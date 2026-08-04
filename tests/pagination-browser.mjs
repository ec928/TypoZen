/**
 * Pagination is a real page model, not scrolling by a bit (Phase 4).
 *
 * These are the checks that would have caught what shipped: 1-column "pagination" was
 * scrollBy(window.innerHeight * 0.9) with smooth behaviour, so pages were never aligned
 * to anything, Page Down did not land on a boundary, and turning back stuttered because
 * there was no boundary to return to. Nothing asserted that a page turn produced a page.
 *
 * The properties that make pagination pagination:
 *   - a page map exists, with more than one page, in both layouts
 *   - forward then back returns to exactly the same offset (no accumulated drift)
 *   - repeated turns land on mapped offsets, never between pages
 *   - a page turn actually changes what is on screen
 *   - page boundaries do not slice a block in half
 *
 *   node tests/pagination-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pageState() {
    const ed = document.getElementById('editor');
    const main = document.getElementById('main-container');
    const twoCol = ed.classList.contains('two-col-layout');
    PageMap.ensure();
    const host = (twoCol ? ed : main).getBoundingClientRect();
    const visible = [];
    ed.querySelectorAll('.block').forEach(b => {
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) return;
        if (r.right <= host.left + 1 || r.left >= host.right - 1) return;
        const mi = DocumentModel.modelIndexOfEl(b);
        if (mi >= 0) visible.push(mi);
    });
    visible.sort((a, b) => a - b);
    return {
        layout: PageMap.layout,
        pageCount: PageMap.pages.length,
        current: PageMap.current(),
        offset: Math.round(twoCol ? (ed.scrollLeft || 0) : (main.scrollTop || 0)),
        offsets: PageMap.pages.map(p => Math.round(p.offset)),
        visible: visible
    };
}

async function checkLayout(page, label) {
    console.log('\n=== ' + label + ' ===');
    let s = await page.evaluate(pageState);
    info('map: ' + s.pageCount + ' pages, currently ' + s.current);
    assert(s.pageCount > 1, label + ': the page map has more than one page (' + s.pageCount + ')');

    // Turn forward three pages; each must land exactly on a mapped offset.
    const seen = [];
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => PageMap.step(1));
        await sleep(220);
        s = await page.evaluate(pageState);
        seen.push({ page: s.current, offset: s.offset, first: s.visible[0] });
        assert(s.offsets.indexOf(s.offset) !== -1,
            label + ': turn ' + (i + 1) + ' lands on a page boundary (offset ' + s.offset + ')');
    }
    info('forward: ' + seen.map(x => 'p' + x.page + '@' + x.offset).join(' -> '));

    assert(seen[0].page < seen[1].page && seen[1].page < seen[2].page,
        label + ': each turn advances exactly one page');
    assert(seen[0].first !== seen[2].first,
        label + ': turning pages changes what is on screen');

    // Forward then back must return to the identical offset. The old scrollBy path
    // could not: a fractional nudge with smooth scrolling never retraces itself.
    const before = await page.evaluate(pageState);
    await page.evaluate(() => PageMap.step(1));
    await sleep(220);
    await page.evaluate(() => PageMap.step(-1));
    await sleep(220);
    const after = await page.evaluate(pageState);
    assert(after.offset === before.offset,
        label + ': forward then back returns to the same offset (' + after.offset + ' vs ' + before.offset + ')');
    assert(after.current === before.current,
        label + ': forward then back returns to the same page');

    // Ten turns, still exactly on boundaries: proves nothing accumulates.
    for (let i = 0; i < 10; i++) { await page.evaluate(() => PageMap.step(1)); }
    await sleep(400);
    s = await page.evaluate(pageState);
    assert(s.offsets.indexOf(s.offset) !== -1,
        label + ': still exactly on a boundary after ten turns (offset ' + s.offset + ')');
    return s;
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1600, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await sleep(1800);

        // Reader forces Pagination, which is what is being tested.
        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await sleep(900);

        await checkLayout(page, '1-column pagination');

        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await sleep(1800);
        await checkLayout(page, '2-column pagination');

        console.log('\n=== page boundaries respect blocks ===');
        const split = await page.evaluate(() => {
            // In 1 column a page must start at the top of a block, never mid-block.
            handleCommand('view_set:columns:1');
            return null;
        });
        await sleep(1500);
        // Measured, not derived. Comparing each page offset against prefixHeight() would
        // be circular -- the map is built from prefixHeight, so it can only agree with
        // itself. Turn to a page and measure where the block really rendered.
        // Behaviour, not internals: go to a page, then ask which page the block now at the
        // top of the screen reports itself to be on. Those must agree, or navigation and
        // lookup disagree and a column switch cannot land anywhere sensible.
        const bounds = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const bad = [];
            for (const i of [1, 2, 3, 5, 8]) {
                if (i >= PageMap.count()) continue;
                PageMap.goto(i);
                await sleep(250);
                const top = topLeftModelIndexTwoCol();
                if (top < 0) { bad.push({ page: i, why: 'nothing visible' }); continue; }
                const reported = PageMap.pageOfBlock(top);
                if (reported !== i) bad.push({ page: i, topBlock: top, reportedPage: reported });
            }
            return { pages: PageMap.count(), bad: bad };
        });
        assert(bounds.bad.length === 0,
            'the block on screen agrees with the page we navigated to (' + bounds.pages +
            ' pages' + (bounds.bad.length ? ', bad: ' + JSON.stringify(bounds.bad) : '') + ')');

        console.log('\n=== switching layouts always lands ON a page ===');
        {
            // Both reported symptoms in one check. Restoring the caret focuses a block, and
            // focusing inside a horizontally scrolled multi-column container makes the
            // browser scroll it into view -- which parked the view between two pages,
            // showing half of each. Every switch must finish on a stored boundary, and on
            // the page that holds what the reader was looking at.
            const snap = () => page.evaluate(() => {
                const sl = Math.round(editor.scrollLeft || 0);
                const w = Math.round(PageMap.width());
                return {
                    cols: getComputedStyle(document.getElementById('editor')).columnCount,
                    scrollLeft: sl,
                    scrollTop: Math.round(editor.scrollTop || 0),
                    onBoundary: (sl % w) < 2,
                    page: PageMap.current(),
                    topBlock: topLeftModelIndexTwoCol()
                };
            });

            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await sleep(2500);
            await page.evaluate(() => { PageMap.step(1); });
            await sleep(300);
            await page.evaluate(() => { PageMap.step(1); });
            await sleep(600);
            const two = await snap();
            info('2-col page ' + two.page + ', top block ' + two.topBlock);
            assert(two.onBoundary, '2-column sits exactly on a page boundary after turning pages');

            await page.evaluate(() => handleCommand('view_set:columns:1'));
            await sleep(3000);
            const one = await snap();
            info('1-col page ' + one.page + ', top block ' + one.topBlock);
            assert(one.cols === '1', 'switched to a single column');
            assert(one.onBoundary,
                'switching to 1-column lands exactly on a page boundary, not between two (scrollLeft ' +
                one.scrollLeft + ')');
            assert(one.scrollTop === 0,
                'a page never scrolls vertically, so no diagonal half-page offset');
            // The block that was on screen before must be on the page now shown. Not
            // necessarily at the top: pages begin where the layout breaks, so arriving
            // partway down a page is correct.
            const holds = await page.evaluate((b) => PageMap.pageOfBlock(b), two.topBlock);
            assert(holds === one.page,
                'the page shown holds what was on screen before (block ' + two.topBlock +
                ' is on page ' + holds + ', showing page ' + one.page + ')');

            // And back again returns to where it started.
            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await sleep(3000);
            const back = await snap();
            assert(back.page === two.page && back.topBlock === two.topBlock,
                'switching back returns to the same page and content (page ' + back.page +
                ' vs ' + two.page + ', block ' + back.topBlock + ' vs ' + two.topBlock + ')');
        }

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) {
            console.error('\nPAGINATION FAILED');
            process.exitCode = 1;
            return;
        }
        console.log('\nPAGINATION PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
