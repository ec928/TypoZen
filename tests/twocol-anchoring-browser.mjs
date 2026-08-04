/**
 * Two-column / pagination anchoring e2e -- REAL layout, via puppeteer.
 *
 * Why this exists as a separate harness:
 *
 * The jsdom suites (mode-switch-sticky-e2e.mjs and friends) are fast and cover the
 * model-level anchoring logic well, but jsdom has no layout engine. column-count never
 * applies, scrollLeft assignments are inert, and getBoundingClientRect() returns zeros.
 * Any assertion about which block is on screen in 2-column mode is therefore meaningless
 * there -- the probe reports block 0 no matter where the document actually sits.
 *
 * This harness loads TypoZen_Template.html in headless Chrome, so css/typozen.css and
 * js/typozen.js load natively and columns really lay out. Assertions here are about
 * measured geometry, not model bookkeeping.
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

function buildDoc(nLines) {
    const lines = [];
    for (let i = 1; i <= nLines; i++) lines.push('row content ' + i);
    return lines.join('\n');
}

async function boot(browser, viewport) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    page.on('pageerror', e => console.error('  PAGE ERROR: ' + e.message));

    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });

    // The app wires itself up on DOMContentLoaded; wait for the globals the suite drives.
    await page.waitForFunction(
        () => typeof handleCommand === 'function' && typeof loadMarkdownContent === 'function',
        { timeout: 10000 }
    );
    return page;
}

async function loadDoc(page, md) {
    await page.evaluate((content) => { loadMarkdownContent(content); }, md);
    await sleep(300);
}

/** Geometry of the editor as the browser actually laid it out. */
function readLayout() {
    const ed = document.getElementById('editor');
    const cs = getComputedStyle(ed);
    return {
        classes: ed.className,
        columnCount: cs.columnCount,
        columnGap: cs.columnGap,
        clientWidth: ed.clientWidth,
        scrollWidth: ed.scrollWidth,
        clientHeight: ed.clientHeight,
        scrollHeight: ed.scrollHeight,
        scrollLeft: ed.scrollLeft,
        blocks: ed.querySelectorAll('.block').length
    };
}

/**
 * Model index of the topmost block actually visible in the editor viewport.
 * Real rects, so this means what it says -- unlike the jsdom equivalent.
 */
function topVisibleModelIndex() {
    const ed = document.getElementById('editor');
    const host = ed.getBoundingClientRect();
    let best = null;
    ed.querySelectorAll('.block').forEach(b => {
        const r = b.getBoundingClientRect();
        if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) return;
        if (r.right <= host.left + 1 || r.left >= host.right - 1) return;
        const mi = parseInt(b.getAttribute('data-model-index'), 10);
        if (isNaN(mi)) return;
        if (best === null || r.left < best.left - 1 || (Math.abs(r.left - best.left) <= 1 && r.top < best.top)) {
            best = { mi: mi, top: r.top, left: r.left };
        }
    });
    return best;
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        console.log('=== boot (1280x800, real layout) ===');
        const page = await boot(browser, { width: 1280, height: 800 });
        assert(true, 'app booted and exposed handleCommand/loadMarkdownContent');

        const md = buildDoc(400);
        await loadDoc(page, md);

        // Preview mode is the baseline for column work.
        await page.evaluate(() => { if (state.mode !== 'wysiwyg') handleCommand('toggle_mode'); });
        await sleep(200);
        const mode = await page.evaluate(() => state.mode);
        assert(mode === 'wysiwyg', 'in preview mode (got ' + mode + ')');

        const oneCol = await page.evaluate(readLayout);
        info('1-col layout: ' + JSON.stringify(oneCol));
        assert(oneCol.blocks > 0, 'blocks are mounted in 1-col (' + oneCol.blocks + ')');
        assert(oneCol.columnCount === 'auto' || oneCol.columnCount === '1',
            '1-col computes columnCount auto/1 (got ' + oneCol.columnCount + ')');

        console.log('\n=== switch to 2-column ===');
        await page.evaluate(() => handleCommand('set_column_mode:2'));
        await sleep(400);
        const twoCol = await page.evaluate(readLayout);
        info('2-col layout: ' + JSON.stringify(twoCol));

        assert(/two-col-layout/.test(twoCol.classes),
            'editor carries .two-col-layout (classes: ' + twoCol.classes + ')');

        // The load-bearing assertion. css/typozen.css currently gates the column rule on
        // "#editor.reader-mode.two-col-layout", so in Preview the class lands but no
        // column box is ever created. This is exactly the check the suppressed jsdom test
        // could never make.
        assert(twoCol.columnCount === '2',
            'computed column-count is 2 in preview (got ' + twoCol.columnCount + ')');

        console.log('\n=== round-trip 2-col -> 1-col preserves reading position ===');
        const before = await page.evaluate(() => {
            const ed = document.getElementById('editor');
            ed.scrollLeft = Math.floor(ed.scrollWidth / 3);
            return null;
        });
        await sleep(250);
        const atTwoCol = await page.evaluate(topVisibleModelIndex);
        info('top visible block in 2-col after scroll: ' + JSON.stringify(atTwoCol));

        await page.evaluate(() => handleCommand('set_column_mode:1'));
        await sleep(500);
        const atOneCol = await page.evaluate(topVisibleModelIndex);
        info('top visible block after switching to 1-col: ' + JSON.stringify(atOneCol));

        assert(atTwoCol && atOneCol, 'a top visible block is identifiable in both modes');
        if (atTwoCol && atOneCol) {
            // Success criterion from the goals doc: content on the first page of the
            // current mode should still be generally visible in the target mode. A
            // window of 20 blocks is "generally visible" for a 400-line document.
            const drift = Math.abs(atOneCol.mi - atTwoCol.mi);
            assert(drift <= 20,
                'reading position drift across 2->1 col is <= 20 blocks (got ' + drift + ')');
        }

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) {
            console.error('\nTWO-COL ANCHORING E2E FAILED');
            process.exitCode = 1;
            return;
        }
        console.log('\nTWO-COL ANCHORING E2E PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
