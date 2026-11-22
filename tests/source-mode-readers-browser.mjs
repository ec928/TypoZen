/**
 * Every feature that reads the document sees what was just typed in Source (2026-11-22).
 *
 * In Source the text is the Source editor's; the Preview blocks still in the page are the
 * text as it was when Preview was left. Export to HTML read the document after copying those
 * stale blocks back into it, and left out what was typed in Source; Print read the Source
 * editor's drawn lines, a window of them. This types a new heading and a new quotation in
 * Source, then -- without switching back -- asks each reader for the document and looks for
 * them. A new feature that reads the document belongs in this list.
 *
 *   node tests/source-mode-readers-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;
function ok(c, msg, detail) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg + (detail ? '  -- ' + detail : '')); } }
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.__sent = []; window.chrome = { webview: { postMessage: (m) => { window.__sent.push(String(m)); }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    await page.evaluate(() => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); loadMarkdownContent('# Story\n\n"Hello," said Anna.\n\nThe end of the first part.'); });
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await new Promise(r => setTimeout(r, 500));
    // Typed with real keys: a word on an existing line (no Enter), then new lines.
    await page.evaluate(() => { const se = sourceEditor; const at = se.value.indexOf('first part') + 'first part'.length; se.focus(); se.setSelectionRange(at, at); });
    await page.keyboard.type(' QzSameLine');
    await page.evaluate(() => { const se = sourceEditor; se.focus(); se.setSelectionRange(se.value.length, se.value.length); });
    await page.keyboard.type('\n\n## QzHeading\n\n"Quiet," said Qzoltan.');
    await new Promise(r => setTimeout(r, 200));
    const r = await page.evaluate(async () => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        const out = {};
        out.save = getMarkdownContent(false);
        out.exportHtml = new DOMParser().parseFromString(generateExportHtml(), 'text/html').body.textContent;
        try { const t = castScanTexts(); out.findCharacters = JSON.stringify(t.texts || t); } catch (e) { out.findCharacters = 'threw ' + e.message; }
        updateOutline(); await wait(100);
        out.outline = (document.getElementById('tab-outline') || {}).textContent || '';
        window.__sent.length = 0; (typeof updateStatsNow === 'function' ? updateStatsNow : updateStats)(); await wait(100);
        out.words = ((window.__sent.filter(m => m.startsWith('stats:')).pop() || '').slice(6).split(',')[0]) | 0;
        const se = sourceEditor; se.focus(); se.setSelectionRange(0, 0);
        window.__sent.length = 0; speakSelection(); await wait(300);
        out.readAloud = window.__sent.find(m => m.startsWith('host_tts_play:')) || '';
        stopReading();
        const prep = tzPreparePrint();
        out.print = (document.getElementById('tzPrintSource') || {}).textContent || ('no copy: ' + prep);
        window.dispatchEvent(new Event('afterprint'));
        DocumentModel.syncMountedToModel();
        out.modelAfterSync = DocumentModel.toMarkdown();
        return out;
    });
    const has = (s, w) => String(s || '').indexOf(w) >= 0;
    for (const [name, what] of [['Save', r.save], ['Export to HTML', r.exportHtml], ['Print / Export PDF', r.print], ['Read Aloud from the top', r.readAloud], ['the document model after a sync from the page', r.modelAfterSync]]) {
        ok(has(what, 'QzSameLine') && has(what, 'QzHeading') && has(what, 'Qzoltan'), name + ' has what was typed in Source', JSON.stringify(String(what).slice(-120)));
    }
    ok(has(r.findCharacters, 'Qzoltan'), 'Find characters reads the new quotation');
    ok(has(r.outline, 'QzHeading'), 'the outline shows the new heading');
    ok(r.words === 15, 'the word count counts the typed words (' + r.words + ')');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
