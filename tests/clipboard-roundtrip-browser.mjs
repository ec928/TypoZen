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
import { settled } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

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
        await settled(page);

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

        // --- Select all, on a document the DOM only partly holds.
        //
        // Ctrl+A selects the editor's CONTENTS, and under virtualisation those contents are
        // a window onto the document, not the document. Walking the mounted blocks put 2,797
        // characters of a 205,842-character file on the clipboard -- 1% -- with nothing to
        // say so. Copy is no more allowed to be a projection of the document than saving is.
        console.log('\n=== select all copies the document, not the window ===');
        // A BIG document, loaded here on purpose.
        //
        // The document above is seven lines, so every block is mounted and this assertion
        // would hold however broken the copy path was -- a test that cannot fail is worse
        // than no test, because it reads as cover. The fault needs a DOM that is a window:
        // virtualisation engages around 2000 blocks.
        await page.evaluate(() => {
            const big = [];
            for (let i = 0; i < 3000; i++) {
                big.push('Paragraph ' + i + ' with enough words in it to occupy a line or so.');
            }
            loadMarkdownContent(big.join('\n\n'));
        });
        await settled(page);

        const all = await page.evaluate(() => {
            const ed = document.getElementById('editor');
            const range = document.createRange();
            range.selectNodeContents(ed);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return {
                virt: !!DocumentModel.virtEnabled,
                mounted: ed.querySelectorAll('.block').length,
                modelBlocks: DocumentModel.blocks.length,
                copied: selectionToPlainText().length,
                whole: DocumentModel.toMarkdown().length
            };
        });
        info(all.mounted + ' of ' + all.modelBlocks + ' blocks mounted (virt ' + all.virt +
             '); select-all copied ' + all.copied + ' of ' + all.whole + ' chars');
        // The premise first: if the DOM holds everything, the assertion below proves nothing.
        assert(all.virt && all.mounted < all.modelBlocks,
            'the document is virtualised, so the DOM really is a window (' +
            all.mounted + ' of ' + all.modelBlocks + ')');
        assert(all.copied === all.whole,
            'select all copies every character of the document (' +
            all.copied + ' of ' + all.whole + ')');

        // And the same question of the save path, which is the one with a file at stake.
        const saved = await page.evaluate(() => getMarkdownContent(false).length);
        assert(saved === all.whole,
            'and what would be saved is the whole document too (' + saved + ')');

        console.log('\n=== select all cut takes the document, not the window ===');
        const cut = await page.evaluate(() => {
            const ed = document.getElementById('editor');
            const range = document.createRange();
            range.selectNodeContents(ed);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            const before = DocumentModel.toMarkdown();
            const virtBefore = !!DocumentModel.virtEnabled;
            const mountedBefore = ed.querySelectorAll('.block').length;
            const modelBefore = DocumentModel.blocks.length;
            const dt = new DataTransfer();
            const ev = new Event('cut', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'clipboardData', { value: dt });
            ed.dispatchEvent(ev);
            return {
                virtBefore: virtBefore,
                mountedBefore: mountedBefore,
                modelBefore: modelBefore,
                clip: dt.getData('text/plain').length,
                wholeBefore: before.length,
                after: DocumentModel.toMarkdown().length,
                modelBlocks: DocumentModel.blocks.length
            };
        });
        info('cut clipboard ' + cut.clip + ' of ' + cut.wholeBefore +
            '; model now ' + cut.after + ' chars, ' + cut.modelBlocks + ' blocks');
        assert(cut.virtBefore && cut.mountedBefore < cut.modelBefore,
            'cut ran on a windowed document (' + cut.mountedBefore + ' of ' + cut.modelBefore + ')');
        assert(cut.clip === cut.wholeBefore,
            'select all cut copies every character (' + cut.clip + ' of ' + cut.wholeBefore + ')');
        assert(cut.after === 0 || cut.modelBlocks <= 1,
            'and the model is emptied rather than left holding the rest of the file');

        console.log('\n=== export HTML is the document, not the window ===');
        // Reload a virtualised document — the cut above emptied it.
        await page.evaluate(() => {
            const big = [];
            for (let i = 0; i < 3000; i++) {
                big.push('Paragraph ' + i + ' with enough words in it to occupy a line or so.');
            }
            loadMarkdownContent(big.join('\n\n'));
        });
        await settled(page);
        const exp = await page.evaluate(() => {
            const html = generateExportHtml();
            const n = (html.match(/class="block"/g) || []).length;
            return {
                virt: !!DocumentModel.virtEnabled,
                mounted: document.getElementById('editor').querySelectorAll('.block').length,
                modelBlocks: DocumentModel.blocks.length,
                exportedBlocks: n
            };
        });
        info('export ' + exp.exportedBlocks + ' blocks; mounted ' + exp.mounted +
            ' of ' + exp.modelBlocks);
        assert(exp.virt && exp.mounted < exp.modelBlocks,
            'export runs against a windowed DOM (' + exp.mounted + ' of ' + exp.modelBlocks + ')');
        assert(exp.exportedBlocks === exp.modelBlocks,
            'export HTML contains every model block (' + exp.exportedBlocks +
            ' of ' + exp.modelBlocks + ')');

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) { console.error('\nCLIPBOARD ROUND TRIP FAILED'); process.exitCode = 1; return; }
        console.log('\nCLIPBOARD ROUND TRIP PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
