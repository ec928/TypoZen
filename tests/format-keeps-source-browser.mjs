/**
 * Bold, italic, strike and code change the selection and nothing else in the line.
 *
 * The marks model behind them holds text and those marks only, so writing a line back from it
 * deleted link addresses, images and code marks from the whole line (found 2026-10-30, strike off
 * and Ctrl+B in Source). Strike off in a table wrote ~~ into its separator row. In the gate.
 *
 *   node tests/format-keeps-source-browser.mjs
 *   TZ_APP_DIR=path node tests/format-keeps-source-browser.mjs     another build, as a control
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;
const same = (msg, got, want) => {
    if (got === want) { passed++; return; }
    failed++;
    console.error('  FAIL ' + msg + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want));
};
const RICH = 'Top.\n\nalpha WORD **b** [t](https://e.com/a_b "T") ![p](a.png) `c  d` __u__ omega\n\nEnd.';
const LINES = [RICH,
    'Top.\n\n   * alpha WORD omega\n\nEnd.',
    'Top.\n\n- [x] alpha WORD omega\n\nEnd.',
    'Top.\n\n## alpha WORD omega ##\n\nEnd.',
    'Top.\n\n> alpha WORD omega\n\nEnd.',
    'Top.\n\n| h | i |\n|:--|--:|\n| alpha WORD omega | y |\n\nEnd.',
];
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 15000 });
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
    await sleep(450);       // the startup caret timer
    const load = async (d) => { await page.evaluate((d) => { localStorage.clear(); handleCommand('view_set:mode:preview'); loadMarkdownContent(d); }, d); await sleep(100); };
    const md = () => page.evaluate(() => getMarkdownContent(false));
    const selectWord = async () => {
        const pt = await page.evaluate(() => {
            const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
            let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('WORD') < 0) {}
            const r = document.createRange(); r.setStart(t, t.nodeValue.indexOf('WORD')); r.setEnd(t, t.nodeValue.indexOf('WORD'));
            const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 };
        });
        await page.mouse.click(pt.x, pt.y);
        await sleep(40);
        await page.evaluate(() => {
            const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
            let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('WORD') < 0) {}
            const at = t.nodeValue.indexOf('WORD');
            const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + 4);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        });
        await sleep(30);
    };
    const fmt = async (c) => { await page.evaluate((c) => window.__host('fmt:' + c), c); await sleep(70); };
    const MARK = { bold: '**', italic: '*', strike: '~~' };
    for (const doc of LINES) for (const cmd of ['bold', 'italic', 'strike']) {
        await load(doc);
        await selectWord();
        await fmt(cmd);
        same(cmd + ' on keeps the rest', await md(), doc.replace('WORD', MARK[cmd] + 'WORD' + MARK[cmd]));
        await selectWord();
        await fmt(cmd);
        same(cmd + ' off gives the line back', await md(), doc);
    }
    // Source mode: positions in the raw line, marks before the selection.
    for (const doc of [RICH, 'Top.\n\n**b** *i* WORD omega\n\nEnd.', 'Top.\n\n- [x] **b** WORD omega\n\nEnd.']) {
        await load(doc);
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await sleep(300);
        await page.evaluate(() => { const se = sourceEditor; const a = se.value.indexOf('WORD'); se.focus(); se.setSelectionRange(a, a + 4); });
        await sleep(40);
        await page.keyboard.down('Control'); await page.keyboard.press('b'); await page.keyboard.up('Control');
        await sleep(100);
        same('Ctrl+B in Source', await page.evaluate(() => sourceEditor.value), doc.replace('WORD', '**WORD**'));
    }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
