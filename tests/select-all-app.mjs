/**
 * Edit > Select All, on both surfaces.
 *
 * The point is not that something gets selected. Under virtualisation the DOM holds a
 * window onto the document -- 54 blocks of 3767 -- so a selection that merely covers
 * what is on screen looks identical to the reader and copies 1% of the file. Copy, Cut,
 * Delete and Export all recognise "select everything" by asking selectionIsWholeEditor()
 * whether the range is #editor itself with offsets spanning every child, and only then
 * read the model. So the assertion is about the SHAPE of the range, over a document the
 * DOM is deliberately only part of.
 *
 *   RUN_APP_E2E=1 node tests/select-all-app.mjs
 */
import { execSync } from 'child_process';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

function ui(cmd, arg) {
    try {
        const out = execSync(
            'powershell -NoProfile -ExecutionPolicy Bypass -File tests/shell-ui.ps1 -Command ' + cmd
            + (arg === undefined ? '' : ' -Arg "' + String(arg) + '"'),
            { encoding: 'utf8', timeout: 30000 });
        return JSON.parse(out.trim());
    } catch (e) { return { error: String(e.message).slice(0, 200) }; }
}

/**
 * Press a menu item, and keep asking until it is there.
 *
 * A WPF submenu is populated when it opens, so an invoke that arrives before the items
 * exist answers "no item 'Select All' under 'Edit'" -- which is indistinguishable from
 * the command having been removed, and failed this suite against a working build.
 */
async function invokeMenu(pathStr) {
    let last = null;
    for (let i = 0; i < 5; i++) {
        last = ui('invoke', pathStr);
        if (last && !last.error) return last;
        await sleep(400);
    }
    return last;
}

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 8000, view: true });
try {
    await settledApp(app, 8000);

    console.log('\n=== Preview: the range is the whole document, not the window ===');
    const before = await app.eval(() => ({
        blocks: DocumentModel.blocks.length,
        mounted: document.querySelectorAll('#editor .block').length,
        virt: !!DocumentModel.virtEnabled
    }));
    info(before.mounted + ' of ' + before.blocks + ' blocks mounted, virt=' + before.virt);
    // Without this the rest proves nothing: on a fully mounted document, selecting the
    // window and selecting the document are the same range.
    assert(before.mounted < before.blocks,
        'control: the DOM holds only part of the document (' +
        before.mounted + '/' + before.blocks + ')');

    // Clear any selection first, so a pass cannot come from what was already selected.
    await app.eval(() => { try { window.getSelection().removeAllRanges(); } catch (e) {} });
    const cleared = await app.eval(() => window.getSelection().rangeCount);
    assert(cleared === 0, 'control: nothing is selected before the menu is used');

    const inv = await invokeMenu('Edit>Select All');
    info('invoke: ' + JSON.stringify(inv));
    // Wait for the selection to arrive rather than for 600ms. The menu press, the host
    // message and the page all happen in sequence, and a flat wait passed on one run and
    // failed on the next with only a log line changed between them.
    for (let i = 0; i < 20; i++) {
        if (await app.eval(() => window.getSelection().rangeCount > 0)) break;
        await sleep(150);
    }

    const sel = await app.eval(() => {
        const s = window.getSelection();
        if (!s || s.rangeCount === 0) return { none: true };
        const r = s.getRangeAt(0);
        return {
            whole: (typeof selectionIsWholeEditor === 'function')
                ? selectionIsWholeEditor(r) : null,
            chars: String(s).length,
            startIsEditor: r.startContainer === document.getElementById('editor'),
            endIsEditor: r.endContainer === document.getElementById('editor')
        };
    });
    info('selection: ' + JSON.stringify(sel));
    assert(!sel.none, 'the menu item selects something');
    // The shape, not the size. This is what Copy/Cut/Delete/Export branch on.
    assert(sel.whole === true,
        'selectionIsWholeEditor() recognises it, so the model paths engage');
    assert(sel.startIsEditor && sel.endIsEditor,
        'both ends are #editor itself, which is what that predicate requires');

    console.log('\n=== Source: the textarea selects itself ===');
    await app.eval(() => handleCommand('view_set:mode:source'));
    await sleep(1200);
    await app.eval(() => { try { document.getElementById('source-editor').setSelectionRange(0, 0); } catch (e) {} });
    await invokeMenu('Edit>Select All');
    for (let i = 0; i < 20; i++) {
        const n = await app.eval(() => {
            const ta = document.getElementById('source-editor');
            return ta ? ta.selectionEnd - ta.selectionStart : 0;
        });
        if (n > 0) break;
        await sleep(150);
    }
    const src = await app.eval(() => {
        const ta = document.getElementById('source-editor');
        return { len: ta.value.length, start: ta.selectionStart, end: ta.selectionEnd };
    });
    info('source: ' + src.start + '..' + src.end + ' of ' + src.len);
    assert(src.end - src.start === src.len && src.len > 100000,
        'Select All covers the whole file in Source (' + (src.end - src.start) + '/' + src.len + ')');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('SELECT ALL FAILED'); process.exit(1); }
console.log('SELECT ALL PASSED');
