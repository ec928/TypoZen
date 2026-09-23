/**
 * What narration actually does over a minute, on a real book, in the layout Ed reads in.
 *
 * Every earlier check asked one question at one moment. Ed's reports were about what
 * happens over time -- it started in the wrong place, played one sentence and stopped,
 * and moving elsewhere started over -- so this records a timeline instead: every half
 * second, what block is highlighted, what audio is playing, how much is queued, and
 * whether more is still coming.
 *
 *   node tests/narration-timeline-app.mjs
 */
import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BOOK = path.join(appDir, 'tests', 'Matter - Iain M. Banks.epub');
const profile = path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache_Portable');
const qroot = path.join(profile, 'extensions', 'QwenTTS');

if (execSync('tasklist /FI "IMAGENAME eq TypoZen.exe" /NH', { encoding: 'utf8' }).includes('TypoZen.exe')) {
    console.log('TypoZen is open - close it first.');
    process.exit(2);
}

const health = async () => {
    try { const r = await fetch('http://127.0.0.1:8765/health'); return (await r.json()).ready === true; }
    catch (e) { return false; }
};
let sidecar = null;
if (!(await health())) {
    sidecar = spawn(path.join(qroot, 'venv', 'Scripts', 'python.exe'),
        [path.join(appDir, 'tools', 'qwen-narrator', 'sidecar.py'),
         '--cache', path.join(qroot, 'narration'), '--port', '8765'],
        { stdio: 'ignore', windowsHide: true });
    let up = false;
    for (let i = 0; i < 180 && !up; i++) { await sleep(1000); up = await health(); }
    if (!up) { console.log('sidecar never ready'); process.exit(1); }
}
console.log('  narrator ready');

const child = spawn(path.join(appDir, 'TypoZen.exe'), ['--debug', BOOK], {
    cwd: appDir, stdio: 'ignore',
    env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profile })
});
let browser = null;
for (let i = 0; i < 90 && !browser; i++) {
    try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null, protocolTimeout: 600000 }); }
    catch (e) { await sleep(500); }
}
const page = (await browser.pages()).find(p => p.url().includes('localapp')) || (await browser.pages())[0];
await sleep(4000);

// Ed's layout, and the prologue on screen with no cursor in it.
await page.evaluate(() => { handleCommand('view_set:columns:2'); });
await sleep(1500);
await page.evaluate(() => { handleCommand('view_set:scroll:pagination'); });
await sleep(2500);
const where = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('#editor .block'));
    const i = blocks.findIndex(b => /A light breeze produced/.test(b.innerText || ''));
    if (i < 0) return { found: false, blocks: blocks.length };
    const idx = parseInt(blocks[i].getAttribute('data-model-index'), 10);
    if (isFinite(idx) && typeof goToModelBlock === 'function') goToModelBlock(idx);
    return { found: true, idx: idx };
});
await sleep(3000);
await page.evaluate(() => { try { window.getSelection().removeAllRanges(); } catch (e) {} });
console.log('  prologue located: ' + JSON.stringify(where));

const snap = () => page.evaluate(() => ({
    on: (document.querySelector('.tts-active')?.innerText || '').replace(/\s+/g, ' ').slice(0, 50),
    url: (window.__lastChunkUrl || '').split('/').pop(),
    playing: isPlaying === true,
    queued: (typeof _ttsChunks !== 'undefined') ? _ttsChunks.length : -1,
    pending: (typeof _narrationPending !== 'undefined') ? _narrationPending : null,
    status: (document.getElementById('kokoro-status')?.innerText || '').slice(0, 60)
}));

const t0 = Date.now();
await page.evaluate(() => { window.__lastChunkUrl = ''; window.startQwenNarration('http://127.0.0.1:8765'); });

let last = '';
const clips = new Set();
let firstBlock = null;
for (let i = 0; i < 150; i++) {
    const s = await snap();
    if (s.url) clips.add(s.url);
    if (s.on && !firstBlock) firstBlock = s.on;
    const line = JSON.stringify([s.on, s.url, s.playing, s.queued, s.pending, s.status]);
    if (line !== last) {
        console.log('  ' + ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's  '
            + (s.playing ? 'PLAY ' : 'idle ') + 'q=' + s.queued + ' pend=' + s.pending
            + '  "' + s.on + '"  ' + (s.url || '') + (s.status ? '  [' + s.status + ']' : ''));
        last = line;
    }
    await sleep(500);
}
console.log('');
console.log('  first block read : "' + firstBlock + '"');
console.log('  distinct clips   : ' + clips.size);

await page.evaluate(() => stopReading());
try { browser.disconnect(); } catch (e) {}
try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
if (sidecar) { try { execSync('taskkill /PID ' + sidecar.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {} }
