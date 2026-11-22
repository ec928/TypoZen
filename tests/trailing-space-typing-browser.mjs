/**
 * Typing at the end of a line that ends in spaces changes nothing but what is typed (2026-11-22).
 *
 * Preview drew a line's last trailing space as an ordinary space, which the browser treats as
 * nothing at the end of a line: typing beside it deleted it. "fix. " + Q saved "fix.Q", a
 * Markdown line break "virt.  " + Q saved "virt. Q" (one space and the break gone), and
 * "**Scrolling:** " + Q saved "**Scrolling:Q**". Trailing spaces are now drawn as no-break
 * spaces, which the browser keeps; the letter goes after them, as End puts it in Source.
 *
 *   node tests/trailing-space-typing-browser.mjs          (TZ_ROOT=<folder> to test another copy)
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
    const line1 = () => page.evaluate(() => getMarkdownContent(false).split('\n')[1]);
    const atEnd = async (raw) => {
        await page.evaluate((l) => { setSourceDocExt('md'); handleCommand('view_set:mode:wysiwyg'); loadMarkdownContent('Top\n' + l + '\nNext'); }, raw);
        await quiet();
        const b = await page.evaluate(() => { const r = document.querySelector('#editor .block[data-model-index="1"]').getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; });
        await page.mouse.click(b.x, b.y);
        await page.keyboard.press('End');
        await quiet();
    };

    for (const raw of ['fix. ', 'virt.  ', 'virt.   ', '**Scrolling:** ', '- item ', '## Heading  ', '> quoted  ']) {
        await atEnd(raw);
        await page.keyboard.type('Q'); await quiet();
        same(JSON.stringify(raw) + ' + Q at the end keeps its spaces', await line1(), raw + 'Q');
        await page.keyboard.press('Backspace'); await quiet();
        same(JSON.stringify(raw) + ' then Backspace is the line as it was', await line1(), raw);
    }
    await atEnd('virt.  ');
    await page.keyboard.type('Q'); await quiet();
    await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await quiet();
    same('Ctrl+Z after typing at the end of a line break gives it back, spaces and all', await line1(), 'virt.  ');
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await quiet();
    same('and Source shows the same line', await page.evaluate(() => sourceEditor.value.split('\n')[1]), 'virt.  ');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
