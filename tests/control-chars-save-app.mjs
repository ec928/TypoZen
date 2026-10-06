/**
 * Saving keeps form feed and backspace characters.
 *
 * The host reads the document back from the page as a JSON-escaped script result. Its own
 * unescape read \f and \b as the letters f and b, so saving a file that held a form feed
 * (a page break in old text and source files) or a backspace quietly changed it. Fixed in
 * 0.14.12 by using the shared JsonUnescape.
 *
 *   RUN_APP_E2E=1 node tests/control-chars-save-app.mjs     (~10 s, hidden desktop)
 */
import fs from 'fs';
import { launchApp, profileFile, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
const isDirty = (app) => app.eval(() => {
    try { return getMarkdownContent(false) !== state.lastSavedContent; } catch (e) { return null; }
});

const doc = profileFile('control-chars.md');
const before = '# Control characters\n\nPage one ends here.\n\f\nPage two, with a back\bspace in it.\n';
fs.writeFileSync(doc, before, 'utf8');

let app;
try {
    app = await launchApp({ file: doc, settleMs: 6000 });
    const EDIT = 'EDITED-' + Date.now();
    await app.eval(async (marker) => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:mode:source');
        await wait(1200);
        const se = sourceEditor;
        se.setRangeText('\n' + marker + '\n', se.value.length, se.value.length, 'end');
        se.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(900);
    }, EDIT);
    const inPage = await app.eval(() => sourceEditor.value);
    assert(inPage.includes('\f') && inPage.includes('\b'), 'the page holds both characters before saving');
    assert((await isDirty(app)) === true, 'the edit marked the document edited');

    await app.eval(() => { try { postMsg('debug_save'); } catch (e) {} });
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !fs.readFileSync(doc, 'utf8').includes(EDIT)) await sleep(200);

    const after = fs.readFileSync(doc, 'utf8');
    assert(after.includes(EDIT), 'the save reached the file');
    assert(after.includes('ends here.\n\f\nPage two'), 'the form feed is still a form feed (' + JSON.stringify(after.slice(30, 60)) + ')');
    assert(after.includes('back\bspace'), 'the backspace is still a backspace (' + JSON.stringify(after.slice(60, 100)) + ')');
    assert(!after.includes('ends here.\nf\n') && !after.includes('backbspace'), 'neither became a letter');
} catch (e) {
    failed++; console.error('  FAIL ' + e.message.split('\n')[0]);
} finally {
    if (app) await app.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('\nCONTROL CHARS SAVE APP FAILED'); process.exit(1); }
console.log('\nCONTROL CHARS SAVE APP PASSED');
process.exit(0);
