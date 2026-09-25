"""TypoZen's narration service: one resident process, HTTP on the loopback.

Resident because there is no streaming mode in qwen-tts and loading the weights costs 8.3
seconds; paying that once per session is the difference between three seconds to first
sound and eleven.

Renders in batches rather than one piece at a time: a batch of eight paragraphs runs at
about 0.4-0.65x realtime against 2.1x one at a time (measured 2026-09-23, with each clip
decoded separately -- see _decode_clips_separately), so batching is what makes narration
outrun listening at all. Since 2026-09-24 generation runs as CUDA graphs (graphs.py): the
code predictor alone made it 2.7x faster (one sentence 0.85x realtime, eight 0.14x), and a
whole frame as one graph 1.3-1.5x more (0.62x and 0.09x).

The cache is per piece: its key is the model, the voice-print, the style and the piece's
text. A piece already on disk is never rendered again, whatever batch asks for it, so a
batch can start wherever the reader does and replay, restart and render-ahead all reuse
what exists. The price: a piece's take depends on the batch it was rendered in, so
clearing the cache and narrating again gives a different take of the same voice.

This replaced a cache keyed on fixed groups of eight blocks, which kept re-renders
identical but made a start near the end of a group render the whole group -- mostly text
nobody would hear -- and then wait for the next one: 117s to first sound on 2026-09-23.

  GET  /health                     is the model up
  POST /render                     {"blocks":[{"id":1,"text":"..."}], "voice":"...", ...}
                                   -> {"items":[{"id":1,"file":"...","seconds":3.7}]}
  POST /stop                       shut down

Run it by hand:
  venv\\Scripts\\python.exe sidecar.py --cache <dir> --port 8765
"""
import argparse
import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# This script and graphs.py ship beside TypoZen.exe, where nothing may be written: an MSIX
# install folder is read-only, and the uninstaller removes only what it installed. Importing
# graphs would otherwise leave a __pycache__ folder there. Reading existing .pyc is unaffected.
sys.dont_write_bytecode = True
import graphs  # noqa: E402

# CustomVoice, with the narrator's voice-print in the speaker slot (docs/qwen-tts-plan.md 3g).
#
# VoiceDesign, used before, invents the speaker afresh on every piece it renders, so the
# narrator changed from paragraph to paragraph -- "multiple people narrating". CustomVoice
# holds whatever speaker it is given and still takes a style instruction. It is given the
# voice-print of the northern-English narrator Ed chose (taken with the Base model's speaker
# encoder from one VoiceDesign recording of that voice), so the voice is his choice and it
# stays put. Chosen by ear on 2026-09-23 against the old narration and a pinned VoiceDesign.
MODEL_REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'

# How the narrator reads when the reader has set no style of their own. The voice is not
# described here -- it comes from the voice-print.
NARRATION_BASE = (
    "Narrate as an accomplished audiobook reader of literary fiction: measured and "
    "unhurried, phrasing that follows the sense of the sentence, understated rather than "
    "performed."
)
LIGHT_DIALOGUE = " Give the spoken lines a light, distinct colour without acting them out."
NARRATION_CRAFT = NARRATION_BASE + LIGHT_DIALOGUE

# Direction (slice 3): the page reads how a paragraph's spoken lines should sound from the text
# around them -- "whispered, hushed", "sharp and angry" -- and it is added to the instruction
# for that paragraph only. 'thought' is a paragraph that is a character's private thought.
DIRECTED_SUFFIX = (" Voice the lines in quotation marks as %s, clearly but with restraint, "
                   "and keep the narration around them measured.")
THOUGHT_SUFFIX = " This passage is a character's private thought: read it quieter and more inward."
# Cast (slice 4): a quoted line spoken in a character's own voice, apart from the narration.
DIALOGUE = "Speak this line of dialogue as the character would say it, naturally and in character."
DIALOGUE_DIRECTED = "Speak this line of dialogue as the character would say it: %s."

HERE = os.path.dirname(os.path.abspath(__file__))
# The voice the narrator shipped with. Others are designed from a description in TypoZen
# (Narrator settings) and kept in voices/ beside the cache, one folder each.
BUILTIN_VOICES = {
    'northern-english': {
        'name': 'Northern English (original)',
        'description': ('A British woman with a soft northern English accent, gentle and '
                        'grounded, with a low steady delivery.'),
        'print': os.path.join(HERE, 'northern-english.npy'),
    },
}
DEFAULT_VOICE = 'northern-english'
# A voice-print is the speaker encoder's x-vector: this many float32 values.
VOICE_PRINT_SIZE = 2048
GROUP_SIZE = 8

# Designing a voice: VoiceDesign turns the description into a speaker reading DESIGN_TEXT
# (about 12s, as the original reference was); that recording gives the voice-print; the
# narrator then reads PREVIEW_TEXT in it, which is what the voice will sound like in use.
VOICEDESIGN_REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'
BASE_REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base'
DESIGN_TEXT = ("The road ran straight across the plain, and the mountains beyond it were pale "
               "with distance. She had been walking since the morning, and the light had not "
               "changed at all. There was nothing to mark the hours but the sound of her own steps.")
PREVIEW_TEXT = ("“You should have waited for me,” she said quietly, and for a while "
                "neither of them spoke.")


# narration.log, beside the cache in the extension folder. Always on: nobody sees this
# process's console, so without the file a failed reading leaves no trace at all. The page
# writes its side of the story here too (POST /log), so one file holds the whole timeline.
# Ids, counts, lengths and timings only -- never the text being read.
LOG_PATH = None
_log_lock = threading.Lock()


