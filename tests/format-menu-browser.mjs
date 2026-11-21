/**
 * The page's half of the Format menu work (2026-11-21):
 *   - a right-click in a Markdown document asks the host for TypoZen's menu (format_menu:
 *     with the caret line's type) instead of the browser's, and does not also raise the
 *     selection popup; in a code file the browser's menu stays
 *   - Ctrl+1..6 make headings, the same key again makes normal text, Ctrl+Alt+2 does not
 *   - the selection popup: Highlight sits with the reading tools; Bold and the other
 *     formats are hidden in a code file
 * The host's half (the WPF menu itself, its ticks, Alt+O, the host key filter) is not
 * reachable from here.
 *
 *   node tests/format-menu-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (40 s)'); process.exit(1); }, 40000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++;
    console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    // Record what the page sends the host, and whether a right-click's default survived.
    await page.evaluate(() => {
        window.__sent = [];
        postMsg = function (m) { window.__sent.push(String(m)); };
        window.__ctxDefault = null;
        document.addEventListener('contextmenu', (e) => { window.__ctxDefault = !e.defaultPrevented; });
    });
    const saved = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
    const load = async (md, ext, mode) => {
        await page.evaluate((m, x) => { setSourceDocExt(x); loadMarkdownContent(m); }, md, ext || 'md');
        await page.evaluate((m) => handleCommand('view_set:mode:' + m), mode || 'wysiwyg');
        await settled(page);
        await page.evaluate(() => { window.__sent = []; window.__ctxDefault = null; });
    };
    const lineBox = async (i) => (await page.$('#editor .block[data-model-index="' + i + '"]')).boundingBox();
    const menuMsgs = () => page.evaluate(() => window.__sent.filter(m => m.indexOf('format_menu:') === 0));
    const popShown = () => page.evaluate(() => { const p = document.getElementById('selPop'); return !!p && !p.hidden; });
    // Drag across the start of a line. (Not clickCount: 2 -- Puppeteer's is no real double-click.)
    const dragSelect = async (box) => {
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + 2, y);
        await page.mouse.down();
        await page.mouse.move(box.x + 40, y, { steps: 4 });
        await page.mouse.up();
        await new Promise(r => setTimeout(r, 120));   // the popup is raised 10 ms after mouseup
    };

    console.log('\n=== right-click in Markdown: TypoZen\'s menu, not the browser\'s ===');
    await load('## Heading\n> [!TIP]\n> Tip body\nPlain');
    let b = await lineBox(2);
    await page.mouse.click(b.x + 20, b.y + b.height / 2, { button: 'right' });
    await settled(page);
    let msgs = await menuMsgs();
    same('one format_menu: request, with the line\'s type', JSON.stringify(msgs), JSON.stringify(['format_menu:{"block":"quote","callout":"tip"}']));
    same('the browser\'s own menu is cancelled', await page.evaluate(() => window.__ctxDefault), false);
    // Right-click on a selection: the menu, and no popup over it.
    b = await lineBox(3);
    await dragSelect(b);
    same('premise: the drag selected text and raised the popup', await popShown(), true);
    await page.evaluate(() => { window.__sent = []; hideSelPop(); });
    await page.mouse.click(b.x + 20, b.y + b.height / 2, { button: 'right' });
    await new Promise(r => setTimeout(r, 120));   // the popup is raised 10 ms after mouseup
    same('right-click on a selection does not raise the popup', await popShown(), false);
    same('and asks for the menu', (await menuMsgs()).length, 1);

    console.log('\n=== a code file keeps the browser\'s menu ===');
    await load('int x = 1;', 'cs', 'source');
    const cm = await page.$('#source-cm .cm-content');
    b = await cm.boundingBox();
    await page.mouse.click(b.x + 10, b.y + 8, { button: 'right' });
    await settled(page);
    same('no format_menu: request in a .cs file', (await menuMsgs()).length, 0);
    same('the browser\'s menu is left alone', await page.evaluate(() => window.__ctxDefault), true);

    console.log('\n=== Ctrl+1..6 ===');
    await load('Title line\nSecond');
    b = await lineBox(0);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.keyboard.down('Control'); await page.keyboard.press('Digit2'); await page.keyboard.up('Control');
    await settled(page);
    same('Ctrl+2 makes a level 2 heading', await saved(), '## Title line\nSecond');
    b = await lineBox(0);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.keyboard.down('Control'); await page.keyboard.press('Digit2'); await page.keyboard.up('Control');
    await settled(page);
    same('Ctrl+2 again: normal text', await saved(), 'Title line\nSecond');
    b = await lineBox(1);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.keyboard.down('Control'); await page.keyboard.down('Alt');
    await page.keyboard.press('Digit2');
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await settled(page);
    same('Ctrl+Alt+2 (AltGr) changes nothing', await saved(), 'Title line\nSecond');

    console.log('\n=== the selection popup ===');
    await load('Some words here');
    b = await lineBox(0);
    await dragSelect(b);
    same('premise: the popup is up', await popShown(), true);
    const pop = await page.evaluate(() => {
        const mark = document.getElementById('selPopMark');
        return { inRow: !!(mark && !mark.closest('#selPopOverflow')), bold: !document.getElementById('selPopBold').hidden };
    });
    same('Highlight is on the icon row, not in More', pop.inRow, true);
    same('Bold is offered in Markdown', pop.bold, true);
    await load('int value = 1;', 'cs', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(4, 9); showSelPop({ left: 100, top: 100, width: 0, height: 0, bottom: 100 }); });
    same('Bold is hidden in a code file', await page.evaluate(() => document.getElementById('selPopBold').hidden), true);
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
