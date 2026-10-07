/**
 * The basic use of each writing feature, with the right result -- not edge cases.
 *
 * controls-browser proves every control does *something*; this proves the common ones do
 * the right thing. Highlight selection "did something" (it made two marks) and passed
 * the sweep, which is why this exists.
 *
 *   node tests/basic-features-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function check(ok, msg, got) {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + (got !== undefined ? '   got ' + JSON.stringify(got) : '')); }
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 15000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => check(false, 'page threw: ' + e.message));
    await page.evaluateOnNewDocument(() => {
        window.__sent = []; window.__L = [];
        window.chrome = { webview: { postMessage: (m) => window.__sent.push(String(m)),
            addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
        window.__host = (m) => window.__L.forEach(fn => fn({ data: m }));
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });

    const md = () => page.evaluate(() => getMarkdownContent(false));
    // Load a document and put the caret in the words "some words" (or select them).
    async function setup(doc, select) {
        await page.evaluate((d) => { localStorage.clear(); handleCommand('view_set:mode:preview'); loadMarkdownContent(d); }, doc);
        await settled(page);
        const pt = await page.evaluate(() => {
            const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
            let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('some words') < 0) {}
            const at = t.nodeValue.indexOf('some words');
            const r = document.createRange(); r.setStart(t, at + 2); r.setEnd(t, at + 2);
            const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 };
        });
        await page.mouse.click(pt.x, pt.y);
        await settled(page);
        if (select) {
            await page.evaluate(() => {
                const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
                let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('some words') < 0) {}
                const at = t.nodeValue.indexOf('some words');
                const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + 10);
                const s = getSelection(); s.removeAllRanges(); s.addRange(r);
            });
            await settled(page);
        }
    }
    const DOC = 'Intro line.\n\nA paragraph with some words in it.\n\nEnd.';
    const line = async () => (await md()).split('\n').find(l => /some words/.test(l));

    console.log('=== toolbar formatting, on a paragraph ===');
    for (const [cmd, want] of [['h1', /^# A paragraph/], ['h2', /^## A paragraph/], ['h3', /^### A paragraph/],
        ['list', /^- A paragraph/], ['ol', /^1\. A paragraph/], ['checklist', /^- \[ \] A paragraph/], ['quote', /^> A paragraph/]]) {
        await setup(DOC, false);
        await page.evaluate((c) => window.__host('fmt:' + c), cmd);
        await settled(page);
        const l = await line();
        check(want.test(l || ''), cmd + ' turns the paragraph into ' + want, l);
    }

    console.log('\n=== inline formatting, on a selection ===');
    for (const [cmd, want] of [['bold', '**some words**'], ['italic', '*some words*'], ['strike', '~~some words~~']]) {
        await setup(DOC, true);
        await page.evaluate((c) => window.__host('fmt:' + c), cmd);
        await settled(page);
        const l = await line();
        check((l || '').includes(want) && (l || '').startsWith('A paragraph with '), cmd + ' wraps only the selection', l);
    }
    // Insert link asks for the address first: the dialog opens with the selection as its
    // text, and only Save changes the document.
    const linkOpen = async () => {
        await setup(DOC, true);
        await page.evaluate(() => window.__host('fmt:link'));
        await settled(page);
        return page.evaluate(() => {
            const m = document.getElementById('linkModal');
            return { open: !!m && !m.hidden, text: (document.getElementById('linkModalText') || {}).value };
        });
    };
    let lm = await linkOpen();
    check(lm.open && lm.text === 'some words', 'Insert link opens the dialog with the selection as its text', lm);
    check((await md()) === DOC, 'and changes nothing until Save', await md());
    await page.click('#linkModalHref', { clickCount: 3 });
    await page.keyboard.type('https://example.com/page');
    await page.click('#linkModalOk');
    await settled(page);
    check(((await line()) || '') === 'A paragraph with [some words](https://example.com/page) in it.',
        'Save turns the selection into that link', await line());
    lm = await linkOpen();
    await page.click('#linkModalClose');
    await settled(page);
    check((await md()) === DOC && await page.evaluate(() => document.getElementById('linkModal').hidden),
        'closing the dialog leaves the document as it was', await md());

    console.log('\n=== undo and redo a format ===');
    await setup(DOC, false);
    await page.evaluate(() => window.__host('fmt:h2'));
    await settled(page);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
    await settled(page);
    check((await md()) === DOC, 'Ctrl+Z puts the document back exactly', await md());
    await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control');
    await settled(page);
    check(/^## A paragraph/m.test(await md()), 'Ctrl+Y applies it again', await md());

    console.log('\n=== Preview and Source show the same document ===');
    const RICH = '# Head\n\nText with **bold** and a [link](https://example.com).\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nLast.';
    await page.evaluate((d) => { handleCommand('view_set:mode:preview'); loadMarkdownContent(d); }, RICH);
    await settled(page);
    await page.evaluate(() => handleCommand('view_set:mode:source')); await settled(page);
    const inSource = await page.evaluate(() => sourceEditor.value);
    await page.evaluate(() => handleCommand('view_set:mode:preview')); await settled(page);
    check(inSource === RICH && (await md()) === RICH, 'switching views changes nothing in the text', { inSource, back: await md() });

    console.log('\n=== the status bar counts words ===');
    await page.evaluate(() => { window.__sent.length = 0; loadMarkdownContent('One two three four five.\n\nSix seven.'); updateStatsNow(); });
    const st = await page.evaluate(() => (window.__sent.filter(m => m.startsWith('stats:')).pop() || '').slice(6).split(','));
    check(+st[0] === 7 && +st[1] === 'One two three four five.\n\nSix seven.'.length, 'seven words, every character', st.slice(0, 2));

    console.log('\n=== focus, typewriter and reveal toggle on and off ===');
    for (const [cmd, prop] of [['toggle_focus', 'focusMode'], ['toggle_typewriter', 'typewriterMode'], ['toggle_reveal', 'revealOnFocus']]) {
        const a = await page.evaluate((p) => !!state[p], prop);
        await page.evaluate((c) => window.__host('cmd:' + c), cmd);
        const b = await page.evaluate((p) => !!state[p], prop);
        await page.evaluate((c) => window.__host('cmd:' + c), cmd);
        const c2 = await page.evaluate((p) => !!state[p], prop);
        check(b === !a && c2 === a, cmd + ' turns it on and back off', [a, b, c2]);
    }
    const focusClass = await page.evaluate(() => { window.__host('cmd:toggle_focus'); const on = editor.classList.contains('focus-mode'); window.__host('cmd:toggle_focus'); return on; });
    check(focusClass, 'focus mode dims the page (focus-mode class)');

    console.log('\n=== choosing a theme applies its colours ===');
    // The host sends the shipped themes at start-up (init_themes:), then a choice (set_theme:).
    const themes = JSON.parse(fs.readFileSync(path.join(appDir, 'TypoZen_Themes.json'), 'utf8'));
    const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return 'rgb(' + (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')'; };
    await page.evaluate((j) => window.__host('init_themes:' + j), JSON.stringify(themes));
    await settled(page);
    for (const name of ['Gruvbox', themes.find(t => /latte|light|paper/i.test(t.Name) && t.Bg !== themes[0].Bg).Name]) {
        const i = themes.findIndex(t => t.Name === name);
        await page.evaluate((k) => window.__host('set_theme:' + k), i);
        await settled(page);
        const got = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, name: state.themeName }));
        check(got.name === name && got.bg === rgb(themes[i].Bg), 'theme ' + name + ' gives the page its background ' + themes[i].Bg, got);
    }

    console.log('\n=== Export as HTML carries the document ===');
    await page.evaluate((d) => { handleCommand('view_set:mode:preview'); loadMarkdownContent(d); window.__sent.length = 0; window.__host('export_html'); }, RICH);
    const html = await page.evaluate(() => (window.__sent.find(m => m.startsWith('export_html_content:')) || '').slice(20));
    check(/<h1[^>]*>\s*Head\s*<\/h1>/.test(html) && /<strong>bold<\/strong>/.test(html) && /<a [^>]*href="https:\/\/example\.com"/.test(html)
        && /<li[^>]*>\s*one/.test(html) && /<table/.test(html) && /Last\./.test(html),
        'the heading, bold, link, list, table and last line are all in it', html.slice(0, 300));
} finally {
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('\nBASIC FEATURES BROWSER FAILED'); process.exit(1); }
console.log('\nBASIC FEATURES BROWSER PASSED');
process.exit(0);
