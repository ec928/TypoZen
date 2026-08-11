/**
 * Every tab the app is holding has a chip on the strip.
 *
 * This is the one thing no other suite could see. The application suites reach into the
 * *page*, and the page knows nothing about tabs; the model suites check `_tabs` through the
 * session file, and the session file is written from the model. Both agreed with each other
 * while the strip -- the only surface a person actually looks at -- disagreed with both.
 *
 * The defect: ApplyTabToEditor ended with
 *
 *     if (!string.IsNullOrEmpty(tab.FilePath))
 *     RebuildTabStrip();
 *
 * -- no braces, so an untitled tab never repainted. That path is how New Tab, session
 * restore, closing the active tab and switching all finish, so a tab with no file was
 * created, made active, loaded and persisted without ever appearing. Clicking + looked
 * inert and quietly added another invisible tab each time; a real session reached ten
 * untitled tabs behind a strip showing one. Restarting did not clear it, because restore
 * rebuilt all ten and took the same branch, which is why the app looked permanently unable
 * to open a tab.
 *
 * So the assertion is deliberately about the painted chips, counted from outside the
 * process by UI Automation, against what the model says it has.
 *
 *   RUN_APP_E2E=1 node tests/tab-strip-paint-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp, sleep } from './app-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const SESSION = path.join(process.env.LOCALAPPDATA || '', 'TypoZen_Cache', 'tabs_session.txt');

// The real profile's session store. Put it back whatever happens.
let restoreSession = null;
try { restoreSession = fs.readFileSync(SESSION, 'utf8'); } catch (e) {}
function putSessionBack() {
    try {
        if (restoreSession !== null) fs.writeFileSync(SESSION, restoreSession);
        else fs.unlinkSync(SESSION);
    } catch (e) {}
}

/** A session of N untitled tabs with no bodies -- exactly the shape that failed. */
function writeUntitledSession(n) {
    let s = 'TZTABS1\nactive=' + (n - 1) + '\ncount=' + n + '\n\n';
    for (let i = 0; i < n; i++) {
        s += '[tab ' + i + ']\npath=\ndirty=0\nle=lf\ntrail=lf\nresume=0\ncols=0\nbody=\n\n';
    }
    fs.writeFileSync(SESSION, s);
}

function sessionCount() {
    try {
        const m = /^count=(\d+)$/m.exec(fs.readFileSync(SESSION, 'utf8'));
        return m ? parseInt(m[1], 10) : -1;
    } catch (e) { return -1; }
}

/** Chips actually painted in the title bar, seen from outside the process. */
function paintedTabs() {
    const out = execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(appDir, 'tests', 'shell-ui.ps1'), '-Command', 'tabs'
    ], { encoding: 'utf8', cwd: appDir });
    return JSON.parse(out.trim());
}

const N = 6;
writeUntitledSession(N);

console.log('\n=== a restored session of untitled tabs is all on the strip ===');
let app = await launchApp({ settleMs: 6000 });
try {
    const strip = paintedTabs();
    info('session restored ' + sessionCount() + ' tabs; strip painted ' + strip.count);
    assert(sessionCount() === N, 'the session still holds ' + N + ' tabs after restore');
    assert(strip.count === N,
        'the strip paints one chip per tab (' + strip.count + ' of ' + N + ')');

    // And a new one shows up. File > New is the same NewTab() the + button calls.
    console.log('\n=== and a new tab appears when asked for ===');
    execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(appDir, 'tests', 'shell-ui.ps1'),
        '-Command', 'invoke', '-Arg', 'File>New'
    ], { encoding: 'utf8', cwd: appDir });
    await sleep(2500);

    const after = paintedTabs();
    info('after File > New: session ' + sessionCount() + ', strip ' + after.count);
    assert(after.count === N + 1,
        'the new tab is on the strip (' + after.count + ', was ' + strip.count + ')');
    assert(sessionCount() === N + 1,
        'and the model agrees it exists (' + sessionCount() + ')');
} finally {
    await app.close();
    putSessionBack();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'TAB STRIP PAINT FAILED' : 'TAB STRIP PAINT PASSED');
process.exit(failed ? 1 : 0);
