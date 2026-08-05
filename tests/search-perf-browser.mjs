/**
 * Searching a large document must stay interactive.
 *
 * "scroll" matches 2135 times in the 4582-line fixture. Stepping to a late match raises
 * the sidebar's render window to cover it, and each render numbered every row with
 * markdownOffsetToBlock() then modelBlockStartLine() -- both O(blocks). At the last match of a
 * 3769-block document that is roughly 26 million iterations, each allocating a string or
 * calling linesInBlockRaw, and it ran again on every , or . keypress. The application was
 * reported as hanging; it was arithmetic.
 *
 * Two properties:
 *   - a full render of a late, wide result set completes quickly (one walk, not one per row)
 *   - stepping does not re-render at all; it moves the active row
 *
 * The second is what makes stepping feel instant, and it is asserted structurally (the
 * existing nodes must survive) rather than only by timing, so it cannot pass by luck on a
 * fast machine.
 *
 *   node tests/search-perf-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
        await page.evaluate(m => loadMarkdownContent(m),
            fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8'));
        await sleep(2500);
        await page.evaluate(() => handleCommand('toggle_search_sidebar'));
        await sleep(600);

        const r = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const input = document.getElementById('sidebarSearchInput');
            input.value = 'scroll';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(1500);

            const list = document.getElementById('search-results-list');
            const n = findState.matches.length;

            // Jump to a late match, as , and . eventually do. This is the render that hung.
            findState.index = n - 1;
            let t = performance.now();
            updateSearchSidebar();
            const full = performance.now() - t;
            const rows = list.children.length;

            // A rebuild replaces every node, so a marked node disappearing proves one
            // happened -- and surviving proves one did not.
            list.children[0].setAttribute('data-witness', '1');
            const times = [];
            for (let k = 0; k < 5; k++) {
                findState.index--;
                t = performance.now();
                updateSearchSidebar();
                times.push(performance.now() - t);
                await sleep(10);
            }
            return {
                matches: n,
                rows: rows,
                full: Math.round(full),
                worstStep: Math.round(Math.max.apply(null, times)),
                rebuilt: !document.querySelector('#search-results-list [data-witness]'),
                activeCount: list.querySelectorAll('.search-item.active').length,
                activeIsCurrent: list.querySelector('.search-item.active') === list.children[findState.index]
            };
        });

        info('matches ' + r.matches + ', rows painted ' + r.rows);
        assert(r.matches > 2000, 'the fixture produces a wide result set (' + r.matches + ')');

        console.log('\n=== rendering a late, wide result set ===');
        info('full render of ' + r.rows + ' rows: ' + r.full + 'ms');
        assert(r.full < 600, 'a full render at the last match takes under 600ms (' + r.full + 'ms)');

        console.log('\n=== stepping moves the highlight instead of rebuilding ===');
        info('worst step ' + r.worstStep + 'ms, list rebuilt: ' + r.rebuilt);
        assert(!r.rebuilt, 'stepping did not rebuild the list');
        assert(r.worstStep < 50, 'each step costs under 50ms (' + r.worstStep + 'ms)');
        assert(r.activeCount === 1, 'exactly one row is highlighted (' + r.activeCount + ')');
        assert(r.activeIsCurrent, 'the highlighted row is the current match');

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) { console.error('\nSEARCH PERF FAILED'); process.exitCode = 1; return; }
        console.log('\nSEARCH PERF PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
