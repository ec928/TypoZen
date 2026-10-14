"""
The narrators answer only TypoZen's own page, not any web site open in a browser.

Each sidecar is an HTTP server on 127.0.0.1. Loopback does not keep web pages out: any site
in a browser on this PC can send requests there. Until 0.16.37 both answered every origin
("Access-Control-Allow-Origin: *") and read any body as JSON, so a site could read the voice
list and cache paths, and a plain-text POST -- which a browser sends without asking -- could
delete a designed or cloned voice. Now a request naming an origin other than
https://localapp is refused before anything runs; the host's own requests name none.

This loads only each sidecar's request handler, with a stand-in narrator (no model, no GPU),
and talks to it over real HTTP.

    python tests/sidecar-origin-selftest.py
"""
import http.client
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools')
SIDECARS = [('qwen', os.path.join(ROOT, 'qwen-narrator', 'sidecar.py')),
            ('breeze', os.path.join(ROOT, 'breeze-narrator', 'sidecar.py'))]

passed = failed = 0


def check(ok, name, detail=''):
    global passed, failed
    if ok:
        passed += 1
        print('  OK   ' + name)
    else:
        failed += 1
        print('  FAIL ' + name + (('\n         ' + detail) if detail else ''))


class StubNarrator:
    ready = True
    load_error = None
    private_dir = ''
    cache_dir = 'C:\\cache'
    prints = {}
    voices = {}
    voice_meta = {}
    mode = 'test'

    def __init__(self):
        self.deleted = []

    def delete_voice(self, vid, both=False):
        self.deleted.append(vid)

    def voice_list(self):
        return []


def load_handler(path):
    """The Handler class (and the lines just above it) out of a sidecar, run with stand-ins."""
    src = open(path, encoding='utf-8').read()
    start = src.find('\nALLOWED_ORIGINS')
    if start < 0:                                 # before the fix: the class alone
        start = src.find('\nclass Handler(')
    m = re.compile(r'\n(?=[^\s#])').search(src, src.find('\nclass Handler(') + 1)
    end = m.start() if m else len(src)
    while True:                                   # the comment block after the class is not code
        prev = src.rfind('\n', 0, end - 1)
        if src[prev + 1:end].lstrip().startswith('#'):
            end = prev
        else:
            break
    g = {'json': json, 'BaseHTTPRequestHandler': BaseHTTPRequestHandler, 'log': lambda *a, **k: None,
         'touch': lambda: None, 'cancel': lambda r: None, 'is_cancelled': lambda r: False,
         'Cancelled': type('Cancelled', (Exception,), {}), 'DEFAULT_VOICE': 'v', 'MODEL_REPO': 'm',
         'MODEL_ID': 'm', 'GROUP_SIZE': 8, 'time': __import__('time'), 'threading': threading,
         'LOG_ON': True}
    exec(compile(src[start:end], path, 'exec'), g)
    return g['Handler']


def request(port, method, path, origin=None, body=None, ctype='application/json'):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    headers = {}
    if origin:
        headers['Origin'] = origin
    if body is not None:
        headers['Content-Type'] = ctype
    c.request(method, path, body=body, headers=headers)
    r = c.getresponse()
    r.read()
    return r.status, r.getheader('Access-Control-Allow-Origin')


for name, path in SIDECARS:
    print('--- ' + name)
    Handler = load_handler(path)
    stub = StubNarrator()
    Handler.narrator = stub
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        st, acao = request(port, 'GET', '/health')
        check(st == 200, name + ': the host (no Origin) gets /health', str(st))
        st, acao = request(port, 'GET', '/health', 'https://localapp')
        check(st == 200 and acao == 'https://localapp', name + ': TypoZen\'s page gets /health, allowed by name', '%s %s' % (st, acao))
        st, acao = request(port, 'OPTIONS', '/voices/delete', 'https://localapp')
        check(st == 204 and acao == 'https://localapp', name + ': TypoZen\'s page passes the preflight', '%s %s' % (st, acao))
        st, acao = request(port, 'GET', '/voices', 'https://evil.example')
        check(st == 403 and acao is None, name + ': another site cannot read the voice list', '%s %s' % (st, acao))
        st, acao = request(port, 'OPTIONS', '/voices/delete', 'https://evil.example')
        check(st == 403, name + ': another site fails the preflight', str(st))
        st, _ = request(port, 'POST', '/voices/delete', 'https://evil.example',
                        json.dumps({'id': 'my-voice'}), 'text/plain')
        check(st == 403 and not stub.deleted, name + ': a plain-text POST from another site deletes nothing',
              '%s deleted=%s' % (st, stub.deleted))
        st, _ = request(port, 'POST', '/voices/delete', 'null', json.dumps({'id': 'my-voice'}), 'text/plain')
        check(st == 403 and not stub.deleted, name + ': nor from a file:// or sandboxed page (Origin: null)',
              '%s deleted=%s' % (st, stub.deleted))
        st, _ = request(port, 'POST', '/voices/delete', 'https://localapp', json.dumps({'id': 'kept'}))
        check(st == 200 and stub.deleted == ['kept'], name + ': TypoZen\'s page can still delete a voice',
              '%s deleted=%s' % (st, stub.deleted))
    finally:
        server.shutdown()
        server.server_close()

print('passed=%d failed=%d' % (passed, failed))
print('SIDECAR ORIGIN ' + ('PASSED' if not failed else 'FAILED'))
sys.exit(1 if failed else 0)
