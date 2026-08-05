/**
 * The position control reaches both ends of a book.
 *
 * The editor's own scrollbar spans the range currently laid out and nothing more -- about
 * 28 pages of a 1400-page novel -- so dragging it could not take a reader to either end.
 * The scrubber addresses pages instead, which is the coordinate that describes the whole
 * document however little of it is mounted.
 *
 * Driven through the control's own events, not by calling PageMap.goto(): what is being
 * checked is that dragging the thing on screen arrives somewhere, and a test that calls
 * the seek underneath it would pass with the control unwired.
 *
 *   RUN_APP_E2E=1 node tests/page-scrubber-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const books = fs.readdirSync(path.join(appDir, 'tests'))
    .filter(f => f.toLowerCase().endsWith('.epub')).sort();
const biggest = books.length
    ? books.map(b => ({ b, size: fs.statSync(path.join(appDir, 'tests', b)).size }))
        .sort((x, y) => y.size - x.size)[0].b
    : null;
if (!biggest) {
    console.log('  --   no .epub in tests/, nothing to verify.');
    console.log('passed=0 failed=0');
    console.log('PAGE SCRUBBER SKIPPED');
    process.exit(0);
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3000);

    // The scrolling case has to be asked of a Markdown document. A book is Reader, Reader
    // is pages, and the loader now enforces that -- so a book can no longer be put into a
    // scrolling layout at all, which is the point of the mode rules.
    const md = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const host = document.getElementById('page-scrubber');
        handleCommand('view_set:mode:preview'); await sleep(1000);
        handleCommand('view_set:columns:1'); await sleep(800);
        handleCommand('view_set:scroll:scroll'); await sleep(1500);
        const scrolling = host.style.display !== 'none';
        handleCommand('view_set:scroll:pagination'); await sleep(2500);
        return { scrolling: scrolling, paginated: host.style.display !== 'none' };
    });
    assert(!md.scrolling,
        'a scrolling layout has no pages to scrub, so the control is not offered');
    assert(md.paginated,
        'and it appears when the same document is paginated');

    await app.eval((p) => postMsg('open_file_path:' + p), path.join(appDir, 'tests', biggest));
    await sleep(11000);
    await settledApp(app, 40000);

    const r = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const host = document.getElementById('page-scrubber');
        const range = document.getElementById('page-scrubber-range');
        const drag = async (v) => {
            range.value = String(v);
            range.dispatchEvent(new Event('input', { bubbles: true }));
            range.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(2500);
        };
        const out = {
            shown: host.style.display !== 'none',
            max: parseInt(range.max, 10),
            pages: PageMap.count(),
            blocks: DocumentModel.blocks.length,
            chunks: PageChunks.counts ? PageChunks.counts.length : 0
        };

        await drag(parseInt(range.max, 10));
        out.endBlock = topLeftModelIndexTwoCol();
        out.endChunk = PageChunks.mounted;
        out.endPage = PageMap.current();
        out.endTotal = PageMap.count();

        await drag(0);
        out.startBlock = topLeftModelIndexTwoCol();
        out.startPage = PageMap.current();

        // Halfway, then the scrubber must report where the reader now is.
        await drag(Math.floor(parseInt(range.max, 10) / 2));
        out.midBlock = topLeftModelIndexTwoCol();
        out.midValue = parseInt(range.value, 10);
        out.midCurrent = PageMap.current();

        // A book cannot leave a paginated layout: Reader is pages, and the selectors
        // refuse to take a read-only document anywhere else.
        handleCommand('view_set:scroll:scroll');
        await sleep(1500);
        out.stillPaginated = isPaginatedLayout() && host.style.display !== 'none';
        return out;
    });

    info('scrubber spans 0..' + r.max + ' for ' + r.pages + ' pages, ' +
         r.chunks + ' ranges, ' + r.blocks + ' blocks');
    assert(r.shown, 'the scrubber is there as soon as the book opens');
    assert(r.max > 100,
        'and spans the whole book, not the range that happens to be laid out (' + r.max + ')');

    info('dragged to the end: block ' + r.endBlock + ' of ' + r.blocks +
        ', range ' + r.endChunk + ', page ' + r.endPage + ' of ' + r.endTotal);
    assert(r.endBlock >= r.blocks - 60,
        'dragging to the end arrives at the end of the book (' +
        r.endBlock + ' of ' + r.blocks + ')');
    assert(r.endPage >= r.endTotal - 2,
        'and on its last page, not short of it once the total is re-measured (' +
        r.endPage + ' of ' + r.endTotal + ')');

    info('dragged back to the start: block ' + r.startBlock + ', page ' + r.startPage);
    assert(r.startBlock === 0 && r.startPage === 0,
        'dragging back to the start returns to the first page');

    info('dragged to the middle: block ' + r.midBlock + ', page ' + r.midCurrent +
        ', thumb ' + r.midValue);
    assert(r.midBlock > 0 && r.midBlock < r.blocks,
        'dragging to the middle lands inside the book (' + r.midBlock + ')');
    assert(Math.abs(r.midValue - r.midCurrent) <= 2,
        'and the thumb reports where the reader actually is (' +
        r.midValue + ' vs ' + r.midCurrent + ')');

    assert(r.stillPaginated,
        'a book stays paginated when asked to scroll, rather than landing somewhere ' +
        'the scroll selector is locked out of leaving');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PAGE SCRUBBER FAILED' : 'PAGE SCRUBBER PASSED');
process.exit(failed ? 1 : 0);
