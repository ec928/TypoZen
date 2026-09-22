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

## 3. Shape: render ahead, do not stream

Narration is a batch job, not a live one, and that follows directly from "quality beats
startup":

- Render a chapter **before** it is listened to, one utterance at a time, into a cache.
- Store audio as **opus** with a **manifest**: model block index → `[start, end]` in the
  audio file. A ten-hour book is ~150MB at 32kbps; the same as wav would be over 3GB.
- Playback reads the cache and drives the *existing* highlight and auto-page-turn from the
  manifest. Nothing new is needed in the reader.

What this buys:

- Latency stops mattering entirely, so the budget per sentence can be generous — retries,
  a second take, a slower sampler.
- A voice or a direction can be changed and only the affected utterances re-rendered.
- **Export to m4b falls out for free**, which was already on the wanted list.
- A failed or ugly line can be re-rendered without touching the rest of the chapter.

---

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

## 5. Phases

**Phase 0 — spike, before anything is designed further.** A venv, `pip install qwen-tts`,
three paragraphs of a real book rendered with three different style instructions, listened
to by Ed. Measure seconds-of-audio per second of compute, and peak VRAM.
**Decision gate:** if undirected output is not clearly better than Kokoro, stop here. Also
the point at which the English-language quality of style instructions gets judged — the
vendor's examples are in Chinese.

**Phase 1 — the sidecar.** A small CLI: JSON in (text, speaker, style, output path), wav
out, one process that stays warm across requests. No TypoZen dependency; runnable by hand,
which keeps it debuggable and testable on its own.

**Phase 2 — install and removal.** Model plus codec plus environment provisioned through
File > Extensions: resumable, hash-checked, ~7GB all told. Menu gating exactly as Kokoro's
(absent means no menu). Remove takes all of it, including the venv.

**Phase 3 — director and cast.** Segmentation, attribution, style mapping, cast sheet UI,
and a **preview** — render one paragraph and hear it before committing a chapter.

**Phase 4 — render queue.** Chapter at a time, with progress, cancel, and the cache plus
manifest on disk. Resumable: closing the app mid-chapter loses at most one utterance.

**Phase 5 — playback and export.** Play from cache with the existing block highlight and
page turning; then export the book as m4b/opus.

---

## 6. Risks, and what is not known

- **Throughput is unmeasured.** The whole schedule depends on Phase 0's number. If a
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

## 7. Open questions for Ed

1. **One narrator with emotional range, or a full cast with per-character voices?** The
   cast work is most of Phase 3, and it is the difference between "good" and "the thing
   commercial audiobooks do".
2. **Where does the audio cache live** — beside the book, or in the profile folder? Beside
   the book survives a profile clear and travels with the file; the profile keeps the
   book's folder clean.
3. **Is a plain Python venv acceptable**, given this is mainly for one machine? It removes
   most of Phase 2's difficulty. A self-contained bundle is possible but is a project of
   its own.
