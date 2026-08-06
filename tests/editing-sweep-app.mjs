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
 *   - typing over a selection replaces it rather than appending to it
 *   - Enter splits, Backspace at the start of a block joins, Tab indents a list item
 *   - Enter at the end of a bullet continues the list
 *   - undo returns the document exactly, and redo puts the edit back
 *   - none of it throws
 *   - none of it takes long enough to feel broken
 *
 * Every operation is undone back to the starting document before the next one runs, and
 * that return is itself asserted. A sweep whose steps accumulate would report the first
 * failure and then a cascade of consequences, which is not a survey of anything.
 *
 * Keys are dispatched as real KeyboardEvents rather than driven through execCommand: Enter,
 * Backspace and Tab are all handled by the editor's own listeners, and calling the command
 * underneath them tests a path no keyboard reaches.
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
            const out = { notes: [] };
            const norm = (x) => String(x).replace(/\r\n/g, '\n').replace(/\s+$/gm, '').trim();
            const before = getMarkdownContent(false);
            const beforeNorm = norm(before);
            out.beforeLen = before.length;

            const key = (k, opts) => {
                const ev = new KeyboardEvent('keydown', Object.assign(
                    { key: k, bubbles: true, cancelable: true }, opts || {}));
                editor.dispatchEvent(ev);
                return ev;
            };
            // Undo until the document is back, rather than a fixed number of times: one
            // gesture is not reliably one history entry, and a sweep that assumed it would
            // start each operation from a document it had not checked.
            const rewind = async (steps) => {
                let back = false;
                for (let i = 0; i < (steps || 8); i++) {
                    if (norm(getMarkdownContent(false)) === beforeNorm) { back = true; break; }
                    HistoryManager.undo();
                    await sleep(450);
                }
                if (!back) back = norm(getMarkdownContent(false)) === beforeNorm;

                // Back to the same *state*, not just the same text.
                //
                // Every step here starts by finding a block and putting a caret or a range
                // in it, and each one used to inherit whatever the previous step left
                // behind: a stale selection, focus somewhere else, and a mounted window
                // that had moved. That is where this suite's intermittency lived once the
                // block-picking was fixed -- the gestures themselves measure 30/30 and 5/5
                // in isolation, in every layout.
                try { window.getSelection().removeAllRanges(); } catch (eSel) {}
                goToModelBlock(0);
                await sleep(700);
                return back;
            };
            const blockEls = () => editor.querySelectorAll('.block');
            const pick = (i) => blockEls()[Math.min(i, blockEls().length - 1)];

            /**
             * Plain paragraphs, found by what they are rather than where they sit.
             *
             * Picking by position was this suite's whole intermittency. blockEls()[25] is a
             * paragraph in one layout, a blank line in another and a table row in a third,
             * because the mounted window does not begin in the same place every time.
             * Measured directly in 1-col Pages: index 24 was a table, 25 was empty, 26 was a
             * paragraph. Selecting five characters inside a table cell and typing over them
             * goes through the table serialiser, which is exactly how "typing over a
             * 5-character selection" reported +1 instead of -4 on some runs.
             *
             * @returns {HTMLElement[]} mounted paragraphs, in order
             */
            const paragraphs = () => {
                const out = [];
                for (const el of blockEls()) {
                    const raw = el.getAttribute('data-raw') || '';
                    if (raw.length < 24) continue;                    // blank or too short
                    if (/^\s*([-*+]|\d+\.)\s/.test(raw)) continue;    // a list item
                    if (/^\s*#/.test(raw)) continue;                  // a heading
                    if (raw.indexOf('|') >= 0) continue;              // a table row
                    if (raw.indexOf('`') >= 0) continue;              // code
                    if (raw.indexOf('!') === 0 || raw.indexOf('>') === 0) continue;
                    if (el.querySelector('table, ul, ol, pre, code, img')) continue;
                    out.push(el);
                }
                return out;
            };
            /** The first text node with something in it, however the block wraps its text. */
            const textNodeOf = (el) => {
                if (!el) return null;
                const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
                let n;
                while ((n = walk.nextNode())) {
                    if (n.textContent && n.textContent.length >= 8) return n;
                }
                return null;
            };

            // From the top, so every layout edits the same blocks. Documents reopen where
            // they were last read now, which means the mounted window -- and therefore
            // which paragraph pick(25) lands on -- depends on whatever the previous run of
            // anything left behind.
            goToModelBlock(0);
            await sleep(900);

            // Park on a real block a way into the mounted set.
            const el = paragraphs()[2] || pick(25);
            const raw0 = el.getAttribute('data-raw') || '';
            out.pickedRaw = raw0.slice(0, 40);
            out.pickedIndex = el.getAttribute('data-model-index');
            out.mounted = blockEls().length;
            focusBlock(el, (el.innerText || '').length);
            await sleep(250);

            // --- typing ---
            let t = performance.now();
            for (const ch of 'ZZTOP') document.execCommand('insertText', false, ch);
            await sleep(400);
            out.typeMs = Math.round(performance.now() - t);
            const after = getMarkdownContent(false);
            out.afterLen = after.length;
            out.typedLanded = after.indexOf(raw0 + 'ZZTOP') >= 0;
            out.grewByFive = (after.length - before.length) === 5;

            // --- Enter splits ---
            const blocksBeforeEnter = DocumentModel.blocks.length;
            t = performance.now();
            key('Enter');
            await sleep(500);
            out.enterMs = Math.round(performance.now() - t);
            out.stackAfterEdits = 'undo=' + HistoryManager.undoStack.length;
            out.blocksAfterEnter = DocumentModel.blocks.length;
            out.enterSplit = DocumentModel.blocks.length === blocksBeforeEnter + 1;

            // --- undo returns the document exactly ---
            out.undoExact = await rewind(10);
            out.undoLen = getMarkdownContent(false).length;
            if (!out.undoExact) {
                out.stacks = 'undo=' + HistoryManager.undoStack.length +
                    ' redo=' + HistoryManager.redoStack.length;
                const now = norm(getMarkdownContent(false));
                let i = 0;
                while (i < now.length && i < beforeNorm.length && now[i] === beforeNorm[i]) i++;
                out.diffAt = i;
                out.diffGot = JSON.stringify(now.slice(Math.max(0, i - 40), i + 60));
                out.diffWant = JSON.stringify(beforeNorm.slice(Math.max(0, i - 40), i + 60));
                out.diffLen = now.length + ' vs ' + beforeNorm.length;
            }

            // --- redo puts the edit back ---
            HistoryManager.redo();
            await sleep(600);
            out.redoChanged = norm(getMarkdownContent(false)) !== beforeNorm;
            out.redoBackOut = await rewind(10);

            // --- typing over a selection replaces it ---
            {
                const b = paragraphs()[2] || pick(25);
                const tn = textNodeOf(b);
                if (tn && tn.nodeType === 3 && tn.textContent.length > 6) {
                    const rg = document.createRange();
                    rg.setStart(tn, 0);
                    rg.setEnd(tn, 5);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(rg);
                    await sleep(250);
                    const lenBefore = getMarkdownContent(false).length;
                    document.execCommand('insertText', false, 'Q');
                    await sleep(450);
                    // Five characters out, one in.
                    out.selReplaceDelta = getMarkdownContent(false).length - lenBefore;
                    out.selReplaced = out.selReplaceDelta === -4;
                    out.selRestored = await rewind(8);
                } else {
                    out.notes.push('no text node to select in block 25');
                    out.selReplaced = true; out.selRestored = true;
                }
            }

            // --- Backspace at the start of a block joins it to the one above ---
            {
                const ps = paragraphs();
                const b = ps[3] || ps[ps.length - 1] || pick(26);
                focusBlock(b, 0);
                await sleep(250);
                const n0 = DocumentModel.blocks.length;
                key('Backspace');
                await sleep(600);
                out.backspaceJoined = DocumentModel.blocks.length === n0 - 1;
                out.backspaceBlocks = DocumentModel.blocks.length + ' from ' + n0;
                out.backspaceRestored = await rewind(8);
            }

            // --- Enter at the end of a bullet continues the list ---
            {
                let bullet = null;
                for (const b of blockEls()) {
                    const raw = b.getAttribute('data-raw') || '';
                    if (/^\s*[-*+]\s+\S/.test(raw)) { bullet = b; break; }
                }
                if (bullet) {
                    focusBlock(bullet, (bullet.innerText || '').length);
                    await sleep(250);
                    const idx = DocumentModel.modelIndexOfEl(bullet);
                    key('Enter');
                    await sleep(600);
                    const next = DocumentModel.blocks[idx + 1];
                    const nextRaw = next ? String(next.raw) : '';
                    out.listContinued = /^\s*[-*+]\s*/.test(nextRaw);
                    out.listNextRaw = nextRaw.slice(0, 20);
                    out.listRestored = await rewind(8);
                } else {
                    out.notes.push('no bullet in the mounted set');
                    out.listContinued = true; out.listRestored = true;
                }
            }

            // --- Tab indents a list item ---
            {
                let bullet = null;
                for (const b of blockEls()) {
                    const raw = b.getAttribute('data-raw') || '';
                    if (/^[-*+]\s+\S/.test(raw)) { bullet = b; break; }
                }
                if (bullet) {
                    const idx = DocumentModel.modelIndexOfEl(bullet);
                    const rawWas = String(DocumentModel.blocks[idx].raw);
                    focusBlock(bullet, 1);
                    await sleep(250);
                    key('Tab');
                    await sleep(600);
                    const rawNow = String(DocumentModel.blocks[idx].raw);
                    out.tabIndented = rawNow.length > rawWas.length && /^\s+[-*+]/.test(rawNow);
                    out.tabRaw = rawNow.slice(0, 20);
                    out.tabRestored = await rewind(8);
                } else {
                    out.notes.push('no top-level bullet in the mounted set');
                    out.tabIndented = true; out.tabRestored = true;
                }
            }

            // --- find and replace, through the bar a user opens ---
            {
                const bar = document.getElementById('findBar');
                const input = document.getElementById('findInput');
                const repl = document.getElementById('replaceInput');
                const one = document.getElementById('findReplaceOne');
                const all = document.getElementById('findReplaceAll');
                // 35 occurrences: enough that Replace All is a real operation and few
                // enough that it does not dominate the sweep's runtime.
                const needle = 'blockquote';
                if (bar && input && repl && one && all &&
                    getMarkdownContent(false).indexOf(needle) >= 0) {
                    handleCommand('cmd:find');
                    await sleep(500);
                    input.value = needle;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    await sleep(1200);
                    const hits = findState.matches.length;
                    out.frHits = hits;

                    repl.value = 'BEACON';
                    one.click();
                    await sleep(900);
                    const afterOne = getMarkdownContent(false);
                    out.frOneDidOne = (afterOne.split('BEACON').length - 1) === 1;

                    all.click();
                    await sleep(2500);
                    const afterAll = getMarkdownContent(false);
                    out.frAllDidRest = afterAll.indexOf(needle) < 0 &&
                        (afterAll.split('BEACON').length - 1) === hits;
                    out.frCounts = hits + ' hits, ' +
                        (afterAll.split('BEACON').length - 1) + ' replaced';

                    try { closeFindBar(); } catch (eF) {}
                    await sleep(400);
                    out.frRestored = await rewind(18);
                } else {
                    out.notes.push('no find bar, or nothing to replace');
                    out.frOneDidOne = true; out.frAllDidRest = true; out.frRestored = true;
                }
            }

            // --- editing inside a table cell ---
            //
            // A table is one block whose raw is a pipe grid, so a keystroke in a cell has to
            // survive the DOM being turned back into that grid. Nothing else in this sweep
            // touches a block whose serializer is that particular.
            {
                let tableBlock = null;
                for (const b of blockEls()) {
                    if ((b.getAttribute('data-raw') || '').indexOf('|') >= 0 && b.querySelector('td')) {
                        tableBlock = b; break;
                    }
                }
                if (tableBlock) {
                    const idx = DocumentModel.modelIndexOfEl(tableBlock);
                    const cell = tableBlock.querySelector('td');
                    const rawWas = String(DocumentModel.blocks[idx].raw);
                    const pipesWas = (rawWas.match(/\|/g) || []).length;
                    setCaretAtOffset(cell, (cell.innerText || '').length);
                    await sleep(300);
                    document.execCommand('insertText', false, 'XQ');
                    await sleep(800);
                    const rawNow = String(DocumentModel.blocks[idx].raw);
                    out.tableTyped = rawNow.indexOf('XQ') >= 0;
                    out.tablePipes = pipesWas + ' -> ' + (rawNow.match(/\|/g) || []).length;
                    out.tableShape = (rawNow.match(/\|/g) || []).length === pipesWas;
                    out.tableRestored = await rewind(10);
                } else {
                    out.notes.push('no table in the mounted set');
                    out.tableTyped = true; out.tableShape = true; out.tableRestored = true;
                }
            }

            out.finalExact = norm(getMarkdownContent(false)) === beforeNorm;
            out.errors = (window.__sweepErrors || []).slice();
            return out;
        });

        info('typing ' + r.typeMs + 'ms for 5 chars, Enter ' + r.enterMs + 'ms');
        info('edited block ' + r.pickedIndex + ' of ' + r.mounted + ' mounted: ' +
             JSON.stringify(r.pickedRaw) + ', doc grew by ' + (r.afterLen - r.beforeLen));
        if (r.notes.length) info('skipped: ' + r.notes.join('; '));

        assert(r.typedLanded, L.name + ': typed text lands at the caret, in order');
        assert(r.grewByFive, L.name + ': typing 5 characters changes the document by exactly 5');
        assert(r.typeMs < 1500,
            L.name + ': typing 5 characters stays responsive (' + r.typeMs + 'ms)');

        assert(r.enterSplit,
            L.name + ': Enter splits the block in two (' + r.blocksAfterEnter + ' blocks)');
        assert(r.enterMs < 1500, L.name + ': Enter stays responsive (' + r.enterMs + 'ms)');

        if (!r.undoExact) {
            info('history: ' + r.stackAfterEdits + ' after edits, ' + r.stacks + ' after rewind');
            info('diverges at ' + r.diffAt + ', lengths ' + r.diffLen);
            info('  got  ' + r.diffGot);
            info('  want ' + r.diffWant);
        }
        assert(r.undoExact, L.name + ': undo returns the document exactly');
        assert(r.redoChanged, L.name + ': redo puts the undone edit back');
        assert(r.redoBackOut, L.name + ': and undoing again returns the document');

        assert(r.selReplaced,
            L.name + ': typing over a 5-character selection replaces it (' +
            r.selReplaceDelta + ' characters, wanted -4)');
        assert(r.selRestored, L.name + ': and undo returns the document');

        assert(r.backspaceJoined,
            L.name + ': Backspace at the start of a block joins it to the one above (' +
            r.backspaceBlocks + ')');
        assert(r.backspaceRestored, L.name + ': and undo returns the document');

        assert(r.listContinued,
            L.name + ': Enter at the end of a bullet continues the list (' +
            JSON.stringify(r.listNextRaw) + ')');
        assert(r.listRestored, L.name + ': and undo returns the document');

        assert(r.tabIndented,
            L.name + ': Tab indents a list item (' + JSON.stringify(r.tabRaw) + ')');
        assert(r.tabRestored, L.name + ': and undo returns the document');

        info('find/replace: ' + r.frCounts);
        assert(r.frOneDidOne, L.name + ': Replace changes exactly one match');
        assert(r.frAllDidRest, L.name + ': Replace All changes the rest');
        assert(r.frRestored, L.name + ': and undo returns the document');

        info('table cell pipes: ' + r.tablePipes);
        assert(r.tableTyped, L.name + ': typing in a table cell reaches the block');
        assert(r.tableShape, L.name + ': and the table keeps its shape');
        assert(r.tableRestored, L.name + ': and undo returns the document');

        assert(r.finalExact,
            L.name + ': the layout ends on the document it started with');
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
