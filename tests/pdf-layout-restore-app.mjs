/**
 * A PDF tab keeps its own layout -- columns and Pages -- across a restart.
 *
 * Found by hand on 2026-09-27: a PDF read in 2-column Pages reopened as 1-column scroll.
 * The viewer held its layout in the page's memory (10-pdf.js S.cols / S.scroll), shared by
 * every PDF tab and lost on restart; the host's per-tab bag held the columns but skipped
 * PDF tabs when applying it, and had nowhere to keep Pages at all.
 *
 * The toolbar click that records a choice is a WPF button (UI Automation, visible window),
 * so this starts one step later: it writes the choice into the saved session the way that
 * click leaves it, restarts, and checks the PDF comes back laid out that way -- then that
 * closing again writes it back unchanged.
 *
 *   RUN_APP_E2E=1 node tests/pdf-layout-restore-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, profileFile } from './app-harness.mjs';
import { sleep } from './settle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(here, 'pdf-sample.pdf');
const SESSION = profileFile('tabs_session.txt');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + (detail ? '  ' + detail : '')); }
}
async function waitFor(app, fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { const v = await app.eval(fn); if (v) return v; } catch (e) { }
        await sleep(150);
    }
    return null;
}
if (process.env.RUN_APP_E2E !== '1') { console.log('PDF LAYOUT RESTORE SKIPPED (set RUN_APP_E2E=1)'); process.exit(0); }

let saved = null;
try { saved = fs.readFileSync(SESSION, 'utf8'); } catch (e) { }
const deadline = setTimeout(() => { console.error('BUDGET EXCEEDED'); process.exit(2); }, 90000);
try {
    // 1. Open the PDF so the session has a PDF tab, then close: the session is written.
    let app = await launchApp({ file: PDF, settleMs: 8000 });
    try { await waitFor(app, () => window.tzPdfState && window.tzPdfState() && window.tzPdfState().pages > 0, 10000); }
    finally { await app.close(); }
    await sleep(1200);
    let text = fs.readFileSync(SESSION, 'utf8');
    const block = text.split(/(?=\[tab \d+\])/).find(b => /pdf-sample\.pdf/i.test(b));
    ok(!!block, 'the session has the PDF tab');
    ok(block && /^scroll=/m.test(block), 'and a line for its Pages setting', block && block.slice(0, 300));

    // 2. What clicking 2-Col and Pages on that tab leaves behind, then restart.
    const chosen = block.replace(/^cols=.*$/m, 'cols=2').replace(/^scroll=.*$/m, 'scroll=pagination');
    fs.writeFileSync(SESSION, text.replace(block, chosen));
    app = await launchApp({ settleMs: 8000 });
    try {
        const st = await waitFor(app, () => {
            const s = window.tzPdfState && window.tzPdfState();
            return s && s.pages > 0 ? s : null;
        }, 15000);
        ok(!!st, 'the PDF tab is restored');
        ok(st && st.cols === 2 && st.scroll === 'pagination', 'with its own layout asked for', JSON.stringify(st));
        // PDF.js: SpreadMode.ODD = 1, ScrollMode.PAGE = 3.
        ok(st && st.spread === 1 && st.scrollMode === 3, 'and the viewer showing a two-page spread, one page at a time', JSON.stringify(st));
    } finally { await app.close(); }
    await sleep(1200);

    // 3. Closing writes it back as it was, so it survives the next restart too.
    text = fs.readFileSync(SESSION, 'utf8');
    const again = text.split(/(?=\[tab \d+\])/).find(b => /pdf-sample\.pdf/i.test(b)) || '';
    ok(/^cols=2$/m.test(again) && /^scroll=pagination$/m.test(again), 'and closing saves it again', again.slice(0, 300));
} finally {
    clearTimeout(deadline);
    try { if (saved != null) fs.writeFileSync(SESSION, saved); else fs.unlinkSync(SESSION); } catch (e) { }
}
console.log('');
console.log('passed=' + passed + ' failed=' + failed);
if (failed) { console.log('PDF LAYOUT RESTORE FAILED'); process.exit(1); }
console.log('PDF LAYOUT RESTORE PASSED');
