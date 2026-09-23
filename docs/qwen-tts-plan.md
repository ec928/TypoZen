# Qwen3-TTS narration — design and plan

Status: **proposed, nothing built.** Written 2026-09-22.

Goal: narrate ebooks with the quality and the emotional beats of a decent audiobook.
Quality outranks startup speed. Opt-in extension, primarily for one machine.

---

## 1. What the model actually is

Checked on Hugging Face rather than assumed:

| | |
| --- | --- |
| Weights | `Qwen/Qwen3-TTS-12Hz-1.7B-{Base,CustomVoice,VoiceDesign}`, **Apache 2.0** |
| Also needed | `Qwen/Qwen3-TTS-Tokenizer-12Hz` — the audio codec, a separate download |
| Architecture | autoregressive LM over a discrete multi-codebook codec. No vocoder |
| Reference runtime | `pip install -U qwen-tts`, PyTorch, `device_map="cuda:0"`, bf16 |
| Style control | natural-language instruction per utterance, plus a named speaker |
| Vendor claim | streaming synthesis latency from ~97ms |

**VoiceDesign is the variant this wants.** A voice and a manner are described in words
("an older man, dry and unhurried"; "speak in a hushed, urgent tone"), which is exactly the
control surface an audiobook needs. CustomVoice clones a voice from a reference sample and
is the fallback if described voices prove inconsistent between chapters.

12Hz means twelve codec frames per second of speech, so a minute of audio is ~720 steps of
autoregression. That is cheap by LLM standards and is why the latency claim is plausible.

**The target machine:** RTX 4070 Ti, 12GB VRAM, Python 3.11.9, 576GB free. 1.7B at bf16 is
about 3.4GB of weights, so it runs unquantised with room for the codec. No ONNX, no 4-bit,
no compromises needed. (`Win32_VideoController` reports 4GB — 32-bit overflow. `nvidia-smi`
is right.)

---

## 2. It cannot be an in-page extension like Kokoro

Kokoro works inside the WebView because it is 82M of ONNX that `transformers.js` supports
and WebGPU can run. None of that holds here: `qwen3_tts` is not a `transformers.js`
architecture, the weights are safetensors for PyTorch, and the codec is a second model. A
community ONNX port exists (`speed-brain-ai/...CustomVoice-ONNX`) but covers CustomVoice
only, is third-party, and abandons the variant we want.

So the engine lives **outside the page, in a sidecar process**, and TypoZen talks to it.

Say this plainly: it is not an extension in the sense the Extensions dialog currently
means — files downloaded into a folder and served to the page over `localextensions`. It is
a **local service with an installer**. The dialog can still own install, size and removal,
but the machinery underneath is different and should not pretend otherwise.

---

## 3. Shape: stream with a lead, and keep what you render

The first draft of this section said render a whole chapter before playback. That was
needless pessimism, and Ed was right to push on it: nothing about quality requires it.
Quality comes from directing each utterance and being able to re-render a bad one, and
neither needs the chapter to exist before Play is pressed.

**How it should work:**

- Render utterance by utterance, start playing after the first one, and keep a **lead** of
  a few utterances ahead of the voice. TypoZen already does exactly this for Kokoro -- a
  generation queue feeding a play queue, with prefetch -- so this is less work than the
  batch design, not more.
- **Persist each utterance as it is produced**, into the same opus file plus a manifest of
  block index to offset. By the time a chapter has been heard once, the cache is complete
  and the second listen is instant. The cache is a by-product of listening rather than a
  precondition for it.
- **Batch is kept for the one case that wants it:** rendering a whole book with nothing
  playing, for export. Several utterances in flight keep the GPU busy in a way that
  serial rendering does not, and there is no listener to stay ahead of. That is a different
  mode, not the default one.

**Where the startup cost actually is:** not per utterance but in loading 3.4GB of weights
into VRAM, which is a one-off of seconds. The sidecar stays resident once started, so that
is paid on first use and not again.

**The one thing that would force pre-rendering** is throughput below realtime -- a lead
cannot be maintained if generating a sentence takes longer than speaking it. Slice 1
measures this. If it comes out under realtime, the fallback is to render ahead of the
reader rather than ahead of the voice, and to say so in the UI rather than let it stutter.

## 3a. Measured, 2026-09-22 — and it changes the answer

