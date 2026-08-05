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
const STORE = path.join(process.env.LOCALAPPDATA || '', 'TypoZen_Cache', 'book_positions.txt');
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

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'BOOK POSITION FAILED' : 'BOOK POSITION PASSED');
process.exit(failed ? 1 : 0);
