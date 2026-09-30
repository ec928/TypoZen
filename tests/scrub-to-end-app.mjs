// Dragging the page scrubber to the end of a book lands on its last page.
//
// It went to the page holding the last block, which is the last page only when that block fits
// on one. The Project Gutenberg Alice ends in one block holding the whole licence, 11 pages in
// 2-Col, so the drag stopped on page 97 of 108 -- every time (Ed, 2026-09-30). The drag is a
// real mouse drag of the thumb, twice, returning to the start in between.
//
//   RUN_APP_E2E=1 node tests/scrub-to-end-app.mjs
import path from 'path';
import { launchApp, appDir } from './app-harness.mjs';

let passed = 0, failed = 0;
function check(ok, msg, got) {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg + (got !== undefined ? '  (got ' + JSON.stringify(got) + ')' : '')); }
}
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 60000);
const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function dragThumbTo(app, toEnd) {
    const b = await app.eval(() => {
        const r = document.getElementById('page-scrubber-range');
        const rc = r.getBoundingClientRect();
        return { x: rc.left, y: rc.top + rc.height / 2, w: rc.width, v: +r.value, max: +r.max };
    });
    const x0 = b.x + 8 + (b.w - 16) * (b.max ? b.v / b.max : 0);
    const x1 = toEnd ? b.x + b.w + 40 : b.x - 40;
    await app.page.mouse.move(x0, b.y);
    await app.page.mouse.down();
    for (let s = 1; s <= 10; s++) { await app.page.mouse.move(x0 + (x1 - x0) * s / 10, b.y); await pause(30); }
    await app.page.mouse.up();
    await pause(1500);
}

let app;
try {
    app = await launchApp({ file: path.join(appDir, 'tests', 'alices-adventures-in-wonderland3.epub'), settleMs: 6000 });
    await app.eval(() => handleCommand('view_set:columns:2'));
    await pause(1500);
    const spans = await app.eval(() => {
        const el = elementForModelIndex(DocumentModel.blocks.length - 1);
        return el ? Math.round(el.getBoundingClientRect().width / twoColPageWidth()) : 0;
    });
    check(spans > 2, 'control: the book\'s last block spans several pages', spans);
    for (let k = 1; k <= 2; k++) {
        await dragThumbTo(app, true);
        const at = await app.eval(() => ({ page: PageMap.current(), total: PageMap.count() }));
        check(at.page >= at.total - 2, 'drag #' + k + ' to the end lands on the last spread', at);
        await dragThumbTo(app, false);
    }
} catch (e) {
    failed++;
    console.log('  FAIL threw: ' + e.message);
} finally {
    if (app) await app.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'SCRUB TO END FAILED' : 'SCRUB TO END PASSED');
process.exit(failed ? 1 : 0);
