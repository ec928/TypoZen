/**
 * A list edit reaches a block outside the mounted window, and costs no other block.
 *
 * This was a *-pending.mjs file describing behaviour that did not work, and the reason it
 * was written down rather than fixed in passing: Tab silently failed to indent a list item
 * two thirds through a document, and the obvious one-line fix -- the caller bounded a model
 * index by the number of mounted blocks -- turned a silent no-op into data loss. Removing
 * the bound let the call through to mutateDocumentMarkdown, which snapshotted the mounted
 * window and rebuilt the whole document from it: 3,766 blocks became 99.
 *
 * mutateDocumentMarkdown now mutates DocumentModel and treats the DOM as the projection it
 * is, so both halves hold: the edit lands, and nothing off screen is lost. The block count
 * assertion is the one that matters -- an indent that works while quietly discarding the
 * rest of the file would satisfy the other two.
 *
 *   RUN_APP_E2E=1 node tests/virt-list-indent-app.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(3500);
    await settledApp(app, 20000);

    const r = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const totalBefore = DocumentModel.blocks.length;
        goToModelBlock(Math.floor(totalBefore * 0.66));
        await sleep(1800);

        let bullet = null;
        for (const b of editor.querySelectorAll('.block')) {
            if (/^[-*+]\s+\S/.test(b.getAttribute('data-raw') || '')) { bullet = b; break; }
        }
        if (!bullet) return { note: 'no bullet in the mounted window' };

        const idx = DocumentModel.modelIndexOfEl(bullet);
        const was = String(DocumentModel.blocks[idx].raw);
        focusBlock(bullet, 1);
        await sleep(400);

        const selected = (typeof getSelectedBlockIndices === 'function')
            ? getSelectedBlockIndices() : [];
        editor.dispatchEvent(new KeyboardEvent('keydown',
            { key: 'Tab', bubbles: true, cancelable: true }));
        await sleep(900);

        const after = DocumentModel.blocks[idx];
        return {
            idx: idx,
            mounted: editor.querySelectorAll('.block').length,
            totalBefore: totalBefore,
            totalAfter: DocumentModel.blocks.length,
            selected: selected.slice(0, 3),
            was: was.slice(0, 26),
            now: after ? String(after.raw).slice(0, 26) : '(block gone)',
            indented: !!(after && /^\s+[-*+]/.test(String(after.raw)))
        };
    });

    if (r.note) {
        info(r.note + ' -- nothing to assert');
    } else {
        info('bullet at model index ' + r.idx + ', ' + r.mounted + ' blocks mounted of ' +
             r.totalBefore);
        info('selection reports ' + JSON.stringify(r.selected) +
             ', raw ' + JSON.stringify(r.was) + ' -> ' + JSON.stringify(r.now));

        assert(r.selected.indexOf(r.idx) >= 0,
            'the selection reports the bullet by its model index');
        assert(r.totalAfter === r.totalBefore,
            'the document keeps every block (' + r.totalBefore + ' -> ' + r.totalAfter + ')');
        assert(r.indented,
            'Tab indents a list item outside the mounted window');
    }
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'VIRT LIST INDENT FAILED' : 'VIRT LIST INDENT PASSED');
process.exit(failed ? 1 : 0);
