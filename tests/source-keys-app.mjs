/**
 * In Source, TypoZen's keys do TypoZen's things -- not CodeMirror's.
 *
 * docs/codemirror-source-plan.md, section 5.2. CodeMirror's default keymaps bind Ctrl+Z,
 * Ctrl+D, Alt+arrows, Ctrl+[ and more to behaviours TypoZen either owns already or does
 * not have. Source loads CodeMirror's standard caret keys only, plus TypoZen's own Enter
 * and Tab. This presses real keys (through DevTools, so page-level shortcuts; the host's
 * own chords such as Ctrl+S are Win32 messages and belong to the visible-window suites)
 * and checks the document afterwards.
 *
 *   RUN_APP_E2E=1 node tests/source-keys-app.mjs
 */
import { launchApp } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const DOC = 'alpha beta gamma\n\n- one\n- two\n\nlast line\n';
const deadline = setTimeout(() => { console.error('DEADLINE'); process.exit(3); }, 90000);
const app = await launchApp({ file: 'tests/band-1600.md', settleMs: 8000, view: true });
const page = app.page;
const chord = async (mods, key) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(key);
    for (const m of mods.slice().reverse()) await page.keyboard.up(m);
};
const value = () => app.eval(() => sourceEditor.value);
/** Put DOC in Source as if typed (so the model and undo take it in), select [a, b). */
async function reset(a, b) {
    await app.eval((doc, a, b) => {
        sourceEditor.value = doc;
        sourceEditor.dispatchEvent(new Event('input', { bubbles: true }));
        HistoryManager.undoStack = []; HistoryManager.redoStack = [];
        HistoryManager._push(HistoryManager._stateFromContent(doc), true);
        sourceEditor.focus();
        sourceEditor.setSelectionRange(a, b);
    }, DOC, a, b);
    await page.waitForFunction((doc) => sourceEditor.value === doc, { timeout: 3000 }, DOC);
}
try {
    await app.eval(() => handleCommand('view_set:mode:source'));
    await page.waitForFunction(() => state.mode === 'source', { timeout: 5000 });
    const engine = await app.eval(() => window.__tzSourceEngine);
    assert(engine === 'codemirror', 'Source is on CodeMirror (' + engine + ')');
    await page.bringToFront().catch(() => { });

    console.log('\n=== formatting and undo are TypoZen\'s ===');
    await reset(6, 10);                                        // "beta"
    await chord(['Control'], 'b');
    await page.waitForFunction(() => sourceEditor.value.includes('**beta**'), { timeout: 3000 }).catch(() => { });
    const bold = await value();
    assert(bold.startsWith('alpha **beta** gamma'), 'Ctrl+B bolds the selection');
    await chord(['Control'], 'z');
    await page.waitForFunction((doc) => sourceEditor.value === doc, { timeout: 3000 }, DOC).catch(() => { });
    assert((await value()) === DOC, 'Ctrl+Z undoes it through TypoZen\'s history');
    await chord(['Control'], 'y');
    await page.waitForFunction(() => sourceEditor.value.includes('**beta**'), { timeout: 3000 }).catch(() => { });
    assert((await value()).includes('**beta**'), 'Ctrl+Y redoes it');
    await reset(0, 5);                                         // "alpha"
    await chord(['Control'], 'i');
    await page.waitForFunction(() => /^[*_]alpha[*_]/.test(sourceEditor.value), { timeout: 3000 }).catch(() => { });
    assert(/^[*_]alpha[*_] beta/.test(await value()), 'Ctrl+I italicises the selection');

    console.log('\n=== Enter and Tab are TypoZen\'s ===');
    await reset(DOC.indexOf('- two') + 5, DOC.indexOf('- two') + 5);   // end of "- two"
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => sourceEditor.value.includes('- two\n- '), { timeout: 3000 }).catch(() => { });
    assert((await value()).includes('- two\n- \n'), 'Enter continues the list marker');
    await reset(DOC.indexOf('- one') + 2, DOC.indexOf('- one') + 2);
    await page.keyboard.press('Tab');
    await page.waitForFunction((doc) => sourceEditor.value !== doc, { timeout: 3000 }, DOC).catch(() => { });
    const tabbed = await value();
    info('after Tab: ' + JSON.stringify(tabbed.split('\n')[2]));
    assert(/^\s+- one$/.test(tabbed.split('\n')[2]), 'Tab indents the list item');
    await reset(0, 0);
    await page.keyboard.press('Enter');
    await page.waitForFunction((doc) => sourceEditor.value !== doc, { timeout: 3000 }, DOC).catch(() => { });
    assert((await value()) === '\n' + DOC, 'Enter on an unindented line is a plain newline');

    console.log('\n=== Select All, Find, F3 ===');
    await reset(3, 3);
    await chord(['Control'], 'a');
    const all = await app.eval(() => [sourceEditor.selectionStart, sourceEditor.selectionEnd, sourceEditor.value.length]);
    assert(all[0] === 0 && all[1] === all[2], 'Ctrl+A selects the whole document');
    await reset(0, 0);
    await chord(['Control'], 'f');
    await page.waitForFunction(() => { const b = document.getElementById('findBar'); return b && getComputedStyle(b).display !== 'none'; }, { timeout: 3000 }).catch(() => { });
    const fb = await app.eval(() => { const b = document.getElementById('findBar'); return !!b && getComputedStyle(b).display !== 'none'; });
    assert(fb, 'Ctrl+F opens TypoZen\'s find bar, not CodeMirror\'s search panel');
    const cmPanel = await app.eval(() => !!document.querySelector('#source-cm .cm-panels, #source-cm .cm-search'));
    assert(!cmPanel, 'no CodeMirror panel appeared');
    await app.eval(() => { const i = document.getElementById('findInput'); i.value = 'e'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => findState.query === 'e' && findState.matches.length > 2, { timeout: 5000 });
    const i0 = await app.eval(() => findState.index);
    await page.keyboard.press('F3');
    await page.waitForFunction((i) => findState.index !== i, { timeout: 3000 }, i0).catch(() => { });
    assert((await app.eval(() => findState.index)) === i0 + 1, 'F3 steps to the next hit');
    await page.keyboard.down('Shift'); await page.keyboard.press('F3'); await page.keyboard.up('Shift');
    await page.waitForFunction((i) => findState.index === i, { timeout: 3000 }, i0).catch(() => { });
    assert((await app.eval(() => findState.index)) === i0, 'Shift+F3 steps back');
    await page.keyboard.press('Escape');

    console.log('\n=== CodeMirror\'s own bindings are absent ===');
    for (const [mods, key, what] of [[['Alt'], 'ArrowDown', 'Alt+Down (move line)'], [['Control'], 'd', 'Ctrl+D (select next occurrence)'],
        [['Control'], ']', 'Ctrl+] (indent)'], [['Control'], '/', 'Ctrl+/ (comment)']]) {
        await reset(0, 5);
        await chord(mods, key);
        const r = await app.eval(() => ({ v: sourceEditor.value, ranges: sourceEditor.view.state.selection.ranges.length }));
        assert(r.v === DOC && r.ranges === 1, what + ' leaves the document and selection alone');
    }
} finally {
    clearTimeout(deadline);
    await app.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SOURCE KEYS FAILED'); process.exit(1); }
console.log('SOURCE KEYS PASSED');
