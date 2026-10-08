/**
 * The Breeze narrator, end to end, through the host: Read Aloud with the Breeze voice chosen
 * starts Breeze's sidecar (BreezeNarrator), the page plays its audio from Breeze's own host,
 * the highlight moves on, and choosing the Qwen narrator afterwards takes Breeze off the card
 * before Qwen starts (NarratorEngine: the two do not fit 12 GB together). Closing TypoZen
 * stops whichever is running.
 *
 * Runs in the harness's throwaway profile on its hidden desktop. The extensions are linked into
 * that profile, not copied: Breeze from its install (%LOCALAPPDATA%\TypoZen_Cache_Portable\
 * extensions\BreezeTTS) or, before there is an installer, the test rig in BREEZE_RIG
 * (default C:\Users\chan_\BreezeTest: venv, model, code); Qwen from its install. Rendered audio
 * and logs stay in the profile. The narration is heard. Refuses if a narrator is already running.
 *
 *   RUN_APP_E2E=1 node tests/breeze-narration-app.mjs      (about 3 minutes)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { launchApp, profileDir, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }
let pass = 0, fail = 0;
const check = (ok, what, detail) => {
    if (ok) { pass++; console.log('  PASS  ' + what); }
    else { fail++; console.log('  FAIL  ' + what + (detail ? '   ' + detail : '')); }
};
const health = async (port) => { try { return await (await fetch('http://127.0.0.1:' + port + '/health')).json(); } catch (e) { return null; } };
for (const port of [8765, 8766]) {
    if (await health(port)) { console.log('A narrator is already running on ' + port + ' - stop it first.'); process.exit(2); }
}

const installed = path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache_Portable', 'extensions');
const rig = process.env.BREEZE_RIG || 'C:\\Users\\chan_\\BreezeTest';
const breezeSrc = fs.existsSync(path.join(installed, 'BreezeTTS', 'model', 'config.json'))
    ? { venv: path.join(installed, 'BreezeTTS', 'venv'), model: path.join(installed, 'BreezeTTS', 'model'), code: path.join(installed, 'BreezeTTS', 'breeze-tts') }
    : { venv: path.join(rig, 'venv'), model: path.join(rig, 'model'), code: path.join(rig, 'code') };
const qwenSrc = path.join(installed, 'QwenTTS');
// Compiled kernels outlive the throwaway profile, so a run does not pay the first compile (2 min).
const compiled = path.join(process.env.LOCALAPPDATA, 'Temp', 'typozen-breeze-test-compiled');
fs.mkdirSync(compiled, { recursive: true });

const ext = path.join(profileDir, 'extensions');
const links = [];
function link(at, to) {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    execSync('cmd /c mklink /J "' + at + '" "' + to + '"', { stdio: 'ignore' });
    links.push(at);
}
link(path.join(ext, 'BreezeTTS', 'venv'), breezeSrc.venv);
link(path.join(ext, 'BreezeTTS', 'model'), breezeSrc.model);
link(path.join(ext, 'BreezeTTS', 'breeze-tts'), breezeSrc.code);
link(path.join(ext, 'BreezeTTS', 'compiled'), compiled);
const haveQwen = fs.existsSync(path.join(qwenSrc, 'venv', 'Scripts', 'python.exe'));
if (haveQwen) {
    link(path.join(ext, 'QwenTTS', 'venv'), path.join(qwenSrc, 'venv'));
    link(path.join(ext, 'QwenTTS', 'models'), path.join(qwenSrc, 'models'));
}

const doc = path.join(profileDir, 'breeze-sample.md');
fs.writeFileSync(doc,
    '# A sample\n\nThe woman looked through the binoculars again, using both hands this time.\n\n'
  + '"I can see their dust," she announced. "And another couple of scouts, I think."\n\n'
  + 'She laughed. [laughing] "Astounding," the drone said.\n\n'
  + 'She placed the field glasses down and pulled the brim of her hat over her eyes.\n');

let app = null;
const unlinkAll = () => { for (const l of links.reverse()) { try { fs.rmdirSync(l); } catch (e) { } } };
const cleanup = async () => { try { if (app) await app.close(); } catch (e) { } unlinkAll(); };
const killer = setTimeout(async () => { console.log('BUDGET HIT (7 min)'); await cleanup(); process.exit(3); }, 7 * 60000);

try {
    app = await launchApp({ file: doc, settleMs: 6000 });
    const page = app.page;
    // Choose the Breeze narrator the way the menu does: the page is told, and tells the host.
    await page.evaluate(() => window.setKokoroVoice('breeze_narrator', 'Northern English (original)'));
    await sleep(500);
    // Read Aloud, as the toolbar button sends it.
    await page.evaluate(() => { window.getSelection().removeAllRanges(); speakSelection(); });

    let h = null; const t0 = Date.now();
    while (Date.now() - t0 < 200000) { h = await health(8766); if (h && (h.ready || h.error)) break; await sleep(500); }
    check(h && h.ready && h.engine === 'breeze', 'Read Aloud started the Breeze narrator', JSON.stringify(h));
    console.log('        ready after ' + ((Date.now() - t0) / 1000).toFixed(0) + 's, mode ' + (h && h.mode));
    check(h && h.cache && h.cache.startsWith(profileDir), "its audio goes to the profile's Breeze folder", h && h.cache);

    let src = '', t1 = Date.now();
    while (Date.now() - t1 < 60000) {
        src = await page.evaluate(() => { const a = (typeof _renderedAudio !== 'undefined') && _renderedAudio; return a && !a.paused ? a.src : ''; });
        if (src) break; await sleep(200);
    }
    check(/^https:\/\/localbreeze\//.test(src), 'the page plays Breeze audio from its own host', src);
    const firstSound = (Date.now() - t1) / 1000;
    // One piece per request (BreezeNarrator sends batch 1): a batch of eight made this 17.8s.
    check(src && firstSound < 8, 'the first sound comes within 8s of the narrator being ready', firstSound.toFixed(1) + 's');
    const first = await page.evaluate(() => (document.querySelector('#editor .tts-active') || {}).textContent || '');
    let moved = false; const t2 = Date.now();
    while (Date.now() - t2 < 60000) {
        const now = await page.evaluate(() => (document.querySelector('#editor .tts-active') || {}).textContent || '');
        if (now && now !== first) { moved = true; break; }
        await sleep(300);
    }
    check(moved, 'the highlight follows on to the next block', first.slice(0, 40));
    check(!(await health(8765)), 'the Qwen narrator is not running alongside it');

    if (haveQwen) {
        await page.evaluate(() => { if (typeof stopReading === 'function') stopReading(); });
        await page.evaluate(() => window.setKokoroVoice('qwen_narrator', 'Northern English (original)'));
        await sleep(500);
        await page.evaluate(() => { window.getSelection().removeAllRanges(); speakSelection(); });
        let breezeGone = false, qwenUp = null; const t3 = Date.now();
        while (Date.now() - t3 < 120000) {
            if (!breezeGone && !(await health(8766))) breezeGone = true;
            const q = await health(8765);
            if (q) { if (!breezeGone && await health(8766)) { qwenUp = 'both'; break; } }
            if (q && q.ready) { qwenUp = 'ready'; break; }
            await sleep(250);
        }
        check(breezeGone && qwenUp === 'ready', 'choosing Qwen took Breeze off the card before Qwen was up', 'breezeGone ' + breezeGone + ', qwen ' + qwenUp);
        await page.evaluate(() => { if (typeof stopReading === 'function') stopReading(); });
    } else console.log('        (Qwen not installed: the switch is not checked)');

    await app.close(); app = null;
    await sleep(1500);
    check(!(await health(8765)) && !(await health(8766)), 'closing TypoZen stopped the narrator');
} catch (e) {
    fail++; console.log('  FAIL  ' + e.message.split('\n')[0]);
} finally {
    await cleanup();
    clearTimeout(killer);
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
