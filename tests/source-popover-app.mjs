/**
 * Look up and Find in document work in Source too.
 *
 * They did not, and nobody had decided that. A textarea's selection is not a DOM
 * Selection -- window.getSelection() reports collapsed inside one -- so showSelPop's
 * "is this inside #editor" check failed and the popover never appeared. Absence by
 * implementation detail rather than by judgement.
 *
 * Highlight is a different matter and stays out: it anchors to a block and Source has
 * no blocks. Hidden rather than shown-and-inert, which is the same courtesy the
 * format controls get on a book.
 *
 * The suite asserts what the buttons DO, not just that they are on screen. A popover
 * that appears and whose buttons act on an empty string would satisfy any weaker
 * check.
 *
 *   RUN_APP_E2E=1 node tests/source-popover-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

// Visible on screen, not merely flagged. `hidden` is an attribute; whether it hides
// anything depends on the CSS, and here it did not.
const VISIBLE = `window.isVisible = function (el) {
    if (!el) return false;
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
};`;

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 7000, view: true });
try {
    console.log('=== Preview still behaves as it did ===');
    await app.eval((src) => { eval(src); }, VISIBLE);
    const preview = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const b = [...document.querySelectorAll('#editor .block')]
            .find(x => /scroll marker/.test(x.textContent || ''));
        const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); tw.nextNode();
        const n = tw.currentNode;
        const at = n.nodeValue.indexOf('scroll');
        const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + 6);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        const box = r.getBoundingClientRect();
        document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, clientX: box.left + 2, clientY: box.top + 2 }));
        await sleep(500);
        return {
            shown: !document.getElementById('selPop').hidden,
            markShows: isVisible(document.getElementById('selPopMark')),
            lookupShows: isVisible(document.getElementById('selPopLookup')),
        };
    });
    assert(preview.shown, 'the popover still appears in Preview');
    assert(preview.markShows, 'and Highlight is still offered there');
    assert(preview.lookupShows, 'along with Look up');

    console.log('\n=== Source now offers the two that make sense ===');
    const source = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:mode:source');
        await sleep(2200);
        const ta = document.getElementById('source-editor');
        // A real word, so Look up has something to ask about.
        const idx = ta.value.indexOf('scroll');
        ta.focus();
        ta.setSelectionRange(idx, idx + 6);
        const box = ta.getBoundingClientRect();
        document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, clientX: box.left + 40, clientY: box.top + 40 }));
        await sleep(600);
        const pop = document.getElementById('selPop');
        return {
            mode: state.mode,
            selected: ta.value.slice(ta.selectionStart, ta.selectionEnd),
            shown: !pop.hidden,
            markShows: isVisible(document.getElementById('selPopMark')),
            lookupShows: isVisible(document.getElementById('selPopLookup')),
            findShows: isVisible(document.getElementById('selPopFind')),
            onScreen: (() => { const r = pop.getBoundingClientRect();
                return r.left >= 0 && r.top >= 0 &&
                       r.right <= window.innerWidth && r.bottom <= window.innerHeight; })(),
        };
    });
    info('selected ' + JSON.stringify(source.selected) + ' in ' + source.mode);
    assert(source.mode === 'source', 'control: the app really is in Source');
    assert(source.selected === 'scroll', 'control: a word is selected in the textarea');
    assert(source.shown, 'the popover appears for a textarea selection');
    // isVisible, not .hidden. Asserting the property is what let this ship broken: the
    // attribute was set correctly all along and the button was on screen anyway, because
    // .selpop-btn sets display: flex and an author rule beats the UA [hidden] rule.
    assert(source.markShows === false,
        'Highlight is not on screen — Source has no blocks to anchor to');
    assert(source.lookupShows, 'Look up is offered');
    assert(source.findShows, 'Find in document is offered');
    assert(source.onScreen, 'and it is positioned inside the window');

    console.log('\n=== and they act on the text that is selected ===');
    const lookedUp = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const b = document.getElementById('selPopLookup');
        const br = b.getBoundingClientRect();
        const o = { bubbles: true, clientX: br.left + 5, clientY: br.top + 5 };
        b.dispatchEvent(new MouseEvent('mousedown', o));
        b.dispatchEvent(new MouseEvent('mouseup', o));
        b.click();
        await sleep(1600);
        const body = document.getElementById('selPopBody');
        return { shown: !body.hidden, text: (body.textContent || '').slice(0, 120) };
    });
    info('answer: ' + JSON.stringify(lookedUp.text));
    assert(lookedUp.shown, 'Look up answers in Source');
    assert(/scroll/i.test(lookedUp.text), 'and the answer is about the word that was selected');

    const found = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        document.getElementById('selPopFind').click();
        await sleep(2600);
        const input = document.getElementById('sidebarSearchInput');
        const active = document.querySelector('.sidebar-tab.active');
        return {
            query: input ? input.value : null,
            tab: active ? active.getAttribute('data-tab') : null,
            paneOpen: !document.getElementById('sidebar').classList.contains('collapsed'),
            matches: (typeof findState !== 'undefined') ? findState.matches.length : -1,
        };
    });
    info(JSON.stringify(found));
    assert(found.query === 'scroll', 'Find in document carries the selected word across');
    assert(found.tab === 'search' && found.paneOpen, 'and opens the Search pane on it');
    assert(found.matches > 0, 'with real results (' + found.matches + ')');
    // --- The same defect hid a second thing, so it is asserted too.
    //
    // showSelPop has always done `lookup.hidden = !_selPopWord` -- Look up is for a word,
    // because a paragraph has no definition. That never hid anything either, for the same
    // reason, so Look up sat there over a whole-sentence selection offering to define it.
    console.log('\n=== Look up is for a word, and now says so ===');
    const phrase = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:mode:preview');
        await sleep(2200);
        const b = [...document.querySelectorAll('#editor .block')]
            .find(x => /scroll marker/.test(x.textContent || ''));
        const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); tw.nextNode();
        const n = tw.currentNode;
        // A whole run of words, not one.
        const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, Math.min(24, n.nodeValue.length));
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        const box = r.getBoundingClientRect();
        document.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true, clientX: box.left + 2, clientY: box.top + 2 }));
        await sleep(600);
        return {
            selected: r.toString(),
            popShown: !document.getElementById('selPop').hidden,
            lookupShows: isVisible(document.getElementById('selPopLookup')),
            markShows: isVisible(document.getElementById('selPopMark')),
        };
    });
    info('selected ' + JSON.stringify(phrase.selected));
    assert(phrase.popShown, 'control: the popover is up for a multi-word selection');
    assert(phrase.selected.trim().indexOf(' ') > 0, 'control: more than one word is selected');
    assert(phrase.lookupShows === false,
        'Look up is not offered for a phrase — a paragraph has no definition');
    assert(phrase.markShows, 'but Highlight is, because a phrase is exactly what you highlight');

} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'SOURCE POPOVER FAILED' : 'SOURCE POPOVER PASSED');
process.exit(failed ? 1 : 0);
