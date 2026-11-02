/**
 * The caret and keyboard focus after a menu, and after a paste.
 *
 * Alt+F, S opens File and invokes Save. The menu takes focus from the WebView, and
 * Chromium drops the selection on blur, so the caret is gone until a click. A paste
 * in that state inserted nothing and left the caret at the start of a line.
 *
 * The WPF menu itself is not in this page. The test does what the menu does to the
 * document: blur it and clear the selection, then ask for the caret back.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && typeof restoreEditorFocusAfterChrome === 'function', { timeout: 15000 });

    const lost = await page.evaluate(() => {
        loadMarkdownContent('Hello world here.\n\nSecond paragraph stays.\n');
        const block = document.querySelector('#editor .block');
        editor.focus();
        setCaretAtOffset(block, 6);
        rememberEditorCaret();
        editor.blur();
        getSelection().removeAllRanges();
        const gone = getSelection().rangeCount === 0;
        handleCommand('restore_editor_focus');
        const sel = getSelection();
        const pre = document.createRange();
        pre.selectNodeContents(block);
        pre.setEnd(sel.anchorNode, sel.anchorOffset);
        return {
            gone,
            active: document.activeElement && document.activeElement.id,
            inFirst: !!(sel.anchorNode && block.contains(sel.anchorNode)),
            off: pre.toString().length,
            md: getMarkdownContent(false)
        };
    });
    assert(lost.gone, 'blurring the editor clears the selection, as the File menu does');
    assert(lost.active === 'editor', 'restore puts keyboard focus back on the editor  (' + lost.active + ')');
    assert(lost.inFirst && lost.off === 6, 'the caret is back at "world", not at the start  (off ' + lost.off + ')');
    assert(lost.md.indexOf('Hello world here.') === 0, 'restore does not change the text');

    const pasted = await page.evaluate(() => {
        loadMarkdownContent('Hello world here.\n\nSecond paragraph stays.\n');
        const block = document.querySelector('#editor .block');
        editor.focus();
        setCaretAtOffset(block, 6);
        rememberEditorCaret();
        editor.blur();
        getSelection().removeAllRanges();
        insertPastedPlainText('beautiful ');
        const sel = getSelection();
        const host = document.querySelector('#editor .block');
        let off = -1;
        try {
            const pre = document.createRange();
            pre.selectNodeContents(host);
            pre.setEnd(sel.anchorNode, sel.anchorOffset);
            off = pre.toString().length;
        } catch (e) {}
        return {
            active: document.activeElement && document.activeElement.id,
            inEditor: !!(sel.anchorNode && editor.contains(sel.anchorNode)),
            off,
            md: getMarkdownContent(false)
        };
    });
    assert(pasted.md.indexOf('Hello beautiful world here.') === 0,
        'a paste after the caret was taken still lands where the caret was  (' + JSON.stringify(pasted.md.split('\n')[0]) + ')');
    assert(pasted.active === 'editor' && pasted.inEditor, 'and the caret stays in the editor afterwards');
    assert(pasted.off === 16, 'the caret is after the pasted word  (off ' + pasted.off + ')');

    const kept = await page.evaluate(() => {
        handleCommand('find');
        const before = document.activeElement && document.activeElement.id;
        handleCommand('restore_editor_focus');
        return { before, after: document.activeElement && document.activeElement.id };
    });
    assert(kept.before === 'findInput' && kept.after === 'findInput',
        'Find keeps focus when a menu closes  (before ' + kept.before + ', after ' + kept.after + ')');

    const source = await page.evaluate(() => {
        handleCommand('mode_to_source');
        sourceEditor.focus();
        sourceEditor.setSelectionRange(4, 4);
        rememberEditorCaret();
        sourceEditor.blur();
        sourceEditor.setSelectionRange(0, 0);
        handleCommand('restore_editor_focus');
        return {
            focused: typeof isSourceFocused === 'function' && isSourceFocused(),
            start: sourceEditor.selectionStart,
            end: sourceEditor.selectionEnd
        };
    });
    assert(source.focused, 'Source gets the keyboard back too');
    assert(source.start === 4 && source.end === 4, 'the Source caret is restored  (' + source.start + ')');
} finally {
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('FOCUS-RETURN FAILED'); process.exit(1); }
console.log('FOCUS-RETURN PASSED');
