"""Sets up Qwen narration for TypoZen: the Python packages, the two models, the speaker encoder.

TypoZen creates the extension's Python environment and runs this with it:

  venv\\Scripts\\python.exe install.py --root <extensions\\QwenTTS>

It reports on stdout, one line at a time, for TypoZen to show:

  STEP <what>                          a new stage
  PROGRESS <done> <total> <what>       bytes of a download
  NOTE <text>                          anything worth a status line
  ERROR <text>                         why it stopped (then a non-zero exit)
  DONE

Safe to stop and run again: pip skips what is installed, model downloads resume, and a step
already finished is checked rather than repeated.

Everything is pinned to what the narrator was built and measured on (2026-09-24), so an
install reproduces that setup instead of whatever is newest.
"""
import argparse
import json
import os
import struct
import subprocess
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True          # nothing written beside the app (see sidecar.py)

TORCH_INDEX = 'https://download.pytorch.org/whl/cu126'
PACKAGES = [
    'accelerate==1.12.0', 'annotated-doc==0.0.5', 'annotated-types==0.8.0', 'anyio==4.15.1',
    'audioread==3.1.0', 'brotli==1.2.0', 'certifi==2026.7.22', 'cffi==2.1.1',
    'charset-normalizer==3.5.1', 'click==8.5.0', 'cloudpickle==3.1.2', 'colorama==0.4.6',
    'decorator==5.3.1', 'einops==0.8.2', 'fastapi==0.141.1', 'filelock==3.32.3',
    'flatbuffers==25.12.19', 'fsspec==2026.7.0', 'gradio==6.17.3', 'gradio_client==2.5.0',
    'groovy==0.1.2', 'h11==0.16.0', 'hf-gradio==0.4.1', 'hf-xet==1.6.0', 'httpcore==1.0.9',
    'httpx==0.28.1', 'huggingface_hub==0.36.2', 'idna==3.20', 'Jinja2==3.1.6', 'joblib==1.6.0',
    'lazy-loader==0.6', 'librosa==0.11.0', 'llvmlite==0.49.0', 'markdown-it-py==4.2.0',
    'MarkupSafe==3.0.3', 'mdurl==0.1.2', 'mpmath==1.3.0', 'msgpack==1.2.2', 'narwhals==2.26.0',
    'networkx==3.6.1', 'numba==0.67.0', 'numpy==2.4.6', 'onnxruntime==1.30.0', 'orjson==3.12.0',
    'packaging==26.3', 'pandas==3.0.6', 'pillow==12.3.0', 'platformdirs==4.11.12', 'pooch==1.9.0',
    'protobuf==7.36.2', 'psutil==7.2.2', 'pycparser==3.0', 'pydantic==2.13.5',
    'pydantic_core==2.46.5', 'pydub==0.25.1', 'Pygments==2.21.0', 'python-dateutil==2.9.0.post0',
    'python-multipart==0.0.32', 'pytz==2026.3.post1', 'PyYAML==6.0.3', 'qwen-tts==0.1.1',
    'regex==2026.9.10', 'requests==2.34.2', 'rich==15.0.0', 'safehttpx==0.1.7',
    'safetensors==0.8.0', 'scikit-learn==1.9.1', 'scipy==1.17.1', 'semantic-version==2.10.0',
    'shellingham==1.5.4', 'six==1.17.0', 'soundfile==0.14.0', 'sox==1.5.0', 'soxr==1.1.0',
    'starlette==1.6.0', 'sympy==1.14.0', 'threadpoolctl==3.7.0', 'tokenizers==0.22.2',
    'tomlkit==0.14.0', 'torch==2.14.0+cu126', 'torchaudio==2.11.0+cu126', 'tqdm==4.70.1',
    'transformers==4.57.3', 'typer==0.27.2', 'typing-inspection==0.4.4',
    'typing_extensions==4.16.0', 'tzdata==2026.4', 'urllib3==2.8.0', 'uvicorn==0.53.0',
]
MODELS = [
    ('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', '0c0e3051f131929182e2c023b9537f8b1c68adfe'),
    ('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', '5ecdb67327fd37bb2e042aab12ff7391903235d3'),
]
# Only Base has a speaker encoder, and it is about 24 MB of a 3.8 GB file. It is read out of
# that file with ranged requests rather than downloading the whole model.
BASE = ('Qwen/Qwen3-TTS-12Hz-1.7B-Base', 'fd4b254389122332181a7c3db7f27e918eec64e3')
ENCODER_PREFIX = 'speaker_encoder.'


