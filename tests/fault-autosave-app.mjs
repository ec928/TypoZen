/**
 * After an unhandled UI fault, automatic writes stop; File > Save does not.
 *
 * Claude stopped autosave and session persist when DispatcherUnhandledException
 * fires. Nothing had actually thrown and watched the disk. This does: a --debug
 * host command throws on the dispatcher, then we wait past AutosaveIdleMs and
 * prove the file is untouched. A control first (no fault) proves autosave was
 * going to write. Persist is the same shape. debug_save is File > Save.
 *
 *   RUN_APP_E2E=1 node tests/fault-autosave-app.mjs
 */
import fs from 'fs';
import path from 'path';
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

const MARK_A = 'FAULT_MARK_A_UNIQUE';
const MARK_B = 'FAULT_MARK_B_UNIQUE';
const ORIGINAL = '# Fault autosave fixture\n\nOriginal line.\n';
const FILE = path.join(profileDir, 'fault-autosave-docs', 'note.md');
const BODIES = path.join(profileDir, 'session_bodies');

function writeDoc(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}
function readDoc(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}
function sessionText() {
    let out = '';
    try { out += fs.readFileSync(profileFile('tabs_session.txt'), 'utf8'); } catch (e) {}
    try {
        for (const name of fs.readdirSync(BODIES)) {
            try { out += fs.readFileSync(path.join(BODIES, name), 'utf8'); } catch (e) {}
        }
    } catch (e) {}
    return out;
}
function setFlags(flags) {
    const state = profileFile('window_state.json');
    let o = {};
    try { o = JSON.parse(fs.readFileSync(state, 'utf8')); } catch (e) {}
    if (!o || typeof o !== 'object') o = {};
    Object.assign(o, flags);
    fs.writeFileSync(state, JSON.stringify(o));
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

async function typeMark(app, mark) {
    const focused = await app.eval(() => {
        const el = editor && editor.querySelector('.block');
        if (!el) return false;
        focusBlock(el, (el.innerText || '').length);
        return true;
    });
    if (!focused) throw new Error('no block to type into');
    await app.page.bringToFront().catch(() => {});
    await app.page.keyboard.type(' ' + mark);
    await until(async () => {
        const md = await pageMd(app);
        return (md && md.indexOf(mark) >= 0) ? md : null;
    }, 8000, 'typed mark is not in the buffer: ' + mark);
}

async function untilDiskHas(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (readDoc(FILE).indexOf(needle) >= 0) return true;
        await sleep(150);
    }
    return false;
}

async function untilLogHas(needle, timeoutMs) {
    const log = profileFile('debug.log');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let t = '';
        try { t = fs.readFileSync(log, 'utf8'); } catch (e) {}
        if (t.indexOf(needle) >= 0) return t;
        await sleep(150);
    }
    return '';
}

async function untilSessionHas(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (sessionText().indexOf(needle) >= 0) return true;
        await sleep(150);
    }
    return false;
}

setFlags({ autosave: true, sessionBodies: true });
writeDoc(FILE, ORIGINAL);

const app = await launchApp({ file: FILE, settleMs: 5000, view: true });
try {
    await settledApp(app, 15000);
    await until(async () => {
        const md = await pageMd(app);
        return (md && md.indexOf('Original line') >= 0) ? md : null;
    }, 20000, 'document did not open');

    console.log('\n=== control: autosave and persist actually write ===');
    await typeMark(app, MARK_A);
    // Persist while dirty: a clean tab after autosave stores path only, no body.
    await app.eval(() => { try { postMsg('debug_persist_session'); } catch (e) {} });
    const persistWrote = await untilSessionHas(MARK_A, 8000);
    info('session has MARK_A: ' + persistWrote);
    assert(persistWrote, 'without a fault, session persist writes the dirty buffer');

    const autoWrote = await untilDiskHas(MARK_A, 8000);
    info('disk after idle: ' + JSON.stringify(readDoc(FILE).slice(0, 80)));
    assert(autoWrote, 'without a fault, autosave writes the dirty buffer');

    console.log('\n=== throw on the dispatcher ===');
    await typeMark(app, MARK_B);
    await app.eval(() => { try { postMsg('debug_throw_ui'); } catch (e) {} });
    const log = await untilLogHas('FAULT dispatcher', 8000);
    info('debug.log has dispatcher fault: ' + (log.indexOf('FAULT dispatcher') >= 0));
    assert(log.indexOf('FAULT dispatcher') >= 0,
        'the unhandled-exception handler ran (logged FAULT dispatcher)');
    assert(log.indexOf('debug_throw_ui') >= 0, 'and it was the throw we asked for');

    // AutosaveIdleMs is 2000; wait past two idle cycles. A poll-for-absence is
    // how you lie to yourself; the control above is what makes the wait honest.
    await sleep(5500);
    const diskAfter = readDoc(FILE);
    info('disk after fault+idle: MARK_A=' + (diskAfter.indexOf(MARK_A) >= 0) +
        ' MARK_B=' + (diskAfter.indexOf(MARK_B) >= 0));
    assert(diskAfter.indexOf(MARK_A) >= 0, 'the last good autosave is still on disk');
    assert(diskAfter.indexOf(MARK_B) < 0,
        'autosave did not write the post-fault edit over the file');

    await app.eval(() => { try { postMsg('debug_persist_session'); } catch (e) {} });
    await sleep(800);
    const sess = sessionText();
    info('session after fault persist: MARK_A=' + (sess.indexOf(MARK_A) >= 0) +
        ' MARK_B=' + (sess.indexOf(MARK_B) >= 0));
    assert(sess.indexOf(MARK_B) < 0,
        'session persist did not replace the last good snapshot with post-fault state');

    console.log('\n=== File > Save still writes ===');
    await app.eval(() => { try { postMsg('debug_save'); } catch (e) {} });
    const saved = await untilDiskHas(MARK_B, 8000);
    info('disk after save: ' + JSON.stringify(readDoc(FILE).slice(0, 120)));
    assert(saved, 'File > Save still writes after a fault (the reader asked)');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'FAULT AUTOSAVE FAILED' : 'FAULT AUTOSAVE PASSED');
process.exit(failed ? 1 : 0);
