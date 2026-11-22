/**
 * Opening a file that is already open with unsaved edits switches to its tab (2026-11-22).
 *
 * It used to ask "Reload from disk / Keep edits / Cancel" every time, even when the file on
 * disk had not changed -- so a double-click in Explorer on a file being edited raised a
 * warning about discarding work. Ed: just switch. It still asks when the file changed on disk
 * since the tab loaded or saved it; this suite checks that it does not switch then (on a
 * hidden desktop the question cannot be answered, so the tab shown stays put).
 *
 *   RUN_APP_E2E=1 node tests/reopen-open-tab-app.mjs     (~15 s, hidden desktop)
 */
import fs from 'fs';
import { launchApp, profileFile, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++; console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const A = profileFile('reopen-a.md'), B = profileFile('reopen-b.md');
fs.writeFileSync(A, '# reA\n\nalpha\n');
fs.writeFileSync(B, '# reB\n\nbeta\n');
let app;
try {
    app = await launchApp({ file: A, settleMs: 6000 });
    const shown = () => app.eval(() => getMarkdownContent(false));
    const ctrlTab = async () => {
        const p = await app.surface();
        await p.bringToFront().catch(() => { });
        await p.keyboard.down('Control'); await p.keyboard.press('Tab'); await p.keyboard.up('Control');
        await sleep(900);
    };
    await app.eval((x) => postMsg('open_file_path:' + x), B); await sleep(1500);
    await ctrlTab();
    same('Ctrl+Tab goes to A', await shown(), '# reA\n\nalpha');
    const p = await app.surface();
    const at = await p.evaluate(() => { const el = [...document.querySelectorAll('#editor .block')].find(x => x.textContent === 'alpha'); const r = el.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; });
    await p.mouse.click(at.x, at.y); await p.keyboard.press('End'); await p.keyboard.type(' TYPED'); await sleep(300);
    await ctrlTab();
    same('and back to B', await shown(), '# reB\n\nbeta');

    await app.eval((x) => postMsg('open_file_path:' + x), A); await sleep(2000);
    same('opening A again shows A with its unsaved edit, no question', await shown(), '# reA\n\nalpha TYPED');

    await ctrlTab();
    fs.writeFileSync(A, '# reA\n\nalpha CHANGED OUTSIDE\n'); await sleep(300);
    await app.eval((x) => postMsg('open_file_path:' + x), A); await sleep(2000);
    same('changed on disk: it asks first, so B is still shown', await shown(), '# reB\n\nbeta');
} finally {
    try { if (app) await app.close(); } catch (e) { }
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
