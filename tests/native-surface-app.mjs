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

/**
 * The View menu, read until it is whole.
 *
 * A WPF submenu is populated when it opens, so a read that lands early returns a partial
 * list -- an item simply missing, which reads as "disabled" or "absent" and is neither.
 * That flakiness had me reporting a restore bug that did not exist. Ask again until the
 * item count stops growing.
 */
async function viewMenuState(expected) {
    let best = {};
    for (let i = 0; i < 12; i++) {
        const v = ui('menu', 'View');
        const st = {};
        for (const x of (v.states || [])) st[String(x.name)] = x.enabled;
        if (Object.keys(st).length > Object.keys(best).length) best = st;
        if (Object.keys(best).length >= expected) break;
        await sleep(250);
    }
    return best;
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

        // The chrome must not reach past this tab.
        //
        // The first version of this suite checked tabs, status, disk bytes and the
        // document -- and never pressed a button. Every toolbar and menu item routes
        // "cmd:..." to the editor WebView, which is still alive behind the PDF: Toggle
        // Sidebar collapsed the sidebar of the document you were NOT looking at, silently,
        // and you found it shut on returning. About opened its modal on the hidden
        // surface, which is what "it triggers on a different tab" meant. Reported from
        // real use, on a suite that was green.
        // Pressed through the real menu, not by calling handleCommand in the page. The
        // first version of this check did the latter and failed against a working fix,
        // because the gate is host-side: the page function is downstream of it. Testing
        // the function instead of the control is how a suite misses the control.
        // Only About. Two earlier versions of this check asserted on View>Sidebar and
        // then View>Focus Mode, and BOTH read identically with the gate removed -- View
        // menu items do not reach the page on a native tab either way, so those lines
        // could never fail. Control-checked by building with the gate disabled: About is
        // the one that flips (none -> flex), so About is the one worth asserting. A green
        // line that cannot go red is worse than no line.
        ui('invoke', 'Help>About TypoZen');
        await sleep(800);
        const chrome = await app.eval(() => ({
            about: document.getElementById('aboutModal')
                ? getComputedStyle(document.getElementById('aboutModal')).display : 'none'
        }));
        info('hidden editor: about ' + chrome.about);

        // And the menus have to LOOK dead, not merely be dead. Blocking the command stops
        // the damage; a menu that still opens and responds to nothing is the other half of
        // the complaint. Edit and Help are page-routed end to end, so both go grey whole.
        const ctl = ui('controls');
        const byName = (n) => (ctl.controls || []).find(c => c.name === n || c.id === n);
        const edit = byName('Edit'), help = byName('Help'), view = byName('View');
        info('menus: Edit=' + (edit ? edit.enabled : '?')
            + ' Help=' + (help ? help.enabled : '?')
            + ' View=' + (view ? view.enabled : '?'));
        assert(edit && edit.enabled === false,
            nat.file + ': the Edit menu is greyed, not silently inert');
        assert(help && help.enabled === false,
            nat.file + ': the Help menu is greyed, not silently inert');
        // View keeps zoom, fullscreen and the rest, which still mean something here.
        assert(view && view.enabled === true,
            nat.file + ': View stays available -- zoom and fullscreen still apply');

        // Zoom has to actually zoom, twice.
        //
        // ZoomBy read the EDITOR's ZoomFactor whatever was on screen, so on an image or
        // HTML tab every press computed "the editor's zoom plus one notch": the surface
        // moved one step and then stuck. Reported exactly that way -- fine for PDFs
        // (Chromium's viewer has its own controls, which is what was being used) and fine
        // for HTML if you set the zoom on a document tab first, because the switch applies
        // it on the way in. Two presses, because one press hid the bug.
        const zoomPct = () => {
            const st = (ui('status').status || []);
            const cell = st.find(x => /%$/.test(String(x)));
            return cell ? parseInt(String(cell), 10) : NaN;
        };
        // Wait for the number to move, not for a guessed interval. A flat 500ms passed on
        // the image and failed on the PDF, where the label settles a beat later -- and a
        // sleep that works for one fixture and not another is the fault this whole suite
        // keeps rediscovering.
        const zoomAfter = async (prev) => {
            for (let i = 0; i < 20; i++) {
                const v = zoomPct();
                if (!isNaN(v) && v !== prev) return v;
                await sleep(150);
            }
            return zoomPct();
        };
        const z0 = zoomPct();
        ui('invoke', 'View>Zoom>Zoom In');
        const z1 = await zoomAfter(z0);
        ui('invoke', 'View>Zoom>Zoom In');
        const z2 = await zoomAfter(z1);
        info('zoom: ' + z0 + '% -> ' + z1 + '% -> ' + z2 + '%');
        assert(z1 > z0 && z2 > z1,
            nat.file + ': zoom advances on every press (' + z0 + '/' + z1 + '/' + z2 + ')');
        ui('invoke', 'View>Zoom>Reset Zoom'); await sleep(400);

        // Inside View, item by item. Named individually on purpose: "half of View is
        // wrong" was the report, and a count passes just as happily when the wrong half
        // is the disabled one. shell-ui reports IsEnabled per item so this is seen rather
        // than inferred -- an earlier version of this check could only prove the items
        // EXISTED, which is true whether they work or not.
        const state = await viewMenuState(16);
        const find = (frag) => {
            const k = Object.keys(state).find(n => n.indexOf(frag) >= 0);
            return k === undefined ? null : state[k];
        };
        const mustBeOff = ['Sidebar', 'Focus Mode', 'Typewriter', 'Reveal Markdown',
                           'Font Appearance', 'Spacing', 'Bookmark Gutter', 'Justified'];
        const mustBeOn = ['Scrubber', 'Status Bar', 'Zoom', 'Fullscreen', 'Reset View'];
        const wrongOff = mustBeOff.filter(f => find(f) !== false);
        const wrongOn = mustBeOn.filter(f => find(f) !== true);
        info('View: ' + (mustBeOff.length - wrongOff.length) + '/' + mustBeOff.length
            + ' greyed, ' + (mustBeOn.length - wrongOn.length) + '/' + mustBeOn.length + ' kept');
        assert(wrongOff.length === 0,
            nat.file + ': the document-shaped View items are greyed'
            + (wrongOff.length ? ' (still live: ' + wrongOff.join(', ') + ')' : ''));
        assert(wrongOn.length === 0,
            nat.file + ': the host-owned View items still work'
            + (wrongOn.length ? ' (wrongly greyed: ' + wrongOn.join(', ') + ')' : ''));
        assert(chrome.about === 'none',
            nat.file + ': About does not open behind the native surface');
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

        // Given back, not left disabled. A menu greyed on a PDF and never restored would
        // be a worse bug than the one being fixed.
        const ctlBack = ui('controls');
        const backBy = (n) => (ctlBack.controls || []).find(c => c.name === n || c.id === n);
        const editBack = backBy('Edit'), helpBack = backBy('Help');
        info('menus back: Edit=' + (editBack ? editBack.enabled : '?')
            + ' Help=' + (helpBack ? helpBack.enabled : '?'));
        assert(editBack && editBack.enabled === true, 'Edit is usable again on the document');
        assert(helpBack && helpBack.enabled === true, 'Help is usable again on the document');

        // Every View item given back, named. Fourteen items are disabled on the way in,
        // and a restore that misses one leaves a menu permanently dead for the session --
        // a worse bug than the one being fixed, and invisible until someone reaches for
        // that item. This is what pays for keeping the per-item approach over greying
        // View whole: the list is checked, not trusted.
        const backState = await viewMenuState(16);
        const stillOff = Object.keys(backState).filter(k => backState[k] === false);
        info('View after: ' + Object.keys(backState).length + ' items, still greyed: '
            + (stillOff.length ? JSON.stringify(stillOff) : 'none'));
        assert(stillOff.length === 0,
            'every View item is given back on the document'
            + (stillOff.length ? ' (left greyed: ' + stillOff.join(', ') + ')' : ''));

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
