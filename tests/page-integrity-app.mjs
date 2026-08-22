/**
 * Paging must not change the document, and must not show the wrong words.
 *
 * page-coverage-app asks whether every block was PAINTED. That is the "did I see all the
 * words" question, and it is not the only one. Under pagination the DOM holds a window --
 * 800 blocks of 3767 -- and the failure this suite exists for is the one recorded in
 * docs/for-agents.md under "the DOM is a projection; the document is DocumentModel". It
 * has bitten four times: saving wrote the window and would have discarded the rest of the
 * file, a page turn dropped text, Select All + copy put 1% of a 205,842-character file on
 * the clipboard, and Print produced a PDF of what was on screen. Every one of those is a
 * path that read the DOM and called it the document.
 *
 * So this asks three things page-coverage-app does not, all of them AFTER paging deep into
 * 2-column mode, with most of the document unmounted:
 *
 *   1. Is the document still the document -- same block count, and the SAVE payload
 *      byte-identical to what it was before a single page was turned, and still equal to
 *      the file on disk. The payload comes from getDocumentStateTagged(), which is the
 *      exact call FetchDocumentStateBlocking makes in TypoZen_App.cs, so this is the real
 *      save path's page-side half rather than a re-implementation of it.
 *   2. Did paging DIRTY a document nobody edited. A false dirty flag is not cosmetic: it
 *      arms autosave, and it makes the close prompt ask about a file that never changed.
 *   3. Is the text painted at model index i actually block i's text. A projection that
 *      paints the right NUMBER of blocks in the right order can still paint the wrong
 *      content into them, and coverage cannot see that.
 *
 * On check 3: rendering REMOVES markup and never adds text -- "## Section 61" paints as
 * "Section 61", "**bold**" as "bold". Comparing painted text against raw markdown reports
 * every heading and every list item as corrupt; the first version of this check did
 * exactly that and produced 141 false failures against correct code. Compare alphanumeric
 * signatures instead, and require the painted one to appear inside the model's. That still
 * catches the failure that matters -- block N painted with block M's words -- while a
 * bullet marker or an emphasis pair cannot trip it.
 *
 * PREMISE: the assertion that the DOM really is a window. A document that is fully mounted
 * cannot fail any of this, and a test that cannot fail is worse than no test because it
 * reads as cover.
 *
 *   RUN_APP_E2E=1 node tests/page-integrity-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = 'tests/large-scroll-mixed.md';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const onDisk = fs.readFileSync(path.join(__dirname, '..', FIXTURE), 'utf8')
    .replace(/\r\n/g, '\n').replace(/\n+$/, '');

const app = await launchApp({ file: FIXTURE, settleMs: 8000 });
await sleep(2000);

// --- baseline, before a single page is turned -------------------------------------
const before = await app.eval(() => {
    const t = getDocumentStateTagged();
    return { blocks: DocumentModel.blocks.length, md: t.slice(1), flag: t[0] };
});
info('loaded ' + before.blocks + ' blocks; save payload ' + before.md.length + ' chars');
assert(before.md.replace(/\n+$/, '') === onDisk,
    'the save payload is the file on disk before any paging (' + before.md.length + ')');

// --- into 2-column pagination and page a long way in ------------------------------
await app.eval(() => handleCommand('view_set:scroll:pagination'));
await sleep(2000);
await app.eval(() => handleCommand('view_set:columns:2'));
await sleep(2600);
await app.eval(() => PageMap.goto(0));
await sleep(1400);

const walk = await app.eval(async () => {
    const nap = (ms) => new Promise(r => setTimeout(r, ms));
    let turns = 0;
    for (let i = 0; i < 140; i++) {
        if (PageMap.step(1) === false) break;
        turns++;
        await nap(90);
    }
    const ed = document.getElementById('editor');
    return {
        turns,
        mounted: ed.querySelectorAll('.block[data-model-index]').length,
        page: PageMap.current(),
        model: DocumentModel.blocks.length
    };
});
info('turned ' + walk.turns + ' spreads to page ' + walk.page +
    '; ' + walk.mounted + ' blocks mounted of ' + walk.model);
assert(walk.turns > 60, 'the walk actually paged a long way (' + walk.turns + ')');
assert(walk.mounted < walk.model,
    'PREMISE: the DOM is a window, so these checks can fail (' +
    walk.mounted + ' of ' + walk.model + ')');

// --- 1 + 2: the document survived, and was not dirtied ----------------------------
const after = await app.eval(() => {
    const t = getDocumentStateTagged();
    return { flag: t[0], md: t.slice(1), blocks: DocumentModel.blocks.length };
});
assert(after.blocks === before.blocks,
    'block count unchanged by paging (' + before.blocks + ')');
assert(after.md === before.md,
    'save payload byte-identical after paging (' + after.md.length + ' chars)');
assert(after.md.replace(/\n+$/, '') === onDisk,
    'save payload is still the file on disk, not the mounted window');
assert(after.flag === '0',
    'paging did not mark an unedited document dirty (flag=' + after.flag + ')');

// --- 3: what is painted at index i is block i -------------------------------------
const fidelity = await app.eval(() => {
    const ed = document.getElementById('editor');
    const sig = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const bad = [];
    let checked = 0;
    for (const b of ed.querySelectorAll('.block[data-model-index]')) {
        const mi = parseInt(b.getAttribute('data-model-index'), 10);
        if (!isFinite(mi)) continue;
        const p = sig(b.innerText);
        const m = sig(DocumentModel.blockText(mi));
        // Short runs collide by chance ("2026", "notes"); they prove nothing either way.
        if (p.length < 12 || !m) continue;
        checked++;
        if (!m.includes(p) && !p.includes(m)) {
            bad.push({
                mi,
                painted: (b.innerText || '').slice(0, 45),
                model: (DocumentModel.blockText(mi) || '').slice(0, 45)
            });
        }
    }
    return { checked, badCount: bad.length, bad: bad.slice(0, 5) };
});
info('render fidelity: ' + fidelity.checked + ' painted blocks compared against the model');
assert(fidelity.checked > 5,
    'enough painted blocks for the comparison to mean anything (' + fidelity.checked + ')');
assert(fidelity.badCount === 0,
    'every painted block shows its own model text (' + fidelity.badCount + ' mismatched)' +
    (fidelity.badCount ? ' ' + JSON.stringify(fidelity.bad) : ''));

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PAGE INTEGRITY FAILED' : 'PAGE INTEGRITY PASSED');
await app.close();
process.exit(failed ? 1 : 0);
