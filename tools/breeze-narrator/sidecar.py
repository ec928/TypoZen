"""TypoZen's Breeze narration service: one resident process, HTTP on the loopback.

The second narrator beside the Qwen one (tools/qwen-narrator/sidecar.py), answering the same
requests in the same shapes, so the page's narration -- pieces, cues, casts, the reading queue --
works with either. Plan: docs/internal/breeze-tts-plan.md.

What differs from Qwen:
- A voice is a reference recording and its exact words, not a voice-print. Breeze copies the
  voice from it and still takes an instruction. Designed voices, voices cloned from the
  reader's own recording, and Qwen's saved voices (whose design.wav is a recording of
  DESIGN_TEXT) all work that way.
- One piece at a time: Breeze serves one request at a time, and at about 0.7x realtime it stays
  ahead of the listener without batching (measured 2026-10-08: a 34-piece chapter, 10 minutes
  of audio in 7.8, the voice unchanged from first piece to last).
- The fast path (CUDA graphs and torch.compile for the depth decoder and the backbone's decode
  step) is what makes it faster than realtime; without it, about 3.2x realtime -- fine for a
  preview, never for reading. If it cannot be set up, the narrator says so on /health
  ("mode": "eager") and still answers.
- TypoZen's in-text bracket tags are translated (translate()): point events become Breeze's own
  parenthesised events, which add the sound; span tags become the instruction for the rest of
  the piece.

  GET  /health                     is the model up, and in which mode
  GET  /voices                     the voice library
  POST /render                     {"blocks":[{"id":1,"text":"..."}], "voice":"...", ...}
                                   -> {"items":[{"id":1,"file":"...","seconds":3.7}]}
  POST /design /voices/clone /voices/keep /voices/import /voices/delete /preview
  POST /cancel /stop /log /logging

Run it by hand:
  venv\\Scripts\\python.exe sidecar.py --cache <dir> --port 8766
"""
import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Beside TypoZen.exe nothing may be written (an MSIX install folder is read-only).
sys.dont_write_bytecode = True

MODEL_ID = 'BreezeBlue/Breeze-TTS-2@3e28c515'      # the revision the installer pins
HERE = os.path.dirname(os.path.abspath(__file__))

# The instruction wording is the Qwen narrator's, word for word, so a reader's settings mean the
# same thing to either engine.
NARRATION_BASE = (
    "Narrate as an accomplished audiobook reader of literary fiction: measured and "
    "unhurried, phrasing that follows the sense of the sentence, understated rather than "
    "performed."
)
LIGHT_DIALOGUE = " Give the spoken lines a light, distinct colour without acting them out."
# Plain since 2026-10-09: "clearly but with restraint, and keep the narration around them measured"
# told the narrator to hold back on exactly the lines a cue marks as emphatic or breaking off.
DIRECTED_SUFFIX = " Voice the lines in quotation marks as %s."
THOUGHT_SUFFIX = " This passage is a character's private thought: read it quieter and more inward."
DIALOGUE = "Speak this line of dialogue as the character would say it, naturally and in character."
DIALOGUE_DIRECTED = "Speak this line of dialogue as the character would say it: %s."

DESIGN_TEXT = ("The road ran straight across the plain, and the mountains beyond it were pale "
               "with distance. She had been walking since the morning, and the light had not "
               "changed at all. There was nothing to mark the hours but the sound of her own steps.")
PREVIEW_TEXT = ("\u201cYou should have waited for me,\u201d she said quietly, and for a while "
                "neither of them spoke.")

# The narrator TypoZen ships with: the same recording the Qwen narrator's voice-print was taken
# from, so the default voice is the same person in both engines.
BUILTIN_VOICES = {
    'northern-english': {
        'name': 'Northern English (original)',
        'description': ('A British woman with a soft northern English accent, gentle and '
                        'grounded, with a low steady delivery.'),
        'reference': os.path.join(HERE, 'northern-english.wav'),
        'transcript': DESIGN_TEXT,
    },
}
DEFAULT_VOICE = 'northern-english'

# TypoZen's bracket words (docs/narrator-cues.md). Point events are sounds; Breeze performs the
# same words in parentheses and adds the sound to the speech (Ed's ear, 2026-10-08: all of them,
# "(snorts)" weakest). Span tags change the delivery from there on; Breeze has no in-text form,
# so they become the instruction for the rest of the piece.
POINT_EVENTS = ('laughing', 'giggles', 'gasp', 'sighing', 'cough', 'clears throat', 'snorts')
SPAN_TAGS = ('excited', 'sad', 'angry', 'amazed', 'serious', 'sarcastic', 'curious', 'mischievously',
             'crying', 'panicked', 'tired', 'asmr', 'singing', 'whispers', 'very slowly', 'very fast',
             'like dracula', 'deep and loud shouting')
