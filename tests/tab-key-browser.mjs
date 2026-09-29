/**
 * Tab types a tab, in ordinary text, as it does in Notepad.
 *
 * Tab only ever indented list items: in a plain paragraph Preview swallowed the key, and
 * in Source CodeMirror had no Tab binding, so the browser moved focus out of the editor
 * and the next letters typed went nowhere (Ed, 2026-09-30: "tab doesn't work"). The only
 * tests that pressed Tab did it in list items. This one presses the real key in plain
 * text -- never calls the handler -- and checks what is saved, not just what is shown.
 *
 *   node tests/tab-key-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { sleep } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAB = '\t';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    const md = () => page.evaluate(() => getMarkdownContent(false));
    const shiftTab = async () => { await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); };
    const inEditor = () => page.evaluate(() => {
        const a = document.activeElement;
        return !!a && (a === editor || editor.contains(a) || !!(a.closest && a.closest('.cm-editor')));
    });

    console.log('=== Preview: a plain paragraph ===');
    await page.evaluate(() => loadMarkdownContent('123456\n\n123456\n\nlast line'));
    await sleep(600);
    const pt = await page.evaluate(() => {
        const el = editor.querySelector('.block[data-model-index="2"]');
        const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(tn, 3); r.setEnd(tn, 3);
        const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
    });
    await page.mouse.click(pt.x, pt.y);
    await sleep(200);
    await page.keyboard.press('Tab');
    await page.keyboard.type('X');
    await sleep(300);
    assert((await md()) === '123456\n\n123' + TAB + 'X456\n\nlast line', 'Tab mid-paragraph types a tab, saved as a tab');
    assert(await inEditor(), 'focus stays in the editor, so typing carries on');
    const width = await page.evaluate(() => {
        const tw = document.createTreeWalker(editor.querySelector('.block[data-model-index="2"]'), NodeFilter.SHOW_TEXT);
        let n;
        while ((n = tw.nextNode())) {
            const i = n.nodeValue.indexOf('\t');
            if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return r.getBoundingClientRect().width; }
        }
        return 0;
    });
    assert(width > 8, 'the tab shows as a gap, not one space (' + Math.round(width) + ' px)');

    const last = await page.evaluate(() => { const r = editor.querySelector('.block[data-model-index="4"]').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
    await page.mouse.click(last.x, last.y);
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await sleep(300);
    assert((await md()).endsWith('\n\n' + TAB + 'last line'), 'Tab at the start of a line keeps the tab');
    await shiftTab();
    await sleep(300);
    assert((await md()).endsWith('\n\nlast line'), 'Shift+Tab removes it');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await sleep(400);
    assert((await md()) === '123456\n\n123456\n\nlast line', 'Ctrl+Z takes the typing back');

    console.log('\n=== Preview: a tab in a file that is opened ===');
    await page.evaluate((t) => loadMarkdownContent('a' + t + 'b\n\n' + t + 'indented'), TAB);
    await sleep(600);
    const shown = await page.evaluate(() => { const s = editor.querySelector('.tz-tab'); return s ? s.getBoundingClientRect().width : 0; });
    assert(shown > 8, 'a tab already in the file shows as a gap (' + Math.round(shown) + ' px)');
    assert((await md()) === 'a' + TAB + 'b\n\n' + TAB + 'indented', 'and saves back unchanged, leading tab included');

    console.log('\n=== Source ===');
    await page.evaluate(() => loadMarkdownContent('123456\n\nline two\nline three\n\n- a list item'));
    await sleep(500);
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await sleep(800);
    const val = () => page.evaluate(() => sourceEditor.value);
    const clickLine = async (n, dx) => {
        const r = await page.evaluate((i) => { const b = document.querySelectorAll('.cm-line')[i].getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; }, n);
        await page.mouse.click(r.x + dx, r.y);
        await sleep(150);
    };
    await clickLine(0, 1);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab');
    await page.keyboard.type('X');
    await sleep(300);
    assert((await val()).startsWith('123' + TAB + 'X456\n'), 'Tab mid-line types a tab');
    assert(await inEditor(), 'focus stays in Source');
    await clickLine(2, 1);
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
    await page.keyboard.press('Tab');
    await sleep(200);
    assert((await val()).includes('\n' + TAB + 'line two\n' + TAB + 'line three\n'), 'Tab over two lines indents both');
    await shiftTab();
    await sleep(200);
    assert((await val()).includes('\nline two\nline three\n'), 'Shift+Tab takes them back');
    await clickLine(5, 40);
    await page.keyboard.press('Tab');
    await sleep(300);
    assert((await val()).endsWith('\n  - a list item'), 'Tab on a list line still nests the list (no tab typed as well)');
} finally {
    await browser.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
