"""TypoZen's narration service: one resident process, HTTP on the loopback.

Resident because there is no streaming mode in qwen-tts and loading the weights costs 8.3
seconds; paying that once per session is the difference between three seconds to first
sound and eleven.

Renders in groups rather than one utterance at a time, for two measured reasons:

  * a batch of eight paragraphs runs at 0.34x realtime against 2.2x one at a time, so
    grouping is what makes narration outrun listening at all; and
  * batch composition is part of the input -- the same sentence rendered with different
    neighbours is a different take -- so a group has to be a fixed, repeatable set if the
    cache is ever to match a re-render.

A group is therefore N consecutive blocks of the document, and its cache key is the hash of
everything that went into it: the model, the voice, the seed, and every block's text in
order. Change any of that and the key changes; change nothing and the audio on disk is
exactly what would be produced again.

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

MODEL_REPO = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'

# The voices Ed chose, by ear, on 2026-09-22. With VoiceDesign the wording is the voice, so
# editing these strings changes what the narrator sounds like -- and changes every cache key
# that used them, which is intended: the audio on disk no longer matches the request.
NARRATION_CRAFT = (
    " Narrate as an accomplished audiobook reader of literary fiction: measured and "
    "unhurried, phrasing that follows the sense of the sentence, understated rather than "
    "performed. Give the spoken lines a light, distinct colour without acting them out."
)
VOICES = {
    'northern-english': ("A British woman with a soft northern English accent, gentle and "
                         "grounded, with a low steady delivery." + NARRATION_CRAFT),
    'northern-clear': ("A British woman with a light northern English accent, clear and "
                       "unhurried, with a smooth low register and very even pacing. "
                       "Understated and composed." + NARRATION_CRAFT),
}
DEFAULT_VOICE = 'northern-english'
GROUP_SIZE = 8


def log(m):
    print('%s  %s' % (time.strftime('%H:%M:%S'), m), flush=True)


class Narrator(object):
    def __init__(self, cache_dir):
        self.cache_dir = cache_dir
        self.lock = threading.Lock()
        self.model = None
        self.sr = None
        os.makedirs(cache_dir, exist_ok=True)

    def load(self):
        import torch
        from qwen_tts import Qwen3TTSModel
        t = time.time()
        from huggingface_hub import snapshot_download
        self.torch = torch
        # From the local folder, not the repository name. Given a name, the tokenizer loader
        # asks the Hugging Face API about the model even when every file is on disk -- which
        # fails offline, and online cost most of a 51-second start. Given a path it asks
        # nothing: 16 seconds, and no network.
        local = snapshot_download(MODEL_REPO, local_files_only=True)
        self.model = Qwen3TTSModel.from_pretrained(local, device_map='cuda:0',
                                                   dtype=torch.bfloat16)
        log('model ready in %.1fs' % (time.time() - t))

    def key_for(self, texts, voice, seed):
        """Everything that decides the audio, and nothing that does not."""
        h = hashlib.sha256()
        h.update(MODEL_REPO.encode('utf-8'))
        h.update(b'\x00')
        h.update(VOICES[voice].encode('utf-8'))
        h.update(b'\x00')
        h.update(str(seed).encode('utf-8'))
        for t in texts:
            h.update(b'\x00')
            h.update(t.encode('utf-8'))
        return h.hexdigest()[:16]

    def render_group(self, blocks, voice, seed):
        """One batched call. Returns [{id, file, seconds}] and whether it was cached."""
        import numpy as np
        import soundfile as sf

        texts = [b['text'] for b in blocks]
        key = self.key_for(texts, voice, seed)
        manifest_path = os.path.join(self.cache_dir, key + '.json')
        if os.path.exists(manifest_path):
            try:
                with open(manifest_path, encoding='utf-8') as f:
                    items = json.load(f)
                if all(os.path.exists(os.path.join(self.cache_dir, i['file'])) for i in items):
                    return items, True
            except Exception as e:
                log('cache entry %s unreadable (%s), re-rendering' % (key, e))

        with self.lock:
            self.torch.manual_seed(seed)
            self.torch.cuda.manual_seed_all(seed)
            t = time.time()
            wavs, sr = self.model.generate_voice_design(
                text=texts, instruct=VOICES[voice], language='English')
            took = time.time() - t

        items, total = [], 0.0
        for block, wav in zip(blocks, wavs):
            a = np.asarray(wav, dtype=np.float32)
            name = '%s-%d.wav' % (key, block['id'])
            sf.write(os.path.join(self.cache_dir, name), a, sr)
            secs = len(a) / float(sr)
            total += secs
            items.append({'id': block['id'], 'file': name, 'seconds': round(secs, 3)})

        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(items, f)
        log('rendered %d blocks: %.1fs of audio in %.1fs (%.2fx realtime)'
            % (len(blocks), total, took, took / total if total else 0))
        return items, False


# Cancellation. A render request carries the id of the reading it belongs to; stopping the
# reading cancels that id, and any group not yet started is dropped. A group already inside
# generate() runs to the end -- there is no safe way to interrupt a CUDA call mid-flight --
# so the worst case is one group of wasted work rather than a queue of them.
#
# This exists because the first build had none: Stop stopped the playback, the page kept
# asking for more, and the card stayed at 99% rendering audio nobody was going to hear.
_cancelled = set()
_cancel_lock = threading.Lock()


def cancel(reading_id):
    with _cancel_lock:
        _cancelled.add(reading_id)
        if len(_cancelled) > 64:                # ids only ever grow; keep the newest
            for old in sorted(_cancelled)[:-32]:
                _cancelled.discard(old)


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

        touch()
        if self.path.startswith('/cancel'):
            rid = int(body.get('reading', 0))
            cancel(rid)
            log('reading %d cancelled' % rid)
            self._send(200, {'cancelled': rid})
            return

        if self.path.startswith('/stop'):
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
        if is_cancelled(reading):
            self._send(200, {'items': [], 'cancelled': True})
            return

        items, cached_groups, rendered_groups = [], 0, 0
        try:
            for at in range(0, len(blocks), size):
                if is_cancelled(reading):
                    log('reading %d cancelled mid-request, %d blocks dropped'
                        % (reading, len(blocks) - at))
                    self._send(200, {'items': items, 'cancelled': True})
                    return
                group = blocks[at:at + size]
                got, was_cached = Handler.narrator.render_group(group, voice, seed)
                items.extend(got)
                if was_cached:
                    cached_groups += 1
                else:
                    rendered_groups += 1
        except Exception as e:
            log('render failed: %s: %s' % (type(e).__name__, e))
            self._send(500, {'error': '%s: %s' % (type(e).__name__, e)})
            return

        self._send(200, {'items': items, 'voice': voice, 'seed': seed,
                         'groups_from_cache': cached_groups,
                         'groups_rendered': rendered_groups})


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

    narrator = Narrator(args.cache)
    Handler.narrator = narrator

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
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
