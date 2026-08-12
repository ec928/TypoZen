/**
 * Leaving a book leaves nothing behind.
 *
 * The bug: read an epub in Pages, switch to a Markdown tab, and the Markdown was laid
 * out in the book's column -- one narrow strip of text with the rest of the pane empty,
 * in a view whose toolbar said Scroll and 1-Col.
 *
 * Two faults, both of the same kind, and both had to be fixed:
 *
 *   1. leaveBookViewForMarkdown() took page-mode off with classList directly, so it
 *      never passed through syncPaginationClass() -- the only other place that clears
 *      the inline column-width/gap/count/fill and the zeroed page padding that
 *      PageGeometry wrote. With page-mode gone, isPaginatedLayout() was false, so
 *      relayout() would never run again to correct it either. The geometry was live and
 *      unreachable at the same time.
 *
 *   2. relayout() clamped an unmeasurable pane with Math.max(1, 0), so a hidden editor
 *      produced column-width: 1px -- a number that looks valid to every guard
 *      downstream, and sets one glyph per line.
 *
 * What this asserts is the property, not the two fixes: **after a book, the editor
 * carries no page geometry**, and **a pane that cannot be measured is refused rather
 * than invented**. Anything that reintroduces either fault fails here.
 *
 *   RUN_APP_E2E=1 node tests/book-to-markdown-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const MD = '# Section 1 of 140\n\nLine 1 of 40 - scroll marker row 1\n\n' +
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.\n';

const readState = () => {
    const ed = document.getElementById('editor');
    const cs = getComputedStyle(ed);
    const blk = ed.querySelector('.block');
    return {
        kind: (typeof DocumentModel !== 'undefined') ? DocumentModel.kind : '?',
        cls: ed.className,
        inline: ed.getAttribute('style') || '',
        colWidth: cs.columnWidth,
        colGap: cs.columnGap,
        editorW: Math.round(ed.getBoundingClientRect().width),
        blockW: blk ? Math.round(blk.getBoundingClientRect().width) : 0,
        paginated: (typeof isPaginatedLayout === 'function') ? isPaginatedLayout() : null,
    };
};

/**
 * One lap: open the book, read it in `cols` columns, then hand the editor a Markdown
 * document the way a tab switch does.
 *
 * A fresh launch per lap, because there is no in-process way to reopen a book once the
 * Markdown has replaced it -- and faking one would test the fake.
 */
