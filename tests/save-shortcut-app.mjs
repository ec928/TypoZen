/**
 * Ctrl+S while typing saves the document in place; on a book both Ctrl+S and Ctrl+Shift+S
 * do nothing, as their menu items are greyed there. The page forwards the chord to the host,
 * which never sees keys while the editor has focus -- before 0.5.7 the shortcut did nothing.
 *
 *   RUN_APP_E2E=1 node tests/save-shortcut-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, sleep } from './app-harness.mjs';
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 90000);
let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const chord = async (page, shift) => {
    await page.keyboard.down('Control'); if (shift) await page.keyboard.down('Shift');
    await page.keyboard.press('KeyS');
    if (shift) await page.keyboard.up('Shift'); await page.keyboard.up('Control');
};
const doc = path.join(os.tmpdir(), 'tz-save-probe.md');
fs.writeFileSync(doc, '# Probe\n\nA paragraph to edit.\n');
const exportTo = path.join(os.tmpdir(), 'tz-save-probe-export.md');
try { fs.unlinkSync(exportTo); } catch (e) {}
let app = null;
try {
    app = await launchApp({ file: doc, settleMs: 8000, env: { TYPOZEN_SAVE_AS_PATH: exportTo } });
    await app.eval(() => {
        const p = Array.from(document.querySelectorAll('#editor p')).find(e => e.innerText.includes('paragraph to edit'));
        const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); p.focus && p.focus();
        document.execCommand('insertText', false, ' Saved by Ctrl+S.');
    });
    await sleep(400);
    const dirty = () => app.eval(() => getMarkdownContent(false) !== state.lastSavedContent);
    ok(await dirty(), 'document edited');
    await chord(app.page, false);
    let d = true; for (let i = 0; i < 15 && d; i++) { await sleep(200); d = await dirty(); }
    ok(!d && fs.readFileSync(doc, 'utf8').includes('Saved by Ctrl+S.'), 'Ctrl+S while typing saves the document');
    ok(!fs.existsSync(exportTo), 'and it saved in place, not through Save As');
    await app.closeGracefully(); app = null;

    app = await launchApp({ file: path.join(path.dirname(fileURLToPath(import.meta.url)), '7-Dune - Frank Herbert.epub'), settleMs: 12000, env: { TYPOZEN_SAVE_AS_PATH: exportTo } });
    await app.eval(() => { const e = document.getElementById('editor'); e.focus(); });
    await chord(app.page, false);
    await sleep(2500);
    ok(!fs.existsSync(exportTo), 'Ctrl+S on a book does nothing (Save is greyed there)');
    await chord(app.page, true);
    let made = false; for (let i = 0; i < 12 && !made; i++) { await sleep(250); made = fs.existsSync(exportTo) && fs.statSync(exportTo).size > 1000; }
    ok(!made, 'Ctrl+Shift+S on a book does nothing (Save As is greyed there too)');
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    for (const f of [doc, exportTo]) { try { fs.unlinkSync(f); } catch (e) { } }
    clearTimeout(killer);
    console.log(failed ? 'SAVE-SHORTCUT FAILED' : 'SAVE-SHORTCUT PASSED');
    process.exitCode = failed ? 1 : 0;
}
