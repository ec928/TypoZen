/**
 * Column switching, tested against the real TypoZen.exe.
 *
 * This is the suite that would have caught the bug the browser suites missed for a
 * fortnight. Everything here runs inside the shipped binary via the DevTools port that
 * --debug opens, so the WPF shell, the real window size, the per-layout window geometry
 * and real focus behaviour are all in play. The equivalent checks against
 * TypoZen_Template.html in headless Chrome passed throughout, because the fault needs
 * the application to occur.
 *
 * The bug it pins: a block that begins a page can measure a few pixels short of the
 * boundary, so a 1px epsilon floored it onto the previous page. The switch then landed
 * a page early, and the anchor filter rejected every block on screen.
 *
 *   RUN_APP_E2E=1 node tests/column-switch-app.mjs
 */
import { settledApp } from './settle.mjs';
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** Page, alignment and the block at the top, read from the running app. */
function viewState() {
    // Unrounded. The page stride is fractional now -- the pane resolves against a
    // container that is very often fractional, and flooring it is what made pages drift --
    // so rounding both sides before the modulo turns a perfectly aligned page five turns in
    // into a two-pixel error that grows.
    const w = PageMap.width();
    const sl = editor.scrollLeft || 0;
    return {
        // Columns actually rendered, not the computed property. The geometry is driven by
        // a pixel column-width now, so column-count reads auto in both layouts; counting
        // distinct column positions still catches "the class is on but nothing happened",
        // which is the failure this suite exists for.
        cols: (function () {
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
            return String(lefts.size);
        })(),
        paged: isPaginatedLayout(),
        page: PageMap.current(),
        count: PageMap.count(),
        // Either side of a boundary: a fractional stride can land just under the next one.
        aligned: Math.min(sl % w, w - (sl % w)) <= 2,
        scrollTop: Math.round(editor.scrollTop || 0),
        top: topLeftModelIndexTwoCol(),
        indicator: (document.getElementById('page-indicator') || {}).textContent
    };
}

async function main() {
    const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 4000 });
    try {
        const st = () => app.eval(viewState);
        info('viewport: ' + JSON.stringify(await app.viewport()));

        await app.eval(() => handleCommand('view_set:mode:reader'));
        await settledApp(app);
        await app.eval(() => handleCommand('view_set:columns:2'));
        await settledApp(app);

        console.log('--- 2-column, advance two pages ---');
        await app.eval(() => PageMap.step(1)); await sleep(600);
        await app.eval(() => PageMap.step(1)); await settledApp(app);
        const two = await st();
        info('2-col page ' + two.page + ' of ' + two.count + ', top block ' + two.top +
             ', showing "' + two.indicator + '"');
        assert(two.cols === '2', 'two columns are laid out');
        assert(two.aligned, '2-column sits on a page boundary');
        assert(two.top >= 0, 'an anchor block is identifiable in 2-column');
        assert(two.page === 2, 'two page turns reach page index 2 (pages 5 and 6)');

        console.log('\n--- switch to 1-column ---');
        await app.eval(() => handleCommand('view_set:columns:1'));
        await settledApp(app);
        const one = await st();
        info('1-col page ' + one.page + ' of ' + one.count + ', top block ' + one.top +
             ', showing "' + one.indicator + '"');

        assert(one.cols === '1', 'one column is laid out');
        assert(one.aligned, 'lands exactly on a page boundary, not between two pages');
        assert(one.scrollTop === 0, 'no vertical offset, so no diagonal half-page');
        // The anchor filter used to reject every block here, leaving nothing to anchor to.
        assert(one.top >= 0, 'an anchor block is identifiable after the switch (not -1)');
        // The heart of it: the page shown must hold what was on screen before.
        const holds = await app.eval((b) => PageMap.pageOfBlock(b), two.top);
        assert(holds === one.page,
            'the page shown holds the block that was on screen in 2-column (block ' +
            two.top + ' is on page ' + holds + ', showing page ' + one.page + ')');

        console.log('\n--- switch back to 2-column ---');
        await app.eval(() => handleCommand('view_set:columns:2'));
        await settledApp(app);
        const back = await st();
        info('2-col page ' + back.page + ', top block ' + back.top +
             ', showing "' + back.indicator + '"');
        assert(back.page === two.page,
            'returns to the same page (' + back.page + ' vs ' + two.page + ')');
        assert(back.top === two.top,
            'returns to the same content (block ' + back.top + ' vs ' + two.top + ')');

        console.log('\n--- page turns stay aligned ---');
        for (let i = 0; i < 5; i++) await app.eval(() => PageMap.step(1));
        await settledApp(app);
        const turned = await st();
        assert(turned.aligned, 'still on a boundary after five more turns');
        assert(turned.page === two.page + 5, 'five turns advance exactly five pages');

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) {
            console.error('\nCOLUMN SWITCH (APP) FAILED');
            process.exitCode = 1;
            return;
        }
        console.log('\nCOLUMN SWITCH (APP) PASSED');
    } finally {
        await app.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