async function leaveBookLap(cols) {
    console.log('\n=== leaving a book read in ' + cols + '-column ===');
    // No view pin here, deliberately: a book forces Reader + Pages on itself, so pinning
    // the layout at launch would fight the very state the controls below assert.
    const app = await launchApp({ file: 'tests/Matter - Iain M. Banks.epub', settleMs: 12000 });
    try {
        // Controls first: the book must actually be paginated with a pixel column, or
        // every claim below is vacuous -- nothing left behind because nothing was set.
        let s = await app.eval(readState);
        info('book open: colW=' + s.colWidth + ' cls=[' + s.cls + ']');
        assert(s.kind === 'epub', cols + '-col: control: a book is open');
        assert(s.paginated === true, cols + '-col: control: the book is paginated');

        if (cols === 2) {
            await app.eval(() => handleCommand('view_set:columns:2'));
            await sleep(2500);
            s = await app.eval(readState);
            assert(/two-col-layout/.test(s.cls), '2-col: control: the book is in two columns');
        }
        const bookColW = s.colWidth;
        info('reading: colW=' + bookColW + ' gap=' + s.colGap + ' cls=[' + s.cls + ']');
        assert(s.colWidth !== 'auto',
            cols + '-col: control: PageGeometry wrote a pixel column-width');

        // The transition under test: exactly what arriving on a Markdown tab does.
        await app.eval((text) => loadMarkdownContent(text, { replaceBook: true }), MD);
        await sleep(2500);
        s = await app.eval(readState);
        info('after markdown: colW=' + s.colWidth + ' gap=' + s.colGap +
             ' inline="' + s.inline + '"');

        assert(s.kind === 'markdown', cols + '-col: the markdown document loaded');

        // The property is "none of the BOOK's numbers survive" -- not "the markdown ends
        // up unpaginated". Those are different claims, and asserting the second failed
        // honest runs: the app restores the layout the last session was left in, so if
        // that was Pages the markdown is legitimately paginated and legitimately has
        // column geometry of its own. The first version of this read that as a leak.
        //
        // A leak is identifiable without ambiguity, because a leaked column-width is the
        // BOOK's measurement and a healthy one is measured for the pane in front of it.
        if (s.paginated) {
            info(cols + '-col: restored into Pages, so the markdown has its own geometry');
            assert(s.colWidth !== bookColW,
                cols + '-col: the column is measured for this pane, not carried over from ' +
                'the book (' + s.colWidth + ' vs the book: ' + bookColW + ')');
            assert(s.colGap !== '60px' || cols === 2,
                cols + '-col: and the two-column gap did not come with it');
        } else {
            assert(s.colWidth === 'auto',
                cols + '-col: no column-width survives the book (was ' + bookColW + ')');
            assert(s.colGap === 'normal' || s.colGap === '0px' || s.colGap === 'auto',
                cols + '-col: no column-gap survives the book (got ' + s.colGap + ')');
            assert(!/column-width|column-count|column-fill/.test(s.inline),
                cols + '-col: no inline column geometry is left on the editor');
            assert(!/--tz-page-h/.test(s.inline),
                cols + '-col: the page-height custom property is cleared too');
        }

        // NOT asserted here: the visual symptom -- text in a narrow strip with the rest
        // of the page blank.
        //
        // It was, twice, and both versions passed with the bug still present, which is
        // worse than not testing it. column-width is a *preferred* width: with
        // column-count auto the browser fits floor((pane + gap) / (colWidth + gap))
        // columns and then stretches them to fill, so a single leaked column is
        // indistinguishable from a healthy one at any width. Fragmenting needs a pane
        // roughly twice the leaked column, and neither the sidebar (about 1.5x) nor the
        // per-column-count window rects get there from the width these tests run at.
        //
        // The assertions above are the test. They are strictly more sensitive than the
        // rendering: the geometry has to leak before it can fragment, so nothing can
        // reach the visible symptom without failing them first. Left here as a note so
        // the next person does not spend the afternoon rediscovering it.
        info(cols + '-col: block ' + s.blockW + 'px in a ' + s.editorW + 'px pane ' +
             '(rendering not asserted -- see comment)');
    } finally {
        await app.close();
    }
}

await leaveBookLap(1);
await leaveBookLap(2);

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    // --- A pane that cannot be measured is refused, not invented.
    // This is fault 2 on its own: hide the editor while it is paginated and ask for a
    // relayout. The old code answered "1", wrote column-width: 1px, and every guard
    // downstream accepted it because 1 > 0.
    console.log('\n=== an unmeasurable pane ===');
    const hidden = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const ed = document.getElementById('editor');
        handleCommand('view_set:scroll:pagination');
        await sleep(1200);
        const strideVisible = PageGeometry.stride();
        const colVisible = getComputedStyle(ed).columnWidth;
        // Hide it with page-mode still on -- relayout() will run and must refuse.
        const prevDisplay = ed.style.display;
        ed.style.display = 'none';
        const strideHidden = PageGeometry.relayout();
        const colHidden = getComputedStyle(ed).columnWidth;
        const inlineHidden = ed.getAttribute('style') || '';
        ed.style.display = prevDisplay;
        await sleep(600);
        PageGeometry.relayout();
        await sleep(400);
        return {
            strideVisible, colVisible, strideHidden, colHidden,
            wroteOnePixel: /column-width:\s*1px/.test(inlineHidden),
            strideBack: PageGeometry.stride(),
            colBack: getComputedStyle(ed).columnWidth,
        };
    });
    info(JSON.stringify(hidden));
    assert(hidden.strideVisible > 1, 'control: a visible pane has a real stride');
    assert(hidden.strideHidden === 0,
        'relayout() on a hidden editor returns 0, not a fabricated stride');
    assert(!hidden.wroteOnePixel,
        'and never writes column-width: 1px');
    assert(hidden.strideBack > 1,
        'the stride recovers once the editor is measurable again (' + hidden.strideBack + ')');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'BOOK TO MARKDOWN FAILED' : 'BOOK TO MARKDOWN PASSED');
process.exit(failed ? 1 : 0);
