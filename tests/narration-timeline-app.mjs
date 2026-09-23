/**
 * Does narration keep talking? Measured over a minute and a half, in 2-column Pages, on
 * book-length paragraphs, starting from a page that is not the first.
 *
 * Ed's reports were all about behaviour over time -- it started at the table of contents,
 * played one sentence and went quiet, and moving elsewhere started over -- and every
 * earlier check looked at one instant. This records each clip starting and ending and
 * reports the silences between them, which is the number that decides whether it works.
 *
 * Runs in a throwaway profile, so nothing changes Ed's own layout or tabs. The narrator is
 * started by the test with its cache inside that profile and the weights read from the
 * installed extension. Everything it starts, it stops -- even when a check fails.
 *
 *   node tests/narration-timeline-app.mjs
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

const realModels = path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache_Portable',
                             'extensions', 'QwenTTS', 'models');
const python = path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache_Portable',
                         'extensions', 'QwenTTS', 'venv', 'Scripts', 'python.exe');
const profile = path.join(os.tmpdir(), 'typozen-narr-' + process.pid);
const narrCache = path.join(profile, 'extensions', 'QwenTTS', 'narration');
fs.mkdirSync(narrCache, { recursive: true });

const PARA = "The woman looked through the binoculars again, using both hands this time, and "
    + "said nothing at all for a long moment while the dust rose along the line of the road. "
    + "In the distance, trembling through the heat haze, the straight edge of the highway ran "
    + "on towards mountains that were pale with distance. Some scrawny trees marked its course, "
    + "few of them taller than one man standing on another's shoulders. She had been watching "
    + "the same stretch of ground since the morning, and nothing had moved on it but the army.";
const doc = path.join(profile, 'narration-timeline.md');
const paras = ['# Contents\n\nPrologue\n\nOne\n\nTwo\n\nThree'];
for (let i = 0; i < 24; i++) paras.push('Paragraph ' + (i + 1) + '. ' + PARA);
fs.writeFileSync(doc, paras.join('\n\n') + '\n');

if (execSync('tasklist /FI "IMAGENAME eq TypoZen.exe" /NH', { encoding: 'utf8' }).includes('TypoZen.exe')) {
    console.log('TypoZen is open - close it first.');
    process.exit(2);
}

let sidecar = null, app = null, browser = null;
const cleanup = () => {
    try { if (browser) browser.disconnect(); } catch (e) {}
    try { if (app) execSync('taskkill /PID ' + app.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
    try { if (sidecar) execSync('taskkill /PID ' + sidecar.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
};

try {
    // Whatever is on 8765 now is not ours and points at another cache; stop it.
    try { execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" | Where-Object { $_.CommandLine -like \'*sidecar.py*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { stdio: 'ignore' }); } catch (e) {}
    await sleep(1500);

    const tc = Date.now();
    sidecar = spawn(python, [path.join(appDir, 'tools', 'qwen-narrator', 'sidecar.py'),
        '--cache', narrCache, '--models', realModels, '--port', '8765'],
        { stdio: 'ignore', windowsHide: true });
    let up = false;
    for (let i = 0; i < 180 && !up; i++) {
        await sleep(1000);
        try { up = (await (await fetch('http://127.0.0.1:8765/health')).json()).ready === true; } catch (e) {}
    }
    check(up, 'the narrator starts from the extension folder, offline',
          ((Date.now() - tc) / 1000).toFixed(0) + 's');
    if (!up) throw new Error('narrator never became ready');
    console.log('        model load: ' + ((Date.now() - tc) / 1000).toFixed(0) + 's');

    app = spawn(path.join(appDir, 'TypoZen.exe'), ['--debug', doc], {
        cwd: appDir, stdio: 'ignore',
        env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profile })
    });
    for (let i = 0; i < 90 && !browser; i++) {
        try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null, protocolTimeout: 600000 }); }
        catch (e) { await sleep(500); }
    }
    let page = (await browser.pages()).find(p => p.url().includes('localapp')) || (await browser.pages())[0];
    await sleep(3000);

    // Ed's layout. Changing it can reload the page, so find the page again afterwards.
    await page.evaluate(() => handleCommand('view_set:columns:2'));
    await sleep(2000);
    await page.evaluate(() => handleCommand('view_set:scroll:pagination'));
    await sleep(3000);
    page = (await browser.pages()).find(p => p.url().includes('localapp')) || page;

    // Put paragraph 9 on screen, with no cursor anywhere -- as when simply reading.
    await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('#editor .block'))
            .find(x => /^Paragraph 9\./.test((x.innerText || '').trim()));
        const idx = b ? parseInt(b.getAttribute('data-model-index'), 10) : NaN;
        if (isFinite(idx)) goToModelBlock(idx);
    });
    await sleep(2500);
    await page.evaluate(() => { try { window.getSelection().removeAllRanges(); } catch (e) {} });

    const t0 = Date.now();
    await page.evaluate(() => { window.startQwenNarration('http://127.0.0.1:8765'); });

    // Pieces are whole paragraphs, so a cold first batch takes about twice its longest
    // paragraph -- the price of one voice with context across sentences (plan 3g). 90s is
    // that ceiling for this document's paragraphs; render-ahead is what makes it instant.
    let firstSound = -1, firstBlock = '';
    for (let i = 0; i < 200 && firstSound < 0; i++) {
        const s = await page.evaluate(() => ({
            n: (window.__narrLog || []).filter(e => e[0] === 'play').length,
            on: (document.querySelector('.tts-active')?.innerText || '').trim().slice(0, 30)
        }));
        if (s.n > 0) { firstSound = (Date.now() - t0) / 1000; firstBlock = s.on; }
        else await sleep(500);
    }
    check(firstSound > 0 && firstSound < 90, 'first sound within one batch of paragraphs (under 90s)', firstSound.toFixed(1) + 's');
    check(!/Contents|Prologue/.test(firstBlock) && /Paragraph/.test(firstBlock),
          'it starts on the page being read, not the contents', JSON.stringify(firstBlock));

    console.log('        listening for 90 seconds...');
    await sleep(90000);

    const r = await page.evaluate(() => {
        const log = window.__narrLog || [];
        const gaps = [];
        for (let i = 0; i < log.length - 1; i++) {
            if (log[i][0] === 'end' && log[i + 1][0] === 'play') gaps.push((log[i + 1][1] - log[i][1]) / 1000);
        }
        // A silence still going on counts too. Only measuring between clips missed a
        // narration that had stalled at the end: 8 clips played in 90s, then nothing, and
        // this test passed.
        const last = log[log.length - 1];
        if (last && last[0] === 'end') gaps.push((performance.now() - last[1]) / 1000);
        return {
            clips: log.filter(e => e[0] === 'play').length,
            gaps: gaps,
            playing: isPlaying === true,
            on: (document.querySelector('.tts-active')?.innerText || '').trim().slice(0, 30)
        };
    });
    const worst = r.gaps.length ? Math.max.apply(null, r.gaps) : 0;
    const long = r.gaps.filter(g => g > 1.5).length;
    console.log('        clips played: ' + r.clips + ', worst silence between them: ' + worst.toFixed(1)
        + 's, silences over 1.5s: ' + long);
    console.log('        now reading: ' + JSON.stringify(r.on));
    check(r.playing, 'still reading after 90 seconds, not stopped after one sentence');
    // Clips are paragraphs of 15-30s, so three in 90s is moving on.
    check(r.clips >= 3, 'it moved on through several clips', r.clips + ' clips');
    check(long === 0, 'no silence between clips longer than 1.5s', 'worst ' + worst.toFixed(1) + 's');

    await page.evaluate(() => stopReading());
    // A failure should say why, and the profile holding narration.log is deleted below.
    if (fail) {
        const trace = await page.evaluate(() => window.__narrTrace || []);
        console.log('        --- page trace');
        for (const l of trace.filter(l => /narrate:|batch|first sound|waiting|answer|SILENT|FAILED/.test(l)).slice(0, 25)) {
            console.log('        ' + l.slice(0, 220));
        }
    }
} catch (err) {
    check(false, 'no exception', String(err && err.message || err));
} finally {
    cleanup();
    if (fail) {
        try {
            const log = fs.readFileSync(path.join(profile, 'extensions', 'QwenTTS', 'narration.log'), 'utf8');
            console.log('        --- narrator');
            for (const l of log.split('\n').filter(l => /rendered|answered|model ready/.test(l))) console.log('        ' + l.slice(14, 200));
        } catch (e) {}
    }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
