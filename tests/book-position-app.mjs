/**
 * A book reopens where you stopped reading.
 *
 * Through two real launches of TypoZen.exe, because that is the whole claim: the position
 * has to survive the process, not just the tab. Asserting it in one session would only
 * prove a variable still holds a number.
 *
 *   RUN_APP_E2E=1 node tests/book-position-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, profileFile } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const book = fs.readdirSync(path.join(appDir, 'tests'))
    .filter(f => f.toLowerCase().endsWith('.epub')).sort()
    .find(f => /matter/i.test(f));
if (!book) {
    console.log('  --   no book in tests/, nothing to verify.');
    console.log('passed=0 failed=0');
    console.log('BOOK POSITION SKIPPED');
    process.exit(0);
}
const bookPath = path.join(appDir, 'tests', book);

// Start from nothing remembered, so "it opened at the right place" cannot be an accident
// of a previous run. The store is the real profile's, so it is put back afterwards -- a test has no
// business discarding where someone was up to in their own books.
const STORE = profileFile('book_positions.txt');
let restoreStore = null;
try { restoreStore = fs.readFileSync(STORE, 'utf8'); } catch (e) {}
try { fs.unlinkSync(STORE); } catch (e) {}
function putStoreBack() {
    try {
        if (restoreStore !== null) fs.writeFileSync(STORE, restoreStore);
        else fs.unlinkSync(STORE);
    } catch (e) {}
}

const TARGET = 900;

console.log('\n=== first session: read into the book ===');
let app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
let landed = -1;
try {
    await sleep(3000);
    await app.eval((p) => postMsg('open_file_path:' + p), bookPath);
    await sleep(9000);
    await settledApp(app, 30000);

    landed = await app.eval(async (at) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:columns:2');
        await sleep(2000);
        handleCommand('view_set:scroll:pagination');
        await sleep(2500);
        goToModelBlock(at);
        await sleep(1500);
        // A real scroll, so the position is reported the way reading reports it rather
        // than by calling the reporter directly.
        const ed = document.getElementById('editor');
        ed.dispatchEvent(new Event('scroll'));
        await sleep(2500);
        return topLeftModelIndexTwoCol();
    }, TARGET);
    info('reading at block ' + landed + ' (asked for ' + TARGET + ')');
    assert(landed > 0, 'the reader is somewhere in the book, not at the cover');
} finally {
    await app.close();
}

await sleep(1500);

const haveStore = fs.existsSync(STORE);
info('position store: ' + (haveStore ? STORE : 'not written'));
assert(haveStore, 'reading a book leaves a remembered position on disk');
if (haveStore) {
    const text = fs.readFileSync(STORE, 'utf8');
    info('store says: ' + text.trim().split(String.fromCharCode(10))[0].trim());
    assert(text.toLowerCase().includes(book.toLowerCase()),
        'and it names the book that was read');
}

console.log('\n=== second session: it opens where it was left ===');
app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3000);
    await app.eval((p) => postMsg('open_file_path:' + p), bookPath);
    await sleep(11000);
    await settledApp(app, 30000);

    const back = await app.eval(() => ({
        at: topLeftModelIndexTwoCol(),
        blocks: DocumentModel.blocks.length
    }));
    info('reopened at block ' + back.at + ' of ' + back.blocks +
         ', left at ' + landed);
    assert(back.at > 0, 'the book does not reopen at the cover');
    // Not an exact block: the window may differ by a page, and a reader who returns to
    // the top of the page they were on has lost nothing.
    assert(Math.abs(back.at - landed) <= 40,
        'and reopens within a page of where reading stopped (' + back.at + ' vs ' + landed + ')');
} finally {
    await app.close();
}

console.log('\n=== and is not overwritten by the tab you came from ===');
// Reported from real use: reading a .txt and switching to a book put the book on its
// cover. The report is debounced, so the one armed by scrolling the .txt fired after the
// host had already pointed the current path at the book, and the book's own position was
// overwritten with a block number from a different document.
app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3000);
    await app.eval((p) => postMsg('open_file_path:' + p), bookPath);
    await sleep(10000);
    const deep = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(1500);
        await sleep(1200);
        document.getElementById('editor').dispatchEvent(new Event('scroll'));
        await sleep(2200);
        return currentReadingBlock();
    });
    info('book left at block ' + deep);

    // Onto a short text document, scroll it, then straight back -- the switch happening
    // while a report from the text document is still pending.
    await app.eval((p) => postMsg('open_file_path:' + p),
        path.join(appDir, 'tests', 'short-note.txt'));
    await sleep(5000);
    await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(12);
        await sleep(300);
        document.getElementById('editor').dispatchEvent(new Event('scroll'));
        if (mainContainer) mainContainer.dispatchEvent(new Event('scroll'));
    });
    await sleep(250);
    await app.eval((p) => postMsg('open_file_path:' + p), bookPath);
    await sleep(11000);
    await settledApp(app, 30000);

    const reopened = await app.eval(() => ({
        kind: DocumentModel.kind, at: currentReadingBlock(), blocks: DocumentModel.blocks.length
    }));
    info('book reopened at block ' + reopened.at + ' of ' + reopened.blocks);
    assert(reopened.kind === 'epub', 'the book is what came back');
    assert(reopened.at > 200,
        'the book keeps its own position rather than the short document’s (' +
        reopened.at + ', left at ' + deep + ')');
} finally {
    await app.close();
}

console.log('\n=== and does not show the cover on the way there ===');
// The resume used to run after the first paint, so a book opened 2,000 blocks in showed
// its cover for a moment and then jumped. The range holding the resume block is mounted
// first instead, so there is no frame to see.
app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3000);
    await app.eval((p) => postMsg('open_file_path:' + p), bookPath);
    await sleep(11000);
    await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(2200);
        await sleep(1500);
        document.getElementById('editor').dispatchEvent(new Event('scroll'));
        await sleep(2200);
    });
    await app.eval((p) => postMsg('open_file_path:' + p),
        path.join(appDir, 'tests', 'short-note.txt'));
    await sleep(5000);

    // Sample hard from the moment the open is asked for, so an early frame at the cover
    // would be caught rather than slept through.
    await app.eval((p) => postMsg('open_file_path:' + p), bookPath);
    const frames = [];
    for (let i = 0; i < 30 && frames.length < 6; i++) {
        await sleep(250);
        const f = await app.eval(() => (DocumentModel.kind === 'epub')
            ? { c: PageChunks.mounted, at: currentReadingBlock() } : null);
        if (f) frames.push(f);
    }
    info('first frames (range/block): ' + frames.map(f => f.c + '/' + f.at).join('  '));
    assert(frames.length > 0, 'the book came back');
    assert(frames.every(f => f.c > 0),
        'every frame is the range being resumed into, never the front of the book');
    assert(frames.every(f => f.at > 1000),
        'and no frame sits on the cover (' + frames.map(f => f.at).join(', ') + ')');
} finally {
    await app.close();
}

// The store is the real profile's; this test borrowed it.
putStoreBack();

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'BOOK POSITION FAILED' : 'BOOK POSITION PASSED');
process.exit(failed ? 1 : 0);
