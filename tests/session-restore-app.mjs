/**
 * "Remember unsaved documents between sessions" (2026-11-22 smoke test): with it on, unsaved
 * edits to a long file come back after the app ends without the exit prompt (a crash, a power
 * cut). Exit itself always asks Save / Don't save. A 3,000-line file, an edit at line 1500,
 * not saved; the app is killed, started again, and the edit must be on screen and the file on
 * disk untouched. With the setting off, nothing comes back.
 *
 *   RUN_APP_E2E=1 node tests/session-restore-app.mjs     (~40 s, hidden desktop)
 */
import fs from 'fs';
import { launchApp, profileFile, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }
const deadline = setTimeout(() => { console.error('  FAIL over budget (150 s)'); process.exit(1); }, 150000);
let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }

const lines = [];
for (let i = 0; i < 3000; i++) lines.push(i % 3 === 2 ? '' : 'Line ' + i + ' of an ordinary paragraph of prose.');
const BASE = lines.join('\n') + '\n';
const doc = profileFile('session-restore.md');
const MARK = ' UNSAVED-EDIT-7Q';
function setFlags(flags) {
    const f = profileFile('window_state.json');
    let o = {}; try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { }
    if (!o || typeof o !== 'object') o = {};
    Object.assign(o, flags); fs.writeFileSync(f, JSON.stringify(o));
}

async function editAndKill(persistFirst) {
    fs.writeFileSync(doc, BASE);
    try { fs.unlinkSync(profileFile('tabs_session.txt')); } catch (e) { }
    let app = await launchApp({ file: doc, settleMs: 6000 });
    try {
        const page = await app.surface();
        await page.evaluate(async () => {
            const bi = 1500; goToModelBlock(bi); await new Promise(r => setTimeout(r, 250));
        });
        const at = await page.evaluate(() => { const b = document.querySelector('#editor .block[data-model-index="1500"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.right - 4, y: r.top + Math.min(r.height / 2, 10) }; });
        if (!at) { ok(false, 'line 1500 on screen'); return; }
        await page.mouse.click(at.x, at.y); await page.keyboard.press('End');
        await page.keyboard.type(MARK); await sleep(400);
        if (persistFirst) { await page.evaluate(() => postMsg('debug_persist_session')); await sleep(1500); }
    } finally { await app.close(); }   // killed: no exit prompt, as a crash or a power cut
}
async function relaunchHas() {
    const app = await launchApp({ settleMs: 7000 });
    try {
        const page = await app.surface();
        await sleep(800);
        return await page.evaluate((m) => getMarkdownContent(false).indexOf(m) >= 0, MARK);
    } finally { await app.close(); }
}

try {
    setFlags({ sessionBodies: true });
    await editAndKill(false);
    const a = await relaunchHas();
    console.log('  ..   setting on, killed straight after typing: the edit ' + (a ? 'came back' : 'did NOT come back'));
    await editAndKill(true);
    const b = await relaunchHas();
    ok(b, 'setting on, session written (as on a tab switch), then killed: the unsaved edit comes back');
    ok(fs.readFileSync(doc, 'utf8') === BASE, 'and the file on disk is untouched (the edit was never saved)');
    setFlags({ sessionBodies: false });
    await editAndKill(true);
    const c = await relaunchHas();
    ok(!c, 'setting off: the unsaved edit does not come back');
} finally {
    setFlags({ sessionBodies: false });
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
