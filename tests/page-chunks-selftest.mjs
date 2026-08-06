/**
 * The page-range map, on its own, before any of it touches the DOM.
 *
 * PageChunks is to pagination what DocumentModel.blockHeights is to scrolling: a per-range
 * page count whose cumulative sum gives the global page number, estimated at first and
 * refined as ranges are actually laid out. It carries the same three rules, each of which
 * cost a real bug in the scrolling path:
 *
 *   - estimate, then refine from measurement
 *   - a structural edit SPLICES the map rather than discarding it. invalidateHeights()
 *     threw away every measurement on any edit, so the next prefix sum was rebuilt from
 *     estimates and the viewport moved by the accumulated error -- 1562px per pasted block.
 *   - the range on screen is measured, never trusted from its estimate. An estimated
 *     current page is the 2px page-boundary bug wearing a different hat.
 *
 * Testing it here, extracted and DOM-free, is deliberate: the same logic embedded in the
 * layout can only be tested through a browser, and every property below is arithmetic.
 *
 *   node tests/page-chunks-selftest.mjs
 */
import { readEngineSource } from './engine-source.mjs';

const src = readEngineSource();

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

// Extract the shipping object rather than reimplementing it: a test that passes against
// its own copy proves nothing.
const start = src.indexOf('const PageChunks = {');
if (start < 0) { console.error('  FAIL PageChunks not found in engine modules'); process.exit(1); }
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const PageChunks = new Function(src.slice(start, end) + '; return PageChunks;')();

const N = 3767;   // the mixed fixture

console.log('--- 1. the map covers the document ---');
{
    PageChunks.invalidate();
    const chunks = PageChunks.ensure(N);
    assert(chunks === Math.ceil(N / PageChunks.size),
        'one range per ' + PageChunks.size + ' blocks (' + chunks + ' for ' + N + ')');
    assert(PageChunks.counts.length === chunks && PageChunks.measured.length === chunks,
        'counts and measured are the same length as the range list');
    assert(PageChunks.counts.every(c => c >= 1),
        'every range starts with at least one page, so no page number is unreachable');
    assert(PageChunks.chunkOfBlock(0) === 0 &&
           PageChunks.chunkOfBlock(N - 1) === chunks - 1,
        'the first and last block land in the first and last range');
    assert(PageChunks.chunkOfBlock(PageChunks.size) === 1,
        'the block after the first range is in the second');
}

console.log('\n--- 2. page numbers and ranges agree in both directions ---');
{
    PageChunks.invalidate();
    PageChunks.ensure(N);
    // Give the ranges uneven counts, as real content does.
    for (let i = 0; i < PageChunks.counts.length; i++) {
        PageChunks.setMeasured(i, 3 + (i % 7));
    }
    let ok = true, badAt = -1;
    for (let c = 0; c < PageChunks.counts.length; c++) {
        const first = PageChunks.prefixPages(c);
        const loc = PageChunks.locatePage(first);
        if (loc.chunk !== c || loc.local !== 0) { ok = false; badAt = c; break; }
        const last = first + PageChunks.counts[c] - 1;
        const locLast = PageChunks.locatePage(last);
        if (locLast.chunk !== c || locLast.local !== PageChunks.counts[c] - 1) {
            ok = false; badAt = c; break;
        }
    }
    assert(ok, 'the first and last page of every range locate back to it' +
        (ok ? '' : ' -- failed at range ' + badAt));

    const total = PageChunks.totalPages();
    assert(total === PageChunks.counts.reduce((a, b) => a + b, 0),
        'the total is the sum of the ranges (' + total + ')');
    const beyond = PageChunks.locatePage(total + 50);
    assert(beyond.chunk === PageChunks.counts.length - 1,
        'a page past the end clamps to the last range rather than running off it');
    assert(PageChunks.locatePage(-5).chunk === 0, 'a negative page clamps to the first');
}