Slice 1 ran. Three takes of a Banks passage, `Qwen3-TTS-12Hz-1.7B-CustomVoice`, speaker
Vivian, bf16 on the 4070 Ti:

| | |
| --- | --- |
| Throughput | **2.23x realtime** — 25.8s of audio took 57.8s of compute |
| Model load | 8.3s, once |
| Peak VRAM | 4.4GB of 12GB |
| Sample rate | 24kHz |
| Weights | 3.4GB, downloaded in 44s |

**Batched, it is 0.45x realtime — 2.2x faster than speech.** The same eight sentences took
101.4s one at a time and 20.3s in a single call: a **5.00x speedup**, at 5.7GB of 12GB, so
there is room for a larger batch still.

| | audio | compute | rate |
| --- | --- | --- | --- |
| one at a time | 46.2s | 101.4s | 2.20x realtime |
| eight at once | 44.9s | 20.3s | **0.45x realtime** |

**So streaming with a lead works after all, and Ed's original instinct was right.** Batch-1
decoding leaves the card mostly idle; the model is not slow, the way it was being called
was. What this cost: I measured the unoptimised path, told Ed his design would not fly, and
the next measurement said it does. Twice in one session a confident design call went out
ahead of the evidence. The number to trust is the one from the shape you intend to ship.

**The design, then:**

- Render in batches of about eight utterances, play from the front of the queue while the
  next batch renders. The lead grows rather than shrinks: eight sentences of speech cost
  under half their own duration to make.
- **First audio is the real latency now** -- a batch of eight takes ~20s, plus 8s of model
  load on first use. Start with a batch of one or two so speech begins in a few seconds,
  then widen the batch to build the lead. Untested, and the obvious next measurement.
- Cache each utterance as it lands, as already described.
- A ten-hour book is about **4.5 hours** of compute, not 22 -- so whole-book export is an
  afternoon, and listening needs no preparation at all.

**Still unmeasured, and worth it in this order:** the first-audio ramp, batch sizes above
eight, flash-attn (the library warns it is missing on every load), and torch.compile.

## 3b. Delivery wanders unless the sampler is pinned

Ed heard the emotion move between takes "like some random element is at play". It is: the
model samples its prosody. The same line, same instruction, four times:

| regime | durations | spread | identical |
| --- | --- | --- | --- |
| default sampling | 4.56 / 4.64 / 4.32 / 3.52 | 1.12s | no |
| **fixed seed** | 3.76 x 4 | **0.00s** | **yes** |
| temperature 0.2 | 4.64 / 4.00 / 4.08 / 4.32 | 0.64s | no |
| temp 0.2 + seed | 4.40 x 4 | 0.00s | yes |
| greedy (do_sample=False) | 4.40 / 4.40 / 4.16 / 4.72 | 0.56s | no |

A quarter of the line's length, take to take. `do_sample=False` not settling it suggests the
flag is not reaching the sampler through `**kwargs`; the seed is the lever that works.

**But a seed buys reproducibility, not uniformity.** The second cause of wandering emotion is
the direction itself: give every utterance its own instruction and delivery varies by design.
So:

- **Narration takes one fixed style instruction for the whole book**, and a seed derived from
  the utterance's block index and text. The narrator then sounds like the same person on page
  300 as on page 1, and a re-render reproduces the same audio so the cache stays valid.
- **Dialogue takes the character's style plus the beat's modifier.** Variation only where the
  text asks for it.

That is the difference between a narrator and, in Ed's words, a slightly unhinged madwoman
experiencing several emotions at once.

**Untested and it matters for caching:** whether the same sentence renders identically at a
different position in a batch. If batch composition changes the output, cached audio and
re-rendered audio diverge.

## 3c. Batch composition is part of the input

Tested, because it decides whether the cache can be trusted. The same line, seed pinned,
rendered in different company:

| | duration | audio |
| --- | --- | --- |
| alone | 3.76s | different |
| first of four | 3.60s | baseline |
| second of four | 3.92s | different |
| last of four | 3.84s | different |
| with no long neighbour | 4.08s | different |
| **same batch, repeated** | 3.60s | **identical** |

0.48s of spread on a 3.8s line, and an rms difference of 0.05 to 0.09 against a signal rms
of 0.038 -- larger than the signal, so these are different takes rather than numerical
noise. Padding to the longest sequence in the batch is the likely mechanism.

