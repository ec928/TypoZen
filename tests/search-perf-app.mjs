/**
 * Searching a large document must stay interactive.
 *
 * A search for "scroll" on the 4582-line fixture matches 2135 times. Stepping to a late
 * match raised the sidebar's render window to cover it, and each render numbered every
 * row with markdownOffsetToBlock() + modelBlockStartLine(), both O(blocks). At match 4581
 * of a 3769-block document that is ~26 million iterations per keypress -- indistinguishable
 * from a hang, and it ran again on every step.
 *
 * Two properties, both measured through the shipped binary:
 *   - a full render of a late, wide result set completes quickly
 *   - stepping does not re-render at all; it moves the active row
 *
 *   node tests/search-perf-app.mjs
 */
import { launchApp } from './app-harness.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(2500);
    await app.eval(() => handleCommand('view_set:columns:1'));
    await sleep(900);
    await app.eval(() => handleCommand('view_set:scroll:scroll'));
    await sleep(1500);
    await app.eval(() => handleCommand('toggle_search_sidebar'));
    await sleep(600);

    const found = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const input = document.getElementById('sidebarSearchInput');
        input.value = 'scroll';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1200);
        return { matches: findState.matches.length, rows: document.getElementById('search-results-list').children.length };
    });
    info('matches: ' + found.matches + ', rows painted: ' + found.rows);
    assert(found.matches > 2000, 'the fixture produces a wide result set (' + found.matches + ')');

    console.log('\n=== a full render of a late result set is fast ===');
    const wide = await app.eval(async (target) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        findState.index = target;
        const t0 = performance.now();
        updateSearchSidebar();
        const ms = performance.now() - t0;
        await sleep(50);
        return { ms: Math.round(ms), rows: document.getElementById('search-results-list').children.length };
    }, Math.min(4581, found.matches - 1));
    info('render of ' + wide.rows + ' rows: ' + wide.ms + 'ms');
    assert(wide.ms < 600, 'rendering the full window at a late match takes under 600ms (' + wide.ms + 'ms)');

    console.log('\n=== stepping moves the highlight without re-rendering ===');
    const step = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const list = document.getElementById('search-results-list');
        const before = list.children[findState.index];
        const stamp = Symbol ? null : null;
        // Mark a row so a rebuild is detectable: innerHTML replaces the nodes.
        const witness = list.children[0];
        witness.setAttribute('data-witness', '1');
        const times = [];
        for (let i = 0; i < 5; i++) {
            findState.index = findState.index - 1;
            const t0 = performance.now();
            updateSearchSidebar();
            times.push(performance.now() - t0);
            await sleep(20);
        }
        const stillThere = !!document.querySelector('#search-results-list [data-witness]');
        const active = list.querySelector('.search-item.active');
        return {
            worst: Math.round(Math.max.apply(null, times)),
            rebuilt: !stillThere,
            activeIsCorrect: active === list.children[findState.index],
            activeCount: list.querySelectorAll('.search-item.active').length
        };
    });
    info('worst step: ' + step.worst + 'ms, list rebuilt: ' + step.rebuilt);
    assert(!step.rebuilt, 'stepping did not rebuild the list');
    assert(step.worst < 50, 'each step costs under 50ms (' + step.worst + 'ms)');
    assert(step.activeCount === 1,
        'exactly one row is highlighted (' + step.activeCount + ')');
    assert(step.activeIsCorrect, 'the highlighted row is the current match');

    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.error('\nSEARCH PERF FAILED'); process.exitCode = 1; }
    else console.log('\nSEARCH PERF PASSED');
} finally {
    await app.close();
}
