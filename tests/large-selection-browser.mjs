/**
 * Selections bigger than what is on screen, in a LARGE document, every layout (2026-11-22).
 *
 * In a long document Preview holds only a window of it; a selection can run far past that
 * window. On the 4,582-line large-scroll-mixed.md: Select All then type / Delete / cut and
 * paste back; Shift+PageDown over hundreds of lines from the middle, then type over it, or cut
 * it and paste it elsewhere; Shift+Ctrl+End from the middle, then Delete. For each: the file
 * is what the edit should make (no line lost or doubled), the cursor is still in the page, and
 * Undo gives the file back.
 *
 *   node tests/large-selection-browser.mjs          (TZ_ROOT=<folder> to test another copy)
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
const sortedLines = (t) => t.split('\n').filter(l => l.trim()).sort().join('\n');
// A selection made with Shift+PageDown ends mid-line, so a cut and paste moves part of a line:
// compare the characters, not whole lines -- every one still there, none doubled.
const sortedChars = (t) => t.replace(/\s+/g, '').split('').sort().join('');

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
    const live = () => page.evaluate(() => { const s = getSelection(); if (!s || !s.rangeCount || !s.anchorNode) return 'no selection'; return document.getElementById('editor').contains(s.anchorNode) ? '' : 'caret not in the page'; });
    const undoAll = async (orig) => { for (let i = 0; i < 6 && (await doc()) !== orig; i++) { await ctrl('KeyZ'); await quiet(); } return (await doc()) === orig; };

    for (const [layout, cmds] of Object.entries(LAYOUTS)) {
        const load = async () => { await page.evaluate((t, c) => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, TEXT, cmds); await quiet(); await quiet(); };
        const clickIn = async (marker) => {
            const at = await page.evaluate(async (m) => {
                const bi = DocumentModel.blocks.findIndex(b => String(b.raw).indexOf(m) >= 0);
                goToModelBlock(bi); await new Promise(r => setTimeout(r, 250));
                const b = document.querySelector('#editor .block[data-model-index="' + bi + '"]'); if (!b) return null;
                const r = b.getBoundingClientRect(); return { x: r.left + 4, y: r.top + Math.min(r.height / 2, 10) };
            }, marker);
            // A line that is not there is a broken test, not a pass: stop here.
            if (!at) throw new Error(layout + ': could not put the cursor on "' + marker + '"');
            await page.mouse.click(at.x, at.y); await page.keyboard.press('Home'); await quiet(); return true;
        };
        await load();
        const orig = await doc();

        // Select All, type.
        await clickIn('Line 2002 of'); await ctrl('KeyA'); await quiet();
        await page.keyboard.type('Z'); await quiet();
        ok((await doc()) === 'Z', layout + ': Select All then a letter leaves just that letter (' + JSON.stringify((await doc()).slice(0, 40)) + ')');
        ok(!(await live()), layout + ': after typing over everything, the cursor is in the page');
        ok(await undoAll(orig), layout + ': Undo gives the whole file back after typing over everything');

        // Select All, Delete.
        await load(); await clickIn('Line 2002 of'); await ctrl('KeyA'); await quiet();
        await page.keyboard.press('Delete'); await quiet();
        ok((await doc()).trim() === '', layout + ': Select All then Delete empties the document');
        ok(await undoAll(orig), layout + ': Undo gives the whole file back after deleting everything');

        // Select All, cut, paste back.
        await load(); await clickIn('Line 2002 of'); await ctrl('KeyA'); await quiet();
        const cutAll = await page.evaluate(() => tzMenuCopyOrCut(true)); await quiet();
        ok((await doc()).trim() === '', layout + ': Select All then Cut empties the document');
        await page.evaluate((c) => pasteLikeCtrlV(c.html || '', c.text || '', false), cutAll); await quiet(); await quiet();
        const back = await doc();
        ok(back === orig || sortedLines(back) === sortedLines(orig), layout + ': pasting it back gives every line back (' + back.split('\n').length + ' of ' + orig.split('\n').length + ' lines)');

        // Select All, paste: the paste is the document; one Undo gives the file back.
        await load(); await clickIn('Line 2002 of'); await ctrl('KeyA'); await quiet();
        await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'PASTED one\nPASTED two'); document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
        await quiet(); await quiet();
        const pastedAll = await doc();
        ok(pastedAll.replace(/\n+/g, '\n') === 'PASTED one\nPASTED two', layout + ': Select All then paste leaves just the pasted text (' + JSON.stringify(pastedAll.slice(0, 40)) + ')');
        ok(!(await live()), layout + ': after pasting over everything, the cursor is in the page');
        await ctrl('KeyZ'); await quiet();
        ok((await doc()) === orig, layout + ': one Undo gives the whole file back after pasting over everything');

        // Shift+PageDown x3 from the middle, type over it.
        await load(); await clickIn('Line 2002 of');
        await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) { await page.keyboard.press('PageDown'); await quiet(); } await page.keyboard.up('Shift');
        const selLines = await page.evaluate(() => String(getSelection().toString()).split('\n').length);
        await page.keyboard.type('Z'); await quiet();
        const typed = await doc();
        const T = typed.split('\n'), O = orig.split('\n');
        ok(typed.split('Z').length - 1 >= 1 && T.length < O.length && O.slice(0, O.findIndex(l => l.indexOf('Line 2002 of') >= 0)).join('\n') === T.slice(0, O.findIndex(l => l.indexOf('Line 2002 of') >= 0)).join('\n'),
            layout + ': typing over a selection of ~' + selLines + ' lines replaces just those (' + O.length + ' -> ' + T.length + ' lines), nothing above it changes');
        ok(!(await live()), layout + ': after typing over hundreds of lines, the cursor is in the page');
        ok(await undoAll(orig), layout + ': Undo gives the file back after typing over hundreds of lines');

        // Shift+PageDown x3, cut, paste further down: every line still there, once.
        await load(); await clickIn('Line 2002 of');
        await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) { await page.keyboard.press('PageDown'); await quiet(); } await page.keyboard.up('Shift');
        const cut = await page.evaluate(() => tzMenuCopyOrCut(true)); await quiet();
        const afterCut = await doc();
        ok(afterCut.split('\n').length < orig.split('\n').length && !(await live()), layout + ': Cut of hundreds of lines removes them and the cursor stays (' + orig.split('\n').length + ' -> ' + afterCut.split('\n').length + ')');
        await clickIn('Line 4000 of'); await quiet();
        await page.evaluate((c) => pasteLikeCtrlV(c.html || '', c.text || '', false), cut); await quiet(); await quiet();
        const moved = await doc();
        ok(sortedChars(moved) === sortedChars(orig), layout + ': pasted at line 4000, every character of the file is there exactly once (' + moved.split('\n').length + ' lines)');
        ok(await undoAll(orig), layout + ': Undo of cut and paste gives the file back');

        // Shift+Ctrl+Home from the middle, Delete: everything before the caret goes.
        await load(); await clickIn('Line 3000 of');
        await ctrl('Home', true); await quiet();
        await page.keyboard.press('Delete'); await quiet();
        const headCut = await doc();
        ok(headCut.startsWith('Line 3000 of') && headCut.split('\n').length === O.length - O.findIndex(l => l.indexOf('Line 3000 of') >= 0),
            layout + ': Shift+Ctrl+Home then Delete removes everything before the caret (' + headCut.split('\n').length + ' lines left, starts ' + JSON.stringify(headCut.slice(0, 20)) + ')');
        ok(await undoAll(orig), layout + ': Undo gives the file back after deleting to the start');

        // Shift+Ctrl+End from the middle, type: the rest of the file becomes the letter.
        await load(); await clickIn('Line 3000 of');
        await ctrl('End', true); await quiet();
        await page.keyboard.type('Z'); await quiet();
        const tailTyped = await doc();
        const cut3 = O.findIndex(l => l.indexOf('Line 3000 of') >= 0);
        ok(tailTyped.split('\n').length === cut3 + 1 && tailTyped.split('\n')[cut3] === 'Z' && tailTyped.split('\n').slice(0, cut3).join('\n') === O.slice(0, cut3).join('\n'),
            layout + ': Shift+Ctrl+End then a letter replaces the rest of the file with it');
        ok(await undoAll(orig), layout + ': Undo gives the file back after typing over the rest');

        // Shift+Ctrl+End from the middle, Delete.
        await load(); await clickIn('Line 3000 of');
        await ctrl('End', true); await quiet();
        await page.keyboard.press('Delete'); await quiet();
        const trunc = await doc();
        const cutAt = O.findIndex(l => l.indexOf('Line 3000 of') >= 0);
        ok(trunc.split('\n').length <= cutAt + 1 && trunc.split('\n').slice(0, cutAt).join('\n') === O.slice(0, cutAt).join('\n'), layout + ': Shift+Ctrl+End then Delete removes from the caret to the end, nothing before it (' + trunc.split('\n').length + ' lines left)');
        ok(!(await live()), layout + ': after deleting to the end, the cursor is in the page');
        ok(await undoAll(orig), layout + ': Undo gives the file back after deleting to the end');
        console.log('  ..   ' + layout + ': ' + passed + ' passed, ' + failed + ' failed so far');
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
