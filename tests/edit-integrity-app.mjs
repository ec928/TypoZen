/**
 * The paste/undo corruption, verified against the shipped binary.
 *
 * edit-integrity-browser.mjs proves the same properties in headless Chrome and gates the
 * build. This one runs them through TypoZen.exe, because the last six "fixes" to a
 * different bug were all verified in a browser where the fault could not occur. The page
 * logic is the same; the window size, host zoom and focus handling are not, and the
 * report that started this was against the real app.
 *
 * Not part of the build gate (needs a desktop session):
 *   node tests/edit-integrity-app.mjs
 */
import { launchApp } from './app-harness.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const PASTE = ['PASTED-A one', '', 'PASTED-B two', '', 'PASTED-C three'].join('\n');

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(2500);

    // Establish the view state instead of inheriting it. TypoZen restores the layout the
    // user left, and this suite is about the SCROLLING path: it reads mainContainer
    // .scrollTop and expects virtualisation. Started against a session saved in 2-column
    // Pages, every measurement here read 0 -- horizontal scrolling, virtualisation off --
    // and it reported four product failures that were entirely its own ambient dependency.
    await app.eval(() => handleCommand('view_set:columns:1'));
    await sleep(900);
    await app.eval(() => handleCommand('view_set:scroll:scroll'));
    await sleep(1800);

    const virt = await app.eval(() => DocumentModel.virtEnabled);
    assert(virt === true,
        'the document is virtualised and scrolling, so this suite is testing that path');
    info('virtualised: ' + virt + ', blocks: ' + await app.eval(() => DocumentModel.blocks.length));

    const rawsBefore = await app.eval(() => DocumentModel.blocks.map(b => b.raw));

    const park = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const target = Math.min(850, Math.floor(DocumentModel.blocks.length / 2));
        for (let i = 0; i < 3; i++) {
            mainContainer.scrollTop = DocumentModel.prefixHeight(target);
            await sleep(400);
        }
        const before = Math.round(mainContainer.scrollTop);
        const host = mainContainer.getBoundingClientRect();
        let el = null, firstIdx = -1;
        editor.querySelectorAll('.block').forEach(b => {
            const r = b.getBoundingClientRect();
            if (r.bottom > host.top + 2 && r.top < host.bottom && firstIdx < 0) {
                firstIdx = DocumentModel.modelIndexOfEl(b);
            }
            if (el) return;
            if (r.bottom > host.top + 80 && r.top < host.bottom
                && (b.innerText || '').trim().length > 10) el = b;
        });
        focusBlock(el, (el.innerText || '').length);
        await sleep(300);
        const sel = window.getSelection();
        const at = sel && sel.anchorNode ? getAncestorBlock(sel.anchorNode) : null;
        return {
            caretIdx: DocumentModel.modelIndexOfEl(at),
            firstIdx: firstIdx,
            scrollBefore: before,
            scrollAfterFocus: Math.round(mainContainer.scrollTop)
        };
    });

    console.log('\n=== focus does not throw the view to line 1 ===');
    info('scrollTop ' + park.scrollBefore + ' -> ' + park.scrollAfterFocus + ' after focusBlock');
    assert(park.scrollBefore > 1000 && Math.abs(park.scrollAfterFocus - park.scrollBefore) < 200,
        'focusBlock() mid-document leaves the view where it was');
    assert(park.caretIdx > 100, 'caret parked mid-document at block ' + park.caretIdx);

    console.log('\n=== paste lands at the caret and corrupts nothing ===');
    const caretRaw = await app.eval((i) => DocumentModel.blocks[i].raw, park.caretIdx);
    await app.eval((t) => insertPastedPlainText(t), PASTE);
    await sleep(1500);

    const rawsAfter = await app.eval(() => DocumentModel.blocks.map(b => b.raw));
    const p = PASTE.split('\n');
    const want = rawsBefore.slice();
    want.splice(park.caretIdx, 1, caretRaw + p[0], p[1], p[2], p[3], p[4]);
    let diff = -1;
    for (let i = 0; i < Math.max(want.length, rawsAfter.length); i++) {
        if (want[i] !== rawsAfter[i]) { diff = i; break; }
    }
    assert(diff === -1, 'the document is exactly the original with the paste spliced in');
    if (diff >= 0) {
        info('first differing block ' + diff);
        info('  got:  ' + JSON.stringify(String(rawsAfter[diff]).slice(0, 60)));
        info('  want: ' + JSON.stringify(String(want[diff]).slice(0, 60)));
    }

    const seen = await app.eval(() => {
        const host = mainContainer.getBoundingClientRect();
        let idx = -1;
        editor.querySelectorAll('.block').forEach(b => {
            if (idx >= 0) return;
            const r = b.getBoundingClientRect();
            if (r.bottom > host.top + 2 && r.top < host.bottom) idx = DocumentModel.modelIndexOfEl(b);
        });
        return { firstIdx: idx, scrollTop: Math.round(mainContainer.scrollTop) };
    });
    info('first visible block ' + park.firstIdx + ' -> ' + seen.firstIdx);
    assert(Math.abs(seen.firstIdx - park.firstIdx) <= 2,
        'the paste did not move the reader');

    console.log('\n=== undo restores the document and stays put ===');
    await app.eval(() => HistoryManager.undo());
    await sleep(2000);
    const undone = await app.eval(() => {
        const host = mainContainer.getBoundingClientRect();
        let idx = -1;
        editor.querySelectorAll('.block').forEach(b => {
            if (idx >= 0) return;
            const r = b.getBoundingClientRect();
            if (r.bottom > host.top + 2 && r.top < host.bottom) idx = DocumentModel.modelIndexOfEl(b);
        });
        return {
            firstIdx: idx,
            raws: DocumentModel.blocks.map(b => b.raw),
            stillPasted: DocumentModel.blocks.filter(b => /PASTED-/.test(b.raw || '')).length
        };
    });
    assert(undone.stillPasted === 0, 'undo removed the pasted text');
    const norm = (a) => a.join('\n').replace(/\s+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    assert(norm(undone.raws) === norm(rawsBefore), 'undo restored the original document');
    info('first visible block after undo: ' + undone.firstIdx);
    assert(undone.firstIdx > 100,
        'undo did NOT jump to line 1 (first visible block ' + undone.firstIdx + ')');
    assert(Math.abs(undone.firstIdx - park.firstIdx) <= 8,
        'undo left the reader at the edit site (' + undone.firstIdx + ' vs ' + park.firstIdx + ')');

    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.error('\nEDIT INTEGRITY (APP) FAILED'); process.exitCode = 1; }
    else console.log('\nEDIT INTEGRITY (APP) PASSED');
} finally {
    await app.close();
}
