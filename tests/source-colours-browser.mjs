/**
 * Source highlights Markdown and code in Preview's colours, and plain text not at all.
 *
 * docs/codemirror-source-plan.md, Phase 3 and decisions 2-3. Markdown is parsed by
 * CodeMirror and drawn with tzmd-* classes whose CSS is Preview's own rules; code -- a
 * file of a code type, or a fenced block -- is drawn with tzcode-* classes from
 * 08-code.js's lexers, the same colours Preview's code blocks use. The document's type
 * arrives from the host as doc_ext: (setSourceDocExt) before each load.
 *
 * Checks the classes land on the right text and resolve to the theme's variables -- the
 * colours themselves are the theme's, so "right" means "the variable Preview uses".
 *
 *   node tests/source-colours-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const MD = [
    '# Title here',
    '',
    'Some **bold words** and *italic words*, ~~struck~~, `inline code` and a [link text](https://example.com).',
    '',
    '> a quoted line',
    '',
    '- a list item',
    '',
    '```json',
    '{ "key": "value", "n": 42 }',
    '```',
    '',
    'after'
].join('\n');

const deadline = setTimeout(() => { console.error('DEADLINE'); process.exit(3); }, 60000);
const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof finishLoadContent === 'function', { timeout: 15000 });
    assert((await page.evaluate(() => window.__tzSourceEngine)) === 'codemirror', 'Source is on CodeMirror');

    // Load as the host does: doc_ext first, then the text.
    const load = async (ext, text, plain) => {
        await page.evaluate((e, t, p) => {
            setSourceDocExt(e);
            finishLoadContent(t, false, p);
            if (!p) handleCommand('view_set:mode:source');
        }, ext, text, plain);
        await page.waitForFunction(() => state.mode === 'source', { timeout: 5000 });
    };
    const classText = (cls) => page.evaluate((c) => Array.from(document.querySelectorAll('#source-cm .' + c)).map(e => e.textContent), cls);

    console.log('=== Markdown ===');
    await load('md', MD, false);
    await page.waitForFunction(() => !!document.querySelector('#source-cm .tzmd-h1') && !!document.querySelector('#source-cm .tzcode-string'),
        { timeout: 5000 }).catch(() => { });
    const has = async (cls, text, what) => {
        const got = await classText(cls);
        assert(got.some(s => s.includes(text)), what + ' (' + cls + ' on "' + text + '")');
    };
    await has('tzmd-h1', 'Title here', 'the heading');
    await has('tzmd-mark', '#', 'the heading marker is muted');
    await has('tzmd-strong', 'bold words', 'bold');
    await has('tzmd-mark', '**', 'the bold markers are muted');
    await has('tzmd-em', 'italic words', 'italic');
    await has('tzmd-del', 'struck', 'strikethrough');
    await has('tzmd-code', 'inline code', 'inline code');
    await has('tzmd-link', 'link text', 'link text');
    await has('tzmd-url', 'https://example.com', 'the link address');
    await has('tzmd-quote', 'a quoted line', 'the quote');
    await has('tzmd-mark', '-', 'the list marker');
    const fence = await page.evaluate(() => Array.from(document.querySelectorAll('#source-cm .cm-line.tzmd-fence')).map(e => e.textContent));
    info('fence lines: ' + JSON.stringify(fence));
    assert(fence.length === 3 && fence[0].startsWith('```json') && fence[2] === '```', 'the fenced block\'s three lines are tinted');
    await has('tzcode-string', '"value"', 'a string inside the fence, by 08-code.js\'s json lexer');
    await has('tzcode-number', '42', 'a number inside the fence');
    assert((await classText('tzcode-string')).every(s => !s.includes('after')), 'nothing outside the fence is lexed');

    console.log('=== the colours are Preview\'s variables ===');
    const c = await page.evaluate(() => {
        const probe = (varName) => { const d = document.createElement('span'); d.style.color = 'var(' + varName + ')'; document.body.appendChild(d); const v = getComputedStyle(d).color; d.remove(); return v; };
        // The text's span, not a marker's: `#` and `[` carry the heading and link classes
        // too, and are muted on purpose.
        const cs = (sel) => getComputedStyle(document.querySelector('#source-cm ' + sel
            + (sel === '.tzmd-mark' ? '' : ':not(.tzmd-mark):not(.tzmd-url)')));
        const base = parseFloat(getComputedStyle(document.querySelector('#source-cm .cm-content')).fontSize);
        return {
            accent: probe('--accent'), muted: probe('--tx-muted'), tx: probe('--tx'),
            link: cs('.tzmd-link').color, mark: cs('.tzmd-mark').color, h1: cs('.tzmd-h1').color,
            h1Size: parseFloat(cs('.tzmd-h1').fontSize) / base, h1Weight: cs('.tzmd-h1').fontWeight,
            strongWeight: cs('.tzmd-strong').fontWeight, emStyle: cs('.tzmd-em').fontStyle,
            codeFont: cs('.tzmd-code').fontFamily
        };
    });
    info(JSON.stringify(c));
    assert(c.link === c.accent, 'link text is the accent, as Preview\'s links are');
    assert(c.mark === c.muted, 'markers are --tx-muted');
    assert(c.h1 === c.tx && Math.abs(c.h1Size - 2.2) < 0.05 && Number(c.h1Weight) >= 700, 'a level-1 heading is Preview\'s: text colour, 2.2em, bold');
    assert(Number(c.strongWeight) >= 700 && c.emStyle === 'italic', 'bold is bold and italic is italic');
    assert(/Consolas|monospace/i.test(c.codeFont), 'code is in the code face');

    console.log('=== a code file ===');
    await load('css', '/* a note */\nbody { color: "red"; margin: 12px; }\n', true);
    await page.waitForFunction(() => !!document.querySelector('#source-cm .tzcode-comment'), { timeout: 3000 }).catch(() => { });
    await has('tzcode-comment', 'a note', 'a CSS comment');
    await has('tzcode-string', '"red"', 'a CSS string');
    assert((await classText('tzmd-h1')).length === 0 && (await classText('tzmd-mark')).length === 0, 'no Markdown styling on a code file');

    console.log('=== plain text ===');
    await load('txt', '# not a heading\n**not bold** "not a string" 42\n', true);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 100))));
    const plain = await page.evaluate(() => document.querySelectorAll('#source-cm [class*="tzmd-"], #source-cm [class*="tzcode-"]').length);
    assert(plain === 0, 'a .txt file has no highlighting at all (' + plain + ' styled spans)');

    console.log('=== back to Markdown ===');
    await load('md', MD, false);
    await page.waitForFunction(() => !!document.querySelector('#source-cm .tzmd-h1'), { timeout: 5000 }).catch(() => { });
    assert((await classText('tzmd-h1')).length > 0, 'highlighting returns with the next Markdown document');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SOURCE COLOURS FAILED'); process.exit(1); }
console.log('SOURCE COLOURS PASSED');
