/**
 * Undo steps back through typing, one edit at a time.
 *
 * Press Ctrl+Z ONCE and this cannot fail: undo() falls back to pushing the live state
 * when it differs from the top of the stack, so a single undo always reverts something.
 * Every existing suite pressed it once. What none of them did was press it twice.
 *
 * Typing in Preview recorded no frames at all -- the only snapshots came from
 * compositionend (IME), the Source textarea, and the explicit beginEdit/commitEdit pairs
 * around formatting -- so a whole session of typing left the undo stack exactly as the
 * document had loaded. One press reverted EVERYTHING and the next did nothing.
 *
 * So this asserts the stack grows as you type, and that undo walks back one edit per
 * press rather than jumping to the start.
 *
 *   RUN_APP_E2E=1 node tests/undo-steps-app.mjs
 */
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const WORDS = [' ONE', ' TWO', ' THREE'];

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 8000, view: true });
try {
    await settledApp(app, 8000);
    // Real keystrokes. execCommand('insertText') changes the text without going through
    // the input handler that records history, so a probe built on it measures a path no
    // reader uses -- it reported zero snapshots against a working build.
    await app.page.bringToFront().catch(() => {});

    const firstRaw = () => app.eval(() => (DocumentModel.blocks[0] || {}).raw || '');
    const depth = () => app.eval(() => HistoryManager.undoStack.length);

    await app.eval(() => {
        const b = editor.querySelector('.block');
        focusBlock(b, (b.innerText || '').length);
    });
    const base = await firstRaw();
    const baseDepth = await depth();
    info('base: ' + JSON.stringify(base) + ' stack=' + baseDepth);
    assert(base.length > 0, 'control: there is a first block to type into');

    const seen = [];
    for (const w of WORDS) {
        await app.page.keyboard.type(w, { delay: 30 });
        // Wait for the frame, not for a guessed interval: snapshot() is debounced 350ms.
        const want = seen.length + baseDepth + 1;
        for (let i = 0; i < 25; i++) {
            if (await depth() >= want) break;
            await sleep(150);
        }
        seen.push(await firstRaw());
        info('after' + w + ': stack=' + await depth());
    }

    const grown = await depth();
    assert(grown >= baseDepth + WORDS.length,
        'each burst of typing is its own frame (stack ' + baseDepth + ' -> ' + grown + ')');

    // Walk back. The text after undo #1 must be the text as it was after the SECOND
    // burst -- not the base, which is what "one press reverts everything" looked like.
    for (let i = 0; i < WORDS.length; i++) {
        await app.eval(() => HistoryManager.undo());
        const expect = (i === WORDS.length - 1) ? base : seen[WORDS.length - 2 - i];
        for (let k = 0; k < 25; k++) {
            if (await firstRaw() === expect) break;
            await sleep(150);
        }
        const got = await firstRaw();
        info('undo #' + (i + 1) + ': ' + JSON.stringify(got));
        assert(got === expect,
            'undo #' + (i + 1) + ' steps back one edit, not to the start'
            + (got === expect ? '' : ' (wanted ' + JSON.stringify(expect) + ')'));
    }

    // And stops there rather than eating the document it was opened with.
    await app.eval(() => HistoryManager.undo());
    await sleep(500);
    assert(await firstRaw() === base, 'a further undo leaves the loaded document alone');

    console.log(String.fromCharCode(10) + '=== a NEW document undoes all the way back to blank ===');
    // Reported as "type 1 2 3 4 5, Ctrl+Z, the one stays". A new document's initial
    // state is legitimately EMPTY, and undo() drops empty frames on the way past -- so
    // the base frame was popped and discarded rather than restored, and the first thing
    // typed could never be undone. The loaded-document case above cannot catch this:
    // its base frame has text in it.
    // What the host's File > New does to the page (03-shell.js: loadMarkdownContent('',
    // { replaceBook: true })). 'new_tab' is not a page command -- asking for it silently
    // did nothing and the digits went into the document already open.
    await app.eval(() => loadMarkdownContent('', { replaceBook: true }));
    await sleep(1500);
    const text = () => app.eval(() => getMarkdownContent(false));
    await app.eval(() => {
        const b = editor.querySelector('.block');
        if (b) focusBlock(b, 0);
    });
    const startedEmpty = (await text()).trim() === '';
    assert(startedEmpty, 'control: the new document really is blank to begin with');

    for (const ch of ['1', '2', '3', '4', '5']) {
        await app.page.keyboard.type(ch, { delay: 40 });
        await sleep(450);
    }
    await sleep(600);
    const typed = (await text()).trim();
    info('typed: ' + JSON.stringify(typed));
    assert(typed === '12345', 'control: all five characters are in the document');

    let last = typed;
    for (let i = 1; i <= 6; i++) {
        await app.eval(() => HistoryManager.undo());
        for (let k = 0; k < 20; k++) {
            if ((await text()).trim() !== last) break;
            await sleep(150);
        }
        last = (await text()).trim();
        info('undo #' + i + ': ' + JSON.stringify(last));
        if (last === '') break;
    }
    assert(last === '',
        'undo reaches the blank page, so the first character is undoable too'
        + (last === '' ? '' : ' (stuck at ' + JSON.stringify(last) + ')'));
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('UNDO STEPS FAILED'); process.exit(1); }
console.log('UNDO STEPS PASSED');
