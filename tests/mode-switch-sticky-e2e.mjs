/**
 * Real Source ↔ Preview sticky line e2e (jsdom).
 * Asserts BOTH status Ln and on-screen visibility for a line > 1 across mode switches.
 *
 * node tests/mode-switch-sticky-e2e.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/** Inject test hooks + stats capture into the main template script. */
function patchHtml(rawHtml) {
    const scripts = [...rawHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    const main = scripts.sort((a, b) => b[1].length - a[1].length)[0];
    if (!main) throw new Error('no main script');
    const inject = `
window.__tzPostStats = [];
window.__tzTest = {
  get state() { return state; },
  get sourceEditor() { return sourceEditor; },
  get editor() { return editor; },
  get mainContainer() { return mainContainer; },
  get DocumentModel() { return DocumentModel; },
  get stickyCache() { return _stickyLineCache; },
  get lastCaret() { return _lastCaretLine; },
  get currentActiveBlock() { return currentActiveBlock; },
  setSticky: function (n) { rememberStickyLine(n); },
  capture: captureStickyDocumentLine,
  restore: restoreStickyDocumentLine,
  load: loadMarkdownContent,
  handleCommand: handleCommand,
  getCaret: getCaretLineNumber,
  updateStatsNow: updateStatsNow,
  ensureVisible: ensureModelBlockVisible,
  sourceOffsetAtHardLine: sourceOffsetAtHardLine,
  lineFromMarkdownOffset: lineFromMarkdownOffset,
  modelLocationFromDocumentLine: modelLocationFromDocumentLine,
  resizeSourceEditor: resizeSourceEditor,
  applyEditorChromeForMode: applyEditorChromeForMode
};
(function () {
  var _pm = postMsg;
  postMsg = function (m) {
    try {
      if (String(m).indexOf('stats:') === 0) window.__tzPostStats.push(String(m));
    } catch (e0) {}
    try { return _pm.apply(null, arguments); } catch (e1) {}
  };
})();
`;
    const newMain = '<script>' + main[1] + '\n' + inject + '\n</script>';
    return rawHtml.replace(main[0], newMain);
}

function lastStatusCaret() {
    const arr = globalThis.__tzWin.__tzPostStats || [];
    if (!arr.length) return null;
    const last = arr[arr.length - 1];
    // stats:words,chars,readTime,isDirty,totalLines,caretLine,...
    const body = last.slice('stats:'.length).split(',');
    return {
        raw: last,
        total: parseInt(body[4], 10) || 0,
        caret: parseInt(body[5], 10) || 0
    };
}

/**
 * Is model block for document line L inside the main-container viewport?
 * jsdom has limited layout; we set geometric stubs and check scrollTop vs prefixHeight
 * and/or getBoundingClientRect after our layout helpers.
 */
function isPreviewLineVisuallyOnScreen(t, line) {
    const mc = t.mainContainer;
    const loc = t.modelLocationFromDocumentLine(line);
    const bi = loc.blockIndex;
    const el = t.editor.querySelector('.block[data-model-index="' + bi + '"]');
    if (!el) return { ok: false, reason: 'block ' + bi + ' not mounted for line ' + line };

    // Prefer real geometry if available
    try {
        const r = el.getBoundingClientRect();
        const c = mc.getBoundingClientRect();
        // Visible if any vertical overlap with container
        const overlaps = r.bottom > c.top + 2 && r.top < c.bottom - 2;
        if (c.height > 0 && r.height >= 0) {
            return { ok: overlaps, reason: overlaps ? 'rect overlap' : 'rect off-screen top=' + r.top + ' c=[' + c.top + ',' + c.bottom + ']', bi, el };
        }
    } catch (e) {}

    // Fallback: scroll mapping (virt / height map)
    try {
        const st = mc.scrollTop || 0;
        const vh = mc.clientHeight || 600;
        t.DocumentModel.ensureHeights();
        const y0 = t.DocumentModel.prefixHeight(bi);
        const y1 = y0 + (t.DocumentModel.blockHeights[bi] || 28);
        const overlaps = y1 > st + 2 && y0 < st + vh - 2;
        return { ok: overlaps, reason: overlaps ? 'scroll map' : 'scroll map miss y=[' + y0 + ',' + y1 + '] st=' + st + ' vh=' + vh, bi, el };
    } catch (e2) {
        return { ok: false, reason: String(e2), bi, el };
    }
}

function isSourceLineVisuallyOnScreen(t, line) {
    const se = t.sourceEditor;
    const total = Math.max(1, (se.value || '').split(/\n/).length);
    const max = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
    const st = se.scrollTop || 0;
    const vh = se.clientHeight || 400;
    // Proportional mapping used by scrollSourceToHardLine
    let targetTop = 0;
    if (total > 1 && max > 0) {
        if (line >= total) targetTop = max;
        else if (line > 1) targetTop = Math.round(max * ((line - 1) / (total - 1)));
    }
    // Line is "visible" if its proportional position is within viewport scroll range
    // (caret line near targetTop). Allow half-viewport slack.
    const slack = Math.max(40, vh * 0.6);
    const ok = Math.abs(st - targetTop) <= slack || (line <= 1 && st <= slack);
    // Also require selection on that line
    const pos = se.selectionStart | 0;
    const caretLine = t.lineFromMarkdownOffset(se.value || '', pos);
    return {
        ok: ok && caretLine === line,
        reason: 'src scrollTop=' + st + ' target=' + targetTop + ' caretLine=' + caretLine + ' sel=' + pos,
        caretLine
    };
}

function layoutStubs(window) {
    const ROW = 28;
    const VIEW_H = 600;
    const VIEW_W = 800;

    // main-container geometry
    const mc = window.document.getElementById('main-container');
    const se = window.document.getElementById('source-editor');
    const ed = window.document.getElementById('editor');

    function stubRect(el, top, height, left, width) {
        el.getBoundingClientRect = function () {
            return {
                top: top, bottom: top + height, left: left || 0, right: (left || 0) + (width || VIEW_W),
                width: width || VIEW_W, height: height,
                x: left || 0, y: top
            };
        };
    }

    if (mc) {
        Object.defineProperty(mc, 'clientHeight', { get: () => VIEW_H, configurable: true });
        Object.defineProperty(mc, 'clientWidth', { get: () => VIEW_W, configurable: true });
        Object.defineProperty(mc, 'scrollHeight', {
            get: function () {
                try {
                    const DM = window.__tzTest.DocumentModel;
                    if (DM && DM.virtEnabled) return Math.max(VIEW_H, DM.totalHeight());
                } catch (e) {}
                return Math.max(VIEW_H, (this._scrollHeight | 0) || 5000);
            },
            configurable: true
        });
        let _st = 0;
        Object.defineProperty(mc, 'scrollTop', {
            get: () => _st,
            set: (v) => { _st = Math.max(0, v | 0); },
            configurable: true
        });
        stubRect(mc, 80, VIEW_H, 0, VIEW_W);
    }

    if (se) {
        Object.defineProperty(se, 'clientHeight', { get: () => VIEW_H - 48, configurable: true });
        Object.defineProperty(se, 'clientWidth', { get: () => VIEW_W, configurable: true });
        Object.defineProperty(se, 'scrollHeight', {
            get: function () {
                const n = Math.max(1, (this.value || '').split(/\n/).length);
                return Math.max(this.clientHeight, n * ROW);
            },
            configurable: true
        });
        let _sst = 0;
        Object.defineProperty(se, 'scrollTop', {
            get: () => _sst,
            set: (v) => { _sst = Math.max(0, v | 0); },
            configurable: true
        });
        // focus helpers
        se.focus = function () { window.document.activeElement = se; };
    }

    // Blocks: after mount, override getBoundingClientRect based on model index + scroll
    const origQS = ed && ed.querySelector.bind(ed);
    // Patch Element prototype for .block nodes when measured
    const _origGBCR = window.Element.prototype.getBoundingClientRect;
    window.Element.prototype.getBoundingClientRect = function () {
        if (this.classList && this.classList.contains('block') && mc) {
            const mi = parseInt(this.getAttribute('data-model-index') || '-1', 10);
            const st = mc.scrollTop || 0;
            let yDoc = mi * ROW;
            try {
                const DM = window.__tzTest && window.__tzTest.DocumentModel;
                if (DM && DM.blocks) {
                    DM.ensureHeights();
                    yDoc = DM.prefixHeight(mi);
                }
            } catch (e) {}
            const top = 80 + (yDoc - st); // mc top = 80
            const h = ROW;
            return {
                top: top, bottom: top + h, left: 64, right: VIEW_W - 64,
                width: VIEW_W - 128, height: h, x: 64, y: top
            };
        }
        if (this.id === 'main-container') {
            return { top: 80, bottom: 80 + VIEW_H, left: 0, right: VIEW_W, width: VIEW_W, height: VIEW_H, x: 0, y: 80 };
        }
        return _origGBCR.apply(this, arguments);
    };

    // offsetHeight for blocks
    Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
        get: function () {
            if (this.classList && this.classList.contains('block')) return ROW;
            if (this.classList && this.classList.contains('virt-spacer')) {
                const h = parseInt((this.style && this.style.height) || '0', 10);
                return h || 0;
            }
            return this.clientHeight || 0;
        },
        configurable: true
    });
}

