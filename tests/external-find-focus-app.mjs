/**
 * A search arriving from ZenSeek leaves focus somewhere the step keys work.
 *
 * Reported from real use: opening a book from ZenSeek put the caret in the sidebar's search
 * box with the query selected, so ',' and '.' typed punctuation into it instead of moving
 * between matches. Nobody is about to retype a query that was just handed over.
 *
 * Two faults, and both are checked here:
 *   - the hand-off focused the search input on purpose
 *   - the idle hand-off to the results list was armed only from the input's own `input`
 *     event, so focus placed programmatically was never scheduled to move on and sat there
 *
 *   RUN_APP_E2E=1 node tests/external-find-focus-app.mjs
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
    console.log('EXTERNAL FIND FOCUS SKIPPED');
    process.exit(0);
}

/** Where the keyboard is, in terms that mean something. */
const focusWhere = () => {
    const a = document.activeElement;
    if (!a) return 'nothing';
    if (a.id === 'sidebarSearchInput') return 'search box';
    if (a.id === 'findInput') return 'find bar';
    if (a.id === 'search-results-list') return 'results list';
    if (a === editor || (editor && editor.contains(a))) return 'document';
    return a.id || a.tagName;
};

// Exactly what ZenSeek runs: the book, Reader, and a query to land on.
const app = await launchApp({
    file: path.join('tests', book),
    args: ['--reader', '--search', 'princess']
});
try {
    await sleep(14000);
    await settledApp(app, 30000);

    const landed = await app.eval(function () {
        return {
            where: (function () {
                const a = document.activeElement;
                if (!a) return 'nothing';
                if (a.id === 'sidebarSearchInput') return 'search box';
                if (a.id === 'findInput') return 'find bar';
                if (a.id === 'search-results-list') return 'results list';
                if (a === editor || (editor && editor.contains(a))) return 'document';
                return a.id || a.tagName;
            })(),
            matches: findState.matches.length,
            index: findState.index,
            kind: DocumentModel.kind
        };
    });
    info('after the hand-off: focus in the ' + landed.where + ', ' +
         landed.matches + ' matches, on ' + landed.index);
    assert(landed.matches > 1, 'the search ran and found the word');
    assert(landed.where !== 'search box',
        'focus is not left in the search box (' + landed.where + ')');

    // The point of not being in the box: the step keys have to work immediately.
    const stepped = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const before = findState.index;
        const boxWas = (document.getElementById('sidebarSearchInput') || {}).value;
        const target = document.activeElement || editor;
        for (const k of ['.', '.']) {
            target.dispatchEvent(new KeyboardEvent('keydown',
                { key: k, bubbles: true, cancelable: true }));
            await sleep(400);
        }
        return {
            before: before,
            after: findState.index,
            boxWas: boxWas,
            boxNow: (document.getElementById('sidebarSearchInput') || {}).value
        };
    });
    info("'.' twice: match " + stepped.before + ' -> ' + stepped.after +
         ', query ' + JSON.stringify(stepped.boxNow));
    assert(stepped.after === stepped.before + 2,
        "'.' steps to the next match straight after the hand-off (" +
        stepped.before + ' -> ' + stepped.after + ')');
    assert(stepped.boxNow === stepped.boxWas,
        'and does not type into the query (' + JSON.stringify(stepped.boxNow) + ')');

    // Second fault: focus placed in the box by hand must not stay there for ever.
    const idle = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        focusSidebarSearchInput(true);
        await sleep(600);
        const immediately = document.activeElement && document.activeElement.id;
        await sleep(4200);          // SIDEBAR_SEARCH_IDLE_MS is 3000
        const later = document.activeElement && document.activeElement.id;
        return { immediately: immediately, later: later };
    });
    info('focused the box by hand: ' + idle.immediately + ' -> ' + idle.later + ' after 4s');
    assert(idle.immediately === 'sidebarSearchInput', 'Alt+S still puts the caret in the box');
    assert(idle.later !== 'sidebarSearchInput',
        'and it hands off once typing stops, rather than sitting there (' + idle.later + ')');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'EXTERNAL FIND FOCUS FAILED' : 'EXTERNAL FIND FOCUS PASSED');
process.exit(failed ? 1 : 0);
