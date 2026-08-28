/**
 * Editing a large (virtualised) document must not corrupt it or move the view.
 *
 * Everything here is a bug that shipped, and all of it came from one habit: treating a
 * mounted DOM element as if it were the document. Under virtualisation it is not -- it is
 * a temporary painting of a window into DocumentModel, and mountVirtWindow() replaces
 * every element in it.
 *
 *   1. data-model-index went stale on insert/delete. syncMountedToModel() writes each
 *      mounted element's data-raw back into the model slot its attribute names, so after
 *      a mid-document paste the still-mounted neighbours wrote themselves into the rows
 *      the splice had just moved -- silently overwriting real text. Pasting three
 *      paragraphs destroyed the blank line after the caret and shifted the next line up.
 *
 *   2. invalidateHeights() threw away every measured height on any structural edit, so
 *      the next prefixHeight() for a row 850 blocks down was rebuilt from estimates and
 *      the viewport pin moved with the error -- 1562px per pasted block.
 *
 *   3. editor.focus() scrolls #editor into view, and #editor is the whole document, so
 *      its top edge is above the viewport unless you are at line 1. Undo found the right
 *      block and then scrolled to the top of the document before placing the caret.
 *
 *   4. The paste loop chained off the element createBlock returned, which the remount had
 *      already detached. focusBlock() on a detached node left currentActiveBlock pointing
 *      at the first block in the mounted window, and undo stored *that* as the edit site.
 *
 * The assertions are on the document text and on what is on screen, not on internals:
 * a paste must produce exactly the expected document, and must not move the reader.
 *
 *   node tests/edit-integrity-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const PASTE = ['PASTED-A one', '', 'PASTED-B two', '', 'PASTED-C three'].join('\n');

/** Park mid-document and put the caret at the end of a real, visible, non-empty block. */
async function parkCaret(page) {
    return page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 3; i++) {
            mainContainer.scrollTop = DocumentModel.prefixHeight(850);
            await sleep(400);
        }
        const host = mainContainer.getBoundingClientRect();
        let el = null;
        editor.querySelectorAll('.block').forEach(b => {
            if (el) return;
            const r = b.getBoundingClientRect();
            if (r.bottom > host.top + 80 && r.top < host.bottom
                && (b.innerText || '').trim().length > 10) el = b;
        });
        if (!el) return { caretIdx: -1 };
        focusBlock(el, (el.innerText || '').length);
        await sleep(200);
        const sel = window.getSelection();
        const at = sel && sel.anchorNode ? getAncestorBlock(sel.anchorNode) : null;
        return {
            caretIdx: DocumentModel.modelIndexOfEl(at),
            scrollTop: Math.round(mainContainer.scrollTop),
            firstVisibleIdx: firstVisibleModelIndex()
        };
    });
}

