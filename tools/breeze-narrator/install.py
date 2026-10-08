"""Sets up Breeze narration for TypoZen: the Python packages, Breeze's code, the model.

TypoZen creates the extension's Python environment and runs this with it:

  venv\\Scripts\\python.exe install.py --root <extensions\\BreezeTTS>

It reports on stdout as the Qwen install does (tools/qwen-narrator/install.py):

  STEP <what>  PROGRESS <done> <total> <what>  NOTE <text>  ERROR <text>  DONE

Safe to stop and run again: pip skips what is installed, the model download resumes, and a
step already finished is checked rather than repeated.

Pinned to what Breeze was measured on (2026-10-08): the Qwen narrator's package lock -- Breeze
ran unmodified on exactly those versions -- plus triton-windows for the fast path; Breeze's code
at one commit, each file checked; the model at one revision.
"""
import argparse
import hashlib
import io
import os
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True

# The Qwen narrator's lock: the versions Breeze ran on. One list, so the two cannot drift apart.
sys.path.insert(0, os.path.join(HERE, '..', 'qwen-narrator'))
from install import PACKAGES as QWEN_PACKAGES, TORCH_INDEX  # noqa: E402
sys.path.pop(0)
PACKAGES = QWEN_PACKAGES + ['triton-windows==3.8.0.post28']
PACKAGES_BYTES = 4900000000

