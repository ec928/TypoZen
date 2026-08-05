/**
 * Column switching keeps the reader oriented (Phase 4), in a real browser.
 *
 * jsdom cannot judge any of this: it has no layout engine, so column-count never applies
 * and every rect is zero. Only Chrome can say what is actually on screen.
 *
 * Success criteria, per the goals document:
 *
 *   1-col -> 2-col   some of the text that was on screen is still visible, in either
 *                    column of the new page
 *   2-col -> 1-col   some of the text from the FIRST column is still visible
 *   round trip       switching back with no changes in between returns to the original
 *                    layout and position
 *
 * Deliberately about "can the reader still see what they were reading", not about exact
 * block indices: the two layouts break content differently, so demanding an exact anchor
 * would be inventing a requirement the user does not have.
 *
 *   node tests/twocol-anchoring-browser.mjs
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

/** Model indices of every block with any pixels on screen, and the page/scroll state. */
function visibleState() {
    const ed = document.getElementById('editor');
    const main = document.getElementById('main-container');
    const twoCol = ed.classList.contains('two-col-layout');
    const host = (twoCol ? ed : main).getBoundingClientRect();
    const vis = [];
    let firstColumn = [];
    ed.querySelectorAll('.block').forEach(b => {
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) return;
        if (r.right <= host.left + 1 || r.left >= host.right - 1) return;
        const mi = DocumentModel.modelIndexOfEl(b);
        if (mi < 0) return;
        vis.push(mi);
        // In 2 columns, "first column" is the left half of the visible page.
        if (!twoCol || r.left < host.left + host.width / 2) firstColumn.push(mi);
    });
    vis.sort((a, b) => a - b);
    firstColumn.sort((a, b) => a - b);
    return {
        twoCol: twoCol,
        visible: vis,
        firstColumn: firstColumn,
        page: twoCol ? (typeof currentTwoColPage !== 'undefined' ? currentTwoColPage : 0) : 0,
        scrollLeft: Math.round(ed.scrollLeft || 0),
        scrollTop: Math.round(main.scrollTop || 0)
    };
}

const overlap = (a, b) => a.filter(x => b.indexOf(x) !== -1);

/**
 * Wait until the layout has stopped moving, rather than guessing with a fixed sleep.
 *
 * This suite used to sleep 700-1800ms after each column switch. That is enough on an idle
 * machine and not enough when the build runs every browser suite back to back, so it
 * failed intermittently in full runs and passed every time standalone -- which is the
 * worst way for a gate to behave: it blocked four builds without ever indicating a real
 * defect, and would have hidden one just as easily.
 *
 * A column switch settles asynchronously by design: goToPageHoldingBlock retries until
 * editor.scrollWidth stops changing, so the only honest wait is for the same condition.
 * Three consecutive identical samples of the geometry that pagination is derived from.
 */
async function settled(page, timeoutMs = 8000) {
    const started = Date.now();
    let last = null;
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
        const now = await page.evaluate(() => {
            const ed = document.getElementById('editor');
            const main = document.getElementById('main-container');
            return [
                Math.round(ed.scrollWidth), Math.round(ed.scrollLeft),
                Math.round(ed.clientHeight), Math.round(ed.clientWidth),
                Math.round(main.scrollTop),
                (typeof PageMap !== 'undefined' && PageMap.count) ? PageMap.count() : -1
            ].join(',');
        });
        if (now === last) {
            if (++stable >= 3) return true;
        } else {
            stable = 0;
            last = now;
        }
        await sleep(120);
    }
    return false;
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

        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await settled(page);

        console.log('=== 1-col -> 2-col ===');
        // Read a way into the document, so this is not the trivial "everything at page 0".
        // Turn pages: Reader is paginated in both layouts now, so setting scrollTop does
        // nothing at all and the test never left page 0.
        await page.evaluate(() => { for (let i = 0; i < 6; i++) PageMap.step(1); });
        await settled(page);
        const oneColBefore = await page.evaluate(visibleState);
        info('1-col showing blocks ' + oneColBefore.visible[0] + '..' +
             oneColBefore.visible[oneColBefore.visible.length - 1]);

        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await settled(page);
        const twoColAfter = await page.evaluate(visibleState);
        info('2-col page ' + twoColAfter.page + ' showing blocks ' + twoColAfter.visible[0] + '..' +
             twoColAfter.visible[twoColAfter.visible.length - 1]);

        assert(twoColAfter.twoCol, 'the switch actually produced two columns');
        assert(overlap(oneColBefore.visible, twoColAfter.visible).length > 0,
            'text that was on screen in 1-col is still visible in 2-col (' +
            overlap(oneColBefore.visible, twoColAfter.visible).length + ' blocks in common)');

        console.log('\n=== 2-col -> 1-col ===');
        // Turn some pages so the return trip is not from page 0 either.
        await page.evaluate(() => { for (let i = 0; i < 2; i++) PageMap.step(1); });
        await settled(page);
        const twoColBefore = await page.evaluate(visibleState);
        info('2-col page ' + twoColBefore.page + ', first column holds blocks ' +
             twoColBefore.firstColumn[0] + '..' +
             twoColBefore.firstColumn[twoColBefore.firstColumn.length - 1]);

        await page.evaluate(() => handleCommand('view_set:columns:1'));
        await settled(page);
        const oneColAfter = await page.evaluate(visibleState);
        info('1-col showing blocks ' + oneColAfter.visible[0] + '..' +
             oneColAfter.visible[oneColAfter.visible.length - 1]);

        assert(!oneColAfter.twoCol, 'the switch actually returned to one column');
        assert(overlap(twoColBefore.firstColumn, oneColAfter.visible).length > 0,
            'text from the first column is still visible in 1-col (' +
            overlap(twoColBefore.firstColumn, oneColAfter.visible).length + ' blocks in common)');

        console.log('\n=== round trip returns to the original position ===');
        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await settled(page);
        const roundTrip = await page.evaluate(visibleState);
        info('back in 2-col at page ' + roundTrip.page + ' (left at page ' + twoColBefore.page + ')');
        info('showing blocks ' + roundTrip.visible[0] + '..' +
             roundTrip.visible[roundTrip.visible.length - 1]);

        assert(roundTrip.page === twoColBefore.page,
            'returns to the same page (' + roundTrip.page + ' vs ' + twoColBefore.page + ')');
        assert(roundTrip.scrollLeft === twoColBefore.scrollLeft,
            'returns to the same scroll position (' + roundTrip.scrollLeft + ' vs ' +
            twoColBefore.scrollLeft + ')');
        const same = overlap(twoColBefore.visible, roundTrip.visible).length;
        assert(same >= Math.floor(twoColBefore.visible.length * 0.8),
            'shows substantially the same content as before the round trip (' + same + ' of ' +
            twoColBefore.visible.length + ' blocks)');

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) {
            console.error('\nCOLUMN ORIENTATION FAILED');
            process.exitCode = 1;
            return;
        }
        console.log('\nCOLUMN ORIENTATION PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
