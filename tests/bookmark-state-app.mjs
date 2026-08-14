/**
 * The Mark button describes what it will do, wherever the reader is.
 *
 * Reported from the running app: the toolbar read "Marked" hundreds of lines away from any
 * mark, and clicking either it or "Remove this mark" added a ninth mark instead of removing
 * one. Two causes, and the pair is what made it look like a fake control.
 *
 *   1. Nothing recomputed the state when the reader moved. renderMarks ran when the list
 *      changed or the pane opened, so the label was a snapshot of wherever the last mark
 *      had been set and stayed there.
 *   2. The label and the action asked about different blocks. The label asked whether
 *      currentReadingBlock() was marked; the action snapped that block to one with ink
 *      first. Where the top of the viewport is a blank line -- which in Markdown is every
 *      other block -- those are not the same question.
 *
 * So the assertions are that the label tracks position, and that pressing the button does
 * what the label says. The second is the one that matters: a control that lies is worse
 * than one that is merely slow.
 *
 *   RUN_APP_E2E=1 node tests/bookmark-state-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { launchApp, sleep, profileFile } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const STORE = profileFile('bookmarks.txt');
let restore = null;
try { restore = fs.readFileSync(STORE, 'utf8'); } catch (e) {}
function putBack() {
    try {
        if (restore !== null) fs.writeFileSync(STORE, restore);
        else fs.unlinkSync(STORE);
    } catch (e) {}
}

/** What the button says, and what the model says is true — read together. */
const label = () => {
    const btn = document.getElementById('markAddBtn');
    const here = markTargetBlock();
    return {
        says: btn.lastElementChild.textContent,
        lit: btn.classList.contains('on'),
        here,
        reallyMarked: here >= 0 && markIndexAtBlock(here) >= 0,
        count: _marks.length
    };
};

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    await app.eval(() => { _marks = []; persistMarks(); switchTab('marks'); });
    await sleep(600);

    console.log('\n=== on a marked block, it offers to remove ===');
    let s = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(300); await sleep(1000);
        toggleMarkAtBlock(markTargetBlock()); await sleep(400);
        const btn = document.getElementById('markAddBtn');
        const here = markTargetBlock();
        return { says: btn.lastElementChild.textContent, lit: btn.classList.contains('on'),
                 here, reallyMarked: here >= 0 && markIndexAtBlock(here) >= 0, count: _marks.length };
    });
    info('at block ' + s.here + ': "' + s.says + '", lit ' + s.lit + ', marks ' + s.count);
    assert(s.count === 1, 'one mark exists');
    assert(s.says === 'Remove this mark' && s.lit, 'the button offers to remove it');
    assert(s.reallyMarked, 'and the block really is marked');

    console.log('\n=== walk far away, and it stops claiming to be marked ===');
    s = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(2400);
        // The state follows a scroll, so let the debounce run as it would for a reader.
        document.getElementById('main-container').dispatchEvent(new Event('scroll'));
        await sleep(1400);
        const btn = document.getElementById('markAddBtn');
        const here = markTargetBlock();
        return { says: btn.lastElementChild.textContent, lit: btn.classList.contains('on'),
                 here, reallyMarked: here >= 0 && markIndexAtBlock(here) >= 0, count: _marks.length };
    });
    info('now at block ' + s.here + ': "' + s.says + '", lit ' + s.lit);
    assert(!s.reallyMarked, 'this block is genuinely not marked');
    assert(s.says === 'Mark this page' && !s.lit,
        'so the button says so — this is the "Marked stays even when nowhere near it" report');

    console.log('\n=== and pressing it does what it says ===');
    // The heart of it: the label and the action must agree. Press, and check the count
    // moved the way the label promised.
    const act = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const btn = document.getElementById('markAddBtn');
        const said = btn.lastElementChild.textContent;
        const before = _marks.length;
        btn.click(); await sleep(500);
        const after = _marks.length;
        const saidAgain = btn.lastElementChild.textContent;
        return { said, before, after, saidAgain };
    });
    info('said "' + act.said + '": ' + act.before + ' → ' + act.after +
         ' marks, now says "' + act.saidAgain + '"');
    assert(act.after === act.before + 1, 'saying "Mark this page" added one');
    assert(act.saidAgain === 'Remove this mark', 'and it now offers the opposite');

    const undo = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const btn = document.getElementById('markAddBtn');
        const said = btn.lastElementChild.textContent;
        const before = _marks.length;
        btn.click(); await sleep(500);
        return { said, before, after: _marks.length };
    });
    info('said "' + undo.said + '": ' + undo.before + ' → ' + undo.after + ' marks');
    assert(undo.after === undo.before - 1,
        'saying "Remove this mark" removed one, rather than adding a ninth');

    console.log('\n=== the same holds on a blank line, which is every other block ===');
    // The label used to ask about the raw block and the action about the snapped one.
    const blank = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Find a blank block and put the reader on it.
        const i = DocumentModel.blocks.findIndex((b, n) => n > 100 && !(b.raw || '').trim());
        goToModelBlock(i);
        document.getElementById('main-container').dispatchEvent(new Event('scroll'));
        await sleep(1400);
        const btn = document.getElementById('markAddBtn');
        const target = markTargetBlock();
        const said = btn.lastElementChild.textContent;
        const before = _marks.length;
        btn.click(); await sleep(500);
        const said2 = btn.lastElementChild.textContent;
        const before2 = _marks.length;
        btn.click(); await sleep(500);
        return { blankAt: i, target, said, before, mid: before2, said2, after: _marks.length };
    });
    info('reader on blank block ' + blank.blankAt + ', target snaps to ' + blank.target);
    info('"' + blank.said + '" → ' + blank.mid + ', then "' + blank.said2 + '" → ' + blank.after);
    assert(blank.target !== blank.blankAt, 'the target snapped off the blank line');
    assert(blank.mid === blank.before + 1 && blank.after === blank.before,
        'add then remove returns to where it started, rather than adding twice');
} finally {
    await app.close();
    putBack();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'BOOKMARK STATE FAILED' : 'BOOKMARK STATE PASSED');
process.exit(failed ? 1 : 0);
