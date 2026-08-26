/**
 * Dirty tab vs a newer file on disk: Yes / No / Cancel / Autosave.
 *
 * The keep-editing and autosave-divert paths live behind a MessageBox. That dialog
 * pumps the UI thread, so DevTools cannot click it and the run hangs. TYPOZEN_TAB_E2E
 * skips the feature entirely so other in-process suites that rewrite the open file do
 * not silent-reload. Nothing could see this code until the host accepted an answer
 * from TYPOZEN_DISK_PROMPT=Yes|No|Cancel (and treated Save As as cancelled when
 * TYPOZEN_SAVE_AS_PATH is unset).
 *
 *   RUN_APP_E2E=1 node tests/disk-conflict-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp, profileDir, profileFile, sleep } from './app-harness.mjs';
import { settledApp } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const WORK = path.join(profileDir, 'disk-conflict-docs');
const BUFFER_MARK = 'BUFFER_EDIT_UNIQUE';
const DISK_MARK = 'DISK_EDIT_UNIQUE';
const ORIGINAL = '# Disk conflict fixture\n\nOriginal line.\n';
const DISK = '# Disk conflict fixture\n\n' + DISK_MARK + '\n';

function writeDoc(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}

function readDoc(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

/** Wipe session so a previous case in this process is not restored over the next file. */
function wipeSession() {
    for (const name of ['tabs_session.txt', 'recent_files.json']) {
        try { fs.unlinkSync(profileFile(name)); } catch (e) {}
    }
}

/** Preference as a setting, not a menu toggle — same reason as privacy-app. */
function setAutosave(on) {
    const state = profileFile('window_state.json');
    let j = '{}';
    try { j = fs.readFileSync(state, 'utf8'); } catch (e) {}
    const re = /"autosave"\s*:\s*(true|false)/;
    j = re.test(j)
        ? j.replace(re, '"autosave":' + on)
        : j.replace(/^\{/, '{"autosave":' + on + ',');
    fs.writeFileSync(state, j);
}

function ui(cmd, arg, force) {
    const a = arg === undefined ? '' : ' -Arg "' + String(arg).replace(/"/g, '`"') + '"';
    const f = force ? ' -Force' : '';
    try {
        const out = execSync(
            'powershell -NoProfile -ExecutionPolicy Bypass -File tests/shell-ui.ps1 -Command ' +
            cmd + a + f,
            { encoding: 'utf8', timeout: 45000, cwd: path.join(__dirname, '..') });
        return JSON.parse(out.trim());
    } catch (e) {
        return { error: 'driver failed: ' + (e.message || e) };
    }
}

async function until(fn, timeoutMs, msg) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) return last;
        await sleep(150);
    }
    throw new Error(msg + ' (last=' + JSON.stringify(last) + ')');
}

async function pageMd(app) {
    return app.eval(() => {
        try { return getMarkdownContent(false); } catch (e) { return ''; }
    });
}

async function pageDirty(app) {
    return app.eval(() => {
        try { return getMarkdownContent(false) !== state.lastSavedContent; } catch (e) { return false; }
    });
}

async function waitOpen(app, needle) {
    return until(async () => {
        const md = await pageMd(app);
        return (md && md.indexOf(needle) >= 0) ? md : null;
    }, 20000, 'document did not open with ' + JSON.stringify(needle));
}

async function dirtyBuffer(app) {
    const focused = await app.eval(() => {
        const el = editor && editor.querySelector('.block');
        if (!el) return false;
        focusBlock(el, (el.innerText || '').length);
        return true;
    });
    if (!focused) throw new Error('no block to type into');
    await app.page.bringToFront().catch(() => {});
    await app.page.keyboard.type(' ' + BUFFER_MARK);
    await until(() => pageDirty(app), 8000, 'buffer did not become dirty after typing');
    const md = await pageMd(app);
    if (md.indexOf(BUFFER_MARK) < 0)
        throw new Error('typed mark is not in the buffer: ' + JSON.stringify(md.slice(0, 200)));
    return md;
}

/** External write. Size change so the stamp cannot match on mtime slop alone. */
function writeDisk(file) {
    writeDoc(file, DISK);
    try { const st = fs.statSync(file); fs.utimesSync(file, st.atime, new Date()); } catch (e) {}
}

/**
 * Watcher is 400 ms debounce; if it misses the first write, clicking the active tab
 * is the same CheckEngineTabDisk path as switching back to a dirty tab.
 */
async function pokeDiskCheck() {
    ui('click-tab', '0');
}

async function waitPageHas(app, needle, timeoutMs) {
    return until(async () => {
        const md = await pageMd(app);
        return (md && md.indexOf(needle) >= 0) ? md : null;
    }, timeoutMs, 'page never showed ' + JSON.stringify(needle));
}

async function waitPageLacks(app, needle, timeoutMs) {
    return until(async () => {
        const md = await pageMd(app);
        return (md && md.indexOf(needle) < 0) ? md : null;
    }, timeoutMs, 'page still holds ' + JSON.stringify(needle));
}

async function withApp(file, env, fn) {
    wipeSession();
    const app = await launchApp({
        file: file,
        settleMs: 5000,
        view: true,
        env: env
    });
    try {
        await settledApp(app, 15000);
        await waitOpen(app, 'Original line');
        await fn(app);
    } finally {
        await app.close();
    }
    await sleep(1200);
}

