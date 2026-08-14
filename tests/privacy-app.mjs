/**
 * Privacy Mode writes nothing that names a document — proved against a control.
 *
 * A privacy test is the easiest kind to write badly: assert that a file is absent, watch it
 * pass, and never notice the file was never written in the first place. So every claim here
 * is made twice — once with the mode off, where the trace must appear, and once with it on,
 * where it must not. A green run therefore means the suppression did something, not that
 * the feature was idle.
 *
 * Autosave is checked the same way, and by *setting* the stored preference rather than
 * clicking the menu item: the menu item toggles, so a clicking test inherits whatever the
 * previous run left and can assert "off does nothing" while it is quietly on.
 *
 *   RUN_APP_E2E=1 node tests/privacy-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp, sleep, profileDir } from './app-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const CACHE = profileDir;
const STATE = path.join(CACHE, 'window_state.json');
const BOOKS = path.join(appDir, 'typozen_books');
const DOC = path.join(appDir, 'tests', '_privacy_fixture.md');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** Write the preference straight into the state file: setting, not toggling. */
function setFlag(name, on) {
    let j = '{}';
    try { j = fs.readFileSync(STATE, 'utf8'); } catch (e) {}
    const re = new RegExp('"' + name + '"\\s*:\\s*(true|false)');
    j = re.test(j) ? j.replace(re, () => '"' + name + '":' + on)
                   : j.replace(/^\{/, () => '{"' + name + '":' + on + ',');
    fs.writeFileSync(STATE, j);
}
const read = (f) => { try { return fs.readFileSync(path.join(CACHE, f), 'utf8'); } catch (e) { return ''; } };
const wipe = () => ['tabs_session.txt', 'bookmarks.txt', 'book_positions.txt', 'recent_files.json']
    .forEach(f => { try { fs.unlinkSync(path.join(CACHE, f)); } catch (e) {} });

/** Close the window rather than killing it: the cleanup runs in the Closed handler, and
 *  app.close() kills, so a kill measures the crash path and nothing else. */
function closeGracefully() {
    try {
        execFileSync('powershell', ['-NoProfile', '-Command',
            "Get-Process TypoZen -ErrorAction SilentlyContinue | " +
            "ForEach-Object { $_.CloseMainWindow() } | Out-Null; Start-Sleep -Seconds 4"],
            { encoding: 'utf8' });
    } catch (e) {}
}

/** Do the things that normally leave traces. */
async function exercise(app) {
    await app.eval(() => {
        goToModelBlock(2);
        toggleMarkAtBlock(markTargetBlock());
        const i = document.getElementById('sidebarSearchInput');
        if (i) { i.value = 'secret'; i.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(3500);   // past the search debounce and the position report
}

let restoreState = null;
try { restoreState = fs.readFileSync(STATE, 'utf8'); } catch (e) {}

fs.writeFileSync(DOC, '# Privacy fixture\n\nA line of text to read.\n\nAnother line.\n');

console.log('\n=== the control: an ordinary run does write all of this ===');
wipe(); setFlag('privacyMode', false); setFlag('autosave', false);
let app = await launchApp({ file: 'tests/_privacy_fixture.md', settleMs: 5000 });
try { await exercise(app); } finally { await app.close(); }
await sleep(1200);
const normal = {
    tabs: read('tabs_session.txt'), marks: read('bookmarks.txt'),
    recent: read('recent_files.json'), settings: read('settings.json')
};
info('tabs=' + (normal.tabs.length > 0) + ' marks=' + (normal.marks.length > 0) +
    ' recent=' + /_privacy_fixture/.test(normal.recent) +
    ' lastFile=' + /_privacy_fixture/.test(normal.settings) +
    ' search=' + /secret/.test(normal.settings));
assert(normal.tabs.length > 0, 'control: the tab session is written');
assert(normal.marks.length > 0, 'control: bookmarks are written');
assert(/_privacy_fixture/.test(normal.recent), 'control: the document reaches recent files');
assert(/_privacy_fixture/.test(normal.settings), 'control: and settings.json records it');
assert(/secret/.test(normal.settings), 'control: and the search query is kept');

console.log('\n=== with Privacy Mode on, none of it is ===');
wipe(); setFlag('privacyMode', true);
app = await launchApp({ file: 'tests/_privacy_fixture.md', settleMs: 5000 });
try { await exercise(app); } finally { await app.close(); }
await sleep(1200);
const priv = {
    tabs: read('tabs_session.txt'), marks: read('bookmarks.txt'),
    recent: read('recent_files.json'), settings: read('settings.json'),
    state: read('window_state.json')
};
info('settings.json: ' + JSON.stringify(priv.settings.slice(0, 160)));
assert(priv.tabs.length === 0, 'no tab session');
assert(priv.marks.length === 0, 'no bookmarks file');
assert(!/_privacy_fixture/.test(priv.recent), 'no recent-files entry');
assert(!/_privacy_fixture/.test(priv.settings), 'no last-file path');
assert(!/secret/.test(priv.settings), 'no search history');
assert(/"themeName"|"margin"/.test(priv.settings),
    'but the view settings are still kept, as documented');
assert(/"privacyMode"\s*:\s*true/.test(priv.state), 'and the mode itself persists');

console.log('\n=== autosave: control, then suppressed ===');
const typeInto = async (a, text) => {
    await a.eval(() => {
        const b = [...document.querySelectorAll('#editor .block')].find(x => /line/i.test(x.textContent));
        if (!b) return;
        const r = document.createRange(); r.selectNodeContents(b); r.collapse(false);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        editor.focus();
    });
    for (const ch of text) await a.press(ch);
    await sleep(400);
};

fs.writeFileSync(DOC, '# Privacy fixture\n\nA line of text.\n');
setFlag('privacyMode', false); setFlag('autosave', true);
app = await launchApp({ file: 'tests/_privacy_fixture.md', settleMs: 5000 });
try { await typeInto(app, 'AUTOEDIT'); await sleep(6000); } finally { await app.close(); }
const savedNormally = fs.readFileSync(DOC, 'utf8').indexOf('AUTOEDIT') >= 0;
assert(savedNormally, 'control: autosave on writes the edit to the file');

fs.writeFileSync(DOC, '# Privacy fixture\n\nA line of text.\n');
setFlag('privacyMode', true);   // autosave still true; privacy must win
app = await launchApp({ file: 'tests/_privacy_fixture.md', settleMs: 5000 });
try { await typeInto(app, 'PRIVEDIT'); await sleep(6000); } finally { await app.close(); }
const savedPrivately = fs.readFileSync(DOC, 'utf8').indexOf('PRIVEDIT') >= 0;
assert(!savedPrivately, 'Privacy Mode holds autosave off even when autosave is on');

console.log('\n=== an extracted book leaves nothing named behind ===');
const tempSessions = () => fs.readdirSync(os.tmpdir()).filter(n => /^tz-[0-9a-f]{32}$/.test(n));
const BOOK = fs.readdirSync(path.join(appDir, 'tests')).find(f => /\.epub$/i.test(f));
if (!BOOK) {
    info('no .epub in tests/ — skipping the book half');
} else {
    try { fs.rmSync(BOOKS, { recursive: true, force: true }); } catch (e) {}
    setFlag('privacyMode', false); setFlag('autosave', false);
    app = await launchApp({ file: 'tests/' + BOOK, settleMs: 12000 });
    let normalDirs = [];
    try {
        normalDirs = fs.existsSync(BOOKS) ? fs.readdirSync(BOOKS) : [];
        const r = await app.eval(() => ({ kind: DocumentModel.kind, blocks: DocumentModel.blocks.length }));
        info('control: ' + JSON.stringify(normalDirs) + ', ' + r.blocks + ' blocks');
        assert(r.kind === 'epub' && r.blocks > 100, 'control: the book opens');
        assert(normalDirs.length > 0, 'control: extraction lands in typozen_books, by name');
    } finally { await app.close(); }
    await sleep(1200);

    try { fs.rmSync(BOOKS, { recursive: true, force: true }); } catch (e) {}
    const before = tempSessions().length;
    setFlag('privacyMode', true);
    app = await launchApp({ file: 'tests/' + BOOK, settleMs: 12000 });
    try {
        const r = await app.eval(() => ({
            kind: DocumentModel.kind, blocks: DocumentModel.blocks.length,
            img: (document.querySelector('#editor img') || {}).src || ''
        }));
        const during = tempSessions().length;
        const appDirs = fs.existsSync(BOOKS) ? fs.readdirSync(BOOKS) : [];
        info('privacy: app dirs=' + JSON.stringify(appDirs) + ', temp sessions +' + (during - before));
        assert(r.kind === 'epub' && r.blocks > 100, 'the book still opens');
        assert(/localbooks/.test(r.img) || r.img === '', 'assets are served from the book host');
        assert(appDirs.length === 0, 'nothing named appears in the application folder');
        assert(during > before, 'a disposable directory holds it while open');
    } finally {
        closeGracefully();     // the exit path, which is what triggers the cleanup
        await app.close();
    }
    await sleep(2500);
    assert(tempSessions().length <= before, 'and it is gone once the window closes');
}

try { fs.unlinkSync(DOC); } catch (e) {}
try { if (restoreState !== null) fs.writeFileSync(STATE, restoreState); } catch (e) {}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PRIVACY FAILED' : 'PRIVACY PASSED');
process.exit(failed ? 1 : 0);
