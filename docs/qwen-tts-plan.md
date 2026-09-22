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
