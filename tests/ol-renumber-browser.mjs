/**
 * When a numbered item stops being one, the numbers below it close the gap (2026-11-22).
 *
 * Backspace at the start of "2. b" in "1. a / 2. b / 3. c" makes it plain text; "3. c" stayed
 * 3, so the list below read 3 after 1. The items below now go on from the nearest numbered
 * item above at their level (or from 1). Inserting an item already renumbered
 * (renumberOrderedListAfter); this is the other direction. Preview, by keys.
 *
 *   node tests/ol-renumber-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { padPage, LARGE } from './large-pad.mjs';

const appDir = process.env.TZ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++;
    console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await padPage(page);   // cases in a long file first (large-pad.mjs)
    await page.setViewport({ width: 1100, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));
    const md = () => page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''));
    const key = async (k, ctrl) => { if (ctrl) await page.keyboard.down('Control'); await page.keyboard.press(k); if (ctrl) await page.keyboard.up('Control'); await quiet(); };
    // Preview holding `doc`, the caret at the start of line `li`'s text, by a click and Home.
    const startOf = async (doc, li) => {
        await page.evaluate((d) => { setSourceDocExt('md'); handleCommand('view_set:mode:wysiwyg'); loadMarkdownContent(d); }, doc);
        await quiet();
        const b = await page.evaluate((l) => { const r = document.querySelector('#editor .block[data-model-index="' + l + '"]').getBoundingClientRect(); return { x: r.right - 20, y: r.top + r.height / 2 }; }, li);
        await page.mouse.click(b.x, b.y);
        await key('Home');
    };

    const ABC = '1. a\n2. b\n3. c\n4. d';
    console.log('\n=== Backspace at the start of a numbered item ===');
    await startOf(ABC, 1); await key('Backspace');
    same('a middle item: the ones below close the gap', await md(), '1. a\nb\n2. c\n3. d');
    await key('KeyZ', true);
    same('Ctrl+Z puts the list back as it was', await md(), ABC);
    await startOf(ABC, 0); await key('Backspace');
    same('the first item: the ones below start from 1', await md(), 'a\n1. b\n2. c\n3. d');
    await startOf(ABC, 3); await key('Backspace');
    same('the last item: nothing below to change', await md(), '1. a\n2. b\n3. c\nd');
    await startOf('1. first\n2. second', 0); await key('Enter'); await key('Backspace');
    same('Enter then Backspace at the start of the first item (the case it was found by)', await md(), '1. \nfirst\n2. second');

    console.log('\n=== what it leaves alone ===');
    await startOf('1. a\n   1. x\n   2. y\n2. b', 1); await key('Backspace');
    same('a nested numbered item moves out a level: it takes the next number there, the rest follow', await md(), '1. a\n2. x\n   1. y\n3. b');
    await startOf('- a\n- b\n- c', 1); await key('Backspace');
    same('a bulleted list has no numbers to change', await md(), '- a\nb\n- c');
    await startOf('1. a\n2. b\n\nAfter\n\n5. later', 1); await key('Backspace');
    same('the list ends at the blank line; a later list keeps its own numbers', await md(), '1. a\nb\n\nAfter\n\n5. later');

    console.log('\n=== Format > Normal Text on a numbered item ===');
    await startOf(ABC, 1);
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('para'); });
    await quiet();
    same('Normal Text: the ones below close the gap too', await md(), '1. a\nb\n2. c\n3. d');
    await key('KeyZ', true);
    same('Ctrl+Z after Normal Text puts the list back', await md(), ABC);

    console.log('\n=== the same in Source ===');
    await page.evaluate((d) => { setSourceDocExt('md'); handleCommand('view_set:mode:source'); loadMarkdownContent(d); }, ABC);
    await quiet();
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(9, 9); applyFormatting('para'); });
    await quiet();
    same('Source Normal Text on "2. b": the ones below close the gap', await page.evaluate(() => sourceEditor.value), '1. a\nb\n2. c\n3. d');
    same('and the caret is still in "b", where it was', await page.evaluate(() => sourceEditor.selectionStart), 6);
    await key('KeyZ', true);
    same('Ctrl+Z puts the Source list back', await page.evaluate(() => sourceEditor.value), ABC);
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
