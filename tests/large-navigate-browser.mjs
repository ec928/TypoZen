/**
 * Moving the caret across the edge of what is mounted, in a LARGE document, every layout
 * (2026-11-22). Preview holds a window of a long file and rebuilds it as the view moves; the
 * caret must survive that. From the middle of the 4,582-line large-scroll-mixed.md: Down x400,
 * Up x400, PageDown x25, PageUp x25, Ctrl+Down x60 -- then a letter. The caret must still be in
 * the page, the letter must land once, on the line the caret was on, and nowhere else.
 *
 *   node tests/large-navigate-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.TZ_ROOT || path.join(here, '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (240 s)'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }, 240000);
let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; } else { failed++; console.error('  FAIL ' + msg); } }
const TEXT = fs.readFileSync(path.join(here, 'large-scroll-mixed.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const LAYOUTS = { '1-column': ['view_set:columns:1', 'view_set:scroll:scroll'], '2-column': ['view_set:columns:2', 'view_set:scroll:scroll'], 'two pages': ['view_set:columns:2', 'view_set:scroll:pagination'] };
const MOVES = [['Down x400', 'ArrowDown', 400, false], ['Up x400', 'ArrowUp', 400, false], ['PageDown x25', 'PageDown', 25, false], ['PageUp x25', 'PageUp', 25, false], ['Ctrl+Down x60', 'ArrowDown', 60, true]];

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message.slice(0, 160)); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))));
    const doc = () => page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''));
    // Where the caret is, as the block's model line and its text.
    const caretAt = () => page.evaluate(() => {
        const s = getSelection();
        if (!s || !s.rangeCount || !s.anchorNode || !document.getElementById('editor').contains(s.anchorNode)) return null;
        const b = getAncestorBlock(s.anchorNode); if (!b) return null;
        const mi = DocumentModel.modelIndexOfEl(b);
        return { mi, raw: mi >= 0 ? String(DocumentModel.blocks[mi].raw) : null };
    });
    const O = TEXT.split('\n');

    for (const [layout, cmds] of Object.entries(LAYOUTS)) {
        for (const [name, key, times, withCtrl] of MOVES) {
            await page.evaluate((t, c) => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, TEXT, cmds);
            await quiet(); await quiet();
            const at = await page.evaluate(async () => {
                const bi = DocumentModel.blocks.findIndex(b => String(b.raw).indexOf('Line 2400 of') >= 0);
                goToModelBlock(bi); await new Promise(r => setTimeout(r, 250));
                const b = document.querySelector('#editor .block[data-model-index="' + bi + '"]'); if (!b) return null;
                const r = b.getBoundingClientRect(); return { x: r.left + 4, y: r.top + Math.min(r.height / 2, 10) };
            });
            if (!at) throw new Error(layout + ': could not put the cursor on Line 2400');
            await page.mouse.click(at.x, at.y); await quiet();
            if (withCtrl) await page.keyboard.down('Control');
            for (let i = 0; i < times; i++) { await page.keyboard.press(key); if (i % 20 === 19) await quiet(); }
            if (withCtrl) await page.keyboard.up('Control');
            await quiet(); await quiet();
            const before = await caretAt();
            // PageUp / PageDown only scroll and leave the caret where it was (docs/for-agents.md,
            // keyboard matrix): the letter belongs on the line the caret started on.
            const paging = key === 'PageDown' || key === 'PageUp';
            if (!paging) {
                ok(!!before, layout + ', ' + name + ': the caret is still in the page');
                if (!before) continue;
                ok(before.raw.indexOf('Line 2400 of') < 0, layout + ', ' + name + ': the caret moved (now model line ' + before.mi + ')');
            }
            await page.keyboard.type('Q'); await quiet();
            const t = await doc();
            const added = t.split('Q').length - TEXT.split('Q').length;
            if (paging) {
                const L = t.split('\n'); const qi = L.findIndex(l => l.indexOf('Q') >= 0);
                ok(added === 1 && qi >= 0 && L[qi].replace('Q', '') === O.find(l => l.indexOf('Line 2400 of') >= 0), layout + ', ' + name + ': the caret stays where it was and the letter lands there (' + added + ' added, on ' + JSON.stringify(qi >= 0 ? L[qi].slice(0, 28) : null) + ')');
                ok(!!(await caretAt()),layout + ', ' + name + ': after typing, the caret is in the page');
                continue;
            }
            const after = await page.evaluate((mi) => String(DocumentModel.blocks[mi] && DocumentModel.blocks[mi].raw), before.mi);
            ok(added === 1 && after.indexOf('Q') >= 0 && after.replace('Q', '') === before.raw, layout + ', ' + name + ': the letter lands once, on the line the caret was on (' + added + ' added; line ' + before.mi + ' ' + JSON.stringify(after.slice(0, 30)) + ')');
        }
        console.log('  ..   ' + layout + ': ' + passed + ' passed, ' + failed + ' failed so far');
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
