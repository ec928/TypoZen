/**
 * Reading comfort and the chrome that gets out of the way, in a real browser.
 *
 * Four things ship together here and only Chrome can judge any of them, because every one
 * is a question about painted pixels:
 *
 *   line spacing        four presets on --lh, and the claim that they reach a book's text
 *                       as well as a Markdown file's
 *   paragraph spacing   four presets on --para, likewise
 *   scrubber            hidden and shown by command, against an element whose display is
 *                       rewritten on every page turn
 *   staying put         a spacing change moves every page boundary in the document; the
 *                       reader must still be looking at the paragraph they were reading
 *
 * The book is the point of the first two. A publisher's own line-height is stripped when
 * their stylesheet is applied, which is what leaves the app's value in charge -- that is
 * the mechanism the whole feature rests on, and a Markdown fixture cannot test it because
 * there is no publisher stylesheet to lose to.
 *
 * Measured as the distance between the tops of consecutive line boxes, taken from a Range
 * over the text node itself. Not computed style, which reports what CSS was asked for
 * rather than what was drawn, and not the element's own height, which is the paragraph
 * rather than the line.
 *
 *   node tests/reading-chrome-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { JSDOM } from 'jsdom';
import { readSpine, bookBlocks, readToc } from './epub-zip.mjs';
import { settled } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

// The presets the View menu offers, and the defaults they are centred on.
const LINE = [1.4, 1.6, 1.8, 2.0];
const PARA = [1, 3, 7, 12];
const LINE_DEFAULT = 1.6;
const PARA_DEFAULT = 3;

/**
 * Median gap between the tops of consecutive line boxes, across every paragraph long
 * enough to have several.
 *
 * Median rather than mean because a paragraph's last line, a heading in the middle of the
 * sample, or a block that happens to straddle a column boundary all contribute one wrong
 * number each, and the mean carries them.
 */
function measureLeading() {
    const ed = document.getElementById('editor');
    const gaps = [];
    const blocks = Array.prototype.slice.call(ed.querySelectorAll('.block'));
    for (const b of blocks) {
        // Down to the element that owns the text, not the container around it: a book
        // block is a div wrapping the publisher's own <p>, and the wrapper's box says
        // nothing about how the lines inside it are set.
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
            if (!node.nodeValue || node.nodeValue.trim().length < 200) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = Array.prototype.slice.call(range.getClientRects())
                .filter(r => r.width > 1 && r.height > 1);
            if (rects.length < 3) continue;
            for (let i = 1; i < rects.length; i++) {
                // Same column only. A wrap into the next column is a jump of a page width
                // sideways and a whole page height back up, which is not leading.
                if (Math.abs(rects[i].left - rects[i - 1].left) > 40) continue;
                const d = rects[i].top - rects[i - 1].top;
                if (d > 2 && d < 200) gaps.push(d);
            }
        }
    }
    if (!gaps.length) return null;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
}

/** Median vertical gap between the painted bottom of one block and the top of the next. */
function measureParaGap() {
    const ed = document.getElementById('editor');
    const blocks = Array.prototype.slice.call(ed.querySelectorAll('.block'));
    const gaps = [];
    for (let i = 1; i < blocks.length; i++) {
        const a = blocks[i - 1].getBoundingClientRect();
        const b = blocks[i].getBoundingClientRect();
        if (a.height < 2 || b.height < 2) continue;
        if (Math.abs(a.left - b.left) > 2) continue;  // different column
        const d = b.top - a.bottom;
        if (d >= -1 && d < 200) gaps.push(d);
    }
    if (!gaps.length) return null;
    gaps.sort((x, y) => x - y);
    return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Model indices of every block with pixels inside the visible page.
 *
 * The editor is the host in both column counts, because in paginated mode it is the page
 * viewport -- it is the element that clips, and the one that scrolls sideways from page to
 * page. Measuring 1 column against main-container instead counted every block whose rows
 * happened to fall in the same vertical band, including the ones sitting a page or two to
 * the right, and reported forty-three blocks on a page that holds thirteen.
 */
function visibleBlocks() {
    const ed = document.getElementById('editor');
    const host = ed.getBoundingClientRect();
    const vis = [];
    ed.querySelectorAll('.block').forEach(b => {
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) return;
        if (r.right <= host.left + 1 || r.left >= host.right - 1) return;
        const mi = DocumentModel.modelIndexOfEl(b);
        if (mi >= 0) vis.push(mi);
    });
    vis.sort((a, b) => a - b);
    return vis;
}

