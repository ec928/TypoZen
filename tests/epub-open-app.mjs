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
    // Deliberately scrolling, in Preview, before the book arrives. That is the state a
    // reader is in when they open a book from a document they were editing, and it is the
    // one that used to strand them: Reader implies pages, the loader set the mode without
    // the pagination, and Reader locks the scroll selector behind it.
    await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:mode:preview');
        await sleep(800);
        handleCommand('view_set:columns:1');
        await sleep(800);
        handleCommand('view_set:scroll:scroll');
        await sleep(800);
    });
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

    // The body renders at the size the theme asked for.
    //
    // Measured from the element that directly owns each text node, weighted by characters.
    // Both of those matter, and getting either wrong is what hid this for so long: the
    // normaliser read block.querySelector('p'), which on Matter (div.block > div.calibre7 >
    // span.calibre15, no <p> at all) found a container inheriting the theme size, declared
    // the book correct, and left 99.2% of its text painting a third too large. Counting
    // elements rather than characters hides it too -- one enormous chapter and one drop cap
    // are one element each.
    const size = await app.eval(() => {
        const ed = document.getElementById('editor');
        const counts = new Map();
        let total = 0;
        const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null);
        let n;
        while ((n = walker.nextNode())) {
            const s = (n.nodeValue || '').trim();
            if (s.length < 20) continue;
            const owner = n.parentElement;
            if (!owner) continue;
            const px = Math.round(parseFloat(getComputedStyle(owner).fontSize) * 10) / 10;
            if (!px || px < 4) continue;
            counts.set(px, (counts.get(px) || 0) + s.length);
            total += s.length;
        }
        let dominant = 0, best = 0;
        counts.forEach((c, px) => { if (c > best) { best = c; dominant = px; } });
        return {
            themeFs: parseFloat(getComputedStyle(document.documentElement)
                .getPropertyValue('--fs')) || 0,
            dominant: dominant,
            share: total ? best / total : 0
        };
    });
    const ratio = size.themeFs ? size.dominant / size.themeFs : 0;
    info('body ' + size.dominant + 'px against theme ' + size.themeFs + 'px (' +
        ratio.toFixed(3) + 'x, ' + Math.round(size.share * 100) + '% of characters)');
    assert(size.share > 0.5,
        book + ': one size covers the body (' + Math.round(size.share * 100) + '% of characters)');
    assert(ratio > 0.94 && ratio < 1.06,
        book + ': body text renders at the theme size (' + size.dominant + 'px vs ' +
        size.themeFs + 'px, ' + ratio.toFixed(3) + 'x)');

    // The cover fills the page it is on -- and is still on it.
    //
    // Sizing it to exactly the page height put it on the *next* page: the block's margins
    // and the line box a replaced element sits on pushed it a few pixels over and multicol
    // moved the whole thing across, so the cover page rendered blank. The size was right and
    // the position was wrong, and a check that measured only the size passed. So both.
    const cover = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Get to the front of the book and prove it before measuring anything.
        //
        // PageMap.goto(0) alone is not enough on a 45,000-block omnibus: page windowing has
        // to mount the first range, and this suite arrives having already driven the view
        // deep into a different book. Measuring before the seek settled reported the cover
        // 7,053px off to the left and failed a check about sizing on a fact about timing.
        goToModelBlock(0);
        await sleep(1500);
        for (let i = 0; i < 6 && PageMap.current() !== 0; i++) {
            PageMap.goto(0);
            await sleep(1200);
        }
        if (PageMap.current() !== 0) return { found: false, notAtStart: PageMap.current() };
        const ed = document.getElementById('editor');
        const er = ed.getBoundingClientRect();
        let best = null;
        for (const el of ed.querySelectorAll('.block img, .block svg')) {
            const r = el.getBoundingClientRect();
            if (r.height < 2) continue;
            if (!best || r.height > best.h) {
                best = {
                    h: r.height, w: r.width,
                    xOff: r.left - er.left,
                    plate: !!el.closest('.block').classList.contains('tz-plate')
                };
            }
        }
        return best ? {
            found: true,
            h: Math.round(best.h), w: Math.round(best.w),
            xOff: Math.round(best.xOff), plate: best.plate,
            paneH: Math.round(er.height), paneW: Math.round(er.width)
        } : { found: false };
    });
    if (cover.notAtStart !== undefined) {
        failed++;
        console.error('  FAIL ' + book + ': could not get back to the first page to look at ' +
            'the cover (stuck on ' + cover.notAtStart + ')');
    }
    if (cover.found) {
        const fillsH = cover.h / cover.paneH;
        info('cover ' + cover.w + 'x' + cover.h + ' in a ' + cover.paneW + 'x' + cover.paneH +
             ' page, x=' + cover.xOff + ', plate=' + cover.plate);
        assert(cover.plate, book + ': the cover is recognised as a plate');
        assert(cover.xOff >= -2 && cover.xOff < cover.paneW,
            book + ': the cover is on the page being shown, not the next one (x=' +
            cover.xOff + ' in a ' + cover.paneW + 'px page)');
        assert(fillsH > 0.9,
            book + ': and fills the page it is on (' + Math.round(fillsH * 100) + '% of ' +
            cover.paneH + 'px)');
        assert(cover.w <= cover.paneW + 1,
            book + ': without spilling out of the column (' + cover.w + ' in ' +
            cover.paneW + ')');
    }

    // A page of a book is full of text.
    //
    // The most basic thing a reader does, and nothing asserted it. Converting the book's
    // `break-after: page` to a column break -- which looked like honouring the publisher --
    // put a break after nearly every paragraph, because Xeelee carries that declaration on
    // its body classes. Columns went from 97% full to 9%: two paragraphs on a whole spread.
    // Every existing suite stayed green, because they all check *where* things are and none
    // of them checks that there is anything to read.
    const density = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(Math.floor(DocumentModel.blocks.length * 0.6));
        await sleep(3000);
        const ed = document.getElementById('editor');
        const er = ed.getBoundingClientRect();
        const cols = new Map();
        for (const b of ed.querySelectorAll('.block')) {
            for (const r of b.getClientRects()) {
                if (r.height < 1 || r.width < 1) continue;
                const c = Math.round((r.left - er.left) / 4) * 4;
                const e = cols.get(c) || { top: Infinity, bot: -Infinity };
                e.top = Math.min(e.top, r.top - er.top);
                e.bot = Math.max(e.bot, r.bottom - er.top);
                cols.set(c, e);
            }
        }
        const fills = [...cols.values()]
            .map(e => Math.round(100 * (e.bot - e.top) / er.height))
            .sort((a, b) => a - b);
        return { fills, median: fills[Math.floor(fills.length / 2)] || 0, columns: fills.length };
    });
    info('column fill across ' + density.columns + ' columns, median ' + density.median + '%');
    assert(density.median >= 80,
        book + ': a page of the book is full of text (median column ' + density.median +
        '% full; front matter and part titles are legitimately sparse, a novel is not)');

    // A picture is a plate only when its *document* is nothing but pictures.
    //
    // "Alone in its block" is not enough. Matter's appendix is a heading, a table of
    // abbreviations set as an image, another heading, and four character lists set as
    // images -- every image alone in its block, so under the weaker rule every one took a
    // full column and the appendix ran to six columns where a reader uses two pages. They
    // are reference tables, not cover art, and the document they sit in has prose in it.
    const plates = await app.eval(() => {
        if (typeof _bookPlateBlocks === 'undefined' || !_bookPlateBlocks) return null;
        const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        let picturesInProseDocs = 0, plateCount = 0;
        for (let i = 0; i < DocumentModel.blocks.length; i++) {
            const raw = DocumentModel.blocks[i].raw;
            if (!/<(img|svg)\b/i.test(String(raw))) continue;
            if (_bookPlateBlocks[i]) { plateCount++; continue; }
            if (!strip(raw)) picturesInProseDocs++;
        }
        return { plateCount, picturesInProseDocs, blocks: DocumentModel.blocks.length };
    });
    if (plates) {
        info(plates.plateCount + ' plate blocks, ' + plates.picturesInProseDocs +
             ' pictures left inline inside documents that carry text');
        assert(plates.plateCount >= 1,
            book + ': the cover document is recognised as plates (' + plates.plateCount + ')');
        assert(plates.plateCount < 40,
            book + ': and a document with prose in it does not turn its pictures into ' +
            'full-page plates (' + plates.plateCount + ' plate blocks in ' +
            plates.blocks + ')');
    }

    // Every chapter starts at the top of a page.
    //
    // In 2-column each column IS a page -- the foot carries two numbers, one under each,
    // and pageDisplayFromSpread turns a spread into two leaf pages. So a chapter opening at
    // the top of the right-hand column has opened at the top of a page, exactly as a printed
    // book does across a spread. What would be wrong is a chapter opening half way down one,
    // which is what break-before: column exists to prevent and what this measures. Checked in
    // 2-column because that is the layout where "column" and "page" could come apart.
    const chapters = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:columns:2');
        await sleep(2500);
        goToModelBlock(Math.floor(DocumentModel.blocks.length * 0.5));
        await sleep(3000);
        const ed = document.getElementById('editor');
        const er = ed.getBoundingClientRect();

        // "At the top of its column" means nothing is painted above it there -- not that
        // its box starts at y=0. Two things make the naive version wrong, and both bit:
        //
        //  - a chapter heading carries a 36px top margin, so its border-box top is never 0
        //    even when it opens the page;
        //  - getBoundingClientRect() on a block fragmented across a column break returns the
        //    union of its fragments, so it reports a left edge in one column and a top in
        //    another. Grouping by that put blocks in columns they are not in.
        //
        // Client rects are the fragments themselves, one per column, so they say exactly
        // where ink is.
        const frags = [];
        for (const el of ed.querySelectorAll('.block')) {
            for (const r of el.getClientRects()) {
                if (r.height < 1 || r.width < 1) continue;
                frags.push({
                    el,
                    col: Math.round((r.left - er.left) / 4) * 4,
                    top: r.top - er.top
                });
            }
        }
        const out = [];
        for (const el of ed.querySelectorAll('.block[data-chapter-start]')) {
            const mine = frags.filter(f => f.el === el);
            if (!mine.length) continue;
            const first = mine.reduce((a, b) => (b.top < a.top ? b : a));
            let above = 0;
            for (const f of frags) {
                if (f.el === el || f.col !== first.col) continue;
                if (f.top < first.top - 4) above = Math.max(above, Math.round(first.top - f.top));
            }
            out.push({
                mi: +el.getAttribute('data-model-index'),
                y: Math.round(first.top),
                above,
                text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24) || '(empty)'
            });
        }
        return out;
    });
    // `above` is how much content sits over it in its own column. Zero means it opens the
    // page, whatever margin its heading brings with it.
    const strayed = chapters.filter(c => c.above > 4);
    info(chapters.length + ' chapter starts laid out; ' + strayed.length + ' not at a column top' +
         (strayed.length ? ': ' + JSON.stringify(strayed.slice(0, 3)) : ''));
    if (chapters.length) {
        assert(strayed.length === 0,
            book + ': every chapter start begins at the top of a page, not part way down one (' +
            strayed.length + ' of ' + chapters.length + ' strayed)');
    }

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
                readerClass: editor.classList.contains('reader-mode'),
                pageMode: editor.classList.contains('page-mode'),
                view: currentViewState()
            }));
            info('mode ' + s2.mode + ', editable ' + s2.editable);
            assert(s2.mode === 'reader', 'a book opens in Reader, not Preview');
            assert(s2.editable === 'false' && s2.readerClass, 'and stays read-only');
            // Reader is pages only, and Reader locks the scroll selector. Opening a book
            // while the previous document was scrolling used to land in reader + scroll --
            // a state the resolver cannot produce and the toolbar cannot leave. The only
            // way out was a round trip through Preview and back.
            info('view state on open: ' + s2.view.mode + ', ' + s2.view.columns +
                '-col, ' + s2.view.scroll + (s2.view.scrollLocked ? ' (scroll locked)' : ''));
            assert(s2.view.scroll === 'pagination',
                'and opens paginated, which is what Reader means');
            assert(!(s2.view.scrollLocked && s2.view.scroll !== 'pagination'),
                'never in a state the scroll selector is locked out of leaving');
            assert(s2.pageMode,
                'with the page-mode layout actually applied, not just the flag set');
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
                // The element that owns the text, not the block's first child.
                //
                // firstElementChild was a container: on Matter (div.block > div.calibre7 >
                // span.calibre15) it is div.calibre7, which inherits the theme size, so
                // this assertion read exactly what the theme had set and passed no matter
                // what the reader saw. The text is a level deeper at 1.33333em, and this
                // check sat green through a book rendering a third too large.
                const prose = (function () {
                    for (const b of ed.querySelectorAll('.block')) {
                        if ((b.innerText || '').length <= 300) continue;
                        const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, null);
                        let node = null, len = 0, x;
                        while ((x = w.nextNode())) {
                            const s = (x.nodeValue || '').trim();
                            if (s.length > len) { len = s.length; node = x; }
                        }
                        if (node && node.parentElement) return node.parentElement;
                    }
                    return null;
                })();

                // The reader's own size has to reach the book's text, and be the size the
                // text actually renders at. A stylesheet in rem is rooted at the
                // application, so the control moved and nothing happened; one asking for
                // 0.88em rendered a book 12% smaller than the theme it was opened under.
                //
                // Driven through --fs, which is what a theme sets. Writing a pixel size
                // onto the editor instead would overwrite the correction being tested.
                const rootFs = () => parseFloat(getComputedStyle(document.documentElement).fontSize);
                const was = rootFs();
                const before = prose ? parseFloat(getComputedStyle(prose).fontSize) : 0;
                document.documentElement.style.setProperty('--fs', '28px');
                await sleep(400);
                const after = prose ? parseFloat(getComputedStyle(prose).fontSize) : 0;
                const afterRoot = rootFs();
                document.documentElement.style.setProperty('--fs', was + 'px');
                await sleep(300);
                return {
                    remLeft: /\d\s*rem\b/i.test(sheet),
                    pagedBreaks: (sheet.match(/page-break-(before|after)\s*:\s*(always|left|right)/gi) || []).length,
                    columnBreaks: (sheet.match(/break-(before|after)\s*:\s*column/gi) || []).length,
                    editorFont: was + 'px', before: before, after: after, afterRoot: afterRoot
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
            info('prose at a ' + bs.editorFont + ' theme: ' + bs.before +
                 'px, and at a ' + bs.afterRoot + 'px theme: ' + bs.after + 'px');
            assert(Math.abs(bs.before - parseFloat(bs.editorFont)) <= 0.5,
                'the book’s body text renders at the size the theme asks for (' +
                bs.before + ' against ' + bs.editorFont + ')');
            assert(Math.abs(bs.after - bs.afterRoot) <= 1.0,
                'and follows the theme when it changes (' +
                bs.after + ' against ' + bs.afterRoot + 'px)');
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
