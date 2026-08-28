/**
 * Basic smoke tests: does each feature visibly DO anything?
 *
 * Everything here is deliberately shallow. No edge cases, no anchoring maths, no state
 * machine enumeration -- just "the user pressed the thing, did the thing happen". The
 * kind of check that is embarrassing to need and worse to be missing.
 *
 * It exists because 2-column mode shipped broken while the suite was green. The resolver
 * tests proved the *logic* was right (2 columns implies pagination, locks derive
 * correctly, no dead ends) and the class really was applied -- but css/typozen.css gated
 * the column rule on .reader-mode, so in Preview the computed column-count stayed 'auto'
 * and the page looked identical. Every jsdom test in the suite would have passed that
 * bug forever: jsdom has no layout engine, so it cannot tell "2 columns" from "no
 * columns". Only a real browser can, which is why this runs in Chrome.
 *
 * One browser launch, all checks against one page, so it stays a few seconds rather than
 * a few seconds per case.
 *
 *   node tests/smoke-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled, untilPage } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function eq(got, want, msg) {
    if (got === want) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        console.error('        want: ' + JSON.stringify(want));
        console.error('        got : ' + JSON.stringify(got));
    }
}

function buildDoc(n) {
    let md = '';
    for (let i = 1; i <= n; i++) md += 'line ' + i + ' of the document, with enough words on it to wrap\n\n';
    return md;
}

/** Everything the smoke checks need to look at, in one round trip. */
function probe() {
    const ed = document.getElementById('editor');
    const cs = getComputedStyle(ed);
    // How many columns are actually on screen, rather than what column-count says.
    //
    // These checks were written because 2-column shipped with its class applied and
    // column-count stuck at auto, so they asserted on the property. The property is now
    // auto by design -- the geometry is driven by a pixel column-width -- and asserting on
    // it would fail a working layout while still not proving anything is rendered. Count
    // the distinct column positions the browser actually produced.
    const paneW = ed.clientWidth;
    const lefts = new Set();
    for (const b of ed.querySelectorAll('.block')) {
        for (const r of b.getClientRects()) {
            if (r.width <= 0 || r.height <= 0) continue;
            const x = r.left - ed.getBoundingClientRect().left;
            if (x >= -2 && x < paneW - 2) lefts.add(Math.round(x));
        }
    }
    return {
        classes: ed.className,
        columnCount: cs.columnCount,
        renderedColumns: lefts.size,
        mode: state.mode,
        pageAdvance: !!state.pageAdvance,
        blocks: ed.querySelectorAll('.block').length,
        editorShown: getComputedStyle(ed).display !== 'none',
        sourceShown: getComputedStyle(document.getElementById('source-editor')).display !== 'none',
        scrollWidth: ed.scrollWidth,
        clientWidth: ed.clientWidth
    };
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 800 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(
            () => typeof handleCommand === 'function' && typeof loadMarkdownContent === 'function',
            { timeout: 15000 });

        console.log('--- it boots and renders ---');
        await page.evaluate((md) => loadMarkdownContent(md), buildDoc(200));
        await settled(page);
        let s = await page.evaluate(probe);
        assert(s.blocks > 0, 'document renders blocks (' + s.blocks + ')');
        assert(s.editorShown, 'the editor is visible');

        console.log('\n--- 2-column actually produces two columns ---');
        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await settled(page);
        s = await page.evaluate(probe);
        assert(/two-col-layout/.test(s.classes), '2-Column applies the class');
        // The check that matters. The class alone proved nothing: this was 'auto' for the
        // entire time 2-column mode was shipped broken.
        eq(s.renderedColumns, 2, '2-Column really renders two columns in Preview');
        assert(s.scrollWidth > s.clientWidth,
            'columns overflow sideways, so there is a second column to page to (' +
            s.scrollWidth + ' > ' + s.clientWidth + ')');
        assert(s.pageAdvance, '2-Column also turns Pagination on');

        console.log('\n--- 1-column undoes it ---');
        await page.evaluate(() => handleCommand('view_set:columns:1'));
        await settled(page);
        s = await page.evaluate(probe);
        assert(!/two-col-layout/.test(s.classes), '1-Column drops the class');
        eq(s.renderedColumns, 1, '1-Column really renders a single column');

        console.log('\n--- Reader mode ---');
        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await settled(page);
        s = await page.evaluate(probe);
        eq(s.mode, 'reader', 'Reader mode engages');
        assert(/reader-mode/.test(s.classes), 'Reader applies the reader-mode class');
        assert(s.pageAdvance, 'Reader forces Pagination');

        console.log('\n--- 2-column works in Reader too ---');
        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await settled(page);
        s = await page.evaluate(probe);
        eq(s.renderedColumns, 2, 'Reader + 2-Column really renders two columns');

        console.log('\n--- Source mode ---');
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await settled(page);
        s = await page.evaluate(probe);
        eq(s.mode, 'source', 'Source mode engages');
        assert(s.sourceShown, 'the raw textarea is visible in Source');
        assert(!/two-col-layout/.test(s.classes), 'Source drops back to one column');
        assert(!s.pageAdvance, 'Source drops back to scrolling');

        console.log('\n--- back to Preview ---');
        await page.evaluate(() => handleCommand('view_set:mode:preview'));
        await settled(page);
        s = await page.evaluate(probe);
        eq(s.mode, 'wysiwyg', 'Preview mode engages');
        assert(s.editorShown && !s.sourceShown, 'the editor is showing and the textarea is not');
        assert(s.blocks > 0, 'the document is still rendered after the mode round trip');

        console.log('\n--- search finds and reports matches ---');
        await page.evaluate(() => handleCommand('toggle_search_sidebar'));
        await settled(page);
        await page.evaluate(() => {
            const i = document.getElementById('sidebarSearchInput');
            i.value = 'line 7';
            runFind('line 7', false, { navigate: false });
            updateSidebarSearchCount();
        });
        await untilPage(page, () => findState.matches.length > 0);
        const search = await page.evaluate(() => ({
            matches: findState.matches.length,
            rows: document.querySelectorAll('#search-results-list .search-item').length,
            firstLine: (document.querySelector('#search-results-list .search-line') || {}).textContent,
            firstText: (document.querySelector('#search-results-list .search-text') || {}).textContent,
            counter: (document.getElementById('sidebarSearchCount') || {}).textContent,
            sidebarOpen: !document.getElementById('sidebar').classList.contains('collapsed')
        }));
        assert(search.sidebarOpen, 'Alt+S opens the sidebar');
        assert(search.matches > 0, 'search finds matches (' + search.matches + ')');
        assert(search.rows > 0, 'matches are rendered as rows (' + search.rows + ')');
        assert(/^\d+$/.test(String(search.firstLine || '')),
            'a row shows a line number (got ' + JSON.stringify(search.firstLine) + ')');
        assert(/line 7/.test(String(search.firstText || '')),
            'a row shows the matching text (got ' + JSON.stringify(search.firstText) + ')');
        assert(/^\d+\/\d+$/.test(String(search.counter || '')),
            'the counter reads n/total (got ' + JSON.stringify(search.counter) + ')');

        console.log('\n--- the toolbar is told about changes it did not cause ---');
        {
            // The shell paints the selectors purely from view_state:. Any path that
            // changes the view has to report, or the toolbar drifts out of step with the
            // document. That is how a restored 2-column session came up reading "1-Col"
            // and "Scroll" over a two-column page: the host restores columns by sending
            // set_column_mode directly, which used to report nothing at all.
            await page.evaluate(() => {
                window.__vs = [];
                const orig = postMsg;
                window.postMsg = postMsg = function (m) {
                    const s = String(m);
                    if (s.indexOf('view_state:') === 0) window.__vs.push(s);
                    return orig.apply(null, arguments);
                };
            });

            await page.evaluate(() => handleCommand('view_set:mode:preview'));
            await settled(page);
            await page.evaluate(() => { window.__vs = []; });

            // What the host sends when restoring a 2-column session.
            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await settled(page);
            let vs = await page.evaluate(() => window.__vs.slice());
            assert(vs.length > 0, 'a host-driven column change reports view_state');
            assert(vs.some(v => v.split(':')[1].split(',')[1] === '2'),
                'the reported state says 2 columns (got ' + JSON.stringify(vs) + ')');
            // Restoring columns must not leave a combination the rules forbid.
            assert(vs.every(v => {
                const p = v.split(':')[1].split(',');
                return !(p[1] === '2' && p[2] === 'scroll');
            }), 'restoring 2 columns also turns Pagination on (got ' + JSON.stringify(vs) + ')');

            // The raw low-level command still reports, as a safety net for any other path.
            await page.evaluate(() => { window.__vs = []; });
            await page.evaluate(() => handleCommand('set_column_mode:1'));
            await settled(page);
            assert((await page.evaluate(() => window.__vs.slice())).length > 0,
                'the raw set_column_mode command reports too');
            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await settled(page);
            await page.evaluate(() => { window.__vs = []; });

            // And the page really is in two columns, so toolbar and screen agree.
            s = await page.evaluate(probe);
            eq(s.renderedColumns, 2, 'the document really is two columns at that point');

            await page.evaluate(() => { window.__vs = []; });
            await page.evaluate(() => handleCommand('toggle_mode'));
            await settled(page);
            vs = await page.evaluate(() => window.__vs.slice());
            assert(vs.length > 0, 'a mode change from Ctrl+/ or the menu reports view_state');

            await page.evaluate(() => { window.__vs = []; });
            await page.evaluate(() => handleCommand('view_sync'));
            await settled(page);
            vs = await page.evaluate(() => window.__vs.slice());
            assert(vs.length === 1, 'view_sync reports the current state on demand');

            // Mid-transition states must not reach the shell.
            await page.evaluate(() => { window.__vs = []; });
            await page.evaluate(() => handleCommand('view_set:mode:reader'));
            await settled(page);
            vs = await page.evaluate(() => window.__vs.slice());
            eq(vs.length, 1, 'a selector click reports once, when the state is coherent');
            assert(/^view_state:reader,\d,pagination,/.test(vs[0]),
                'and reports Reader with Pagination already applied (got ' + vs[0] + ')');
        }

        console.log('\n--- undo leaves the cursor at the edit ---');
        {
            // The cursor is the natural anchor for an undo, and it was being thrown away:
            // undo() restored the previous state and used *that* state's caret, which for
            // the base state is wherever the file opened. Undoing an edit on line 128 sent
            // the cursor, and the view with it, to line 11.
            await page.evaluate(() => { handleCommand('view_set:mode:preview'); });
            await settled(page);
            await page.evaluate(() => { rememberStickyLine(60); restoreStickyDocumentLine(60); });
            await settled(page);
            await page.evaluate(() => {
                const blocks = [...editor.querySelectorAll('.block')];
                const loc = modelLocationFromDocumentLine(60);
                const el = blocks.find(b => DocumentModel.modelIndexOfEl(b) === loc.blockIndex) || blocks[0];
                el.focus();
                const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
                const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                currentActiveBlock = el;
            });
            await settled(page);
            const atEdit = await page.evaluate(() => getCaretLineNumber());
            await page.keyboard.type('UNDOANCHOR');
            await settled(page);
            await page.evaluate(() => HistoryManager.undo());
            await settled(page);
            const afterUndo = await page.evaluate(() => getCaretLineNumber());
            assert(atEdit > 1, 'the edit happened away from the top of the document (line ' + atEdit + ')');
            assert(Math.abs(afterUndo - atEdit) <= 2,
                'undo leaves the cursor at the edit, not at the top (line ' + afterUndo +
                ' vs ' + atEdit + ')');
        }

        console.log('\n--- clicking an outline heading goes there ---');
        {
            // The outline listed every heading and clicking one did nothing in Scroll mode:
            // it seeded scrollTop and then called mountVirtWindow, whose remount collapsed
            // the document height so the browser clamped the scroll straight back to 0. The
            // caret and status line moved, the view did not, and a bare catch hid it.
            const topBlock = () => page.evaluate(() => {
                const paged = isPaginatedLayout();
                const host = (paged ? editor : mainContainer).getBoundingClientRect();
                let best = null;
                editor.querySelectorAll('.block').forEach(b => {
                    const r = b.getBoundingClientRect();
                    if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) return;
                    if (r.right <= host.left + 1 || r.left >= host.right - 1) return;
                    const mi = DocumentModel.modelIndexOfEl(b);
                    if (mi >= 0 && (best === null || r.top < best.top)) best = { mi: mi, top: r.top };
                });
                return best ? best.mi : -1;
            });

            // buildDoc() has no headings, so the outline would hold only its
            // "No headings found..." placeholder -- which is itself an .outline-item, and
            // clicking it is a no-op that looks like a pass. Use a fixture with headings.
            const headed = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
            await page.evaluate((m) => loadMarkdownContent(m), headed);
            await settled(page);
            await page.evaluate(() => {
                document.querySelector('.sidebar-tab[data-tab="outline"]').click();
                updateOutline();
            });
            await settled(page);
            const headings = await page.evaluate(
                () => document.querySelectorAll('#outline-list .outline-item').length);
            assert(headings > 20, 'the fixture really has headings to list (' + headings + ')');

            for (const layout of ['scroll', 'pagination']) {
                await page.evaluate(() => handleCommand('view_set:mode:preview'));
                await settled(page);
                await page.evaluate((s) => handleCommand('view_set:scroll:' + s), layout);
                await settled(page);
                // Start at the top so a jump is unambiguous.
                await page.evaluate(() => {
                    document.querySelector('.sidebar-tab[data-tab="outline"]').click();
                    const items = document.querySelectorAll('#outline-list .outline-item');
                    if (items.length) items[0].click();
                });
                await settled(page);
                const before = await topBlock();

                const clicked = await page.evaluate(() => {
                    const items = document.querySelectorAll('#outline-list .outline-item');
                    const i = Math.floor(items.length * 0.8);
                    if (!items[i]) return null;
                    items[i].click();
                    return items[i].innerText;
                });
                await settled(page);
                const after = await topBlock();
                assert(clicked !== null, layout + ': the outline lists headings to click');
                assert(after > before + 50,
                    layout + ': clicking a heading near the end scrolls there (block ' +
                    before + ' -> ' + after + ')');
            }
        }

        console.log('\n--- jumping to a search result is not slow ---');
        {
            // A jump used to cost ~1.6s on this document. updateSearchSidebar resolved each
            // row's line number through a helper that rebuilt the whole char -> node index,
            // so rendering 150 rows rebuilt a 200k-entry structure 150 times, and
            // getFindHaystack was called twice per render on top. Both are per-render now.
            //
            // The bound is deliberately loose: this guards against rebuilding an index per
            // row, not against a few ms of drift on someone else's machine.
            await page.evaluate(() => handleCommand('view_set:mode:preview'));
            await settled(page);
            await page.evaluate(() => handleCommand('view_set:scroll:pagination'));
            await settled(page);
            await page.evaluate(() => {
                document.querySelector('.sidebar-tab[data-tab="search"]').click();
                const i = document.getElementById('sidebarSearchInput');
                i.value = 'scroll';
                runFind('scroll', false, { navigate: false });
                updateSidebarSearchCount();
            });
            await untilPage(page, () => findState.matches.length > 500);

            const perf = await page.evaluate(() => {
                const t0 = performance.now();
                updateSearchSidebar();
                const t1 = performance.now();
                return {
                    matches: findState.matches.length,
                    rows: document.querySelectorAll('#search-results-list .search-item').length,
                    renderMs: t1 - t0,
                    activeRows: document.querySelectorAll('#search-results-list .search-item.active').length
                };
            });
            console.log('  ..   matches ' + perf.matches + ', rows ' + perf.rows +
                 ', render ' + perf.renderMs.toFixed(0) + 'ms');
            assert(perf.matches > 500, 'the fixture gives enough matches to be a real test (' + perf.matches + ')');
            assert(perf.renderMs < 400,
                'rendering the results list stays well under a second (' + perf.renderMs.toFixed(0) + 'ms)');
            assert(perf.activeRows <= 1,
                'exactly one row is marked active, never two (' + perf.activeRows + ')');
        }

        console.log('\n--- search behaves the same in Scroll and Pages ---');
        {
            // getFindHaystack used to pick its surface from virtEnabled, and page mode turns
            // virtualization off -- so the same document searched the markdown while
            // scrolling and the mounted DOM while paginated. In the DOM a wrapped paragraph
            // is one long run, so several matches inside it all reported the same line and
            // their snippets came out as mid-word fragments. Two search engines, one app.
            const firstRows = () => page.evaluate(() =>
                [...document.querySelectorAll('#search-results-list .search-item')]
                    .slice(0, 5)
                    .map(r => {
                        const l = r.querySelector('.search-line'), t = r.querySelector('.search-text');
                        return (l ? l.textContent.trim() : '?') + '|' + (t ? t.textContent.slice(0, 30) : '');
                    }));
            const visible = () => page.evaluate(() => {
                const paged = isPaginatedLayout();
                const host = (paged ? editor : mainContainer).getBoundingClientRect();
                const vis = [];
                editor.querySelectorAll('.block').forEach(b => {
                    const r = b.getBoundingClientRect();
                    if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) return;
                    if (r.right <= host.left + 1 || r.left >= host.right - 1) return;
                    const mi = DocumentModel.modelIndexOfEl(b);
                    if (mi >= 0) vis.push(mi);
                });
                vis.sort((a, b) => a - b);
                return { first: vis[0], last: vis[vis.length - 1], kind: getFindHaystack().kind };
            });

            const seen = {};
            for (const layout of ['scroll', 'pagination']) {
                await page.evaluate(() => handleCommand('view_set:mode:preview'));
                await settled(page);
                await page.evaluate((s) => handleCommand('view_set:scroll:' + s), layout);
                await settled(page);
                await page.evaluate(() => {
                    document.querySelector('.sidebar-tab[data-tab="search"]').click();
                    const i = document.getElementById('sidebarSearchInput');
                    i.value = 'scroll';
                    runFind('scroll', false, { navigate: false });
                    updateSidebarSearchCount();
                });
                await untilPage(page, () => findState.matches.length > 0);
                seen[layout] = await firstRows();

                // Reset to the top so a jump is unambiguous, then click a result well in.
                await page.evaluate(() => { const r = document.querySelectorAll('#search-results-list .search-item'); r[0].click(); });
                await settled(page);
                await page.evaluate(() => { const r = document.querySelectorAll('#search-results-list .search-item'); r[90].click(); });
                await settled(page);
                const v = await visible();
                const target = await page.evaluate(() =>
                    markdownOffsetToBlock(findState.matches[findState.index].start).blockIndex);
                assert(v.kind === 'model', layout + ': searches the document model, not the mounted DOM');
                assert(target >= v.first && target <= v.last,
                    layout + ': the match is on screen after clicking it (block ' + target +
                    ' within ' + v.first + '..' + v.last + ')');
            }
            assert(JSON.stringify(seen.scroll) === JSON.stringify(seen.pagination),
                'the results list is identical in Scroll and Pages');
        }

        console.log('\n--- pasted HTML converts ---');
        const md = await page.evaluate(() => htmlToMarkdown(
            '<h2>Title</h2><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'));
        assert(/## Title/.test(md), 'a pasted heading converts');
        assert(/\| A \| B \|/.test(md), 'a pasted table keeps its header cells');
        assert(/\| 1 \| 2 \|/.test(md), 'a pasted table keeps its body cells');


        console.log('\n=== the ways a person actually triggers things ===');
        {
            // An audit of the suites found undo tested as HistoryManager.undo() and search
            // navigation as findJumpTo(n) -- the internals, not the paths a person takes.
            // That is the same gap that let copy/paste ship broken: the test called
            // insertPastedPlainText() directly and never went near the clipboard handlers.
            // Both of these turned out to work; they are pinned here so they stay that way,
            // because "the internal function works" has now twice been mistaken for "the
            // feature works".
            const undoByKey = await page.evaluate(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const el = editor.querySelector('.block[data-model-index="5"]');
                if (!el) return { ok: false };
                focusBlock(el, (el.innerText || '').length);
                await sleep(200);
                const before = getMarkdownContent(false);
                document.execCommand('insertText', false, 'QQQ');
                await sleep(600);
                const dirty = getMarkdownContent(false).indexOf('QQQ') >= 0;
                // The real keystroke, not HistoryManager.undo().
                window.dispatchEvent(new KeyboardEvent('keydown',
                    { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
                await sleep(1200);
                return { ok: true, dirty: dirty, restored: getMarkdownContent(false) === before };
            });
            assert(undoByKey.ok && undoByKey.dirty, 'the edit landed, so undo has something to do');
            assert(undoByKey.restored, 'Ctrl+Z as a keystroke undoes the edit');

            const clickJump = await page.evaluate(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                // Establish the layout rather than inheriting it. An earlier section leaves
                // the app in 2-column Pages, where the scroller is #editor horizontally --
                // so reading the topmost block of #main-container returns the same thing
                // however far the view has moved, and this reported a working click as
                // broken. Third time this class of mistake has cost real time.
                handleCommand('view_set:columns:1');
                await sleep(1200);
                handleCommand('view_set:scroll:scroll');
                await sleep(1800);
                const top = () => {
                    const h = mainContainer.getBoundingClientRect();
                    let t = '';
                    editor.querySelectorAll('.block').forEach(x => {
                        if (t) return;
                        const r = x.getBoundingClientRect();
                        if (r.bottom > h.top + 2 && r.top < h.bottom) t = (x.innerText || '').slice(0, 40);
                    });
                    return t;
                };
                // A string that certainly exists, a long way down: searching for something
                // absent would show "No results" and a click on that placeholder proves
                // nothing, which is exactly how this check first fooled me.
                const rows = DocumentModel.blocks.map(x => x.raw)
                    .filter(r => /scroll marker row \d+$/.test(r));
                if (rows.length < 901) return { ok: false };
                const q = rows[900].replace(/^Line \d+ of \d+ — /, '');
                handleCommand('toggle_search_sidebar');
                await sleep(500);
                const inp = document.getElementById('sidebarSearchInput');
                inp.value = q;
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                // Wait for the result, not for a guess at the debounce. A fixed 1600ms
                // here silently became too short when the sidebar debounce went to 2000,
                // and the click below then landed on an empty list.
                for (let w = 0; w < 100 && findState.matches.length === 0; w++) await sleep(100);
                const items = document.querySelectorAll('#search-results-list .search-item');
                const before = top();
                items[0].click();          // the mouse, not findJumpTo()
                await sleep(1500);
                return {
                    ok: true, query: q, matches: findState.matches.length,
                    before: before, after: top(),
                    marked: (CSS.highlights.get('typozen-find-current') || { size: 0 }).size,
                    // On screen, not necessarily at the top -- scrolling a match into view
                    // puts it comfortably inside the viewport, which is the right behaviour.
                    matchOnScreen: (function () {
                        const r = findState.ranges[findState.currentRange];
                        if (!r) return false;
                        const rect = r.getBoundingClientRect();
                        const h = mainContainer.getBoundingClientRect();
                        return rect.bottom > h.top && rect.top < h.bottom;
                    })()
                };
            });
            assert(clickJump.ok && clickJump.matches === 1,
                'the fixture contains the searched string exactly once (' +
                (clickJump.matches === undefined ? 'n/a' : clickJump.matches) + ')');
            console.log('  ..   clicked a result: ' + JSON.stringify(clickJump.before) +
                ' -> ' + JSON.stringify(clickJump.after));
            assert(clickJump.after !== clickJump.before,
                'clicking a search result with the mouse moves the view');
            assert(clickJump.matchOnScreen,
                'and the match itself is on screen afterwards, not merely somewhere new');
            assert(clickJump.marked === 1, 'the clicked match is the one marked current');
        }

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) {
            console.error('\nSMOKE FAILED');
            process.exitCode = 1;
            return;
        }
        console.log('\nSMOKE PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
