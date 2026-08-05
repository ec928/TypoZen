/**
 * Copy something in TypoZen, paste it back, get the same thing.
 *
 * The most basic operation in an editor, and it had no test that went through the actual
 * clipboard handlers. The existing coverage called insertPastedPlainText() directly, which
 * skips the copy handler, skips the DataTransfer, and skips the branch that decides whether
 * the clipboard came from TypoZen or from somewhere else -- which is precisely where the
 * bug was. It reported green while copying four lines and pasting them produced four lines
 * with a blank between each.
 *
 * So this dispatches real copy and paste events carrying a real DataTransfer, and asserts
 * on the document afterwards. Nothing is called directly.
 *
 *   node tests/clipboard-roundtrip-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** Copy a range of blocks and paste it after another, through the real event handlers. */
function roundTrip(fromIdx, toIdx, afterIdx) {
    const q = (i) => document.querySelector('.block[data-model-index="' + i + '"]');
    const a = q(fromIdx), z = q(toIdx), target = q(afterIdx);
    if (!a || !z || !target) return { ok: false, why: 'blocks not mounted' };

    const source = DocumentModel.blocks.slice(fromIdx, toIdx + 1).map(b => b.raw);

    const rg = document.createRange();
    rg.setStart(a, 0);
    rg.setEnd(z, z.childNodes.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rg);

    // A real copy event, with a real DataTransfer for the handler to write into.
    const dt = new DataTransfer();
    const copyEv = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copyEv, 'clipboardData', { value: dt });
    document.getElementById('editor').dispatchEvent(copyEv);

    const clipPlain = dt.getData('text/plain');
    const clipHtml = dt.getData('text/html');

    // Put the caret at the end of the target block and paste the same DataTransfer back.
    focusBlock(target, (target.innerText || '').length);
    const before = DocumentModel.blocks.length;
    const pasteEv = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEv, 'clipboardData', { value: dt });
    document.getElementById('editor').dispatchEvent(pasteEv);

    return {
        ok: true,
        source: source,
        clipPlain: clipPlain,
        clipHtmlHead: String(clipHtml).slice(0, 120),
        markedAsOurs: String(clipHtml).indexOf('data-source="typozen"') !== -1,
        added: DocumentModel.blocks.length - before,
        after: DocumentModel.blocks.slice(afterIdx, afterIdx + (toIdx - fromIdx) + 2).map(b => b.raw)
    };
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        // A small document, so every block is mounted and this is about the clipboard only.
        const doc = [
            'alpha one',
            'beta two',
            'gamma **three**',
            'delta `four`',
            '',
            'epsilon five',
            'zeta six'
        ].join('\n');
        await page.evaluate(m => loadMarkdownContent(m), doc);
        await sleep(1200);

        const before = await page.evaluate(() => DocumentModel.blocks.map(b => b.raw));
        info('document: ' + JSON.stringify(before));

        console.log('\n=== copy four consecutive lines, paste them back ===');
        const r = await page.evaluate(roundTrip, 0, 3, 5);
        assert(r.ok, 'the blocks under test are mounted' + (r.ok ? '' : ' -- ' + r.why));
        if (!r.ok) { console.log('\npassed=' + passed + ' failed=' + failed); process.exitCode = 1; return; }

        info('clipboard text/plain: ' + JSON.stringify(r.clipPlain));
        info('clipboard text/html : ' + JSON.stringify(r.clipHtmlHead));
        info('pasted region       : ' + JSON.stringify(r.after));

        assert(r.clipPlain === r.source.join('\n'),
            'the clipboard carries exactly the markdown of the copied blocks');
        assert(r.markedAsOurs,
            'the clipboard HTML is marked as TypoZen’s own, so paste uses the plain text');

        // The heart of it: four lines in, four lines out.
        assert(r.added === r.source.length - 1,
            'pasting ' + r.source.length + ' lines adds ' + (r.source.length - 1) +
            ' blocks, not more (' + r.added + ')');

        const pastedRegion = r.after.slice(0, r.source.length);
        const blanks = pastedRegion.filter(x => !String(x).trim()).length;
        assert(blanks === 0,
            'no blank line is invented between the pasted lines (' + blanks +
            ' in ' + JSON.stringify(pastedRegion) + ')');

        assert(pastedRegion.some(x => /\*\*three\*\*/.test(x)),
            'inline markdown survives the round trip rather than arriving as plain words');

        console.log('\n=== the document is otherwise untouched ===');
        const after = await page.evaluate(() => DocumentModel.blocks.map(b => b.raw));
        // The caret block keeps its text and gains the first pasted line, which is what a
        // paste at the end of a line means -- so look for the original text as a prefix,
        // not as a whole block.
        const joined = after.join('\n');
        const removed = before.filter(x => x.trim() && joined.indexOf(x) === -1);
        assert(removed.length === 0,
            'nothing that was in the document before has gone (' +
            JSON.stringify(removed.slice(0, 3)) + ')');

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) { console.error('\nCLIPBOARD ROUND TRIP FAILED'); process.exitCode = 1; return; }
        console.log('\nCLIPBOARD ROUND TRIP PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
