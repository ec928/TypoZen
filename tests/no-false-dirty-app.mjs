/**
 * Opening a book does not mark the tab you came from as unsaved.
 *
 * Reported from real use, launching a book from ZenSeek: closing TypoZen offered to "Save
 * changes to large-scroll-mixed.md" -- a Markdown tab nobody had touched. Saying yes would
 * have written whatever the page held over it.
 *
 * The cause was not ZenSeek. The page posts a `typing` ping so the host can react to
 * editing, and it was posted from updateStats(), which also runs on programmatic changes --
 * loading a book is one. The host applies that ping to whichever tab it currently thinks is
 * active, and during a load that is still the outgoing one.
 *
 * Asserted against the session file rather than the dialog, because the dialog is what the
 * flag causes and the flag is what is wrong.
 *
 *   RUN_APP_E2E=1 node tests/no-false-dirty-app.mjs
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
    console.log('NO FALSE DIRTY SKIPPED');
    process.exit(0);
}

const SESSION = path.join(process.env.LOCALAPPDATA || '', 'TypoZen_Cache', 'tabs_session.txt');
let restoreSession = null;
try { restoreSession = fs.readFileSync(SESSION, 'utf8'); } catch (e) {}
function putSessionBack() {
    try {
        if (restoreSession !== null) fs.writeFileSync(SESSION, restoreSession);
        else fs.unlinkSync(SESSION);
    } catch (e) {}
}

/** [{ name, dirty }] for every tab the session recorded. */
function sessionTabs() {
    let text = '';
    try { text = fs.readFileSync(SESSION, 'utf8'); } catch (e) { return []; }
    const out = [];
    let name = null;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('path=')) {
            const p = line.slice(5);
            name = p ? p.split(String.fromCharCode(92)).pop() : '(untitled)';
        } else if (line.startsWith('dirty=') && name !== null) {
            out.push({ name: name, dirty: line.slice(6) === '1' });
            name = null;
        }
    }
    return out;
}

console.log('\n=== a clean Markdown document, left clean ===');
let app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(4000);
    await settledApp(app, 20000);
} finally {
    await app.close();
}
await sleep(1500);
const before = sessionTabs();
info('after editing nothing: ' + JSON.stringify(before.map(t => t.name + '=' + (t.dirty ? 1 : 0))));
assert(before.length > 0 && before.every(t => !t.dirty),
    'nothing is marked unsaved when nothing was edited');

console.log('\n=== then a book is opened over it ===');
// The shape ZenSeek launches with: the book as the argument, plus a search to jump to.
app = await launchApp({
    file: path.join('tests', book),
    args: ['--reader', '--search', 'princess']
});
try {
    await sleep(13000);
    await settledApp(app, 30000);
    const page = await app.eval(() => ({
        kind: DocumentModel.kind,
        dirtyByPage: getMarkdownContent(false) !== state.lastSavedContent
    }));
    info('page holds a ' + page.kind + ', dirty by its own reckoning: ' + page.dirtyByPage);
    assert(page.kind === 'epub', 'the book is what opened');
    assert(!page.dirtyByPage, 'and the page does not consider it edited');
} finally {
    await app.close();
}
await sleep(1500);

const after = sessionTabs();
info('after opening the book: ' + JSON.stringify(after.map(t => t.name + '=' + (t.dirty ? 1 : 0))));
const wrongly = after.filter(t => t.dirty);
assert(wrongly.length === 0,
    'no tab is marked unsaved by a document being opened over it (' +
    JSON.stringify(wrongly.map(t => t.name)) + ')');

putSessionBack();

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'NO FALSE DIRTY FAILED' : 'NO FALSE DIRTY PASSED');
process.exit(failed ? 1 : 0);
