/**
 * Selecting text in Pages must not turn the page.
 *
 * Reaching for the first word on a page threw the reader to the page before it and took
 * the half-made selection with it, so copying a phrase near the left edge took several
 * attempts.
 *
 * Two parties, and only one of them is ours:
 *
 *   - Chromium auto-scrolls a scroll container when a selection drag reaches its edge.
 *     That is ordinary browser behaviour and #editor.page-mode is a horizontal scroll
 *     container. On its own it is a nudge.
 *   - The scroll listener in 03-shell then calls PageGeometry.snap(), which rounds
 *     scrollLeft to the nearest page and COMMITS. That turned a nudge into a page turn.
 *
 * So the fix is not to fight the browser: it is to stop finishing what it started while
 * a button is still down, and to put the page back where the drag began afterwards --
 * the selection anchor is on that page, so that is the page the reader is working on.
 *
 * The nudge here is deliberately larger than half a page stride. A small one rounds back
 * to the page it came from and the suite passes with the fix removed, which was checked:
 * at 90px of a ~1039px stride this proved nothing at all.
 *
 *   RUN_APP_E2E=1 node tests/page-selection-drag-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 8000 });
try {
    await app.eval(() => handleCommand('view_set:mode:preview'));
    await sleep(1200);
    await app.eval(() => handleCommand('view_set:scroll:pagination'));
    await sleep(2500);

    for (const cols of [1, 2]) {
        console.log('\n=== ' + cols + '-column ===');
        await app.eval((c) => handleCommand('view_set:columns:' + c), cols);
        await sleep(2500);

        const r = await app.eval(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const ed = document.getElementById('editor');
            PageMap.goto(6); await sleep(1600);
            const startPage = PageMap.current();
            const startLeft = Math.round(ed.scrollLeft);
            const stride = Math.round(PageGeometry.stride());

            // What the browser does mid-drag: button held, container auto-scrolled left.
            // More than half a stride, or the snap would round back on its own and this
            // would pass whether the fix is present or not.
            ed.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true, button: 0, clientX: 60, clientY: 300 }));
            await sleep(100);
            ed.scrollLeft = Math.max(0, ed.scrollLeft - Math.round(stride * 0.6));
            await sleep(400);          // well past the 80ms snap debounce
            const midPage = PageMap.current();
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            await sleep(800);
            return {
                startPage, startLeft, stride, midPage,
                endPage: PageMap.current(), endLeft: Math.round(ed.scrollLeft),
            };
        });
        info('stride ' + r.stride + '; page ' + r.startPage + ' (left ' + r.startLeft +
             ') -> mid ' + r.midPage + ' -> end ' + r.endPage + ' (left ' + r.endLeft + ')');

        assert(r.stride > 1, cols + '-col: control: the layout has a real page stride');
        assert(r.startPage === 6, cols + '-col: control: the drag started on a known page');
        // The nudge has to be big enough to have rounded to another page. Without this
        // the assertion below is satisfied by a nudge that could never have moved it.
        assert(r.midPage !== r.startPage,
            cols + '-col: control: mid-drag the scroll really did cross a page boundary (' +
            r.midPage + ')');
        assert(r.endPage === r.startPage,
            cols + '-col: the page does not turn (' + r.startPage + ' -> ' + r.endPage + ')');
        assert(Math.abs(r.endLeft - r.startLeft) < 4,
            cols + '-col: and the view is put back exactly where the drag began (' +
            r.startLeft + ' vs ' + r.endLeft + ')');
    }
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PAGE SELECTION DRAG FAILED' : 'PAGE SELECTION DRAG PASSED');
process.exit(failed ? 1 : 0);
