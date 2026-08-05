/**
 * Open a real book in the shipped application.
 *
 * Everything before this checked the model and the page in isolation. This is the whole
 * route: File open -> EpubReader unzips and reads the spine -> the payload is staged and
 * fetched -> the page splits it into blocks and applies the book's own stylesheets.
 *
 * The book is opened by launching TypoZen.exe with it, which is what a reader does.
 *
 *   node tests/epub-open-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const books = fs.readdirSync(path.join(appDir, 'tests'))
    .filter(f => f.toLowerCase().endsWith('.epub')).sort();
if (!books.length) {
    console.log('  --   no .epub in tests/, nothing to verify.');
    console.log('passed=0 failed=0');
    console.log('EPUB OPEN SKIPPED');
    process.exit(0);
}

// A mid-sized novel for the detail, and the omnibus for scale.
const primary = books.find(b => /matter/i.test(b)) || books[0];
const biggest = books
    .map(b => ({ b, size: fs.statSync(path.join(appDir, 'tests', b)).size }))
    .sort((x, y) => y.size - x.size)[0].b;

async function openAndCheck(app, book, deep) {
    console.log('\n########## ' + book + ' ##########');
    // The same message the shell sends when a file is opened from Explorer or the menu.
    await app.eval((p) => postMsg('open_file_path:' + p), path.join(appDir, 'tests', book));
    await sleep(1500);
    await settledApp(app, 30000);

    const st = await app.eval(() => ({
        kind: DocumentModel.kind,
        blocks: DocumentModel.blocks.length,
        toc: DocumentModel.toc.length,
        mounted: editor.querySelectorAll('.block').length,
        editable: editor.getAttribute('contenteditable'),
        styles: (document.getElementById('book-styles') || { textContent: '' }).textContent.length,
        text: getMarkdownContent(false).length,
        outline: document.querySelectorAll('#outline-list .outline-item').length,
        firstText: (editor.querySelector('.block') || { innerText: '' }).innerText.slice(0, 60),
        imgs: editor.querySelectorAll('img').length,
        inline: editor.querySelectorAll('i, em, b, strong, span').length
    }));

    info(st.blocks + ' blocks, ' + st.toc + ' TOC, ' + st.mounted + ' mounted, ' +
        st.styles + ' chars of book CSS, ' + st.text + ' chars of text');
    info('first block: ' + JSON.stringify(st.firstText));

    assert(st.kind === 'epub', book + ': opened as a book, not as text');
    assert(st.blocks > 1000, book + ': the whole book is in the model (' + st.blocks + ')');
    assert(st.editable === 'false', book + ': read-only');
    assert(st.text > 100000, book + ': searchable text (' + st.text + ' chars)');
    assert(st.outline === st.toc && st.toc > 1,
        book + ': the outline is the book’s own TOC (' + st.outline + ')');
    // A book is never laid out whole. Either virtualisation or page windowing must be
    // holding it, and which one depends only on the layout it happens to open into.
    assert(st.mounted < st.blocks / 2,
        book + ': only part of the book is laid out (' + st.mounted + ' of ' +
        st.blocks + ')');

    if (deep) {
        assert(st.styles > 0, 'the book’s own stylesheets were applied');
        assert(st.inline > 0,
            'inline markup is rendered, not flattened (' + st.inline + ' elements on screen)');

        // The reader features are supposed to work unchanged. That is the whole claim.
        const search = await app.eval(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            handleCommand('toggle_search_sidebar');
            await sleep(500);
            const inp = document.getElementById('sidebarSearchInput');
            inp.value = 'the';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(2000);
            const rows = document.querySelectorAll('#search-results-list .search-item');
            const before = (editor.querySelector('.block') || {}).innerText || '';
            if (rows.length) rows[Math.min(20, rows.length - 1)].click();
            await sleep(1500);
            return {
                matches: findState.matches.length,
                rows: rows.length,
                moved: ((editor.querySelector('.block') || {}).innerText || '') !== before,
                marked: (CSS.highlights.get('typozen-find-current') || { size: 0 }).size,
                hayHasTags: /<\/?(p|div|span)\b/i.test(getFindHaystack().haystack)
            };
        });
        info('search "the": ' + search.matches + ' matches, ' + search.rows + ' rows');
        assert(search.matches > 1000, 'search finds matches across the book');
        assert(!search.hayHasTags, 'and searches its text, not its markup');
        assert(search.marked === 1, 'clicking a result marks exactly one match');

        const paged = await app.eval(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            handleCommand('view_set:columns:2');
            await sleep(2500);
            handleCommand('view_set:scroll:pagination');
            await sleep(3000);
            const before = PageMap.current();
            PageMap.step(1);
            await sleep(800);
            return {
                paginated: isPaginatedLayout(),
                pages: PageMap.count(),
                turned: PageMap.current() !== before,
                windowed: PageChunks.mounted >= 0,
                mounted: editor.querySelectorAll('.block').length
            };
        });
        info('paginated: ' + paged.pages + ' pages, windowed ' + paged.windowed +
            ', ' + paged.mounted + ' blocks mounted');
        assert(paged.paginated, 'a book paginates');
        assert(paged.pages > 10, 'into a real number of pages (' + paged.pages + ')');
        assert(paged.turned, 'and a page turn turns a page');
        assert(paged.windowed && paged.mounted < st.blocks,
            'with windowing engaged, so a novel is not laid out whole (' +
            paged.mounted + ' of ' + st.blocks + ')');

        console.log('\n--- images, links and navigation ---');
        {
            // Every one of these was reported from real use after the loader landed.
            const nav = await app.eval(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                handleCommand('view_set:columns:1');
                await sleep(1200);
                handleCommand('view_set:scroll:scroll');
                await sleep(1800);

                // Images: a src must resolve to the extracted assets, not to a relative
                // path that means nothing from the application's own URL.
                const imgRaws = DocumentModel.blocks.filter(b => /<img/i.test(b.raw)).slice(0, 3);
                const probe = document.createElement('div');
                probe.className = 'block';
                document.getElementById('editor').appendChild(probe);
                let absolute = 0, relative = 0;
                for (const b of imgRaws) {
                    renderBlockPreview(probe, b.raw);
                    probe.querySelectorAll('img').forEach(im => {
                        const s = im.getAttribute('src') || '';
                        if (/^https?:/i.test(s)) absolute++; else relative++;
                    });
                }
                probe.remove();

                // Outline: clicking an entry has to move the reader.
                const before = topLeftModelIndexTwoCol() >= 0
                    ? topLeftModelIndexTwoCol() : firstVisibleIdx();
                const items = document.querySelectorAll('#outline-list .outline-item');
                let outlineMoved = false, outlineTarget = -1;
                if (items.length > 6) {
                    items[6].click();
                    await sleep(1500);
                    outlineTarget = _readingAnchor;
                    outlineMoved = firstVisibleIdx() !== before;
                }

                // Internal links, but only ones whose target actually exists.
                //
                // Matter's in-text links all point at #filepos anchors from the original
                // MOBI, while the anchors Calibre wrote are calibre_pb_*. Those links are
                // dangling in the file itself and no reader could follow them, so asserting
                // on the first link found would be testing the book rather than the reader.
                const anchors = buildBookAnchorIndex();
                let linkBlock = -1, linkHref = null;
                for (let i = 0; i < DocumentModel.blocks.length && linkBlock < 0; i++) {
                    const hs = (DocumentModel.blocks[i].raw || '').match(/href\s*=\s*"([^"]+)"/g);
                    if (!hs) continue;
                    for (const h of hs) {
                        const href = h.slice(6, -1);
                        if (/^https?:/i.test(href)) continue;
                        const frag = href.indexOf('#') >= 0 ? href.slice(href.indexOf('#') + 1) : '';
                        const file = bookNormalizeHref(href);
                        if ((frag && anchors[frag] !== undefined)
                            || (file && _bookDocIndex[file] !== undefined)) {
                            linkBlock = i; linkHref = href; break;
                        }
                    }
                }
                let linkTarget = -1, linkMoved = false;
                if (linkBlock >= 0) {
                    goToModelBlock(linkBlock);
                    await sleep(1200);
                    const was = firstVisibleIdx();
                    bookGoToHref(linkHref);
                    await sleep(1500);
                    linkTarget = firstVisibleIdx();
                    linkMoved = linkTarget !== was;
                }

                function firstVisibleIdx() {
                    const host = mainContainer.getBoundingClientRect();
                    let idx = -1;
                    document.getElementById('editor').querySelectorAll('.block').forEach(b => {
                        if (idx >= 0) return;
                        const r = b.getBoundingClientRect();
                        if (r.bottom > host.top + 2 && r.top < host.bottom) {
                            idx = DocumentModel.modelIndexOfEl(b);
                        }
                    });
                    return idx;
                }

                return {
                    absolute, relative,
                    outlineMoved, outlineTarget,
                    hasLinks: linkBlock >= 0, linkHref: linkHref,
                    linkMoved, linkTarget,
                    dirty: (function () { updateStatsNow(); return null; })()
                };
            });

            info('image srcs: ' + nav.absolute + ' resolved, ' + nav.relative + ' left relative');
            assert(nav.relative === 0 && nav.absolute > 0,
                'every image src resolves to the extracted assets (' + nav.absolute + ')');

            info('outline click -> block ' + nav.outlineTarget);
            assert(nav.outlineMoved, 'clicking an outline entry moves the reader');

            if (nav.hasLinks) {
                info('internal link ' + JSON.stringify(nav.linkHref) + ' -> block ' + nav.linkTarget);
                assert(nav.linkMoved, 'following a link inside the book jumps within it');
            } else {
                info('this book has no resolvable internal links -- its own anchors are ' +
                     'dangling in the file, so there is nothing a reader could follow');
            }
        }

        console.log('\n--- a book is never dirty, and opens in Reader ---');
        {
            const s2 = await app.eval(() => ({
                mode: state.mode,
                editable: editor.getAttribute('contenteditable'),
                readerClass: editor.classList.contains('reader-mode')
            }));
            info('mode ' + s2.mode + ', editable ' + s2.editable);
            assert(s2.mode === 'reader', 'a book opens in Reader, not Preview');
            assert(s2.editable === 'false' && s2.readerClass, 'and stays read-only');
        }

        console.log('\n--- chapters start pages, and page numbers agree ---');
        {
            const pg = await app.eval(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                handleCommand('view_set:columns:2');
                await sleep(2500);
                handleCommand('view_set:scroll:pagination');
                await sleep(3000);
                updatePageIndicator();
                const nums = Array.prototype.map.call(
                    document.querySelectorAll('#page-indicator .page-num'), x => x.innerText);
                return {
                    chapterStarts: document.querySelectorAll('#editor .block[data-chapter-start]').length,
                    nums: nums,
                    total: PageMap.count(),
                    current: PageMap.current()
                };
            });
            info('page numbers on screen: ' + JSON.stringify(pg.nums) +
                ', page ' + pg.current + ' of ' + pg.total);
            assert(pg.chapterStarts > 0,
                'chapter starts are marked so they can begin a page (' + pg.chapterStarts + ')');
            const asInts = pg.nums.map(n => parseInt(n, 10)).filter(n => !isNaN(n));
            assert(asInts.length === 2 && asInts[1] === asInts[0] + 1,
                'the two page numbers of a spread are consecutive (' + JSON.stringify(pg.nums) + ')');
            assert(asInts[0] <= pg.total * 2,
                'and within the document, not a page number from another coordinate system');
        }

    }
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3000);
    await openAndCheck(app, primary, true);
    if (biggest !== primary) await openAndCheck(app, biggest, false);

    console.log('\n=== the book on disk is untouched ===');
    const target = biggest !== primary ? biggest : primary;
    const before = fs.statSync(path.join(appDir, 'tests', target));
    await app.eval(() => { try { postMsg('save_file'); } catch (e) {} });
    await sleep(1500);
    const after = fs.statSync(path.join(appDir, 'tests', target));
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs,
        'asking to save left the .epub byte-identical and untouched');

    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.error('\nEPUB OPEN FAILED'); process.exitCode = 1; }
    else console.log('\nEPUB OPEN PASSED');
} finally {
    await app.close();
}
