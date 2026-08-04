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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildDoc(n) {
    let md = '';
    for (let i = 1; i <= n; i++) md += 'line ' + i + ' of the document, with enough words on it to wrap\n\n';
    return md;
}

/** Everything the smoke checks need to look at, in one round trip. */
function probe() {
    const ed = document.getElementById('editor');
    const cs = getComputedStyle(ed);
    return {
        classes: ed.className,
        columnCount: cs.columnCount,
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
        await sleep(500);
        let s = await page.evaluate(probe);
        assert(s.blocks > 0, 'document renders blocks (' + s.blocks + ')');
        assert(s.editorShown, 'the editor is visible');

        console.log('\n--- 2-column actually produces two columns ---');
        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await sleep(500);
        s = await page.evaluate(probe);
        assert(/two-col-layout/.test(s.classes), '2-Column applies the class');
        // The check that matters. The class alone proved nothing: this was 'auto' for the
        // entire time 2-column mode was shipped broken.
        eq(s.columnCount, '2', '2-Column computes column-count 2 in Preview');
        assert(s.scrollWidth > s.clientWidth,
            'columns overflow sideways, so there is a second column to page to (' +
            s.scrollWidth + ' > ' + s.clientWidth + ')');
        assert(s.pageAdvance, '2-Column also turns Pagination on');

        console.log('\n--- 1-column undoes it ---');
        await page.evaluate(() => handleCommand('view_set:columns:1'));
        await sleep(400);
        s = await page.evaluate(probe);
        assert(!/two-col-layout/.test(s.classes), '1-Column drops the class');
        assert(s.columnCount === 'auto' || s.columnCount === '1', '1-Column computes a single column');

        console.log('\n--- Reader mode ---');
        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await sleep(500);
        s = await page.evaluate(probe);
        eq(s.mode, 'reader', 'Reader mode engages');
        assert(/reader-mode/.test(s.classes), 'Reader applies the reader-mode class');
        assert(s.pageAdvance, 'Reader forces Pagination');

        console.log('\n--- 2-column works in Reader too ---');
        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await sleep(500);
        s = await page.evaluate(probe);
        eq(s.columnCount, '2', 'Reader + 2-Column computes column-count 2');

        console.log('\n--- Source mode ---');
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await sleep(500);
        s = await page.evaluate(probe);
        eq(s.mode, 'source', 'Source mode engages');
        assert(s.sourceShown, 'the raw textarea is visible in Source');
        assert(!/two-col-layout/.test(s.classes), 'Source drops back to one column');
        assert(!s.pageAdvance, 'Source drops back to scrolling');

        console.log('\n--- back to Preview ---');
        await page.evaluate(() => handleCommand('view_set:mode:preview'));
        await sleep(500);
        s = await page.evaluate(probe);
        eq(s.mode, 'wysiwyg', 'Preview mode engages');
        assert(s.editorShown && !s.sourceShown, 'the editor is showing and the textarea is not');
        assert(s.blocks > 0, 'the document is still rendered after the mode round trip');

        console.log('\n--- search finds and reports matches ---');
        await page.evaluate(() => handleCommand('toggle_search_sidebar'));
        await sleep(300);
        await page.evaluate(() => {
            const i = document.getElementById('sidebarSearchInput');
            i.value = 'line 7';
            runFind('line 7', false, { navigate: false });
            updateSidebarSearchCount();
        });
        await sleep(500);
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
            await sleep(400);
            await page.evaluate(() => { window.__vs = []; });

            // What the host sends when restoring a 2-column session.
            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await sleep(500);
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
            await sleep(400);
            assert((await page.evaluate(() => window.__vs.slice())).length > 0,
                'the raw set_column_mode command reports too');
            await page.evaluate(() => handleCommand('view_set:columns:2'));
            await sleep(400);
            await page.evaluate(() => { window.__vs = []; });

            // And the page really is in two columns, so toolbar and screen agree.
            s = await page.evaluate(probe);
            eq(s.columnCount, '2', 'the document really is two columns at that point');

            await page.evaluate(() => { window.__vs = []; });
            await page.evaluate(() => handleCommand('toggle_mode'));
            await sleep(500);
            vs = await page.evaluate(() => window.__vs.slice());
            assert(vs.length > 0, 'a mode change from Ctrl+/ or the menu reports view_state');

            await page.evaluate(() => { window.__vs = []; });
            await page.evaluate(() => handleCommand('view_sync'));
            await sleep(200);
            vs = await page.evaluate(() => window.__vs.slice());
            assert(vs.length === 1, 'view_sync reports the current state on demand');

            // Mid-transition states must not reach the shell.
            await page.evaluate(() => { window.__vs = []; });
            await page.evaluate(() => handleCommand('view_set:mode:reader'));
            await sleep(500);
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
            await sleep(400);
            await page.evaluate(() => { rememberStickyLine(60); restoreStickyDocumentLine(60); });
            await sleep(700);
            await page.evaluate(() => {
                const blocks = [...editor.querySelectorAll('.block')];
                const loc = modelLocationFromDocumentLine(60);
                const el = blocks.find(b => DocumentModel.modelIndexOfEl(b) === loc.blockIndex) || blocks[0];
                el.focus();
                const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
                const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                currentActiveBlock = el;
            });
            await sleep(300);
            const atEdit = await page.evaluate(() => getCaretLineNumber());
            await page.keyboard.type('UNDOANCHOR');
            await sleep(700);
            await page.evaluate(() => HistoryManager.undo());
            await sleep(900);
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
            await sleep(1800);
            await page.evaluate(() => {
                document.querySelector('.sidebar-tab[data-tab="outline"]').click();
                updateOutline();
            });
            await sleep(800);
            const headings = await page.evaluate(
                () => document.querySelectorAll('#outline-list .outline-item').length);
            assert(headings > 20, 'the fixture really has headings to list (' + headings + ')');

            for (const layout of ['scroll', 'pagination']) {
                await page.evaluate(() => handleCommand('view_set:mode:preview'));
                await sleep(400);
                await page.evaluate((s) => handleCommand('view_set:scroll:' + s), layout);
                await sleep(1500);
                // Start at the top so a jump is unambiguous.
                await page.evaluate(() => {
                    document.querySelector('.sidebar-tab[data-tab="outline"]').click();
                    const items = document.querySelectorAll('#outline-list .outline-item');
                    if (items.length) items[0].click();
                });
                await sleep(1200);
                const before = await topBlock();

                const clicked = await page.evaluate(() => {
                    const items = document.querySelectorAll('#outline-list .outline-item');
                    const i = Math.floor(items.length * 0.8);
                    if (!items[i]) return null;
                    items[i].click();
                    return items[i].innerText;
                });
                await sleep(1800);
                const after = await topBlock();
                assert(clicked !== null, layout + ': the outline lists headings to click');
                assert(after > before + 50,
                    layout + ': clicking a heading near the end scrolls there (block ' +
                    before + ' -> ' + after + ')');
            }
        }

        console.log('\n--- pasted HTML converts ---');
        const md = await page.evaluate(() => htmlToMarkdown(
            '<h2>Title</h2><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'));
        assert(/## Title/.test(md), 'a pasted heading converts');
        assert(/\| A \| B \|/.test(md), 'a pasted table keeps its header cells');
        assert(/\| 1 \| 2 \|/.test(md), 'a pasted table keeps its body cells');

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
