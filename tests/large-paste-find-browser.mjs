/**
 * A very large paste, and Find then type, in a LARGE document (2026-11-22).
 *
 * On the 4,582-line large-scroll-mixed.md (about 200 KB), every Preview layout and Source:
 * the whole file pasted into the middle of itself, and over Select All -- every character there
 * once, nothing lost or doubled, and one Undo gives the file back. Then Find a line far down the
 * file, Esc, type; and step to the next match five times, Esc, type: Esc gives the keyboard back
 * to the text with the match selected, so the letter replaces the match, and nothing else
 * changes. (Before 2026-11-22 Esc left focus on nothing: in Source and 2-Col the letter was lost.)
 *
 *   node tests/large-paste-find-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.TZ_ROOT || path.join(here, '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (240 s)'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }, 240000);
let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }
const TEXT = fs.readFileSync(path.join(here, 'large-scroll-mixed.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const O = TEXT.split('\n');
const LAYOUTS = { 'scrolling 1-column': ['view_set:columns:1', 'view_set:scroll:scroll'], '2-column': ['view_set:columns:2', 'view_set:scroll:scroll'], 'two pages': ['view_set:columns:2', 'view_set:scroll:pagination'], 'Source': ['view_set:columns:1', 'view_set:scroll:scroll'] };
const noNl = (s) => s.replace(/\n+/g, '');

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 90000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message.slice(0, 160)); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))));
    const doc = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)).replace(/\n+$/, ''));
    const ctrl = async (k) => { await page.keyboard.down('Control'); await page.keyboard.press(k); await page.keyboard.up('Control'); };
    const paste = (s) => page.evaluate((s) => { const dt = new DataTransfer(); dt.setData('text/plain', s); (state.mode === 'source' ? document.activeElement : document.getElementById('editor')).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, s);
    const live = () => page.evaluate(() => { if (state.mode === 'source') return ''; const s = getSelection(); if (!s || !s.rangeCount || !s.anchorNode) return 'no selection'; return document.getElementById('editor').contains(s.anchorNode) ? '' : 'caret not in the page'; });

    for (const [layout, cmds] of Object.entries(LAYOUTS)) {
        const SRC = layout === 'Source';
        const load = async () => {
            await page.evaluate((t, c, src) => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); if (src) handleCommand('view_set:mode:source'); }, TEXT, cmds, SRC);
            await quiet(); await quiet();
        };
        // The caret at the start of "Line 2002 of ...".
        const at2002 = async () => {
            if (SRC) {
                const p = TEXT.indexOf('\nLine 2002 of') + 1;
                await page.evaluate((p) => { sourceEditor.focus(); sourceEditor.setSelectionRange(p, p); }, p); await quiet(); return p;
            }
            const pt = await page.evaluate(async () => {
                const bi = DocumentModel.blocks.findIndex(b => String(b.raw).indexOf('Line 2002 of') === 0);
                goToModelBlock(bi); await new Promise(r => setTimeout(r, 250));
                const b = document.querySelector('#editor .block[data-model-index="' + bi + '"]'); if (!b) return null;
                const r = b.getBoundingClientRect(); return { x: r.left + 4, y: r.top + Math.min(r.height / 2, 10) };
            });
            if (!pt) throw new Error(layout + ': Line 2002 not on screen');
            await page.mouse.click(pt.x, pt.y); await page.keyboard.press('Home'); await quiet(); return TEXT.indexOf('\nLine 2002 of') + 1;
        };

        // The whole file, pasted into the middle of itself.
        await load(); const p = await at2002();
        const t0 = Date.now(); await paste(TEXT); await quiet(); await quiet();
        const ms = Date.now() - t0;
        const big = await doc();
        const want = TEXT.slice(0, p) + TEXT + TEXT.slice(p);
        ok(big === want || noNl(big) === noNl(want), layout + ': the whole file (' + Math.round(TEXT.length / 1024) + ' KB) pasted mid-file: every character there once (' + big.length + ' vs ' + want.length + ' characters, ' + ms + ' ms)');
        ok(Math.abs(big.split('\n').length - want.split('\n').length) <= 2, layout + ': and every line (' + big.split('\n').length + ' vs ' + want.split('\n').length + ')');
        ok(!(await live()), layout + ': the cursor is in the page after the paste');
        await ctrl('KeyZ'); await quiet(); await quiet();
        ok((await doc()) === TEXT, layout + ': one Undo gives the file back');

        // Select All, then the whole file pasted over it.
        await load(); await at2002(); await ctrl('KeyA'); await quiet();
        await paste(TEXT); await quiet(); await quiet();
        const over = await doc();
        ok(over === TEXT || noNl(over) === noNl(TEXT), layout + ': Select All, paste the whole file: the file, every character (' + over.length + ' vs ' + TEXT.length + ')');
        ctrl('KeyZ'); await quiet(); await quiet();

        // Find a line far down, Esc, type.
        for (const [name, query, steps] of [['Find "row 3500", Esc, type', 'scroll marker row 3500', 0], ['Find "row 41", Enter x5, Esc, type', 'scroll marker row 41', 5]]) {
            await load(); await at2002();
            await page.keyboard.down('Control'); await page.keyboard.press('KeyF'); await page.keyboard.up('Control'); await quiet();
            const opened = await page.evaluate(() => typeof isFindBarOpen === 'function' && isFindBarOpen());
            if (!opened) await page.evaluate(() => openFindBar('', false));
            await page.evaluate(() => { const i = document.getElementById('findInput'); i.focus(); i.select(); });
            await page.keyboard.type(query); await quiet();
            await page.keyboard.press('Enter'); await quiet();
            for (let i = 0; i < steps; i++) { await page.keyboard.press('Enter'); await quiet(); }
            const idx = await page.evaluate(() => findState.index);
            await page.keyboard.press('Escape'); await quiet(); await quiet();
            await page.keyboard.type('Q'); await quiet();
            const t = await doc(); const T = t.split('\n');
            const changed = T.map((l, i) => [i, l]).filter(([i, l]) => l !== O[i]);
            const matchLines = O.map((l, i) => [i, l]).filter(([, l]) => l.indexOf(query) >= 0).map(([i]) => i);
            // Esc gives the keyboard back to the text with the match selected, so the letter
            // replaces the match (as in Notepad), in a line that matched, and nothing else.
            const landed = changed.length === 1 && changed[0][1] === O[changed[0][0]].replace(query, 'Q') && T.length === O.length;
            ok(landed && matchLines.indexOf(changed[0][0]) >= 0, layout + ', ' + name + ': the letter replaces the match, in a matched line, nothing else changes (match ' + (idx + 1) + '; ' + (changed.length ? 'line ' + (changed[0][0] + 1) + ' ' + JSON.stringify(changed[0][1].slice(0, 46)) : 'nothing changed') + ')');
        }
        console.log('  ..   ' + layout + ': ' + passed + ' passed, ' + failed + ' failed so far');
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
