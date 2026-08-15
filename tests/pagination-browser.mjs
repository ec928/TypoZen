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
import { settled } from './settle.mjs';

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
        await settled(page);
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
    await settled(page);
    await page.evaluate(() => PageMap.step(-1));
    await settled(page);
    const after = await page.evaluate(pageState);
    assert(after.offset === before.offset,
        label + ': forward then back returns to the same offset (' + after.offset + ' vs ' + before.offset + ')');
    assert(after.current === before.current,
        label + ': forward then back returns to the same page');

    // Ten turns, still exactly on boundaries: proves nothing accumulates.
    for (let i = 0; i < 10; i++) { await page.evaluate(() => PageMap.step(1)); }
    await settled(page);
    s = await page.evaluate(pageState);
    if (s.offsets.indexOf(s.offset) === -1) {
        const near = s.offsets.filter(o => Math.abs(o - s.offset) < 4000);
        console.log('  ..   offset ' + s.offset + ', page ' + s.current + ' of ' +
            s.offsets.length + ', nearby boundaries ' + JSON.stringify(near));
    }
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
        await settled(page);

        // Reader forces Pagination, which is what is being tested.
        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await settled(page);

        await checkLayout(page, '1-column pagination');

        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await settled(page);
        await checkLayout(page, '2-column pagination');

        console.log('\n=== page boundaries respect blocks ===');
        const split = await page.evaluate(() => {
            // In 1 column a page must start at the top of a block, never mid-block.
            handleCommand('view_set:columns:1');
            return null;
        });
        await settled(page);
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
                // Rendered columns, not the computed property: the geometry is driven by a
                // pixel column-width now, so column-count reads auto in both layouts.
                const ed = document.getElementById('editor');
                const edLeft = ed.getBoundingClientRect().left;
                const paneW = ed.clientWidth;
                const lefts = new Set();
                for (const b of ed.querySelectorAll('.block')) {
                    for (const r of b.getClientRects()) {
                        if (r.width <= 0 || r.height <= 0) continue;
                        const x = r.left - edLeft;
                        if (x >= -2 && x < paneW - 2) lefts.add(Math.round(x));
                    }
                }
                return {
                    cols: String(lefts.size),
                    scrollLeft: sl,
                    scrollTop: Math.round(editor.scrollTop || 0),
                    onBoundary: (sl % w) < 2,
                    page: PageMap.current(),
                    topBlock: topLeftModelIndexTwoCol()
                };
            });

            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await settled(page);
            await page.evaluate(() => { PageMap.step(1); });
            await settled(page);
            await page.evaluate(() => { PageMap.step(1); });
            await settled(page);
            const two = await snap();
            info('2-col page ' + two.page + ', top block ' + two.topBlock);
            assert(two.onBoundary, '2-column sits exactly on a page boundary after turning pages');

            await page.evaluate(() => handleCommand('view_set:columns:1'));
            await settled(page);
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
            //
            // CONTENT is the promise and is checked exactly: the reader must land on the
            // block they were reading. The page NUMBER is allowed to move by one while the
            // map is still part estimate, and that is not slack invented to get a pass --
            // switching columns invalidates every measurement, so the number that was
            // MEASURED at 21 on the way out is ESTIMATED on the way back. Measured against
            // estimated, one page in twenty-one, on a document the application is already
            // labelling "~" for exactly this reason (pageTotalIsApproximate). Demanding
            // equality here is demanding that an estimate agree with a measurement.
            //
            // Once every range has been laid out the estimate is gone and the number is
            // exact; that is what page-count-truth-app asserts, against a settled map.
            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await settled(page);
            const back = await snap();
            const settledMap = await page.evaluate(() => PageChunks.allMeasured());
            const drift = Math.abs(back.page - two.page);
            assert(back.topBlock === two.topBlock,
                'switching back returns to the same content (block ' + back.topBlock +
                ' vs ' + two.topBlock + ')');
            assert(settledMap ? drift === 0 : drift <= 1,
                'and to the same page, within the estimate still in the map (page ' +
                back.page + ' vs ' + two.page + ', map ' +
                (settledMap ? 'fully measured' : 'part estimated') + ')');
        }

        console.log('\n=== pages are not left mostly blank ===');
        {
            // A <pre> with overflow-x: auto is a scroll container, and a scroll container
            // cannot be fragmented across a column break. A code fence only slightly taller
            // than the column therefore moved wholesale to the next one and left most of a
            // page empty behind it -- on the test document, 50 blocks were taller than the
            // 780px column, the worst by 11px. Paginated fences now wrap instead.
            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await settled(page);

            const tall = await page.evaluate(() => {
                const colH = editor.clientHeight;
                let over = 0, maxH = 0;
                editor.querySelectorAll('.block').forEach(b => {
                    const h = b.getBoundingClientRect().height;
                    if (h > maxH) maxH = h;
                    // A fragmented block's rect spans its pieces, so compare against the
                    // page rather than the column.
                    if (h > colH * 2 + 4) over++;
                });
                return { colH: colH, maxH: Math.round(maxH), over: over };
            });
            assert(tall.over === 0,
                'no block is taller than a whole page (' + tall.over + ' over ' +
                (tall.colH * 2) + 'px)');

            const empt = await page.evaluate(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const cap = editor.getBoundingClientRect().height * 2;
                let worst = { page: -1, fill: 1e9 };
                for (let p = 0; p < Math.min(PageMap.count(), 48); p += 4) {
                    PageMap.goto(p);
                    await sleep(40);
                    const host = editor.getBoundingClientRect();
                    let filled = 0;
                    editor.querySelectorAll('.block').forEach(b => {
                        const r = b.getBoundingClientRect();
                        if (r.bottom <= host.top || r.top >= host.bottom) return;
                        if (r.right <= host.left || r.left >= host.right) return;
                        filled += r.height;
                    });
                    const frac = filled / cap;
                    if (frac < worst.fill) worst = { page: p, fill: frac };
                }
                return worst;
            });
            assert(empt.fill > 0.5,
                'no sampled page is left mostly blank (emptiest was page ' + empt.page +
                ' at ' + Math.round(empt.fill * 100) + '% full)');
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
