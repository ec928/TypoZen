/**
 * Stop has to stop the GPU, not just the sound.
 *
 * The first narration build kept the card at 99% after Stop: the page went on requesting
 * groups and the sidecar went on rendering audio nobody would hear. This drives a real
 * reading, presses Stop, and watches what the card does next.
 *
 * Needs the sidecar reachable on 8765 (obj/start-sidecar.ps1).
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
let pass = 0, fail = 0;
const check = (ok, what, detail) => {
    if (ok) { pass++; console.log('  PASS  ' + what); }
    else { fail++; console.log('  FAIL  ' + what + (detail ? '   ' + detail : '')); }
};
const gpu = () => {
    try {
        return parseInt(execSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits',
            { encoding: 'utf8' }).trim().split('\n')[0], 10);
    } catch (e) { return -1; }
};
/** The highest reading over a few seconds: utilisation is spiky, one sample says little. */
async function peak(seconds) {
    let top = 0;
    for (let i = 0; i < seconds * 2; i++) { top = Math.max(top, gpu()); await sleep(500); }
    return top;
}

const profile = path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache_Portable');
const doc = path.join(os.tmpdir(), 'narrate-cancel.md');
// Long enough that rendering it all would take minutes, so "did it stop" is unambiguous.
const paras = [];
for (let i = 0; i < 30; i++) {
    paras.push('Paragraph ' + (i + 1) + '. The woman looked through the binoculars again, using '
        + 'both hands this time, and said nothing at all for a long moment while the dust rose.');
}
fs.writeFileSync(doc, '# Cancel test\n\n' + paras.join('\n\n') + '\n');

if (execSync('tasklist /FI "IMAGENAME eq TypoZen.exe" /NH', { encoding: 'utf8' }).includes('TypoZen.exe')) {
    console.log('TypoZen is open - close it first.');
    process.exit(2);
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

try {
    console.log('  idle GPU before: ' + (await peak(3)) + '%');

    // Kick it off without waiting for it: the call returns once the first block is ready.
    await page.evaluate(() => { window.startQwenNarration('http://127.0.0.1:8765'); });

    let playing = false;
    for (let i = 0; i < 120 && !playing; i++) {
        playing = await page.evaluate(() => isPlaying === true);
        if (!playing) await sleep(1000);
    }
    check(playing, 'narration started');

    const busy = await peak(8);
    console.log('  GPU while narrating: ' + busy + '%');
    check(busy > 20, 'the card is working while it renders ahead', busy + '%');

    const queued = await page.evaluate(() => (typeof queuedSeconds === 'function') ? Math.round(queuedSeconds()) : -1);
    console.log('  audio queued ahead: ' + queued + 's');
    check(queued >= 0 && queued < 200, 'it renders a lead, not the whole document', queued + 's');

    await page.evaluate(() => stopReading());
    // A group already inside generate() runs to its end -- a CUDA call cannot be interrupted
    // safely -- so the promise is "it stops soon", not "it stops instantly". Measured: the
    // in-flight group took 19s. What must not happen is the next group starting.
    console.log('  stopped; waiting for the in-flight group, then checking it stays idle');
    let idleAt = -1;
    for (let i = 0; i < 90; i++) {
        await sleep(1000);
        if (gpu() < 20) { idleAt = i + 1; break; }
    }
    check(idleAt >= 0, 'the card goes idle after Stop', idleAt + 's after stopping');
    if (idleAt >= 0) {
        const after = await peak(10);
        console.log('  GPU over the next 10s: ' + after + '%');
        check(after < 25, 'and stays idle - no further groups started', after + '%');
    }

    const stillPlaying = await page.evaluate(() => isPlaying === true);
    check(!stillPlaying, 'nothing is still reading');
} catch (err) {
    check(false, 'no exception', String(err && err.message || err));
}

try { browser.disconnect(); } catch (e) {}
try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
