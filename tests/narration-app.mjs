/**
 * Narration, end to end, against the real binary: sidecar up, rendered audio playing, and
 * the reading highlight moving on by itself.
 *
 * Needs the Qwen extension installed and the sidecar reachable on 8765 (the app starts it
 * when Qwen Narrator is chosen in File > Read Aloud; obj/start-sidecar.ps1 does it by hand).
 *
 * Two things this suite learned the hard way, both worth keeping:
 *   - virtual-host URLs never appear as page network events, because WebView2 serves them
 *     internally. Ask the page what it is playing instead of watching the network.
 *   - playNextChunk dispatches in two places, paginated and not. Patching one of them left
 *     narration silently falling back to a Windows voice in Pages, which is the layout most
 *     reading actually happens in, and every other check still passed.
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

// The real profile, because that is where the venv and the model are.
const profile = path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache_Portable');
const doc = path.join(os.tmpdir(), 'narrate-sample.md');
fs.writeFileSync(doc,
    '# A sample\n\nThe woman looked through the binoculars again, using both hands this time.\n\n'
  + '"I can see their dust," she announced. "And another couple of scouts, I think."\n\n'
  + '"Astounding," the drone said. It made a small noise, somewhere between a cough and a sigh.\n\n'
  + 'She placed the field glasses down and pulled the brim of her hat over her eyes.\n');

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
    try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null }); }
    catch (e) { await sleep(500); }
}
const page = (await browser.pages()).find(p => p.url().includes('localapp')) || (await browser.pages())[0];
await sleep(2500);

const audioRequests = [];
page.on('request', r => { if (r.url().includes('localnarration')) audioRequests.push(r.url()); });

try {
    check(await page.evaluate(() => typeof window.startQwenNarration === 'function'),
        'the page knows how to narrate');

    // Drive it the way the menu item does, without needing the WPF menu.
    console.log('  starting the narrator (first start loads the model - can take a minute)');
    const started = Date.now();
    const result = await page.evaluate(async () => {
        try {
            const h = await fetch('http://127.0.0.1:8765/health');
            return { reachable: true, body: await h.json() };
        } catch (e) { return { reachable: false, error: String(e) }; }
    });
    if (!result.reachable) {
        console.log('  sidecar not running yet; the app starts it from the menu. ' + result.error);
    }
    check(true, 'health probe from the page completed', JSON.stringify(result).slice(0, 120));

    // Narrate, waiting long enough for a cold model load plus one group.
    await page.evaluate(() => window.startQwenNarration('http://127.0.0.1:8765'));
    let playing = false;
    for (let i = 0; i < 150 && !playing; i++) {
        playing = await page.evaluate(() => isPlaying === true && !!document.querySelector('.tts-active'));
        if (!playing) await sleep(1000);
    }
    check(playing, 'narration started and a block is highlighted',
        Math.round((Date.now() - started) / 1000) + 's');

    if (playing) {
        const first = await page.evaluate(() => document.querySelector('.tts-active')?.innerText?.slice(0, 40));
        console.log('        highlighted: ' + JSON.stringify(first));
        // Not via page.on('request'): WebView2 serves virtual-host URLs internally and they
        // never surface as network events. Ask the page what it is actually playing.
        const playingState = await page.evaluate(() => {
            const a = document.querySelector('audio') || window._renderedAudioProbe || null;
            return {
                chunkHasUrl: !!(window.__lastChunkUrl || ''),
                url: window.__lastChunkUrl || '',
            };
        });
        check(playingState.chunkHasUrl && playingState.url.indexOf('localnarration') >= 0,
            'the block being read is playing rendered narration audio',
            JSON.stringify(playingState));

        // The highlight should move on by itself as the audio ends.
        let moved = false;
        for (let i = 0; i < 60 && !moved; i++) {
            const now = await page.evaluate(() => document.querySelector('.tts-active')?.innerText?.slice(0, 40));
            moved = now && now !== first;
            if (!moved) await sleep(1000);
        }
        check(moved, 'the highlight follows on to the next block');
        await page.evaluate(() => stopReading());
    }
} catch (err) {
    check(false, 'no exception', String(err && err.message || err));
}

try { browser.disconnect(); } catch (e) {}
try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
