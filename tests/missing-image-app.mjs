/**
 * A missing picture is asked for once, and a present one still loads.
 *
 * The host used to ignore a request it could not serve, so the page could not tell
 * "no such file" from "reply lost" and asked again on its 400 ms rescan -- every render of
 * a document with a missing picture sent two requests. The host now answers
 * image_missing:, and the page stops asking until the next document load.
 *
 *   RUN_APP_E2E=1 node tests/missing-image-app.mjs     (~10 s, hidden desktop)
 */
import fs from 'fs';
import path from 'path';
import { launchApp, profileFile, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

// A real 1x1 PNG beside the document, and a reference to one that does not exist.
const doc = profileFile('missing-image.md');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join(path.dirname(doc), 'present-pic.png'), png);
const md = '# Pictures\n\nA present one:\n\n![here](present-pic.png)\n\nA missing one:\n\n![gone](missing-pic.png)\n\nEnd.\n';
fs.writeFileSync(doc, md, 'utf8');

let app;
try {
    app = await launchApp({ file: doc, settleMs: 6000 });
    // Count requests from here on, then render the document again.
    const r = await app.eval(async (m) => {
        const sent = [];
        const real = window.chrome.webview.postMessage.bind(window.chrome.webview);
        window.chrome.webview.postMessage = (x) => { if (String(x).startsWith('image_data_req:')) sent.push(String(x).slice(15)); return real(x); };
        handleCommand('view_set:mode:wysiwyg');
        loadMarkdownContent(m);
        await new Promise(res => setTimeout(res, 2000));
        const img = (src) => Array.from(document.querySelectorAll('#editor img')).find(i => i.getAttribute('data-src') === src);
        const present = img('present-pic.png'), missing = img('missing-pic.png');
        return {
            sent,
            presentLoaded: !!(present && /^data:image\/png/.test(present.getAttribute('src') || '') && !present.hasAttribute('data-pending')),
            missingPending: !!(missing && missing.hasAttribute('data-pending'))
        };
    }, md);
    const count = (p) => r.sent.filter(s => s === p).length;
    assert(count('missing-pic.png') === 1, 'the missing picture is asked for once (' + count('missing-pic.png') + ')');
    assert(count('present-pic.png') <= 1, 'the present one at most once (' + count('present-pic.png') + ')');
    assert(r.presentLoaded, 'and the present picture still loads');
    assert(!r.missingPending, 'the missing one is no longer waited on');
} catch (e) {
    failed++; console.error('  FAIL ' + e.message.split('\n')[0]);
} finally {
    if (app) await app.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('\nMISSING IMAGE APP FAILED'); process.exit(1); }
console.log('\nMISSING IMAGE APP PASSED');
process.exit(0);
