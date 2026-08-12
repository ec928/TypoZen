/**
 * A control that cannot act does not look like one that can.
 *
 * Reader sets #editor to contenteditable="false", for a book and for Markdown alike, so
 * Bold, Italic, Strikethrough, Code, Headings, Quote, Lists, Link and Table are all
 * no-ops there -- and every one of them stayed at full strength, indistinguishable from
 * a toolbar that works. Word Wrap had greyed itself and said why for a long time; the
 * nine controls beside it had not.
 *
 * Asserted through UI Automation rather than the page, because the claim is about the
 * WPF chrome: IsEnabled is what a screen reader reports and what a click obeys.
 *
 * Both directions, in one run. "They are greyed in Reader" is only worth something next
 * to "they are live in Preview" -- a toolbar that is always dead would pass half of this
 * suite, which is exactly the shape of test that has fooled this project before.
 *
 *   RUN_APP_E2E=1 node tests/format-availability-app.mjs
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { launchApp, sleep, appDir } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

function shell(command, arg) {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(appDir, 'tests', 'shell-ui.ps1'), '-Command', command];
    if (arg) args.push('-Arg', arg);
    return JSON.parse(execFileSync('powershell', args, { encoding: 'utf8' }).trim());
}

// By AutomationId (x:Name in the XAML), not by label: these buttons carry private-use
// MDL2 glyphs as their content, so their accessible name is a character that means
// nothing on its own. The three dropdowns are Menus in the XAML and the header MenuItem
// inside each is what UI Automation surfaces -- WPF propagates IsEnabled down, so
// locking the Menu is visible on its item.
const FORMAT = [
    'btnBold', 'btnItalic', 'btnStrike', 'btnCode',
    'miHeadings', 'btnQuote', 'miLists', 'btnLink', 'miTable',
];

/** Report each formatting control's enabled state, plus what could not be found. */
function formatState() {
    const all = shell('controls').controls;
    const seen = [], missing = [];
    for (const id of FORMAT) {
        const hit = all.find(c => c.id === id);
        if (hit) seen.push({ label: id, enabled: hit.enabled });
        else missing.push(id);
    }
    return { seen, missing, total: all.length };
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 7000 });
try {
    // --- Control: on an editable Markdown document every one of them is live.
    console.log('\n=== Markdown, Preview ===');
    await app.eval(() => handleCommand('view_set:mode:preview'));
    await sleep(2000);
    let st = formatState();
    info('found ' + st.seen.length + ' of ' + FORMAT.length + ' format controls among ' +
        st.total + ' toolbar controls' + (st.missing.length ? '; missing ' + st.missing.join(', ') : ''));
    assert(st.missing.length === 0,
        'control: every formatting control is present in the shell');
    assert(st.seen.length > 0 && st.seen.every(c => c.enabled),
        'control: all of them are live on an editable document' +
        ' (' + st.seen.filter(c => !c.enabled).map(c => c.label).join(', ') + ')');

    // --- Reader on the same Markdown: read-only, so they must go quiet.
    console.log('\n=== Markdown, Reader ===');
    await app.eval(() => handleCommand('view_set:mode:reader'));
    await sleep(2500);
    const editable = await app.eval(() =>
        document.getElementById('editor').isContentEditable);
    info('editor.isContentEditable = ' + editable);
    assert(editable === false, 'control: Reader really did make the document read-only');

    st = formatState();
    const live = st.seen.filter(c => c.enabled).map(c => c.label);
    info('still live: ' + (live.length ? live.join(', ') : 'none'));
    assert(st.seen.length === FORMAT.length && live.length === 0,
        'every formatting control is greyed in Reader');

    // --- And back: greying must be a state, not a one-way door.
    console.log('\n=== back to Preview ===');
    await app.eval(() => handleCommand('view_set:mode:preview'));
    await sleep(2500);
    st = formatState();
    const dead = st.seen.filter(c => !c.enabled).map(c => c.label);
    info('still greyed: ' + (dead.length ? dead.join(', ') : 'none'));
    assert(dead.length === 0, 'and they all come back when the document can take an edit');

    // --- The status bar no longer carries a version number nobody asked for.
    // (The reported list also picks up virtualized outline rows whose UI Automation
    // rectangles sit outside the pane; the two claims here are substring tests, so it
    // does not matter, but it is why this prints a slice rather than the lot.)
    const status = shell('status').status;
    info('status bar: ' + JSON.stringify(status.slice(0, 10)));
    assert(!status.some(s => /TypoZen v/i.test(s)),
        'the status bar carries no permanent version label');
    assert(status.some(s => /^Theme:/i.test(s)),
        'control: the theme pill is still there (it was kept deliberately)');
} finally {
    await app.close();
}

// --- A book, which is read-only whatever the mode says. Separate launch: opening one
//     over a Markdown tab is a different code path and this is about the resting state.
console.log('\n=== an epub ===');
const book = await launchApp({ file: 'tests/Matter - Iain M. Banks.epub', settleMs: 12000 });
try {
    const kind = await book.eval(() =>
        (typeof DocumentModel !== 'undefined') ? DocumentModel.kind : '?');
    assert(kind === 'epub', 'control: the book opened');
    const st = formatState();
    const live = st.seen.filter(c => c.enabled).map(c => c.label);
    info('still live: ' + (live.length ? live.join(', ') : 'none'));
    assert(st.missing.length === 0 && live.length === 0,
        'every formatting control is greyed on a book');
} finally {
    await book.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'FORMAT AVAILABILITY FAILED' : 'FORMAT AVAILABILITY PASSED');
process.exit(failed ? 1 : 0);
