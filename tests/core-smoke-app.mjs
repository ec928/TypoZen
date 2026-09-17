/**
 * Core smoke: can the shipped application do the two things it is for?
 *
 * This exists because 0.2.41 reached the Microsoft Store unable to open an ebook,
 * and 107 suites were green. Every one of them drove the web layer or a single
 * feature; none asked the plain question a user asks in the first ten seconds.
 * It was found by hand, while taking screenshots.
 *
 * TypoZen is a prose editor and an epub reader, so this walks both, in one pass:
 *
 *   READER  open a book -> real text painted -> seek -> real, different text there
 *   EDITOR  open a document -> its text on screen -> edit -> dirty -> save -> clean,
 *           and the new bytes are actually on disk
 *
 * Nothing clever, nothing exhaustive, nothing about a marginal surface. It is fast
 * enough to run on any change touching the shell, the reader or packaging. If it
 * grows past ~30s it has stopped being a smoke test.
 *
 * Edits go through the source textarea and an input event, and saving through
 * postMsg('debug_save'), rather than the harness keyboard -- press() calls
 * bringToFront() on every keystroke, and this suite should not fight for focus.
 *
 * The rule this encodes: a green gate that never ran the artefact under test says
 * nothing about the artefact. TYPOZEN_EXE points the harness at whichever build you
 * want checked -- the staging copy in bin\ or the deployed app, not just the loose
 * build that was compiled last.
 *
 * NOT COVERED, and this is the gap that let 0.2.41 ship: a REGISTERED MSIX does not
 * launch from a file path, so no suite reaches it. Until that is solved, the packaged
 * build must be checked by hand -- install it, open a book, turn a page. Two minutes.
 *
 *   RUN_APP_E2E=1 node tests/core-smoke-app.mjs
 *   RUN_APP_E2E=1 TYPOZEN_EXE=bin\TypoZen.exe node tests/core-smoke-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, evalPatiently, profileFile } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

async function waitIdle(app, timeoutMs) {
    try { await app.eval(() => 1); } catch (e) {}
    await settledApp(app, Math.min(timeoutMs || 8000, 8000));
}

/**
 * goToModelBlock schedules an rAF chain and returns immediately. Waiting for the
 * call to return measures nothing -- wait for the target's chunk to be mounted.
 * (This is the mistake that cost a day on 2026-08-28; see the seek timing note in
 * tests/epub-open-app.mjs.)
 */
async function waitForBlock(app, idx, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
        const here = await app.eval((i) => {
            try {
                if (typeof PageChunks !== 'undefined' && PageChunks.mounted >= 0
                    && typeof PageChunks.chunkOfBlock === 'function') {
                    return PageChunks.chunkOfBlock(i) === PageChunks.mounted;
                }
                return !!document.querySelector('#editor .block[data-model-index="' + i + '"]');
            } catch (e) { return false; }
        }, idx);
        if (here) return true;
        await sleep(150);
    }
    return false;
}

/** Visible text actually painted into the editor, not the model's idea of it. */
async function paintedText(app) {
    return evalPatiently(app, () => {
        const ed = document.querySelector('#editor');
        return ed ? (ed.innerText || '').trim() : '';
    });
}

/** The page's own reckoning of whether it holds unsaved changes. */
async function isDirty(app) {
    return evalPatiently(app, () => {
        try {
            return (typeof getMarkdownContent === 'function' && typeof state !== 'undefined')
                ? getMarkdownContent(false) !== state.lastSavedContent : null;
        } catch (e) { return null; }
    });
}

// The smallest book on hand: enough to be a real epub, cheap enough to stay a smoke test.
const books = fs.readdirSync(path.join(appDir, 'tests'))
    .filter(f => f.toLowerCase().endsWith('.epub'))
    .map(f => ({ f, size: fs.statSync(path.join(appDir, 'tests', f)).size }))
    .sort((a, b) => a.size - b.size);

if (!books.length) {
    console.error('  FAIL no .epub fixture in tests/ -- cannot smoke the reader');
    process.exit(1);
}
const book = books[0].f;

