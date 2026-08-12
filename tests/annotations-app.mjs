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

// view pinned: this suite drives selections and the Marks pane, both of which behave
// differently in Pages, and the app opens in whatever layout it was last left in.
let app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000, view: true });
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

    console.log('\n=== selecting a word answers, with nothing pressed ===');
    const define = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Ask, with the full mouse sequence a person produces. Selecting a word does not
        // look it up -- a word is selected to copy it at least as often as to ask about it
        // -- so the answer has to be requested. The wait afterwards is well past the 10ms
        // mouseup timer that used to wipe it.
        const b = document.getElementById('selPopLookup');
        const br = b.getBoundingClientRect();
        const o = { bubbles: true, clientX: br.left + 5, clientY: br.top + 5 };
        b.dispatchEvent(new MouseEvent('mousedown', o));
        b.dispatchEvent(new MouseEvent('mouseup', o));
        b.click();
        await sleep(1400);
        const pop = document.getElementById('selPop');
        const body = document.getElementById('selPopBody');
        // The whole body: a real WordNet entry runs to several hundred characters, and a
        // window of 120 cut off the occurrence line that follows it.
        return { open: !pop.hidden, shown: !body.hidden, text: (body.textContent || '') };
    });
    info('body: ' + JSON.stringify(define.text.slice(0, 150)) + '…');
    assert(define.open && define.shown, 'the answer appears and stays');
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

    console.log('\n=== pressing Highlight shows you where the highlight went ===');
    const revealed = await app.eval(async (sel) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Put the sidebar back where a reader who is reading keeps it, and on a tab that
        // is not Marks -- otherwise this proves nothing, because the pane was already
        // open on the right tab before the button was pressed.
        const sb = document.getElementById('sidebar');
        switchTab('outline', true);
        sb.classList.add('collapsed');
        await sleep(400);
        const before = {
            collapsed: sb.classList.contains('collapsed'),
            tab: (document.querySelector('.sidebar-tab.active') || {}).getAttribute
                ? document.querySelector('.sidebar-tab.active').getAttribute('data-tab') : null,
        };

        const keyOf = (m) => m.block + ':' + m.s + ':' + m.e;
        const had = _marks.map(keyOf);

        eval('window.__sel = ' + sel);
        // A long block, not a numbered marker row: selectWords needs a text node of at
        // least to+2 characters, and "Line 3 of 4582 - scroll marker row 3" is 36. The
        // offsets used to be 26..36 and silently selected NOTHING whenever the mounted
        // window happened to start near the top of the document, so the button was
        // pressed with no selection and the assertions blamed the button.
        window.__sel('long wrapping paragraph', 10, 40);
        await sleep(400);
        // The real control, with the real mouse sequence -- not annotateSelection().
        const b = document.getElementById('selPopMark');
        const br = b.getBoundingClientRect();
        const o = { bubbles: true, clientX: br.left + 5, clientY: br.top + 5 };
        b.dispatchEvent(new MouseEvent('mousedown', o));
        b.dispatchEvent(new MouseEvent('mouseup', o));
        b.click();
        await sleep(900);
        const activeTab = document.querySelector('.sidebar-tab.active');
        const added = _marks.findIndex(m => had.indexOf(keyOf(m)) < 0);
        const row = added >= 0
            ? document.querySelector('#marks-list .mark-item[data-mark="' + added + '"]')
            : null;
        const out = {
            before,
            collapsed: sb.classList.contains('collapsed'),
            tab: activeTab ? activeTab.getAttribute('data-tab') : null,
            rows: document.querySelectorAll('#marks-list .mark-item').length,
            popHidden: document.getElementById('selPop').hidden,
            addedIndex: added,
            rowIsListed: !!row,
            countBefore: had.length,
        };

        // Put the document back the way the rest of the suite expects to find it, using
        // the pane's own delete control rather than reaching into _marks -- the tests
        // after this one work on _marks[0] and the run at the end asserts exactly one
        // annotation survives a restart.
        if (row) {
            const del = row.querySelector('.mark-del');
            if (del) { del.click(); await sleep(500); }
        }
        out.countAfter = _marks.length;
        return out;
    }, selectWords.toString());
    info('sidebar ' + JSON.stringify(revealed.before) + ' -> collapsed=' +
        revealed.collapsed + ' tab=' + revealed.tab + ' rows=' + revealed.rows);
    assert(revealed.before.collapsed === true && revealed.before.tab !== 'marks',
        'control: the sidebar started shut, on another tab');
    assert(revealed.collapsed === false, 'pressing Highlight opens the sidebar');
    assert(revealed.tab === 'marks', 'on the Marks tab');
    assert(revealed.addedIndex >= 0 && revealed.rowIsListed,
        'with the new highlight listed in the pane');
    assert(revealed.popHidden === true, 'and the popover gets out of the way');
    assert(revealed.countAfter === revealed.countBefore,
        'housekeeping: the extra highlight was removed again');

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
app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 7000, view: true });
try {
    const back = await app.eval(async (block) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Generous: the launch now pins the view first, which is several relayouts, and
        // annotations repaint on a debounce after the block mounts. 1400ms read the
        // highlight set before it was repainted.
        goToModelBlock(block); await sleep(3000);
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