CODE_COMMIT = '58ec70ce5fa4cc361bdebf77ec40d1365da00ab2'
CODE_URL = 'https://codeload.github.com/breezeblue-ai/breeze-tts/tar.gz/' + CODE_COMMIT
# Only what the narrator runs, each file by its checksum: GitHub does not promise that the
# archive it builds stays byte for byte the same, but the files in it do.
CODE_FILES = [
    ('LICENSE', 'c8858a5a76440bbca484e134cf7df46385d090dd18b2c58e650f939258802e5b'),
    ('breeze_infer/__init__.py', '810141b5e6326542cced736e82763c37300f9de2b531f3ab97921a1aca32328d'),
    ('breeze_infer/api.py', 'dc636afd62db13fb0f4394f3013acfdf8f3226f59ceb1efe4ef7f2682c1c2170'),
    ('breeze_infer/audio.py', '3dc7977d8b1f3097918d4164e5607c20d99491877f3c4723649a36724713cff4'),
    ('breeze_infer/runtime.py', 'a257d868b867009edddd8ba53b22d3b66394057801c62f198879b1c992637ab9'),
    ('breeze_infer/templates.py', '52057796b74b95e34adf7238cb07ed1484941a5f6c168760632ac54a0bd0ca06'),
    ('configs/fast.json', '879c719966e3cd560e47f7555faacd0073f42b36df5c60a5569d3b8558715900'),
    ('models/__init__.py', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
    ('models/breeze.py', '9c408b2323f1fb57f7ddc4217cc72e4d9fce82cbf287a0d2ae4578e63f204cc2'),
    ('models/breeze_backbone_factory.py', '8d8519dccb82f5363d4e4ff64f182906a0f93dd5853619547b54c89ff22f17ef'),
    ('models/breeze_base_config.py', '6b8aab8979fef27108176d654077e7f1d797a0ca2ed18e6e1460fdf8ab93b7a9'),
    ('models/breeze_config.py', 'f37fc58792ea936d24925254dfbd75eafb47c2ca85db46b0c371b94550a3fb25'),
    ('models/cudagraph/__init__.py', 'ef0418048e1766dfd2efab2f000bcc15f3d75ccfc700e1e5f52d7c540f56bf62'),
    ('models/cudagraph/backbone_graph.py', '942b07eb2c16a31f362e10ecc23e9d1c131fc8cc3116550650010d2ec83fd024'),
    ('models/cudagraph/backbone_prefill_graph.py', 'bd90e34eb8bc4e507af9e222b58db741e913e5c833cd9c5625f4168660d45d82'),
    ('models/cudagraph/depth_decoder_graph.py', '407bb07d0cd610f9c11748655450ad7708f8bab811d2129382925bf729b88acc'),
    ('models/cudagraph/sampling.py', '3dcaa35fd106c730bc630a998d3a6ed3329beb55e8df03d76d3f857346a86623'),
    ('models/fast_streaming.py', '7748cc11fef2a5f54ae82fefc96325673d71b8cb9b1bdd7bb92275c4c100a825'),
    ('models/generation_breeze.py', 'ebc55c27b896423f7a3464cb6dcf1df0918c78bda6b0236235f0f0f4c4d04e84'),
    ('models/logits_process.py', '43bbcc1c85da535aefc757e44716b0e69701c90db660cf14d77da73d31485b9f'),
    ('models/stream_runtime/__init__.py', 'f5f6ff5a5013666069d61bc7d6275fdb4b3feac9d569a1afec3cfacd59dec799'),
    ('models/stream_runtime/core/__init__.py', 'c3daf48ca2c409d255ba51bbbeb9f56a66a68e4934b33a77f0714541f0566670'),
    ('models/stream_runtime/core/compat.py', '27354ec2e98991579b421f1d24af93786da066532a61ad66462ffcff6a978d97'),
    ('models/stream_runtime/inference/__init__.py', '01f6c318a7ac1be7df8f78a42d59bac4214126adbd900c649e5ec3a5367e62a3'),
    ('models/stream_runtime/stream/__init__.py', 'c5cad715006f19bb5c097c2556a301252845b31facd4e402b90db2d727886187'),
    ('models/stream_runtime/stream/kv_cache.py', '1162ba9bce3fbb2e64b6fcb2e95e20b9f6efb9dfce541be61ab8346f123c8f41'),
    ('models/stream_runtime/stream/lane.py', '074a88bd1c6ea367993f66b352df48be372a8236c66dbb7a7e151f50bd620486'),
    ('models/stream_runtime/stream/runtime.py', '6b886844b7e317a4218a9f6f68735e502d8fd853ce41dd8c90648bf1de88c320'),
    ('models/stream_runtime/stream/state.py', '05631403bae6b29538b1bba7710854d1fada84033f656e7302e43cf8c7f5eba7'),
    ('models/stream_runtime/stream/workspace.py', '1607e23cf928febd76efe57f075430a97f8311e1901c1ebe33dde144f3e1c584'),
    ('models/t5gemma2_compat.py', '5902c67fdd3ca28bb13508cb139d0ea96594f118763bc5cd4d940e78d1cf92bf'),
    ('models/text_encoder_graph.py', 'a8cb9c92b9b13124652e93c0f9a95fe8d70775fec105f3616435b08970cbbddb'),
    ('models/warmup_profile.py', '48faa9be17f740a808946eae5f2724e370b68b3e177e7871563f4ee45a0e85c6'),
]

MODEL_REPO = 'BreezeBlue/Breeze-TTS-2'
MODEL_REV = '3e28c5151381a722f1d8661b4118c298caa77aa4'
MODEL_PATTERNS = ['*.json', '*.safetensors', 'audio_tokenizer/*', 'LICENSE']


def out(kind, text=''):
    print(('%s %s' % (kind, text)).rstrip(), flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def folder_bytes(folder):
    done = 0
    for d, _, files in os.walk(folder):
        for f in files:
            try:
                done += os.lstat(os.path.join(d, f)).st_size
            except OSError:
                pass
    return done


def watching(folder, total, what):
    """PROGRESS once a second from the bytes on disk under folder, until the returned stop()."""
    stop = threading.Event()

    def watch():
        while not stop.wait(1.0):
            out('PROGRESS', '%d %d %s' % (min(folder_bytes(folder), total), total, what))

    t = threading.Thread(target=watch, daemon=True)
    t.start()
    return lambda: (stop.set(), t.join())


# ---- 1. packages ---------------------------------------------------------------------------

def packages():
    out('STEP', 'Installing the Python packages (about 4.9 GB)')
    venv_dir = os.path.dirname(os.path.dirname(sys.executable))
    done = watching(venv_dir, PACKAGES_BYTES, 'Python packages')
    try:
        cmd = [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
               '--progress-bar', 'off', '--extra-index-url', TORCH_INDEX] + PACKAGES
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             encoding='utf-8', errors='replace', bufsize=1)
        last = ''
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            last = line
            if line.startswith(('Collecting', 'Downloading', 'Installing', 'Successfully', 'Requirement already')):
                out('NOTE', line[:160])
        if p.wait() != 0:
            raise RuntimeError('pip could not install the packages: ' + last[:200])
    finally:
        done()


# ---- 2. Breeze's code ----------------------------------------------------------------------

def code(root):
    dest = os.path.join(root, 'breeze-tts')
    if all(os.path.isfile(os.path.join(dest, p)) and sha256(os.path.join(dest, p)) == h for p, h in CODE_FILES):
        out('NOTE', "Breeze's code is already in place.")
        return
    out('STEP', "Downloading Breeze's code (%s)" % CODE_COMMIT[:8])
    req = urllib.request.Request(CODE_URL, headers={'User-Agent': 'TypoZen'})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    want = dict(CODE_FILES)
    got = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        for m in tar.getmembers():
            if not m.isfile():
                continue
            rel = m.name.split('/', 1)[1] if '/' in m.name else m.name
            if rel in want:
                got[rel] = tar.extractfile(m).read()
    missing = [p for p in want if p not in got]
    bad = [p for p, b in got.items() if hashlib.sha256(b).hexdigest() != want[p]]
    if missing or bad:
        raise RuntimeError("Breeze's code at %s is not what TypoZen was tested with (%s)."
                           % (CODE_COMMIT[:8], ', '.join((missing + bad)[:4])))
    part = dest + '.part'
    shutil.rmtree(part, ignore_errors=True)
    for rel, b in got.items():
        p = os.path.join(part, *rel.split('/'))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(b)
    shutil.rmtree(dest, ignore_errors=True)
    os.replace(part, dest)
    out('NOTE', '%d files, every checksum matched' % len(got))


# ---- 3. the model --------------------------------------------------------------------------

def model(root):
    from huggingface_hub import HfApi, snapshot_download
    dest = os.path.join(root, 'model')
    info = HfApi().model_info(MODEL_REPO, revision=MODEL_REV, files_metadata=True)
    import fnmatch
    wanted = [s for s in info.siblings if any(fnmatch.fnmatch(s.rfilename, p) for p in MODEL_PATTERNS)]
    total = sum((s.size or 0) for s in wanted)
    out('STEP', 'Downloading the Breeze TTS 2 model (%.1f GB)' % (total / 1e9))
    done = watching(dest, total, 'Breeze TTS 2')
    try:
        # Into a plain folder: no symbolic links for Windows to refuse (see the Qwen sidecar's
        # harden_snapshot), and nothing in a shared Hugging Face cache that Remove cannot reach.
        snapshot_download(MODEL_REPO, revision=MODEL_REV, local_dir=dest, allow_patterns=MODEL_PATTERNS)
    finally:
        done()
    # Every large file checked against the checksum Hugging Face publishes for it.
    for s in wanted:
        lfs = getattr(s, 'lfs', None)
        sha = getattr(lfs, 'sha256', None) if lfs is not None else None
        p = os.path.join(dest, *s.rfilename.split('/'))
        if not os.path.isfile(p) or os.path.getsize(p) != s.size:
            raise RuntimeError('The model file %s did not download completely.' % s.rfilename)
        if sha and sha256(p) != sha:
            os.remove(p)
            raise RuntimeError('The model file %s did not match its checksum and was deleted; Install again.' % s.rfilename)
    shutil.rmtree(os.path.join(dest, '.cache'), ignore_errors=True)
    out('PROGRESS', '%d %d %s' % (total, total, 'Breeze TTS 2'))


# ---- 4. check ------------------------------------------------------------------------------

def check():
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('PyTorch cannot see an NVIDIA graphics card with CUDA, which the narrator needs.')
    total = torch.cuda.get_device_properties(0).total_memory
    out('NOTE', 'Graphics card: %s, %.1f GB' % (torch.cuda.get_device_name(0), total / 2 ** 30))
    try:
        import triton  # noqa: F401
    except Exception as e:
        out('NOTE', 'Triton did not load (%s): Breeze will read in its slower mode.' % e)


# ---- 5. prepare the graphics card ----------------------------------------------------------

def prepare(root):
    """The narrator's first start compiles its fast path for this graphics card: about two
    minutes, once. Done here, while the reader is already waiting for the install, rather than
    the first time they press Read Aloud (Ed, 2026-10-08). It is the narrator's own load, with
    its own settings and compile folder, so what it compiles is exactly what it will look for."""
    out('STEP', 'Preparing the graphics card (about two minutes, once)')
    for k, v in (('TORCHINDUCTOR_CACHE_DIR', os.path.join(root, 'compiled', 'inductor')),
                 ('TRITON_CACHE_DIR', os.path.join(root, 'compiled', 'triton')),
                 ('HF_HUB_OFFLINE', '1'), ('TRANSFORMERS_OFFLINE', '1')):
        os.environ[k] = v
    sys.path.insert(0, HERE)
    import sidecar
    sidecar.log = lambda m, who='install': out('NOTE', m.splitlines()[0][:160])
    n = sidecar.Narrator(os.path.join(root, 'narration'), models=os.path.join(root, 'model'),
                         code=os.path.join(root, 'breeze-tts'))
    t = time.time()
    n.load()
    if not n.ready:
        raise RuntimeError('The narrator could not load: ' + (n.load_error or 'no reason given'))
    if n.mode != 'fast':
        out('NOTE', 'The fast mode could not be prepared: Breeze will read about three times slower than speech.')
    out('NOTE', 'Ready in %.0fs; later starts take about 40 seconds.' % (time.time() - t))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True, help='the extension folder (extensions\\BreezeTTS)')
    ap.add_argument('--skip-packages', action='store_true', help='for tests: the packages are already there')
    ap.add_argument('--only-prepare', action='store_true', help='for tests: only step 5')
    args = ap.parse_args()
    # The compile folders before anything imports torch (check() does): PyTorch may read them once.
    os.environ['TORCHINDUCTOR_CACHE_DIR'] = os.path.join(args.root, 'compiled', 'inductor')
    os.environ['TRITON_CACHE_DIR'] = os.path.join(args.root, 'compiled', 'triton')
    if args.only_prepare:
        try:
            prepare(args.root)
        except Exception as e:
            out('ERROR', str(e).replace('\n', ' ')[:400])
            sys.exit(1)
        out('DONE')
        return
    os.makedirs(args.root, exist_ok=True)
    os.environ['HF_HOME'] = os.path.join(args.root, 'hf')
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
    t = time.time()
    try:
        if not args.skip_packages:
            packages()
        code(args.root)
        model(args.root)
        check()
        prepare(args.root)
    except Exception as e:
        out('ERROR', str(e).replace('\n', ' ')[:400])
        sys.exit(1)
    out('DONE', 'in %.0fs' % (time.time() - t))


if __name__ == '__main__':
    main()
