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
import { launchApp, evalPatiently, profileDir } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

async function waitIdle(app, timeoutMs) {
    try { await app.eval(() => 1); } catch (e) {}
    await settledApp(app, Math.min(timeoutMs || 8000, 8000));
}

async function kick(app, fn, arg) {
    return arg === undefined ? app.eval(fn) : app.eval(fn, arg);
}

async function cmd(app, c) {
    await kick(app, (x) => { handleCommand(x); }, c);
    await waitIdle(app);
}

/**
 * goToModelBlock on a paginated book schedules an rAF chain and returns.
 * Wait until the target's chunk is the one mounted, not until the call returns.
 */
async function waitForBlock(app, idx, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
        const here = await app.eval((i) => {
            try {
                if (typeof PageChunks !== 'undefined' && PageChunks.mounted >= 0
                    && typeof PageChunks.chunkOfBlock === 'function') {
                    return PageChunks.chunkOfBlock(i) === PageChunks.mounted;
                }
                return !!document.querySelector('#editor .block[data-model-index="' + i + '"]');
            } catch (e) { return false; }
        }, idx);
        if (here) return true;
        await sleep(150);
    }
    return false;
}

async function seekFrac(app, f) {
    const idx = await app.eval((frac) => {
        const i = Math.max(0, Math.min(DocumentModel.blocks.length - 1,
            Math.floor(DocumentModel.blocks.length * frac)));
        setTimeout(() => { try { goToModelBlock(i); } catch (e) {} }, 0);
        return i;
    }, f);
    const ok = await waitForBlock(app, idx);
    if (!ok) info('seek did not arrive at block ' + idx);
}

async function seekIndex(app, i) {
    await app.eval((idx) => {
        setTimeout(() => { try { goToModelBlock(idx); } catch (e) {} }, 0);
    }, i);
    const ok = await waitForBlock(app, i);
    if (!ok) info('seek did not arrive at block ' + i);
}

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

