// The page changing size mid-book (ZenMode hides the chrome and the page grows) must not lose
// track of which range of the book is on screen.
//
// A window resize retired the page map with PageChunks.invalidate(), which also forgot the
// mounted range while it stayed in the DOM. Navigation then worked from "nothing mounted":
// on the Xeelee omnibus, three pages back from the middle read "61-62 / ~5458" over text from
// the middle of the book, and the reader could not get back to the start until a tab switch
// remounted it (Ed, 2026-09-30). The total also collapsed to the seed estimate.
//
//   RUN_APP_E2E=1 node tests/page-resize-app.mjs
import path from 'path';
import { launchApp, appDir } from './app-harness.mjs';

let passed = 0, failed = 0;
function check(ok, msg, got) {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg + (got !== undefined ? '  (got ' + JSON.stringify(got) + ')' : '')); }
}
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 90000);
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const book = path.join(appDir, 'tests', 'Xeelee Sequence - [Xeelee  Books 1 to 12] -  Stephen Baxter.epub');

// What is on screen, and what the page numbers claim about it.
const where = () => {
    const ed = document.getElementById('editor');
    const r = ed.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + 40, r.top + 60);
    const blk = el && el.closest ? el.closest('.block') : null;
    const bi = blk ? +blk.getAttribute('data-model-index') : -1;
    return { block: bi, chunkOfBlock: bi >= 0 ? PageChunks.chunkOfBlock(bi) : -1, mounted: PageChunks.mounted,
        page: PageMap.current(), total: PageMap.count() };
};

let app;
try {
    app = await launchApp({ file: book, settleMs: 7000, view: true });
    await app.eval(() => handleCommand('view_set:columns:2'));
    await pause(1500);
    await app.eval(() => goToModelBlock(Math.floor(DocumentModel.blocks.length / 2)));
    await pause(2000);
    const before = await app.eval(where);
    console.log('  ..   middle: ' + JSON.stringify(before));
    check(before.mounted === before.chunkOfBlock, 'control: the range on screen is the one recorded as mounted', before);

    const vp = await app.eval(() => ({ w: innerWidth, h: innerHeight }));
    await app.page.setViewport({ width: vp.w, height: vp.h + 110 });    // ZenMode: the page grows
    await pause(2000);
    const taller = await app.eval(where);
    console.log('  ..   taller: ' + JSON.stringify(taller));
    check(taller.mounted === taller.chunkOfBlock && taller.mounted >= 0,
        'after the page grows, the range on screen is still the one recorded as mounted', taller);

    for (let i = 0; i < 3; i++) { await app.page.keyboard.press('PageUp'); await pause(700); }
    const back = await app.eval(where);
    console.log('  ..   3 pages back: ' + JSON.stringify(back));
    check(back.block < taller.block && back.block > taller.block - 400, 'PageUp turns back through the same part of the book', back);
    check(back.page > before.page * 0.5, 'the page number stays in the middle of the book (it collapsed to ~60 before)', back.page);
    check(back.total > before.total * 0.5, 'the total does not collapse to the seed estimate', back.total);
} catch (e) {
    failed++;
    console.log('  FAIL threw: ' + e.message);
} finally {
    if (app) await app.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PAGE RESIZE FAILED' : 'PAGE RESIZE PASSED');
process.exit(failed ? 1 : 0);
