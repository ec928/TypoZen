/**
 * Every match on screen is highlighted, and the current one is marked.
 *
 * This is what every other editor does and what ZenSeek did; TypoZen highlighted exactly
 * one hit. The cause was a regression from unifying the search surface: once every
 * document searched the model, the model path became the only path, and it built a range
 * for the current match alone.
 *
 * The active mark disappeared with it. applyWysiwygHighlights marks
 * ranges[findState.index], and findState.index counts matches across the whole document --
 * so match 7 of 2135 asked for element 7 of a one-element array and got undefined. Nothing
 * was marked current at all.
 *
 * Run through the shipped binary, because CSS.highlights is a paint-level API and the
 * assertions below are about what is actually on screen.
 *
 *   node tests/search-highlight-app.mjs
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
        await sleep(1500);
        return { matches: findState.matches.length };
    });
    info('matches: ' + found.matches);
    assert(found.matches > 2000, 'a wide result set (' + found.matches + ')');

    // How many matches are actually visible on screen right now, counted from the DOM
    // rather than from anything the highlighter believes.
    const state = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        window.findJumpTo(6);
        await sleep(900);
        const host = mainContainer.getBoundingClientRect();
        let onScreen = 0;
        editor.querySelectorAll('.block').forEach(b => {
            const r = b.getBoundingClientRect();
            if (r.bottom <= host.top || r.top >= host.bottom) return;
            const t = (b.innerText || '').toLowerCase();
            let i = t.indexOf('scroll');
            while (i >= 0) { onScreen++; i = t.indexOf('scroll', i + 6); }
        });
        const all = CSS.highlights.get('typozen-find');
        const cur = CSS.highlights.get('typozen-find-current');
        return {
            onScreen: onScreen,
            ranges: findState.ranges.length,
            highlighted: all ? all.size : 0,
            currentMarked: cur ? cur.size : 0,
            index: findState.index,
            currentRange: findState.currentRange,
            // The marked range must be the match the sidebar says is active.
            // The text the current mark actually sits on. This is the assertion that
            // matters: currentRange being "a number" proved nothing, and reading 0 while
            // the sidebar was on match 7 is precisely what shipped.
            currentText: (function () {
                const r = findState.ranges[findState.currentRange];
                if (!r || !r.startContainer || !r.startContainer.parentElement) return '(none)';
                const b = r.startContainer.parentElement.closest('.block');
                return b ? (b.innerText || '').slice(0, 40) : '(detached)';
            })(),
            sidebarActiveText: (function () {
                const el = document.querySelector('#search-results-list .search-item.active');
                return el ? (el.innerText || '').replace(/\s+/g, ' ').slice(0, 40) : '(none)';
            })()
        };
    });

    info('matches visible on screen: ' + state.onScreen +
        ', ranges built: ' + state.ranges + ', highlighted: ' + state.highlighted);
    assert(state.highlighted > 1,
        'more than one match is highlighted (' + state.highlighted + ')');
    assert(state.highlighted === state.ranges && state.ranges > 0,
        'every range built is handed to the highlighter');
    assert(state.onScreen > 1 && state.highlighted >= Math.min(state.onScreen, 2),
        'the matches visible on screen are highlighted (' + state.highlighted +
        ' for ' + state.onScreen + ' visible)');

    info('findState.index ' + state.index + ', currentRange ' + state.currentRange);
    assert(state.currentMarked === 1,
        'exactly one match is marked as current (' + state.currentMarked + ')');
    assert(state.currentRange >= 0 && state.currentRange < state.ranges,
        'the current mark is indexed within the mounted ranges, not by the global match ' +
        'number (' + state.currentRange + ' of ' + state.ranges + ')');

    info('current mark is on : ' + JSON.stringify(state.currentText));
    info('sidebar active row : ' + JSON.stringify(state.sidebarActiveText));
    assert(state.currentText !== '(none)' && state.currentText !== '(detached)',
        'the current mark points at a mounted block, not a node left behind by a remount');
    // The one that would have caught this: the mark must be on the line the sidebar says.
    const line = (state.sidebarActiveText.match(/Line (\d+) of/) || [])[1];
    assert(line && state.currentText.indexOf('Line ' + line + ' of') === 0,
        'the current mark is on the line the sidebar has selected (' +
        JSON.stringify(state.currentText) + ' vs sidebar line ' + line + ')');

    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.error('\nSEARCH HIGHLIGHT FAILED'); process.exitCode = 1; }
    else console.log('\nSEARCH HIGHLIGHT PASSED');
} finally {
    await app.close();
}
