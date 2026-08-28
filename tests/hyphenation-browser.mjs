/**
 * Justified text is hyphenated, and ragged-right is not.
 *
 * Only a browser can judge this, and it has to be judged by what was drawn. `hyphens: auto`
 * is not an error when it does nothing -- it is simply inert without a language, so the CSS
 * reads as switched on, the computed style agrees, and no word is ever broken. Asserting on
 * getComputedStyle would pass in exactly the case worth catching.
 *
 * So the measurement is a long word in a column too narrow to hold it. Hyphenated, it
 * breaks across lines and the paragraph is two lines tall; unhyphenated it stays whole and
 * overflows on one. Line count is the visible difference between the feature working and
 * appearing to.
 *
 *   node tests/hyphenation-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/**
 * Height of one paragraph of a single long word, in a narrow box, in line boxes.
 *
 * Measured inside #editor so it inherits the real rules rather than a copy of them --
 * except for overflow-wrap, which .block sets to break-word and which would otherwise
 * answer the question for us. That rule breaks an overlong word at any character when it
 * cannot fit, so the probe read three lines whether hyphenation was on or off and the
 * suite could not tell the feature from its absence. Turning it off here leaves
 * hyphenation as the only thing that can break the word, which is the point.
 *
 * It is not a change to how the app wraps: a browser prefers a hyphenation opportunity to
 * an emergency break, so break-word still only catches words hyphenation cannot help.
 */
const measure = (word) => {
    const ed = document.getElementById('editor');
    const p = document.createElement('p');
    p.className = 'block';
    p.textContent = word;
    p.style.width = '80px';
    p.style.margin = '0';
    p.style.overflowWrap = 'normal';
    p.style.wordBreak = 'normal';
    ed.appendChild(p);
    const lineH = parseFloat(getComputedStyle(p).lineHeight) || 20;
    const lines = Math.round(p.getBoundingClientRect().height / lineH);
    const style = getComputedStyle(p).hyphens;
    p.remove();
    return { lines, style };
};

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    await page.evaluate(() => loadMarkdownContent('# Hyphenation\n\nA paragraph.\n'));
    await settled(page);

    // A word English hyphenation definitely breaks, and long enough to clear the 6/3/3
    // limits set in typozen.css.
    const WORD = 'incomprehensibility';

    console.log('\n=== ragged right leaves words whole ===');
    await page.evaluate(() => handleCommand('set_justify:0'));
    await settled(page);
    const off = await page.evaluate(measure, WORD);
    info('hyphens: ' + off.style + ', "' + WORD + '" occupies ' + off.lines + ' line(s)');
    assert(off.style === 'manual', 'the computed value is manual when not justified');
    assert(off.lines === 1, 'the word is not broken (' + off.lines + ' line)');

    console.log('\n=== justified breaks them ===');
    await page.evaluate(() => handleCommand('set_justify:1'));
    await settled(page);
    const on = await page.evaluate(measure, WORD);
    info('hyphens: ' + on.style + ', "' + WORD + '" occupies ' + on.lines + ' line(s)');
    assert(on.style === 'auto', 'the computed value is auto when justified');
    // The real assertion: not what CSS says, but that the word actually broke.
    assert(on.lines > off.lines,
        'the word is hyphenated across lines (' + off.lines + ' -> ' + on.lines + ')');

    console.log('\n=== and it goes back ===');
    await page.evaluate(() => handleCommand('set_justify:0'));
    await settled(page);
    const back = await page.evaluate(measure, WORD);
    info('hyphens: ' + back.style + ', ' + back.lines + ' line(s)');
    assert(back.lines === off.lines,
        'turning Justified off stops hyphenating too (' + back.lines + ')');

    console.log('\n=== the page declares a language, or none of it works ===');
    const lang = await page.evaluate(() => ({
        html: document.documentElement.lang,
        editor: document.getElementById('editor').getAttribute('lang')
    }));
    info('html lang="' + lang.html + '", #editor lang=' + JSON.stringify(lang.editor));
    assert(!!lang.html, 'the page declares a language for Markdown documents');
    assert(lang.editor === null,
        'and #editor does not override it until a book says otherwise');
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'HYPHENATION FAILED' : 'HYPHENATION PASSED');
process.exit(failed ? 1 : 0);
