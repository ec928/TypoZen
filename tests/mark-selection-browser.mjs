/**
 * Highlight selection makes one mark: the highlight, and nothing else.
 *
 * The Marks button acts on mousedown (before focus collapses the selection) and again on
 * click. The click found the selection already gone and fell through to "Mark this
 * paragraph", bookmarking whichever paragraph was at the top of the view as well
 * (Ed, 2026-10-06: highlighting "Highlights" also marked "Requirements..." above it).
 *
 *   node tests/mark-selection-browser.mjs
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

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
        await page.evaluate(() => loadMarkdownContent(
            'Requirements: an earlier paragraph at the top of the view.\n\n---\n\n## Highlights\n\nWriting follows here.'));
        await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
        await settled(page);
        await page.click('.sidebar-tab[data-tab="marks"]');
        await settled(page);

        console.log('=== select a word, press Highlight selection ===');
        // Select the heading's text: click into it, then Home, Shift+End.
        const h = await page.$$eval('#editor .block', bs => bs.findIndex(b => /Highlights/.test(b.textContent)));
        const blocks = await page.$$('#editor .block');
        const box = await blocks[h].boundingBox();
        await page.mouse.click(box.x + 40, box.y + box.height / 2);
        await settled(page);
        await page.keyboard.press('Home');
        await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift');
        await settled(page);
        const selected = await page.evaluate(() => String(window.getSelection()));
        assert(/Highlights/.test(selected), 'the word is selected (' + JSON.stringify(selected) + ')');
        const label = await page.$eval('#markAddBtn', b => b.lastElementChild.textContent);
        assert(label === 'Highlight selection', 'the button offers to highlight it (' + label + ')');
        await page.click('#markAddBtn');
        await settled(page);
        const marks = await page.evaluate(() => _marks.map(m => ({ block: m.block, ranged: m.s != null })));
        assert(marks.length === 1, 'exactly one mark (got ' + JSON.stringify(marks) + ')');
        assert(marks.length >= 1 && marks[0].ranged && marks[0].block === h, 'and it is the highlight on that word');

        console.log('\n=== with nothing selected the button still marks the paragraph ===');
        await page.evaluate(() => { window.getSelection().removeAllRanges(); });
        const p = await page.$$('#editor .block');
        await p[p.length - 1].click();
        await settled(page);
        const before = await page.evaluate(() => _marks.length);
        await page.click('#markAddBtn');
        await settled(page);
        const after = await page.evaluate(() => _marks.length);
        assert(after === before + 1, 'Mark this paragraph adds one mark (' + before + ' -> ' + after + ')');
    } finally {
        await browser.close();
    }
    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.log('\nMARK SELECTION BROWSER FAILED'); process.exit(1); }
    console.log('\nMARK SELECTION BROWSER PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
