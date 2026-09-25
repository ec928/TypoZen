/**
 * Pasting into the middle of a line, headless, through the real paste event.
 *
 * Two defects found by hand on 2026-09-25:
 *   - a paste lost its own leading space: " there" after "Hello" became "Hellothere",
 *     because the clean-up trimmed every paste, not only multi-paragraph ones;
 *   - **bold** pasted into bold text saved as "**... **bold** ...**", which Markdown cannot
 *     nest, and the reader saw stray asterisks.
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
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    await page.evaluate(m => loadMarkdownContent(m), 'Hello world here.\n\nThe **strong words** end.\n');
    await page.waitForFunction(() => document.querySelectorAll('#editor .block').length >= 2, { timeout: 10000 });

    // Put the caret after `word` inside `blockText`'s block, then paste `text`.
    const pasteAt = (blockText, word, text) => page.evaluate((bt, w, t) => {
        const block = Array.from(document.querySelectorAll('#editor .block')).find(b => b.innerText.includes(bt));
        block.focus();
        const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let n;
        while ((n = tw.nextNode())) { const i = n.data.indexOf(w); if (i >= 0) {
            const r = document.createRange(); r.setStart(n, i + w.length); r.collapse(true);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
        const dt = new DataTransfer(); dt.setData('text/plain', t);
        block.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return getMarkdownContent(false);
    }, blockText, word, text);

    let md = await pasteAt('Hello world', 'Hello', ' there');
    assert(md.includes('Hello there world here.'), 'a paste keeps its leading space  (' + JSON.stringify(md.split('\n')[0]) + ')');

    md = await pasteAt('strong words', 'strong', ' **very**');
    const line = md.split('\n').find(l => l.includes('strong')) || '';
    assert(line === 'The **strong very words** end.', 'bold pasted into bold stays one bold run  (' + JSON.stringify(line) + ')');
    const shown = await page.evaluate(() => Array.from(document.querySelectorAll('#editor .block')).map(b => b.innerText).join('\n'));
    assert(!shown.includes('*'), 'and no asterisks on screen');
} finally {
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('PASTE-INLINE FAILED'); process.exit(1); }
console.log('PASTE-INLINE PASSED');
