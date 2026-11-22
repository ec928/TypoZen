/**
 * Delete, Backspace and typing in the middle of a LONG file, in the real app (2026-11-22).
 *
 * The headless suites run the page in Chrome; this is the WebView in TypoZen.exe. In scrolling
 * Preview of a long file, Delete or Backspace on an empty line (or at a line's ends) left no
 * caret at all and the next letter went nowhere; text typed on a rule line was shown and
 * dropped on save. Each key is pressed for real at a line in the middle of a 3,000-line file,
 * in scrolling 1-column and two-page Preview; the caret must stay in the page, the next letter
 * must land once where it should, and the file on disk must hold it after a save.
 *
 *   RUN_APP_E2E=1 node tests/large-edit-keys-app.mjs     (~40 s, hidden desktop)
 */
import fs from 'fs';
import { execFileSync } from 'child_process';
import { launchApp, profileFile, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }
const deadline = setTimeout(() => { console.error('  FAIL over budget (180 s)'); process.exit(1); }, 180000);
let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }

const lines = [];
for (let i = 0; i < 3000; i++) lines.push(i % 3 === 2 ? '' : 'Line ' + i + ' of an ordinary paragraph of prose.');
lines.splice(1500, 0, 'Before the rule', '---', 'After the rule');
const BASE = lines.join('\n') + '\n';
const doc = profileFile('large-edit-keys.md');

