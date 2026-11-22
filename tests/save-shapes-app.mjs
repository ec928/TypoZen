/**
 * Saving keeps a file's shape, and leaves a read-only file alone (2026-11-22).
 *
 * - A classic Mac file (lines broken by a lone CR) opened as one line with the breaks drawn
 *   as spaces, and saving wrote the spaces: every line merged into one.
 * - Saving a read-only file wrote it anyway: the atomic write moved it aside, put the new
 *   text in its place without the read-only attribute, and left the old copy as name.old.
 *   Save now refuses (and says to use Save As); the edits stay in the window.
 *
 *   RUN_APP_E2E=1 node tests/save-shapes-app.mjs     (~15 s, hidden desktop)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { launchApp, profileFile, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++; console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

async function openEditSave(app, f, tok) {
    await app.eval((p) => postMsg('open_file_path:' + p), f);
    let ok = false;
    for (let j = 0; j < 40 && !ok; j++) {
        await sleep(100);
        try { ok = await app.eval((t) => { handleCommand('view_set:mode:source'); return sourceEditor.value.indexOf(t) >= 0; }, tok); } catch (e) { }
    }
    if (!ok) throw new Error(path.basename(f) + ' never loaded');
    await app.eval((t) => {
        const se = sourceEditor; const at = se.value.indexOf(t);
        se.setRangeText('EDITED', at, at + t.length, 'end');
        se.dispatchEvent(new Event('input', { bubbles: true }));
    }, tok);
    await sleep(400);
    await app.eval(() => postMsg('debug_save'));
    await sleep(1500);
}

const dir = path.dirname(profileFile('x'));
const ro = path.join(dir, 'shapes-readonly.md');
let app;
try {
    const first = profileFile('shapes-first.md'); fs.writeFileSync(first, '# first\n');
    app = await launchApp({ file: first, settleMs: 6000 });

    const cr = path.join(dir, 'shapes-cr.txt'); fs.writeFileSync(cr, 'a\rTOKCR\rc\r');
    await openEditSave(app, cr, 'TOKCR');
    same('a CR-only file is edited and saved with its CRs', fs.readFileSync(cr, 'utf8'), 'a\rEDITED\rc\r');

    try { execSync('attrib -R "' + ro + '"', { stdio: 'ignore' }); } catch (e) { }
    for (const s of ['', '.old', '.tmp']) { try { fs.unlinkSync(ro + s); } catch (e) { } }
    fs.writeFileSync(ro, '# ro\n\nTOKRO\n');
    execSync('attrib +R "' + ro + '"');
    await openEditSave(app, ro, 'TOKRO');
    same('a read-only file is not written', fs.readFileSync(ro, 'utf8'), '# ro\n\nTOKRO\n');
    same('and nothing is left beside it', ['.old', '.tmp'].filter(s => fs.existsSync(ro + s)).join(','), '');
    same('and the edits are still in the window, unsaved', await app.eval(() => getMarkdownContent(false) !== state.lastSavedContent), true);
} finally {
    try { execSync('attrib -R "' + ro + '"', { stdio: 'ignore' }); } catch (e) { }
    try { if (app) await app.close(); } catch (e) { }
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