console.log('\n=== Yes: reload from disk, discard unsaved edits ===');
{
    const file = path.join(WORK, 'yes.md');
    writeDoc(file, ORIGINAL);
    setAutosave(false);
    await withApp(file, { TYPOZEN_DISK_PROMPT: 'Yes' }, async (app) => {
        await dirtyBuffer(app);
        writeDisk(file);
        await sleep(600);
        try {
            await waitPageHas(app, DISK_MARK, 4000);
        } catch (e) {
            info('watcher quiet, clicking the tab to force the check');
            pokeDiskCheck();
            await waitPageHas(app, DISK_MARK, 8000);
        }
        await waitPageLacks(app, BUFFER_MARK, 4000);
        const dirty = await pageDirty(app);
        const disk = readDoc(file);
        info('page dirty=' + dirty + ' disk has DISK=' + (disk.indexOf(DISK_MARK) >= 0));
        assert(disk.indexOf(DISK_MARK) >= 0 && disk.indexOf(BUFFER_MARK) < 0,
            'Yes leaves the external copy on disk');
        assert(!(await pageDirty(app)), 'Yes leaves the tab clean');
        const md = await pageMd(app);
        assert(md.indexOf(DISK_MARK) >= 0, 'Yes puts disk text in the buffer');
        assert(md.indexOf(BUFFER_MARK) < 0, 'Yes discards the unsaved edit');
    });
}

console.log('\n=== No: keep editing, then Save overwrites disk ===');
{
    const file = path.join(WORK, 'no.md');
    writeDoc(file, ORIGINAL);
    setAutosave(false);
    await withApp(file, { TYPOZEN_DISK_PROMPT: 'No' }, async (app) => {
        await dirtyBuffer(app);
        writeDisk(file);
        await sleep(600);
        pokeDiskCheck();
        await sleep(800);
        const afterPrompt = await pageMd(app);
        const dirtyAfter = await pageDirty(app);
        info('after No: dirty=' + dirtyAfter + ' buffer has BUFFER=' +
            (afterPrompt.indexOf(BUFFER_MARK) >= 0));
        assert(afterPrompt.indexOf(BUFFER_MARK) >= 0, 'No keeps the unsaved edit in the buffer');
        assert(afterPrompt.indexOf(DISK_MARK) < 0, 'No does not load disk text into the buffer');
        assert(dirtyAfter, 'No leaves the tab dirty');
        assert(readDoc(file).indexOf(DISK_MARK) >= 0, 'No does not write on the prompt');

        const saved = ui('invoke', 'File>Save', true);
        info('File>Save: ' + JSON.stringify(saved));
        assert(!saved.error, 'Save can be invoked from the menu (' + (saved.error || 'ok') + ')');
        await until(() => Promise.resolve(readDoc(file).indexOf(BUFFER_MARK) >= 0),
            8000, 'Save did not write the buffer over disk');
        const disk = readDoc(file);
        assert(disk.indexOf(BUFFER_MARK) >= 0, 'Save after No overwrites disk with the buffer');
        assert(disk.indexOf(DISK_MARK) < 0, 'Save after No drops the external copy');
        await until(async () => !(await pageDirty(app)), 5000, 'tab stayed dirty after Save');
        assert(!(await pageDirty(app)), 'Save after No leaves the tab clean');
    });
}

console.log('\n=== Cancel: Save As cancelled, file on disk unchanged ===');
{
    const file = path.join(WORK, 'cancel.md');
    writeDoc(file, ORIGINAL);
    setAutosave(false);
    // No TYPOZEN_SAVE_AS_PATH: stub treats Save As as cancelled.
    await withApp(file, { TYPOZEN_DISK_PROMPT: 'Cancel' }, async (app) => {
        await dirtyBuffer(app);
        writeDisk(file);
        const before = readDoc(file);
        await sleep(600);
        pokeDiskCheck();
        await sleep(1200);
        const md = await pageMd(app);
        const disk = readDoc(file);
        info('after Cancel: buffer BUFFER=' + (md.indexOf(BUFFER_MARK) >= 0) +
            ' disk still DISK=' + (disk.indexOf(DISK_MARK) >= 0));
        assert(md.indexOf(BUFFER_MARK) >= 0, 'Cancel keeps the unsaved edit in the buffer');
        assert(disk === before && disk.indexOf(DISK_MARK) >= 0,
            'Cancel with no Save As path leaves the file byte-identical');
        assert(disk.indexOf(BUFFER_MARK) < 0, 'Cancel does not write the buffer over the file');
    });
}

console.log('\n=== Autosave + dirty + external change does not overwrite disk ===');
{
    const file = path.join(WORK, 'autosave.md');
    writeDoc(file, ORIGINAL);
    setAutosave(true);
    // Cancel so a later idle tick cannot Save: after No the stamp matches and
    // Autosave would write, which is "Save will overwrite" — not the divert.
    await withApp(file, { TYPOZEN_DISK_PROMPT: 'Cancel' }, async (app) => {
        await dirtyBuffer(app);
        writeDisk(file);
        await sleep(600);
        pokeDiskCheck();
        // AutosaveIdleMs is 2000; wait past two idle cycles plus debounce.
        await sleep(5500);
        const disk = readDoc(file);
        const md = await pageMd(app);
        info('after idle: disk DISK=' + (disk.indexOf(DISK_MARK) >= 0) +
            ' disk BUFFER=' + (disk.indexOf(BUFFER_MARK) >= 0) +
            ' page BUFFER=' + (md.indexOf(BUFFER_MARK) >= 0));
        assert(disk.indexOf(DISK_MARK) >= 0, 'Autosave did not drop the external copy');
        assert(disk.indexOf(BUFFER_MARK) < 0,
            'Autosave did not write the dirty buffer over the external edit');
        assert(md.indexOf(BUFFER_MARK) >= 0, 'the unsaved edit is still in the buffer');
    });
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'DISK CONFLICT FAILED' : 'DISK CONFLICT PASSED');
process.exit(failed ? 1 : 0);
