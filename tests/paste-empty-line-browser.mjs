/**
 * One Markdown line pasted onto an empty line in Preview is that line, as written (2026-11-21).
 *
 * Until 0.21.28 a task item or a "* " bullet came out as its bare words, a callout header lost
 * "> [!NOTE]", and an indented item came out as "  -   - item": copying a to-do onto a new
 * line lost its box. Two lines pasted together were always right; one line went through the
 * in-line paths (rendered then unwrapped, or typed in then list-formatted).
 *
 * Also: typing in a nested item keeps it nested, and a pasted edge space is saved as a space
 * (both went wrong under Reveal, removed in 0.21.30; kept here for Preview).
 *
 *   node tests/paste-empty-line-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

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
    await page.setViewport({ width: 1100, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
        window.__host = (m) => window.__L.forEach(fn => fn({ data: m }));
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 70)))));
    const md = () => page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''));
    const load = async (doc) => {
        await page.evaluate((d) => { setSourceDocExt('md'); handleCommand('view_set:mode:wysiwyg'); loadMarkdownContent(d); }, doc);
        await quiet();
    };
    const pasteEvent = (t) => page.evaluate((x) => {
        const dt = new DataTransfer(); dt.setData('text/plain', x);
        document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, t);
    const lineAt = (i) => page.evaluate((l) => { const r = document.querySelector('#editor .block[data-model-index="' + l + '"]').getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; }, i);

    console.log('\n=== one line pasted onto an empty line ===');
    for (const line of ['- [ ] task open', '- [x] task done', '* star bullet', '> [!NOTE] Callout title', '  - nested two', '- bullet', 'Plain **bold** end']) {
        for (const route of ['Ctrl+V', 'menu Paste']) {
            await load('Top\n\nBottom');
            await page.evaluate(() => { const el = document.querySelector('#editor .block[data-model-index="1"]'); focusBlock(el, 0); });
            if (route === 'Ctrl+V') await pasteEvent(line); else await page.evaluate((t) => window.__host('paste_text:' + t), line);
            await quiet();
            await page.keyboard.type('Q');
            await quiet();
            same(route + ' ' + JSON.stringify(line) + ', then typing', await md(), 'Top\n' + line + 'Q\nBottom');
        }
    }

    console.log('\n=== spaces that are part of the Markdown ===');
    await load('- top item\n  - nested two\nAfter');
    let p = await lineAt(1);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('End');
    await page.keyboard.type('Z');
    p = await lineAt(2);
    await page.mouse.click(p.x, p.y);
    await quiet();
    same('typing at the end of a nested item keeps it nested', await md(), '- top item\n  - nested twoZ\nAfter');

    await load('## Heading two here\nNext');
    p = await lineAt(0);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Home');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    await pasteEvent('X ');
    await page.keyboard.type('Q');
    p = await lineAt(1);
    await page.mouse.click(p.x, p.y);
    await quiet();
    same('a pasted edge space is saved as a space, not a no-break space', await md(), '## Heading X Qtwo here\nNext');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