async function main() {
    const books = fs.readdirSync(path.join(appDir, 'tests'))
        .filter(f => f.toLowerCase().endsWith('.epub')).sort();
    if (!books.length) {
        console.log('  --   no .epub in tests/, nothing to verify.');
        console.log('passed=0 failed=0');
        console.log('READING CHROME SKIPPED');
        return;
    }

    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        await page.evaluate(measureLeading);   // hoist the helpers into the page
        const bookFile = books.find(b => /matter/i.test(b)) || books[0];
        console.log('=== ' + bookFile + ' ===');
        const dom = new JSDOM('');
        const spine = readSpine(path.join(appDir, 'tests', bookFile));
        const { blocks, docStart } = bookBlocks(spine, dom);
        const toc = readToc(spine, docStart, dom);
        await page.evaluate((bs, tc) => DocumentModel.fromBookBlocks(bs, tc), blocks, toc);
        await settled(page);
        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await settled(page);
        await page.evaluate(() => handleCommand('view_set:columns:1'));
        await settled(page);

        // ---- line spacing ----
        console.log('\n--- line spacing reaches the book ---');
        const leading = [];
        for (const v of LINE) {
            await page.evaluate((x) => handleCommand('set_line_spacing:' + x), v);
            await settled(page);
            const px = await page.evaluate(measureLeading);
            leading.push(px);
            info('preset ' + v.toFixed(1) + ' -> ' + (px == null ? 'nothing measurable' : px.toFixed(2) + 'px between line tops'));
        }
        assert(leading.every(x => x != null && x > 4), 'every preset paints measurable lines');

        if (leading.every(x => x != null)) {
            let rising = true;
            for (let i = 1; i < leading.length; i++) if (!(leading[i] > leading[i - 1] + 0.5)) rising = false;
            assert(rising, 'each preset sets its lines further apart than the one below it');

            // The presets are ratios of a font size the theme owns, so the painted gaps
            // should sit in the same ratios. Loose over Normal is 2.0/1.6 = 1.25.
            const want = LINE[3] / LINE[1];
            const got = leading[3] / leading[1];
            assert(Math.abs(got - want) < 0.06,
                'the painted leading tracks the preset ratio (asked ' + want.toFixed(3) +
                ', drew ' + got.toFixed(3) + ')');
        }

        // Back to the default, and check that is what the stylesheet already shipped --
        // "take the current defaults as the defaults" is only true if Normal changes
        // nothing at all.
        await page.evaluate(() => handleCommand('set_line_spacing:' + 999));
        await settled(page);
        assert(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--lh').trim() !== '999'),
            'a preset outside the sane range is refused rather than applied');
        await page.evaluate((v) => handleCommand('set_line_spacing:' + v), LINE_DEFAULT);
        await settled(page);
        const atDefault = await page.evaluate(measureLeading);
        assert(atDefault != null && Math.abs(atDefault - leading[1]) < 0.51,
            'Normal is the value the stylesheet already used (' + atDefault.toFixed(2) + 'px)');

        // ---- paragraph spacing ----
        console.log('\n--- paragraph spacing ---');
        const gaps = [];
        for (const v of PARA) {
            await page.evaluate((x) => handleCommand('set_para_spacing:' + x), v);
            await settled(page);
            const px = await page.evaluate(measureParaGap);
            gaps.push(px);
            info('preset ' + v + 'px -> ' + (px == null ? 'nothing measurable' : px.toFixed(2) + 'px between blocks'));
        }
        assert(gaps.every(x => x != null), 'every preset leaves a measurable gap');
        if (gaps.every(x => x != null)) {
            let rising = true;
            for (let i = 1; i < gaps.length; i++) if (!(gaps[i] > gaps[i - 1] + 0.5)) rising = false;
            assert(rising, 'each preset opens the paragraphs further than the one below it');

            // Absolute pixels, so the step between two presets should be exactly the step
            // between the values asked for. A book's own paragraph margins sit underneath
            // and add a constant, which subtracting one preset from another removes.
            const wantStep = PARA[3] - PARA[0];
            const gotStep = gaps[3] - gaps[0];
            assert(Math.abs(gotStep - wantStep) < 1.5,
                'the gap grows by exactly what was asked (' + wantStep + 'px asked, ' +
                gotStep.toFixed(2) + 'px drawn)');
        }
        await page.evaluate((v) => handleCommand('set_para_spacing:' + v), PARA_DEFAULT);
        await settled(page);
        const gapDefault = await page.evaluate(measureParaGap);
        assert(gapDefault != null && Math.abs(gapDefault - gaps[1]) < 0.51,
            'Normal is the gap the stylesheet already used (' + gapDefault.toFixed(2) + 'px)');

        // ---- the reader stays where they were ----
        //
        // This is the part that is easy to ship broken. Taller lines mean fewer per page,
        // so every page boundary in the book moves and the page number the reader was on
        // now holds different text. Turning the leading up must not throw them forward
        // hundreds of pages.
        // Judged in pages, not in exact blocks. The two layouts break the text in
        // different places, so demanding the identical set of blocks would be inventing a
        // requirement -- the same reasoning twocol-anchoring-browser gives for its own
        // criterion. "Within a page" is the real thing: a reader who reaches for the menu
        // and comes back a paragraph off has lost nothing, and one thrown to the front of
        // the book has lost their place entirely. The stale-anchor bug this caught landed
        // 2600 blocks out, which is about sixty pages.
        console.log('\n--- a spacing change does not lose the reader ---');
        for (const cols of [1, 2]) {
            await page.evaluate((c) => handleCommand('view_set:columns:' + c), cols);
            await settled(page);

            // Seek only once the page map has actually counted.
            //
            // settled() waits for the geometry to stop moving, which is not the same
            // thing: the view can be perfectly still while PageMap.count() is still the
            // seed estimate for a single range. Straight after a column switch that count
            // can be tiny, and goto(0.6 * 1) is goto(0) -- which drops the reader at the
            // front of the book and fails the guard below for a reason that has nothing
            // to do with line spacing, the very thing this section is testing.
            //
            // Seen once in a full-gate run and not reproducible in isolation across three
            // attempts, which is what a load-sensitive race looks like from the outside.
            // A flaky gate is worse than a slow one here: this suite blocks the build.
            await page.waitForFunction(
                () => typeof PageMap !== 'undefined'
                    && typeof PageMap.count === 'function'
                    && PageMap.count() > 10,
                { timeout: 20000, polling: 150 });
            const pageCount = await page.evaluate(() => PageMap.count());
            await page.evaluate(() => { PageMap.goto(Math.floor(PageMap.count() * 0.6)); });
            await settled(page);
            const before = await page.evaluate(visibleBlocks);
            const perPage = before.length;
            // Guard against the check passing for the wrong reason. An earlier version of
            // the deferred correction dragged the view back to the front of the book while
            // the previous iteration was still settling, so "before" and "after" agreed at
            // block 0 and every assertion below was satisfied by a reader who had been
            // thrown out of the book entirely.
            assert(before.length > 0 && before[0] > 100,
                cols + '-col: the reader really is inside the book before the change (block ' +
                (before[0] === undefined ? 'none' : before[0]) +
                ', seeking 60% of ' + pageCount + ' pages)');
            await page.evaluate(() => handleCommand('set_line_spacing:2.0'));
            await settled(page);
            const after = await page.evaluate(visibleBlocks);
            // Distance from the text that was on screen to the nearest text now on screen.
            let drift = Infinity;
            for (const x of before) for (const y of after) drift = Math.min(drift, Math.abs(x - y));
            const pages = drift / Math.max(1, perPage);
            info(cols + '-col: was showing blocks ' + before[0] + '..' + before[before.length - 1] +
                ', now showing ' + after[0] + '..' + after[after.length - 1] +
                ' — ' + drift + ' blocks away, about ' + pages.toFixed(2) + ' of a page');
            assert(pages <= 1.0,
                cols + '-col: the reader lands within a page of the text they were reading');
            await page.evaluate((v) => handleCommand('set_line_spacing:' + v), LINE_DEFAULT);
            await settled(page);
        }

        // ---- the scrubber ----
        //
        // Its display is rewritten on every page turn by updatePageScrubber, so hiding it
        // has to survive one. Turning a page is the test, not an implementation detail.
        console.log('\n--- the scrubber hides and comes back ---');
        const shown = () => {
            const el = document.getElementById('page-scrubber');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return getComputedStyle(el).display !== 'none' && r.width > 0 && r.height > 0;
        };
        await page.evaluate(() => handleCommand('scrubber_on'));
        await settled(page);
        assert(await page.evaluate(shown), 'the scrubber is on screen to begin with');

        await page.evaluate(() => handleCommand('scrubber_off'));
        await settled(page);
        assert(!(await page.evaluate(shown)), 'scrubber_off takes it off screen');
        await page.evaluate(() => PageMap.step(1));
        await settled(page);
        assert(!(await page.evaluate(shown)), 'and it stays off through a page turn');

        await page.evaluate(() => handleCommand('scrubber_on'));
        await settled(page);
        assert(await page.evaluate(shown), 'scrubber_on brings it back');

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) { console.error('\nREADING CHROME FAILED'); process.exitCode = 1; return; }
        console.log('\nREADING CHROME PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
