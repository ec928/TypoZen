/**
 * A book's "Page X of Y" label tells the truth about its pictures (2026-11-22).
 *
 * A book's pictures load lazily, and the label was drawn before they had: American Gods
 * opened on "Front Matter, Page 1 of 1" with three pages of pictures there, until the next
 * key. The label now redraws when a picture loads, and while any picture in the section is
 * still loading its total carries "~", as a document's estimated total does.
 *
 * The book is made here (make-picture-epub.ps1): three full-page pictures, then a chapter.
 *
 *   RUN_APP_E2E=1 node tests/book-page-label-app.mjs        (TYPOZEN_EXE=... to test a build)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const deadline = setTimeout(() => { console.error('  FAIL over budget (90 s)'); process.exit(1); }, 90000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++;
    console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const book = path.join(os.tmpdir(), 'tz-picture-test.epub');
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'make-picture-epub.ps1'), '-Out', book]);
const app = await launchApp({ file: book, settleMs: 4000 });
try {
    try { await settledApp(app, 15000); } catch (e) {}
    for (const until = Date.now() + 30000; Date.now() < until;) {
        if (await app.eval(() => typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub' && DocumentModel.blocks.length > 0).catch(() => false)) break;
        await sleep(200);
    }
    // Every picture loaded (or given up on), then a moment for the label to follow.
    for (const until = Date.now() + 15000; Date.now() < until;) {
        if (await app.eval(() => [...document.querySelectorAll('#editor img')].every(i => i.complete)).catch(() => false)) break;
        await sleep(200);
    }
    await sleep(600);
    const read = () => app.eval(() => {
        const bp = bookPagePosition();
        const label = (document.getElementById('page-indicator').innerText || '').replace(/\s+/g, ' ').trim();
        return { label, want: bp ? bp.label + ' Page ' + bp.page + ' of ' + bp.pages : null };
    });
    const st = await read();
    console.log('  ..   label "' + st.label + '"');
    same('with the pictures loaded, the label matches the count', st.label, st.want);
    same('and no "~": nothing is still loading', st.label.indexOf('~') < 0, true);

    // The mechanism: a label drawn before a picture loaded is redrawn when it loads, with no
    // key pressed. Put a stale label in place, then make one picture load again.
    await app.eval(() => {
        document.getElementById('page-indicator').textContent = 'STALE';
        const im = document.querySelector('#editor img');
        const c = document.createElement('canvas'); c.width = 600; c.height = 900;
        const g = c.getContext('2d'); g.fillStyle = '#5a8'; g.fillRect(0, 0, 600, 900);
        im.src = c.toDataURL('image/png');
    });
    await sleep(800);
    const after = await read();
    same('a picture loading redraws the label from the count, without a key', after.label, after.want);
} finally {
    await app.close();
    try { fs.unlinkSync(book); } catch (e) {}
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