def log(m, who='sidecar'):
    t = time.time()
    line = '%s.%03d  %-7s %s' % (time.strftime('%H:%M:%S', time.localtime(t)), int(t * 1000) % 1000, who, m)
    print(line, flush=True)
    if LOG_PATH:
        with _log_lock:
            try:
                with open(LOG_PATH, 'a', encoding='utf-8') as f:
                    f.write(line + '\n')
            except Exception:
                pass


def open_log(path):
    """Start the log, keeping one previous file so a restart does not lose the last run."""
    global LOG_PATH
    try:
        if os.path.exists(path) and os.path.getsize(path) > 2 * 1024 * 1024:
            os.replace(path, path + '.1')
    except Exception:
        pass
    LOG_PATH = path


def harden_snapshot(folder):
    """Replace the symbolic links in a Hugging Face snapshot with hard links to the same blobs.

    A snapshot holds each file as a symbolic link to its blob, and Windows intermittently
    refused to open files through those links -- OSError 22 on config.json, for a whole process
    at a time, which is how 4 of 12 narrator starts failed on 2026-09-24. A hard link is an
    ordinary file to Windows: the same bytes, no extra disk.

    Safe to interrupt: the hard link is made under a temporary name first, and a start that
    finds one left behind finishes the swap. A file that cannot be hard-linked (another
    volume, a file system without them) stays a symbolic link and is logged; nothing is
    copied, which would double gigabytes silently.
    """
    converted = 0
    for dirpath, _, names in os.walk(folder):
        for name in names:
            p = os.path.join(dirpath, name)
            if not os.path.lexists(p):
                continue                         # renamed away earlier in this pass
            try:
                if name.endswith('.hardlink'):
                    orig = p[:-len('.hardlink')]
                    if not os.path.lexists(orig):
                        os.rename(p, orig)       # a swap interrupted after the link was removed
                        log('snapshot: finished an interrupted swap for %s' % orig)
                    elif not os.path.islink(orig):
                        os.remove(p)             # the swap had finished; this is a spare name
                    continue
                if not os.path.islink(p):
                    continue
                blob = os.path.normpath(os.path.join(dirpath, os.readlink(p)))
                if not os.path.isfile(blob):
                    log('snapshot: %s links to a missing blob, left as it is' % p)
                    continue
                tmp = p + '.hardlink'
                if os.path.lexists(tmp):
                    os.remove(tmp)
                os.link(blob, tmp)
                os.unlink(p)                     # the symbolic link itself, not its blob
                os.rename(tmp, p)
                converted += 1
            except OSError as e:
                log('snapshot: could not make %s a hard link (%s); left as it is' % (p, e))
    if converted:
        log('snapshot: %d symbolic links in %s replaced by hard links' % (converted, folder))
    return converted


def config_facts(folder):
    """What config.json in `folder` holds right now: for a failed load's log line."""
    try:
        p = os.path.join(folder, 'config.json')
        with open(p, 'rb') as f:
            raw = f.read()
        d = json.loads(raw.decode('utf-8'))
        return 'config.json %d bytes via %s, model_type %r, keys %s' % (
            len(raw), os.path.realpath(p), d.get('model_type'), ','.join(sorted(d)[:12]))
    except Exception as e:
        return 'config.json unreadable: %s: %s' % (type(e).__name__, e)


def backup_dir():
    """Where kept voices are copied: OneDrive, so that losing this PC does not lose them.

    A voice cannot be made again -- the same description gives a different person -- and the
    extension's own folder is not synced anywhere. TYPOZEN_VOICE_BACKUP overrides the place
    (for tests); set to '' it turns the backup off.
    """
    b = os.environ.get('TYPOZEN_VOICE_BACKUP')
    if b is None:
        od = os.environ.get('OneDrive') or os.environ.get('OneDriveConsumer')
        b = os.path.join(od, 'TypoZen', 'Narrator voices') if od else ''
    return b


def recycle(path):
    """Delete to the Recycle Bin, so it can be restored. True if it went.

    Falls back to a _deleted folder beside it rather than erasing anything.
    """
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
        FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 3, 0x4, 0x10, 0x40, 0x400
        # pFrom is a double-null-terminated list: the string's own null plus this one.
        op = SHFILEOPSTRUCTW(None, FO_DELETE, os.path.abspath(path) + '\0', None,
                             FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI, False, None, None)
        if ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0 and not os.path.exists(path):
            return True
    except Exception as e:
        log('Recycle Bin unavailable for %s: %s' % (path, e))
    import shutil
    aside = os.path.join(os.path.dirname(path), '_deleted')
    os.makedirs(aside, exist_ok=True)
    shutil.move(path, os.path.join(aside, '%s-%d' % (os.path.basename(path), int(time.time()))))
    log('moved %s to %s instead' % (path, aside))
    return False


