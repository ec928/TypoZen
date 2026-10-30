/**
 * An edit changes what was edited and nothing else in the line.
 *
 * Every edit re-saves its line from what is on screen, so anything the screen did not hold was
 * lost: found 2026-10-30 by running each line of the real Markdown on this machine through the
 * serializer, and by pressing each key at each kind of block. All of these were in 0.19.1.
 * Enter carried the rest of a line down as plain text, deleting images and link addresses;
 * Enter in a code block or table destroyed it; Backspace beside one flattened it; a line
 * starting "0.48s" was a list item and saved as "1. 48s"; a titled image was lost on save.
 *
 *   node tests/edit-keeps-source-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = process.env.TZ_APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function same(got, want, msg) {
    if (got === want) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 15000 });
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

    // EDIT_LAYOUT=scroll2 or pages runs the same edits in 2-Col or two-page Preview.
    const layout = { scroll2: ['view_set:columns:2', 'view_set:scroll:scroll'], pages: ['view_set:columns:2', 'view_set:scroll:pagination'] }[process.env.EDIT_LAYOUT] || [];
    const load = async (d) => {
        await page.evaluate((d, cmds) => {
            localStorage.clear();
            handleCommand('view_set:mode:preview');
            cmds.forEach(c => handleCommand(c));
            loadMarkdownContent(d);
        }, d, layout);
        await settled(page);
    };
    const md = () => page.evaluate(() => getMarkdownContent(false));
    async function clickAt(word, atEnd) {
        const pt = await page.evaluate((w, e) => {
            const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
            let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf(w) < 0) {}
            const at = t.nodeValue.indexOf(w) + (e ? w.length : 0);
            const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at);
            const b = r.getBoundingClientRect(); return { x: b.left + (e ? 0 : 1), y: b.top + b.height / 2 };
        }, word, atEnd);
        await page.mouse.click(pt.x, pt.y);
        await settled(page);
    }
    async function keys(list) {
        for (const k of list) {
            if (k === 'UNDO') { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); }
            else if (k.length > 1) await page.keyboard.press(k);
            else await page.keyboard.type(k);
            await settled(page);
        }
    }
    async function edit(doc, word, atEnd, list, want, msg) {
        await load(doc);
        await clickAt(word, atEnd);
        await keys(list);
        same(await md(), want, msg);
    }

    console.log('=== Enter carries the rest of the line down whole ===');
    await edit('alpha **bold** *it* `co` ~~st~~ omega', 'alpha', true, ['Enter'], 'alpha\n **bold** *it* `co` ~~st~~ omega', 'marks after the caret');
    await edit('alpha [text](https://e.com/p) omega', 'alpha', true, ['Enter'], 'alpha\n [text](https://e.com/p) omega', 'a link keeps its address');
    await edit('alpha ![pic](a.png) omega', 'alpha', true, ['Enter'], 'alpha\n ![pic](a.png) omega', 'an image is not deleted');
    await edit('alpha plain omega', 'alpha', true, ['Enter'], 'alpha\n plain omega', 'plain text and its leading space, as before');
    await edit('x **alpha bold** y', 'alpha', true, ['Enter'], 'x **alpha**\n **bold** y', 'a split bold word keeps the space after the caret');

    console.log('\n=== Enter at the start of a line moves the line, marker and all ===');
    await edit('Top.\n\n# Head one', 'Head', false, ['Enter'], 'Top.\n\n\n# Head one', 'heading');
    await edit('Top.\n\n> Quote', 'Quote', false, ['Enter'], 'Top.\n\n\n> Quote', 'quote');
    await edit('Top.\n\n- Item', 'Item', false, ['Enter'], 'Top.\n\n- \n- Item', 'bullet');
    await edit('Top.\n\n- [x] Item', 'Item', false, ['Enter', 'Y'], 'Top.\n\n- [ ] \n- [x] YItem', 'task item, and the next letter typed lands in it');

    console.log('\n=== code blocks ===');
    const CODE = 'A\n\n```js\nline1\nline2\n```\n\nZ';
    await edit(CODE, 'line1', true, ['Enter', 'Y'], 'A\n\n```js\nline1\nY\nline2\n```\n\nZ', 'Enter is a new line of code');
    await edit(CODE, 'line2', true, ['Enter', 'Enter', 'Y'], 'A\n\n```js\nline1\nline2\n```\nY\n\nZ', 'Enter on an empty last line leaves the block');
    await edit(CODE, 'line1', true, ['Enter', 'UNDO'], CODE, 'Undo takes the new line back');
    await edit('A\n\n````c++\n```\ninner\n```\n````\n\nZ', 'inner', true, ['x'], 'A\n\n````c++\n```\ninnerx\n```\n````\n\nZ', 'typing keeps the fence and tag as written');
    await edit('A\n\n```\nx\n```\n\nZ', 'Z', false, ['Backspace', 'Backspace'], 'A\n\n```\nx\n```\nZ', 'Backspace takes the blank line, then stops at the block');
    await edit('A\n\n```\nx\n```', 'A', true, ['Delete', 'Delete'], 'A\n```\nx\n```', 'Delete takes the blank line, then stops at the block');

    console.log('\n=== tables ===');
    const TABLE = 'A\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n\nZ';
    await edit(TABLE, 'c1', true, ['Enter'], TABLE, 'Enter in a cell leaves the table alone');
    await edit('A\n\n| h |\n|---|\n| a \\| b |\n\nZ', 'a', true, ['x'], 'A\n\n| h |\n|---|\n| ax \\| b |\n\nZ', 'an escaped pipe stays in its cell');
    await load('A\n\n| h |\n|---|\n| a \\| b |');
    same(await page.evaluate(() => document.querySelectorAll('#editor td').length), 1, 'and is not a second column');

    console.log('\n=== numbers, titles, refused links, markers ===');
    await edit('Top.\n\n0.48s of spread', 'spread', true, ['x'], 'Top.\n\n0.48s of spreadx', 'a line starting with a decimal is not a list');
    await edit('Top.\n\n3.14 is pi', 'pi', true, ['x'], 'Top.\n\n3.14 is pix', 'nor is 3.14');
    await edit('Top.\n\n1.hello', 'hello', true, ['x'], 'Top.\n\n1.hellox', '"1.hello" still is, as written');
    await edit('Top.\n\n0. zero', 'zero', true, ['x'], 'Top.\n\n0. zerox', 'a list from 0 keeps its number');
    await edit('Top.\n\n   * item', 'item', true, ['x'], 'Top.\n\n   * itemx', 'a bullet keeps its marker and indent');
    await edit('alpha [t](https://e.com "T") omega', 'alpha', true, ['Q'], 'alphaQ [t](https://e.com "T") omega', 'a titled link survives an edit');
    await edit('alpha ![p](a.png "T") omega', 'alpha', true, ['Q'], 'alphaQ ![p](a.png "T") omega', 'a titled image survives an edit');
    await edit('alpha [t](javascript:x) omega', 'alpha', true, ['Q'], 'alphaQ [t](javascript:x) omega', 'a refused link is kept, not deleted');
    await edit('alpha ![p](a.png) omega', 'alpha', true, ['Q'], 'alphaQ ![p](a.png) omega', 'the space before an image survives typing');
    const refused = 'x [t](javascript:alert(1)) ![p](a.png "T") y';
    await load(refused);
    same(await md(), refused, 'a titled image and a refused link load unchanged');
    same(await page.evaluate(() => document.querySelector('#editor a').hasAttribute('href')), false, 'and a refused link is not clickable');
    // What is shown, which a save check cannot see.
    await load('0.48s of spread\n\n3.14 is pi\n\nalpha [t](https://e.com "T") omega\n\n![p](a.png "T")');
    same(await page.evaluate(() => document.querySelectorAll('#editor ol').length), 0, 'a decimal is not shown as a numbered item');
    same(await page.evaluate(() => (document.querySelector('#editor a') || {}).href), 'https://e.com/', 'a titled link is clickable');
    same(await page.evaluate(() => document.querySelectorAll('#editor img').length), 1, 'a titled image is shown');

    console.log('\n=== numbered lists ===');
    const OL = 'Top.\n\n1. one\n2. two\n3. three';
    await edit(OL, 'one', true, ['Enter', 'Y'], 'Top.\n\n1. one\n2. Y\n3. two\n4. three', 'Enter at the end of an item moves the ones below down');
    await edit(OL, 'one', false, ['Enter'], 'Top.\n\n1. \n2. one\n3. two\n4. three', 'Enter at the start of an item does too');
    await edit(OL, 'three', true, ['Enter', 'Y'], 'Top.\n\n1. one\n2. two\n3. three\n4. Y', 'at the end of the list there is nothing to move');
    await edit('Top.\n\n1. one\n5. two\n6. three', 'one', true, ['Enter'], 'Top.\n\n1. one\n2. \n5. two\n6. three', 'a list that skips numbers keeps its gap');
    await edit('Top.\n\n1. one\n   - sub\n2. two\n\nAfter 1. text', 'one', true, ['Enter'], 'Top.\n\n1. one\n2. \n   - sub\n3. two\n\nAfter 1. text', 'nested items and text after the list are left alone');
    await edit('Top.\n\n1. one\n2. two', 'one', true, ['Enter', 'UNDO'], 'Top.\n\n1. one\n2. two', 'Undo puts the numbers back');
    await edit('Top.\n\n1. one\n\n1. other', 'one', true, ['Enter'], 'Top.\n\n1. one\n2. \n\n1. other', 'a blank line ends the list');

    console.log('\n=== a table edit changes that cell ===');
    await edit('Top.\n\n|a|b|\n|-|:-:|\n|1|2|', '1', true, ['x'], 'Top.\n\n|a|b|\n|-|:-:|\n|1x|2|', 'tight spacing and the separator stay');
    await edit('Top.\n\n| long   | b |\n|---|---|\n| 1      | 2 |\n| 3      | 4 |', '3', true, ['x'], 'Top.\n\n| long   | b |\n|---|---|\n| 1      | 2 |\n| 3x      | 4 |', 'so do aligned rows, and the other rows');
    await edit('Top.\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |', '1', true, ['x'], 'Top.\n\n  | a | b |\n  |---|---|\n  | 1x | 2 |', 'an indented table is a table');

    await load('Top.\n\n> one\n>\n> two');
    same(await page.evaluate(() => {
        const b = [...document.querySelectorAll('#editor .block')].find(x => x.getAttribute('data-raw') === '>');
        return blockHtmlToMarkdown(b);
    }), '>', 'the blank line in a quote serializes as itself');
} finally {
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
