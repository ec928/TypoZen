/**
 * The surfaces a bookmark is reached through, and the rule they all broke.
 *
 * Bookmarks are set from four places -- the gutter ribbon, the toolbar, the pane button and
 * the keyboard -- and every defect in them so far was the same shape: two things deciding
 * one answer. The button asked whether currentReadingBlock() was marked while the action
 * snapped that block to one with ink first, so it described one thing and did another. The
 * label was then computed in renderMarks and again in refreshMarkState, and only one of
 * them knew a selection turns it into Highlight; that lie came back within the hour.
 *
 * So the assertions here are deliberately not "the label is right". They are "pressing the
 * control does what the control said it would" -- which is the only property that catches
 * this class, and catches it wherever the second opinion is hiding.
 *
 *   RUN_APP_E2E=1 node tests/marks-surfaces-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const STORE = path.join(process.env.LOCALAPPDATA || '', 'TypoZen_Cache', 'bookmarks.txt');
let restore = null;
try { restore = fs.readFileSync(STORE, 'utf8'); } catch (e) {}
function putBack() {
    try {
        if (restore !== null) fs.writeFileSync(STORE, restore);
        else fs.unlinkSync(STORE);
    } catch (e) {}
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    await app.eval(() => { _marks = []; persistMarks(); switchTab('marks'); });
    await sleep(600);

    console.log('\n=== the control tells the truth, wherever the reader is ===');
    // The general form of every bug this feature has had. Press the button in several
    // states and check the count moved the way the label promised, rather than checking
    // the label against a second opinion computed the same way it was.
    const rounds = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const btn = document.getElementById('markAddBtn');
        const out = [];
        const press = async (where) => {
            const said = btn.lastElementChild.textContent;
            const before = _marks.length;
            btn.click();
            await sleep(500);
            out.push({ where, said, before, after: _marks.length });
        };
        // on a fresh block, on the same block again, and far away
        goToModelBlock(300); document.getElementById('main-container')
            .dispatchEvent(new Event('scroll')); await sleep(1300);
        await press('block 300');
        await press('block 300 again');
        goToModelBlock(1800); document.getElementById('main-container')
            .dispatchEvent(new Event('scroll')); await sleep(1300);
        await press('block 1800');
        // on a blank line, where the label and the action used to disagree
        const blank = DocumentModel.blocks.findIndex((b, n) => n > 500 && !(b.raw || '').trim());
        goToModelBlock(blank); document.getElementById('main-container')
            .dispatchEvent(new Event('scroll')); await sleep(1300);
        await press('a blank line (block ' + blank + ')');
        return out;
    });
    for (const r of rounds) {
        const expected = r.said === 'Remove this mark' ? r.before - 1 : r.before + 1;
        info(r.where + ': said "' + r.said + '", ' + r.before + ' -> ' + r.after);
        assert(r.after === expected,
            r.where + ': pressing it did what it said (' + r.said + ')');
    }

    console.log('\n=== the gutter marks the paragraph beside it, and only there ===');
    const gutter = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        _marks = []; persistMarks(); await sleep(200);
        goToModelBlock(400); await sleep(900);
        const el = [...document.querySelectorAll('#editor .block[data-model-index]')]
            .find(b => (b.textContent || '').trim().length > 20);
        const mi = parseInt(el.getAttribute('data-model-index'), 10);
        const r = el.getBoundingClientRect();
        const click = (x) => el.dispatchEvent(new MouseEvent('click',
            { bubbles: true, clientX: x, clientY: r.top + 6 }));
        click(r.left + 4);                       // in the ribbon strip
        await sleep(400);
        const afterGutter = { marks: _marks.map(m => m.block), ribbon: el.classList.contains('tz-marked') };
        const n = _marks.length;
        click(r.left + 140);                     // in the text
        await sleep(400);
        return { mi, afterGutter, afterText: _marks.length, wasN: n };
    });
    info('clicked the gutter of block ' + gutter.mi + ' -> ' + JSON.stringify(gutter.afterGutter.marks));
    assert(gutter.afterGutter.marks.includes(gutter.mi), 'the gutter marks that block');
    assert(gutter.afterGutter.ribbon, 'and the ribbon is painted on it');
    assert(gutter.afterText === gutter.wasN, 'a click in the text does not mark');

    console.log('\n=== a ribbon survives the block being unmounted and remounted ===');
    const remount = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const target = _marks[0].block;
        goToModelBlock(3200); await sleep(1200);   // far enough to unmount it
        const gone = !document.querySelector('[data-model-index="' + target + '"]');
        goToModelBlock(target); await sleep(1500);
        const el = document.querySelector('[data-model-index="' + target + '"]');
        return { target, gone, back: !!el, marked: el ? el.classList.contains('tz-marked') : false };
    });
    info('block ' + remount.target + ': unmounted=' + remount.gone + ', remounted=' + remount.back);
    assert(remount.back && remount.marked,
        'the ribbon is repainted when the block comes back');

    console.log('\n=== the scrubber shows marks only when there are marks ===');
    const ticks = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:scroll:pagination'); await sleep(2500);
        const host = document.getElementById('page-scrubber');
        const withMarks = (host.style.getPropertyValue('--tick-image') || '').length > 0;
        _marks = []; persistMarks(); renderMarks(); await sleep(400);
        const without = (host.style.getPropertyValue('--tick-image') || '').length > 0;
        handleCommand('view_set:scroll:scroll'); await sleep(1500);
        return { withMarks, without };
    });
    info('ticks with marks: ' + ticks.withMarks + ', with none: ' + ticks.without);
    assert(ticks.withMarks, 'ticks appear for a marked paginated document');
    assert(!ticks.without, 'and are cleared when the last mark goes');

    console.log('\n=== renaming writes the name, and emptying it asks for the text back ===');
    const rename = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(600); await sleep(900);
        toggleMarkAtBlock(markTargetBlock()); await sleep(400);
        switchTab('marks'); await sleep(400);
        const auto = _marks[0].name;
        // The row is re-queried every time, never held. renderMarks rebuilds the list, so
        // a reference taken before an edit is detached by the time of the next one -- the
        // same rule the engine states for createBlock, and the first version of this test
        // broke it and reported a product bug that was not there.
        const edit = async (text) => {
            const row = document.querySelector('#marks-list .mark-item');
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            await sleep(200);
            const el = document.querySelector('#marks-list .mark-item .mark-name');
            el.textContent = text;
            el.blur();
            await sleep(400);
        };
        await edit('my own words');
        const named = { name: _marks[0].name, flag: _marks[0].named };
        await edit('');
        return { auto, named, reverted: _marks[0].name, revertedFlag: _marks[0].named };
    });
    info('auto "' + rename.auto.slice(0, 34) + '" -> "' + rename.named.name +
         '" -> "' + rename.reverted.slice(0, 34) + '"');
    assert(rename.named.name === 'my own words' && rename.named.flag,
        'a rename sticks and is recorded as deliberate');
    assert(rename.reverted === rename.auto && !rename.revertedFlag,
        'emptying the name restores the text it was set on');
} finally {
    await app.close();
    putBack();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'MARKS SURFACES FAILED' : 'MARKS SURFACES PASSED');
process.exit(failed ? 1 : 0);
