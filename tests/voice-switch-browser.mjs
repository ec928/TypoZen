/**
 * Changing the voice while reading: the reading goes on in the new voice from the paragraph
 * that was playing; choosing a narrator takes Kokoro off the graphics card. Headless; the
 * host is a stub, and Kokoro's worker a stand-in that records being terminated.
 *
 * 2026-10-17: Kokoro (Isabella) was reading, Breeze was chosen; the rest of the reading went
 * to a Windows voice while Breeze loaded beside Kokoro on a 12 GB card, and the PC stalled.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
const deadline = setTimeout(() => {
    console.error('VOICE SWITCH: deadline');
    try { browser.process().kill('SIGKILL'); } catch (e) {}
    process.exit(3);
}, 40000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof speakSelection === 'function' && typeof finishLoadContent === 'function', { timeout: 15000 });
    await page.evaluate(() => {
        window.__posts = [];
        window.chrome = window.chrome || {};
        window.chrome.webview = window.chrome.webview || {};
        window.chrome.webview.postMessage = (m) => window.__posts.push(String(m));
        setSourceDocExt('md');
        if (state.mode !== 'preview') handleCommand('view_set:mode:preview');
        finishLoadContent('First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n', false, false);
        window.setKokoroVoice('windows_voice', 'Microsoft Hazel');
    });
    await new Promise(r => setTimeout(r, 300));

    // A Windows voice reads; the first paragraph finishes and the second is playing.
    await page.evaluate(() => {
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        speakSelection();
        nativeTTSFinished();
    });
    await new Promise(r => setTimeout(r, 200));
    const playing = await page.evaluate(() => _currentTTSBlockEl && _currentTTSBlockEl.textContent.trim());
    assert(playing === 'Second paragraph here.', 'the second paragraph is playing (' + playing + ')');

    // Kokoro loaded on the card, as it was.
    await page.evaluate(() => {
        window.__terminated = false;
        _kokoroWorker = { terminate: () => { window.__terminated = true; } };
        _isKokoroReady = true;
        window.__posts = [];
        window.setKokoroVoice('breeze_narrator', 'Mary (RP, Breeze)');
    });
    await new Promise(r => setTimeout(r, 200));
    const after = await page.evaluate(() => ({
        terminated: window.__terminated, ready: _isKokoroReady,
        posts: window.__posts.filter(p => /^host_(tts_stop|qwen_narrate|tts_play)/.test(p)).map(p => p.split(':')[0])
    }));
    assert(after.terminated && !after.ready, 'choosing a narrator takes Kokoro off the card');
    assert(JSON.stringify(after.posts) === '["host_tts_stop","host_qwen_narrate"]',
        'the reading stops and asks the narrator to go on -- no Windows voice (' + JSON.stringify(after.posts) + ')');
    const from = await page.evaluate(() => { const c = readingCaret(); return c && c.block.textContent.trim(); });
    assert(from === 'Second paragraph here.', 'from the paragraph that was playing (' + from + ')');

    // One narrator voice to another is the narrator's own restart: no second request from here.
    await page.evaluate(() => {
        isPlaying = true; window.__posts = [];
        window.setKokoroVoice('breeze_narrator', 'Michael (RP)');
        isPlaying = false;
    });
    const n2n = await page.evaluate(() => window.__posts.filter(p => /^host_(tts_stop|qwen_narrate)/.test(p)).length);
    assert(n2n === 0, 'narrator to narrator is left to the narrator');
} catch (e) {
    failed++;
    console.error('  FAIL ' + (e && e.stack || e));
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`passed=${passed} failed=${failed}`);
if (failed) { console.log('VOICE SWITCH FAILED'); process.exit(1); }
console.log('VOICE SWITCH PASSED');