async function boot() {
    const patched = patchHtml(html);
    const dom = new JSDOM(patched, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        url: 'http://localhost/TypoZen_Template_Test.html',
        beforeParse(window) {
            const listeners = {};
            window.chrome = {
                webview: {
                    postMessage: function () {},
                    addEventListener: function (type, fn) {
                        (listeners[type] || (listeners[type] = [])).push(fn);
                    },
                    removeEventListener: function () {},
                    hostObjects: {}
                }
            };
        }
    });
    // let scripts run
    await sleep(30);
    const w = dom.window;
    globalThis.__tzWin = w;
    if (!w.__tzTest) throw new Error('__tzTest hook missing — inject failed');
    layoutStubs(w);
    // activeElement writable
    try {
        Object.defineProperty(w.document, 'activeElement', {
            get: function () { return w.document._active || w.document.body; },
            set: function (v) { w.document._active = v; },
            configurable: true
        });
    } catch (e) {}
    return w.__tzTest;
}

function buildDoc(nLines) {
    const lines = [];
    for (let i = 1; i <= nLines; i++) lines.push('row content ' + i);
    return lines.join('\n');
}

async function putSourceOnLine(t, w, md, line) {
    t.state.mode = 'source';
    t.sourceEditor.style.display = 'block';
    t.editor.style.display = 'none';
    t.sourceEditor.value = md;
    try { t.applyEditorChromeForMode(); } catch (e) {}
    try { t.resizeSourceEditor(); } catch (e) {}
    const pos = t.sourceOffsetAtHardLine(md, line);
    w.document.activeElement = t.sourceEditor;
    try { t.sourceEditor.focus(); } catch (e) {}
    t.sourceEditor.setSelectionRange(pos, pos);
    t.setSticky(line);
    t.updateStatsNow();
}