**It is deterministic given the same batch**, which is what makes it workable:

- **Batch composition must be a pure function of the document**, not of what happens to be
  pending when the renderer reaches it. Fixed groups of N consecutive utterances, aligned to
  block index. Then a re-render reproduces the cached bytes exactly.
- **The manifest stores the group's hash** -- contents, order, seed, instructions, model.
  A mismatch is what triggers a re-render, and it can be checked without generating anything.
- **Re-rendering is per group, not per utterance.** Editing a paragraph re-renders its group
  of eight; asking for one line again re-renders its group, because a line rendered alone is
  a different take.
- **A single-line preview will not match the final.** Previews are indicative. Say so in the
  UI rather than let it be discovered.

The alternative -- render every utterance alone so it is context-free -- costs the 5x
batching speedup and puts throughput back above realtime. Not worth it.

## 3d. Time to first sound, and there is no streaming mode

| first chunk | compute | cold start (incl. 8.3s load) |
| --- | --- | --- |
| three words | 3.1s | **11.4s** |
| one sentence | 10.0s | 18.3s |
| batch of eight | 17.1s | 25.5s |

`non_streaming_mode=False` returns a finished tuple after 9.2s and no method has "stream"
in its name, so this package does not stream and the vendor's 97ms figure is not reachable
through it. An earlier summary of mine said speech would start in 5 to 10 seconds cold,
which was simply wrong arithmetic: the model load and the first utterance are serial costs
and add.

**So the sidecar stays resident.** The 8.3s is paid once per session, and then:

- **First sound is about 3 seconds**, by making the first chunk a few words and widening to
  batches of eight afterwards. In a batch, a sentence costs 2.1s against 10s alone -- the
  ramp is not an optimisation, it is the difference between 3 seconds and 18.
- **Seeking is about 3 seconds** into unrendered text, provided the renderer drops its queue
  and renders the jump point as a small chunk first. Anywhere already rendered is instant
  from the cache.

## 3e. Context carries as far as the string you send

I wrote here that context reached one sentence and no further. **That was wrong, and it was
a claim about my chunking, not about the model.** `text` takes a string or a list: separate
list elements are independent sequences, but several sentences in *one string* are a single
autoregressive pass, and intonation carries across them.

Measured on the same paragraph and the same question-and-answer exchange:

| shape | throughput | context |
| --- | --- | --- |
| sentences as separate list items | 0.45x realtime | none between sentences |
| one paragraph as a single string | 2.27x realtime | across its sentences |
| **eight paragraphs, each a single string, batched** | **0.34x realtime** | **across each paragraph's sentences** |

So there is no trade-off to make: 85.3s of audio in 28.8s, at 6.3GB of VRAM -- faster than
sentence batching *and* with intonation running through each paragraph.

**Context span is a knob we own, not a limit the model imposes.** A longer string carries
context further: a whole dialogue exchange can go in one pass so a sarcastic line lands off
the one before it. The costs of a longer string are first-audio latency, coarser cache
granularity, and eventually drift on very long sequences -- so the director pass chooses the
grouping, and paragraph-sized is the sensible default rather than the ceiling.

## 3f. The narrator voice, chosen 2026-09-22

**Checkpoint: `Qwen3-TTS-12Hz-1.7B-VoiceDesign`.** Not CustomVoice, whose nine presets
include only two English speakers (Ryan and Aiden, both American male, both rejected), and
not Base, which is the only checkpoint that clones a voice from a reference and **accepts no
`instruct` at all**. Cloning would forfeit the directable emotion that is the entire reason
for preferring this over Kokoro -- the same reason F5-TTS was ruled out.

Two voices, chosen by ear from described candidates. The wording *is* the voice, so it is
recorded verbatim:

**Narrator (default)** -- "northern-english":

> A British woman with a soft northern English accent, gentle and grounded, with a low
> steady delivery.

**Narrator (alternate)** -- "northern-clear":

> A British woman with a light northern English accent, clear and unhurried, with a smooth
> low register and very even pacing. Understated and composed.

Both are appended with the narration direction:

