"""TypoZen's narration service: one resident process, HTTP on the loopback.

Resident because there is no streaming mode in qwen-tts and loading the weights costs 8.3
seconds; paying that once per session is the difference between three seconds to first
sound and eleven.

Renders in batches rather than one piece at a time: a batch of eight paragraphs runs at
about 0.4-0.65x realtime against 2.1x one at a time (measured 2026-09-23, with each clip
decoded separately -- see _decode_clips_separately), so batching is what makes narration
outrun listening at all.

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

# CustomVoice, with the narrator's voice-print in the speaker slot (docs/qwen-tts-plan.md 3g).
#
# VoiceDesign, used before, invents the speaker afresh on every piece it renders, so the
# narrator changed from paragraph to paragraph -- "multiple people narrating". CustomVoice
# holds whatever speaker it is given and still takes a style instruction. It is given the
# voice-print of the northern-English narrator Ed chose (taken with the Base model's speaker
# encoder from one VoiceDesign recording of that voice), so the voice is his choice and it
# stays put. Chosen by ear on 2026-09-23 against the old narration and a pinned VoiceDesign.
MODEL_REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice'

# How the narrator reads. The voice is not described here -- it comes from the voice-print.
NARRATION_CRAFT = (
    "Narrate as an accomplished audiobook reader of literary fiction: measured and "
    "unhurried, phrasing that follows the sense of the sentence, understated rather than "
    "performed. Give the spoken lines a light, distinct colour without acting them out."
)
HERE = os.path.dirname(os.path.abspath(__file__))
# A voice is a voice-print file beside this script plus the style it narrates in. Changing
# either changes every cache key that used it, which is intended: the audio on disk no
# longer matches the request.
VOICES = {
    'northern-english': {'print': os.path.join(HERE, 'northern-english.npy'), 'style': NARRATION_CRAFT},
}
DEFAULT_VOICE = 'northern-english'
GROUP_SIZE = 8


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


class Narrator(object):
    def __init__(self, cache_dir):
        self.cache_dir = cache_dir
        self.lock = threading.Lock()
        self.model = None
        self.sr = None
        os.makedirs(cache_dir, exist_ok=True)

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
            self.model = Qwen3TTSModel.from_pretrained(local, device_map='cuda:0',
                                                       dtype=torch.bfloat16)
            import numpy as np
            self.prints = {}
            for name, v in VOICES.items():
                raw = np.load(v['print']).astype(np.float32)
                self.prints[name] = (torch.from_numpy(raw), hashlib.sha256(raw.tobytes()).hexdigest())
            self._decode_clips_separately()
            self._stop_when_cancelled()
            log('model ready in %.1fs (%s)' % (time.time() - t, MODEL_REPO))
        except Exception:
            import traceback
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

    def key_for(self, text, voice):
        """One piece's cache key: the model, the voice, the style and the text."""
        h = hashlib.sha256()
        h.update(MODEL_REPO.encode('utf-8'))
        h.update(b'\x00')
        h.update(self.prints[voice][1].encode('utf-8'))
        h.update(b'\x00')
        h.update(VOICES[voice]['style'].encode('utf-8'))
        h.update(b'\x00')
        h.update(text.encode('utf-8'))
        return h.hexdigest()[:20]

    def generate(self, texts, voice):
        """One batched generation with the voice-print pinned and the style instruction.

        qwen-tts has no public call for this pairing -- generate_custom_voice takes only its
        nine named speakers, generate_voice_clone takes a voice-print but no instruction --
        so this is generate_custom_voice with the voice-print passed the way
        generate_voice_clone passes one (x-vector only, no reference audio).
        """
        m = self.model
        n = len(texts)
        vprint = self.prints[voice][0]
        prompt = dict(ref_code=[None] * n, ref_spk_embedding=[vprint] * n,
                      x_vector_only_mode=[True] * n, icl_mode=[False] * n)
        input_ids = m._tokenize_texts([m._build_assistant_text(t) for t in texts])
        style = m._tokenize_texts([m._build_instruct_text(VOICES[voice]['style'])])[0]
        codes, _ = m.model.generate(input_ids=input_ids, instruct_ids=[style] * n,
                                    voice_clone_prompt=prompt, languages=['English'] * n,
                                    non_streaming_mode=True, **m._merge_generate_kwargs())
        return m.model.speech_tokenizer.decode([{'audio_codes': c} for c in codes])

    def cached(self, key):
        """Seconds of audio for a piece already on disk, or None."""
        path = os.path.join(self.cache_dir, key + '.wav')
        if not os.path.exists(path):
            return None
        try:
            import soundfile as sf
            return sf.info(path).duration
        except Exception as e:
            log('cached piece %s unreadable (%s), rendering again' % (key, e))
            return None

    def render_group(self, blocks, voice, seed, reading=None):
        """Audio for each block, from the cache where it exists; the rest in one batched call.

        Returns ([{id, file, seconds}] in the order given, how many came from the cache).
        Raises Cancelled if the reading is cancelled while its batch is being generated;
        nothing from that batch is kept.
        """
        import numpy as np
        import soundfile as sf

        keys = [self.key_for(b['text'], voice) for b in blocks]
        have = [self.cached(k) for k in keys]
        todo = [i for i, s in enumerate(have) if s is None]
        if todo:
            waited = time.time()
            with self.lock:
                # Asked for twice at once -- Narrate pressed on text being rendered ahead --
                # the second request waits here, then takes whatever the first one made
                # rather than rendering it again.
                for i in todo:
                    have[i] = self.cached(keys[i])
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
                        wavs, sr = self.generate([blocks[i]['text'] for i in todo], voice)
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
                        path = os.path.join(self.cache_dir, keys[i] + '.wav')
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
        items = [{'id': b['id'], 'file': k + '.wav', 'seconds': round(s, 3)}
                 for b, k, s in zip(blocks, keys, have)]
        return items, cached


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
        if self.path.startswith('/health'):
            self._send(200, {'ready': Handler.narrator.model is not None,
                             'model': MODEL_REPO,
                             'voices': sorted(VOICES),
                             'cache': Handler.narrator.cache_dir})
        else:
            self._send(404, {'error': 'no such path'})

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

        if not self.path.startswith('/render'):
            self._send(404, {'error': 'no such path'})
            return

        blocks = body.get('blocks') or []
        voice = body.get('voice') or DEFAULT_VOICE
        seed = int(body.get('seed', 1234))
        size = int(body.get('group_size', GROUP_SIZE))
        if voice not in VOICES:
            self._send(400, {'error': 'unknown voice %r' % voice, 'voices': sorted(VOICES)})
            return
        blocks = [b for b in blocks if (b.get('text') or '').strip()]
        if not blocks:
            self._send(400, {'error': 'no blocks with text'})
            return

        reading = int(body.get('reading', 0))
        started = time.time()
        log('render request: reading %d, %d pieces [%s]' % (
            reading, len(blocks),
            ' '.join('%s:%dch' % (b.get('id'), len(b.get('text') or '')) for b in blocks)))
        if is_cancelled(reading):
            log('reading %d already cancelled, nothing rendered' % reading)
            self._send(200, {'items': [], 'cancelled': True})
            return
        if Handler.narrator.model is None:
            log('render request before the model is ready')

        items, from_cache = [], 0
        try:
            for at in range(0, len(blocks), size):
                if is_cancelled(reading):
                    log('reading %d cancelled mid-request, %d blocks dropped'
                        % (reading, len(blocks) - at))
                    self._send(200, {'items': items, 'cancelled': True})
                    return
                got, cached = Handler.narrator.render_group(blocks[at:at + size], voice, seed, reading)
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

    narrator = Narrator(args.cache)
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
