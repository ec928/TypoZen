/**
 * File > Save confirmation on the page.
 *
 * The host sends save_noted only for an explicit save (the menu or Ctrl+S).
 * Autosave does not. This page has no WPF status bar, so the test is the note
 * that stands in when that bar is hidden: it names the file, and it does not
 * move the caret or change the text.
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
    await page.waitForFunction(() => typeof handleSaveNoted === 'function' && typeof setCaretAtOffset === 'function', { timeout: 15000 });

    const shown = await page.evaluate(() => {
        loadMarkdownContent('Hello world here.\n\nSecond paragraph stays.\n');
        const block = document.querySelector('#editor .block');
        editor.focus();
        setCaretAtOffset(block, 6);
        const beforeMd = getMarkdownContent(false);
        const scroll = editor.scrollTop;
        const ignored = handleSaveNoted('not-a-save');
        const absent = !document.getElementById('saveNote');
        handleSaveNoted('save_noted:' + encodeURIComponent('My Notes.md'));
        const el = document.getElementById('saveNote');
        const sel = getSelection();
        const pre = document.createRange();
        pre.selectNodeContents(block);
        pre.setEnd(sel.anchorNode, sel.anchorOffset);
        const cs = el ? getComputedStyle(el) : null;
        return {
            ignored,
            absent,
            text: el ? el.textContent : '',
            hidden: el ? el.hidden : true,
            inEditor: !!(el && editor.contains(el)),
            active: document.activeElement && document.activeElement.id,
            off: pre.toString().length,
            md: getMarkdownContent(false) === beforeMd,
            scroll: editor.scrollTop === scroll,
            pe: cs ? cs.pointerEvents : ''
        };
    });
    assert(shown.ignored === false && shown.absent, 'anything other than save_noted does not add a note');
    assert(shown.text === 'Saved \u00b7 My Notes.md' && shown.hidden === false,
        'the note names the file  (' + shown.text + ')');
    assert(!shown.inEditor, 'the note is not part of the document');
    assert(shown.active === 'editor' && shown.off === 6, 'the caret stays where it was  (off ' + shown.off + ', ' + shown.active + ')');
    assert(shown.md && shown.scroll, 'the text and the scroll position stay put');
    assert(shown.pe === 'none', 'the note does not take clicks');

    const again = await page.evaluate(() => {
        handleSaveNoted('save_noted:' + encodeURIComponent(''));
        const el = document.getElementById('saveNote');
        return { text: el ? el.textContent : '', count: document.querySelectorAll('#saveNote').length };
    });
    assert(again.text === 'Saved' && again.count === 1, 'a save with no name says Saved, once  (' + again.text + ')');
} finally {
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('SAVE-NOTE FAILED'); process.exit(1); }
console.log('SAVE-NOTE PASSED');
