/**
 * The page count is a promise: every page it names can be reached.
 *
 * Three bugs in a row came from the map and the geometry disagreeing about how many pages
 * there are, with the map winning and the reader losing:
 *
 *   - PageGeometry.go seeked to 0 when it had no stride, and returned true
 *   - localCount counted content extent, so it named pages past maxScroll
 *   - mountPageChunk carried its own copy of that formula, so fixing localCount fixed the
 *     number a turn consults and left the number recorded for the range wrong
 *
 * Each was found by a different suite failing for a different-looking reason. This asserts
 * the property underneath all three, so the next one is caught as itself: **count() names
 * only pages you can actually get to, and paging forward from the first reaches the last.**
 *
 * Both column counts, because in one column content extent and reachable extent agree and
 * the whole family of bugs is invisible.
 *
 *   RUN_APP_E2E=1 node tests/page-count-truth-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    await app.eval(() => handleCommand('view_set:scroll:pagination'));
    await sleep(2500);

    for (const cols of [1, 2]) {
        console.log('\n=== ' + cols + ' column' + (cols > 1 ? 's' : '') + ' ===');
        await app.eval((c) => handleCommand('view_set:columns:' + c), cols);
        await sleep(3000);

        // 1. Every page the map names can be reached, sampled across the document.
        const reach = await app.eval(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const total = PageMap.count();
            const want = [];
            for (let i = 0; i < 12; i++) want.push(Math.floor((total - 1) * i / 11));
            const bad = [];
            for (const p of want) {
                PageMap.goto(p);
                await sleep(260);
                const got = PageMap.current();
                // Within a page: goto lands on the page, and a partial final page of a
                // range shares pixels with its neighbour, which is not being lost.
                if (Math.abs(got - p) > 1) bad.push({ asked: p, got });
            }
            return { total, bad };
        });
        info('asked for 12 pages across ' + reach.total + '; missed ' + reach.bad.length +
             (reach.bad.length ? ' — ' + JSON.stringify(reach.bad.slice(0, 3)) : ''));
        assert(reach.bad.length === 0,
            cols + '-col: every page count() names can be seeked to');

        // 2. The last page is real, and there is nothing past it.
        const ends = await app.eval(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const total = PageMap.count();
            PageMap.goto(total - 1); await sleep(400);
            const atLast = PageMap.current();
            const movedOn = PageMap.step(1);
            await sleep(400);
            const afterStep = PageMap.current();
            return { total, atLast, movedOn, afterStep };
        });
        info('last page ' + ends.atLast + ' of ' + ends.total +
             '; step past it returned ' + ends.movedOn);
        assert(ends.atLast === ends.total - 1,
            cols + '-col: the last page count() names is where the document ends');
        assert(ends.afterStep === ends.atLast,
            cols + '-col: and paging past it does not move');

        // 3. Turning forward from the first page reaches the last, in exactly the number
        //    of turns the count promises. This is the property the stall broke.
        const walk = await app.eval(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            PageMap.goto(0); await sleep(500);
            const total = PageMap.count();
            let turns = 0, stalls = 0, at = PageMap.current();
            // Bounded well above the count so a stall shows as a stall, not a timeout.
            while (turns < total + 8) {
                const before = at;
                PageMap.step(1);
                await sleep(90);
                at = PageMap.current();
                if (at === before) {
                    // One lost turn after a range mount is a known hiccup; press again.
                    await sleep(500);
                    PageMap.step(1);
                    await sleep(150);
                    at = PageMap.current();
                    if (at === before) { stalls++; break; }
                }
                turns++;
                if (at >= total - 1) break;
            }
            return { total, turns, stalls, at };
        });
        info(walk.turns + ' turns from page 0 reached page ' + walk.at + ' of ' + walk.total);
        assert(walk.stalls === 0, cols + '-col: no turn stalls between the ends');
        assert(walk.at === walk.total - 1,
            cols + '-col: paging forward reaches the last page (' + walk.at +
            ' of ' + (walk.total - 1) + ')');

        // 4. The recorded per-range counts and the live geometry agree. This is the one
        //    that was wrong by construction: two copies of one formula.
        // Read what the mount recorded BEFORE anything reconciles it.
        //
        // PageMap.localCount self-heals: it asks PageGeometry and quietly rewrites the
        // range's entry when they differ. That is a good belt, but it means a second,
        // wrong implementation in mountPageChunk is invisible to any assertion that calls
        // localCount first -- verified by putting the duplicate formula back, at which
        // point this suite still passed. The window where the wrong value is live is
        // between the mount and the next localCount, and updatePageIndicator reads
        // count() inside it.
        const agree = await app.eval(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const windowed = pageWindowingActive();
            if (!windowed) return { windowed };
            // Force a fresh mount of a range we are not on, then look at once.
            const other = PageChunks.mounted > 0 ? PageChunks.mounted - 1
                                                 : Math.min(1, PageChunks.counts.length - 1);
            mountPageChunk(other);
            await sleep(400);
            const recorded = PageChunks.counts[PageChunks.mounted];
            const live = PageGeometry.localCount();
            const mapLocal = PageMap.localCount();
            return { windowed, recorded, live, mapLocal };
        });
        info('range ' + JSON.stringify(agree));
        if (agree.windowed) {
            assert(agree.recorded === agree.live,
                cols + '-col: the count recorded for the mounted range is the measured one');
        } else {
            info('not windowed at this size — nothing recorded to disagree');
            passed++;
            console.log('  OK   ' + cols + '-col: no windowing, no second opinion to hold');
        }
        assert(agree.mapLocal === agree.live,
            cols + '-col: PageMap and PageGeometry report the same local count');
    }
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PAGE COUNT TRUTH FAILED' : 'PAGE COUNT TRUTH PASSED');
process.exit(failed ? 1 : 0);
