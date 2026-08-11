/**
 * Highlights, notes, and the popover they are reached from.
 *
 * The one invariant worth stating up front: **annotating must not touch the document**. A
 * .block is a projection of one model row and its content round-trips into data-raw on
 * every edit, so a <mark> wrapped round the words would become part of the file the moment
 * anything serialised. Highlights are painted with the CSS Custom Highlight API instead,
 * and that is asserted directly rather than assumed.
 *
 * The popover's own history is here too: it took its background from --surface, a 5%
 * translucent wash that is right for the sidebar and left this unreadable over text; and
 * releasing the mouse over Define fired the document mouseup that raises it, which cleared
 * the result body ten milliseconds after the answer arrived. Both are checked by driving
 * real mouse events, because both were invisible to a test that called the functions.
 *
 *   RUN_APP_E2E=1 node tests/annotations-app.mjs
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

/** Select a run of characters inside one block, the way dragging does.
 *  `from`/`to` are offsets into the first text node long enough to hold them. */
const selectWords = (needle, from, to) => {
    const el = [...document.querySelectorAll('#editor .block[data-model-index]')]
        .find(b => new RegExp(needle).test(b.textContent || ''));
    if (!el) return null;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let tn = null;
    while (w.nextNode()) { if (w.currentNode.nodeValue.length >= to + 2) { tn = w.currentNode; break; } }
    if (!tn) return null;
    const r = document.createRange();
    r.setStart(tn, from); r.setEnd(tn, to);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { block: parseInt(el.getAttribute('data-model-index'), 10), text: r.toString() };
};

/** Press a popover button with the full mouse sequence a person produces. */
const pressPopBtn = (id) => {
    const b = document.getElementById(id);
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 };
    b.dispatchEvent(new MouseEvent('mousedown', o));
    b.dispatchEvent(new MouseEvent('mouseup', o));
    b.click();
};

