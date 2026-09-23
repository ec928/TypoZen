/**
 * How long until a word is heard, on paragraphs the size a book actually has.
 *
 * Every earlier measurement used one-line paragraphs, which made the opening chunk cheap
 * and the number meaningless: it said 4s where Ed measured two minutes. This uses ~900
 * character paragraphs -- about a minute of speech each -- and reports the wall clock from
 * pressing Narrate to the first audio element playing.
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LONG = "The woman looked through the binoculars again, using both hands this time, and "
    + "said nothing at all for a long moment while the dust rose along the line of the road. "
    + "In the distance, trembling through the heat haze, the straight edge of the highway ran "
    + "on towards mountains that were pale with distance and shimmered in the baking air. Some "
    + "scrawny trees marked its course, few of them taller than one man standing on another's "
    + "shoulders, and beyond them the scrub gave way to sand. She had been watching the same "
    + "stretch of ground since the morning, and the light had not changed, and nothing had "
    + "moved on it but the army, which was closer now than it had been at noon, and slower "
    + "than she had expected an army of that size to be.";

const profile = path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache_Portable');
const doc = path.join(os.tmpdir(), 'narrate-long-' + Date.now() + '.md');
const paras = [];
for (let i = 0; i < 10; i++) paras.push('Section ' + (i + 1) + '. ' + LONG);
fs.writeFileSync(doc, '# Long paragraphs\n\n' + paras.join('\n\n') + '\n');
console.log('  paragraphs of ' + LONG.length + ' characters (about a minute of speech each)');

if (execSync('tasklist /FI "IMAGENAME eq TypoZen.exe" /NH', { encoding: 'utf8' }).includes('TypoZen.exe')) {
    console.log('TypoZen is open - close it first.');
    process.exit(2);
}

// The test owns the sidecar for its whole run. Starting it detached from a tool shell kept
// losing it -- it loaded, then was killed without a word -- which made every "never played"
// ambiguous between a slow narrator and no narrator at all.
const qroot = path.join(profile, 'extensions', 'QwenTTS');
const health = async () => {
    try { const r = await fetch('http://127.0.0.1:8765/health'); return (await r.json()).ready === true; }
    catch (e) { return false; }
};
let sidecar = null;
if (!(await health())) {
    const tc = Date.now();
    sidecar = spawn(path.join(qroot, 'venv', 'Scripts', 'python.exe'),
        [path.join(appDir, 'tools', 'qwen-narrator', 'sidecar.py'),
         '--cache', path.join(qroot, 'narration'), '--port', '8765'],
        { stdio: 'ignore', windowsHide: true });
    let up = false;
    for (let i = 0; i < 180 && !up; i++) { await sleep(1000); up = await health(); }
    console.log(up ? '  cold start (process to model ready): ' + ((Date.now() - tc) / 1000).toFixed(0) + 's'
                   : '  SIDECAR NEVER BECAME READY');
    if (!up) { try { sidecar.kill(); } catch (e) {} process.exit(1); }
} else {
    console.log('  sidecar already warm');
}

const child = spawn(path.join(appDir, 'TypoZen.exe'), ['--debug', doc], {
    cwd: appDir, stdio: 'ignore',
    env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profile })
});
let browser = null;
for (let i = 0; i < 90 && !browser; i++) {
    try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null, protocolTimeout: 600000 }); }
    catch (e) { await sleep(500); }
}
const page = (await browser.pages()).find(p => p.url().includes('localapp')) || (await browser.pages())[0];
await sleep(2500);

const t0 = Date.now();
await page.evaluate(() => { window.__lastChunkUrl = ''; window.startQwenNarration('http://127.0.0.1:8765'); });

let heard = -1;
for (let i = 0; i < 240; i++) {
    const playing = await page.evaluate(() => !!window.__lastChunkUrl && isPlaying === true);
    if (playing) { heard = (Date.now() - t0) / 1000; break; }
    await sleep(500);
}
console.log(heard < 0 ? '  NEVER PLAYED within 120s'
                      : '  first sound after ' + heard.toFixed(1) + 's');

// And again from the same place: this should come from the cache.
if (heard > 0) {
    await page.evaluate(() => stopReading());
    await sleep(1500);
    const t1 = Date.now();
    await page.evaluate(() => { window.__lastChunkUrl = ''; window.startQwenNarration('http://127.0.0.1:8765'); });
    let again = -1;
    for (let i = 0; i < 240; i++) {
        const playing = await page.evaluate(() => !!window.__lastChunkUrl && isPlaying === true);
        if (playing) { again = (Date.now() - t1) / 1000; break; }
        await sleep(500);
    }
    console.log(again < 0 ? '  second attempt never played'
                          : '  second time from the same spot: ' + again.toFixed(1) + 's');
    await page.evaluate(() => stopReading());
}

try { browser.disconnect(); } catch (e) {}
try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
if (sidecar) { try { execSync('taskkill /PID ' + sidecar.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {} }
