/**
 * Backspace at the start of a later page, and Delete at the end of one, must join
 * the line that is off screen. The page only holds part of the file, so the
 * neighbouring line is not the previous element in the DOM.
 *
 *   node tests/page-line-join-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 900;
const lines = [];
for (let i = 0; i < N; i++) lines.push('KEEP-' + String(i).padStart(4, '0'));
const doc = lines.join('\n');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

async function show(page, bi) {
    await page.evaluate(md => loadMarkdownContent(md), doc);
    await settled(page);
    await page.evaluate(() => {
        handleCommand('view_set:columns:2');
        handleCommand('view_set:scroll:pagination');
    });
    await settled(page);
    await page.evaluate(i => goToModelBlock(i), bi);
    await settled(page);
}

async function keyOn(page, bi, offset, key) {
    return page.evaluate((i, off, k) => {
        const el = editor.querySelector('.block[data-model-index="' + i + '"]');
        if (!el) return { err: 'not mounted ' + i };
        const sib = k === 'Backspace' ? el.previousElementSibling : el.nextElementSibling;
        const sibBlock = !!(sib && sib.classList && sib.classList.contains('block'));
        focusBlock(el, off < 0 ? (el.innerText || '').length : off);
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        return { sibBlock: sibBlock, mounted: PageChunks.mounted };
    }, bi, offset, key);
}

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    info('first line of the file');
    await show(page, 0);
    const top = await keyOn(page, 0, 0, 'Backspace');
    await settled(page);
    const topAfter = await page.evaluate(() => ({
        n: DocumentModel.blocks.length,
        first: DocumentModel.blocks[0].raw
    }));
    info('top ' + JSON.stringify(top) + ' -> ' + JSON.stringify(topAfter));
    assert(top && top.sibBlock === false, 'line 1 has no previous line on the page');
    assert(topAfter.n === N && topAfter.first === 'KEEP-0000',
        'Backspace on line 1 leaves the file alone');

    info('Backspace at the start of a later page');
    await show(page, 400);
    const boundary = await keyOn(page, 400, 0, 'Backspace');
    await settled(page);
    const joined = await page.evaluate(() => {
        const b = DocumentModel.blocks;
        const shown = editor.querySelector('.block[data-model-index="399"]');
        return {
            n: b.length,
            at0: b[0].raw,
            at398: b[398].raw,
            at399: b[399].raw,
            at400: b[400].raw,
            shown: shown ? shown.getAttribute('data-raw') : null
        };
    });
    info('boundary ' + JSON.stringify(boundary));
    info('joined ' + JSON.stringify(joined));
    assert(boundary && boundary.sibBlock === false, 'the line above the page is not in the page');
    assert(joined.at399 === 'KEEP-0399KEEP-0400',
        'Backspace joins the line onto the one above (' + JSON.stringify(joined.at399) + ')');
    assert(joined.at400 === 'KEEP-0401',
        'the following line moves up (' + JSON.stringify(joined.at400) + ')');
    assert(joined.at0 === 'KEEP-0000' && joined.n === N - 1,
        'the rest of the file stays (' + joined.n + ', ' + JSON.stringify(joined.at0) + ')');
    assert(joined.shown === 'KEEP-0399KEEP-0400',
        'the joined line is the one on screen');

    info('Backspace in the middle of a page');
    await show(page, 450);
    const mid = await keyOn(page, 450, 0, 'Backspace');
    await settled(page);
    const midAfter = await page.evaluate(() => ({
        at449: DocumentModel.blocks[449].raw,
        at450: DocumentModel.blocks[450].raw,
        n: DocumentModel.blocks.length
    }));
    info('mid ' + JSON.stringify(mid) + ' -> ' + JSON.stringify(midAfter));
    assert(mid && mid.sibBlock === true, 'the previous line is on the page');
    assert(midAfter.at449 === 'KEEP-0449KEEP-0450' && midAfter.at450 === 'KEEP-0451'
        && midAfter.n === N - 1,
        'Backspace still joins two lines that are both on screen (' + JSON.stringify(midAfter.at449) + ')');

    info('Delete at the end of a page');
    await show(page, 799);
    const del = await keyOn(page, 799, -1, 'Delete');
    await settled(page);
    const delAfter = await page.evaluate(() => ({
        at799: DocumentModel.blocks[799].raw,
        at800: DocumentModel.blocks[800].raw,
        at0: DocumentModel.blocks[0].raw,
        n: DocumentModel.blocks.length
    }));
    info('delete ' + JSON.stringify(del));
    info('delete after ' + JSON.stringify(delAfter));
    assert(del && del.sibBlock === false, 'the next line is not on the page');
    assert(delAfter.at799 === 'KEEP-0799KEEP-0800',
        'Delete pulls the next line up (' + JSON.stringify(delAfter.at799) + ')');
    assert(delAfter.at800 === 'KEEP-0801' && delAfter.at0 === 'KEEP-0000' && delAfter.n === N - 1,
        'the rest of the file stays (' + delAfter.n + ')');
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nPAGE LINE JOIN FAILED');
    process.exitCode = 1;
} else {
    console.log('\nPAGE LINE JOIN PASSED');
}
