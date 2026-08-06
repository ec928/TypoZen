/**
 * Tab does not indent a list item outside the mounted window -- and must not, yet.
 *
 * PENDING: this asserts behaviour that is not built. Opt in with RUN_PENDING_E2E=1.
 *
 * What happens today, on a 3,767-block document with the reader two thirds of the way in:
 *
 *   - getSelectedBlockIndices() correctly reports the model index of the bullet (2467)
 *   - applyListIndentToSelection() bounds that index by the number of *mounted* blocks
 *     (~99) rather than the number of blocks in the document, so nothing matches and the
 *     handler returns false
 *   - Tab therefore does nothing, silently, for any list item that is not near the top
 *
 * That looks like a one-line bug and is not. Removing the bound lets the call through to
 * mutateDocumentMarkdown, which snapshots `editor.querySelectorAll('.block')` -- the
 * mounted window -- and rebuilds the document from it. Measured: the model went from 3,766
 * blocks to 99. The bound is load-bearing by accident; it is the only thing standing
 * between a Tab keypress and losing everything not on screen.
 *
 * So the fix is in mutateDocumentMarkdown, not in its caller: it has to mutate the model
 * and treat the DOM as the projection it is. That touches formatting, the frozen selection
 * cache and undo, all of which have their own history, so it is written down here rather
 * than attempted in passing.
 *
 * When it is fixed, this file moves to *-app.mjs and the assertions below stand as they are.
 *
 *   RUN_PENDING_E2E=1 node tests/virt-list-indent-pending.mjs
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
console.log(failed ? 'VIRT LIST INDENT PENDING (expected)' : 'VIRT LIST INDENT PASSED');
// Pending: a failure here is the known state, not a regression. It exits 0 so the runner
// reports it as pending rather than red; the assertions above are the specification.
process.exit(0);
