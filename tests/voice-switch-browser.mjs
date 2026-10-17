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

    // Previous, in a reading started at the second paragraph: the first, though never heard.
    const prev = await page.evaluate(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        window.setKokoroVoice('windows_voice', 'Microsoft Hazel');
        try { stopReading(); } catch (e) {}
        const blocks = [...document.querySelectorAll('#editor .block')].filter(b => b.textContent.trim());
        _readFrom = { el: blocks[1], until: Date.now() + 60000 };
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        speakSelection();
        await wait(100);
        const started = _currentTTSBlockEl && _currentTTSBlockEl.textContent.trim();
        window.__posts = [];
        readAloudSkip(-1);
        await wait(200);
        const plays = window.__posts.filter(p => p.startsWith('host_tts_play:')).map(p => JSON.parse(p.substring(14)).text);
        return { started, plays, now: _currentTTSBlockEl && _currentTTSBlockEl.textContent.trim() };
    });
    assert(prev.started === 'Second paragraph here.', 'the reading starts at the second paragraph');
    assert(prev.now === 'First paragraph here.' && prev.plays[0] === 'First paragraph here.',
        'Previous goes to the first, before where it started (' + JSON.stringify(prev) + ')');

    // Next while what comes next is not queued yet (a narrator still rendering it): the next
    // paragraph in the document, not nothing.
    const next = await page.evaluate(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        try { stopReading(); } catch (e) {}
        const blocks = [...document.querySelectorAll('#editor .block')].filter(b => b.textContent.trim());
        _readFrom = { el: blocks[0], until: Date.now() + 60000 };
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        speakSelection();
        await wait(100);
        _ttsChunks = [];                       // the rest not rendered yet
        window.__posts = [];
        readAloudSkip(1);
        await wait(200);
        const plays = window.__posts.filter(p => p.startsWith('host_tts_play:')).map(p => JSON.parse(p.substring(14)).text);
        return { plays, now: _currentTTSBlockEl && _currentTTSBlockEl.textContent.trim() };
    });
    assert(next.now === 'Second paragraph here.' && next.plays[0] === 'Second paragraph here.',
        'Next with nothing queued goes to the next paragraph (' + JSON.stringify(next) + ')');

    // The reading bar stays through all of it: the page tells the host a restart, never a stop
    // (a stop is what takes the bar down). Then Stop while the narrator loads does stop.
    const bar = await page.evaluate(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const stops = () => window.__posts.filter(p => p === 'host_tts_stop').length;
        const restarts = () => window.__posts.filter(p => p === 'host_tts_stop:restart').length;
        const out = {};
        window.setKokoroVoice('windows_voice', 'Microsoft Hazel');
        try { stopReading(); } catch (e) {}
        const blocks = [...document.querySelectorAll('#editor .block')].filter(b => b.textContent.trim());
        _readFrom = { el: blocks[1], until: Date.now() + 60000 };
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        speakSelection();
        await wait(100);
        window.__posts = []; readAloudSkip(-1); await wait(150);
        out.prev = { stops: stops(), restarts: restarts() };
        window.__posts = []; _ttsChunks = []; readAloudSkip(1); await wait(150);
        out.next = { stops: stops(), restarts: restarts() };
        window.__posts = []; window.setKokoroVoice('breeze_narrator', 'Mary (RP, Breeze)'); await wait(150);
        out.voice = { stops: stops(), restarts: restarts(), narrate: window.__posts.includes('host_qwen_narrate'), starting: window.tzNarrStarting ? window.tzNarrStarting() : null };
        // The toolbar's button while the narrator loads: a stop, not a second request.
        window.__posts = []; handleCommand('read_aloud_doc'); await wait(50);
        out.stopWhileLoading = { stops: stops(), narrate: window.__posts.includes('host_qwen_narrate'), starting: window.tzNarrStarting ? window.tzNarrStarting() : null };
        return out;
    });
    assert(bar.prev.stops === 0 && bar.prev.restarts === 1, 'Previous past the start keeps the bar (' + JSON.stringify(bar.prev) + ')');
    assert(bar.next.stops === 0 && bar.next.restarts === 1, 'Next past what is queued keeps the bar (' + JSON.stringify(bar.next) + ')');
    assert(bar.voice.stops === 0 && bar.voice.restarts === 1 && bar.voice.narrate && bar.voice.starting,
        'a voice change keeps the bar while the narrator starts (' + JSON.stringify(bar.voice) + ')');
    assert(bar.stopWhileLoading.stops === 1 && !bar.stopWhileLoading.narrate && !bar.stopWhileLoading.starting,
        'Stop while the narrator loads stops it (' + JSON.stringify(bar.stopWhileLoading) + ')');

    // A narrator voice changed mid-narration: again from the paragraph playing, not the cursor.
    const narr = await page.evaluate(() => {
        const blocks = [...document.querySelectorAll('#editor .block')].filter(b => b.textContent.trim());
        try { stopReading(); } catch (e) {}
        isPlaying = true; _narrActive = true; _currentTTSBlockEl = blocks[2];
        window.__posts = [];
        window.setNarratorSettings({ voice: 'some-other-voice', engine: 'breeze' });
        const asked = window.__posts.some(p => p === 'host_qwen_narrate');
        isPlaying = false; _narrActive = false;
        const c = readingCaret();
        return { asked, from: c && c.block.textContent.trim() };
    });
    assert(narr.asked && narr.from === 'Third paragraph here.',
        'a narrator voice change goes on from the paragraph playing (' + JSON.stringify(narr) + ')');
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
