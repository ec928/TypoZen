/**
 * Opening a file TypoZen does not edit: PDF, image, media, HTML.
 *
 * This deliberately does NOT test that Chromium can display a PDF or a PNG. It can, that
 * is not our code, and a suite asserting it would cost time and prove nothing. What is
 * ours is the plumbing either side of it: the file becomes its own tab rather than
 * replacing the document, the shell knows what kind of thing it is, the tab is read-only
 * and never written, and the document you were editing is still there when you come back.
 *
 * Nor does it read the native WebView's Source. For an image or a video the top-level
 * document genuinely IS about:blank -- that is what NavigateToString produces -- so a
 * check shaped like "did it navigate somewhere" reports a working PNG as broken. An
 * earlier audit did exactly that and logged it as a defect against 0.2.7.
 *
 *   RUN_APP_E2E=1 node tests/native-surface-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** The shell, over UI Automation -- the tab strip and status bar are not in the page. */
function ui(cmd, arg) {
    try {
        const out = execSync(
            'powershell -NoProfile -ExecutionPolicy Bypass -File tests/shell-ui.ps1 -Command ' + cmd
            + (arg === undefined ? '' : ' -Arg "' + String(arg) + '"'),
            { encoding: 'utf8', timeout: 30000, cwd: appDir });
        return JSON.parse(out.trim());
    } catch (e) { return { error: String(e.message).slice(0, 200) }; }
}

/** Poll the shell rather than sleeping at it. */
async function untilUi(cmd, pred, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    let last = null;
    while (Date.now() < deadline) {
        last = ui(cmd);
        if (pred(last)) return last;
        await sleep(200);
    }
    return last;
}

const NATIVES = [
    { file: 'native-sample.pdf', label: 'PDF' },
    { file: 'native-sample.png', label: 'Image' }
];

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 8000 });
try {
    await settledApp(app, 8000);

    const doc = await app.eval(() => ({
        blocks: DocumentModel.blocks.length, kind: DocumentModel.kind
    }));
    info('document tab: ' + doc.blocks + ' blocks, kind ' + doc.kind);
    assert(doc.kind === 'markdown' && doc.blocks > 1000,
        'control: a real document is open to come back to');

    for (const nat of NATIVES) {
        console.log('\n=== ' + nat.file + ' ===');
        const full = path.join(appDir, 'tests', nat.file);
        const before = fs.statSync(full);

        await app.eval((p) => postMsg('open_file_path:' + p), full);
        const tabs = await untilUi('tabs',
            (t) => t && t.tabs && t.tabs.some(x => x.name === nat.file), 20000);
        const names = (tabs.tabs || []).map(x => x.name);
        info('tabs: ' + JSON.stringify(names));

        // Its own tab, beside the document -- not in place of it. Opening a PDF must not
        // cost you the thing you were editing.
        assert(names.indexOf(nat.file) >= 0, nat.file + ': opens as its own tab');
        assert(names.indexOf('large-scroll-mixed.md') >= 0,
            nat.file + ': the document tab is still there');

        // The shell knows what it is. "PDF" / "Image" in the status bar is the host's
        // ClassifyNativeRole answer surfaced to the reader, and it is the only place that
        // classification is visible at all.
        const status = await untilUi('status',
            (s) => s && s.status && s.status.indexOf(nat.file) >= 0, 15000);
        info('status: ' + JSON.stringify(status.status));
        assert((status.status || []).indexOf(nat.label) >= 0,
            nat.file + ': the shell reports it as ' + nat.label);
        assert((status.status || []).indexOf('Saved') >= 0,
            nat.file + ': never dirty -- there is nothing to save');

        // The editor WebView is still alive and still holding the document. A native tab
        // is a second surface, not a replacement: if this fails, coming back from a PDF
        // means reloading whatever you had open.
        const still = await app.eval(() => ({
            blocks: DocumentModel.blocks.length, kind: DocumentModel.kind
        }));
        assert(still.kind === doc.kind && still.blocks === doc.blocks,
            nat.file + ': the document survives untouched in the editor (' +
            still.blocks + ' blocks)');

        // Read-only means read-only on disk, not just in the UI.
        const after = fs.statSync(full);
        assert(after.size === before.size && after.mtimeMs === before.mtimeMs,
            nat.file + ': the file on disk is byte-identical and untouched');
    }

    console.log('\n=== back to the document ===');
    // Click the chip, the way a reader returns -- not a command that bypasses the strip.
    const strip = ui('tabs');
    const idx = (strip.tabs || []).findIndex(x => x.name === 'large-scroll-mixed.md');
    assert(idx >= 0, 'the document tab is still listed');
    if (idx >= 0) {
        ui('click-tab', idx);
        // Wait for the whole arrival, not the first sign of it. Polling only for the
        // filename returned while the counts were still on their way, so the same file
        // passed or failed run to run -- a race invented by the test, in a product that
        // does not have one.
        const back = await untilUi('status',
            (s) => s && s.status
                && s.status.indexOf('large-scroll-mixed.md') >= 0
                && s.status.some(x => String(x).indexOf(' words') >= 0), 15000);
        info('status: ' + JSON.stringify(back.status));
        const doc2 = await app.eval(() => ({
            blocks: DocumentModel.blocks.length, kind: DocumentModel.kind,
            mounted: document.querySelectorAll('#editor .block').length
        }));
        info('editor: ' + doc2.blocks + ' blocks, ' + doc2.mounted + ' mounted');
        assert((back.status || []).indexOf('large-scroll-mixed.md') >= 0,
            'switching back lands on the document');
        assert(doc2.kind === 'markdown' && doc2.blocks === doc.blocks,
            'the whole document is still in the model (' + doc2.blocks + ')');
        assert(doc2.mounted > 0, 'and it is laid out, not left blank');
        assert((back.status || []).indexOf('Saved') >= 0,
            'the round trip did not dirty it');

        // The status bar has to come back too, not just the document.
        //
        // ShowNativeSurface writes the native kind into lblChapter and blanks the word,
        // line and character counts -- none of them mean anything for a picture. Nothing
        // put them back, so returning from an image left the bar reading "Image 100%"
        // over your document with no word count. Found by this suite on the first run.
        const kinds = ['PDF', 'Image', 'Video', 'Audio', 'Page'];
        const stale = kinds.filter(k => (back.status || []).indexOf(k) >= 0);
        assert(stale.length === 0,
            'the native kind label is gone from the status bar' +
            (stale.length ? ' (still showing ' + stale.join(', ') + ')' : ''));
        // Read from the status we already polled for. A second UI Automation query here
        // was answering empty often enough to fail a passing product -- one walk of the
        // visual tree is enough, and re-asking invents a race the app does not have.
        const wordCell = (back.status || []).filter(x => /words$/.test(String(x)));
        info('counts: ' + JSON.stringify(wordCell));
        assert(wordCell.length > 0, 'the word count is back');
    }
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('NATIVE SURFACE FAILED'); process.exit(1); }
console.log('NATIVE SURFACE PASSED');