> Narrate as an accomplished audiobook reader of literary fiction: measured and unhurried,
> phrasing that follows the sense of the sentence, understated rather than performed. Give
> the spoken lines a light, distinct colour without acting them out.

Rejected along the way, and why it is worth remembering: every sample before this used
**Vivian, a Chinese voice preset**, taken from the vendor's Chinese example and never
checked. It is what made the early takes sound, in Ed's words, like someone talking to a
baby. Check what a preset is for before building on it.

## 3g. Status, 2026-09-23 -- where slice 2 actually stands

**Last known-good build: commit `9278781`** (VoiceDesign, northern-english). Measured: it
plays continuously (19 clips, worst gap 0.8s), starts on the page being read, and loads
offline in 16-18s. **Known fault:** the voice changes from sentence to sentence.

**Cause of that fault -- a regression, not a model limit.** VoiceDesign re-invents the
speaker on every generation. Paragraph-sized pieces hid it, because one generation means one
speaker for a whole paragraph. To shorten time to first sound, the opening pieces were cut
to ~55 characters (the 55/130/250 ramp in `narrationPieces`). More, shorter pieces meant
more speaker changes. The consistency fixed earlier was undone by that change.

**Uncommitted working tree -- a mistake, to be reverted, never deployed:**

- `tools/qwen-narrator/sidecar.py` was switched to `Qwen3-TTS-12Hz-1.7B-Base`, cloning
  `narrator-reference.wav`. **That switch was wrong, and it was made without the owner's
  decision.** It reverses §3f. Base accepts no `instruct`, so a cloned narrator cannot be
  directed: no emotional beats, no per-line style, no slice 3. Directable emotion is the
  core requirement of this feature and the reason for choosing Qwen over Kokoro. So the
  clone path could never have succeeded, however long it was tuned.
- It also gave up §3e. Cloned paragraphs ran at 3.3x realtime, so pieces were forced down
  to sentence length, losing the context that carries intonation across sentences.
- `js/modules/09-speech.js` piece cap changed to 90, then 140. This is part of the same
  change; revert it with it.
- The timeline test "passed", yet only 8 clips played in 90s. Its gap metric does not see a
  stall at the end, so the pass is not evidence.

**Cloning is not an option for this feature.** The measurements taken on it (it slowed
sharply above ~58 characters, and it reduced the speaker drift between sentences) are not
recorded here as a basis for decisions. It bought voice consistency by giving up the
requirement the feature exists for.

**What is settled:** VoiceDesign stays (§3f). Paragraph-sized pieces stay the default (§3e).
Short pieces were the cause of the voice changing between sentences, not the model.