def out(kind, text=''):
    print(('%s %s' % (kind, text)).rstrip(), flush=True)


# ---- 1. packages ---------------------------------------------------------------------------

def packages():
    out('STEP', 'Installing the Python packages (about 4.8 GB)')
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
        # The lines worth showing: what it is fetching and what it is installing.
        if line.startswith(('Collecting', 'Downloading', 'Installing', 'Successfully', 'Requirement already')):
            out('NOTE', line[:160])
    if p.wait() != 0:
        raise RuntimeError('pip could not install the packages: ' + last[:200])


# ---- 2. models -----------------------------------------------------------------------------

def models(models_dir):
    from huggingface_hub import HfApi, snapshot_download
    api = HfApi()
    for repo, rev in MODELS:
        name = repo.split('/')[-1]
        out('STEP', 'Downloading the %s model' % name)
        info = api.model_info(repo, revision=rev, files_metadata=True)
        total = sum((s.size or 0) for s in info.siblings)
        repo_dir = os.path.join(models_dir, 'models--' + repo.replace('/', '--'))
        stop = threading.Event()

        def watch():
            # Bytes on disk under this model's folder, finished or not: resumes count.
            while not stop.wait(1.0):
                done = 0
                for d, _, files in os.walk(repo_dir):
                    for f in files:
                        try:
                            done += os.lstat(os.path.join(d, f)).st_size
                        except OSError:
                            pass
                out('PROGRESS', '%d %d %s' % (min(done, total), total, name))

        t = threading.Thread(target=watch, daemon=True)
        t.start()
        try:
            snapshot_download(repo, revision=rev, cache_dir=models_dir)
        finally:
            stop.set()
            t.join()
        # The narrator asks for the model by the name "main", and a download by commit, as
        # here, records no names. Record that "main" is this revision, as a download of main
        # would have: without it the narrator cannot find the model it was just given.
        refs = os.path.join(repo_dir, 'refs')
        os.makedirs(refs, exist_ok=True)
        with open(os.path.join(refs, 'main'), 'w', encoding='ascii') as f:
            f.write(rev)
        out('PROGRESS', '%d %d %s' % (total, total, name))


# ---- 3. speaker encoder --------------------------------------------------------------------

def _get(url, start=None, end=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'TypoZen'})
    if start is not None:
        req.add_header('Range', 'bytes=%d-%d' % (start, end))
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def encoder(models_dir):
    import torch
    from qwen_tts.core.models.configuration_qwen3_tts import Qwen3TTSSpeakerEncoderConfig
    from qwen_tts.core.models.modeling_qwen3_tts import Qwen3TTSSpeakerEncoder
    import inspect

    path = os.path.join(models_dir, 'speaker-encoder.pt')
    accepted = set(inspect.signature(Qwen3TTSSpeakerEncoderConfig.__init__).parameters)

    def loads(saved):
        cfg = Qwen3TTSSpeakerEncoderConfig(**{k: v for k, v in saved['config'].items() if k in accepted})
        Qwen3TTSSpeakerEncoder(cfg).load_state_dict(saved['state'])       # strict: every weight, no more

    if os.path.isfile(path):
        try:
            loads(torch.load(path, map_location='cpu'))
            out('NOTE', 'The speaker encoder is already in place.')
            return
        except Exception as e:
            out('NOTE', 'The speaker encoder on disk did not load (%s); fetching it again.' % e)

    out('STEP', 'Fetching the speaker encoder (about 24 MB of the Base model)')
    repo, rev = BASE
    base = 'https://huggingface.co/%s/resolve/%s/' % (repo, rev)
    config = json.loads(_get(base + 'config.json').decode('utf-8'))['speaker_encoder_config']
    url = base + 'model.safetensors'
    n = struct.unpack('<Q', _get(url, 0, 7))[0]
    header = json.loads(_get(url, 8, 8 + n - 1).decode('utf-8'))
    names = [k for k in header if k.startswith(ENCODER_PREFIX)]
    if not names:
        raise RuntimeError('The Base model has no speaker encoder weights at this revision.')
    lo = min(header[k]['data_offsets'][0] for k in names)
    hi = max(header[k]['data_offsets'][1] for k in names)
    if hi - lo > 200 * 1024 * 1024:
        raise RuntimeError('The speaker encoder weights are not stored together (%d MB span).' % ((hi - lo) >> 20))
    data = _get(url, 8 + n + lo, 8 + n + hi - 1)
    if len(data) != hi - lo:
        raise RuntimeError('The speaker encoder download was cut short.')
    dtypes = {'BF16': torch.bfloat16, 'F16': torch.float16, 'F32': torch.float32, 'I64': torch.int64,
              'I32': torch.int32, 'BOOL': torch.bool}
    state = {}
    for k in names:
        h = header[k]
        a, b = h['data_offsets']
        t = torch.frombuffer(bytearray(data[a - lo:b - lo]), dtype=dtypes[h['dtype']])
        state[k[len(ENCODER_PREFIX):]] = t.reshape(h['shape']).clone()
    saved = {'config': config, 'state': state}
    loads(saved)
    tmp = path + '.part'
    torch.save(saved, tmp)
    os.replace(tmp, path)
    out('NOTE', 'Speaker encoder saved: %d weights, %.1f MB.' % (len(state), (hi - lo) / 1048576.0))


