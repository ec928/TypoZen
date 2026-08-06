/**
 * A page fits the pane, and stays fitting after a hundred turns.
 *
 * This is the check that was missing while pages drifted. The suite that existed compared
 * the page stride against the column pitch -- and both were computed from the same number,
 * so they agreed with each other while the text ran off the right-hand edge of the window
 * and the previous column showed down the left margin. Two quantities derived from one
 * mistake will always agree.
 *
 * What a reader can see, and therefore what this asserts:
 *
 *   - no text is clipped: every laid-out fragment sits inside the pane
 *   - a column starts at the pane's left edge, not part way across it
 *   - after many page turns both are still true, because drift accumulates
 *
 * Runs in headless Chrome in a few seconds, which is the point: the geometry does not need
 * the shell, and a check nobody waits twenty minutes for is a check that gets run.
 *
 *   node tests/page-fit-browser.mjs
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

/** Geometry of what is actually on the page, in pane coordinates. */
function fitState() {
    const ed = document.getElementById('editor');
    const pane = ed.getBoundingClientRect();
    const paneW = ed.clientWidth;

    let worstRight = -Infinity, worstRightText = '';
    let leftmost = Infinity;
    let fragments = 0;

    for (const b of ed.querySelectorAll('.block')) {
        // Per-fragment, never the bounding box: a paragraph running from one column into
        // the next reports the union of its fragments, which spans both.
        for (const r of b.getClientRects()) {
            if (r.width <= 0 || r.height <= 0) continue;
            const left = r.left - pane.left;
            const right = r.right - pane.left;
            // Only what is on the visible spread; columns beyond it are legitimately
            // off to the right waiting to be scrolled to.
            if (right <= 0 || left >= paneW) continue;
            fragments++;
            if (right > worstRight) {
                worstRight = right;
                worstRightText = (b.innerText || '').replace(/\s+/g, ' ').slice(0, 30);
            }
            if (left < leftmost) leftmost = left;
        }
    }

    return {
        paneW: paneW,
        stride: (typeof PageGeometry !== 'undefined') ? PageGeometry.stride() : PageMap.width(),
        scrollLeft: Math.round((ed.scrollLeft || 0) * 100) / 100,
        overflowRight: Math.round((worstRight - paneW) * 100) / 100,
        overflowText: worstRightText,
        leftmost: Math.round(leftmost * 100) / 100,
        fragments: fragments,
        page: PageMap.current(),
        pages: PageMap.count()
    };
}

async function checkLayout(page, label, turns) {
    console.log('\n=== ' + label + ' ===');

    let s = await page.evaluate(fitState);
    info('pane ' + s.paneW + 'px, stride ' + s.stride + ', ' + s.fragments + ' fragments on screen');
    assert(s.fragments > 0, label + ': something is laid out to look at');

    // A column of text must not be wider than the pane it is read in.
    assert(s.overflowRight <= 1,
        label + ': no text runs past the right edge of the pane (' +
        s.overflowRight + 'px over, at "' + s.overflowText + '")');
    assert(s.leftmost >= -1,
        label + ': nothing hangs off the left edge (' + s.leftmost + 'px)');

    // Turn a lot of pages. One page of drift is invisible; a hundred is not, which is
    // exactly why this went unnoticed until page 411 of a novel.
    for (let i = 0; i < turns; i++) await page.evaluate(() => PageMap.step(1));
    await settled(page);

    s = await page.evaluate(fitState);
    info('after ' + turns + ' turns: page ' + s.page + ' of ' + s.pages +
         ', scrollLeft ' + s.scrollLeft + ', leftmost fragment at ' + s.leftmost + 'px');

    assert(s.overflowRight <= 1,
        label + ': still nothing past the right edge after ' + turns + ' turns (' +
        s.overflowRight + 'px over, at "' + s.overflowText + '")');

    // The reader is looking at the start of a column, not part way into one. This is the
    // drift itself: a fraction of a pixel lost per page, accumulating until a sliver of the
    // previous column is showing.
    assert(Math.abs(s.leftmost) <= 2,
        label + ': a column still starts at the left edge after ' + turns + ' turns (' +
        s.leftmost + 'px in)');

    // And the scroll offset is a whole number of strides, which is the same statement
    // made against the model rather than against the pixels.
    const rem = Math.min(s.scrollLeft % s.stride, s.stride - (s.scrollLeft % s.stride));
    assert(rem <= 1,
        label + ': the scroll offset is a whole number of pages (' +
        s.scrollLeft + ' with stride ' + s.stride + ', ' + rem.toFixed(2) + ' out)');
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await settled(page);
        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await settled(page);

        // Widths that are not round numbers on purpose. The pane resolves against its
        // parent, and a fractional parent is what produced a fractional column against an
        // integer stride -- 911.36px in the running app, losing a third of a pixel a page.
        for (const width of [1600, 1437, 1281]) {
            await page.setViewport({ width: width, height: 900 });
            await settled(page);

            await page.evaluate(() => handleCommand('view_set:columns:1'));
            await settled(page);
            await checkLayout(page, width + 'px wide, 1 column', 100);

            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await settled(page);
            await checkLayout(page, width + 'px wide, 2 columns', 100);
        }

        // A resize with no command after it.
        //
        // This is the case a pinned pixel width fails: the pane keeps the size it was given,
        // the container is now a different size, and the text runs off the edge until
        // something happens to lay it out again. Nothing below asks for a relayout -- if the
        // geometry only follows its container when told to, this fails.
        await page.setViewport({ width: 1103, height: 780 });
        await settled(page);
        await checkLayout(page, 'after a resize, with nothing asking for a relayout', 40);

        await page.setViewport({ width: 1731, height: 941 });
        await settled(page);
        await checkLayout(page, 'after growing again', 40);
    } finally {
        await browser.close();
    }

    console.log('\npassed=' + passed + ' failed=' + failed);
    console.log(failed ? 'PAGE FIT FAILED' : 'PAGE FIT PASSED');
    process.exit(failed ? 1 : 0);
}

main();
