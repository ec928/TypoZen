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

                // Images: not "the src was rewritten" -- that assertion passed for weeks
                // while Xeelee showed a broken-image placeholder on every page. Go to the
                // blocks that carry images, let them mount, and ask the browser whether the
                // bytes arrived. A rewritten src that 404s is the bug, not the fix.
                let absolute = 0, relative = 0, loaded = 0, broken = 0;
                const brokenSrcs = [];
                let coverRatio = null, coverBoxRatio = null;
                const carriers = [], found = [], missed = [];
                for (let i = 0; i < DocumentModel.blocks.length && carriers.length < 3; i++) {
                    if (/<(img|image)[\s>]/i.test(DocumentModel.blocks[i].raw)) carriers.push(i);
                }
                for (const bi of carriers) {
                    goToModelBlock(bi);
                    await sleep(1600);
                    const el = document.querySelector('#editor .block[data-model-index="' + bi + '"]');
                    if (!el) { missed.push(bi); continue; }
                    found.push(bi);

                    for (const im of el.querySelectorAll('img')) {
                        const src = im.getAttribute('src') || '';
                        if (/^https?:/i.test(src)) absolute++; else relative++;
                        if (im.complete && im.naturalWidth > 0) loaded++;
                        else { broken++; if (brokenSrcs.length < 3) brokenSrcs.push(src); }
                    }

                    // An SVG-wrapped cover is not an <img>: the browser reports nothing
                    // about it, so fetch the href and check the ratio it actually renders at.
                    for (const im of el.querySelectorAll('image')) {
                        const XLINK = 'http://www.w3.org/1999/xlink';
                        const href = im.getAttributeNS(XLINK, 'href') || im.getAttribute('href') || '';
                        if (/^https?:/i.test(href)) absolute++; else relative++;
                        let ok = false;
                        try { const r = await fetch(href, { method: 'GET' }); ok = r.ok; } catch (e) { ok = false; }
                        if (ok) loaded++; else { broken++; if (brokenSrcs.length < 3) brokenSrcs.push(href); }

                        const svg = im.closest('svg');
                        const vb = svg && svg.getAttribute('viewBox');
                        if (vb && coverRatio === null) {
                            const p4 = vb.trim().split(/[\s,]+/).map(Number);
                            const r = svg.getBoundingClientRect();
                            if (p4.length === 4 && p4[3] && r.height) {
                                coverRatio = p4[2] / p4[3];
                                coverBoxRatio = r.width / r.height;
                            }
                        }
                    }
                }

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
                        // And whose target is somewhere else: a contents page links to the
                        // section it sits in, so "did the view move" is not a fair question
                        // of a link that legitimately points at the block already on screen.
                        const t = (frag && anchors[frag] !== undefined) ? anchors[frag]
                            : ((file && _bookDocIndex[file] !== undefined) ? _bookDocIndex[file] : -1);
                        if (t >= 0 && Math.abs(t - i) > 20) {
                            linkBlock = i; linkHref = href; break;
                        }
                    }
                }
                let linkTarget = -1, linkMoved = false;
                if (linkBlock >= 0) {
                    goToModelBlock(linkBlock);
                    await sleep(1200);
                    // _readingAnchor, not firstVisibleIdx(): windowing mounts a chunk at a
                    // time, so two blocks a few hundred apart share one window and "the
                    // first block on screen" is the same number before and after the jump.
                    const was = _readingAnchor;
                    bookGoToHref(linkHref);
                    await sleep(1500);
                    linkTarget = _readingAnchor;
                    linkMoved = linkTarget !== was;
                }

                // A real click on the book's own contents page, which is the route a reader
                // takes. Matter's entries are the dangling #filepos ones, so this is where
                // the title fallback earns its place; Xeelee's resolve by href and must not
                // change behaviour.
                let tocClickMoved = false, tocClickHref = null, tocClickTarget = -1, tocClickText = null;
                {
                    const titles = {};
                    for (const t of (DocumentModel.toc || [])) {
                        const k = String(t.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        if (k && titles[k] === undefined) titles[k] = t.blockIndex;
                    }
                    // Not firstVisibleIdx(): in a horizontally scrolling multi-column
                    // layout every mounted block intersects the viewport vertically, so it
                    // answers "the first block" no matter where the reader is.
                    const whereAmI = () => (topLeftModelIndexTwoCol() >= 0
                        ? topLeftModelIndexTwoCol() : firstVisibleIdx());
                    goToModelBlock(0);
                    await sleep(1500);
                    const here = whereAmI();
                    const as = document.querySelectorAll('#editor .block a[data-book-href]');
                    let pick = null;
                    for (const a of as) {
                        const k = (a.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        if (titles[k] !== undefined && Math.abs(titles[k] - here) > 20) { pick = a; break; }
                    }
                    if (pick) {
                        tocClickHref = pick.getAttribute('data-book-href');
                        tocClickText = (pick.innerText || '').trim();
                        pick.click();
                        await sleep(1800);
                        tocClickTarget = whereAmI();
                        tocClickMoved = tocClickTarget !== here;
                    }
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
                    absolute, relative, loaded, broken, brokenSrcs, coverRatio, coverBoxRatio,
                    carriers, found, missed,
                    outlineMoved, outlineTarget,
                    hasLinks: linkBlock >= 0, linkHref: linkHref,
                    linkMoved, linkTarget,
                    tocClickMoved, tocClickHref, tocClickTarget, tocClickText,
                    dirty: (function () { updateStatsNow(); return null; })()
                };
            });

            info('image blocks ' + JSON.stringify(nav.carriers) + ', mounted ' +
                 JSON.stringify(nav.found) + ', missed ' + JSON.stringify(nav.missed));
            info('image srcs: ' + nav.absolute + ' resolved, ' + nav.relative + ' left relative');
            assert(nav.relative === 0 && nav.absolute > 0,
                'every image src resolves to the extracted assets (' + nav.absolute + ')');

            info('images that actually loaded: ' + nav.loaded + ', broken ' + nav.broken +
                 (nav.brokenSrcs.length ? ' ' + JSON.stringify(nav.brokenSrcs) : ''));
            assert(nav.loaded > 0 && nav.broken === 0,
                'the bytes arrive: a rewritten src that 404s is still a broken image');

            if (nav.coverRatio !== null) {
                const skew = Math.abs(nav.coverBoxRatio - nav.coverRatio) / nav.coverRatio;
                info('cover renders at ' + nav.coverBoxRatio.toFixed(3) +
                     ' against a viewBox ratio of ' + nav.coverRatio.toFixed(3));
                assert(skew < 0.05,
                    'the cover keeps its aspect ratio (' + (skew * 100).toFixed(1) + '% off)');
            }

            info('outline click -> block ' + nav.outlineTarget);
            assert(nav.outlineMoved, 'clicking an outline entry moves the reader');

            if (nav.hasLinks) {
                info('internal link ' + JSON.stringify(nav.linkHref) + ' -> block ' + nav.linkTarget);
                assert(nav.linkMoved, 'following a link inside the book jumps within it');
            } else {
                info('this book has no resolvable internal links -- its own anchors are ' +
                     'dangling in the file, so there is nothing a reader could follow');
            }

            info('contents click ' + JSON.stringify(nav.tocClickText) + ' (' +
                 JSON.stringify(nav.tocClickHref) + ') -> block ' + nav.tocClickTarget);
            assert(nav.tocClickMoved,
                'clicking an entry on the book’s own contents page jumps to that chapter');
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

        console.log('\n--- the book’s own typography and page breaks ---');
        {
            const bs = await app.eval(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                handleCommand('view_set:columns:1');
                await sleep(1200);
                handleCommand('view_set:scroll:scroll');
                await sleep(1500);
                goToModelBlock(Math.floor(DocumentModel.blocks.length * 0.4));
                await sleep(2500);

                const sheet = (document.getElementById('book-styles') || {}).textContent || '';
                const ed = document.getElementById('editor');
                const prose = Array.prototype.slice.call(ed.querySelectorAll('.block'))
                    .filter(b => (b.innerText || '').length > 300)
                    .map(b => b.firstElementChild || b)[0];

                // The reader's own size has to reach the book's text. A stylesheet in rem
                // is rooted at the application, so the control moves and nothing happens.
                const was = getComputedStyle(ed).fontSize;
                const before = prose ? parseFloat(getComputedStyle(prose).fontSize) : 0;
                ed.style.fontSize = '28px';
                await sleep(300);
                const after = prose ? parseFloat(getComputedStyle(prose).fontSize) : 0;
                ed.style.fontSize = '';
                await sleep(200);
                return {
                    remLeft: /\d\s*rem\b/i.test(sheet),
                    pagedBreaks: (sheet.match(/page-break-(before|after)\s*:\s*(always|left|right)/gi) || []).length,
                    columnBreaks: (sheet.match(/break-(before|after)\s*:\s*column/gi) || []).length,
                    editorFont: was, before: before, after: after
                };
            });
            info('book css: ' + bs.pagedBreaks + ' paged breaks left, ' + bs.columnBreaks +
                 ' turned into column breaks, rem units left: ' + bs.remLeft);
            assert(!bs.remLeft,
                'no rem survives in the book’s css: it is rooted at the application, ' +
                'not at the reader’s text');
            assert(bs.pagedBreaks === 0,
                'the book’s own page breaks are column breaks, which is the only kind ' +
                'a multi-column layout performs');
            info('prose at editor ' + bs.editorFont + ': ' + bs.before +
                 'px, and at 28px: ' + bs.after + 'px');
            assert(bs.before > 0 && bs.after > bs.before * 1.5,
                'the reader’s font size reaches the book’s text (' +
                bs.before + ' -> ' + bs.after + ')');
        }

        console.log('\n--- chapters start pages, and page numbers agree ---');
        {
            const pg = await app.eval(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                handleCommand('view_set:columns:2');
                await sleep(2500);
                handleCommand('view_set:scroll:pagination');
                await sleep(3000);
                // Measured at two places in the book, not one: doc starts are dense in the
                // front matter and sparse in the middle, so a single position quietly turns
                // a thirteen-chapter check into a two-chapter one depending on where the
                // previous test left the reader.
                async function measure(at) {
                    goToModelBlock(at);
                    await sleep(2000);

                    // Per-fragment rects, not getBoundingClientRect(). A paragraph running
                    // from one column into the next reports the *union* of its fragments --
                    // a box spanning both columns -- which buckets by its left edge and
                    // looks exactly like prose sitting above a chapter heading that had in
                    // fact broken correctly. That cost a round of chasing a phantom bug.
                    //
                    // Text-bearing blocks only, too: a book marks its own breaks with an
                    // empty div, and now that those are honoured the div is legitimately
                    // the topmost thing in its column.
                    const ed = document.getElementById('editor');
                    const frags = [];
                    for (const b of ed.querySelectorAll('.block')) {
                        if (!(b.innerText || '').trim()) continue;
                        for (const r of b.getClientRects()) {
                            if (r.height > 0 && r.width > 0) frags.push({ el: b, r: r });
                        }
                    }
                    const colTop = {};
                    for (const f of frags) {
                        const col = Math.round(f.r.left / 10) * 10;
                        if (colTop[col] === undefined || f.r.top < colTop[col]) colTop[col] = f.r.top;
                    }
                    const seen = new Set();
                    const out = { laidOut: 0, atTop: 0, offenders: [] };
                    for (const x of frags) {
                        if (!x.el.hasAttribute('data-chapter-start') || seen.has(x.el)) continue;
                        seen.add(x.el);
                        out.laidOut++;
                        const col = Math.round(x.r.left / 10) * 10;
                        const off = x.r.top - colTop[col];
                        if (off <= 2) out.atTop++;
                        else if (out.offenders.length < 4) {
                            const above = frags.filter(y => Math.round(y.r.left / 10) * 10 === col
                                && y.r.top < x.r.top - 1)
                                .sort((a, b) => a.r.top - b.r.top).slice(0, 2)
                                .map(y => y.el.innerText.replace(/\s+/g, ' ').slice(0, 24));
                            out.offenders.push(Math.round(off) + 'px below its column top: "' +
                                x.el.innerText.replace(/\s+/g, ' ').slice(0, 24) +
                                '", under ' + JSON.stringify(above));
                        }
                    }
                    return out;
                }

                const front = await measure(0);
                const mid = await measure(Math.floor(DocumentModel.blocks.length * 0.4));
                const laidOut = front.laidOut + mid.laidOut;
                const atTop = front.atTop + mid.atTop;
                const offenders = front.offenders.concat(mid.offenders).slice(0, 4);

                updatePageIndicator();
                const nums = Array.prototype.map.call(
                    document.querySelectorAll('#page-indicator .page-num'), x => x.innerText);
                return {
                    chapterStarts: laidOut,
                    laidOut: laidOut,
                    atTop: atTop,
                    offenders: offenders,
                    nums: nums,
                    total: PageMap.count(),
                    current: PageMap.current()
                };
            });
            info('page numbers on screen: ' + JSON.stringify(pg.nums) +
                ', page ' + pg.current + ' of ' + pg.total);
            assert(pg.chapterStarts > 0,
                'chapter starts are marked so they can begin a page (' + pg.chapterStarts + ')');
            info('chapter starts laid out ' + pg.laidOut + ', at a column top ' + pg.atTop +
                (pg.offenders.length ? ' | ' + JSON.stringify(pg.offenders) : ''));
            assert(pg.laidOut === 0 || pg.atTop === pg.laidOut,
                'every laid-out chapter start begins a column (' + pg.atTop + ' of ' + pg.laidOut + ')');
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
    // The omnibus gets the full pass too, not a shallow one. Its assets live in
    // OEBPS/Images/ and its documents in OEBPS/Text/, so it is the only book here whose
    // images can catch a base-directory bug -- Matter is flat at the root and resolves
    // correctly under a base that is wrong for everyone else.
    if (biggest !== primary) await openAndCheck(app, biggest, true);

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
