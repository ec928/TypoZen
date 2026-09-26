/**
 * A narrator of the test's own, for the narration *-app suites.
 *
 * Its cache is inside the harness's throwaway profile -- the same folder the app serves
 * narration audio from under that profile (QwenNarrator.CacheDir) -- and the weights are
 * read from the installed extension, so nothing is written to the reader's own narration
 * cache and no second copy of the model is downloaded. A narrator already on 8765 is not
 * the test's to stop: it may be a TypoZen session in use. The suite refuses instead.
 *
 * Not a suite: listed with the other helpers in run-tests.ps1 and the build scripts.
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache_Portable', 'extensions', 'QwenTTS');
export const NARRATOR = 'http://127.0.0.1:8765';

async function health() {
    try { return await (await fetch(NARRATOR + '/health')).json(); } catch (e) { return null; }
}

/**
 * Start it and wait for the model, up to `readyMs`. Exits the process with code 2 if a
 * narrator is already running. Returns { seconds, stop } -- stop() asks it to exit and
 * kills it (only it) if it has not.
 */
export async function startNarrator(profileDir, readyMs) {
    if (await health()) {
        console.log('A narrator is already running on 8765 - stop it first (it is not this test\'s to stop).');
        process.exit(2);
    }
    const cache = path.join(profileDir, 'extensions', 'QwenTTS', 'narration');
    fs.mkdirSync(cache, { recursive: true });
    const t0 = Date.now();
    const proc = spawn(path.join(ext, 'venv', 'Scripts', 'python.exe'),
        [path.join(here, '..', 'tools', 'qwen-narrator', 'sidecar.py'),
         '--cache', cache, '--models', path.join(ext, 'models'), '--port', '8765', '--idle-minutes', '5'],
        { stdio: 'ignore', windowsHide: true });
    let exited = false;
    proc.on('exit', () => { exited = true; });
    const stop = async () => {
        try { await fetch(NARRATOR + '/stop', { method: 'POST', body: '{}' }); } catch (e) { }
        for (let i = 0; i < 20 && !exited; i++) await new Promise(r => setTimeout(r, 250));
        if (!exited) { try { execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { } }
    };
    const deadline = Date.now() + (readyMs || 180000);
    let h = null;
    while (Date.now() < deadline && !exited) {
        h = await health();
        if (h && (h.ready || h.error)) break;
        await new Promise(r => setTimeout(r, 500));
    }
    if (!h || !h.ready) {
        await stop();
        throw new Error('the narrator did not become ready: ' + JSON.stringify(h));
    }
    return { seconds: (Date.now() - t0) / 1000, stop };
}
