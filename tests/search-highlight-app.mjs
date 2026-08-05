/**
 * Every match on screen is highlighted, and the current one is marked -- in EVERY layout.
 *
 * The layout loop is the whole point. The first version of this test set 1-column + Scroll
 * and reported 8/8 green while the bug being fixed was fully present in 2-column Pages,
 * which is the layout every screenshot of it was taken in. A test that picks the easy mode
 * is worse than no test: it certifies the bug as fixed.
 *
 * What kept breaking was never the range building; it was the repaint being guarded out of
 * existence for whichever case was being reported. First on the Ctrl+F bar being open (the
 * sidebar is a different surface driving the same findState), then on virtualisation being
 * enabled (pagination turns it off), and in paginated views the reveal never called the
 * highlighter at all -- it flashed a .focused class for 1200ms and left the orange mark
 * wherever it had last been set, at the top of the document.
 *
 * Ranges are over live DOM nodes, so anything replacing those nodes invalidates all of
 * them. There is no layout where that is untrue, so there is no layout this may skip.
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

const LAYOUTS = [
    { name: '1-column, Scroll',     cols: 1, scroll: 'scroll' },
    { name: '1-column, Pages',      cols: 1, scroll: 'pagination' },
    { name: '2-column, Pages',      cols: 2, scroll: 'pagination' }
];

/** Read what is actually on screen and what the highlighter actually holds. */
function probe() {
    const paginated = (typeof isPaginatedLayout === 'function') && isPaginatedLayout();
    const host = paginated
        ? editor.getBoundingClientRect()
        : mainContainer.getBoundingClientRect();

    let onScreen = 0;
    editor.querySelectorAll('.block').forEach(b => {
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.bottom <= host.top || r.top >= host.bottom) return;
        if (r.right <= host.left || r.left >= host.right) return;
        const t = (b.innerText || '').toLowerCase();
        let i = t.indexOf('scroll');
        while (i >= 0) { onScreen++; i = t.indexOf('scroll', i + 6); }
    });

    const all = CSS.highlights.get('typozen-find');
    const cur = CSS.highlights.get('typozen-find-current');
    const blockOf = (r) => {
        if (!r || !r.startContainer || !r.startContainer.parentElement) return '(none)';
        const b = r.startContainer.parentElement.closest('.block');
        return b ? (b.innerText || '').slice(0, 40) : '(detached)';
    };
    return {
        paginated: paginated,
        onScreen: onScreen,
        ranges: findState.ranges.length,
        highlighted: all ? all.size : 0,
        currentMarked: cur ? cur.size : 0,
        index: findState.index,
        currentRange: findState.currentRange,
        currentText: blockOf(findState.ranges[findState.currentRange]),
        // Stray block shading. Every search reveal used to add .focused and never remove
        // it from the block before, so each jump left another permanently lit row behind.
        focusedBlocks: (function () {
            const lit = editor.querySelectorAll('.block.focused');
            return Array.prototype.map.call(lit, b => (b.innerText || '').slice(0, 30));
        })(),
        sidebarActiveText: (function () {
            const el = document.querySelector('#search-results-list .search-item.active');
            return el ? (el.innerText || '').replace(/\s+/g, ' ').slice(0, 40) : '(none)';
        })()
    };
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(2500);
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

    for (const layout of LAYOUTS) {
        console.log('\n########## ' + layout.name + ' ##########');
        await app.eval((c) => handleCommand('view_set:columns:' + c), layout.cols);
        await sleep(1800);
        await app.eval((m) => handleCommand('view_set:scroll:' + m), layout.scroll);
        await sleep(2800);

        // Jump to a match well inside the document, the way clicking a result does.
        await app.eval(() => { window.findJumpTo(7); });
        await sleep(1500);

        const s = await app.eval(probe);
        info('paginated: ' + s.paginated + ', matches visible: ' + s.onScreen +
            ', ranges: ' + s.ranges + ', highlighted: ' + s.highlighted);
        info('index ' + s.index + ' -> currentRange ' + s.currentRange);
        info('current mark on : ' + JSON.stringify(s.currentText));
        info('sidebar active  : ' + JSON.stringify(s.sidebarActiveText));

        const L = layout.name;
        assert(s.paginated === (layout.scroll === 'pagination'),
            L + ': the app really is in the layout under test');
        assert(s.highlighted > 1,
            L + ': more than one match is highlighted (' + s.highlighted + ')');
        assert(s.highlighted === s.ranges && s.ranges > 0,
            L + ': every range built is handed to the highlighter');
        assert(s.onScreen > 1,
            L + ': there are several matches on screen to highlight (' + s.onScreen + ')');
        assert(s.currentMarked === 1,
            L + ': exactly one match is marked as current (' + s.currentMarked + ')');
        assert(s.currentRange >= 0 && s.currentRange < s.ranges,
            L + ': the current mark is indexed within the mounted ranges, not by the ' +
            'global match number (' + s.currentRange + ' of ' + s.ranges + ')');
        assert(s.currentText !== '(none)' && s.currentText !== '(detached)',
            L + ': the current mark points at a mounted block, not a node a remount left ' +
            'behind (' + s.currentText + ')');

        // The assertion that matters, and the one that was missing every time this was
        // reported fixed: the mark must be on the line the sidebar row names.
        const line = (s.sidebarActiveText.match(/Line (\d+) of/) || [])[1];
        assert(line && s.currentText.indexOf('Line ' + line + ' of') === 0,
            L + ': the current mark is on the line the sidebar has selected (' +
            JSON.stringify(s.currentText) + ' vs sidebar line ' + line + ')');

        info(L + ' blocks shaded  : ' + JSON.stringify(s.focusedBlocks));
        assert(s.focusedBlocks.length <= 1,
            L + ': at most one block is shaded, not one left behind per jump (' +
            s.focusedBlocks.length + ': ' + JSON.stringify(s.focusedBlocks) + ')');
        // Counting them was never the complaint. The report was "line 3 line highlight for
        // no reason": one block shaded, and the wrong one. So the shaded block has to be
        // the block the current match is in.
        assert(s.focusedBlocks.length === 0 ||
               s.currentText.indexOf(s.focusedBlocks[0].slice(0, 24)) === 0,
            L + ': the shaded block is the one holding the current match (shaded ' +
            JSON.stringify(s.focusedBlocks[0]) + ' vs match in ' +
            JSON.stringify(s.currentText) + ')');

        // Stepping must move it, and keep it on the sidebar's row.
        await app.eval(() => { window.findJumpTo(8); });
        await sleep(1200);
        const t = await app.eval(probe);
        const line2 = (t.sidebarActiveText.match(/Line (\d+) of/) || [])[1];
        info('after stepping  : ' + JSON.stringify(t.currentText) +
            ' (sidebar line ' + line2 + ')');
        assert(t.currentText !== s.currentText,
            L + ': stepping moves the current mark (' + JSON.stringify(t.currentText) + ')');
        assert(line2 && t.currentText.indexOf('Line ' + line2 + ' of') === 0,
            L + ': after stepping the mark is still on the sidebar’s line');
    }

    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.error('\nSEARCH HIGHLIGHT FAILED'); process.exitCode = 1; }
    else console.log('\nSEARCH HIGHLIGHT PASSED');
} finally {
    await app.close();
}
