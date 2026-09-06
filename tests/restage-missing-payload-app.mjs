/**
 * A document whose staged payload has gone recovers instead of erroring.
 *
 * A large document and every book are handed to the page as a file in LoadStageDir() plus
 * a https://localload/ URL to fetch. That directory is disposable BY DESIGN:
 * StageLoadPayload prunes it at five minutes, Clear Stored Data empties it, and turning
 * Privacy Mode off deletes the entire private root it was living in.
 *
 * Reported: Privacy Mode off, switch back to the book, "Load failed / Failed to fetch"
 * over a novel that was perfectly readable on disk. The dialog's advice -- "the tab still
 * holds the file text" -- was false twice over: a book tab's Content is "" by definition,
 * and the inline fallback for a markdown tab is capped at 2 x 96 KB, so the 205,842-char
 * document in the report was 9,234 characters past it and the fallback silently declined.
 *
 * WHAT THIS DRIVES, and why not the obvious thing: deleting the staged file and reopening
 * proves nothing, because opening re-stages a fresh payload and takes the ordinary path --
 * the first version of this suite did exactly that, passed, and tested nothing. The defect
 * is in the host's load_failed: handler, so the suite posts that message directly, with
 * the page deliberately emptied first so a recovery is visible when it arrives.
 *
 * Runs against a temp profile; the real cache is never touched.
 *
 *   RUN_APP_E2E=1 node tests/restage-missing-payload-app.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/**
 * Poll the page until pred(state) holds. An explicit loop rather than evalPatiently:
 * that helper returned null here while the book was plainly loading, so the waits were
 * failing rather than the app.
 */
async function until(read, pred, budgetMs, label) {
    const deadline = Date.now() + budgetMs;
    let last = null;
    while (Date.now() < deadline) {
        try { last = await read(); } catch (e) { last = null; }
        if (last && pred(last)) return last;
        await sleep(400);
    }
    info('timed out waiting for ' + label + '; last = ' + JSON.stringify(last));
    return last;
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 8000 });
try {
    await settledApp(app, 8000);
    const state = () => app.eval(() => ({
        n: DocumentModel.blocks.length, k: DocumentModel.kind
    }));

    const start = await state();
    info('markdown: ' + JSON.stringify(start));
    assert(start.n > 1000 && start.k === 'markdown',
        'control: the large document is open to begin with');

    console.log('\n=== a book tab told its payload failed ===');
    const book = path.join(appDir, 'tests', '7-Dune - Frank Herbert.epub');
    await app.eval((p) => postMsg('open_file_path:' + p), book);
    // Wait for the BOOK, not merely for a document. The first version of this suite read
    // 3,767 blocks of markdown here and called it "the book really opened".
    const opened = await until(state, (s) => s.k === 'epub' && s.n > 100, 60000,
        'the book to finish loading');
    info('book: ' + JSON.stringify(opened));
    assert(opened && opened.k === 'epub', 'control: the book is open and is the active tab');

    // Empty the page. A recovery that puts the book back is now visible; without one the
    // page simply stays empty, which is the reported experience.
    await app.eval(() => loadMarkdownContent('', { replaceBook: true }));
    const emptied = await until(state, (s) => s.k !== 'epub', 15000,
        'the page to let go of the book');
    info('emptied: ' + JSON.stringify(emptied));
    assert(emptied.k !== 'epub', 'control: the page no longer holds the book');

    // Exactly what the page posts when its fetch dies -- 03-shell.js:
    //   postMsg('load_failed:' + String(err && err.message ...))
    // and a dead virtual host gives "Failed to fetch".
    await app.eval(() => postMsg('load_failed:Failed to fetch'));
    const recovered = await until(state, (s) => s.k === 'epub' && s.n > 100, 45000,
        'the book to come back');
    info('recovered: ' + JSON.stringify(recovered));
    assert(recovered && recovered.k === 'epub',
        'the book re-stages from its .epub instead of leaving the reader with an error'
        + (recovered ? '' : ' (never came back)'));
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('RESTAGE FAILED'); process.exit(1); }
console.log('RESTAGE PASSED');