# A tag may carry its own strength, [sad:9]: the page strips it from brackets beside speakers and
# double brackets, but a tag in the text reaches here with it. A point event's number is dropped.
_NUM = r'(?:\s*:\s*(\d+(?:\.\d+)?))?'
_POINT_RE = re.compile(r'\[\s*(' + '|'.join(re.escape(w) for w in POINT_EVENTS) + r')' + _NUM + r'\s*\]', re.I)
_SPAN_RE = re.compile(r'\[\s*(' + '|'.join(re.escape(w) for w in SPAN_TAGS) + r')' + _NUM + r'\s*\]', re.I)

# How hard Breeze is steered by an instruction (its classifier-free guidance). 1 is no extra push;
# Breeze recommends 4 for voice direction, and by ear 4 beat 1 on every mood tag (2026-10-08). Only
# a piece with an instruction has one: Breeze refuses more than 1 without. Above 1 it renders the
# step twice, about 0.66 -> 1.0 of real time, whatever the value.
DEFAULT_STRENGTH = 4.0
MAX_STRENGTH = 10.0


def clamp_strength(v, default=DEFAULT_STRENGTH):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return max(1.0, min(MAX_STRENGTH, v))

SAMPLE_RATE = 24000
CLONE_MIN_S, CLONE_MAX_S = 3.0, 20.0
MAX_NEW_TOKENS = 1500           # Breeze's own cap: about two minutes of audio in one piece
MAX_SEQ_LEN = 2048


# narration.log in the extension folder: ids, counts, lengths and timings, never the text read.
# Nothing at all in TypoZen's Privacy Mode (--quiet, POST /logging).
LOG_PATH = None
LOG_ON = True
_log_lock = threading.Lock()


def log(m, who='breeze'):
    t = time.time()
    line = '%s.%03d  %-7s %s' % (time.strftime('%H:%M:%S', time.localtime(t)), int(t * 1000) % 1000, who, m)
    print(line, flush=True)
    if LOG_PATH and LOG_ON:
        with _log_lock:
            try:
                with open(LOG_PATH, 'a', encoding='utf-8') as f:
                    f.write(line + '\n')
            except Exception:
                pass


def open_log(path):
    global LOG_PATH
    try:
        if os.path.exists(path) and os.path.getsize(path) > 2 * 1024 * 1024:
            os.replace(path, path + '.1')
    except Exception:
        pass
    LOG_PATH = path


def recycle(path):
    """Delete to the Recycle Bin, so it can be restored; else move aside. True if recycled."""
    if not os.path.exists(path):
        return True
    try:
        import ctypes
        from ctypes import wintypes

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [('hwnd', wintypes.HWND), ('wFunc', ctypes.c_uint), ('pFrom', wintypes.LPCWSTR),
                        ('pTo', wintypes.LPCWSTR), ('fFlags', ctypes.c_ushort),
                        ('fAnyOperationsAborted', wintypes.BOOL), ('hNameMappings', ctypes.c_void_p),
                        ('lpszProgressTitle', wintypes.LPCWSTR)]
        op = SHFILEOPSTRUCTW(None, 3, os.path.abspath(path) + '\0', None, 0x40 | 0x10 | 0x4 | 0x400,
                             False, None, None)
        if ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0 and not os.path.exists(path):
            return True
    except Exception as e:
        log('Recycle Bin unavailable for %s: %s' % (path, e))
    import shutil
    aside = os.path.join(os.path.dirname(path), '_deleted')
    os.makedirs(aside, exist_ok=True)
    shutil.move(path, os.path.join(aside, '%s-%d' % (os.path.basename(path), int(time.time()))))
    return False


def instruction(style, direction, role='narration', whole=None, cue=None, own=None):
    """The full instruction for one piece -- the Qwen narrator's rules exactly (its
    Narrator.instruction), so the same settings and cues mean the same to both engines."""
    direction = (direction or '').strip()[:80]
    style = (style or '').strip()[:300]
    if role == 'dialogue':
        spoken = (own or '').strip()[:1500]
        if spoken:
            if not direction:
                return spoken
            if direction == 'thought':
                return (spoken + THOUGHT_SUFFIX).strip()
            cue = (cue or '').strip()[:400] or DIRECTED_SUFFIX.strip().replace('%s', '{cue}')
            return (spoken + ' ' + cue.replace('{cue}', direction)).strip()
        return DIALOGUE_DIRECTED % direction if direction and direction != 'thought' else DIALOGUE
    if whole is not None:
        whole = whole.strip()[:1500]
        if not direction:
            return whole
        if direction == 'thought':
            return (whole + THOUGHT_SUFFIX).strip()
        cue = (cue or '').strip()[:400] or DIRECTED_SUFFIX.strip().replace('%s', '{cue}')
        return (whole + ' ' + cue.replace('{cue}', direction)).strip()
    base = ('Narrate as an audiobook reader of literary fiction. ' + style) if style else NARRATION_BASE
    if not direction:
        return base + LIGHT_DIALOGUE
    if direction == 'thought':
        return base + THOUGHT_SUFFIX
    return base + DIRECTED_SUFFIX % direction


