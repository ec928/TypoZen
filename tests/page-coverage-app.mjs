/**
 * Turning pages must never skip text.
 *
 * Every other pagination suite asks whether a turn MOVES: page-window-app counts stalls,
 * page-count-truth-app checks that a page the map names can be reached, page-arrow-keys
 * checks which key turns. None of them asked the question a reader actually cares about --
 * did I see all the words -- and a turn that jumps two pages forward passes every one of
 * them.
 *
 * It was not hypothetical. Reading a text file in 2-column Pages, blocks 792-799 were
 * never painted: a range's last page is partial, so its start offset lies past the
 * furthest the view can scroll, and PageGeometry.localCount() dropped it as "not a page
 * you can turn to". go() had already been fixed to end that page at maxScroll so its tail
 * shows flush right -- but with the page absent from the count nothing ever asked for it,
 * the view stopped at the last whole boundary, and everything between there and the end of
 * the range went unshown. Once per 800-block range, silently, with nothing on screen to
 * say a paragraph had gone.
 *
 * So: walk forward and record which model blocks are actually painted on each spread. A
 * block may repeat across a boundary -- one paragraph can span two columns, and seeing it
 * twice is not a fault. A GAP is: if a spread ends at block 100 and the next starts at
 * 104, the reader was never shown 101-103.
 *
 * Run at more than one font size. The fault is NOT size-specific -- whenever the content
 * does not end exactly on a page boundary, which is nearly always, one page is dropped --
 * but the size sets the stride, and the stride sets how much text lands in the dropped
 * region. Measured on the pre-fix code over 200 spreads of this fixture: 16px lost 16
 * blocks across three range boundaries (7, 1 and 8), 18px lost 8 across one. The default
 * 16px was the WORSE case, so testing only the reported 18px would have understated it,
 * and testing only the default would have called a 1-block loss noise.
 *
 *   RUN_APP_E2E=1 node tests/page-coverage-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const SIZES = [16, 18];
const TURNS = 100;

/** Blocks painted inside the editor's visible box, right now. */
function visibleBlocksSrc() {
    const ed = document.getElementById('editor');
    const h = ed.getBoundingClientRect();
    const out = [];
    for (const b of ed.querySelectorAll('.block[data-model-index]')) {
        const mi = parseInt(b.getAttribute('data-model-index'), 10);
        if (!isFinite(mi)) continue;
        for (const r of b.getClientRects()) {
            if (r.width < 1 || r.height < 1) continue;
            if (r.right <= h.left + 1 || r.left >= h.right - 1) continue;
            if (r.bottom <= h.top + 1 || r.top >= h.bottom - 1) continue;
            out.push(mi);
            break;
        }
    }
    return out;
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 8000 });
try {
    await sleep(5000);
    await app.eval(() => handleCommand('view_set:mode:preview'));
    await sleep(1200);
    await app.eval(() => handleCommand('view_set:scroll:pagination'));
    await sleep(2200);

    for (const FS of SIZES) {
    for (const cols of [1, 2]) {
        console.log('\n=== ' + cols + ' column' + (cols > 1 ? 's' : '') + ' at ' + FS + 'px ===');
        await app.eval((fs) => document.documentElement.style.setProperty('--fs', fs + 'px'), FS);
        await sleep(1200);
        await app.eval((c) => handleCommand('view_set:columns:' + c), cols);
        await sleep(2600);
        await app.eval(() => PageMap.goto(0));
        await sleep(1400);

        const walk = await app.eval(async (turns, visSrc) => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const visible = new Function('return (' + visSrc + ')')();
            const spreads = [];
            for (let i = 0; i < turns; i++) {
                const v = visible();
                spreads.push(v.length
                    ? { page: PageMap.current(), min: Math.min(...v), max: Math.max(...v), n: v.length }
                    : { page: PageMap.current(), min: -1, max: -1, n: 0 });
                const moved = PageMap.step(1);
                await sleep(110);
                if (moved === false) break;
            }
            const gaps = [];
            for (let i = 1; i < spreads.length; i++) {
                const prev = spreads[i - 1], cur = spreads[i];
                if (prev.max < 0 || cur.min < 0) continue;
                if (cur.min > prev.max + 1) {
                    gaps.push({ fromPage: prev.page, toPage: cur.page,
                                lastShown: prev.max, nextShown: cur.min,
                                missing: cur.min - prev.max - 1 });
                }
            }
            return {
                spreads: spreads.length,
                empty: spreads.filter(s => s.n === 0).length,
                gaps,
                covered: spreads.length ? spreads[spreads.length - 1].max : -1,
                crossings: new Set(spreads.map(s => Math.floor(s.min / 800))).size
            };
        }, TURNS, visibleBlocksSrc.toString());

        info(walk.spreads + ' spreads walked, reaching block ' + walk.covered +
             ', across ' + walk.crossings + ' range(s); ' +
             walk.gaps.length + ' gap(s)' +
             (walk.gaps.length ? ' — ' + JSON.stringify(walk.gaps.slice(0, 4)) : ''));

        const L = cols + '-col @' + FS + 'px';
        assert(walk.spreads > 40,
            L + ': the walk actually paged through the document (' + walk.spreads + ')');
        assert(walk.crossings > 1,
            L + ': and crossed at least one range boundary, where the fault was (' +
            walk.crossings + ')');
        assert(walk.empty === 0,
            L + ': no spread is blank (' + walk.empty + ')');
        assert(walk.gaps.length === 0,
            L + ': turning a page never skips a block (' +
            (walk.gaps.length ? walk.gaps.reduce((s, g) => s + g.missing, 0) + ' skipped' : '0') + ')');
    }
    }
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PAGE COVERAGE FAILED' : 'PAGE COVERAGE PASSED');
process.exit(failed ? 1 : 0);
