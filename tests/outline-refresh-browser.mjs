/**
 * The sidebar outline follows the headings, and only the headings.
 *
 *   - typing a new heading in Preview puts it in the outline
 *   - moving the caret or typing ordinary text does not rebuild the outline list (it used
 *     to be thrown away and rebuilt after every stats pass, including caret moves)
 *   - editing a heading and arrowing away updates its entry
 *   - Source still builds its own outline
 *
 *   node tests/outline-refresh-browser.mjs
 */
import fs from 'fs';
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

const outlineTitles = (page) => page.evaluate(() =>
    [...document.querySelectorAll('#outline-list .outline-item')].map(e => e.innerText));
// Stats run debounced, then the outline 250 ms after: wait past both.
const afterStats = (page) => new Promise(r => setTimeout(r, 1100)).then(() => settled(page));

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
        const hasList = await page.evaluate(() => !!document.getElementById('outline-list'));
        assert(hasList, 'outline list exists');

        console.log('\n=== Preview: headings in, headings out, nothing else rebuilds ===');
        await page.evaluate(() => loadMarkdownContent('# Alpha\n\nFirst paragraph.\n\n# Beta\n\nSecond paragraph.'));
        await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
        await settled(page);
        await page.evaluate(() => updateOutline());
        assert(JSON.stringify(await outlineTitles(page)) === '["Alpha","Beta"]', 'starts with Alpha, Beta');

        // Mark the current list; a rebuild replaces its children.
        await page.evaluate(() => { document.querySelector('#outline-list .outline-item').__mark = 1; });
        const para = await page.$$('#editor .block');
        await para[1].click();
        await page.keyboard.press('End');
        await page.keyboard.type(' More words.');
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
        await afterStats(page);
        const kept = await page.evaluate(() => {
            const f = document.querySelector('#outline-list .outline-item');
            return !!(f && f.__mark === 1);
        });
        assert(kept, 'typing in a paragraph and moving the caret left the outline list alone');

        // A new heading: Enter at the end of the paragraph, then type one.
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('## Gamma');
        await page.keyboard.press('Enter');
        await afterStats(page);
        let titles = await outlineTitles(page);
        assert(JSON.stringify(titles) === '["Alpha","Gamma","Beta"]', 'a typed heading appears in place (got ' + JSON.stringify(titles) + ')');

        // Edit an existing heading, then leave it by arrowing into the next block.
        const alpha = (await page.$$('#editor .block'))[0];
        await alpha.click();
        await page.keyboard.press('End');
        await page.keyboard.type('Z');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await afterStats(page);
        titles = await outlineTitles(page);
        assert(titles[0] === 'AlphaZ', 'editing a heading and arrowing away updates it (got ' + JSON.stringify(titles) + ')');

        console.log('\n=== Source builds its own outline ===');
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await settled(page);
        await page.evaluate(() => updateOutline());
        titles = await outlineTitles(page);
        assert(titles.includes('Gamma') && titles.includes('AlphaZ'), 'Source outline lists the headings (' + JSON.stringify(titles) + ')');
        await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
        await settled(page);
        await afterStats(page);
        titles = await outlineTitles(page);
        assert(titles.includes('Gamma'), 'back in Preview the outline is still right (' + JSON.stringify(titles) + ')');

        console.log('\n=== cost of one stats pass + outline refresh, 1 MB ===');
        const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8').repeat(5);
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await settled(page);
        await page.evaluate(() => updateOutline());
        const ms = await page.evaluate(() => {
            const refresh = typeof updateOutlineIfHeadingsChanged === 'function'
                ? updateOutlineIfHeadingsChanged : updateOutline;
            const t = performance.now();
            for (let i = 0; i < 10; i++) { _contentCache = null; updateStatsNow(); refresh(); }
            return (performance.now() - t) / 10;
        });
        info(md.length + ' chars: ' + ms.toFixed(1) + ' ms per stats pass + outline refresh');
    } finally {
        await browser.close();
    }
    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.log('\nOUTLINE REFRESH BROWSER FAILED'); process.exit(1); }
    console.log('\nOUTLINE REFRESH BROWSER PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
