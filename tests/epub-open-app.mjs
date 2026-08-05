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
