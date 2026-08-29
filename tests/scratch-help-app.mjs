/**
 * Empty new tab is empty, and F1 / Help → Syntax & Shortcuts actually opens.
 *
 * Two defects that looked like "the editor is junk":
 *   1. New Tab injected placeholder markdown; the CSS hint lived on .block::before
 *      (the 10px gutter), innerText captured it on tab switch.
 *   2. F1 was painted on that hint and in the Help menu, but only F7/F8/F9 were
 *      bound in the page, and Window.KeyDown never runs while the WebView has
 *      focus, so the key did nothing.
 *
 *   RUN_APP_E2E=1 node tests/scratch-help-app.mjs
 */
import { execSync } from 'child_process';
import path from 'path';
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

function ui(cmd, arg) {
    try {
        const out = execSync(
            'powershell -NoProfile -ExecutionPolicy Bypass -File tests/shell-ui.ps1 -Command ' + cmd
            + (arg === undefined ? '' : ' -Arg "' + String(arg) + '"'),
            { encoding: 'utf8', timeout: 30000, cwd: appDir });
        return JSON.parse(out.trim());
    } catch (e) { return { error: String(e.message).slice(0, 200) }; }
}

function overlayState() {
    const m = document.getElementById('helpModal');
    if (!m) return { exists: false };
    const cs = getComputedStyle(m);
    return {
        exists: true,
        open: m.classList.contains('open') && !m.hasAttribute('hidden'),
        display: cs.display,
        title: ((document.getElementById('helpTitle') || {}).textContent || '').trim()
    };
}

function docState() {
    const wrap = document.getElementById('editor-wrapper');
    const md = (typeof getMarkdownContent === 'function') ? getMarkdownContent(false) : '';
    const raw0 = (DocumentModel.blocks[0] && DocumentModel.blocks[0].raw) || '';
    const inner = (document.getElementById('editor') && document.getElementById('editor').innerText) || '';
    return {
        md: md,
        raw0: raw0,
        inner: inner,
        scratchEmpty: !!(wrap && wrap.classList.contains('scratch-empty')),
        hintInMd: /Start typing/i.test(md) || /Untitled Document/i.test(md),
        hintInInner: /Start typing/i.test(inner)
    };
}

console.log('\n=== empty scratch + F1 help, against TypoZen.exe ===');
const app = await launchApp({ view: true });
try {
    await settledApp(app, 15000);

    await app.eval(() => {
        if (typeof loadMarkdownContent === 'function')
            loadMarkdownContent('', { replaceBook: true });
    });
    await settledApp(app, 8000);

    let d = await app.eval(docState);
    assert(String(d.md || '').trim() === '', 'new scratch serializes to empty markdown');
    assert(!d.hintInMd, 'serialized markdown is not the Start typing / Untitled hint');
    assert(String(d.raw0 || '').trim() === '', 'block 0 data-raw is empty');
    assert(!d.hintInInner, 'editor innerText does not contain the hint (wrapper overlay, not ::before)');
    assert(d.scratchEmpty, 'scratch-empty class is on so the painted hint can show');

    // Host command the Help menu posts.
    await app.eval(() => handleCommand('help_syntax'));
    await sleep(200);
    let h = await app.eval(overlayState);
    assert(h.exists, '#helpModal is in the hosted page');
    assert(h.open, 'Help → Syntax & Shortcuts opens the overlay (class open, not hidden)');
    assert(h.display === 'flex', 'the overlay is visible, not display:none (got ' + h.display + ')');
    assert(/Syntax/i.test(h.title || ''), 'title is Syntax & Shortcuts (got ' + JSON.stringify(h.title) + ')');

    d = await app.eval(docState);
    assert(String(d.md || '').trim() === '', 'opening help does not write the hint into the document');

    await app.eval(() => { if (typeof closeTzOverlay === 'function') closeTzOverlay('helpModal'); });
    await sleep(150);

    // Real F1 into the window (Win32), not CDP into the page. That is the path
    // a person pressing the key takes, and the one the host filter exists for.
    const sent = ui('keys', '{F1}');
    assert(!sent.error, 'shell-ui accepted {F1} (got ' + JSON.stringify(sent) + ')');
    for (let i = 0; i < 20 && !(h && h.open && h.display === 'flex'); i++) {
        await sleep(100);
        h = await app.eval(overlayState);
    }
    assert(h && h.open && h.display === 'flex',
        'F1 as a real keystroke opens the visible Syntax overlay (got ' + JSON.stringify(h) + ')');

    // Type after closing. The document must be what was typed, not the hint.
    await app.eval(() => { if (typeof closeTzOverlay === 'function') closeTzOverlay('helpModal'); });
    await sleep(150);
    await app.eval(() => {
        const el = editor && editor.querySelector('.block');
        if (el && typeof focusBlock === 'function') focusBlock(el, 0);
    });
    await app.press('a');
    await app.press('b');
    await app.press('c');
    await settledApp(app, 8000);
    d = await app.eval(docState);
    assert(/abc/i.test(d.md || d.raw0 || ''),
        'typing into the empty scratch stores the typed text (got ' + JSON.stringify((d.md || '').slice(0, 80)) + ')');
    assert(!d.hintInMd, 'typed document is still not the hint sentence');
} finally {
    try { await app.close(); } catch (e) {}
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('SCRATCH HELP APP FAILED');
    process.exit(1);
}
console.log('SCRATCH HELP APP PASSED');