let app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
let made = null;
try {
    await app.eval(() => { _marks = []; persistMarks(); switchTab('marks'); });
    await sleep(500);

    console.log('\n=== the popover is readable over the text it floats on ===');
    const look = await app.eval(async (sel) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        eval('window.__sel = ' + sel);
        goToModelBlock(600); await sleep(900);
        // A single word: Define is offered for a word, and correctly hidden for a run of
        // digits and punctuation, so the popover check has to select one.
        const el = [...document.querySelectorAll('#editor .block[data-model-index]')]
            .find(b => /scroll marker/.test(b.textContent || ''));
        // A TreeWalker, not firstChild: a block's text is routinely nested inside a
        // <strong> or an <a>, so the first child is often an element.
        const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let t = null;
        while (tw.nextNode()) { if (/scroll/.test(tw.currentNode.nodeValue)) { t = tw.currentNode; break; } }
        const at = t.nodeValue.indexOf('scroll');
        const rg = document.createRange(); rg.setStart(t, at); rg.setEnd(t, at + 6);
        const sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(rg);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await sleep(400);
        const pop = document.getElementById('selPop');
        const cs = getComputedStyle(pop);
        return { shown: !pop.hidden, bg: cs.backgroundColor, img: cs.backgroundImage };
    }, selectWords.toString());
    info('background ' + look.bg);
    assert(look.shown, 'selecting text raises the popover');
    const alpha = (/rgba\([^)]*,\s*([\d.]+)\)/.exec(look.bg) || [, '1'])[1];
    assert(parseFloat(alpha) === 1,
        'its background is opaque, so the document does not read through it');
    assert(/gradient/.test(look.img), 'while keeping the surface tint that lifts it');

    console.log('\n=== Define answers, and the answer survives the click ===');
    const define = await app.eval(async (press) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        eval('window.__press = ' + press);
        window.__press('selPopDefine');
        await sleep(1200);            // well past the 10ms timer that used to wipe it
        const pop = document.getElementById('selPop');
        const body = document.getElementById('selPopBody');
        // The whole body: a real WordNet entry runs to several hundred characters, and a
        // window of 120 cut off the occurrence line that follows it.
        return { open: !pop.hidden, shown: !body.hidden, text: (body.textContent || '') };
    }, pressPopBtn.toString());
    info('body: ' + JSON.stringify(define.text.slice(0, 150)) + '…');
    assert(define.open && define.shown,
        'the result outlives the click that asked for it');
    assert(define.text.length > 20, 'and says something');
    assert(/Appears [\d,]+ times/.test(define.text) || /installed/.test(define.text),
        'occurrence count or the setup hint is there, dictionary or not');

    console.log('\n=== highlighting a selection never touches the document ===');
    made = await app.eval(async (sel) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        eval('window.__sel = ' + sel);
        const picked = window.__sel('scroll marker', 4, 24);
        await sleep(400);
        const rawBefore = DocumentModel.blocks[picked.block].raw;
        const label = document.getElementById('markAddBtn').lastElementChild.textContent;
        annotateSelection();
        await sleep(500);
        const m = _marks[0];
        return {
            picked, label, rawBefore,
            rawAfter: DocumentModel.blocks[picked.block].raw,
            mark: { block: m.block, s: m.s, e: m.e, name: m.name },
            injected: document.querySelectorAll('#editor mark, #editor .tz-annot').length,
            painted: (window.CSS && CSS.highlights && CSS.highlights.get('typozen-mark'))
                ? CSS.highlights.get('typozen-mark').size : 0
        };
    }, selectWords.toString());
    info('quoted ' + JSON.stringify(made.picked.text) + ' at ' + made.mark.s + '..' + made.mark.e);
    assert(made.label === 'Highlight selection',
        'the Mark button offers to highlight while text is selected');
    assert(made.mark.e > made.mark.s, 'the mark carries a range');
    assert(made.rawAfter === made.rawBefore,
        "the block's raw markdown is byte-identical afterwards");
    assert(made.injected === 0, 'and nothing was inserted into the editor DOM');
    assert(made.painted === 1, 'it is painted as a custom highlight instead');

    console.log('\n=== a note is the reader\'s, the quotation is not ===');
    const noted = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        switchTab('marks'); await sleep(400);
        const row = document.querySelector('#marks-list .mark-item');
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await sleep(250);
        // Whatever the handler put the caret in -- for a highlight that is the note line,
        // for a bookmark the name. Guessing at the selector instead is how the first
        // version of this edited a different element and reported a bug that was not there.
        const el = document.activeElement;
        const editable = el && el.getAttribute
            && el.getAttribute('contenteditable') !== null;
        el.textContent = 'check this against the appendix';
        el.blur(); await sleep(400);
        return { note: _marks[0].note, name: _marks[0].name,
                 editedClass: el.className, wasEditable: editable };
    });
    info('edited .' + noted.editedClass + ' (editable: ' + noted.wasEditable + ')');
    assert(noted.wasEditable, 'double-click makes a field editable');
    assert(noted.note === 'check this against the appendix', 'the note is written');
    assert(noted.name === made.mark.name, 'and the quoted words are left alone');
} finally { await app.close(); }

console.log('\n=== and all of it comes back next launch ===');
app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 7000 });
try {
    const back = await app.eval(async (block) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(block); await sleep(1400);
        const m = _marks[0];
        return {
            n: _marks.length,
            mark: m ? { block: m.block, s: m.s, e: m.e, note: m.note } : null,
            painted: (window.CSS && CSS.highlights && CSS.highlights.get('typozen-mark'))
                ? CSS.highlights.get('typozen-mark').size : 0
        };
    }, made.mark.block);
    info('restored ' + JSON.stringify(back.mark));
    assert(back.n === 1 && back.mark && back.mark.e > back.mark.s,
        'the annotation survived the restart');
    assert(back.mark.s === made.mark.s && back.mark.e === made.mark.e,
        'with the same offsets');
    assert(back.mark.note === 'check this against the appendix', 'and its note');
    assert(back.painted === 1, 'and it is painted again');
} finally {
    await app.close();
    putBack();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'ANNOTATIONS FAILED' : 'ANNOTATIONS PASSED');
process.exit(failed ? 1 : 0);
