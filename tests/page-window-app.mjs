/**
 * Page windowing, against the shipped binary.
 *
 * Pagination mounts the whole document because the browser can only fragment content it
 * has laid out. Windowing lays out one range of blocks at a time instead, which is what
 * makes a book-sized document viable -- and what makes the DOM stop being the document.
 *
 * The first assertion here is the one that matters more than the performance:
 * getMarkdownContent's full-mount branch rebuilds the model from the DOM when the counts
 * differ. With a window mounted that would rebuild a 3767-block document from the 400 on
 * screen and save the result. Every other property in this file is a nicety; that one is
 * whether the feature is allowed to exist.
 *
 *   node tests/page-window-app.mjs
 */
import { launchApp } from './app-harness.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3000);

    // The feature ships disabled until the column round trip holds. Skip rather than fail,
    // so the gate stays honest about what is and is not enabled.
    const enabled = await app.eval(() => PAGE_WINDOWING_ENABLED);
    if (!enabled) {
        console.log('  --   PAGE_WINDOWING_ENABLED is false; nothing to verify.');
        console.log('       Set it true in the page engine (js/modules) to run these checks.');
        console.log('passed=0 failed=0');
        console.log('PAGE WINDOW SKIPPED');
        await app.close();
        process.exit(0);
    }

    // Baseline in a scrolling view, where the whole document is definitely intact.
    await app.eval(() => handleCommand('view_set:columns:1'));
    await sleep(1500);
    await app.eval(() => handleCommand('view_set:scroll:scroll'));
    await sleep(2500);
    const base = await app.eval(() => ({
        text: getMarkdownContent(false),
        blocks: DocumentModel.blocks.length
    }));
    info('document: ' + base.blocks + ' blocks, ' + base.text.length + ' chars');

    console.log('\n=== entering pagination mounts a range, not the document ===');
    await app.eval(() => handleCommand('view_set:columns:2'));
    await sleep(1800);
    await app.eval(() => handleCommand('view_set:scroll:pagination'));
    await sleep(3000);

    const win = await app.eval(() => ({
        active: pageWindowingActive(),
        mountedBlocks: editor.querySelectorAll('.block').length,
        modelBlocks: DocumentModel.blocks.length,
        chunkSize: PageChunks.size,
        mountedChunk: PageChunks.mounted,
        totalPages: PageMap.count(),
        localPages: PageMap.localCount()
    }));
    info('mounted ' + win.mountedBlocks + ' of ' + win.modelBlocks + ' blocks, range ' +
        win.mountedChunk + ', pages ' + win.localPages + ' local / ' + win.totalPages + ' total');
    assert(win.active, 'windowing engaged for a document this size');
    assert(win.mountedBlocks <= win.chunkSize,
        'only one range is laid out (' + win.mountedBlocks + ' <= ' + win.chunkSize + ')');
    assert(win.mountedBlocks < win.modelBlocks / 2,
        'that is substantially less than the whole document');
    assert(win.totalPages > win.localPages,
        'the page count covers the document, not just the mounted range (' +
        win.totalPages + ' vs ' + win.localPages + ')');

    console.log('\n=== the document survives being windowed ===');
    const saved = await app.eval(() => getMarkdownContent(false));
    assert(saved.length === base.text.length,
        'serialising while windowed returns the whole document (' + saved.length +
        ' vs ' + base.text.length + ' chars)');
    assert(saved === base.text, 'and returns it byte for byte');
    const modelNow = await app.eval(() => DocumentModel.blocks.length);
    assert(modelNow === base.blocks,
        'the model still holds every block (' + modelNow + ' vs ' + base.blocks + ')');

    console.log('\n=== paging forward never stands still ===');
    // Reported as "I cannot go beyond this page unless I force the scrubber", and it took
    // several attempts to find because it needs the reader to arrive by turning pages.
    //
    // The page count comes from the content extent and the seek comes from the scrollable
    // range, and those differ by up to a page whenever the last page of a range is partial.
    // The map then offers a page the seek cannot reach: the target looked in range, so the
    // branch that crosses into the next range was never tried; the seek clamped back to
    // where it started and reported success. Every further press did nothing, forever.
    // Measured on Xeelee: page 39 of 40 began at 70200 with the furthest scroll at 70181.
    const walk = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(Math.floor(DocumentModel.blocks.length * 0.42));
        await sleep(2500);
        let stalls = 0, first = null, crossed = 0, atEnd = false, hiccups = 0;
        let chunk = PageChunks.mounted;
        for (let i = 0; i < 120; i++) {
            // A reader's cadence, not a machine's. The key handler throttles repeats to
            // 150ms, so stepping faster than that measures a race the app never sees --
            // a turn issued before a freshly mounted range has settled computes against
            // stale geometry and does nothing. That is worth knowing and is not this
            // check's subject, which is whether a settled reader can be stranded.
            await sleep(220);
            const before = PageMap.current();
            PageMap.step(1);
            // Settle before judging. A turn that crosses a range has to mount 800 blocks,
            // so a fixed short wait reports a stall for what is only slowness -- and a
            // flaky assertion about being stranded is worse than none.
            let moved = false;
            for (let t = 0; t < 12 && !moved; t++) {
                await sleep(60);
                moved = PageMap.current() !== before;
            }
            if (!moved) {
                atEnd = PageMap.current() >= PageMap.count() - 1;
                if (atEnd) break;   // end of the document; refusing is correct
                // One lost turn is a hiccup, not being stranded. Mounting a range lays out
                // 800 blocks, and a turn issued before that settles is computed against
                // stale geometry and does nothing -- reproducibly, on the turn after a
                // crossing. Pressing again works. What the reader reported, and what this
                // asserts, is the other thing: a page you cannot get past at all.
                hiccups++;
                await sleep(900);
                const retryFrom = PageMap.current();
                PageMap.step(1);
                for (let t = 0; t < 12 && !moved; t++) {
                    await sleep(80);
                    moved = PageMap.current() !== retryFrom;
                }
                if (!moved) {
                    stalls++;
                    first = { turn: i, page: retryFrom, of: PageMap.count(),
                        local: PageMap.localCurrent(), localCount: PageMap.localCount() };
                    break;
                }
            }
            if (PageChunks.mounted !== chunk) { crossed++; chunk = PageChunks.mounted; }
        }
        return { stalls, first, crossed, atEnd, hiccups };
    });
    info('120 turns, ' + walk.crossed + ' range crossings, ' + walk.hiccups +
         ' turns lost to a mount, ' + walk.stalls + ' stalls' +
         (walk.atEnd ? ', stopped at the end of the document' : '') +
         (walk.first ? ' — first at ' + JSON.stringify(walk.first) : ''));
    assert(walk.stalls === 0,
        'a page turn always turns a page (' + walk.stalls + ' stalled)');
    assert(walk.crossed > 0,
        'and the walk crossed at least one range boundary (' + walk.crossed + ')');

    console.log('\n=== turning pages crosses ranges ===');
    const turned = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Start from the front, not from wherever the app happened to open.
        //
        // This used to read PageChunks.mounted as it found it, which is set by the restored
        // reading position -- so the range it called "start" was whatever the previous
        // suite in the run had left behind. Run alone it opened in range 3 and passed; run
        // after the others it opened in range 4 of 4, "the next range" did not exist,
        // goto() clamped to the end and the assertion failed on a product that was working.
        PageMap.goto(1);
        await sleep(600);
        const startChunk = PageChunks.mounted;
        const target = PageChunks.prefixPages(startChunk + 1) + 1;
        PageMap.goto(target);
        await sleep(600);
        return {
            startChunk: startChunk,
            chunks: PageChunks.chunkCount(DocumentModel.blocks.length),
            asked: target,
            nowChunk: PageChunks.mounted,
            nowPage: PageMap.current(),
            topBlock: topLeftModelIndexTwoCol(),
            firstBlockOfChunk: PageChunks.firstBlockOfChunk(PageChunks.mounted)
        };
    });
    info('range ' + turned.startChunk + ' -> ' + turned.nowChunk +
        ' (of ' + turned.chunks + '), page ' + turned.nowPage +
        ', top block ' + turned.topBlock);
    // And say so out loud if there is nothing to cross into, rather than reporting the
    // clamp as a windowing failure.
    assert(turned.startChunk === 0,
        'the crossing starts from the first range, whatever was open before (' +
        turned.startChunk + ')');
    assert(turned.nowChunk === turned.startChunk + 1,
        'going to a page in the next range mounts that range');
    assert(turned.topBlock >= turned.firstBlockOfChunk,
        'the content on screen is from the range that was mounted');

    console.log('\n=== leaving pagination restores the whole document ===');
    // Back to a single column first: the resolver requires pagination in 2-column, so
    // asking for Scroll while still in 2-col is correctly refused, and a test that did not
    // know that would have reported the refusal as a windowing bug.
    await app.eval(() => handleCommand('view_set:columns:1'));
    await sleep(2000);
    await app.eval(() => handleCommand('view_set:scroll:scroll'));
    await sleep(3500);
    const back = await app.eval(() => ({
        text: getMarkdownContent(false),
        blocks: DocumentModel.blocks.length,
        paginated: isPaginatedLayout()
    }));
    assert(!back.paginated, 'the view really left pagination');
    assert(back.blocks === base.blocks,
        'the model is intact after the round trip (' + back.blocks + ')');
    assert(back.text === base.text, 'and the document is byte for byte what it was');

    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.error('\nPAGE WINDOW FAILED'); process.exitCode = 1; }
    else console.log('\nPAGE WINDOW PASSED');
} finally {
    await app.close();
}
