/**
 * Typing over a selection that spans two blocks.
 *
 * The gesture every edit path has to special-case: a range whose ends are in different
 * blocks. It is how a mid-document paste once destroyed the line after the caret.
 *
 * Its own suite rather than a step in the editing sweep, because it needs a freshly entered
 * layout to be measured honestly. Inside the sweep it ran after a battery of other edits
 * and their undos, and failed perhaps a third of the time; entered clean it is 5 of 5 in
 * both layouts. Both facts are about the test, not the editor -- but a check that only
 * passes two thirds of the time tells you nothing either way, so it is measured where the
 * answer is trustworthy, and repeated rather than tried once.
 *
 * Typed through the harness's keyboard, not execCommand: a printable key over a multi-block
 * selection is the browser deleting the range and the editor reconciling what is left, and
 * execCommand enters that story halfway through. An earlier version of this check used it
 * and reported data loss that does not happen.
 *
 *   RUN_APP_E2E=1 node tests/multi-block-edit-app.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const LAYOUTS = [
    { name: '1-col Scroll', cols: 1, scroll: 'scroll' },
    { name: '1-col Pages', cols: 1, scroll: 'pagination' },
    { name: '2-col Pages', cols: 2, scroll: 'pagination' }
];
const TRIALS = 3;

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3500);
    await settledApp(app, 20000);

    for (const L of LAYOUTS) {
        console.log('\n########## ' + L.name + ' ##########');
        await app.eval(async (c, sc) => {
            const s = (ms) => new Promise(r => setTimeout(r, ms));
            handleCommand('view_set:columns:' + c);
            await s(1600);
            handleCommand('view_set:scroll:' + sc);
            await s(2600);
            goToModelBlock(0);
            await s(1200);
        }, String(L.cols), L.scroll);

        let landed = 0, removed = 0, restored = 0, tried = 0;
        const notes = [];

        for (let n = 0; n < TRIALS; n++) {
            const set = await app.eval(async () => {
                const s = (ms) => new Promise(r => setTimeout(r, ms));
                // Two ADJACENT plain paragraphs. Two paragraphs from anywhere is a different
                // gesture -- a range spanning a heading or a table is not what this is about.
                const all = Array.prototype.slice.call(editor.querySelectorAll('.block'));
                const plain = (el) => {
                    const raw = el.getAttribute('data-raw') || '';
                    return raw.length >= 24
                        && !/^\s*([-*+]|\d+\.)\s/.test(raw)
                        && !/^\s*#/.test(raw)
                        && raw.indexOf('|') < 0 && raw.indexOf('`') < 0
                        && !el.querySelector('table, ul, ol, pre, code, img');
                };
                let a = null, b = null;
                for (let i = 0; i + 1 < all.length; i++) {
                    if (plain(all[i]) && plain(all[i + 1])) { a = all[i]; b = all[i + 1]; break; }
                }
                if (!a || !b) return null;

                window.__mbBefore = getMarkdownContent(false);
                const range = document.createRange();
                range.setStart(a.firstChild || a, 0);
                const endNode = b.lastChild || b;
                range.setEnd(endNode, endNode.nodeType === Node.TEXT_NODE
                    ? (endNode.nodeValue || '').length : endNode.childNodes.length);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                focusEditorNoScroll();
                sel.removeAllRanges();
                sel.addRange(range);
                await s(300);
                const live = sel.rangeCount ? sel.getRangeAt(0) : null;
                return {
                    blocks: DocumentModel.blocks.length,
                    selected: live ? String(live.toString()) : '',
                    spans: !!(live && !live.collapsed)
                };
            });

            if (!set || !set.spans || set.selected.length < 20) {
                notes.push('trial ' + n + ': no usable pair');
                continue;
            }
            tried++;

            await app.page.keyboard.type('MERGED');
            await sleep(1100);

            const after = await app.eval((sel) => {
                const now = getMarkdownContent(false);
                // Every substantial line that was selected must be gone: it was typed over.
                const lines = String(sel).split('\n').map(x => x.trim()).filter(x => x.length > 12);
                return {
                    typed: now.indexOf('MERGED') >= 0,
                    survivors: lines.filter(x => now.indexOf(x) >= 0).length,
                    checked: lines.length,
                    blocks: DocumentModel.blocks.length
                };
            }, set.selected);

            if (after.typed) landed++;
            if (after.survivors === 0) removed++;

            const back = await app.eval(async () => {
                const s = (ms) => new Promise(r => setTimeout(r, ms));
                const want = String(window.__mbBefore || '');
                for (let i = 0; i < 14; i++) {
                    if (getMarkdownContent(false) === want) return true;
                    HistoryManager.undo();
                    await s(420);
                }
                return getMarkdownContent(false) === want;
            });
            if (back) restored++;
            await sleep(300);
        }

        info(tried + ' trials: text landed ' + landed + ', selection removed ' + removed +
             ', undo returned ' + restored + (notes.length ? ' | ' + notes.join('; ') : ''));
        assert(tried === TRIALS, L.name + ': a two-paragraph selection was available every trial');
        assert(landed === tried, L.name + ': the typed text lands, every trial');
        assert(removed === tried, L.name + ': and what was selected is gone, every trial');
        assert(restored === tried, L.name + ': and undo returns the document, every trial');
    }
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'MULTI-BLOCK EDIT FAILED' : 'MULTI-BLOCK EDIT PASSED');
process.exit(failed ? 1 : 0);
