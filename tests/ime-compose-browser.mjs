/**
 * Typing through an input method (Chinese, Japanese, Korean) in Source and Preview, headless.
 *
 * An IME builds a word in stages -- "ni", then "に", then the chosen "日本" -- and only the
 * last is committed. Editors that react to each stage duplicate or mangle the text. Source has
 * been CodeMirror since 0.8.4 and this had never been checked there (backlog, 2026-09-29).
 * DevTools' Input.imeSetComposition drives the same composition events a real IME does.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
const deadline = setTimeout(() => { console.error('IME: deadline'); try { browser.process().kill('SIGKILL'); } catch (e) {} process.exit(3); }, 45000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof finishLoadContent === 'function', { timeout: 15000 });
    const cdp = await page.target().createCDPSession();
    // Premise: the page must really see a composition, not just the final text.
    await page.evaluate(() => {
        window.__ime = { start: 0, update: 0, end: 0 };
        for (const k of ['start', 'update', 'end'])
            document.addEventListener('composition' + k, () => { window.__ime[k]++; }, true);
    });
    const compose = async () => {
        await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
        await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
        await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
        await cdp.send('Input.insertText', { text: '日本' });
        await new Promise(r => setTimeout(r, 300));
    };

    // Source
    await page.evaluate(async () => {
        setSourceDocExt('md'); handleCommand('view_set:mode:source');
        finishLoadContent('Hello world', false, false);
        await new Promise(r => setTimeout(r, 300));
        sourceEditor.focus(); sourceEditor.setSelectionRange(11, 11);
    });
    await compose();
    const src = await page.evaluate(() => sourceEditor.value);
    const ev = await page.evaluate(() => window.__ime);
    assert(ev.start >= 1 && ev.update >= 2 && ev.end >= 1, 'premise: Source received a real composition (' + JSON.stringify(ev) + ')');
    assert(src === 'Hello world日本', 'Source: a composed word is committed once, nothing left of its stages (' + JSON.stringify(src) + ')');

    // Preview
    await page.evaluate(async () => {
        handleCommand('view_set:mode:preview');
        finishLoadContent('Hello world', false, false);
        await new Promise(r => setTimeout(r, 400));
        const b = document.querySelector('#editor .block');
        const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); const n = w.nextNode();
        b.focus();
        const r = document.createRange(); r.setStart(n, n.nodeValue.length); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await compose();
    const pv = await page.evaluate(() => getMarkdownContent(false).trim());
    assert(pv === 'Hello world日本', 'Preview: a composed word is committed once, nothing left of its stages (' + JSON.stringify(pv) + ')');
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('IME COMPOSE FAILED'); process.exit(1); }
console.log('IME COMPOSE PASSED');
