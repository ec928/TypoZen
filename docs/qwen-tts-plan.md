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

**So streaming with a lead does not work, and section 3 above is wrong as written.** A lead
cannot be maintained when a sentence takes twice as long to make as to say. The fallback
named there is now the main path: render ahead of the *reader*, not ahead of the voice.

Being clear about the reversal: Ed was right to challenge rendering a chapter first, and I
was right to say quality did not require it — but the machine does. The corrected design
was still wrong, and only the measurement said so.

**What it means in practice.** A ten-hour book is about twenty-two hours of compute at this
rate, so whole-book rendering is an overnight job rather than something done on the way in.
Per chapter it is tolerable: a 20-minute chapter takes about 45 minutes, which is fine if it
happens while an earlier chapter is being listened to.

**Four things could move this number, none of them tried yet:**

1. **Batching.** Everything above was one utterance at a time, batch size 1, which leaves
   the card mostly idle. Several utterances in flight is the obvious first move and the one
   that suits render-ahead.
2. **flash-attn** is not installed — the library says so on every load and falls back to
   "the manual PyTorch version". Awkward to build on Windows, but it is the vendor's own
   recommendation for faster inference.
3. **torch.compile / CUDA graphs**, unmeasured.
4. **The 0.6B model**, if 1.7B quality turns out to be more than is needed.

Until one of those lands, the design is: render ahead, cache, and never pretend to stream.

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
