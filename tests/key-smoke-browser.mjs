/**
 * The keys that have done the most damage, pressed for real, as fast as they can be. Part of the
 * build's 20-second budget (version-smoke.mjs), so it waits for the page to answer rather than for
 * fixed times. edit-keeps-source-browser is the full set; this is the worst of it.
 *
 *   node tests/key-smoke-browser.mjs
 *   TZ_APP_DIR=path node tests/key-smoke-browser.mjs     another build, as a control
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const started = Date.now();
const deadline = setTimeout(() => { console.error('  FAIL over budget (25 s)'); process.exit(1); }, 25000);

// [what it guards, document, word to click, click after it?, keys, what must be saved]
const CODE = 'A\n\n```js\nline1\nline2\n```\n\nZ';
const TABLE = 'A\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n\nZ';
const OL = 'A\n\n1. one\n2. two\n3. three';
const WRAP = 'A\n\nThis is **very important\nand continues here** in it.\n\nZ';
const CASES = [
    ['Enter keeps marks after the caret', 'A\n\nalpha **bold** *it* `co` omega', 'alpha', true, ['Enter'], 'A\n\nalpha\n **bold** *it* `co` omega'],
    ['Enter keeps a link address', 'A\n\nalpha [t](https://e.com/p) omega', 'alpha', true, ['Enter'], 'A\n\nalpha\n [t](https://e.com/p) omega'],
    ['Enter keeps an image', 'A\n\nalpha ![p](a.png) omega', 'alpha', true, ['Enter'], 'A\n\nalpha\n ![p](a.png) omega'],
    ['Enter at line start keeps a heading', 'A\n\n# Head', 'Head', false, ['Enter'], 'A\n\n\n# Head'],
    ['Enter at line start keeps a quote', 'A\n\n> Quote', 'Quote', false, ['Enter'], 'A\n\n\n> Quote'],
    ['Enter in a quote keeps the next line', 'A\n\n> one\n> two', 'one', true, ['Enter', 'Y'], 'A\n\n> one\nY\n> two'],
    ['Enter in code is a line of code', CODE, 'line1', true, ['Enter', 'Y'], 'A\n\n```js\nline1\nY\nline2\n```\n\nZ'],
    ['Enter in a table does nothing', TABLE, 'c1', true, ['Enter'], TABLE],
    ['Enter renumbers the list', OL, 'one', true, ['Enter', 'Y'], 'A\n\n1. one\n2. Y\n3. two\n4. three'],
    ['Enter at a task start: next letter lands', 'A\n\n- [x] Item', 'Item', false, ['Enter', 'Y'], 'A\n\n- [ ] \n- [x] YItem'],
    ['Backspace twice keeps a callout body', 'A\n\n> [!NOTE]\n> Body text.', 'Body', false, ['Home', 'Backspace', 'Backspace'], 'A\n\n> [!NOTE]Body text.'],
    ['Backspace stops at a code block', 'A\n\n```\nx\n```\n\nZ', 'Z', false, ['Backspace', 'Backspace'], 'A\n\n```\nx\n```\nZ'],
    ['Delete stops at a code block', 'A\n\n```\nx\n```', 'A', true, ['Delete', 'Delete'], 'A\n```\nx\n```'],
    ['Delete stops at a table', TABLE, 'A', true, ['Delete', 'Delete'], 'A\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n\nZ'],
    ['a table edit changes that cell', TABLE, 'c1', true, ['x'], 'A\n\n| h1 | h2 |\n|---|---|\n| c1x | c2 |\n\nZ'],
    ['typing keeps a titled link', 'A\n\nalpha [t](https://e.com "T") omega', 'alpha', true, ['Q'], 'A\n\nalphaQ [t](https://e.com "T") omega'],
    ['typing keeps a titled image', 'A\n\nalpha ![p](a.png "T") omega', 'alpha', true, ['Q'], 'A\n\nalphaQ ![p](a.png "T") omega'],
    ['typing keeps a list marker', 'A\n\n   * item', 'item', true, ['x'], 'A\n\n   * itemx'],
    ['typing keeps a decimal', 'A\n\n0.48s of spread', 'spread', true, ['x'], 'A\n\n0.48s of spreadx'],
    ['typing in wrapped bold saves as written', WRAP, 'important', true, ['x'], 'A\n\nThis is **very importantx\nand continues here** in it.\n\nZ'],
    ['Undo takes back Enter in code', CODE, 'line1', true, ['Enter', 'UNDO'], CODE],
];

let passed = 0, failed = 0;
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 10000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 8000 });

    const md = () => page.evaluate(() => getMarkdownContent(false));
    // The saved text once it is what we want and has stayed so. A first key on a cold page can
    // take well over 100 ms to show, so holding still briefly proves nothing: only a wrong
    // answer waits the whole limit, and a right one returns at once.
    const answer = async (want) => {
        let last = await md();
        for (let i = 0; i < 50; i++) {
            if (last === want) {
                await sleep(30);
                const again = await md();
                if (again === want) return again;
                last = again;
                continue;
            }
            await sleep(30);
            last = await md();
        }
        return last;
    };
    for (const [name, doc, word, after, keys, want] of CASES) {
        await page.evaluate((d) => { localStorage.clear(); handleCommand('view_set:mode:preview'); loadMarkdownContent(d); }, doc);
        // The app's deferred focus after a load can take the caret back from a click made too
        // soon, so the check is that the caret is in the word and has stayed there: no fixed wait
        // is long enough on a busy machine.
        let inWord = false;
        for (let tries = 0; tries < 12 && !inWord; tries++) {
            const pt = await page.evaluate((w, e) => {
                const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
                let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf(w) < 0) {}
                if (!t) return null;
                const at = t.nodeValue.indexOf(w) + (e ? w.length : 0);
                const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at);
                const b = r.getBoundingClientRect(); return { x: b.left + (e ? 0 : 1), y: b.top + b.height / 2 };
            }, word, after);
            if (!pt) break;
            await page.mouse.click(pt.x, pt.y);
            await sleep(60);
            inWord = await page.evaluate((w) => {
                const s = getSelection();
                return !!(s && s.anchorNode && s.anchorNode.nodeType === 3 && s.anchorNode.nodeValue.indexOf(w) >= 0);
            }, word);
            if (inWord) {
                await sleep(40);
                inWord = await page.evaluate((w) => {
                    const s = getSelection();
                    return !!(s && s.anchorNode && s.anchorNode.nodeType === 3 && s.anchorNode.nodeValue.indexOf(w) >= 0);
                }, word);
            }
        }
        if (!inWord) { failed++; console.error('  FAIL ' + name + ': could not put the caret in "' + word + '"'); continue; }
        for (const k of keys) {
            if (k === 'UNDO') { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); }
            else if (k.length > 1) await page.keyboard.press(k);
            else await page.keyboard.type(k);
            await sleep(25);
        }
        const got = await answer(want);
        if (got === want) passed++;
        else { failed++; console.error('  FAIL ' + name + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
    }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`passed=${passed} failed=${failed} seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
process.exit(failed ? 1 : 0);
