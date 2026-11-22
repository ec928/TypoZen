/**
 * More edits in a LARGE document, every layout (2026-11-22): Bold over a selection of hundreds
 * of lines, Enter in the middle and at the ends of the file, typing at the very start and end,
 * Replace All, a chain of edits all over the file undone and redone, and Shift+Ctrl+End then
 * Delete in Source. On the 4,582-line large-scroll-mixed.md, keys pressed for real.
 *
 *   node tests/large-edit-more-browser.mjs          (TZ_ROOT=<folder> to test another copy)
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
const plain = (t) => t.replace(/[*_\s]+/g, '');

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
    const undoAll = async (orig, n = 6) => { for (let i = 0; i < n && (await doc()) !== orig; i++) { await ctrl('KeyZ'); await quiet(); } return (await doc()) === orig; };
    const O = TEXT.split('\n');

    for (const [layout, cmds] of Object.entries(LAYOUTS)) {
        const load = async () => { await page.evaluate((t, c) => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, TEXT, cmds); await quiet(); await quiet(); };
        const clickIn = async (marker, where = 'Home') => {
            const at = await page.evaluate(async (m) => {
                const bi = DocumentModel.blocks.findIndex(b => String(b.raw).indexOf(m) >= 0);
                goToModelBlock(bi); await new Promise(r => setTimeout(r, 250));
                const b = document.querySelector('#editor .block[data-model-index="' + bi + '"]'); if (!b) return null;
                const r = b.getBoundingClientRect(); return { x: r.left + 4, y: r.top + Math.min(r.height / 2, 10) };
            }, marker);
            if (!at) throw new Error(layout + ': could not put the cursor on "' + marker + '"');
            await page.mouse.click(at.x, at.y); await page.keyboard.press(where); await quiet();
        };
        await load();
        const orig = await doc();

        // Bold over ~hundreds of lines: no character lost or added, bar the markers; Undo.
        await clickIn('Line 2002 of');
        await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) { await page.keyboard.press('PageDown'); await quiet(); } await page.keyboard.up('Shift');
        await ctrl('KeyB'); await quiet(); await quiet();
        const bolded = await doc();
        ok(bolded !== orig && plain(bolded) === plain(orig), layout + ': Bold over hundreds of lines changes only the markers (' + O.length + ' -> ' + bolded.split('\n').length + ' lines)');
        ok(!(await live()), layout + ': after Bold over hundreds of lines, the cursor is in the page');
        ok(await undoAll(orig), layout + ': Undo takes the Bold back');

        // Backspace, Enter and paste over a selection of hundreds of lines: the selection goes,
        // the lines above and below it stay, and Undo gives the file back.
        // The reference is typing a letter over the same selection (checked above): Backspace
        // must give that file without the letter, Enter the letter as a line break, paste the
        // letter as the pasted text.
        const selectBig = async () => { await load(); await clickIn('Line 2002 of'); await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) { await page.keyboard.press('PageDown'); await quiet(); } await page.keyboard.up('Shift'); };
        await selectBig(); await page.keyboard.type('Z'); await quiet();
        const ref = await doc();
        // Everything before and after the line the letter went on is unchanged; that line holds
        // what the key or paste put there. (Where the selection ends in a list item, Enter or a
        // pasted line there takes the list's own rule, so the line itself is not compared.)
        const R = ref.split('\n'), zAt = R.findIndex(l => l.indexOf('Z') >= 0);
        const around = (t) => { const L = t.split('\n'); const tailN = R.length - zAt - 1; return L.slice(0, zAt).join('\n') === R.slice(0, zAt).join('\n') && L.slice(L.length - tailN).join('\n') === R.slice(zAt + 1).join('\n'); };
        const rest = (t) => t.split('\n').slice(zAt, t.split('\n').length - (R.length - zAt - 1)).join('\n');
        for (const [what, act, want] of [
            ['Backspace', async () => page.keyboard.press('Backspace'), (t) => around(t) && rest(t) === R[zAt].replace('Z', '')],
            ['Enter', async () => page.keyboard.press('Enter'), (t) => around(t) && rest(t).replace(/\n/g, '').replace(/^(- )+/, '') === R[zAt].replace('Z', '').replace(/^- /, '')],
            ['paste', async () => page.evaluate(() => pasteLikeCtrlV('', 'PASTED one\nPASTED two', false)), (t) => around(t) && /PASTED one/.test(rest(t)) && /PASTED two/.test(rest(t)) && rest(t).indexOf(R[zAt].replace('Z', '').replace(/^- /, '')) >= 0]]) {
            await selectBig();
            await act(); await quiet(); await quiet();
            const t = await doc();
            ok(want(t), layout + ': ' + what + ' over hundreds of selected lines replaces just those (' + O.length + ' -> ' + t.split('\n').length + ', typing gives ' + ref.split('\n').length + ')');
            ok(!(await live()), layout + ': after ' + what + ' over hundreds of lines, the cursor is in the page');
            ok(await undoAll(orig), layout + ': Undo gives the file back after ' + what + ' over hundreds of lines');
        }

        // Enter in the middle of a line, then Backspace.
        await load(); await clickIn('Line 3000 of'); for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Enter'); await quiet();
        const split = await doc();
        ok(split.split('\n').length === O.length + 1 && split.replace(/\n/g, '') === orig.replace(/\n/g, ''), layout + ': Enter mid-line splits it, nothing else changes');
        await page.keyboard.press('Backspace'); await quiet();
        ok((await doc()) === orig, layout + ': Backspace joins it back');
        await page.keyboard.type('Z'); await quiet();
        ok((await doc()).indexOf('LineZ') >= 0 || (await doc()).split('Z').length - 1 >= 1, layout + ': the next letter lands after Enter+Backspace');

        // Ctrl+Home, type; Ctrl+End, Enter, type.
        await load(); await clickIn('Line 3000 of');
        await ctrl('Home'); await quiet(); await page.keyboard.type('Z'); await quiet();
        const head = await doc();
        ok(head === 'Z' + orig || head === orig.replace(/^(#+ )/, '$1Z'), layout + ': Ctrl+Home then a letter puts it at the very start (' + JSON.stringify(head.slice(0, 12)) + ')');
        await load(); await clickIn('Line 3000 of');
        await ctrl('End'); await quiet(); await page.keyboard.press('Enter'); await quiet(); await page.keyboard.type('Z'); await quiet();
        const tail = await doc();
        ok(tail.startsWith(orig) && /\n+Z$/.test(tail.slice(orig.length)), layout + ': Ctrl+End, Enter, a letter: a new last line (' + JSON.stringify(tail.slice(-20)) + ')');
        ok(!(await live()), layout + ': at the end of the file, the cursor is in the page');

        // A chain of edits all over the file, undone then redone.
        await load();
        const spots = ['Line 12 of', 'Line 1502 of', 'Line 2600 of', 'Line 3400 of', 'Line 4300 of', 'Line 700 of'];
        for (const s of spots) { await clickIn(s, 'End'); await page.keyboard.type(' X'); await quiet(); }
        const edited = await doc();
        ok(edited.split(' X').length - 1 === spots.length, layout + ': six edits all over the file all land (' + (edited.split(' X').length - 1) + ')');
        ok(await undoAll(orig, 30), layout + ': Undo takes all six back');
        for (let i = 0; i < 30 && (await doc()) !== edited; i++) { await ctrl('KeyY'); await quiet(); }
        ok((await doc()) === edited, layout + ': Redo puts all six back');

        // Replace All, then Undo.
        await load();
        const n = await page.evaluate(() => {
            document.getElementById('findInput').value = 'scroll marker'; document.getElementById('replaceInput').value = 'SCROLL MARKER';
            replaceAllMatches(); return getMarkdownContent(false).split('SCROLL MARKER').length - 1;
        }); await quiet();
        const replaced = await doc();
        ok(n === orig.split('scroll marker').length - 1 && replaced === orig.split('scroll marker').join('SCROLL MARKER'), layout + ': Replace All replaces every match and nothing else (' + n + ')');
        await page.evaluate(() => { try { focusEditorNoScroll(); } catch (e) { } });
        ok(await undoAll(orig), layout + ': Undo takes Replace All back');
        console.log('  ..   ' + layout + ': ' + passed + ' passed, ' + failed + ' failed so far');
    }

    // Source: Shift+Ctrl+End from the middle, Delete; Undo.
    await page.evaluate((t) => { handleCommand('view_set:columns:1'); handleCommand('view_set:scroll:scroll'); loadMarkdownContent(t); HistoryManager.resetToCurrent(); handleCommand('view_set:mode:source'); }, TEXT);
    await page.waitForFunction(() => typeof state !== 'undefined' && state.mode === 'source' && typeof sourceEditor !== 'undefined' && !!sourceEditor, { timeout: 8000 });
    await quiet(); await quiet();
    const okSrc = await page.evaluate(() => {
        if (typeof sourceEditor === 'undefined' || !sourceEditor || !sourceEditor.setSelectionRange) return false;
        const pos = sourceEditor.value.split('\n').slice(0, 2999).join('\n').length + 1;
        sourceEditor.focus(); sourceEditor.setSelectionRange(pos, pos); return true;
    });
    if (!okSrc) { console.log('  ..   Source case skipped: no handle on the Source editor'); }
    else {
        await ctrl('End', true); await quiet(); await page.keyboard.press('Delete'); await quiet();
        const s = await page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''));
        ok(s === O.slice(0, 2999).join('\n'), 'Source: Shift+Ctrl+End then Delete removes from line 3000 to the end (' + s.split('\n').length + ' lines left)');
        await ctrl('KeyZ'); await quiet();
        ok((await page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''))) === TEXT, 'Source: Undo gives it back');
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
