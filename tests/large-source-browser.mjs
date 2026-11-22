/**
 * Source mode on a LARGE document (2026-11-22). The same attack Preview had: on the 4,582-line
 * large-scroll-mixed.md, keys pressed for real -- Select All then type / paste; Shift+Ctrl+End /
 * Home then Delete; Ctrl+End, Enter, type; Ctrl+Home, type; Shift+PageDown x3 then type,
 * Backspace, paste; PageDown x25 and Down x400 then type; Bold and Heading 2 over hundreds of
 * lines; six edits all over the file, undone and redone; and an edit carried across a switch to
 * Preview and back. Each: the file is what the edit should make, and Undo gives it back.
 *
 *   node tests/large-source-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.TZ_ROOT || path.join(here, '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (180 s)'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }, 180000);
let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }
const TEXT = fs.readFileSync(path.join(here, 'large-scroll-mixed.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const O = TEXT.split('\n');
const posOfLine = (n) => O.slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0);   // 1-based line -> offset

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
    const ctrl = async (k, shift) => { await page.keyboard.down('Control'); if (shift) await page.keyboard.down('Shift'); await page.keyboard.press(k); if (shift) await page.keyboard.up('Shift'); await page.keyboard.up('Control'); };
    const undoAll = async (n = 8) => { for (let i = 0; i < n && (await doc()) !== TEXT; i++) { await ctrl('KeyZ'); await quiet(); } return (await doc()) === TEXT; };
    const paste = (s) => page.evaluate((s) => { const dt = new DataTransfer(); dt.setData('text/plain', s); (document.activeElement || document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, s);
    const load = async () => {
        await page.evaluate((t) => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); handleCommand('view_set:columns:1'); handleCommand('view_set:scroll:scroll'); loadMarkdownContent(t); HistoryManager.resetToCurrent(); handleCommand('view_set:mode:source'); }, TEXT);
        await page.waitForFunction(() => state.mode === 'source' && sourceEditor && sourceEditor.value.length > 1000, { timeout: 8000 });
        await quiet(); await quiet();
    };
    const caretAtLine = async (n, atEnd) => {
        const p = posOfLine(n) + (atEnd ? O[n - 1].length : 0);
        await page.evaluate((p) => { sourceEditor.focus(); sourceEditor.setSelectionRange(p, p); }, p); await quiet();
    };
    const L3000 = O.findIndex(l => l.indexOf('Line 3000 of') === 0) + 1;
    const L2002 = O.findIndex(l => l.indexOf('Line 2002 of') === 0) + 1;

    // Select All, type / paste.
    await load(); await caretAtLine(L3000); await ctrl('KeyA'); await quiet(); await page.keyboard.type('Z'); await quiet();
    ok((await doc()) === 'Z', 'Select All then a letter leaves just the letter');
    ok(await undoAll(), 'Undo gives the file back');
    await load(); await caretAtLine(L3000); await ctrl('KeyA'); await quiet(); await paste('PASTED one\nPASTED two'); await quiet();
    ok((await doc()) === 'PASTED one\nPASTED two', 'Select All then paste leaves just the paste (' + JSON.stringify((await doc()).slice(0, 30)) + ')');
    ok(await undoAll(), 'Undo gives the file back after pasting over everything');

    // Shift+Ctrl+End / Home, Delete.
    await load(); await caretAtLine(L3000); await ctrl('End', true); await quiet(); await page.keyboard.press('Delete'); await quiet();
    ok((await doc()) === O.slice(0, L3000 - 1).join('\n'), 'Shift+Ctrl+End then Delete removes from line 3000 to the end (' + (await doc()).split('\n').length + ' lines left)');
    ok(await undoAll(), 'Undo gives it back');
    await load(); await caretAtLine(L3000); await ctrl('Home', true); await quiet(); await page.keyboard.press('Delete'); await quiet();
    ok((await doc()) === O.slice(L3000 - 1).join('\n'), 'Shift+Ctrl+Home then Delete removes everything before line 3000');
    ok(await undoAll(), 'Undo gives it back');

    // Ctrl+End, Enter, type; Ctrl+Home, type.
    await load(); await caretAtLine(L3000); await ctrl('End'); await quiet(); await page.keyboard.press('Enter'); await page.keyboard.type('Z'); await quiet();
    ok((await doc()) === TEXT + '\nZ', 'Ctrl+End, Enter, a letter: a new last line');
    await load(); await caretAtLine(L3000); await ctrl('Home'); await quiet(); await page.keyboard.type('Z'); await quiet();
    ok((await doc()) === 'Z' + TEXT, 'Ctrl+Home then a letter: at the very start');

    // Shift+PageDown x3 from line 2002, then type / Backspace / paste.
    // Where PageDown stops depends on the scroll, so the selection is measured on every run.
    let sel = null;
    const selectBig = async () => { await load(); await caretAtLine(L2002); await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) { await page.keyboard.press('PageDown'); await quiet(); } await page.keyboard.up('Shift'); await quiet(); sel = await page.evaluate(() => ({ a: sourceEditor.selectionStart, b: sourceEditor.selectionEnd })); };
    const want = (rep) => TEXT.slice(0, sel.a) + rep + TEXT.slice(sel.b);
    await selectBig();
    ok(sel.b - sel.a > 500, 'Shift+PageDown x3 selects a long stretch (' + (sel.b - sel.a) + ' characters)');
    await page.keyboard.type('Z'); await quiet();
    ok((await doc()) === want('Z'), 'typing over it replaces exactly the selection');
    ok(await undoAll(), 'Undo gives it back');
    await selectBig(); await page.keyboard.press('Backspace'); await quiet();
    ok((await doc()) === want(''), 'Backspace over it removes exactly the selection');
    ok(await undoAll(), 'Undo gives it back');
    await selectBig(); await paste('PASTED one\nPASTED two'); await quiet();
    ok((await doc()) === want('PASTED one\nPASTED two'), 'paste over it replaces exactly the selection');
    ok(await undoAll(), 'Undo gives it back');

    // PageDown x25, Down x400, then type: the letter lands at the caret.
    for (const [name, key, n] of [['PageDown x25', 'PageDown', 25], ['Down x400', 'ArrowDown', 400]]) {
        await load(); await caretAtLine(L2002);
        for (let i = 0; i < n; i++) { await page.keyboard.press(key); if (i % 25 === 24) await quiet(); }
        await quiet();
        const p = await page.evaluate(() => sourceEditor.selectionStart);
        await page.keyboard.type('Q'); await quiet();
        ok(p > posOfLineEval(L2002) && (await doc()) === TEXT.slice(0, p) + 'Q' + TEXT.slice(p), name + ' then a letter: it lands at the caret (offset ' + p + ')');
    }
    function posOfLineEval(n) { return posOfLine(n); }

    // Bold and Heading 2 over hundreds of lines (as the Format menu sends them).
    for (const f of ['bold', 'h2']) {
        await selectBig();
        await page.evaluate((type) => { freezeFormatSelection(); applyFormatting(type); }, f); await quiet(); await quiet();
        const t = await doc();
        // A line made a heading loses its trailing spaces (they mean nothing at a heading's end).
        // A heading takes the place of a list marker, as a block format does.
        const strip = (s) => s.replace(/^(#{1,6} |> ?|[-*+] |\d+[.)] )+/gm, '').replace(/\*\*/g, '').replace(/[ \t]+$/gm, '');
        const A = strip(TEXT).split('\n'), B = strip(t).split('\n'); const bad = A.findIndex((l, i) => l !== B[i]);
        ok(t !== TEXT && t.slice(0, sel.a) === TEXT.slice(0, sel.a) && bad < 0 && A.length === B.length, f + ' over hundreds of lines: only marks change, nothing before it' + (bad >= 0 ? ' (line ' + (bad + 1) + ': ' + JSON.stringify(TEXT.split('\n')[bad]) + ' -> ' + JSON.stringify(t.split('\n')[bad]) + ')' : ''));
        ok(await undoAll(2), f + ': one or two Undo give the file back');
    }

    // Six edits all over the file, undone and redone.
    await load();
    const lines = [12, 700, L2002, 2600, 3400, 4300].map(n => O.findIndex((l, i) => i >= n - 1 && /^Line \d+ of/.test(l)) + 1);
    for (const n of lines) { await caretAtLine(n, true); await page.keyboard.type(' X'); await quiet(); }
    const edited = await doc();
    ok(edited.split(' X').length - 1 === 6, 'six edits all over the file all land');
    ok(await undoAll(40), 'Undo takes all six back');
    for (let i = 0; i < 40 && (await doc()) !== edited; i++) { await ctrl('KeyY'); await quiet(); }
    ok((await doc()) === edited, 'Redo puts all six back');

    // An edit in Source at line 4000, then Preview; an edit in Preview, then Source.
    await load(); const L4000 = O.findIndex(l => l.indexOf('Line 4000 of') === 0) + 1;
    await caretAtLine(L4000, true); await page.keyboard.type(' SRC'); await quiet();
    await page.evaluate(() => handleCommand('view_set:mode:preview')); await quiet(); await quiet();
    const inPreview = await page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''));
    ok(inPreview.split('\n')[L4000 - 1] === O[L4000 - 1] + ' SRC' && inPreview.split('\n').length === O.length, 'a Source edit at line 4000 is there in Preview, nothing else changed');
    await page.evaluate(() => handleCommand('view_set:mode:source')); await quiet(); await quiet();
    ok((await page.evaluate(() => sourceEditor.value.replace(/\n+$/, ''))) === inPreview, 'and back in Source, the same text');
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
