/**
 * One code-fence rule, everywhere (2026-11-22).
 *
 * The rule was written out in some twenty places with five regexes, and they disagreed:
 * the block split took backticks only, while the Source line scanners and the edit helpers
 * also took "~~~" and any indent; the renderer and the serializer disagreed about which last
 * line closes a block; and the paste split was a drifted copy of the block split. Now
 * tzFenceOpen / tzFenceClose / tzFenceRaw / tzFenceLineStates / tzFenceAt (01-core.js) are
 * the rule, and this holds each place that disagreed to it.
 *
 *   node tests/fence-rule-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) { passed++; console.log('  OK   ' + msg); return; }
    failed++; console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}
const B = '```';
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));

    // The block split: what is one code block.
    const split = (t) => page.evaluate((x) => splitMarkdownToBlockRaws(x), t);
    same('a "~~~" scene break is prose, not a fence', await split('One\n~~~\nTwo'), ['One', '~~~', 'Two']);
    same('three spaces before a fence is a fence', (await split('   ' + B + '\nx\n   ' + B)).length, 1);
    same('four spaces is not', (await split('    ' + B + '\nx\n    ' + B)).length, 3);
    same('a "```js" line inside a block does not close it (as Source shows)', await split(B + '\na\n' + B + 'js\nb\n' + B + '\nafter'), [B + '\na\n' + B + 'js\nb\n' + B, 'after']);
    same('backticks with more backticks after them are inline code', await split('```` ```css ```` and\nnext'), ['```` ```css ```` and', 'next']);

    // In Source, the text after a "~~~" line is prose: Bold formats it.
    const boldAfter = await page.evaluate(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        setSourceDocExt('md'); handleCommand('view_set:mode:source'); loadMarkdownContent('Scene one.\n~~~\nScene two starts here.'); await wait(200);
        // A bare caret: the single-line path, which scanned the text above for fences.
        const v = sourceEditor.value; const at = v.indexOf('Scene two');
        sourceEditor.focus(); sourceEditor.setSelectionRange(at, at);
        freezeFormatSelection(); applyFormatting('h2'); await wait(80);
        const h = sourceEditor.value.split('\n')[2];
        loadMarkdownContent('Scene one.\n~~~\nScene two starts here.'); await wait(150);
        const v2 = sourceEditor.value; const at2 = v2.indexOf('starts') + 2;
        sourceEditor.focus(); sourceEditor.setSelectionRange(at2, at2);
        freezeFormatSelection(); applyFormatting('bold'); await wait(80);
        return { h, bold: sourceEditor.value.split('\n')[2] };
    });
    same('in Source, a caret after a "~~~" scene break: Heading applies', boldAfter.h, '## Scene two starts here.');
    same('and Bold applies', boldAfter.bold !== 'Scene two starts here.', true);

    // A paste of a table straight followed by a code block keeps their order.
    const pasted = await page.evaluate(async (b) => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:mode:preview'); loadMarkdownContent('Top\n\nEnd'); await wait(150);
        const blk = document.querySelector('#editor .block[data-model-index="1"]');
        const r = document.createRange(); r.selectNodeContents(blk); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        pasteLikeCtrlV('', '| a | b |\n|---|---|\n| 1 | 2 |\n' + b + '\ncode\n' + b, false); await wait(200);
        return getMarkdownContent(false);
    }, B);
    same('a pasted table then code block stay in that order', pasted.indexOf('| a | b |') >= 0 && pasted.indexOf('| a | b |') < pasted.indexOf(B + '\ncode'), true);

    // A "````" block left open with a "```" last line: that line is code, saved once.
    const doc = '````\ncode\n```';
    const saved = await page.evaluate(async (d) => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        loadMarkdownContent(d); await wait(150);
        const blk = document.querySelector('#editor .block');
        const code = blk.querySelector('pre code'); const t = code.firstChild;
        const r = document.createRange(); r.setStart(t, 0); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); editor.focus();
        return { shown: code.textContent };
    }, doc);
    same('a "```" last line of a "````" block is drawn as code', saved.shown.indexOf('```') >= 0, true);
    await page.keyboard.type('X'); await quiet();
    // A guard: this passed before the rules were merged too, but renderer and serializer
    // used different closing rules here, and now they share one.
    same('and after an edit it is saved once, not twice',await page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, '')), '````\nXcode\n```');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
