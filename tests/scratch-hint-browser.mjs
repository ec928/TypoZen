/**
 * The empty-tab hint belongs to an empty tab, and to nothing else.
 *
 * "Start typing... (F1 or Help menu for markdown syntax)" is an ::after on
 * #editor-wrapper.scratch-empty. syncScratchEmpty() sets that class, and it already
 * declines to set it on a book -- but nothing on the book path called it again. Open an
 * epub into a new (empty) tab and the class added while the tab was blank stayed exactly
 * where it was, painting the hint over page 1 of a 750-page novel.
 *
 * Reported against 0.2.38 with Dune open: 205,187 words on screen, and the hint on top
 * of them.
 *
 * The assertion is on the CLASS rather than on the rendered text, because the sentence
 * lives in a CSS pseudo-element that getComputedStyle can report but innerText cannot --
 * and the class is what the rule keys off, so it is the thing that is actually wrong.
 *
 *   node tests/scratch-hint-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    const tpl = path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/');
    await page.goto('file:///' + tpl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof loadMarkdownContent === 'function', { timeout: 15000 });

    const hinted = () => page.evaluate(() =>
        document.getElementById('editor-wrapper').classList.contains('scratch-empty'));

    // 1. A genuinely empty tab SHOULD carry the hint. Without this the rest proves
    //    nothing: a class that is never set is trivially never set wrongly.
    await page.evaluate(() => loadMarkdownContent('', { replaceBook: true }));
    await sleep(500);
    assert(await hinted() === true,
        'control: an empty tab shows the hint, which is what it is for');

    // 2. Typing into it clears the hint.
    await page.evaluate(() => loadMarkdownContent('# Real content\n\nA sentence.\n'));
    await sleep(500);
    assert(await hinted() === false, 'a document with content does not show the hint');

    // 3. Back to empty, so the book opens into a tab that is CURRENTLY hinted -- which is
    //    the reported situation: File > New, then open a book into it.
    await page.evaluate(() => loadMarkdownContent('', { replaceBook: true }));
    await sleep(400);
    assert(await hinted() === true, 'control: the tab is hinted again before the book opens');

    // 4. The model becomes a book. This is the real function the epub loader calls
    //    (06-render-epub.js: DocumentModel.fromBookBlocks(split.blocks, toc)).
    const blocks = await page.evaluate(() => {
        const chapters = [];
        for (let i = 0; i < 40; i++) {
            chapters.push('<p>Page ' + (i + 1) + ' of a book that is plainly not empty.</p>');
        }
        DocumentModel.fromBookBlocks(chapters, [{ title: 'Chapter One', blockIndex: 0 }]);
        return { n: DocumentModel.blocks.length, kind: DocumentModel.kind };
    });
    info('model: ' + blocks.n + ' blocks, kind ' + blocks.kind);
    assert(blocks.kind === 'epub' && blocks.n === 40,
        'control: the model really is a book with content in it');

    assert(await hinted() === false,
        'the hint is gone once the tab holds a book');
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('SCRATCH HINT FAILED'); process.exit(1); }
console.log('SCRATCH HINT PASSED');
