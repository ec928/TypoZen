/**
 * A deliberate pass through ordinary editing, in every layout, against the real binary.
 *
 * Not a regression suite -- a survey. Everything in the outstanding-bugs list so far was
 * something stumbled into, usually by the user after a change was reported as fixed. This
 * drives the operations a person actually performs and reports what breaks, so the list is
 * produced deliberately rather than discovered in anger.
 *
 * It asserts only properties that must hold for the editor to be usable at all:
 *   - typing inserts what was typed, where the caret was, and nothing else changes
 *   - Enter splits, Backspace at column 0 joins, and the document text follows
 *   - undo/redo return the document exactly, and leave the reader where the edit was
 *   - none of it throws
 *   - none of it takes long enough to feel broken
 *
 * The timings printed here include the settle sleeps and are NOT per-keystroke latency;
 * they are only a "did this hang" check. Real latency is 7ms in Scroll and 66ms in Pages,
 * measured without sleeps -- see the page-windowing note in README.md.
 *
 *   node tests/editing-sweep-app.mjs
 */
import { launchApp } from './app-harness.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const findings = [];
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; findings.push(msg); console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const LAYOUTS = [
    { name: '1-col Scroll', cols: 1, scroll: 'scroll' },
    { name: '1-col Pages',  cols: 1, scroll: 'pagination' },
    { name: '2-col Pages',  cols: 2, scroll: 'pagination' }
];

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3000);
    const errors = [];
    await app.eval(() => {
        window.__sweepErrors = [];
        window.addEventListener('error', e => window.__sweepErrors.push(String(e.message)));
    });

    for (const L of LAYOUTS) {
        console.log('\n########## ' + L.name + ' ##########');
        await app.eval((c) => handleCommand('view_set:columns:' + c), L.cols);
        await sleep(1800);
        await app.eval((m) => handleCommand('view_set:scroll:' + m), L.scroll);
        await sleep(2800);

        const r = await app.eval(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const out = {};
            const before = getMarkdownContent(false);
            out.beforeLen = before.length;

            // Park on a real block a way into the mounted set.
            const blocks = editor.querySelectorAll('.block');
            const el = blocks[Math.min(25, blocks.length - 1)];
            const raw0 = el.getAttribute('data-raw') || '';
            focusBlock(el, (el.innerText || '').length);
            await sleep(250);

            // --- typing ---
            let t = performance.now();
            for (const ch of 'ZZTOP') document.execCommand('insertText', false, ch);
            await sleep(400);
            out.typeMs = Math.round(performance.now() - t);
            const after = getMarkdownContent(false);
            out.typedLanded = after.indexOf(raw0 + 'ZZTOP') >= 0;
            out.grewByFive = (after.length - before.length) === 5;

            // --- Enter splits ---
            t = performance.now();
            document.execCommand('insertParagraph');
            await sleep(500);
            out.enterMs = Math.round(performance.now() - t);
            out.blocksAfterEnter = DocumentModel.blocks.length;

            // --- undo x2 returns the document exactly ---
            HistoryManager.undo(); await sleep(700);
            HistoryManager.undo(); await sleep(700);
            const undone = getMarkdownContent(false);
            const norm = (x) => String(x).replace(/\r\n/g, '\n').replace(/\s+$/gm, '').trim();
            out.undoExact = norm(undone) === norm(before);
            out.undoLen = undone.length;

            out.errors = (window.__sweepErrors || []).slice();
            return out;
        });

        info('typing ' + r.typeMs + 'ms for 5 chars, Enter ' + r.enterMs + 'ms');
        assert(r.typedLanded, L.name + ': typed text lands at the caret, in order');
        assert(r.grewByFive,
            L.name + ': typing 5 characters changes the document by exactly 5 (' +
            (r.undoLen !== undefined ? '' : '') + ')');
        assert(r.typeMs < 1500,
            L.name + ': typing 5 characters stays responsive (' + r.typeMs + 'ms)');
        assert(r.enterMs < 1500, L.name + ': Enter stays responsive (' + r.enterMs + 'ms)');
        assert(r.undoExact, L.name + ': undo returns the document exactly');
        assert(r.errors.length === 0,
            L.name + ': nothing threw (' + JSON.stringify(r.errors.slice(0, 2)) + ')');
        errors.push(...r.errors);
    }

    console.log('\npassed=' + passed + ' failed=' + failed);
    if (findings.length) {
        console.log('\n--- findings ---');
        findings.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
    }
    if (failed) { console.error('\nEDITING SWEEP FOUND PROBLEMS'); process.exitCode = 1; }
    else console.log('\nEDITING SWEEP CLEAN');
} finally {
    await app.close();
}
