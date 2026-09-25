/**
 * Bookmarks are never silently lost to a small cap.
 *
 * Until 0.5.8 bookmarks.txt kept 64 documents, and the order it evicted in was "the one
 * just touched, then storage order" -- after any removal not recency at all -- so the 65th
 * document dropped an arbitrary one. The same held for reading positions.
 *
 * Seeds 5,000 documents' bookmarks, adds one more through the real marks_set message, and
 * checks: all 5,000 slots are kept, the new one is first, the rest keep their order, and
 * only the least recently used falls off.
 *
 *   RUN_APP_E2E=1 node tests/marks-retention-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, profileDir } from './app-harness.mjs';

let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 60000);

const SEEDED = 5000;
const seedPath = (i) => 'C:\\Seeded\\doc-' + String(i).padStart(4, '0') + '.md';
const lines = [];
for (let i = 1; i <= SEEDED; i++) lines.push(seedPath(i) + '\t' + 'mark-payload-' + i);   // newest first
fs.writeFileSync(path.join(profileDir, 'bookmarks.txt'), lines.join('\r\n') + '\r\n');

const doc = path.join(os.tmpdir(), 'tz-marks-retention.md');
fs.writeFileSync(doc, '# Marks\n\nA paragraph.\n');
let app = null;
try {
    app = await launchApp({ file: doc, settleMs: 8000 });
    await app.eval(() => postMsg('marks_set:new-doc-payload'));
    await sleep(1500);
    const out = fs.readFileSync(path.join(profileDir, 'bookmarks.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
    ok(out.length === SEEDED, 'the file keeps ' + SEEDED + ' documents, not 64', out.length + ' lines');
    ok(out[0].startsWith(path.resolve(doc) + '\t'), 'the document just marked is first', out[0].slice(0, 60));
    ok(out[1] === lines[0] && out[2] === lines[1], 'the rest keep their order');
    ok(!out.some(l => l.startsWith(seedPath(SEEDED) + '\t')), 'only the least recently used fell off');
    ok(out.some(l => l.startsWith(seedPath(SEEDED - 1) + '\t')), 'and the one before it is still there');
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    try { fs.unlinkSync(doc); } catch (e) { }
    clearTimeout(killer);
    console.log(failed ? 'MARKS-RETENTION FAILED' : 'MARKS-RETENTION PASSED');
    process.exitCode = failed ? 1 : 0;
}
