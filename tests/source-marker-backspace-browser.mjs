/**
 * Source: one Backspace on a line holding only a list or quote marker removes the marker
 * (Ed, 2026-11-22), as Preview does. Enter writes "- " / "> " for you; Backspace used to
 * take back only the space and leave a lone "-" or ">". Everywhere else Backspace deletes
 * one character. Also: Enter on a task item continues it as a task item ("- [ ] "), and an
 * empty one ends the list, as in Preview.
 *
 *   node tests/source-marker-backspace-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (90 s)'); process.exit(1); }, 90000);
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
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 40))));
    const val = () => page.evaluate(() => sourceEditor.value);
    const key = async (k, ctrl) => { if (ctrl) await page.keyboard.down('Control'); await page.keyboard.press(k); if (ctrl) await page.keyboard.up('Control'); await quiet(); };
    // Source holding `doc`, the caret at the end of line `li` (or at `col`), focused.
    const at = async (doc, li, col) => {
        await page.evaluate((d) => { setSourceDocExt('md'); handleCommand('view_set:mode:source'); loadMarkdownContent(d); }, doc);
        await quiet();
        await page.evaluate((l, c) => {
            const lines = sourceEditor.value.split('\n'); let p = 0;
            for (let k = 0; k < l; k++) p += lines[k].length + 1;
            p += c == null ? lines[l].length : c;
            sourceEditor.focus(); sourceEditor.setSelectionRange(p, p);
        }, li, col);
        await quiet();
    };

    console.log('\n=== Enter continues the marker, one Backspace takes all of it back ===');
    for (const [line, cont] of [['- item', '- '], ['* item', '* '], ['+ item', '+ '], ['1. item', '2. '], ['2) item', '3) '],
        ['- [ ] task', '- [ ] '], ['- [x] done', '- [ ] '], ['  - nested', '  - '], ['> quoted', '> '], ['> > deep', '> > ']]) {
        await at('Top\n' + line + '\nEnd', 1);
        await key('Enter');
        same(JSON.stringify(line) + ': Enter continues with ' + JSON.stringify(cont), await val(), 'Top\n' + line + '\n' + cont + '\nEnd');
        await key('Backspace');
        same(JSON.stringify(line) + ': one Backspace leaves an empty line', await val(), 'Top\n' + line + '\n\nEnd');
        await key('KeyZ', true);
        same(JSON.stringify(line) + ': Ctrl+Z brings the marker back', await val(), 'Top\n' + line + '\n' + cont + '\nEnd');
    }
    await at('> [!NOTE]\n> body\nEnd', 1);
    await key('Enter'); await key('Backspace');
    same('callout body: Enter, Backspace leaves an empty line', await val(), '> [!NOTE]\n> body\n\nEnd');

    console.log('\n=== everywhere else Backspace deletes one character ===');
    await at('Top\n- ab\nEnd', 1);
    await key('Backspace');
    same('text on the line: one character', await val(), 'Top\n- a\nEnd');
    await at('Top\n- \nEnd', 1, 1);
    await key('Backspace');
    same('caret before the space: one character', await val(), 'Top\n \nEnd');
    await at('Top\n- after\nEnd', 1, 2);
    await key('Backspace');
    same('text after the caret: one character', await val(), 'Top\n-after\nEnd');
    await at('```\n- \n```\nEnd', 1);
    await key('Backspace');
    same('inside a code fence: one character', await val(), '```\n-\n```\nEnd');
    await at('Top\n- \nEnd', 1);
    await page.evaluate(() => { sourceEditor.setSelectionRange(4, 6); });
    await key('Backspace');
    same('a selection: deleted as usual', await val(), 'Top\n\nEnd');
    await at('Top\n> [!NOTE]\nEnd', 1);
    await key('Backspace');
    same('a callout header is text: one character', await val(), 'Top\n> [!NOTE\nEnd');

    console.log('\n=== an empty task item ends the list ===');
    // As for an empty "- ": the marker goes and the caret moves to a new line below.
    for (const empty of ['- ', '- [ ] ']) {
        await at('Top\n' + empty + '\nEnd', 1);
        await key('Enter');
        same('Enter on an empty ' + JSON.stringify(empty) + ' ends the list', await val(), 'Top\n\n\nEnd');
    }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
