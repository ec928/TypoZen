/**
 * With Reveal on, Enter in a code block or a table is a line break in its Markdown (2026-11-21).
 *
 * Reveal draws the active block as its Markdown; a fenced code block or a table is several
 * lines in one block. Enter there split the block and tidied each half as one line, which
 * moved the breaks: at the end of a code line the closing fence ended up on the last line,
 * so the block no longer closed and swallowed the rest of the document; a table row broke in
 * the wrong place and Backspace could not take it back. In Source, Enter is a line break;
 * now it is in Reveal too, and the block stays one block.
 *
 *   node tests/reveal-enter-multiline-browser.mjs          (TZ_ROOT=<folder> to test another copy)
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
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 70)))));
    const md = () => page.evaluate(() => getMarkdownContent(false));
    const key = async (k, ctrl) => { if (ctrl) await page.keyboard.down('Control'); await page.keyboard.press(k); if (ctrl) await page.keyboard.up('Control'); await quiet(); };

    // Reveal on, the block at line `li` drawn as its Markdown, the caret `off` characters into that
    // Markdown (a line break counts one), by the arrow keys from the start of the block.
    const caretInRevealed = async (doc, li, off) => {
        await page.evaluate((d) => { state.revealOnFocus = true; setSourceDocExt('md'); handleCommand('view_set:mode:wysiwyg'); loadMarkdownContent(d); }, doc);
        await quiet();
        const b = await page.evaluate((l) => { const r = document.querySelector('#editor .block[data-model-index="' + l + '"]').getBoundingClientRect(); return { x: r.left + 30, y: r.top + 12 }; }, li);
        await page.mouse.click(b.x, b.y);
        await page.evaluate((l) => {
            const el = document.querySelector('#editor .block[data-model-index="' + l + '"]');
            if (el.querySelector(':not(br)')) { currentActiveBlock = null; updateActiveBlock(); }
            const r = document.createRange(); r.selectNodeContents(el); r.collapse(true);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        }, li);
        await quiet();
        for (let i = 0; i < off; i++) await page.keyboard.press('ArrowRight');
        await quiet();
    };
    // Leave the block so it is written back.
    const leave = async () => {
        const a = await page.evaluate(() => { const bl = document.querySelectorAll('#editor .block'); const r = bl[bl.length - 1].getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; });
        await page.mouse.click(a.x, a.y);
        await quiet();
    };

    const CODE = 'Top\n\n```js\nlet x = 1;\nlet y = 2;\n```\n\nAfter';
    console.log('\n=== code block ===');
    await caretInRevealed(CODE, 2, 16);          // after "let x = 1;"
    await key('Enter'); await leave();
    same('Enter at the end of a code line adds a line and the fence still closes', await md(), 'Top\n\n```js\nlet x = 1;\n\nlet y = 2;\n```\n\nAfter');
    await caretInRevealed(CODE, 2, 13);          // after "let x ="
    await key('Enter'); await leave();
    same('Enter mid-line breaks the line at the caret', await md(), 'Top\n\n```js\nlet x =\n 1;\nlet y = 2;\n```\n\nAfter');
    await caretInRevealed(CODE, 2, 16);
    await key('Enter'); await key('Backspace'); await leave();
    same('Enter, Backspace leaves the code block as it was', await md(), CODE);
    await caretInRevealed(CODE, 2, 16);
    await key('Enter'); await key('KeyZ', true); await leave();
    same('Enter, Ctrl+Z leaves the code block as it was', await md(), CODE);
    await caretInRevealed(CODE, 2, 31);          // after the closing fence
    await key('Enter'); await leave();
    same('Enter after the closing fence adds a line below the block', await md(), 'Top\n\n```js\nlet x = 1;\nlet y = 2;\n```\n\n\nAfter');
    await caretInRevealed(CODE, 2, 31);
    await key('Enter'); await key('Backspace'); await leave();
    same('Enter, Backspace after the closing fence leaves it as it was', await md(), CODE);

    const TABLE = 'Top\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter';
    console.log('\n=== table ===');
    await caretInRevealed(TABLE, 2, 33);         // the end of "| 1 | 2 |"
    await key('Enter'); await leave();
    same('Enter at the end of the last row adds a line below it, the rows intact', await md(), 'Top\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n\nAfter');
    await caretInRevealed(TABLE, 2, 33);
    await key('Enter'); await key('Backspace'); await leave();
    same('Enter, Backspace leaves the table as it was', await md(), TABLE);
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
