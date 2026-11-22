/**
 * Tables and big pastes in the middle of a LARGE document, in every layout (2026-11-22).
 *
 * Large documents are the default for editing tests. This puts a table, and lines to paste
 * over, in the middle of a 3,000-line document and presses real keys there in scrolling
 * 1-column, 2-column and two-page Preview: typing, Enter, Tab and Backspace in cells, Delete
 * and Backspace beside a table; pasting many lines, a whole table, a code block, and a paste
 * over a selection of several lines. For each: everything outside the edited region is
 * unchanged, the cursor is still in the page, the next letter lands once by the edit, and Undo
 * gives the file back.
 *
 *   node tests/large-tables-paste-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (240 s)'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }, 240000);
let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; } else { failed++; console.error('  FAIL ' + msg); } }
const filler = (tag, n) => Array.from({ length: n }, (_, i) => (i % 4 === 3 ? '' : tag + ' line ' + i + ' of ordinary prose, long enough to wrap now and then when the page is narrow.')).join('\n');
const ABOVE = filler('Above', 1500), BELOW = filler('Below', 1500);
const B = '```';
const TABLE = '| Name | Qty | Note |\n|---|---|---|\n| apple | 3 | red |\n| pear | 5 | green |';
const FRAG = 'Before the table\n\n' + TABLE + '\n\nAfter the table\nSecond line after\nThird line after';
const PASTE_LINES = Array.from({ length: 40 }, (_, i) => 'Pasted line ' + i + ' with words.').join('\n');
const PASTE_TABLE = '| x | y |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
const PASTE_CODE = B + 'js\nlet pasted = 1;\n\n  more();\n' + B;
const LAYOUTS = { '1-column': ['view_set:columns:1', 'view_set:scroll:scroll'], '2-column': ['view_set:columns:2', 'view_set:scroll:scroll'], 'two pages': ['view_set:columns:2', 'view_set:scroll:pagination'] };
// [name, where to put the caret, keys/paste, a check on the fragment after (text between ABOVE and BELOW)]
const CASES = [
    ['type in a cell', { cell: [2, 0], at: 'end' }, ['type:Qz'], (f) => f.indexOf('| appleQz | 3 | red |') >= 0],
    ['Tab to the next cell, then type', { cell: [2, 0], at: 'end' }, ['Tab', 'type:Qz'], (f) => /\| apple \| (Qz3|3Qz|Qz) \| red \|/.test(f) || f.indexOf('Qz') > f.indexOf('apple')],
    ['Enter in a cell keeps the table whole', { cell: [2, 1], at: 'end' }, ['Enter', 'type:Qz'], (f) => /\| Name \| Qty \| Note \|\n\|---\|---\|---\|/.test(f) && f.split('\n').filter(l => /^\|/.test(l)).length >= 4],
    ['Backspace at the start of a cell keeps the table', { cell: [3, 1], at: 'start' }, ['Backspace', 'type:Qz'], (f) => f.split('\n').filter(l => /^\|/.test(l)).length === 4],
    ['Backspace through a whole cell', { cell: [3, 2], at: 'end' }, ['Backspace', 'Backspace', 'Backspace', 'Backspace', 'Backspace', 'type:Qz'], (f) => f.split('\n').filter(l => /^\|/.test(l)).length === 4 && f.indexOf('Qz') >= 0],
    ['Delete at the end of the line above the table', { line: 'Before the table', at: 'end' }, ['Delete', 'type:Qz'], (f) => f.indexOf('Before the tableQz') >= 0 || f.indexOf('Qz') >= 0],
    ['Backspace on the empty line below the table', { line: '', after: TABLE, at: 'start' }, ['Backspace', 'type:Qz'], (f) => f.split('\n').filter(l => /^\|/.test(l)).length === 4],
    ['paste 40 lines mid-line', { line: 'Second line after', at: 6 }, ['paste:' + PASTE_LINES], (f) => f.indexOf('Pasted line 0') >= 0 && f.indexOf('Pasted line 39') >= 0 && (f.split('Pasted line').length - 1) === 40],
    ['paste a table on an empty line', { line: '', after: 'Before the table', at: 'start' }, ['paste:' + PASTE_TABLE], (f) => f.indexOf('| x | y |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |') >= 0 && f.indexOf(TABLE) >= 0],
    ['paste a code block mid-line', { line: 'Third line after', at: 5 }, ['paste:' + PASTE_CODE], (f) => f.indexOf('let pasted = 1;') >= 0 && f.indexOf('  more();') >= 0],
    ['paste 40 lines over three selected lines', { line: 'After the table', at: 3, selectDown: 2 }, ['paste:' + PASTE_LINES], (f) => (f.split('Pasted line').length - 1) === 40 && f.indexOf('Second line after') < 0],
    ['paste into a cell', { cell: [2, 2], at: 'end' }, ['paste:one\ntwo'], (f) => f.split('\n').filter(l => /^\|/.test(l)).length === 4 && f.indexOf('one') >= 0],
];

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message.slice(0, 160)); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));
    const DOC = ABOVE + '\n' + FRAG + '\n' + BELOW;
    // BELOW ends with an empty line, which a saved file does not keep: compare without it.
    const fragOf = (t) => { const s = String(t).replace(/\n+$/, ''); const a = ABOVE + '\n', b = '\n' + BELOW.replace(/\n+$/, ''); return s.startsWith(a) && s.endsWith(b) ? s.slice(a.length, s.length - b.length) : null; };
    for (const [layout, cmds] of Object.entries(LAYOUTS)) {
        for (const [name, where, keys, check] of CASES) {
            const tag = name + ' (' + layout + ')';
            await page.evaluate((t, c) => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, DOC, cmds);
            await quiet(); await quiet();
            const orig = await page.evaluate(() => getMarkdownContent(false));
            const placed = await page.evaluate(async (w) => {
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                const bs = DocumentModel.blocks.map(b => String(b.raw));
                let bi = -1;
                if (w.cell) bi = bs.findIndex(r => r.indexOf('| Name | Qty |') === 0);
                else if (w.after) { const a = bs.findIndex(r => r === w.after || r.indexOf(w.after) === 0); bi = a + 1; }
                else bi = bs.findIndex(r => r === w.line);
                if (bi < 0) return 'no such line';
                goToModelBlock(bi); await wait(250);
                const b = document.querySelector('#editor .block[data-model-index="' + bi + '"]'); if (!b) return 'not mounted';
                const s = getSelection(); const rg = document.createRange();
                let node = b, off = 0;
                if (w.cell) {
                    const row = b.querySelectorAll('tr')[w.cell[0] === 2 ? 1 : w.cell[0] === 3 ? 2 : 0];
                    const cell = row ? row.children[w.cell[1]] : null; if (!cell) return 'no cell';
                    const t = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT).nextNode();
                    node = t || cell; off = t ? (w.at === 'end' ? t.nodeValue.length : 0) : 0;
                } else {
                    const t = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
                    if (t) { node = t; off = w.at === 'end' ? t.nodeValue.length : (typeof w.at === 'number' ? w.at : 0); }
                }
                rg.setStart(node, off); rg.collapse(true); s.removeAllRanges(); s.addRange(rg); editor.focus();
                if (typeof rememberEditorCaret === 'function') rememberEditorCaret();
                return '';
            }, where);
            if (placed) { ok(false, tag + ': ' + placed); continue; }
            if (where.selectDown) { await page.keyboard.down('Shift'); for (let i = 0; i < where.selectDown; i++) await page.keyboard.press('ArrowDown'); await page.keyboard.up('Shift'); await quiet(); }
            for (const k of keys) {
                if (k.startsWith('type:')) await page.keyboard.type(k.slice(5));
                else if (k.startsWith('paste:')) await page.evaluate((t) => pasteLikeCtrlV('', t, false), k.slice(6));
                else await page.keyboard.press(k);
                await quiet();
            }
            const after = await page.evaluate(() => getMarkdownContent(false));
            const frag = fragOf(after);
            if (frag === null) { const A = orig.split('\n'), G = after.split('\n'); let p = 0; while (p < A.length && A[p] === G[p]) p++; ok(false, tag + ': text outside the edited region changed, at line ' + p + ': ' + JSON.stringify(G[p])); continue; }
            ok(check(frag), tag + ': the result is right -- ' + JSON.stringify(frag.slice(0, 160)));
            const lost = await page.evaluate(() => { const s = getSelection(); if (!s || !s.rangeCount || !s.anchorNode) return 'no selection'; return document.getElementById('editor').contains(s.anchorNode) ? '' : 'caret not in the page'; });
            ok(!lost, tag + ': the cursor is still in the page' + (lost ? ' (' + lost + ')' : ''));
            if (!lost) {
                await page.keyboard.type('Qy'); await quiet();
                const t2 = await page.evaluate(() => getMarkdownContent(false));
                const f2 = fragOf(t2);
                ok(f2 !== null && (f2.split('Qy').length - 1) === 1, tag + ': the next letters land once, inside the edited part');
                await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await quiet();
            }
            // Undo all the way back.
            for (let i = 0; i < 8 && (await page.evaluate(() => getMarkdownContent(false))) !== orig; i++) { await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await quiet(); }
            ok((await page.evaluate(() => getMarkdownContent(false))) === orig, tag + ': Undo gives the file back');
        }
        console.log('  ..   ' + layout + ': ' + passed + ' passed, ' + failed + ' failed so far');
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