const started = Date.now();
let app;
try {
    // ------------------------------------------------------------------ READER
    console.log('=== the application starts and opens a book ===');
    info('book: ' + book + ' (' + Math.round(books[0].size / 1024) + ' KB)');
    app = await launchApp({ file: path.join('tests', book) });
    await waitIdle(app, 20000);
    assert(true, 'TypoZen started and the DevTools port answered');

    const model = await evalPatiently(app, () => ({
        blocks: (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
            ? DocumentModel.blocks.length : -1
    }));
    info('document model: ' + model.blocks + ' blocks');
    assert(model.blocks > 0, 'the book parsed into a document model with blocks in it');

    const text = await paintedText(app);
    info('painted ' + text.length + ' characters of text');
    assert(text.length > 200,
        'the reader painted real text on screen -- THE check that was missing when '
        + '0.2.41 shipped unable to open a book');

    console.log('\n=== it moves through the book ===');
    const target = await app.eval(() => {
        const i = Math.floor(DocumentModel.blocks.length * 0.5);
        setTimeout(() => { try { goToModelBlock(i); } catch (e) {} }, 0);
        return i;
    });
    const arrived = await waitForBlock(app, target, 30000);
    info('sought to block ' + target + ' of ' + model.blocks);
    assert(arrived, 'navigating to the middle of the book mounted the target chunk');

    await waitIdle(app, 8000);
    const midText = await paintedText(app);
    info('painted ' + midText.length + ' characters after the seek');
    assert(midText.length > 200, 'there is real text at the new position too');
    assert(midText !== text, 'and it is different text -- the view actually moved');

    // No error-banner assertion on purpose: the obvious selectors (.error-banner,
    // .fault-dialog, #error-overlay) do not exist in this app, so a check on them
    // could never fail -- it would inflate the pass count and prove nothing.
    assert((await isDirty(app)) !== true,
        'simply opening and reading a book did not mark it edited');
    assert(fs.statSync(path.join(appDir, 'tests', book)).size === books[0].size,
        'the .epub on disk is the size it started');

    // ------------------------------------------------------------------ EDITOR
    // A fresh instance: TypoZen is single-instance, so the reader session has to end
    // before a second launch can own the window. The fixture lives in the throwaway
    // profile directory, never in the repository.
    await app.close();
    app = null;
    await sleep(900);

    console.log('\n=== it opens a document, edits it and saves it ===');
    const MARKER = 'SmokeFixture-' + Date.now();
    const docPath = profileFile('core-smoke.md');
    fs.writeFileSync(docPath, '# ' + MARKER + '\n\nOriginal body text for the smoke test.\n', 'utf8');
    info('document: ' + docPath);

    app = await launchApp({ file: docPath });
    await waitIdle(app, 20000);

    const docText = await paintedText(app);
    assert(docText.indexOf(MARKER) >= 0, 'the document opened and its own text is on screen');
    assert((await isDirty(app)) !== true, 'a freshly opened document is not dirty');

    const EDIT = 'EDITED-' + Date.now();
    await app.eval(async (marker) => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:mode:source');
        await wait(1200);
        const se = document.getElementById('source-editor');
        se.setRangeText('\n\n' + marker + '\n', se.value.length, se.value.length, 'end');
        se.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(900);
    }, EDIT);
    await waitIdle(app, 8000);

    assert((await isDirty(app)) === true, 'editing the document marked it edited');

    // debug_save is the C# save hook (TypoZen_App.cs:5447). 'save_file' is NOT handled
    // anywhere in the C# and does nothing -- epub-open-app.mjs asserts on it, which makes
    // that assertion vacuous.
    await app.eval(() => { try { postMsg('debug_save'); } catch (e) {} });
    await sleep(2000);
    await waitIdle(app, 8000);

    assert((await isDirty(app)) !== true, 'saving cleared the edited state');
    const onDisk = fs.readFileSync(docPath, 'utf8');
    assert(onDisk.indexOf(EDIT) >= 0,
        'and the edit actually reached the file on disk -- not just the page');
    assert(onDisk.indexOf(MARKER) >= 0, 'without losing what was already in it');

    const secs = Math.round((Date.now() - started) / 1000);
    console.log('\npassed=' + passed + ' failed=' + failed + '  (' + secs + 's)');
    if (secs > 30) console.warn('  !!   over 30s -- trim this, it is a smoke test');
    if (failed) { console.error('\nCORE SMOKE FAILED'); process.exitCode = 1; }
    else console.log('\nCORE SMOKE PASSED');
} finally {
    if (app) await app.close();
}