def translate(text, told, strength=DEFAULT_STRENGTH):
    """A piece as Breeze is given it: [(text, instruction, strength)], usually one.

    Point events -- [laughing], [clears throat] -- become (laughing), (clears throat): Breeze
    adds the sound. A span tag -- [sad], [whispers] -- ends the stretch before it; the text after
    it is its own generation, told the tag's words as well as the piece's instruction, so the
    delivery changes from there on, as it does with Qwen. Any other bracket is left as written
    (read aloud, as Qwen reads it). A span tag's own number, [sad:9], is the strength from there
    on; otherwise `strength`. A part with no instruction has none (1).
    """
    text = _POINT_RE.sub(lambda m: '(' + m.group(1).lower() + ')', text)
    out, at, span, own = [], 0, None, None

    def part(seg):
        instr = told_with(span)
        return (seg, instr, (own if own is not None else strength) if instr else 1.0)

    def told_with(s):
        if not s:
            return told
        return (told.rstrip(' .;,') + '. Now ' + s + '.').strip() if told else s

    for m in _SPAN_RE.finditer(text):
        seg = text[at:m.start()].strip()
        if re.search(r'[A-Za-z0-9]', seg):
            out.append(part(seg))
        span, at = m.group(1).lower(), m.end()
        own = clamp_strength(m.group(2), None) if m.group(2) else None
    seg = text[at:].strip()
    if re.search(r'[A-Za-z0-9]', seg):
        out.append(part(seg))
    return out


class Cancelled(Exception):
    """The reading was cancelled while its piece was being rendered."""


_cancelled = []
_cancel_lock = threading.Lock()


def cancel(reading_id):
    with _cancel_lock:
        _cancelled.append(reading_id)
        if len(_cancelled) > 64:
            del _cancelled[:32]


def is_cancelled(reading_id):
    with _cancel_lock:
        return reading_id in _cancelled