/** Model index of the topmost block actually on screen — "what the reader is looking at". */
function firstVisibleModelIndexSrc() {
    window.firstVisibleModelIndex = function () {
        const host = mainContainer.getBoundingClientRect();
        let idx = -1;
        editor.querySelectorAll('.block').forEach(b => {
            if (idx >= 0) return;
            const r = b.getBoundingClientRect();
            if (r.bottom > host.top + 2 && r.top < host.bottom) {
                idx = DocumentModel.modelIndexOfEl(b);
            }
        });
        return idx;
    };
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
        await page.evaluateOnNewDocument(firstVisibleModelIndexSrc);
        await page.evaluate(firstVisibleModelIndexSrc);

        const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
        await page.evaluate(m => loadMarkdownContent(m), md);
        await settled(page);

        assert(await page.evaluate(() => DocumentModel.virtEnabled === true),
            'the test document is large enough to virtualise (otherwise this proves nothing)');

        console.log('\n=== focusing a block does not scroll the document to the top ===');
        {
            // #editor is the whole contenteditable document, so plain focus() scrolls its
            // top edge into view -- i.e. to line 1. Every caller sets the caret itself
            // straight afterwards, so the browser's choice is always wrong. This is what
            // sent undo to the top of the document.
            const r = await page.evaluate(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                for (let i = 0; i < 3; i++) {
                    mainContainer.scrollTop = DocumentModel.prefixHeight(850);
                    await sleep(400);
                }
                const before = Math.round(mainContainer.scrollTop);
                const host = mainContainer.getBoundingClientRect();
                let el = null;
                editor.querySelectorAll('.block').forEach(b => {
                    if (el) return;
                    const rr = b.getBoundingClientRect();
                    if (rr.bottom > host.top + 80 && rr.top < host.bottom) el = b;
                });
                focusBlock(el, 0);
                await sleep(300);
                return { before: before, after: Math.round(mainContainer.scrollTop) };
            });
            info('scrollTop ' + r.before + ' -> ' + r.after);
            assert(r.before > 1000 && Math.abs(r.after - r.before) < 200,
                'focusBlock() mid-document leaves the view where it was, not at line 1');
        }

        console.log('\n=== pasting mid-document does not corrupt the document ===');

        // The document as the app itself serialises it. Comparing against the file on disk
        // would fail on round-trip whitespace differences that are not what is under test.
        const baseline = await page.evaluate(() => getMarkdownContent(false));
        const rawsBefore = await page.evaluate(() => DocumentModel.blocks.map(b => b.raw));
        const park = await parkCaret(page);
        assert(park.caretIdx > 100, 'caret parked mid-document at model block ' + park.caretIdx);
        info('first visible block before the paste: ' + park.firstVisibleIdx);
        if (!(park.caretIdx > 100)) {
            console.error('\n  Cannot park a caret mid-document, so the paste and undo checks');
            console.error('  below cannot run. Fix the focus check above first.');
            console.log('\npassed=' + passed + ' failed=' + failed);
            console.error('\nEDIT INTEGRITY FAILED');
            process.exitCode = 1;
            return;
        }

        const caretRaw = await page.evaluate(i => DocumentModel.blocks[i].raw, park.caretIdx);
        await page.evaluate(t => insertPastedPlainText(t), PASTE);
        await settled(page);

        const actual = await page.evaluate(() => getMarkdownContent(false));
        const pasted = PASTE.split('\n');
        const around = await page.evaluate((i) =>
            DocumentModel.blocks.slice(i, i + 6).map(b => b.raw), park.caretIdx);
        const wantAround = [
            caretRaw + pasted[0],
            pasted[1],
            pasted[2],
            pasted[3],
            pasted[4]
        ];
        assert(JSON.stringify(around.slice(0, 5)) === JSON.stringify(wantAround),
            'the pasted blocks land at the caret, in order, with nothing merged or dropped');
        if (JSON.stringify(around.slice(0, 5)) !== JSON.stringify(wantAround)) {
            info('got:  ' + JSON.stringify(around.slice(0, 5)));
            info('want: ' + JSON.stringify(wantAround));
        }

        // The strong one, and the assertion that caught the overwritten blank line: every
        // OTHER block in the document must be untouched. Block counts matched while the
        // content did not, so counting is not enough -- compare the whole list.
        const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        const rawsAfter = await page.evaluate(() => DocumentModel.blocks.map(b => b.raw));
        const wantRaws = rawsBefore.slice();
        wantRaws.splice(park.caretIdx, 1, caretRaw + pasted[0], pasted[1], pasted[2],
            pasted[3], pasted[4]);
        let firstDiff = -1;
        for (let i = 0; i < Math.max(wantRaws.length, rawsAfter.length); i++) {
            if (wantRaws[i] !== rawsAfter[i]) { firstDiff = i; break; }
        }
        assert(firstDiff === -1,
            'every other block in the document is untouched (' + rawsAfter.length +
            ' blocks, expected ' + wantRaws.length + ')');
        if (firstDiff >= 0) {
            info('first differing block: ' + firstDiff);
            info('  got:  ' + JSON.stringify(String(rawsAfter[firstDiff]).slice(0, 60)));
            info('  want: ' + JSON.stringify(String(wantRaws[firstDiff]).slice(0, 60)));
        }
        assert(actual.length > baseline.length,
            'the pasted text really is in the serialised document');

        console.log('\n=== pasting does not move the reader ===');
        const afterPaste = await page.evaluate(() => ({
            firstVisibleIdx: firstVisibleModelIndex(),
            scrollTop: Math.round(mainContainer.scrollTop)
        }));
        info('first visible block after the paste: ' + afterPaste.firstVisibleIdx +
            ' (scrollTop ' + park.scrollTop + ' -> ' + afterPaste.scrollTop + ')');
        assert(Math.abs(afterPaste.firstVisibleIdx - park.firstVisibleIdx) <= 2,
            'the block on screen before the paste is still the block on screen after it');

        console.log('\n=== undo restores the document and stays at the edit site ===');
        const caretForUndo = await page.evaluate(() => HistoryManager._captureCaret());
        assert(caretForUndo && Math.abs(caretForUndo.blockIndex - park.caretIdx) <= 6,
            'the caret undo will store is the paste site, not the top of the mounted window (' +
            (caretForUndo ? caretForUndo.blockIndex : 'null') + ' vs ' + park.caretIdx + ')');

        await page.evaluate(() => HistoryManager.undo());
        await settled(page);
        const undone = await page.evaluate(() => ({
            content: getMarkdownContent(false),
            firstVisibleIdx: firstVisibleModelIndex(),
            stillPasted: DocumentModel.blocks.filter(b => /PASTED-/.test(b.raw || '')).length
        }));
        assert(undone.stillPasted === 0, 'undo removed the pasted text');
        assert(norm(undone.content) === norm(baseline),
            'undo restored the original document exactly');
        info('first visible block after undo: ' + undone.firstVisibleIdx);
        assert(undone.firstVisibleIdx > 100,
            'undo did NOT jump to the top of the document (first visible block ' +
            undone.firstVisibleIdx + ')');
        assert(Math.abs(undone.firstVisibleIdx - park.firstVisibleIdx) <= 8,
            'undo left the reader where the edit was (' + undone.firstVisibleIdx +
            ' vs ' + park.firstVisibleIdx + ')');

        console.log('\n=== deleting across blocks does not corrupt the document ===');
        {
            // The other two callers of the model splice. Same stale-index defect, so the
            // same guard has to cover them.
            const before = await page.evaluate(() => getMarkdownContent(false));
            const cut = await page.evaluate(async () => {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const start = firstVisibleModelIndex() + 1;
                const raws = DocumentModel.blocks.slice(start, start + 4).map(b => b.raw);
                const a = elementForModelIndex(start);
                const b = elementForModelIndex(start + 3);
                if (!a || !b) return { ok: false };
                const r = document.createRange();
                r.setStart(a.firstChild || a, 0);
                r.setEnd(b, b.childNodes.length);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
                await sleep(120);
                removeCrossBlockSelection();
                await sleep(400);
                return { ok: true, start: start, removed: raws };
            });
            assert(cut.ok, 'selected four consecutive blocks mid-document');

            const after = await page.evaluate((s) => ({
                content: getMarkdownContent(false),
                around: DocumentModel.blocks.slice(s - 2, s + 3).map(b => b.raw)
            }), cut.start);

            // Every line that was NOT in the deleted range must still be present, in order.
            const gone = cut.removed.join('\n');
            const survives = norm(before).split('\n').filter(l =>
                l.trim() && gone.indexOf(l) === -1);
            const nowText = norm(after.content);
            const missing = survives.filter(l => nowText.indexOf(l) === -1);
            assert(missing.length === 0,
                'a cross-block delete removes only the selection (' + missing.length +
                ' untouched lines went missing' +
                (missing.length ? ': ' + JSON.stringify(missing.slice(0, 3)) : '') + ')');
        }

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) {
            console.error('\nEDIT INTEGRITY FAILED');
            process.exitCode = 1;
            return;
        }
        console.log('\nEDIT INTEGRITY PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
