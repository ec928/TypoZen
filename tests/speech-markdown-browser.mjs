/**
 * Read aloud with a Windows, online or Kokoro voice gives the voice what Preview shows, not
 * the Markdown source: no **, #, list markers or link syntax. Headless; the host is a stub.
 *
 * 2026-10-17: the narration monitor showed "**Write in the morning...**" -- each paragraph
 * of a Markdown file was sent to the voice as written.
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
    console.error('SPEECH MARKDOWN: deadline');
    try { browser.process().kill('SIGKILL'); } catch (e) {}
    process.exit(3);
}, 40000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof speakSelection === 'function' && typeof finishLoadContent === 'function', { timeout: 15000 });
    const doc = [
        '**Write in the morning, read in the evening.**', '',
        '# The Ferry', '',
        'See [the docs](https://x.y/z) and _soft_ text with `code`.', '',
        '- a list item with **bold**', '',
        '> a quoted line', '',
        '![A harbour at night](harbour.png)', ''
    ].join('\n');
    const want = ['Write in the morning, read in the evening.', 'The Ferry', 'See the docs and soft text with code.',
        'a list item with bold', 'a quoted line', 'A harbour at night'];
    const sent = await page.evaluate(async (doc) => {
        const posts = [];
        window.chrome = window.chrome || {};
        window.chrome.webview = window.chrome.webview || {};
        window.chrome.webview.postMessage = (m) => posts.push(String(m));
        setSourceDocExt('md');
        if (state.mode !== 'preview') handleCommand('view_set:mode:preview');
        finishLoadContent(doc, false, false);
        await new Promise(r => setTimeout(r, 300));
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        speakSelection();
        await new Promise(r => setTimeout(r, 300));
        const first = posts.filter(p => p.startsWith('host_tts_play:')).map(p => JSON.parse(p.substring(14)).text);
        // The rest of the queue, as each will be given to the voice.
        const rest = (_ttsChunks || []).map(c => chunkSpeechText(c));
        try { stopReading(); } catch (e) {}
        return first.concat(rest).filter(t => t && t.trim());
    }, doc);
    assert(sent.length === want.length, 'one piece per paragraph (' + sent.length + ': ' + JSON.stringify(sent) + ')');
    want.forEach((w, i) => assert(sent[i] === w, 'given ' + JSON.stringify(w) + ' (got ' + JSON.stringify(sent[i]) + ')'));
    assert(!sent.some(t => /\*\*|^#|\]\(|^- |^> /.test(t)), 'no Markdown syntax reaches the voice');
} catch (e) {
    failed++;
    console.error('  FAIL ' + (e && e.stack || e));
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`passed=${passed} failed=${failed}`);
if (failed) { console.log('SPEECH MARKDOWN FAILED'); process.exit(1); }
console.log('SPEECH MARKDOWN PASSED');