console.log('\n--- 3. measuring one range does not move the ranges before it ---');
{
    PageChunks.invalidate();
    PageChunks.ensure(N);
    for (let i = 0; i < PageChunks.counts.length; i++) PageChunks.setMeasured(i, 5);
    // Derived, not named: 4 was a middle range only while the range size was 400. At 800
    // it is the last one, and "the range after it" stopped existing.
    const target = Math.floor(PageChunks.counts.length / 2);
    const beforePrefix = PageChunks.prefixPages(target);
    PageChunks.setMeasured(target, 12);
    assert(PageChunks.prefixPages(target) === beforePrefix,
        'pages before the measured range are unchanged (' +
        PageChunks.prefixPages(target) + ' vs ' + beforePrefix + ')');
    assert(PageChunks.counts[target] === 12, 'the measured range took the real count');
    assert(PageChunks.counts[target + 1] === 5,
        'the next range kept its own measurement rather than being re-estimated');
}

console.log('\n--- 4. estimates refine as ranges are measured ---');
{
    PageChunks.invalidate();
    PageChunks.ensure(N);
    const naive = PageChunks.counts[PageChunks.counts.length - 1];
    // Measure the first few ranges as much denser than the seed estimate. Expressed
    // against the range size rather than as a bare number: 40 pages was denser than the
    // 0.06 seed when a range was 400 blocks and thinner than it once a range became 800,
    // so the test quietly started asserting the opposite of what it says.
    const dense = Math.round(PageChunks.size * 0.12);
    for (let i = 0; i < 3; i++) PageChunks.setMeasured(i, dense);
    // Read the live map rather than rebuilding it. invalidate() forgets the learned
    // density on purpose -- a page count belongs to a layout -- so a rebuild in between
    // was measuring the seed and calling it the refined figure.
    const refined = PageChunks.counts[PageChunks.counts.length - 1];
    assert(refined > naive,
        'unmeasured ranges follow what measurement has shown (' + naive + ' -> ' + refined + ')');
    // The last range is short, and counting it as a full one is what made a real book
    // report 540 pages in one column and 708 in two.
    const lastBlocks = N - PageChunks.size * (PageChunks.counts.length - 1);
    assert(PageChunks.blocksInChunk(PageChunks.counts.length - 1) === lastBlocks,
        'the last range is measured by the blocks it holds, not a full range (' +
        PageChunks.blocksInChunk(PageChunks.counts.length - 1) + ' of ' + PageChunks.size + ')');
    assert(Math.abs(PageChunks.perBlock - dense / PageChunks.size) < 1e-9,
        'the density is pages over the blocks actually measured (' +
        PageChunks.perBlock.toFixed(4) + ')');
    assert(PageChunks.perBlock > 0 && PageChunks.perBlock <= 1,
        'the pages-per-block estimate stays in range (' + PageChunks.perBlock.toFixed(4) + ')');
}

console.log('\n--- 5. a structural edit splices the map, it does not discard it ---');
{
    PageChunks.invalidate();
    PageChunks.ensure(N);
    for (let i = 0; i < PageChunks.counts.length; i++) PageChunks.setMeasured(i, 6);
    // A range in the middle, derived rather than named: this used to say range 5, which
    // existed only while the range size was 400 and fell off the end of the document the
    // moment it changed.
    const editedChunk = Math.floor(PageChunks.counts.length / 2);
    const editedBlock = PageChunks.size * editedChunk + 10;
    const prefixBefore = PageChunks.prefixPages(editedChunk);

    PageChunks.spliceBlocks(editedBlock, 1, N + 1);

    assert(PageChunks.measured[editedChunk] === false,
        'the edited range loses its measurement, because its page count really is unknown');
    assert(PageChunks.measured[editedChunk - 1] === true &&
           PageChunks.measured[editedChunk + 1] === true,
        'every other range keeps its measurement');
    assert(PageChunks.prefixPages(editedChunk) === prefixBefore,
        'the pages before the edit do not move (' +
        PageChunks.prefixPages(editedChunk) + ' vs ' + prefixBefore + ')');

    // Growing past a range boundary adds a range without disturbing the rest.
    const wasChunks = PageChunks.counts.length;
    PageChunks.ensure(N + PageChunks.size);
    assert(PageChunks.counts.length === wasChunks + 1, 'growing the document adds a range');
    assert(PageChunks.measured.slice(0, editedChunk).every(Boolean),
        'and leaves earlier measurements alone');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nPAGE CHUNKS SELFTEST FAILED');
    process.exit(1);
}
console.log('\nPAGE CHUNKS SELFTEST PASSED');
process.exit(0);
