/**
 * Typing over a selection undoes in one step, whether it spans one line or several
 * (2026-11-22).
 *
 * Over a selection across lines in Preview, the first letter replaced the selection as one
 * undo step and the rest of the word became a second, so Ctrl+Z left the first letter
 * where the selection had been and only a second Ctrl+Z brought the lines back. One line,
 * and Source either way, always took one step. Found by a sweep of real long files.
 *
 *   node tests/undo-typing-over-lines-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++; console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))));
    const doc = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)).replace(/\n+$/, ''));
    const ctrl = async (k) => { await page.keyboard.down('Control'); await page.keyboard.press(k); await page.keyboard.up('Control'); };
    const DOC = 'First line here\nSecond line here\nThird line here';
    for (const mode of ['wysiwyg', 'source']) for (const span of ['one line', 'two lines']) {
        await page.evaluate((m, d) => { setSourceDocExt('md'); handleCommand('view_set:mode:' + m); loadMarkdownContent(d); HistoryManager.resetToCurrent(); }, mode, DOC);
        await quiet();
        if (mode === 'source') await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(6, 6); });
        else {
            const r = await page.evaluate(() => { const b = document.querySelector('#editor .block[data-model-index="0"]').getBoundingClientRect(); return { x: b.left + 3, y: b.top + b.height / 2 }; });
            await page.mouse.click(r.x, r.y); await page.keyboard.press('Home');
            for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
        }
        await page.keyboard.down('Shift');
        if (span === 'one line') { for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight'); } else await page.keyboard.press('ArrowDown');
        await page.keyboard.up('Shift');
        await page.keyboard.type('Qzx'); await quiet();
        const after = await doc();
        const label = (mode === 'source' ? 'Source' : 'Preview') + ', ' + span;
        same(label + ': the word replaced the selection', after.split('\n')[0], span === 'one line' ? 'First Qzx here' : 'First Qzxnd line here');
        await ctrl('KeyZ'); await quiet();
        same(label + ': one Ctrl+Z gives the text back', await doc(), DOC);
        await ctrl('KeyY'); await quiet();
        same(label + ': and Ctrl+Y the whole word', await doc(), after);
    }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