class Narrator(object):
    def __init__(self, cache_dir, private_dir=None, models=None, code=None, qwen_voices=None, eager=False):
        self.cache_dir = cache_dir
        self.private_dir = private_dir
        self.root = os.path.dirname(os.path.abspath(cache_dir))
        self.voices_dir = os.path.join(self.root, 'voices')
        self.models = models
        self.code = code
        self.qwen_voices = qwen_voices if qwen_voices and os.path.isdir(qwen_voices) else None
        self.force_eager = eager
        self.lock = threading.Lock()
        self.ready = False
        self.load_error = ''
        self.mode = ''
        self.voices = {}            # id -> {'reference', 'transcript', 'hash', meta...}
        os.makedirs(cache_dir, exist_ok=True)
        os.makedirs(self.voices_dir, exist_ok=True)

    # ---- the model -----------------------------------------------------------------------

    def load(self):
        try:
            t = time.time()
            sys.path.insert(0, self.code)
            import torch
            from pathlib import Path
            from breeze_infer.runtime import load_runtime, update_generation_config_for_breeze
            from breeze_infer.templates import get_template, prepare_inputs, select_template_name
            from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig
            self.torch = torch
            self._get_template, self._prepare, self._template_for = get_template, prepare_inputs, select_template_name
            self.tokenizer, self.model, self.audio_tokenizer = load_runtime(
                Path(self.models), device='cuda:0', attn_implementation='eager')
            update_generation_config_for_breeze(self.model)
            log('weights in %.1fs' % (time.time() - t))
            self.reload_voices()

            def runtime(fast):
                return FastBreezeStreamingRuntime(
                    self.model, self.audio_tokenizer,
                    FastStreamingConfig(max_new_tokens=MAX_NEW_TOKENS, max_seq_len=MAX_SEQ_LEN,
                                        repetition_penalty=1.1, fast_all=None if fast else False,
                                        fast_depth_decoder=fast, fast_backbone_decode=fast),
                    tokenizer=self.tokenizer)

            # The two stages that fit a 12 GB card; the others were still compiling after four
            # minutes with the card full (2026-10-08). Compiled kernels are cached in the
            # extension folder, so a later start compiles in about 33 s instead of 125.
            if not self.force_eager:
                try:
                    t_fast = time.time()
                    from dataclasses import replace
                    from models.warmup_profile import load_warmup_profile
                    rt = runtime(True)
                    prof = load_warmup_profile(os.path.join(self.code, 'configs', 'fast.json'))
                    rt.warmup_from_profile(replace(prof, codec_chunk_frames=rt.codec_chunk_frames))
                    torch.cuda.synchronize()
                    self.runtime, self.mode = rt, 'fast'
                    log('fast path ready in %.1fs' % (time.time() - t_fast))
                except Exception as e:
                    import traceback
                    log('fast path unavailable, reading in eager mode (about 3x slower than realtime):\n'
                        + traceback.format_exc())
                    torch.cuda.empty_cache()
            if not self.mode:
                self.runtime, self.mode = runtime(False), 'eager'
            self.sr = self.runtime.sample_rate
            self.ready = True
            log('model ready in %.1fs (%s, %s, GPU %.2f GiB reserved)'
                % (time.time() - t, MODEL_ID, self.mode, torch.cuda.memory_reserved() / 2 ** 30))
        except Exception as e:
            import traceback
            self.load_error = (str(e).splitlines() or [type(e).__name__])[0][:200]
            log('model load FAILED:\n' + traceback.format_exc())

    def _generate(self, text, voice=None, told='', reading=None, seed=1234, reference=None, transcript=None, strength=1.0):
        """One generation: audio for `text`, in a voice (its reference recording) or, with no
        voice, the voice `told` describes. Stops at the next chunk once `reading` is cancelled."""
        import numpy as np
        req = {'id': 'piece', 'text': text, 'speaker': 'S0'}
        if told:
            req['instruction'] = told
        if voice is not None:
            reference, transcript = self.voices[voice]['reference'], self.voices[voice]['transcript']
        if reference:
            req['ref_audio_path'] = reference
            req['ref_text'] = transcript
        self.torch.manual_seed(seed)
        self.torch.cuda.manual_seed_all(seed)
        inputs = self._prepare(self.tokenizer, self.audio_tokenizer, self.model, [req],
                               self._get_template(self._template_for(req)),
                               guidance_scale=float(strength) if told else 1.0,
                               guidance_scale_ref=None, guidance_scale_ins=None)
        from contextlib import closing
        parts = []
        # closing(): a cancel leaves the loop part-way, and the generator's own finally is what
        # closes Breeze's request; closing() runs it now rather than whenever it is collected.
        with closing(self.runtime.iter_audio_chunks(inputs, request_id='piece', seed=seed)) as chunks:
            for chunk in chunks:
                if reading is not None and is_cancelled(reading):
                    raise Cancelled()
                parts.append(chunk.audio)
        return np.concatenate(parts).astype(np.float32) if parts else np.zeros(0, dtype=np.float32)

    # ---- voices --------------------------------------------------------------------------

    @staticmethod
    def _hash_voice(path, transcript):
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            h.update(f.read())
        h.update(b'\x00' + transcript.encode('utf-8'))
        return h.hexdigest()

    def reload_voices(self):
        """Built-in, then Qwen's saved voices (read-only), then this extension's own."""
        voices = {}

        def add(vid, ref, transcript, meta, source):
            try:
                voices[vid] = dict(meta, id=vid, reference=ref, transcript=transcript, source=source,
                                   hash=self._hash_voice(ref, transcript))
            except Exception as e:
                log('voice %s unreadable, skipped: %s' % (vid, e))

        for vid, v in BUILTIN_VOICES.items():
            add(vid, v['reference'], v['transcript'],
                {'name': v['name'], 'description': v['description'], 'builtin': True, 'preview': ''}, 'builtin')
        for folder, source in ((self.qwen_voices, 'qwen'), (self.voices_dir, 'breeze')):
            if not folder:
                continue
            for vid in sorted(os.listdir(folder)):
                d = os.path.join(folder, vid)
                if vid.startswith('_') or vid in BUILTIN_VOICES or not os.path.isdir(d):
                    continue
                meta = {}
                try:
                    with open(os.path.join(d, 'meta.json'), encoding='utf-8-sig') as f:
                        meta = json.load(f)
                except Exception:
                    pass
                # A Breeze voice keeps its words beside its recording. A Qwen voice's design.wav is
                # always DESIGN_TEXT read in that voice.
                ref = os.path.join(d, 'reference.wav')
                transcript = str(meta.get('transcript') or '')
                if not os.path.isfile(ref):
                    ref, transcript = os.path.join(d, 'design.wav'), transcript or DESIGN_TEXT
                if not os.path.isfile(ref) or not transcript:
                    continue
                preview = os.path.join(d, 'preview.wav')
                add(vid, ref, transcript,
                    {'name': str(meta.get('name') or vid), 'description': str(meta.get('description') or ''),
                     'builtin': False, 'made': meta.get('made', 'design'),
                     'preview': preview if os.path.isfile(preview) else ''}, source)
        self.voices = voices
        log('voices: %s' % ', '.join('%s(%s)' % (v, voices[v]['source']) for v in sorted(voices)))

    def known_voice(self, vid):
        return vid if vid in self.voices else DEFAULT_VOICE

    def voice_list(self):
        keys = ('id', 'name', 'description', 'builtin', 'preview', 'source', 'made')
        order = sorted(self.voices.values(), key=lambda v: (not v['builtin'], v['name'].lower()))
        return [{k: v.get(k, '') for k in keys} for v in order]

    def _new_id(self, name):
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'voice'
        vid, n = slug, 2
        while (vid in self.voices or vid in BUILTIN_VOICES or os.path.exists(os.path.join(self.voices_dir, vid))
               or (self.qwen_voices and os.path.exists(os.path.join(self.qwen_voices, vid)))):
            vid, n = '%s-%d' % (slug, n), n + 1
        return vid

    def _candidate(self, cid, reference_audio, transcript, meta, style=''):
        """A voice not yet kept: its recording, its words, and PREVIEW_TEXT read in it."""
        import soundfile as sf
        d = os.path.join(self.voices_dir, '_candidates', cid)
        os.makedirs(d, exist_ok=True)
        ref = os.path.join(d, 'reference.wav')
        sf.write(ref, reference_audio, SAMPLE_RATE, subtype='PCM_16')
        preview = self._generate(PREVIEW_TEXT, told=instruction(style, '', 'narration'),
                                 reference=ref, transcript=transcript)
        sf.write(os.path.join(d, 'preview.wav'), preview, self.sr, subtype='PCM_16')
        with open(os.path.join(d, 'meta.json'), 'w', encoding='utf-8') as f:
            json.dump(dict(meta, transcript=transcript), f)
        return {'candidate': cid, 'preview': os.path.join(d, 'preview.wav'), 'design': ref}

    def design(self, description, count=3, style=''):
        """Candidates for a voice described in words: Breeze reads DESIGN_TEXT as that voice,
        a new speaker each time, and the recording becomes the voice's reference."""
        import shutil
        description = description.strip()[:400]
        count = max(1, min(int(count or 3), 4))
        root = os.path.join(self.voices_dir, '_candidates')
        with self.lock:
            t = time.time()
            shutil.rmtree(root, ignore_errors=True)
            out = []
            for k in range(count):
                audio = self._generate(DESIGN_TEXT, told=description, seed=int(time.time() * 1000 + k) % 100000)
                out.append(self._candidate('c%d' % (k + 1), audio, DESIGN_TEXT,
                                           {'description': description, 'made': 'design'}, style))
        log('designed %d candidates in %.1fs' % (count, time.time() - t))
        return out

    def clone(self, path, transcript, start=None, end=None, style=''):
        """A candidate from the reader's own recording: what is said in it, exactly, is needed.
        Any length or format soundfile reads; trimmed to start..end seconds when given."""
        import shutil
        import numpy as np
        import soundfile as sf
        transcript = re.sub(r'\s+', ' ', transcript or '').strip()
        if not transcript:
            raise ValueError('type exactly what is said in the recording')
        if len(transcript) > 1000:
            raise ValueError('the words are too long for a voice sample; use 3 to 20 seconds of speech')
        if not os.path.isfile(path or ''):
            raise ValueError('the recording is not there any more: %s' % os.path.basename(path or ''))
        try:
            audio, sr = sf.read(path, dtype='float32', always_2d=True)
        except Exception:
            raise ValueError('this file is not audio TypoZen can read (WAV, FLAC, OGG or MP3)')
        audio = audio.mean(axis=1)
        a = int(float(start) * sr) if start not in (None, '') else 0
        b = int(float(end) * sr) if end not in (None, '') else len(audio)
        audio = audio[max(0, a):max(0, min(len(audio), b))]
        secs = len(audio) / float(sr)
        if secs < CLONE_MIN_S:
            raise ValueError('the recording is %.1f seconds; a voice needs at least %d' % (secs, CLONE_MIN_S))
        if secs > CLONE_MAX_S:
            raise ValueError('the recording is %.0f seconds; choose %d seconds or less of it' % (secs, CLONE_MAX_S))
        if float(np.sqrt(np.mean(audio ** 2))) < 0.003:
            raise ValueError('the recording is silent or nearly so')
        if sr != SAMPLE_RATE:
            import soxr
            audio = soxr.resample(audio, sr, SAMPLE_RATE)
        peak = float(np.max(np.abs(audio)))
        if peak > 0:
            audio = audio * min(1.0, 0.95 / peak)
        with self.lock:
            t = time.time()
            shutil.rmtree(os.path.join(self.voices_dir, '_candidates'), ignore_errors=True)
            out = self._candidate('c1', audio.astype(np.float32), transcript, {'description': '', 'made': 'clone'}, style)
        log('cloned a candidate from %.1fs of audio in %.1fs' % (secs, time.time() - t))
        return out

    def keep(self, candidate, name):
        import shutil
        src = os.path.join(self.voices_dir, '_candidates', os.path.basename(candidate))
        if not os.path.isfile(os.path.join(src, 'reference.wav')):
            raise ValueError('no such candidate: %s' % candidate)
        name = (name or '').strip()[:60] or 'Voice'
        vid = self._new_id(name)
        dst = os.path.join(self.voices_dir, vid)
        shutil.copytree(src, dst)
        with open(os.path.join(dst, 'meta.json'), encoding='utf-8') as f:
            meta = json.load(f)
        meta['name'] = name
        with open(os.path.join(dst, 'meta.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f)
        self.reload_voices()
        log('kept candidate %s as voice %s' % (candidate, vid))
        return vid

    def import_voice(self, path):
        """A .tzvoice file or a voice folder -- Breeze's (reference.wav + its words) or Qwen's
        (design.wav, which is DESIGN_TEXT). Returns (id, name, already)."""
        import io
        import zipfile
        import soundfile as sf
        limits = {'reference.wav': 20 << 20, 'design.wav': 20 << 20, 'preview.wav': 20 << 20, 'meta.json': 64 << 10}
        got = {}
        if os.path.isdir(path) or os.path.basename(path).lower() in limits:
            folder = path if os.path.isdir(path) else os.path.dirname(path)
            for name, cap in limits.items():
                p = os.path.join(folder, name)
                if os.path.isfile(p) and os.path.getsize(p) <= cap:
                    with open(p, 'rb') as f:
                        got[name] = f.read()
        else:
            try:
                with zipfile.ZipFile(path) as z:
                    for info in z.infolist():
                        name = info.filename.replace('\\', '/').split('/')[-1]
                        if name in limits and info.file_size <= limits[name]:
                            got[name] = z.read(info)
            except zipfile.BadZipFile:
                raise ValueError('this is not a saved TypoZen voice')
        try:
            meta = json.loads(got.get('meta.json', b'{}').decode('utf-8-sig'))
        except Exception:
            meta = {}
        if not isinstance(meta, dict):
            meta = {}
        wav = got.get('reference.wav') or got.get('design.wav')
        transcript = str(meta.get('transcript') or ('' if 'reference.wav' in got else DESIGN_TEXT)).strip()
        if not wav or wav[:4] != b'RIFF' or not transcript:
            raise ValueError('this is not a voice Breeze can use (no recording and words in it)')
        try:
            info = sf.info(io.BytesIO(wav))
        except Exception:
            raise ValueError('this voice is damaged and cannot be read')
        if not 1.0 <= info.duration <= 60.0:
            raise ValueError('this voice\'s recording is not a usable length')
        digest = hashlib.sha256(wav + b'\x00' + transcript.encode('utf-8')).hexdigest()
        for vid, v in self.voices.items():
            if v['hash'] == digest:
                return vid, v['name'], True
        name = str(meta.get('name') or os.path.splitext(os.path.basename(path.rstrip('\\/')))[0]).strip()[:60] or 'Voice'
        vid = self._new_id(name)
        dst = os.path.join(self.voices_dir, vid)
        os.makedirs(dst)
        with open(os.path.join(dst, 'reference.wav'), 'wb') as f:
            f.write(wav)
        if got.get('preview.wav', b'')[:4] == b'RIFF':
            with open(os.path.join(dst, 'preview.wav'), 'wb') as f:
                f.write(got['preview.wav'])
        with open(os.path.join(dst, 'meta.json'), 'w', encoding='utf-8') as f:
            json.dump({'name': name, 'description': str(meta.get('description') or '')[:2000],
                       'transcript': transcript, 'made': str(meta.get('made') or 'design')}, f)
        self.reload_voices()
        log('imported voice %s' % vid)
        return vid, name, False

    def delete_voice(self, vid):
        """Only this extension's own voices: Qwen's library is read here, never changed."""
        v = self.voices.get(vid)
        if not v or v['source'] != 'breeze' or vid.startswith('_') or '/' in vid or '\\' in vid:
            raise ValueError('cannot delete %s here' % vid)
        recycle(os.path.join(self.voices_dir, vid))
        self.reload_voices()
        log('deleted voice %s (to the Recycle Bin)' % vid)

    # ---- rendering -----------------------------------------------------------------------

    def key_for(self, text, voice, told, seed=1234, strengths=None):
        h = hashlib.sha256()
        for part in (MODEL_ID, self.voices[voice]['hash'], told, text):
            h.update(part.encode('utf-8'))
            h.update(b'\x00')
        # The strength each instructed part was rendered at: a change is a different reading.
        if strengths and any(x != 1.0 for x in strengths):
            h.update(('strength ' + ','.join('%g' % x for x in strengths)).encode('ascii'))
        if seed != 1234:
            h.update(b'seed ' + str(seed).encode('ascii'))
        return h.hexdigest()[:20]

    def cached(self, key, folder=None):
        path = os.path.join(folder or self.cache_dir, key + '.wav')
        if not os.path.exists(path):
            return None
        try:
            import soundfile as sf
            return sf.info(path).duration
        except Exception as e:
            log('cached piece %s unreadable (%s), rendering again' % (key, e))
            return None

    def find(self, key, private):
        if private and self.private_dir:
            s = self.cached(key, self.private_dir)
            if s is not None:
                return s, True
        return self.cached(key), False

    def render_group(self, blocks, voice, seed, reading=None, style='', private=False, whole=None, cue=None,
                     strength=DEFAULT_STRENGTH):
        """Audio for each block, from the cache where it exists, the rest one at a time. A block's
        own 'strength' (a tag's number) wins over `strength` (Narrator Settings).
        Returns ([{id, file, seconds, private, instruction, voice, cached, parts}] in order, how many
        were cached); `parts` is exactly what Breeze was given: [{text, instruction, strength}]."""
        import numpy as np
        import soundfile as sf
        private = bool(private and self.private_dir)
        if private:
            os.makedirs(self.private_dir, exist_ok=True)
        voices = [self.known_voice(b.get('voice') or voice) for b in blocks]

        def told(b):
            role = b.get('role') or 'narration'
            piece = b.get('instruction')
            use_whole, own = whole, None
            if role == 'dialogue':
                own = piece
            elif isinstance(piece, str) and piece.strip():
                use_whole = piece
            return instruction(style, b.get('direction'), role, use_whole, cue, own)

        tolds = [told(b) for b in blocks]
        partss = [translate(b['text'], t, clamp_strength(b.get('strength'), strength) if b.get('strength') else strength)
                  for b, t in zip(blocks, tolds)]
        keys = [self.key_for(b['text'], v, i, seed, [x[2] for x in ps])
                for b, v, i, ps in zip(blocks, voices, tolds, partss)]
        found = [self.find(k, private) for k in keys]
        have, where = [f[0] for f in found], [f[1] for f in found]
        made = 0
        fresh = set()                   # pieces rendered by this request, not found in the cache
        for i, b in enumerate(blocks):
            if have[i] is not None:
                continue
            with self.lock:
                have[i], where[i] = self.find(keys[i], private)    # made meanwhile by another request
                if have[i] is not None:
                    continue
                if reading is not None and is_cancelled(reading):
                    raise Cancelled()
                t = time.time()
                parts = partss[i]
                audio = [self._generate(text, voices[i], instr, reading, seed, strength=st) for text, instr, st in parts]
                a = np.concatenate(audio) if audio else np.zeros(int(0.2 * self.sr), dtype=np.float32)
                path = os.path.join(self.private_dir if private else self.cache_dir, keys[i] + '.wav')
                sf.write(path + '.part', a, self.sr, format='WAV')
                os.replace(path + '.part', path)
                have[i], where[i] = len(a) / float(self.sr), private
                made += 1
                fresh.add(i)
                log('rendered piece %s: %.1fs of audio in %.1fs (%.2fx realtime, %d part%s, %s)'
                    % (b.get('id'), have[i], time.time() - t, (time.time() - t) / max(have[i], 0.01),
                       len(parts), '' if len(parts) == 1 else 's', voices[i]))
        cached = len(blocks) - made
        if cached:
            log('%d of %d pieces from the cache' % (cached, len(blocks)))
        return ([{'id': b['id'], 'file': k + '.wav', 'seconds': round(s, 3), 'private': p, 'instruction': i,
                  'voice': v, 'cached': n not in fresh,
                  'parts': [{'text': t, 'instruction': ins, 'strength': st} for t, ins, st in ps]}
                 for n, (b, k, s, p, i, v, ps) in enumerate(zip(blocks, keys, have, where, tolds, voices, partss))], cached)

    def preview(self, voice, style, reading=None):
        items, _ = self.render_group([{'id': 0, 'text': PREVIEW_TEXT}], voice, 1234, reading, style)
        return os.path.join(self.cache_dir, items[0]['file']), items[0]['seconds']


class Handler(BaseHTTPRequestHandler):
    narrator = None

    def _send(self, code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        # Bound to the loopback; the page TypoZen serves calls this directly.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        n = Handler.narrator
        if self.path.startswith('/health'):
            self._send(200, {'ready': n.ready, 'error': n.load_error, 'private': n.private_dir or '',
                             'model': MODEL_ID, 'engine': 'breeze', 'mode': n.mode,
                             'voices': sorted(n.voices), 'cache': n.cache_dir})
        elif self.path.startswith('/voices'):
            self._send(200, {'voices': n.voice_list(), 'default': DEFAULT_VOICE})
        else:
            self._send(404, {'error': 'no such path'})

    def _voice_library(self, body):
        n = Handler.narrator
        try:
            if not n.ready:
                self._send(503, {'error': 'the narrator is still starting'})
                return
            if self.path.startswith('/design'):
                desc = (body.get('description') or '').strip()
                if not desc:
                    self._send(400, {'error': 'describe the voice'})
                    return
                t = time.time()
                out = n.design(desc, body.get('count') or 3, body.get('style') or '')
                self._send(200, {'candidates': out, 'seconds': round(time.time() - t, 1)})
            elif self.path.startswith('/voices/clone'):
                t = time.time()
                out = n.clone(body.get('path') or '', body.get('transcript') or '',
                              body.get('start'), body.get('end'), body.get('style') or '')
                self._send(200, {'candidates': [out], 'seconds': round(time.time() - t, 1)})
            elif self.path.startswith('/voices/keep'):
                self._send(200, {'id': n.keep(body.get('candidate') or '', body.get('name') or '')})
            elif self.path.startswith('/voices/import'):
                vid, name, already = n.import_voice(body.get('path') or '')
                self._send(200, {'id': vid, 'name': name, 'already': already})
            elif self.path.startswith('/voices/delete'):
                n.delete_voice(body.get('id') or '')
                self._send(200, {'ok': True})
            elif self.path.startswith('/preview'):
                path, secs = n.preview(n.known_voice(body.get('voice') or DEFAULT_VOICE), body.get('style') or '')
                self._send(200, {'file': path, 'seconds': secs})
            else:
                self._send(404, {'error': 'no such path'})
        except ValueError as e:
            log('%s refused: %s' % (self.path, e))
            self._send(400, {'error': str(e)})
        except Exception as e:
            import traceback
            log('%s FAILED:\n%s' % (self.path, traceback.format_exc()))
            self._send(500, {'error': '%s: %s' % (type(e).__name__, e)})

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception as e:
            self._send(400, {'error': 'bad json: %s' % e})
            return
        if self.path.startswith('/logging'):
            global LOG_ON
            LOG_ON = bool(body.get('on', True))
            self._send(200, {'logging': LOG_ON})
            return
        if self.path.startswith('/log'):
            for line in (body.get('lines') or [])[:200]:
                log(str(line)[:500], who='page')
            self._send(200, {'ok': True})
            return
        touch()
        if self.path.startswith('/cancel'):
            rid = int(body.get('reading', 0))
            cancel(rid)
            log('reading %d cancelled' % rid)
            self._send(200, {'cancelled': rid})
            return
        if self.path.startswith('/stop'):
            log('stop requested by the host')
            self._send(200, {'stopping': True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path.startswith(('/design', '/voices/', '/preview')):
            self._voice_library(body)
            return
        if not self.path.startswith('/render'):
            self._send(404, {'error': 'no such path'})
            return

        n = Handler.narrator
        if not n.ready:
            self._send(503, {'error': 'the narrator is still starting'})
            return
        blocks = [b for b in (body.get('blocks') or []) if (b.get('text') or '').strip()]
        if not blocks:
            self._send(400, {'error': 'no blocks with text'})
            return
        voice = n.known_voice(body.get('voice') or DEFAULT_VOICE)
        whole = body.get('instruction')
        whole = whole if isinstance(whole, str) else None
        seed = int(body.get('seed', 1234))
        reading = int(body.get('reading', 0))
        private = bool(body.get('private'))
        started = time.time()
        log('render request: reading %d, voice %s,%s %d pieces [%s]' % (
            reading, voice, ' private,' if private else '', len(blocks),
            ' '.join('%s:%dch%s%s' % (b.get('id'), len(b.get('text') or ''),
                                      '<%s>' % b['voice'] if b.get('voice') else '',
                                      '[%s]' % b['direction'] if b.get('direction') else '') for b in blocks)))
        if is_cancelled(reading):
            self._send(200, {'items': [], 'cancelled': True})
            return
        try:
            items, from_cache = n.render_group(blocks, voice, seed, reading, body.get('style') or '',
                                               private, whole, body.get('cue') or '',
                                               clamp_strength(body.get('strength')))
        except Cancelled:
            log('reading %d cancelled mid-piece; nothing kept from that piece' % reading)
            self._send(200, {'items': [], 'cancelled': True})
            return
        except Exception as e:
            import traceback
            log('render FAILED for reading %d:\n%s' % (reading, traceback.format_exc()))
            self._send(500, {'error': '%s: %s' % (type(e).__name__, e)})
            return
        log('render answered: reading %d, %d items in %.1fs (%d from the cache)'
            % (reading, len(items), time.time() - started, from_cache))
        self._send(200, {'items': items, 'voice': voice, 'seed': seed, 'from_cache': from_cache})


_last_used = time.time()


def touch():
    global _last_used
    _last_used = time.time()


def watch_idle(server, minutes):
    while True:
        time.sleep(30)
        if time.time() - _last_used > minutes * 60:
            log('idle for %d minutes, shutting down to release the GPU' % minutes)
            server.shutdown()
            return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True, help='where rendered audio goes')
    ap.add_argument('--private-cache', default=None, help='where audio for a private request goes')
    ap.add_argument('--port', type=int, default=8766)
    ap.add_argument('--idle-minutes', type=int, default=15)
    ap.add_argument('--models', default=None, help='the model folder; defaults to model/ beside the cache')
    ap.add_argument('--code', default=None, help="Breeze's inference code; defaults to breeze-tts/ beside the cache")
    ap.add_argument('--qwen-voices', default=None, help="the Qwen narrator's voices folder, read only")
    ap.add_argument('--eager', action='store_true', help='skip the fast path')
    ap.add_argument('--quiet', action='store_true', help='write nothing to narration.log (Privacy Mode)')
    args = ap.parse_args()
    global LOG_ON
    LOG_ON = not args.quiet

    root = os.path.dirname(os.path.abspath(args.cache))
    # Compiled kernels and the network: both stay inside the extension's folder, so Remove takes
    # everything, and nothing is fetched while reading. Set before torch is imported.
    compiled = os.path.join(root, 'compiled')
    os.environ['TORCHINDUCTOR_CACHE_DIR'] = os.path.join(compiled, 'inductor')
    os.environ['TRITON_CACHE_DIR'] = os.path.join(compiled, 'triton')
    os.environ['HF_HOME'] = os.path.join(root, 'hf')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'

    open_log(os.path.join(root, 'narration.log'))
    log('---- sidecar starting: pid %d, python %s, script %s'
        % (os.getpid(), sys.version.split()[0], os.path.abspath(__file__)))
    narrator = Narrator(args.cache, args.private_cache,
                        models=args.models or os.path.join(root, 'model'),
                        code=args.code or os.path.join(root, 'breeze-tts'),
                        qwen_voices=args.qwen_voices, eager=args.eager)
    Handler.narrator = narrator
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except Exception as e:
        log('cannot listen on port %d: %s -- another narrator already running?' % (args.port, e))
        raise
    log('listening on 127.0.0.1:%d, cache %s' % (args.port, args.cache))
    threading.Thread(target=narrator.load, daemon=True).start()
    threading.Thread(target=watch_idle, args=(server, args.idle_minutes), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    log('stopped')


if __name__ == '__main__':
    main()
