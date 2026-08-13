/**
 * Keyboard paging without a live search (the common path).
 *
 * Product matrix (docs/for-agents.md): Preview arrows = caret; Reader arrows = page;
 * PageUp/PageDown always page when paginated. Search mode (matches.length > 0) adds
 * Up/Down = hits and Left/Right = page — not covered here.
 *
 * Paginated Preview used to claim every arrow (caret never moved). The split is on
 * contenteditable: Reader sets #editor contenteditable=false. PageUp/PageDown must not
 * be skipped just because Preview is editable.
 *
 *   RUN_APP_E2E=1 node tests/page-arrow-keys-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** Where the caret is, as an offset inside whichever block holds it. */
const caret = () => {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const n = s.anchorNode;
    const b = (n && n.nodeType === 1 ? n : n && n.parentElement);
    const block = b && b.closest ? b.closest('.block') : null;
    return {
        offset: s.anchorOffset,
        block: block ? block.getAttribute('data-model-index') : null
    };
};

const pageNow = () => (typeof PageMap !== 'undefined' && PageMap.current)
    ? PageMap.current() : -1;

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 5000 });
try {
    // --- Preview, paginated: the arrows belong to the caret -------------------------
    console.log('\n=== paginated Preview: arrows move the caret ===');
    await app.eval(() => handleCommand('view_set:scroll:pagination'));
    await sleep(3000);

    const editable = await app.eval(() => ({
        mode: state.mode,
        paged: !!state.pageAdvance,
        editable: document.getElementById('editor').isContentEditable
    }));
    info('mode ' + editable.mode + ', paginated ' + editable.paged +
         ', editable ' + editable.editable);
    assert(editable.paged && editable.editable,
        'Preview is paginated and still editable');

    // Put the caret somewhere real, then press Right twice.
    const before = await app.eval(() => {
        const blocks = document.querySelectorAll('#editor .block');
        for (const b of blocks) {
            if ((b.textContent || '').trim().length > 20) {
                const r = document.createRange();
                const t = b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild : b;
                r.setStart(t, 0); r.collapse(true);
                const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                b.focus && b.focus();
                break;
            }
        }
        const s = window.getSelection();
        const n = s.anchorNode;
        const el = (n && n.nodeType === 1 ? n : n && n.parentElement);
        const blk = el && el.closest ? el.closest('.block') : null;
        return { offset: s.anchorOffset, block: blk ? blk.getAttribute('data-model-index') : null };
    });
    const pageBefore = await app.eval(pageNow);
    info('caret at offset ' + before.offset + ' in block ' + before.block +
         ', page ' + pageBefore);

    await app.press('ArrowRight');
    await sleep(250);
    await app.press('ArrowRight');
    await sleep(400);

    const after = await app.eval(caret);
    const pageAfter = await app.eval(pageNow);
    info('after two ArrowRight: offset ' + after.offset + ' in block ' + after.block +
         ', page ' + pageAfter);
    assert(after.offset > before.offset,
        'the caret advanced (' + before.offset + ' -> ' + after.offset + ')');
    assert(pageAfter === pageBefore,
        'and the page did not turn under it (' + pageBefore + ' -> ' + pageAfter + ')');

    // PageDown is still the page turn while writing.
    console.log('\n=== and PageDown still turns the page while writing ===');
    await app.press('PageDown');
    await sleep(900);
    const pagedDown = await app.eval(pageNow);
    info('after PageDown: page ' + pagedDown);
    assert(pagedDown > pageAfter,
        'PageDown advanced the page (' + pageAfter + ' -> ' + pagedDown + ')');

    // --- Reader: the arrows are still the page turn ---------------------------------
    console.log('\n=== Reader: arrows still turn the page ===');
    await app.eval(() => handleCommand('view_set:mode:reader'));
    await sleep(3500);

    const ro = await app.eval(() => ({
        mode: state.mode,
        editable: document.getElementById('editor').isContentEditable
    }));
    info('mode ' + ro.mode + ', editable ' + ro.editable);
    assert(ro.mode === 'reader' && !ro.editable, 'Reader is read-only');

    const readerBefore = await app.eval(pageNow);
    await app.press('ArrowRight');
    await sleep(900);
    const readerAfter = await app.eval(pageNow);
    info('ArrowRight in Reader: page ' + readerBefore + ' -> ' + readerAfter);
    assert(readerAfter > readerBefore,
        'ArrowRight turns the page in Reader (' + readerBefore + ' -> ' + readerAfter + ')');

    await app.press('ArrowLeft');
    await sleep(900);
    const readerBack = await app.eval(pageNow);
    info('ArrowLeft in Reader: page ' + readerAfter + ' -> ' + readerBack);
    assert(readerBack < readerAfter,
        'and ArrowLeft turns it back (' + readerAfter + ' -> ' + readerBack + ')');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PAGE ARROW KEYS FAILED' : 'PAGE ARROW KEYS PASSED');
process.exit(failed ? 1 : 0);