**The open question (the owner's):** how to get an acceptable first sound while keeping
paragraph-sized pieces. With VoiceDesign, every piece boundary is a possible voice change.
The trade-off has to be made inside that constraint, not by changing engine.

**Decided 2026-09-23: render ahead of the reader.** Built in `463fcca`, not yet heard:

- A paragraph is one piece. Paragraphs over 400 characters are split at sentence ends.
- Groups are fixed by the document.
- Narration starts at the top of the cursor's paragraph.
- After narration has been used once in a session, turning pages with narration stopped
  renders the group on screen and the next one into the cache.

A jump to text not rendered yet still waits for its batch (about twice the longest
paragraph in it). The first Narrate of a session also pays the model load.

**Measured 2026-09-23, later: VoiceDesign throughput, and a decode trap.** The 0.34x of
§3e was measured on **CustomVoice** (`qwen_parabatch.py`: speaker Vivian, an 8-word
instruction, eight paragraphs of similar length). It was carried over to VoiceDesign without
being re-measured. On VoiceDesign, the first live groups took 137s each, 1.35x to 2.1x
realtime, so narration could not stay ahead. Bounded probes found the cause:

| | Result |
| --- | --- |
| Generation, single piece or batch of 8 | 5.6-6.1 steps/s either way; a 53-word or an 8-word instruction makes no difference |
| Generation, real group from Matter, 324 steps | 57s, steady rate throughout |
| Decode to audio, same 8 clips **as one batch** | over a minute (killed) |
| Decode to audio, same 8 clips **one at a time** | **1.1s** |

qwen-tts decodes a group's clips in one padded batch, in 300-frame chunks, and past 300
frames that batched decode crawls. The sidecar now decodes each clip separately
(`_decode_clips_separately`); generation stays batched. End to end on Matter from block
217, real app, fresh narrator:

| | Before | After |
| --- | --- | --- |
| Group of 101s audio | 137.2s | 63.7s (decode 0.9s) |
| Group of 66s audio | 138.0s | 44.9s (decode 0.6s) |
| Rate | 1.35-2.1x realtime | **0.63-0.68x realtime** |
| First sound, narrator loaded | 137s | 64.5s |
| 100s of listening | stalls | 8 clips, longest gap 0.1s |

**What still limits first sound:** a group takes as long as its longest piece, at about 2.2s
of compute per second of that piece's audio. So a cold Narrate waits roughly twice the
longest paragraph in the first group, plus the 16s model load on the first use. Render-ahead
removes the wait on pages already turned to. The lever that remains is the piece cap (400
characters). A lower cap shortens the wait but adds voice changes inside long paragraphs.
That is the owner's trade-off.

**One voice, decided 2026-09-23: CustomVoice with the narrator's voice-print.** Narration on
VoiceDesign sounded like "multiple people narrating", because VoiceDesign invents the speaker
afresh on every piece. The consistent voice heard earlier came from test samples: CustomVoice
with the built-in speaker Vivian, and single-pass VoiceDesign auditions. The app's narrator
was built on VoiceDesign from the start and never held one voice across pieces.

qwen-tts builds every variant's input the same way, as an instruction followed by a speaker
slot. So the voice-print of the chosen northern-English narrator can go in the slot while a
style instruction still applies. The voice-print is 2048 floats, taken with Base's speaker
encoder from `narrator-reference.wav`, and ships as `tools/qwen-narrator/northern-english.npy`.
Judged by ear against the old narration:

| Variant | Verdict |
| --- | --- |
| VoiceDesign, as narration was | weird |
| VoiceDesign plus the voice-print | weird |
| **CustomVoice plus the voice-print** | **ok; built in `140b6f4`** |
| The reference recording itself | better still |

Direction still works: a shouted line came out 6-7 dB louder than a whispered one. End to end
it renders at 0.63x realtime, the same as before.

**Tried and not usable as-is:** conditioning CustomVoice on the recording itself (its codes
plus transcript, the way Base clones) as well as the voice-print. Short lines collapsed to
0.2s; the cause is unknown. The longer paragraphs came out normal. This is worth pursuing
only if those sound clearly closer to the reference than the voice-print alone.

**No silence after the first line.** A start near the end of a group used to play a few
seconds, then go silent for the whole render of the next group. That was the "one word and it
stopped" of the first live test. Before the first word, the page now keeps adding batches
until the queued audio outlasts the estimated render of the next one. That estimate is 2.3s of
compute per second of the longest piece's audio, at 12 characters a second. The render-behind
loop also asks early for any batch that will take longer than its usual 90-second lead.
Verified at block 223 of Matter: it waited for batch 1, then played 60s with no gap over
0.1s while batch 2 rendered cold at 0.62x realtime.

**Also found on review:** pieces and groups are counted from wherever Play was pressed. They
are not fixed points in the document, so pressing Play somewhere else, or stopping and
restarting, forms different groups and misses the cache (§3c requires composition to be a
pure function of the document). That is why a restart costs as much as a first start.

**How to test:**
- Before each run, write down the question it answers and the expected result.
- Use one piece, and the resident sidecar rather than a fresh load.
- Enforce a limit of 60 seconds or less inside the process (a generation cap, a script
  deadline). A tool or shell timeout that only detaches the run is not a limit.
- Afterwards, confirm that no Python process is left on the GPU.

Batch-of-8 probes with multi-minute timeouts held the GPU at 100% for about an hour and
answered almost nothing. Many short tests beat one long one.

**Minor, known:** `QwenNarrator.Ready()` reads the response stream twice. There is also a
4.3GB duplicate model download in the global Hugging Face cache (`~\.cache\huggingface`),
which nothing uses. It was left in place, for deletion only on request.

## 4. The emotional beats — a director pass

This is what decides whether it sounds like an audiobook or like a machine reading. The TTS
supplies the acting; something has to supply the direction. Three stages, per chapter:

1. **Segment** — split into utterances, separating narration from quoted dialogue.
2. **Attribute** — decide who speaks each line: attribution verbs ("she said", "Anaplian
   whispered"), and alternation carry-over for exchanges with no tags.
3. **Direct** — build the instruction string per utterance: the speaker's base description,
   plus an emotional modifier taken from the attribution verb and adverb ("snapped",
   "said quietly", "shouted"), punctuation (`!`, `?`, an em-dash cut-off), and whether the
   line is interior thought.

A **cast sheet** per book — character → voice description, and optionally a reference
sample — stored beside the cache and editable, because getting the cast right is most of
what makes a narration good. Changing an entry re-renders only that character's lines.

Start with heuristics and measure how far they get. A local LLM pass for attribution and
emotion is the obvious upgrade, but it is not the first move: the heuristic version is a
day's work and will show whether the ceiling is the direction or the model.

---

## 5. Slices, not phases

Each slice ends with something that works and that Ed can listen to. None of them ends with
a report. If a slice takes more than a day to reach sound coming out, it was cut too thick.

The earlier draft of this section was five phases where nothing could be heard until the
fourth. That is the pattern that has already cost this project time: a long build against a
design I was confident about, discovered wrong at the end. Grok's prototypes worked on day
one and got better; mine were correct on paper for a week. Thin slice, every time.

**Slice 1 — sound, from inside TypoZen, on one paragraph.**
A venv, `qwen-tts`, a CLI that takes text and writes a wav, and a hidden command in TypoZen
that sends the current paragraph to it and plays the result. One fixed voice, no direction,
no cache, no menu. Ugly is fine. What it proves is the whole chain: app → sidecar → audio →
playback. What it produces is the number everything else depends on — seconds of audio per
second of compute — and the first honest answer to "does this sound better than Kokoro".
**Stop condition: if it does not, the project ends here.**

**Slice 2 — a chapter, cached, with the highlight following.**
Render utterance by utterance into an opus file plus a manifest of block → offset; play from
the cache; drive the existing highlight and page turning. Still one voice, still no
direction. At the end of this slice the feature is *usable* — a book can be listened to.
Everything after it is improvement on a working thing.

**Slice 3 — direction.**
Attribution verbs and punctuation become style instructions per utterance. This is where it
starts sounding like a narration rather than a reading. Judged by ear, one chapter at a
time, against slice 2's recording of the same chapter.

**Slice 4 — cast.** Per-character voices, a cast sheet, re-render on change.

**Slice 5 — export.** m4b/opus out, which by then is mostly already done.

Running through all of them, not gating them: it looks like an extension to the reader.
It appears in File > Extensions with a size and a Remove button, and the narration menu is
hidden until it is installed — exactly like Kokoro, whatever is happening underneath.
Slice 1 can skip the dialog entirely; by slice 2 it belongs there.

**Decisions already made, not questions:**

- **One voice** until slice 4. Ed: a working thin slice with one voice is fine.
- **A plain Python venv**, in the existing extensions folder under the profile. There is
  already a data area with a convention and a Remove path; this uses it rather than
  inventing anything.
- **The audio cache goes with the other per-book data**, for the same reason.

## 6. Risks, and what is not known

- **Throughput is unmeasured.** Slice 1 produces the number; nothing after it is schedulable until then. If a
  ten-hour book takes ten hours to render, the feature still works — it just becomes an
  overnight job, and that should be a deliberate decision rather than a surprise.
- **Long-form drift.** Autoregressive TTS can wander or repeat on long inputs. Rendering
  per utterance limits the blast radius, but chapter-scale behaviour needs checking.
- **Described voices may not be stable** across a whole book. If chapter 9's narrator does
  not match chapter 1's, the answer is CustomVoice with one fixed reference sample per
  character, and VoiceDesign only for the emotional modifier.
- **Distribution.** A 7GB install with a bundled Python and CUDA stack is not something to
  put in the Microsoft Store. This stays an opt-in extension, and if it is ever offered
  publicly it needs a different conversation about packaging.
- **The Extensions dialog's assumptions** — a list of files, one zip, an HTTP download —
  do not cover provisioning a Python environment. Phase 2 extends it or bypasses it; that
  is a real design decision, not plumbing.

---

## 7. What Ed decides

Only one thing, and only when slice 1 has produced a wav: whether it sounds good enough to
carry on. Everything else in here is a working decision and mine to make.