/**
 * Drive the editor to a specific mode with toggle_mode.
 *
 * toggle_mode is no longer a two-way Preview<->Source switch: since Reader landed it
 * cycles wysiwyg -> reader -> source -> wysiwyg, so a single toggle out of Preview now
 * stops in Reader. Asserting on mode after a fixed number of toggles is brittle -- and
 * Phase 3A replaces this toggle with a [Source | Preview | Reader] segmented control
 * anyway. Cycle until the requested mode is reached instead.
 */
async function toMode(t, target, sleepMs) {
    for (let i = 0; i < 4 && t.state.mode !== target; i++) {
        t.handleCommand('toggle_mode');
        await sleep(sleepMs || 80);
    }
    return t.state.mode;
}

function simulateWpfFocusSteal(t, w) {
    // Host chrome button steals focus; many WebViews zero selectionStart
    w.document.activeElement = w.document.body;
    try { t.sourceEditor.setSelectionRange(0, 0); } catch (e) {
        try { t.sourceEditor.selectionStart = 0; t.sourceEditor.selectionEnd = 0; } catch (e2) {}
    }
}

async function main() {
    console.log('=== boot editor ===');
    const t = await boot();
    const w = globalThis.__tzWin;
    assert(!!t.handleCommand, 'handleCommand available');
    assert(!!t.sourceEditor, 'sourceEditor available');

    const TARGET = 16;
    const md = buildDoc(80); // small enough for non-virt + large enough for L16
    // Also a large doc path
    const mdLarge = buildDoc(2500); // triggers virt (blocks >= 2000)

    console.log('\n=== Case A: source L' + TARGET + ' → preview (status + visible) ===');
    await putSourceOnLine(t, w, md, TARGET);
    let st = lastStatusCaret();
    assert(st && st.caret === TARGET, 'status on source before switch is Ln ' + TARGET + ' (got ' + (st && st.caret) + ')');
    assert(t.stickyCache === TARGET, 'sticky cache is ' + TARGET + ' (got ' + t.stickyCache + ')');
    let vis = isSourceLineVisuallyOnScreen(t, TARGET);
    // After putSourceOnLine, scroll may not have run — force restore once
    t.restore(TARGET);
    await sleep(20);
    vis = isSourceLineVisuallyOnScreen(t, TARGET);
    assert(vis.ok, 'source L' + TARGET + ' visible before switch (' + vis.reason + ')');

    // Real host path: focus steal then toggle
    simulateWpfFocusSteal(t, w);
    const cap = t.capture();
    assert(cap === TARGET, 'capture after focus-steal still ' + TARGET + ' (got ' + cap + ')');

    t.handleCommand('toggle_mode');
    await sleep(80); // rAF double restore

    assert(t.state.mode === 'wysiwyg', 'mode is preview/wysiwyg after toggle');
    st = lastStatusCaret();
    assert(st && st.caret === TARGET,
        'STATUS after source→preview is Ln ' + TARGET + ' (got ' + (st && st.caret) + ' raw=' + (st && st.raw) + ')');
    assert(t.stickyCache === TARGET, 'sticky cache still ' + TARGET + ' after →preview (got ' + t.stickyCache + ')');
    assert(t.getCaret() === TARGET, 'getCaretLineNumber is ' + TARGET + ' (got ' + t.getCaret() + ')');
    vis = isPreviewLineVisuallyOnScreen(t, TARGET);
    assert(vis.ok, 'VISIBLE on preview: L' + TARGET + ' on screen (' + vis.reason + ')');

    console.log('\n=== Case B: preview L' + TARGET + ' → source (status + visible) ===');
    // Stay on preview, re-assert sticky, switch back
    t.setSticky(TARGET);
    simulateWpfFocusSteal(t, w); // steal from editor
    await toMode(t, 'source');

    assert(t.state.mode === 'source', 'mode is source after toggle back');
    st = lastStatusCaret();
    assert(st && st.caret === TARGET,
        'STATUS after preview→source is Ln ' + TARGET + ' (got ' + (st && st.caret) + ')');
    vis = isSourceLineVisuallyOnScreen(t, TARGET);
    assert(vis.ok, 'VISIBLE on source: L' + TARGET + ' on screen (' + vis.reason + ')');

    console.log('\n=== Case C: round-trip 3x stays on L' + TARGET + ' ===');
    for (let i = 0; i < 3; i++) {
        simulateWpfFocusSteal(t, w);
        t.handleCommand('toggle_mode');
        await sleep(80);
        st = lastStatusCaret();
        const mode = t.state.mode;
        const caretOk = st && st.caret === TARGET;
        let v;
        if (mode === 'source') v = isSourceLineVisuallyOnScreen(t, TARGET);
        else v = isPreviewLineVisuallyOnScreen(t, TARGET);
        assert(caretOk, 'round ' + (i + 1) + ' ' + mode + ' status Ln ' + TARGET + ' (got ' + (st && st.caret) + ')');
        assert(v.ok, 'round ' + (i + 1) + ' ' + mode + ' L' + TARGET + ' visible (' + v.reason + ')');
    }

    console.log('\n=== Case D: large doc virt path L' + TARGET + ' source→preview→source ===');
    await putSourceOnLine(t, w, mdLarge, TARGET);
    t.restore(TARGET);
    await sleep(20);
    simulateWpfFocusSteal(t, w);
    assert(t.capture() === TARGET, 'large: capture after steal is ' + TARGET);
    t.handleCommand('toggle_mode');
    await sleep(100);
    assert(t.state.mode === 'wysiwyg', 'large: preview mode');
    st = lastStatusCaret();
    assert(st && st.caret === TARGET, 'large STATUS preview Ln ' + TARGET + ' (got ' + (st && st.caret) + ')');
    vis = isPreviewLineVisuallyOnScreen(t, TARGET);
    assert(vis.ok, 'large VISIBLE preview L' + TARGET + ' (' + vis.reason + ')');
    // and back
    simulateWpfFocusSteal(t, w);
    await toMode(t, 'source', 100);
    st = lastStatusCaret();
    assert(t.state.mode === 'source', 'large: back to source');
    assert(st && st.caret === TARGET, 'large STATUS source Ln ' + TARGET + ' (got ' + (st && st.caret) + ')');
    vis = isSourceLineVisuallyOnScreen(t, TARGET);
    assert(vis.ok, 'large VISIBLE source L' + TARGET + ' (' + vis.reason + ')');

    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) {
        console.error('\nMODE SWITCH STICKY E2E FAILED');
        process.exit(1);
    }
    console.log('\nMODE SWITCH STICKY E2E PASSED');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