class Narrator(object):
    def __init__(self, cache_dir, private_dir=None):
        self.cache_dir = cache_dir
        # Privacy Mode: audio rendered while it is on goes here -- a per-session folder that
        # TypoZen deletes when Privacy Mode ends or the app closes -- and never into cache_dir,
        # which is only read from. Without it, private reading left every clip behind.
        self.private_dir = private_dir
        self.voices_dir = os.path.join(os.path.dirname(os.path.abspath(cache_dir)), 'voices')
        self.lock = threading.Lock()
        self.model = None
        # Set only once load() has finished everything, voices included. /health said ready as
        # soon as the weights were in, and a render arriving in the moment before the voices
        # were read failed with KeyError (hit on 2026-09-24 by a probe polling /health).
        self.ready = False
        self.load_error = ''         # why the model did not load, once that is known
        self.encoder = None
        self.sr = None
        self.prints = {}
        self.voice_meta = {}
        os.makedirs(cache_dir, exist_ok=True)
        os.makedirs(self.voices_dir, exist_ok=True)

    def sync_backup(self):
        """Every kept voice in the backup, and every backed-up voice here.

        Copies out any voice the backup lacks, and brings back any it holds that this folder
        lacks -- after the extension is set up again, or on another PC. Deleting a voice takes
        it out of both, so a deletion is not undone by this.
        """
        import shutil
        b = backup_dir()
        if not b:
            return
        try:
            os.makedirs(b, exist_ok=True)
            here = lambda root, vid: os.path.isfile(os.path.join(root, vid, 'print.npy'))
            for vid in os.listdir(self.voices_dir):
                if not vid.startswith('_') and here(self.voices_dir, vid) and not here(b, vid):
                    shutil.copytree(os.path.join(self.voices_dir, vid), os.path.join(b, vid), dirs_exist_ok=True)
                    log('voice %s backed up to %s' % (vid, b))
            for vid in os.listdir(b):
                if not vid.startswith('_') and here(b, vid) and not here(self.voices_dir, vid):
                    shutil.copytree(os.path.join(b, vid), os.path.join(self.voices_dir, vid), dirs_exist_ok=True)
                    log('voice %s restored from %s' % (vid, b))
        except Exception as e:
            log('voice backup failed: %s' % e)

    def reload_voices(self):
        """The built-in voice and every kept one: id -> (voice-print tensor, its hash)."""
        import numpy as np
        self.sync_backup()
        prints, meta = {}, {}
        for vid, v in BUILTIN_VOICES.items():
            raw = np.load(v['print']).astype(np.float32)
            prints[vid] = (self.torch.from_numpy(raw), hashlib.sha256(raw.tobytes()).hexdigest())
            meta[vid] = {'id': vid, 'name': v['name'], 'description': v['description'], 'builtin': True,
                         'preview': ''}
        for vid in sorted(os.listdir(self.voices_dir)):
            d = os.path.join(self.voices_dir, vid)
            if vid.startswith('_') or not os.path.isfile(os.path.join(d, 'print.npy')):
                continue
            try:
                raw = np.load(os.path.join(d, 'print.npy')).astype(np.float32)
                with open(os.path.join(d, 'meta.json'), encoding='utf-8') as f:
                    m = json.load(f)
                prints[vid] = (self.torch.from_numpy(raw), hashlib.sha256(raw.tobytes()).hexdigest())
                meta[vid] = {'id': vid, 'name': m.get('name') or vid, 'description': m.get('description', ''),
                             'builtin': False, 'preview': os.path.join(d, 'preview.wav')}
            except Exception as e:
                log('voice %s unreadable, skipped: %s' % (vid, e))
        self.prints, self.voice_meta = prints, meta
        log('voices: %s' % ', '.join(sorted(prints)))

    def known_voice(self, vid):
        return vid if vid in self.prints else DEFAULT_VOICE

    def load(self):
        # A failure here used to die silently in its thread: /health just never said ready,
        # and the host gave up after three minutes with nothing to say why.
        try:
            t = time.time()
            import torch
            from qwen_tts import Qwen3TTSModel
            from huggingface_hub import snapshot_download
            self.torch = torch
            # From the local folder, not the repository name. Given a name, the tokenizer
            # loader asks the Hugging Face API about the model even when every file is on
            # disk -- which fails offline, and online cost most of a 51-second start. Given
            # a path it asks nothing: 16 seconds, and no network.
            local = snapshot_download(MODEL_REPO, local_files_only=True)
            harden_snapshot(local)
            # Retried: on 2026-09-24, 4 of 12 starts failed about 8s in with "Unrecognized
            # model ... should have a model_type key in its config.json" -- although the file has
            # one. The logged cause: opening config.json failed with OSError 22 (Windows'
            # ERROR_CANT_ACCESS_FILE), because every file in a Hugging Face snapshot is a symbolic
            # link to its blob and Windows intermittently refused to follow it, for a whole
            # process at a time. harden_snapshot (above) now replaces them with hard links before
            # every load; the retry and config_facts stay in case a file cannot be converted.
            for attempt in range(1, 4):
                try:
                    self.model = Qwen3TTSModel.from_pretrained(local, device_map='cuda:0',
                                                               dtype=torch.bfloat16)
                    break
                except ValueError as e:
                    log('model load attempt %d failed: %s | %s'
                        % (attempt, str(e).splitlines()[0][:160], config_facts(local)))
                    if attempt == 3:
                        raise
                    time.sleep(2)
            self.reload_voices()
            self._decode_clips_separately()
            # CUDA graphs (graphs.py): a whole frame as one graph, the predictor's own graph as
            # its fallback. Before the cancel hook, which wraps whatever generate() is in place.
            graphs.graph_talker(self.model, torch, log)
            graphs.graph_code_predictor(self.model, torch, log)
            talker = self.model.model.talker
            self.release_graphs = [talker.generate.release, talker.code_predictor.generate.release]
            self._stop_when_cancelled()
            self.ready = True
            log('model ready in %.1fs (%s)' % (time.time() - t, MODEL_REPO))
        except Exception as e:
            import traceback
            # Said on /health, so the host stops waiting and tells the reader, rather than
            # showing "starting" for its three-minute limit (2026-09-24).
            self.load_error = (str(e).splitlines() or [type(e).__name__])[0][:200]
            log('model load FAILED:\n' + traceback.format_exc())

    # The reading whose batch is inside the model right now, so a cancel can reach it.
    generating_for = None

    def _stop_when_cancelled(self):
        """Stop a batch mid-generation when its reading is cancelled.

        Cancelling used to drop only the batches not yet started; one already in the model ran
        to its end, up to a minute, holding the model while the reader waited. Measured on
        2026-09-23: a one-sentence Read queued behind an abandoned batch for 41s. Generation
        now checks for a cancel at every step and stops at the next one. qwen-tts does not
        pass a stopping criterion through, so it is added to the talker's generate here.
        """
        torch = self.torch
        from transformers import StoppingCriteria, StoppingCriteriaList
        narrator = self

        class StopWhenCancelled(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):
                r = narrator.generating_for
                stop = r is not None and is_cancelled(r)
                return torch.full((input_ids.shape[0],), stop, dtype=torch.bool, device=input_ids.device)

        talker = self.model.model.talker
        inner = talker.generate

        def generate(*a, **k):
            crit = k.pop('stopping_criteria', None) or StoppingCriteriaList()
            crit.append(StopWhenCancelled())
            return inner(*a, stopping_criteria=crit, **k)

        talker.generate = generate

    def _decode_clips_separately(self):
        """Batch the model, never the codec.

        After generating a group, qwen-tts decodes all its clips to audio in one padded call,
        in 300-frame chunks. Measured on 2026-09-23 with a real group from Matter (clips up to
        324 frames, 26s): generation took 57s at the expected 5.6 steps/s, and the batched
        decode then ran for over a minute -- it is most of the 137s each group took in
        narration.log. The same eight clips decoded one at a time took 1.1s in total. Batching
        is what makes generation fast; for the decoder it does the opposite.
        """
        tok = self.model.model.speech_tokenizer
        batched = tok.decode

        def decode_each(encoded):
            t = time.time()
            if not isinstance(encoded, list) or len(encoded) < 2:
                out = batched(encoded)
            else:
                wavs, sr = [], None
                for one in encoded:
                    w, sr = batched([one])
                    wavs.extend(w)
                out = (wavs, sr)
            self.last_decode_s = time.time() - t
            return out

        tok.decode = decode_each

    @staticmethod
    def instruction(style, direction, role='narration'):
        """The full instruction for one piece.

        Narration: the reader's own style if they set one, else the standing one, plus the
        paragraph's direction. With no style and no direction this is NARRATION_CRAFT exactly,
        so audio rendered before styles existed stays valid. A cast line (role 'dialogue') is
        spoken in the character's voice and takes only its own direction.
        """
        direction = (direction or '').strip()[:80]
        style = (style or '').strip()[:300]
        if role == 'dialogue':
            return DIALOGUE_DIRECTED % direction if direction and direction != 'thought' else DIALOGUE
        base = ('Narrate as an audiobook reader of literary fiction. ' + style) if style else NARRATION_BASE
        if not direction:
            return base + LIGHT_DIALOGUE
        if direction == 'thought':
            return base + THOUGHT_SUFFIX
        return base + DIRECTED_SUFFIX % direction

    def key_for(self, text, voice, instruction):
        """One piece's cache key: the model, the voice-print, the instruction and the text."""
        h = hashlib.sha256()
        h.update(MODEL_REPO.encode('utf-8'))
        h.update(b'\x00')
        h.update(self.prints[voice][1].encode('utf-8'))
        h.update(b'\x00')
        h.update(instruction.encode('utf-8'))
        h.update(b'\x00')
        h.update(text.encode('utf-8'))
        return h.hexdigest()[:20]

    def generate(self, texts, prints, instructions):
        """One batched generation, each piece with its own voice-print and instruction.

        qwen-tts has no public call for this pairing -- generate_custom_voice takes only its
        nine named speakers, generate_voice_clone takes a voice-print but no instruction --
        so this is generate_custom_voice with the voice-print passed the way
        generate_voice_clone passes one (x-vector only, no reference audio).
        """
        m = self.model
        n = len(texts)
        prompt = dict(ref_code=[None] * n, ref_spk_embedding=list(prints),
                      x_vector_only_mode=[True] * n, icl_mode=[False] * n)
        input_ids = m._tokenize_texts([m._build_assistant_text(t) for t in texts])
        tokenized = {}
        for i in set(instructions):
            tokenized[i] = m._tokenize_texts([m._build_instruct_text(i)])[0]
        codes, _ = m.model.generate(input_ids=input_ids, instruct_ids=[tokenized[i] for i in instructions],
                                    voice_clone_prompt=prompt, languages=['English'] * n,
                                    non_streaming_mode=True, **m._merge_generate_kwargs())
        return m.model.speech_tokenizer.decode([{'audio_codes': c} for c in codes])

    def cached(self, key, folder=None):
        """Seconds of audio for a piece already on disk, or None."""
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
        """(seconds, found in the private folder) for a piece on disk, or (None, False).

        A private reading looks in its own folder first, then in the ordinary cache: audio
        made before Privacy Mode was turned on is already on disk, and reading it adds nothing.
        """
        if private and self.private_dir:
            s = self.cached(key, self.private_dir)
            if s is not None:
                return s, True
        return self.cached(key), False

    def render_group(self, blocks, voice, seed, reading=None, style='', private=False):
        """Audio for each block, from the cache where it exists; the rest in one batched call.

        Each block may name its own voice (a cast line) and role; the rest use `voice`.
        Returns ([{id, file, seconds, private}] in the order given, how many came from the
        cache). `private` puts new pieces in the private folder, never the ordinary cache.
        Raises Cancelled if the reading is cancelled while its batch is being generated;
        nothing from that batch is kept.
        """
        import numpy as np
        import soundfile as sf

        private = bool(private and self.private_dir)
        if private:
            os.makedirs(self.private_dir, exist_ok=True)
        voices = [self.known_voice(b.get('voice') or voice) for b in blocks]
        instructions = [self.instruction(style, b.get('direction'), b.get('role') or 'narration') for b in blocks]
        keys = [self.key_for(b['text'], v, i) for b, v, i in zip(blocks, voices, instructions)]
        found = [self.find(k, private) for k in keys]
        have = [f[0] for f in found]
        where = [f[1] for f in found]
        todo = [i for i, s in enumerate(have) if s is None]
        if todo:
            waited = time.time()
            with self.lock:
                # Asked for twice at once -- Narrate pressed on text being rendered ahead --
                # the second request waits here, then takes whatever the first one made
                # rather than rendering it again.
                for i in todo:
                    have[i], where[i] = self.find(keys[i], private)
                before = len(todo)
                todo = [i for i in todo if have[i] is None]
                if time.time() - waited > 0.5:
                    log('waited %.1fs for the model; %d of %d pieces were rendered meanwhile'
                        % (time.time() - waited, before - len(todo), before))
                if todo and reading is not None and is_cancelled(reading):
                    raise Cancelled()
                if todo:
                    self.torch.manual_seed(seed)
                    self.torch.cuda.manual_seed_all(seed)
                    t = time.time()
                    self.generating_for = reading
                    try:
                        wavs, sr = self.generate([blocks[i]['text'] for i in todo],
                                                 [self.prints[voices[i]][0] for i in todo],
                                                 [instructions[i] for i in todo])
                    finally:
                        self.generating_for = None
                    took = time.time() - t
                    if reading is not None and is_cancelled(reading):
                        # Stopped mid-way: the clips are cut short, so none of them is kept.
                        log('reading %d cancelled mid-batch; stopped after %.1fs, nothing kept'
                            % (reading, took))
                        raise Cancelled()
                    total = 0.0
                    for i, wav in zip(todo, wavs):
                        a = np.asarray(wav, dtype=np.float32)
                        path = os.path.join(self.private_dir if private else self.cache_dir,
                                            keys[i] + '.wav')
                        where[i] = private
                        # Written aside and moved into place, so a piece is never found
                        # half-written by a request that checks the cache meanwhile.
                        sf.write(path + '.part', a, sr, format='WAV')
                        os.replace(path + '.part', path)
                        have[i] = len(a) / float(sr)
                        total += have[i]
                    log('rendered %d pieces: %.1fs of audio in %.1fs (%.2fx realtime, decode %.1fs); clips %s'
                        % (len(todo), total, took, took / total if total else 0,
                           getattr(self, 'last_decode_s', -1),
                           ' '.join('%s:%.1fs' % (blocks[i]['id'], have[i]) for i in todo)))
        cached = len(blocks) - len(todo)
        if cached:
            log('%d of %d pieces from the cache' % (cached, len(blocks)))
        items = [{'id': b['id'], 'file': k + '.wav', 'seconds': round(s, 3), 'private': p}
                 for b, k, s, p in zip(blocks, keys, have, where)]
        return items, cached

    # ---- the voice library: design from a description, keep, delete, preview ----------------

    @staticmethod
    def encoder_path():
        return os.path.join(os.environ.get('HF_HUB_CACHE', ''), 'speaker-encoder.pt')

    def _load_encoder(self):
        """The speaker encoder, which turns a recording into a voice-print. Only Base has one.

        It is a small part of Base, so it is kept on its own in models\\speaker-encoder.pt and
        loaded from there: the rest of Base (4.2GB) is then not needed on disk at all. If the
        file is missing and Base is present, the encoder is taken from Base once and saved.
        """
        import gc
        torch = self.torch
        from qwen_tts.core.models.modeling_qwen3_tts import Qwen3TTSSpeakerEncoder
        from qwen_tts.core.models.configuration_qwen3_tts import Qwen3TTSSpeakerEncoderConfig
        t = time.time()
        path = self.encoder_path()
        if os.path.isfile(path):
            saved = torch.load(path, map_location='cpu', weights_only=False)
            # Only the fields the config takes: to_dict() adds bookkeeping (dtype, versions)
            # that this class's constructor rejects.
            import inspect
            accepted = set(inspect.signature(Qwen3TTSSpeakerEncoderConfig.__init__).parameters)
            cfg = Qwen3TTSSpeakerEncoderConfig(**{k: v for k, v in saved['config'].items() if k in accepted})
            enc = Qwen3TTSSpeakerEncoder(cfg)
            enc.load_state_dict(saved['state'])
            self.encoder = enc.to('cuda:0', dtype=torch.bfloat16).eval()
            log('speaker encoder ready in %.1fs (from %s)' % (time.time() - t, os.path.basename(path)))
            return
        from qwen_tts import Qwen3TTSModel
        from huggingface_hub import snapshot_download
        base = Qwen3TTSModel.from_pretrained(snapshot_download(BASE_REPO, local_files_only=True),
                                             device_map='cuda:0', dtype=torch.bfloat16)
        self.encoder = base.model.speaker_encoder
        cfg = base.model.config.speaker_encoder_config.to_dict()
        del base
        gc.collect()
        torch.cuda.empty_cache()
        torch.save({'config': cfg, 'state': {k: v.detach().cpu() for k, v in self.encoder.state_dict().items()}}, path)
        log('speaker encoder ready in %.1fs (taken from Base, saved to %s)' % (time.time() - t, os.path.basename(path)))

    def voice_print(self, wav, sr):
        """A voice-print (2048 floats) from a recording at 24kHz."""
        import numpy as np
        from qwen_tts.core.models.modeling_qwen3_tts import mel_spectrogram
        if self.encoder is None:
            self._load_encoder()
        a = np.ascontiguousarray(np.asarray(wav, dtype=np.float32))
        mels = mel_spectrogram(self.torch.from_numpy(a).unsqueeze(0), n_fft=1024, num_mels=128,
                               sampling_rate=24000, hop_size=256, win_size=1024, fmin=0,
                               fmax=12000).transpose(1, 2)
        p = next(self.encoder.parameters())
        with self.torch.inference_mode():
            return self.encoder(mels.to(p.device).to(p.dtype))[0].float().cpu()

    def design(self, description, count=3, style=''):
        """Candidates for a voice described in words: each is a VoiceDesign recording of
        DESIGN_TEXT, the voice-print taken from it, and PREVIEW_TEXT read by the narrator in
        that print -- what the voice will actually sound like. The words make a slightly
        different speaker every time, which is why there are several; keeping one fixes it.
        """
        import gc
        import shutil
        import numpy as np
        import soundfile as sf
        from qwen_tts import Qwen3TTSModel
        from huggingface_hub import snapshot_download
        description = description.strip()[:400]
        count = max(1, min(int(count or 3), 4))
        cand_root = os.path.join(self.voices_dir, '_candidates')
        with self.lock:
            t = time.time()
            shutil.rmtree(cand_root, ignore_errors=True)
            os.makedirs(cand_root, exist_ok=True)
            # The narrator steps off the card while VoiceDesign is on it. Both at once overfill
            # 12GB, and Windows then pages GPU memory to system RAM instead of failing: the
            # first design took two and a half minutes that way. Moving the narrator's
            # weights out and back costs seconds.
            # Its CUDA graphs go too: they point at where the weights are now, and the talker's
            # holds a gigabyte of static cache that VoiceDesign needs more.
            for release in getattr(self, 'release_graphs', []):
                release()
            self.model.model.to('cpu')
            gc.collect()
            self.torch.cuda.empty_cache()
            try:
                vd_local = snapshot_download(VOICEDESIGN_REPO, local_files_only=True)
                harden_snapshot(vd_local)
                vd = Qwen3TTSModel.from_pretrained(vd_local, device_map='cuda:0', dtype=self.torch.bfloat16)
                graphs.graph_talker(vd, self.torch, log)
                graphs.graph_code_predictor(vd, self.torch, log)
                seed = int(time.time()) % 100000
                self.torch.manual_seed(seed)
                self.torch.cuda.manual_seed_all(seed)
                wavs, sr = vd.generate_voice_design(text=[DESIGN_TEXT] * count, instruct=[description] * count,
                                                    language='English')
                del vd
                gc.collect()
                self.torch.cuda.empty_cache()
                t_design = time.time() - t
                prints = [self.voice_print(w, sr) for w in wavs]
            finally:
                gc.collect()
                self.torch.cuda.empty_cache()
                self.model.model.to('cuda:0')
            previews, psr = self.generate([PREVIEW_TEXT] * count, prints,
                                          [self.instruction(style, '', 'narration')] * count)
            out = []
            for k, (w, p, pv) in enumerate(zip(wavs, prints, previews)):
                cid = 'c%d' % (k + 1)
                d = os.path.join(cand_root, cid)
                os.makedirs(d, exist_ok=True)
                np.save(os.path.join(d, 'print.npy'), p.numpy().astype(np.float32))
                sf.write(os.path.join(d, 'design.wav'), np.asarray(w, dtype=np.float32), sr)
                sf.write(os.path.join(d, 'preview.wav'), np.asarray(pv, dtype=np.float32), psr)
                with open(os.path.join(d, 'meta.json'), 'w', encoding='utf-8') as f:
                    json.dump({'description': description}, f)
                out.append({'candidate': cid, 'preview': os.path.join(d, 'preview.wav'),
                            'design': os.path.join(d, 'design.wav')})
        log('designed %d candidates in %.1fs (VoiceDesign %.1fs)' % (count, time.time() - t, t_design))
        return out

    def keep(self, candidate, name):
        """A candidate becomes a saved voice, named, with its preview kept as its sample."""
        import re
        import shutil
        src = os.path.join(self.voices_dir, '_candidates', os.path.basename(candidate))
        if not os.path.isfile(os.path.join(src, 'print.npy')):
            raise ValueError('no such candidate: %s' % candidate)
        name = (name or '').strip()[:60] or 'Voice'
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'voice'
        vid, n = slug, 2
        while os.path.exists(os.path.join(self.voices_dir, vid)) or vid in BUILTIN_VOICES:
            vid, n = '%s-%d' % (slug, n), n + 1
        dst = os.path.join(self.voices_dir, vid)
        shutil.copytree(src, dst)
        with open(os.path.join(dst, 'meta.json'), encoding='utf-8') as f:
            meta = json.load(f)
        meta['name'] = name
        with open(os.path.join(dst, 'meta.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f)
        self.reload_voices()                 # which also copies it to the backup
        log('kept candidate %s as voice %s' % (candidate, vid))
        return vid

    def import_voice(self, path):
        """A voice saved with Export (a .tzvoice file) or a voice folder, from wherever it is.

        Returns (id, name, already): `already` when the same voice is installed, under any name.
        Only the files a voice has are read, and each is checked before anything is written: the
        voice-print must be a plain array of VOICE_PRINT_SIZE finite numbers of a speaker
        encoder's scale, so a file that merely has the right name is refused rather than loaded.
        """
        import io
        import re
        import zipfile
        import numpy as np
        limits = {'print.npy': 64 << 10, 'meta.json': 64 << 10,
                  'preview.wav': 20 << 20, 'design.wav': 20 << 20}
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
        if 'print.npy' not in got or 'meta.json' not in got:
            raise ValueError('this is not a saved TypoZen voice (no voice-print in it)')
        try:
            raw = np.load(io.BytesIO(got['print.npy']), allow_pickle=False)
            meta = json.loads(got['meta.json'].decode('utf-8'))
        except Exception:
            raise ValueError('this voice is damaged and cannot be read')
        if (raw.shape != (VOICE_PRINT_SIZE,) or raw.dtype.kind != 'f' or not np.all(np.isfinite(raw))
                or not 1.0 < float(np.linalg.norm(raw)) < 100.0 or not isinstance(meta, dict)):
            raise ValueError('this file does not hold a voice this narrator can use')
        raw = raw.astype(np.float32)
        digest = hashlib.sha256(raw.tobytes()).hexdigest()
        for vid, (_, h) in self.prints.items():
            if h == digest:
                return vid, self.voice_meta.get(vid, {}).get('name', vid), True
        name = str(meta.get('name') or os.path.splitext(os.path.basename(path.rstrip('\\/')))[0])
        name = name.strip()[:60] or 'Voice'
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'voice'
        vid, n = slug, 2
        while os.path.exists(os.path.join(self.voices_dir, vid)) or vid in BUILTIN_VOICES:
            vid, n = '%s-%d' % (slug, n), n + 1
        dst = os.path.join(self.voices_dir, vid)
        os.makedirs(dst)
        np.save(os.path.join(dst, 'print.npy'), raw)
        with open(os.path.join(dst, 'meta.json'), 'w', encoding='utf-8') as f:
            json.dump({'name': name, 'description': str(meta.get('description') or '')[:2000]}, f)
        for wav in ('preview.wav', 'design.wav'):
            if got.get(wav, b'')[:4] == b'RIFF':
                with open(os.path.join(dst, wav), 'wb') as f:
                    f.write(got[wav])
        self.reload_voices()                 # which also copies it to the backup
        log('imported voice %s' % vid)
        return vid, name, False

    def delete_voice(self, vid):
        """To the Recycle Bin, here and in the backup: restorable, and not brought back by the backup."""
        if vid in BUILTIN_VOICES or vid.startswith('_') or '/' in vid or '\\' in vid:
            raise ValueError('cannot delete %s' % vid)
        recycle(os.path.join(self.voices_dir, vid))
        if backup_dir():
            recycle(os.path.join(backup_dir(), vid))
        self.reload_voices()
        log('deleted voice %s (to the Recycle Bin)' % vid)

    def preview(self, voice, style, reading=None):
        """PREVIEW_TEXT in a voice and style, through the cache like any other piece."""
        items, _ = self.render_group([{'id': 0, 'text': PREVIEW_TEXT}], voice, 1234, reading, style)
        return os.path.join(self.cache_dir, items[0]['file']), items[0]['seconds']


# Cancellation. A render request carries the id of the reading it belongs to; stopping the
# reading cancels that id, and any group not yet started is dropped. A group already inside
# generate() runs to the end -- there is no safe way to interrupt a CUDA call mid-flight --
# so the worst case is one group of wasted work rather than a queue of them.
#
# This exists because the first build had none: Stop stopped the playback, the page kept
# asking for more, and the card stayed at 99% rendering audio nobody was going to hear.
_cancelled = []
_cancel_lock = threading.Lock()


class Cancelled(Exception):
    """The reading was cancelled while its batch was being rendered."""


def cancel(reading_id):
    with _cancel_lock:
        _cancelled.append(reading_id)
        # Keep the newest by arrival, not by value: the page's play and render-ahead
        # readings count from different bases, so the largest id is not the latest.
        if len(_cancelled) > 64:
            del _cancelled[:32]


def is_cancelled(reading_id):
    with _cancel_lock:
        return reading_id in _cancelled


class Handler(BaseHTTPRequestHandler):
    narrator = None

    def _send(self, code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        # The page talks to this directly rather than relaying through the host: it already
        # owns the block queue and the reading highlight, and a relay would only copy text
        # from one process to another and back. Bound to the loopback, so the origin allowed
        # here is the page TypoZen serves itself.
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
        pass                                    # the server's own chatter is not useful here

    def do_GET(self):
        n = Handler.narrator
        if self.path.startswith('/health'):
            self._send(200, {'ready': n.ready,
                             'error': n.load_error,
                             'private': n.private_dir or '',
                             'model': MODEL_REPO,
                             'voices': sorted(n.prints),
                             'cache': n.cache_dir})
        elif self.path.startswith('/voices'):
            self._send(200, {'voices': [n.voice_meta[v] for v in sorted(n.voice_meta,
                                        key=lambda v: (not n.voice_meta[v]['builtin'], n.voice_meta[v]['name'].lower()))],
                             'default': DEFAULT_VOICE})
        else:
            self._send(404, {'error': 'no such path'})

    def _voice_library(self, body):
        """Design, keep, delete and preview: the voice library behind Narrator settings."""
        n = Handler.narrator
        try:
            if self.path.startswith('/design'):
                desc = (body.get('description') or '').strip()
                if not desc:
                    self._send(400, {'error': 'describe the voice'})
                    return
                log('design requested: %d candidates, %d-char description' % (int(body.get('count') or 3), len(desc)))
                t = time.time()
                out = n.design(desc, body.get('count') or 3, body.get('style') or '')
                self._send(200, {'candidates': out, 'seconds': round(time.time() - t, 1)})
            elif self.path.startswith('/voices/keep'):
                vid = n.keep(body.get('candidate') or '', body.get('name') or '')
                b = backup_dir()
                self._send(200, {'id': vid, 'backup': b if b and os.path.isfile(os.path.join(b, vid, 'print.npy')) else ''})
            elif self.path.startswith('/voices/import'):
                vid, name, already = n.import_voice(body.get('path') or '')
                self._send(200, {'id': vid, 'name': name, 'already': already})
            elif self.path.startswith('/voices/delete'):
                n.delete_voice(body.get('id') or '')
                self._send(200, {'ok': True})
            elif self.path.startswith('/preview'):
                path, secs = n.preview(n.known_voice(body.get('voice') or DEFAULT_VOICE), body.get('style') or '')
                self._send(200, {'file': path, 'seconds': secs})
        except ValueError as e:
            # Said to the reader as it stands: "this is not a saved TypoZen voice".
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

        if self.path.startswith('/log'):
            # The page's side of the timeline. Not a touch(): logging is not use, and must
            # not keep an idle narrator holding the GPU.
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

        blocks = body.get('blocks') or []
        # A voice that has been deleted since the page last heard falls back to the default
        # rather than failing the reading.
        voice = Handler.narrator.known_voice(body.get('voice') or DEFAULT_VOICE)
        style = body.get('style') or ''
        seed = int(body.get('seed', 1234))
        size = int(body.get('group_size', GROUP_SIZE))
        blocks = [b for b in blocks if (b.get('text') or '').strip()]
        if not blocks:
            self._send(400, {'error': 'no blocks with text'})
            return

        reading = int(body.get('reading', 0))
        private = bool(body.get('private'))
        started = time.time()
        log('render request: reading %d, voice %s,%s %d pieces [%s]' % (
            reading, voice, ' private,' if private else '', len(blocks),
            ' '.join('%s:%dch%s%s' % (b.get('id'), len(b.get('text') or ''),
                                      '<%s>' % b['voice'] if b.get('voice') else '',
                                      '[%s]' % b['direction'] if b.get('direction') else '') for b in blocks)))
        if is_cancelled(reading):
            log('reading %d already cancelled, nothing rendered' % reading)
            self._send(200, {'items': [], 'cancelled': True})
            return
        if not Handler.narrator.ready:
            log('render request before the model is ready')

        items, from_cache = [], 0
        try:
            for at in range(0, len(blocks), size):
                if is_cancelled(reading):
                    log('reading %d cancelled mid-request, %d blocks dropped'
                        % (reading, len(blocks) - at))
                    self._send(200, {'items': items, 'cancelled': True})
                    return
                got, cached = Handler.narrator.render_group(blocks[at:at + size], voice, seed, reading,
                                                            style, private)
                items.extend(got)
                from_cache += cached
        except Cancelled:
            self._send(200, {'items': items, 'cancelled': True})
            return
        except Exception as e:
            import traceback
            log('render FAILED for reading %d:\n%s' % (reading, traceback.format_exc()))
            self._send(500, {'error': '%s: %s' % (type(e).__name__, e)})
            return

        log('render answered: reading %d, %d items in %.1fs (%d from the cache)'
            % (reading, len(items), time.time() - started, from_cache))
        self._send(200, {'items': items, 'voice': voice, 'seed': seed, 'from_cache': from_cache})


# Idle shutdown. TypoZen stops this when it closes, but a crash or a killed process skips
# that, and a narrator left behind holds several gigabytes of VRAM for nothing. So it also
# stops itself once nobody has asked it for anything in a while.
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
    ap.add_argument('--cache', required=True, help='where the audio and manifests go')
    ap.add_argument('--private-cache', default=None,
                    help='where audio rendered for a request marked private goes')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--idle-minutes', type=int, default=15)
    ap.add_argument('--models', default=None,
                    help='weights folder; defaults to models/ beside the cache')
    args = ap.parse_args()

    # The weights live in the extension's own folder and nowhere else, and the network is
    # off. Without this the loader fell back to the global Hugging Face cache, downloaded
    # the model a second time on first start -- outside the extension, where Remove could
    # never reach it -- and made "no network except while installing" untrue.
    models = args.models or os.path.join(os.path.dirname(os.path.abspath(args.cache)), 'models')
    os.environ['HF_HUB_CACHE'] = models
    os.environ['HF_HOME'] = os.path.dirname(models)
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'

    open_log(os.path.join(os.path.dirname(os.path.abspath(args.cache)), 'narration.log'))
    log('---- sidecar starting: pid %d, python %s, script %s'
        % (os.getpid(), sys.version.split()[0], os.path.abspath(__file__)))

    narrator = Narrator(args.cache, args.private_cache)
    Handler.narrator = narrator

    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except Exception as e:
        log('cannot listen on port %d: %s -- another narrator already running?' % (args.port, e))
        raise
    log('listening on 127.0.0.1:%d, cache %s' % (args.port, args.cache))
    # Answer /health before the weights are in, so the host can tell "starting" from "dead".
    threading.Thread(target=narrator.load, daemon=True).start()
    threading.Thread(target=watch_idle, args=(server, args.idle_minutes), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    log('stopped')


if __name__ == '__main__':
    main()