let app;
try {
    fs.writeFileSync(doc, BASE);
    app = await launchApp({ file: doc, settleMs: 8000 });
    const page = await app.surface();
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))));
    const caretLive = () => page.evaluate(() => {
        const s = getSelection();
        if (!s || !s.rangeCount || !s.anchorNode) return 'no selection';
        return document.getElementById('editor').contains(s.anchorNode) ? '' : 'caret not in the page';
    });
    const clickLine = async (li) => {
        const at = await page.evaluate(async (i) => {
            goToModelBlock(i); await new Promise(r => setTimeout(r, 250));
            const b = document.querySelector('#editor .block[data-model-index="' + i + '"]'); if (!b) return null;
            const r = b.getBoundingClientRect(); return { x: r.left + 4, y: r.top + Math.max(4, Math.min(r.height / 2, 10)) };
        }, li);
        if (!at) return false;
        await page.bringToFront().catch(() => { });
        await page.mouse.click(at.x, at.y); await quiet();
        return true;
    };
    const reset = async (cmds) => {
        await page.evaluate((c) => { handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); }, cmds);
        await page.evaluate((t) => { loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, BASE);
        await quiet(); await quiet();
    };
    const CASES = [
        // [name, model index to click, keys before typing, what the text after must hold]
        ['Delete on an empty line', 1202, ['Delete'], (t) => /Line 1201 of an ordinary paragraph of prose\.\nZLine 1203 of/.test(t)],
        ['Backspace on an empty line', 1202, ['Backspace'], (t) => /Line 1201 of an ordinary paragraph of prose\.Z\nLine 1203 of/.test(t)],
        ['Delete at the end of a line', 1201, ['End', 'Delete'], (t) => /Line 1201 of an ordinary paragraph of prose\.Z\nLine 1203/.test(t)],
        ['Backspace at the start of a line', 1203, ['Home', 'Backspace'], (t) => /\nZLine 1203 of/.test(t) || /prose\.ZLine 1203/.test(t)],
        ['Down onto a rule', 1500, ['End', 'ArrowDown'], (t) => /Before the rule\n---\nZAfter the rule/.test(t)],
    ];
    for (const [layout, cmds] of [['scrolling 1-column', ['view_set:columns:1', 'view_set:scroll:scroll']], ['two pages', ['view_set:columns:2', 'view_set:scroll:pagination']]]) {
        for (const [name, li, keys, holds] of CASES) {
            await reset(cmds);
            if (!(await clickLine(li))) { ok(false, layout + ', ' + name + ': the line was not on screen'); continue; }
            for (const k of keys) { await page.keyboard.press(k); await quiet(); }
            const lost = await caretLive();
            ok(!lost, layout + ', ' + name + ': the caret is still in the page' + (lost ? ' (' + lost + ')' : ''));
            await page.keyboard.type('Z'); await quiet();
            const t = await page.evaluate(() => getMarkdownContent(false));
            ok(holds(t) && t.split('Z').length - 1 === 1, layout + ', ' + name + ': the next letter lands once, where it should');
        }
    }
    // Selections past the window, in the real WebView: Ctrl+A then a letter; Shift+Ctrl+End
    // from the middle then Delete (2026-11-22: the letter was dropped; Delete removed nothing
    // or one chunk).
    for (const [layout, cmds] of [['scrolling 1-column', ['view_set:columns:1', 'view_set:scroll:scroll']], ['two pages', ['view_set:columns:2', 'view_set:scroll:pagination']]]) {
        await reset(cmds);
        if (await clickLine(1201)) {
            await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await quiet();
            await page.keyboard.type('Z'); await quiet();
            const t = (await page.evaluate(() => getMarkdownContent(false))).replace(/\n+$/, '');
            ok(t === 'Z', layout + ', Ctrl+A then a letter: the document is that letter (' + t.length + ' characters)');
        }
        await reset(cmds);
        if (await clickLine(2000)) {
            await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await quiet();
            await page.keyboard.press('Delete'); await quiet();
            const t = await page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''));
            ok(t.split('\n').length <= 2003 && t.indexOf('Line 2998') < 0, layout + ', Shift+Ctrl+End then Delete removes the rest of the file (' + t.split('\n').length + ' lines left)');
        }
        // Ctrl+End, Enter, a letter: a new last line. Ctrl+Home, a letter: the very start.
        // (2026-11-22: the caret was lost; the letter went nowhere, or back to the old line.)
        await reset(cmds);
        if (await clickLine(2000)) {
            await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control'); await quiet(); await quiet();
            await page.keyboard.press('Enter'); await quiet(); await page.keyboard.type('Z'); await quiet();
            const t = (await page.evaluate(() => getMarkdownContent(false))).replace(/\n+$/, '');
            ok(t.startsWith(BASE.replace(/\n+$/, '')) && /\n+Z$/.test(t), layout + ', Ctrl+End, Enter, a letter: a new last line (' + JSON.stringify(t.slice(-12)) + ')');
        }
        await reset(cmds);
        if (await clickLine(2000)) {
            await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control'); await quiet(); await quiet();
            await page.keyboard.type('Z'); await quiet();
            const t = await page.evaluate(() => getMarkdownContent(false));
            ok(t.startsWith('ZLine 0 of') && t.split('Z').length - 1 === 1, layout + ', Ctrl+Home then a letter: at the very start (' + JSON.stringify(t.slice(0, 12)) + ')');
        }
        // Select All, then a real Ctrl+V of what is on the clipboard: the paste is the document.
        await reset(cmds);
        if (await clickLine(1201)) {
            execFileSync('powershell.exe', ['-NoProfile', '-Command', "Set-Clipboard -Value 'PASTED one'"]);
            await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await quiet();
            await page.keyboard.down('Control'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control'); await sleep(600); await quiet();
            const t = (await page.evaluate(() => getMarkdownContent(false))).replace(/\n+$/, '');
            ok(t === 'PASTED one', layout + ', Select All then Ctrl+V: the document is what was pasted (' + JSON.stringify(t.slice(0, 30)) + ')');
        }
    }
    await reset(['view_set:columns:1', 'view_set:scroll:scroll']);
    if (await clickLine(1500)) { await page.keyboard.press('End'); await page.keyboard.press('ArrowDown'); await quiet(); await page.keyboard.type('Z'); await quiet(); }

    // What is on the page is what is saved: the last case's Z, on disk.
    await page.evaluate(() => postMsg('debug_save')); await sleep(1500);
    const disk = fs.readFileSync(doc, 'utf8').replace(/\r\n/g, '\n');
    ok(/Before the rule\n---\nZAfter the rule/.test(disk), 'saved: the letter typed after stepping off the rule is in the file on disk');
} finally {
    try { if (app) await app.close(); } catch (e) { }
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
