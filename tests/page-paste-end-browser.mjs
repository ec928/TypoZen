/**
 * Pasting at the end of a two-page document must not rewrite the beginning.
 *
 * Page mode mounts one range of a long file. A multi-line paste (what a browser
 * copy becomes) inserts blocks, then renumbered every block on screen as 0, 1, 2.
 * The paste's own undo snapshot writes each block back into the row that number
 * names, so the page you were reading replaced the start of the file.
 *
 *   node tests/page-paste-end-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const N = 900;
const lines = [];
for (let i = 0; i < N; i++) lines.push('KEEP-' + String(i).padStart(4, '0'));
const PASTE = 'PASTE-A\nPASTE-B\nPASTE-C';

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    await page.evaluate(md => loadMarkdownContent(md), lines.join('\n'));
    await settled(page);
    await page.evaluate(() => {
        handleCommand('view_set:columns:2');
        handleCommand('view_set:scroll:pagination');
    });
    await settled(page);
    // The page turn measures and mounts after this call returns.
    await page.evaluate(() => goToModelBlock(DocumentModel.blocks.length - 1));
    await settled(page);

    const placed = await page.evaluate(() => ({
        n: DocumentModel.blocks.length,
        windowed: pageWindowingActive(),
        chunk: PageChunks.mounted,
        chunks: PageChunks.chunkCount(DocumentModel.blocks.length)
    }));
    info('blocks ' + placed.n + ', windowed ' + placed.windowed +
        ', range ' + placed.chunk + ' of ' + placed.chunks);
    assert(placed.n === N, 'the document is ' + N + ' blocks');
    assert(placed.windowed, 'two-page mode is windowed');
    assert(placed.chunk > 0, 'the caret range is not the first range');

    const before = await page.evaluate(() => DocumentModel.blocks[0].raw);
    await page.evaluate(t => {
        const n = DocumentModel.blocks.length;
        const el = editor.querySelector('.block[data-model-index="' + (n - 1) + '"]');
        if (!el) throw new Error('last block is not mounted');
        focusBlock(el, (el.innerText || '').length);
        insertPastedPlainText(t);
    }, PASTE);
    await settled(page);

    const after = await page.evaluate(() => ({
        first: DocumentModel.blocks[0].raw,
        tenth: DocumentModel.blocks[10].raw,
        at800: DocumentModel.blocks[800].raw,
        n: DocumentModel.blocks.length,
        tail: DocumentModel.blocks.slice(-4).map(b => b.raw)
    }));
    info('first block after paste: ' + JSON.stringify(after.first));
    info('tail: ' + JSON.stringify(after.tail));
    assert(after.first === before && after.first === 'KEEP-0000',
        'the first line is still the first line (' + JSON.stringify(after.first) + ')');
    assert(after.tenth === 'KEEP-0010',
        'a line near the start is untouched (' + JSON.stringify(after.tenth) + ')');
    assert(after.at800 === 'KEEP-0800',
        'the start of the later range is untouched (' + JSON.stringify(after.at800) + ')');
    assert(after.n === N + 2,
        'two new lines were added, the first joined the last line (' + after.n + ')');
    assert(after.tail[after.tail.length - 1] === 'PASTE-C' &&
        after.tail.indexOf('PASTE-B') >= 0,
        'the paste is at the end (' + JSON.stringify(after.tail) + ')');
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nPAGE PASTE END FAILED');
    process.exitCode = 1;
} else {
    console.log('\nPAGE PASTE END PASSED');
}