# ---- 4. tidy: hard links -------------------------------------------------------------------

def tidy(models_dir):
    out('STEP', 'Finishing')
    sys.path.insert(0, HERE)
    import sidecar
    sidecar.log = lambda m, who='install': out('NOTE', m)
    for repo, rev in MODELS:
        sidecar.harden_snapshot(os.path.join(models_dir, 'models--' + repo.replace('/', '--'), 'snapshots', rev))
    # The two models share files byte for byte (the speech tokenizer is 0.64 GB). Hugging Face
    # names blobs by content, so a blob with the same name in both is the same file: keep one.
    a, b = [os.path.join(models_dir, 'models--' + r.replace('/', '--'), 'blobs') for r, _ in MODELS]
    shared = 0
    for name in (set(os.listdir(a)) & set(os.listdir(b))) if os.path.isdir(a) and os.path.isdir(b) else ():
        pa, pb = os.path.join(a, name), os.path.join(b, name)
        try:
            sa, sb = os.stat(pa), os.stat(pb)
            if sa.st_ino == sb.st_ino or sa.st_size != sb.st_size:
                continue
            tmp = pb + '.hardlink'
            if os.path.lexists(tmp):
                os.remove(tmp)
            os.link(pa, tmp)
            os.replace(tmp, pb)
            shared += sa.st_size
        except OSError as e:
            out('NOTE', 'could not share %s: %s' % (name, e))
    if shared:
        out('NOTE', '%.2f GB stored once instead of twice' % (shared / 1073741824.0))


# ---- 5. check ------------------------------------------------------------------------------

def check():
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('PyTorch cannot see an NVIDIA graphics card with CUDA, which the narrator needs.')
    out('NOTE', 'Graphics card: %s' % torch.cuda.get_device_name(0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True, help='the extension folder (extensions\\QwenTTS)')
    ap.add_argument('--skip-packages', action='store_true', help='for tests: the packages are already there')
    args = ap.parse_args()
    models_dir = os.path.join(args.root, 'models')
    os.makedirs(models_dir, exist_ok=True)
    # The same places the narrator uses, and nothing sent back to Hugging Face.
    os.environ['HF_HUB_CACHE'] = models_dir
    os.environ['HF_HOME'] = args.root
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
    t = time.time()
    try:
        if not args.skip_packages:
            packages()
        models(models_dir)
        encoder(models_dir)
        tidy(models_dir)
        check()
    except Exception as e:
        out('ERROR', str(e).replace('\n', ' ')[:400])
        sys.exit(1)
    out('DONE', 'in %.0fs' % (time.time() - t))


if __name__ == '__main__':
    main()