async function openAndCheck(app, book, deep, opts) {
    console.log('\n########## ' + book + ' ##########');
    if (!opts || !opts.alreadyOpen) {
        // Deliberately scrolling, in Preview, before the book arrives. That is the state a
        // reader is in when they open a book from a document they were editing, and it is the
        // one that used to strand them: Reader implies pages, the loader set the mode without
        // the pagination, and Reader locks the scroll selector behind it.
        await cmd(app, 'view_set:mode:preview');
        await cmd(app, 'view_set:columns:1');
        await cmd(app, 'view_set:scroll:scroll');
        await evalPatiently(app, (p) => postMsg('open_file_path:' + p),
            path.join(appDir, 'tests', book), { perTry: 20000, timeout: 60000 });
        await waitIdle(app, 60000);
    } else {
        const t0 = Date.now();
        while (Date.now() - t0 < 90000) {
            const k = await evalPatiently(app, () => ({
                kind: (typeof DocumentModel !== 'undefined' && DocumentModel.kind) || '',
                n: (DocumentModel && DocumentModel.blocks) ? DocumentModel.blocks.length : 0
            }), undefined, { perTry: 5000, timeout: 20000 });
            if (k && k.kind === 'epub' && k.n > 1000) break;
            await sleep(250);
        }
        await waitIdle(app, 60000);
    }

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
    // Get to the front of the book and prove it before measuring anything.
    //
    // Already at the front: do not seek. goToModelBlock(0) / PageMap.goto(0) on a
    // 45k-block omnibus remounts and warms an 800-block neighbour; doing that and
    // then immediately measuring (and then seeking to 60%) is the pile-up. Only
    // jump if we are not on page 0.
    let atStart = await evalPatiently(app, () => {
        try { return PageMap.current(); } catch (e) { return -1; }
    });
    if (atStart !== 0) {
        await seekIndex(app, 0);
        atStart = await evalPatiently(app, () => {
            try { return PageMap.current(); } catch (e) { return -1; }
        });
        if (atStart !== 0) {
            await kick(app, () => { try { PageMap.goto(0); } catch (e) {} });
            await waitIdle(app);
            atStart = await evalPatiently(app, () => {
                try { return PageMap.current(); } catch (e) { return -1; }
            });
        }
    }
    const cover = atStart !== 0 ? { found: false, notAtStart: atStart } : await kick(app, () => {
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
    //
    // Isolated, this seek is ~120ms. Fire once and wait for the 60% chunk to
    // be mounted; do not retry the seek itself.
    await seekFrac(app, 0.6);
    const density = await kick(app, () => {
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

    // The book's own stylesheet cannot suppress TypoZen's chapter breaks.
    //
    // The test is a comparison, because the absolute number is not the interesting part: lay
    // the same page out with the book's CSS and without it, and the same chapter starts must
    // open a page either way. Xeelee put `break-after: page` on a body class, so it landed on
    // the paragraph before every story title; at a break point break-after and break-before
    // combine and the strongest wins, `page` outranks `column`, and a multi-column layout
    // discards a paged break -- taking our chapter break with it. Measured 1 of 3 with the
    // stylesheet against 3 of 3 without, which is what pointed at the rule out of 3,114.
    await seekFrac(app, 0.92);
    const surveyChapters = () => {
        const ed = document.getElementById('editor');
        const er = ed.getBoundingClientRect();
        const pitch = PageGeometry.stride() / 2;
        const frags = [];
        for (const b of ed.querySelectorAll('.block'))
            for (const r of b.getClientRects())
                if (r.height >= 1 && r.width >= 1)
                    frags.push({ b, col: Math.round((r.left - er.left + ed.scrollLeft) / pitch), top: r.top });
        let total = 0, atTop = 0;
        for (const el of ed.querySelectorAll('.block[data-chapter-start]')) {
            const mine = frags.filter(f => f.b === el);
            if (!mine.length) continue;
            total++;
            const first = mine.reduce((a, b2) => (b2.top < a.top ? b2 : a));
            if (!frags.some(f => f.b !== el && f.col === first.col && f.top < first.top - 2)) atTop++;
        }
        return { total, atTop };
    };
    const withBook = await evalPatiently(app, surveyChapters);
    await evalPatiently(app, () => {
        const sheet = document.getElementById('book-styles');
        if (sheet) { sheet.disabled = true; void document.getElementById('editor').offsetWidth; }
    });
    await waitIdle(app);
    const without = await evalPatiently(app, surveyChapters);
    await evalPatiently(app, () => {
        const sheet = document.getElementById('book-styles');
        if (sheet) { sheet.disabled = false; void document.getElementById('editor').offsetWidth; }
    });
    const suppression = { withBook, without };
    info('chapter starts opening a page: ' + suppression.withBook.atTop + '/' +
         suppression.withBook.total + ' with the book CSS, ' +
         suppression.without.atTop + '/' + suppression.without.total + ' without it');
    if (suppression.withBook.total > 0) {
        assert(suppression.withBook.atTop === suppression.withBook.total,
            book + ': the book\'s own stylesheet does not swallow a chapter break (' +
            suppression.withBook.atTop + ' of ' + suppression.withBook.total + ')');
    }

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

    // Every outline entry goes somewhere different, and somewhere that starts a page.
    //
    // Matter's whole table of contents points into one file through #filepos anchors that do
    // not exist -- the book contains calibre_pb_0..68 and nothing else -- so all 36 entries
    // resolved to the same block. Title matching rescued the chapters, because a chapter has
    // its name printed at the top of it, and left "Title Page", "Copyright Page",
    // "Dedication" and "About the Author" pointing at the table of contents itself: 28
    // distinct targets for 36 entries, five of them opening the contents page.
    //
    // Distinctness is the assertion because it is the property that survives a book with
    // broken anchors: the entries are ordered and the spine is known, so every entry can at
    // least be given its own document in the right order even when no anchor can prove which.
    const tocTargets = await app.eval(() => {
        const toc = DocumentModel.toc || [];
        const at = toc.map(e => (e.blockIndex != null ? e.blockIndex : e.block))
            .filter(b => b >= 0);
        let onBoundary = 0;
        for (const b of at) if (_bookDocStarts[b]) onBoundary++;
        return { entries: toc.length, resolved: at.length,
                 distinct: new Set(at).size, onBoundary };
    });
    info('outline: ' + tocTargets.entries + ' entries, ' + tocTargets.distinct +
         ' distinct targets, ' + tocTargets.onBoundary + ' on a document boundary');
    if (tocTargets.resolved > 2) {
        assert(tocTargets.distinct === tocTargets.resolved,
            book + ': every outline entry has its own target (' + tocTargets.distinct +
            ' distinct for ' + tocTargets.resolved + ' entries)');
        assert(tocTargets.onBoundary === tocTargets.resolved,
            book + ': and every one of them starts a page (' + tocTargets.onBoundary +
            ' of ' + tocTargets.resolved + ')');
    }

    // No document boundary is anchored to a block that renders nothing.
    //
    // A model-level check, because that is where this went wrong and layout only showed the
    // symptom. Xeelee's stories each begin with a blank spacer block, so the boundary landed
    // on it, the forced break before an empty box did not fire, and three story titles ran on
    // mid-column with a dozen paragraphs of the previous story above them. The spine was
    // right and the anchor was not.
    const anchors = await app.eval(() => {
        const ink = (raw) => /<(img|svg|image|table|hr)\b/i.test(String(raw)) ||
            !!String(raw).replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
                .replace(/\s+/g, ' ').trim();
        const bad = [];
        let total = 0;
        for (const k of Object.keys(_bookDocStarts)) {
            const i = +k;
            total++;
            const b = DocumentModel.blocks[i];
            if (!b) continue;
            if (!ink(b.raw)) bad.push(i);
        }
        return { total, bad: bad.slice(0, 5), badCount: bad.length };
    });
    info(anchors.total + ' document boundaries, ' + anchors.badCount + ' anchored to a blank block');
    assert(anchors.badCount === 0,
        book + ': every document boundary sits on a block that renders something (' +
        anchors.badCount + ' blank' + (anchors.badCount ? ', e.g. ' + JSON.stringify(anchors.bad) : '') + ')');

    // Every chapter starts at the top of a page.
    //
    // In 2-column each column IS a page -- the foot carries two numbers, one under each,
    // and pageDisplayFromSpread turns a spread into two leaf pages. So a chapter opening at
    // the top of the right-hand column has opened at the top of a page, exactly as a printed
    // book does across a spread. What would be wrong is a chapter opening half way down one,
    // which is what break-before: column exists to prevent and what this measures. Checked in
    // 2-column because that is the layout where "column" and "page" could come apart.
    await cmd(app, 'view_set:columns:2');
    await seekFrac(app, 0.5);
    const chapters = await evalPatiently(app, () => {
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
        //
        // Skip the find walk on an omnibus: runFind over 8.1 MB is one synchronous
        // pass, and a CDP poll sitting behind it hits protocolTimeout. Matter is
        // the book that covers search; Xeelee is the book that covers scale.
        if (st.text < 2000000) {
            await cmd(app, 'toggle_search_sidebar');
            await evalPatiently(app, () => {
                const inp = document.getElementById('sidebarSearchInput');
                inp.value = 'the';
                inp.dispatchEvent(new Event('input', { bubbles: true }));
            });
            const searchWait = Date.now();
            while (Date.now() - searchWait < 10000) {
                const n = await evalPatiently(app, () => findState.matches.length);
                if (n > 0) break;
                await sleep(50);
            }
            const searchBefore = await evalPatiently(app, () =>
                (editor.querySelector('.block') || {}).innerText || '');
            await evalPatiently(app, () => {
                const rows = document.querySelectorAll('#search-results-list .search-item');
                if (rows.length) rows[Math.min(20, rows.length - 1)].click();
            });
            await waitIdle(app);
            const search = await evalPatiently(app, (before) => ({
                matches: findState.matches.length,
                rows: document.querySelectorAll('#search-results-list .search-item').length,
                moved: ((editor.querySelector('.block') || {}).innerText || '') !== before,
                marked: (CSS.highlights.get('typozen-find-current') || { size: 0 }).size,
                hayHasTags: /<\/?(p|div|span)\b/i.test(getFindHaystack().haystack)
            }), searchBefore);
            info('search "the": ' + search.matches + ' matches, ' + search.rows + ' rows');
            assert(search.matches > 1000, 'search finds matches across the book');
            assert(!search.hayHasTags, 'and searches its text, not its markup');
            assert(search.marked === 1, 'clicking a result marks exactly one match');
        } else {
            info('search skipped on a ' + st.text + '-char book (find walk is one sync pass)');
        }

        await cmd(app, 'view_set:columns:2');
        await cmd(app, 'view_set:scroll:pagination');
        const pageBefore = await evalPatiently(app, () => PageMap.current());
        await kick(app, () => { PageMap.step(1); });
        await waitIdle(app);
        const paged = await evalPatiently(app, (before) => ({
            paginated: isPaginatedLayout(),
            pages: PageMap.count(),
            turned: PageMap.current() !== before,
            windowed: PageChunks.mounted >= 0,
            mounted: editor.querySelectorAll('.block').length
        }), pageBefore);
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
            await cmd(app, 'view_set:columns:1');
            await cmd(app, 'view_set:scroll:scroll');

            const carriers = await evalPatiently(app, () => {
                const out = [];
                for (let i = 0; i < DocumentModel.blocks.length && out.length < 3; i++) {
                    if (/<(img|image)[\s>]/i.test(DocumentModel.blocks[i].raw)) out.push(i);
                }
                return out;
            });
            let absolute = 0, relative = 0, loaded = 0, broken = 0;
            const brokenSrcs = [];
            let coverRatio = null, coverBoxRatio = null;
            const found = [], missed = [];
            for (const bi of carriers) {
                await seekIndex(app, bi);
                const shot = await evalPatiently(app, async (i) => {
                    const el = document.querySelector('#editor .block[data-model-index="' + i + '"]');
                    if (!el) return { missed: true };
                    const out = { missed: false, absolute: 0, relative: 0, loaded: 0, broken: 0,
                        brokenSrcs: [], coverRatio: null, coverBoxRatio: null };
                    for (const im of el.querySelectorAll('img')) {
                        const src = im.getAttribute('src') || '';
                        if (/^https?:/i.test(src)) out.absolute++; else out.relative++;
                        let ok = im.complete && im.naturalWidth > 0;
                        if (!ok && !im.complete) {
                            ok = await new Promise((res) => {
                                const t = setTimeout(() => res(im.naturalWidth > 0), 5000);
                                im.onload = () => { clearTimeout(t); res(im.naturalWidth > 0); };
                                im.onerror = () => { clearTimeout(t); res(false); };
                            });
                        }
                        if (ok) out.loaded++;
                        else { out.broken++; if (out.brokenSrcs.length < 3) out.brokenSrcs.push(src); }
                    }
                    for (const im of el.querySelectorAll('image')) {
                        const XLINK = 'http://www.w3.org/1999/xlink';
                        const href = im.getAttributeNS(XLINK, 'href') || im.getAttribute('href') || '';
                        if (/^https?:/i.test(href)) out.absolute++; else out.relative++;
                        let ok = false;
                        try {
                            ok = await new Promise((res) => {
                                const probe = new Image();
                                const t = setTimeout(() => res(false), 8000);
                                probe.onload = () => { clearTimeout(t); res(probe.naturalWidth > 0); };
                                probe.onerror = () => { clearTimeout(t); res(false); };
                                probe.src = href;
                            });
                        } catch (e) { ok = false; }
                        if (ok) out.loaded++; else { out.broken++; if (out.brokenSrcs.length < 3) out.brokenSrcs.push(href); }
                        const svg = im.closest('svg');
                        const vb = svg && svg.getAttribute('viewBox');
                        if (vb && out.coverRatio === null) {
                            const p4 = vb.trim().split(/[\s,]+/).map(Number);
                            const r = svg.getBoundingClientRect();
                            if (p4.length === 4 && p4[3] && r.height) {
                                out.coverRatio = p4[2] / p4[3];
                                out.coverBoxRatio = r.width / r.height;
                            }
                        }
                    }
                    return out;
                }, bi, { perTry: 12000, timeout: 20000 });
                if (!shot || shot.missed) { missed.push(bi); continue; }
                found.push(bi);
                absolute += shot.absolute; relative += shot.relative;
                loaded += shot.loaded; broken += shot.broken;
                for (const s of (shot.brokenSrcs || [])) if (brokenSrcs.length < 3) brokenSrcs.push(s);
                if (coverRatio === null && shot.coverRatio != null) {
                    coverRatio = shot.coverRatio; coverBoxRatio = shot.coverBoxRatio;
                }
            }

            const outlineBefore = await evalPatiently(app, () =>
                (topLeftModelIndexTwoCol() >= 0 ? topLeftModelIndexTwoCol() : (function () {
                    const host = mainContainer.getBoundingClientRect();
                    let idx = -1;
                    document.getElementById('editor').querySelectorAll('.block').forEach(b => {
                        if (idx >= 0) return;
                        const r = b.getBoundingClientRect();
                        if (r.bottom > host.top + 2 && r.top < host.bottom)
                            idx = DocumentModel.modelIndexOfEl(b);
                    });
                    return idx;
                })()));
            await evalPatiently(app, () => {
                const items = document.querySelectorAll('#outline-list .outline-item');
                if (items.length > 6) items[6].click();
            });
            await waitIdle(app);
            const outline = await evalPatiently(app, (before) => {
                const host = mainContainer.getBoundingClientRect();
                let idx = -1;
                document.getElementById('editor').querySelectorAll('.block').forEach(b => {
                    if (idx >= 0) return;
                    const r = b.getBoundingClientRect();
                    if (r.bottom > host.top + 2 && r.top < host.bottom)
                        idx = DocumentModel.modelIndexOfEl(b);
                });
                return { outlineMoved: idx !== before, outlineTarget: _readingAnchor };
            }, outlineBefore);

            const linkPick = await evalPatiently(app, () => {
                const anchors = buildBookAnchorIndex();
                for (let i = 0; i < DocumentModel.blocks.length; i++) {
                    const hs = (DocumentModel.blocks[i].raw || '').match(/href\s*=\s*"([^"]+)"/g);
                    if (!hs) continue;
                    for (const h of hs) {
                        const href = h.slice(6, -1);
                        if (/^https?:/i.test(href)) continue;
                        const frag = href.indexOf('#') >= 0 ? href.slice(href.indexOf('#') + 1) : '';
                        const file = bookNormalizeHref(href);
                        const t = (frag && anchors[frag] !== undefined) ? anchors[frag]
                            : ((file && _bookDocIndex[file] !== undefined) ? _bookDocIndex[file] : -1);
                        if (t >= 0 && Math.abs(t - i) > 20)
                            return { linkBlock: i, linkHref: href };
                    }
                }
                return { linkBlock: -1, linkHref: null };
            });
            let linkTarget = -1, linkMoved = false;
            if (linkPick.linkBlock >= 0) {
                await seekIndex(app, linkPick.linkBlock);
                const was = await evalPatiently(app, () => _readingAnchor);
                await kick(app, (href) => { bookGoToHref(href); }, linkPick.linkHref);
                await waitIdle(app);
                linkTarget = await evalPatiently(app, () => _readingAnchor);
                linkMoved = linkTarget !== was;
            }

            await seekIndex(app, 0);
            const tocHere = await evalPatiently(app, () =>
                (topLeftModelIndexTwoCol() >= 0 ? topLeftModelIndexTwoCol() : 0));
            const tocPick = await evalPatiently(app, (here) => {
                const titles = {};
                for (const t of (DocumentModel.toc || [])) {
                    const k = String(t.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    if (k && titles[k] === undefined) titles[k] = t.blockIndex;
                }
                const as = document.querySelectorAll('#editor .block a[data-book-href]');
                for (const a of as) {
                    const k = (a.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    if (titles[k] !== undefined && Math.abs(titles[k] - here) > 20) {
                        a.setAttribute('data-tz-toc-pick', '1');
                        return { href: a.getAttribute('data-book-href'), text: (a.innerText || '').trim() };
                    }
                }
                return null;
            }, tocHere);
            let tocClickMoved = false, tocClickHref = null, tocClickTarget = -1, tocClickText = null;
            if (tocPick) {
                tocClickHref = tocPick.href; tocClickText = tocPick.text;
                await evalPatiently(app, () => {
                    const a = document.querySelector('#editor .block a[data-tz-toc-pick]');
                    if (a) a.click();
                });
                await waitIdle(app);
                tocClickTarget = await evalPatiently(app, () =>
                    (topLeftModelIndexTwoCol() >= 0 ? topLeftModelIndexTwoCol() : 0));
                tocClickMoved = tocClickTarget !== tocHere;
            }

            const nav = {
                absolute, relative, loaded, broken, brokenSrcs, coverRatio, coverBoxRatio,
                carriers, found, missed,
                outlineMoved: outline.outlineMoved, outlineTarget: outline.outlineTarget,
                hasLinks: linkPick.linkBlock >= 0, linkHref: linkPick.linkHref,
                linkMoved, linkTarget,
                tocClickMoved, tocClickHref, tocClickTarget, tocClickText
            };

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
            await cmd(app, 'view_set:columns:1');
            await cmd(app, 'view_set:scroll:scroll');
            await seekFrac(app, 0.4);
            const bsSheet = await evalPatiently(app, () => {
                const sheet = (document.getElementById('book-styles') || {}).textContent || '';
                return {
                    remLeft: /\d\s*rem\b/i.test(sheet),
                    pagedBreaks: (sheet.match(/page-break-(before|after)\s*:\s*(always|left|right)/gi) || []).length,
                    columnBreaks: (sheet.match(/break-(before|after)\s*:\s*column/gi) || []).length
                };
            });
            const proseFs = () => {
                const ed = document.getElementById('editor');
                for (const b of ed.querySelectorAll('.block')) {
                    if ((b.innerText || '').length <= 300) continue;
                    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, null);
                    let node = null, len = 0, x;
                    while ((x = w.nextNode())) {
                        const s = (x.nodeValue || '').trim();
                        if (s.length > len) { len = s.length; node = x; }
                    }
                    if (node && node.parentElement)
                        return parseFloat(getComputedStyle(node.parentElement).fontSize);
                }
                return 0;
            };
            const was = await evalPatiently(app, () =>
                parseFloat(getComputedStyle(document.documentElement).fontSize));
            const before = await evalPatiently(app, proseFs);
            await evalPatiently(app, () => {
                document.documentElement.style.setProperty('--fs', '28px');
            });
            await waitIdle(app);
            const after = await evalPatiently(app, proseFs);
            const afterRoot = await evalPatiently(app, () =>
                parseFloat(getComputedStyle(document.documentElement).fontSize));
            await evalPatiently(app, (px) => {
                document.documentElement.style.setProperty('--fs', px + 'px');
            }, was);
            const bs = {
                remLeft: bsSheet.remLeft,
                pagedBreaks: bsSheet.pagedBreaks,
                columnBreaks: bsSheet.columnBreaks,
                editorFont: was + 'px', before: before, after: after, afterRoot: afterRoot
            };
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
            await cmd(app, 'view_set:columns:2');
            await cmd(app, 'view_set:scroll:pagination');
            const measureSpread = () => {
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
            };
            await seekIndex(app, 0);
            const front = await evalPatiently(app, measureSpread);
            await seekFrac(app, 0.4);
            const mid = await evalPatiently(app, measureSpread);
            const laidOut = front.laidOut + mid.laidOut;
            const atTop = front.atTop + mid.atTop;
            const offenders = front.offenders.concat(mid.offenders).slice(0, 4);
            const pg = await evalPatiently(app, () => {
                updatePageIndicator();
                const nums = Array.prototype.map.call(
                    document.querySelectorAll('#page-indicator .page-num'), x => x.innerText);
                return { nums, total: PageMap.count(), current: PageMap.current() };
            });
            pg.chapterStarts = laidOut;
            pg.laidOut = laidOut;
            pg.atTop = atTop;
            pg.offenders = offenders;
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

let app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await openAndCheck(app, primary, true);
    // The omnibus gets the full pass too. Its assets live in OEBPS/Images/ and its
    // documents in OEBPS/Text/, so it is the only book here whose images can catch a
    // base-directory bug -- Matter is flat at the root.
    //
    // Own process, launched as the .epub itself, on a fresh profile. Matter's
    // session in the throwaway profile (2-col geometry, last file, page map)
    // coming along for the ride left the omnibus density seek sitting behind
    // leftover work until protocolTimeout. Isolated, the same seek is ~120ms.
    if (biggest !== primary) {
        await app.close();
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
        fs.mkdirSync(profileDir, { recursive: true });
        await sleep(800);
        app = await launchApp({ file: path.join('tests', biggest) });
        await openAndCheck(app, biggest, true, { alreadyOpen: true });
    }

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
