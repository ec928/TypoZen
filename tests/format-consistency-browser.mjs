/**
 * Every formatting command gives the same result in Preview and Source.
 *
 * Each command runs the way a menu runs it (freeze, then applyFormatting) on a caret, a word
 * selected with Shift+arrows, and a selection over two lines made with Shift+ArrowDown; then a
 * letter is typed. The saved text, and the text after the letter, must be the same in both
 * views. Bold, italic, strike and code over two lines mark what is selected, not the whole of
 * the first and last lines (Ed, 2026-11-14). (Found 2026-11-21: Source marked whole lines and
 * left them selected, so the next letter replaced both; Preview did the same with a keyboard
 * selection; Source left markers selected around a word, so typing over it dropped the bold.)
 *
 *   node tests/format-consistency-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { padPage, LARGE } from './large-pad.mjs';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (200 s)'); process.exit(1); }, 200000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; return; }
    failed++;
    console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const DOC = 'One two three\nFour five six\nSeven';
const CMDS = ['bold', 'italic', 'strike', 'code', 'h2', 'quote', 'list', 'ol', 'checklist', 'para', 'callout:note'];
const SITS = [['caret', 4, 4], ['word', 4, 7], ['2 lines', 4, -1]];
const RULE = {   // what is selected, over two lines
    bold: 'One **two three**\n**Four** five six\nSeven',
    italic: 'One *two three*\n*Four* five six\nSeven',
    strike: 'One ~~two three~~\n~~Four~~ five six\nSeven',
    code: 'One `two three`\n`Four` five six\nSeven'
};

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
try {
    const page = await browser.newPage();
    await padPage(page);   // cases in a long file first (large-pad.mjs)
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    await page.evaluate(() => { postMsg = function () {}; });
    const saved = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
    for (const cmd of CMDS) for (const [sit, a, b] of SITS) {
        const res = {};
        for (const mode of ['wysiwyg', 'source']) {
            await page.evaluate((m) => { setSourceDocExt('md'); loadMarkdownContent(m); }, DOC);
            await page.evaluate((m) => handleCommand('view_set:mode:' + m), mode);
            await settled(page);
            if (mode === 'source') {
                await page.evaluate((x) => { sourceEditor.focus(); sourceEditor.setSelectionRange(x, x); }, a);
            } else {
                const el = await page.$('#editor .block[data-model-index="0"]');
                await el.click(); await page.keyboard.press('Home');
                for (let i = 0; i < a; i++) await page.keyboard.press('ArrowRight');
            }
            await page.keyboard.down('Shift');
            if (b > a) for (let i = a; i < b; i++) await page.keyboard.press('ArrowRight');
            if (b < 0) await page.keyboard.press('ArrowDown');
            await page.keyboard.up('Shift');
            await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
            await settled(page);
            const out = await saved();
            await page.keyboard.type('Z');
            await settled(page);
            res[mode] = { out, typed: await saved() };
        }
        const label = cmd + ', ' + sit;
        same(label + ': Preview and Source write the same', res.wysiwyg.out, res.source.out);
        same(label + ': a letter typed next lands the same', res.wysiwyg.typed, res.source.typed);
        if (sit === '2 lines' && RULE[cmd]) {
            same(label + ': Preview marks what is selected', res.wysiwyg.out, RULE[cmd]);
            same(label + ': Source marks what is selected', res.source.out, RULE[cmd]);
        }
    }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
