/**
 * Paging BACKWARD must not skip text either, and the end of the document must be reachable.
 *
 * page-coverage-app walks forward with PageMap.step(1) for a fixed 100 turns. On the
 * standard fixture that reaches block 1554 of 3767, so two things it is named for are
 * outside what it actually exercises:
 *
 *   1. The END of the document. The recorded fault -- localCount() dropping a range's last
 *      page because its start offset lies past maxScroll -- is a fault about the last page
 *      of a range, and the last page of the LAST range is the one a forward walk that stops
 *      two-fifths of the way in can never look at. go() ends that page at maxScroll on
 *      purpose so the tail shows flush right; this asserts the tail is actually shown, by
 *      paging to the end and asking whether the final model block was painted.
 *
 *   2. Going BACK. Every pagination suite in the tree steps forward. A reader turning back
 *      a page runs different arithmetic -- localIndex() has to answer "parked at maxScroll
 *      = the last page" or stepping back off it reads as "did not move" -- and nothing
 *      asserted that the backward walk shows a contiguous document. A gap going back is
 *      the same defect as a gap going forward: text the reader was never shown.
 *
 * A block may repeat between adjacent spreads -- one paragraph can span two columns -- and
 * seeing it twice is not a fault. A gap is: walking back from a spread starting at block
 * 104 onto one ending at 100 means 101-103 were never on screen.
 *
 * 2-column only, because that is the mode the original loss was found in and the one with
 * the shorter stride, so a dropped page hides more text per occurrence.
 *
 * The round-trip assertions at the end are the cheap half of page-integrity-app: after
 * going all the way out and part of the way back, the document must still be the document.
 *
 *   RUN_APP_E2E=1 node tests/page-reverse-coverage-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** Blocks painted inside the editor's visible box, right now. */
function visibleBlocksSrc() {
    const ed = document.getElementById('editor');
    const h = ed.getBoundingClientRect();
    const out = [];
    for (const b of ed.querySelectorAll('.block[data-model-index]')) {
        const mi = parseInt(b.getAttribute('data-model-index'), 10);
        if (!isFinite(mi)) continue;
        const r = b.getBoundingClientRect();
        if (r.bottom > h.top + 1 && r.top < h.bottom - 1 &&
            r.right > h.left + 1 && r.left < h.right - 1) out.push(mi);
    }
    return out;
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 8000 });
await sleep(2000);
await app.eval(() => handleCommand('view_set:scroll:pagination'));
await sleep(2000);
await app.eval(() => handleCommand('view_set:columns:2'));
await sleep(2600);

const total = await app.eval(() => DocumentModel.blocks.length);

// --- to the very end -------------------------------------------------------------
const end = await app.eval(async (src) => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    const visible = new Function('return (' + src + ')')();
    PageMap.goto(0);
    await nap(1200);
    let turns = 0;
    // Generous bound: this walks the whole document, not a sample.
    for (let i = 0; i < 4000; i++) {
        if (PageMap.step(1) === false) break;
        turns++;
        await nap(35);
    }
    await nap(600);
    const v = visible();
    const ed = document.getElementById('editor');
    return {
        turns, page: PageMap.current(), n: v.length,
        maxShown: v.length ? Math.max(...v) : -1,
        mounted: ed.querySelectorAll('.block[data-model-index]').length
    };
}, visibleBlocksSrc.toString());

info('paged to the end in ' + end.turns + ' turns (page ' + end.page + '); ' +
    'last block shown ' + end.maxShown + ' of ' + (total - 1) +
    '; ' + end.mounted + ' mounted of ' + total);
assert(end.turns > 100, 'the walk reached the end by turning, not by giving up (' + end.turns + ')');
assert(end.mounted < total,
    'PREMISE: the DOM is a window, so a skipped tail could show up (' + end.mounted + ' of ' + total + ')');
assert(end.n > 0, 'the final spread is not blank (' + end.n + ' blocks painted)');
assert(end.maxShown >= total - 1,
    'the LAST block of the document is reachable by paging (' + end.maxShown + ' of ' + (total - 1) + ')');

// --- and back again --------------------------------------------------------------
const back = await app.eval(async (src) => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    const visible = new Function('return (' + src + ')')();
    const spreads = [];
    for (let i = 0; i < 160; i++) {
        const v = visible();
        spreads.push(v.length
            ? { page: PageMap.current(), min: Math.min(...v), max: Math.max(...v), n: v.length }
            : { page: PageMap.current(), min: -1, max: -1, n: 0 });
        if (PageMap.step(-1) === false) break;
        await nap(90);
    }
    // Walking back: spreads[i] is OLDER (earlier in the document) than spreads[i-1].
    // A gap is the newer spread starting above where the older one ended.
    const gaps = [];
    for (let i = 1; i < spreads.length; i++) {
        const newer = spreads[i - 1], older = spreads[i];
        if (newer.min < 0 || older.max < 0) continue;
        if (newer.min > older.max + 1) {
            gaps.push({
                fromPage: newer.page, toPage: older.page,
                never: older.max + 1 + '..' + (newer.min - 1),
                missing: newer.min - older.max - 1
            });
        }
    }
    return {
        spreads: spreads.length,
        empty: spreads.filter(s => s.n === 0).length,
        gaps,
        reached: spreads.length ? spreads[spreads.length - 1].min : -1
    };
}, visibleBlocksSrc.toString());

info('walked back ' + back.spreads + ' spreads to block ' + back.reached + '; ' +
    back.gaps.length + ' gap(s)' +
    (back.gaps.length ? ' - ' + JSON.stringify(back.gaps.slice(0, 4)) : ''));
assert(back.spreads > 60, 'the backward walk actually moved (' + back.spreads + ')');
assert(back.empty === 0, 'no blank spread going backward (' + back.empty + ')');
assert(back.gaps.length === 0, 'turning back never skips a block (' + back.gaps.length + ')');

// --- the document is still the document ------------------------------------------
const intact = await app.eval(() => {
    const t = getDocumentStateTagged();
    return { flag: t[0], len: t.slice(1).length, blocks: DocumentModel.blocks.length };
});
assert(intact.blocks === total, 'block count survived the round trip (' + intact.blocks + ')');
assert(intact.flag === '0', 'the round trip did not dirty the document (flag=' + intact.flag + ')');

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PAGE REVERSE COVERAGE FAILED' : 'PAGE REVERSE COVERAGE PASSED');
await app.close();
process.exit(failed ? 1 : 0);
