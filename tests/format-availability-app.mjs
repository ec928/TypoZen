/**
 * The window's controls tell the truth about what can be done.
 *
 * Since 2026-11-21 formatting has no buttons on the window: it is on the right-click menu
 * (Ed: no format toolbar, no Format menu). This suite used to check that the toolbar's
 * format controls greyed in Reader and on a book; those controls are gone, so it now
 * checks that they stay gone -- with a control that UI Automation does see the toolbar --
 * and keeps its other claims: the status bar, no caught fault, and Source/Preview locked
 * on a PDF.
 *
 * Asserted through UI Automation rather than the page, because the claims are about the
 * WPF chrome: IsEnabled is what a screen reader reports and what a click obeys.
 *
 *   RUN_APP_E2E=1 node tests/format-availability-app.mjs
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { launchApp, sleep, appDir, profileDir } from './app-harness.mjs';

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

// By AutomationId (x:Name in the XAML). These were the toolbar's format controls until
// 2026-11-21; none of them may come back.
const GONE = ['miHeadings', 'btnQuote', 'miCallouts', 'miLists', 'btnTable'];

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 7000, visible: true });
try {
    console.log('\n=== Markdown, Preview ===');
    await app.eval(() => handleCommand('view_set:mode:preview'));
    await sleep(2000);
    const all = shell('controls').controls;
    info(all.length + ' toolbar controls');
    assert(all.some(c => c.id === 'btnModeReader') && all.some(c => c.id === 'btnReadAloud'),
        'control: UI Automation sees the command row (Mode and Read Aloud)');
    const back = GONE.filter(id => all.some(c => c.id === id));
    assert(back.length === 0, 'no formatting controls on the window' + (back.length ? ' (found ' + back.join(', ') + ')' : ''));

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

    // A fault the app caught still turns autosave off ("off after an error"), which this
    // suite's status bar showed on 2026-09-26: fail on it, with its cause.
    let faults = [];
    try { faults = fs.readFileSync(path.join(profileDir, 'debug.log'), 'utf8').split(/\r?\n/).filter(l => /FAULT/.test(l)); } catch (e) { }
    for (const l of faults.slice(0, 3)) info(l.slice(0, 700));
    assert(faults.length === 0, 'no fault was caught along the way' + (faults.length ? ' (' + faults.length + ')' : ''));
} finally {
    await app.close();
}

// --- A PDF: one mode, reading it. Source and Preview were live on a PDF (it moved into the
//     main page, so the "native tab" test that locks them no longer caught it); pressing
//     either closed the PDF behind an empty "Unsaved" document (Ed, 2026-09-30).
console.log('\n=== a PDF ===');
const pdf = await launchApp({ file: 'tests/pdf-sample.pdf', settleMs: 8000, visible: true });
try {
    const on = await pdf.eval(() => !!window.tzPdfActive && window.tzPdfState().pages);
    assert(on === 3, 'control: the PDF opened (' + on + ' pages)');
    await sleep(800);
    const all = shell('controls').controls;
    const seg = (id) => { const c = all.find(x => x.id === id); return c ? c.enabled : 'missing'; };
    info('Source ' + seg('btnModeSource') + ', Preview ' + seg('btnModePreview') + ', Reader ' + seg('btnModeReader'));
    assert(seg('btnModeSource') === false && seg('btnModePreview') === false,
        'Source and Preview are greyed on a PDF');
    assert(seg('btnModeReader') === true, 'and Reader is not');
    // The page's own mode command (keyboard) must not take the PDF away either.
    await pdf.eval(() => { handleCommand('toggle_mode'); handleCommand('mode_to_source'); });
    await sleep(800);
    const still = await pdf.eval(() => ({ active: !!window.tzPdfActive, pages: window.tzPdfState().pages, mode: state.mode }));
    assert(still.active && still.pages === 3, 'a mode command leaves the PDF on screen (' + JSON.stringify(still) + ')');
} finally {
    await pdf.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'FORMAT AVAILABILITY FAILED' : 'FORMAT AVAILABILITY PASSED');
process.exit(failed ? 1 : 0);
