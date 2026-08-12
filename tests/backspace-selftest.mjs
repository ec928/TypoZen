/**
 * Automated Backspace regression tests (list 2-stage + dual-event lock).
 *
 * Simulates WebView: one physical Backspace → keydown + beforeinput.
 * Uses production helpers extracted from TypoZen_Template_Test.html.
 *
 * Run: node tests/backspace-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

function extractFunction(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        if (mainScript[i] === '{') depth++;
        else if (mainScript[i] === '}') {
            depth--;
            if (depth === 0) return mainScript.slice(idx, i + 1);
        }
    }
    throw new Error('unclosed ' + name);
}

const dom = new JSDOM(`<!DOCTYPE html><html><body>
<div id="editor" contenteditable="true"></div>
</body></html>`, { url: 'https://localapp/test', pretendToBeVisual: true });

const { window } = dom;
const { document } = window;
global.window = window;
global.document = document;
global.Node = window.Node;
global.NodeFilter = window.NodeFilter;
global.Range = window.Range;
global.getSelection = () => window.getSelection();

const editor = document.getElementById('editor');
const state = { mode: 'wysiwyg', revealOnFocus: false };
const HistoryManager = {
    beginEdit() {},
    commitEdit() {},
    snapshot() {},
    isRestoring: false
};

function getAncestorBlock(node) {
    let n = node;
    while (n && n !== editor) {
        if (n.classList && n.classList.contains('block')) return n;
        n = n.parentNode;
    }
    return null;
}

function setCaretAtOffset(el, targetOffset) {
    const sel = window.getSelection();
    const range = document.createRange();
    const textHost = el.querySelector('li, p, .task-text') || el;
    const walker = document.createTreeWalker(textHost, window.NodeFilter.SHOW_TEXT, null);
    const textNode = walker.nextNode();
    if (textNode) {
        const off = Math.min(Math.max(0, targetOffset), textNode.nodeValue.length);
        range.setStart(textNode, off);
        range.collapse(true);
    } else {
        range.selectNodeContents(textHost);
        range.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(range);
}

function placeCaretStart(block) {
    const sel = window.getSelection();
    const range = document.createRange();
    const host = block.querySelector('li, p, .task-text') || block;
    // Prefer first text node; if missing, insert one so selection is real
    let textNode = null;
    const walker = document.createTreeWalker(host, window.NodeFilter.SHOW_TEXT, null);
    textNode = walker.nextNode();
    if (!textNode) {
        textNode = document.createTextNode('');
        host.appendChild(textNode);
    }
    range.setStart(textNode, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
}

function updateStats() {}
function updateOutline() {}

function getBlockRaw(block) {
    if (!block) return '';
    const raw = block.getAttribute('data-raw');
    if (raw != null && raw !== '') return normalizeBlockRaw(raw);
    return normalizeBlockRaw(block.textContent || '');
}

// Evaluate production functions in a sandbox with our stubs
const fnList = [
    'parseListLine',
    'formatListLine',
    'indentListLine',
    'isListLine',
    'normalizeBlockRaw',
    'isMultilineBlockRaw',
    'coerceBlockRaw',
    'listIndentPad',
    'setBlockListIndentAttr',
    'resolveListAwareRaw',
    'isCaretAtStartOfBlock',
    'handleListBackspaceAtStart',
    'isListBackspaceLocked',
    'writeBlockRaw'
];

let code = `
const LIST_MAX_INDENT = 6;
const LIST_INDENT_SPACES = 2;
let _listBackspaceLockUntil = 0;
const state = __state;
const HistoryManager = __hm;
const editor = __editor;
const getAncestorBlock = __gab;
const setCaretAtOffset = __sca;
const updateStats = __us;
const updateOutline = __uo;
let getBlockRaw = __gbr;
// Reveal-on-focus is off for a code document, and these extracted functions ask.
// Stubbed here because this sandbox runs them without DocumentModel: the suite is
// about list backspace, and 'is reveal active' is not part of what it exercises.
function revealOnFocusActive() { return !!state.revealOnFocus; }
`;

for (const n of fnList) {
    code += '\n' + extractFunction(n) + '\n';
}

// Minimal render (production writeBlockRaw calls renderBlockPreview)
code += `
function clearListIndentClasses(block) {
    if (!block || !block.classList) return;
    block.classList.remove('list-block');
    for (let i = 0; i <= LIST_MAX_INDENT; i++) block.classList.remove('list-indent-' + i);
}
function renderBlockPreview(block, rawInput) {
    const raw = rawInput != null ? rawInput : (block.getAttribute('data-raw') || '');
    clearListIndentClasses(block);
    setBlockListIndentAttr(block, raw);
    if (!String(raw).trim()) { block.innerHTML = ''; return; }
    const list = parseListLine(raw);
    if (list) {
        block.classList.add('list-block');
        if (list.indent > 0) block.classList.add('list-indent-' + list.indent);
        if (list.kind === 'ol') {
            block.innerHTML = '<ol start="'+list.num+'"><li value="'+list.num+'">'+(list.body||'')+'</li></ol>';
        } else if (list.kind === 'task') {
            block.innerHTML = '<ul class="task-list"><li class="task-list-item"><span class="task-text">'+(list.body||'')+'</span></li></ul>';
        } else {
            block.innerHTML = '<ul><li>'+(list.body||'')+'</li></ul>';
        }
        return;
    }
    block.innerHTML = '<p>'+String(raw).replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</p>';
}

function onEditorListBackspaceCapture(e) {
    if (e.isComposing) return;
    if (state.mode === 'source') return;
    const isBackspaceKey = e.type === 'keydown' && e.key === 'Backspace';
    const isBackspaceInput = e.type === 'beforeinput' && e.inputType === 'deleteContentBackward';
    if (!isBackspaceKey && !isBackspaceInput) return;

    if (isListBackspaceLocked()) {
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        return;
    }

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
    if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;

    const block = getAncestorBlock(sel.anchorNode);
    if (!block) return;
    if (!handleListBackspaceAtStart(block)) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
}

function mergeWithPrevious(block) {
    const prev = block.previousElementSibling;
    if (!prev || !prev.classList.contains('block')) return false;
    const prevRaw = prev.getAttribute('data-raw') || '';
    const curRaw = block.getAttribute('data-raw') || '';
    writeBlockRaw(prev, prevRaw + curRaw);
    block.remove();
    return true;
}

function docLines() {
    return Array.from(editor.querySelectorAll('.block')).map(b => b.getAttribute('data-raw') || '');
}

function addBlock(raw) {
    const b = document.createElement('div');
    b.className = 'block';
    writeBlockRaw(b, raw);
    editor.appendChild(b);
    return b;
}

return {
    parseListLine, formatListLine, indentListLine, coerceBlockRaw, normalizeBlockRaw,
    resolveListAwareRaw, isCaretAtStartOfBlock, handleListBackspaceAtStart, isListBackspaceLocked,
    writeBlockRaw, onEditorListBackspaceCapture, mergeWithPrevious, docLines, addBlock,
    get _listBackspaceLockUntil() { return _listBackspaceLockUntil; },
    set _listBackspaceLockUntil(v) { _listBackspaceLockUntil = v; }
};
`;

// Allow getBlockRaw to call normalizeBlockRaw after functions exist — wire in returned API
const factory = new Function(
    '__state', '__hm', '__editor', '__gab', '__sca', '__us', '__uo', '__gbr',
    code.replace('let getBlockRaw = __gbr;', 'const getBlockRaw = __gbr;')
);

// Temporary getBlockRaw using simple attr read until normalize exists — final uses production resolve
function getBlockRawSimple(block) {
    if (!block) return '';
    const raw = block.getAttribute('data-raw');
    if (raw != null && raw !== '') return String(raw);
    return String(block.textContent || '');
}

const api = factory(
    state,
    HistoryManager,
    editor,
    getAncestorBlock,
    setCaretAtOffset,
    updateStats,
    updateOutline,
    getBlockRawSimple
);

/** Simulate one physical Backspace: keydown then beforeinput (WebView). */
function runPhysicalBackspace() {
    const keyEv = {
        type: 'keydown',
        key: 'Backspace',
        isComposing: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
        stopImmediatePropagation() {}
    };
    api.onEditorListBackspaceCapture(keyEv);

    const beforeEv = {
        type: 'beforeinput',
        inputType: 'deleteContentBackward',
        isComposing: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
        stopImmediatePropagation() {}
    };
    api.onEditorListBackspaceCapture(beforeEv);

    // Browser merge only if NOT locked and delete not prevented on beforeinput
    // (models the real failure: strip on keydown, merge on beforeinput)
    let browserMerged = false;
    const sel = window.getSelection();
    const block = sel && sel.anchorNode ? getAncestorBlock(sel.anchorNode) : null;
    if (
        block &&
        document.body.contains(block) &&
        api.isCaretAtStartOfBlock(block) &&
        !api.isListBackspaceLocked() &&
        !beforeEv.defaultPrevented
    ) {
        api.mergeWithPrevious(block);
        browserMerged = true;
    }

    return {
        keyPrevented: keyEv.defaultPrevented,
        beforePrevented: beforeEv.defaultPrevented,
        locked: api.isListBackspaceLocked(),
        browserMerged,
        lines: api.docLines()
    };
}

function expireLock() {
    api._listBackspaceLockUntil = 0;
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) {
        passed++;
        console.log('  OK  ', msg);
    } else {
        failed++;
        console.error('  FAIL', msg);
    }
}

console.log('\n=== Backspace: ordered list 2-stage (111 / 1. hello) ===');
{
    expireLock();
    editor.innerHTML = '';
    api.addBlock('111');
    const listBlock = api.addBlock('1. hello');
    placeCaretStart(listBlock);

    assert(api.isCaretAtStartOfBlock(listBlock), 'caret at start of list block');
    assert(api.parseListLine(api.resolveListAwareRaw(listBlock))?.kind === 'ol', 'resolved as ordered list');

    // Stage 1
    const r1 = runPhysicalBackspace();
    assert(r1.keyPrevented === true, 'stage1 keydown prevented');
    assert(r1.beforePrevented === true, 'stage1 beforeinput prevented (lock)');
    assert(r1.locked === true, 'stage1 lock active');
    assert(r1.browserMerged === false, 'stage1 NO browser merge');
    assert(r1.lines.length === 2, `stage1 still 2 blocks (got ${r1.lines.length}: ${JSON.stringify(r1.lines)})`);
    assert(r1.lines[0] === '111', 'stage1 first line 111');
    assert(r1.lines[1] === 'hello', `stage1 second line hello (got ${JSON.stringify(r1.lines[1])})`);
    assert(r1.lines.join('|') !== '111hello', 'stage1 not merged into one line');

    // Stage 2 after lock expires
    expireLock();
    const helloBlock = editor.querySelectorAll('.block')[1];
    placeCaretStart(helloBlock);
    assert(!api.parseListLine(helloBlock.getAttribute('data-raw')), 'stage2 target is plain hello');

    // Capture should not treat as list
    const key2 = {
        type: 'keydown', key: 'Backspace', isComposing: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {}
    };
    api.onEditorListBackspaceCapture(key2);
    assert(!key2.defaultPrevented, 'stage2 not handled as list strip');

    // Plain merge (block handler path)
    api.mergeWithPrevious(helloBlock);
    const lines2 = api.docLines();
    assert(lines2.length === 1, 'stage2 one block after merge');
    assert(lines2[0] === '111hello', `stage2 merged 111hello (got ${JSON.stringify(lines2[0])})`);
}

console.log('\n=== Backspace: dual-event lock swallows second event ===');
{
    expireLock();
    editor.innerHTML = '';
    api.addBlock('111');
    const b1 = api.addBlock('1. hello');
    placeCaretStart(b1);

    const first = api.handleListBackspaceAtStart(b1);
    assert(first === true, 'handle strips list');
    assert(b1.getAttribute('data-raw') === 'hello', 'raw is hello after strip');
    assert(api.isListBackspaceLocked(), 'lock set');

    // Second event while locked
    const beforeEv = {
        type: 'beforeinput', inputType: 'deleteContentBackward', isComposing: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {}
    };
    api.onEditorListBackspaceCapture(beforeEv);
    assert(beforeEv.defaultPrevented, 'locked beforeinput prevented');
    assert(api.docLines().join('|') === '111|hello', 'still two lines — no merge');
}

console.log('\n=== Backspace: without lock, dual event would merge (documents bug) ===');
{
    expireLock();
    editor.innerHTML = '';
    api.addBlock('111');
    const b1 = api.addBlock('1. hello');
    placeCaretStart(b1);

    // Strip without going through lock path manually
    const p = api.parseListLine('1. hello');
    api.writeBlockRaw(b1, p.body);
    expireLock(); // force no lock
    placeCaretStart(b1);

    // beforeinput not prevented → browser merge
    const beforeEv = {
        type: 'beforeinput', inputType: 'deleteContentBackward', isComposing: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {}
    };
    // capture does nothing useful (not a list anymore, not locked)
    api.onEditorListBackspaceCapture(beforeEv);
    if (!beforeEv.defaultPrevented && api.isCaretAtStartOfBlock(b1)) {
        api.mergeWithPrevious(b1);
    }
    assert(api.docLines()[0] === '111hello', 'documents merge failure mode without lock');
}

console.log('\n=== Backspace: bullet strip ===');
{
    expireLock();
    editor.innerHTML = '';
    api.addBlock('aaa');
    const b1 = api.addBlock('- item');
    placeCaretStart(b1);
    const r = runPhysicalBackspace();
    assert(r.lines[0] === 'aaa' && r.lines[1] === 'item', 'bullet strip keeps two blocks');
    assert(!r.browserMerged, 'no merge on bullet strip');
}

console.log('\n=== Backspace: nested outdent ===');
{
    expireLock();
    editor.innerHTML = '';
    api.addBlock('- parent');
    const b1 = api.addBlock('  - child');
    placeCaretStart(b1);
    assert(api.isCaretAtStartOfBlock(b1), 'caret at start of nested list');
    const before = api.resolveListAwareRaw(b1);
    assert(api.parseListLine(before)?.indent === 1, `nested indent 1 before (raw=${JSON.stringify(before)})`);
    const r = runPhysicalBackspace();
    assert(r.lines.length === 2, 'outdent keeps 2 blocks');
    assert(r.lines[1] === '- child', `outdent to level 0 (got ${JSON.stringify(r.lines[1])})`);
    assert(api.parseListLine(r.lines[1])?.indent === 0, 'indent level 0');
}

console.log('\n=== Backspace: reconstruct from stale data-raw + <ol> ===');
{
    expireLock();
    editor.innerHTML = '';
    api.addBlock('111');
    const b1 = document.createElement('div');
    b1.className = 'block';
    b1.setAttribute('data-raw', 'hello'); // stale — missing marker
    b1.innerHTML = '<ol start="1"><li>hello</li></ol>';
    editor.appendChild(b1);
    placeCaretStart(b1);

    const resolved = api.resolveListAwareRaw(b1);
    assert(api.parseListLine(resolved)?.kind === 'ol', 'reconstruct ol');
    assert(api.isCaretAtStartOfBlock(b1), 'caret at start of stale-ol block');
    const handled = api.handleListBackspaceAtStart(b1);
    assert(handled === true, `direct handle after reconstruct (raw now ${JSON.stringify(b1.getAttribute('data-raw'))})`);
    assert(b1.getAttribute('data-raw') === 'hello', 'direct strip → hello');
    assert(api.docLines().join('|') === '111|hello', 'two lines after direct strip');

    // Also dual-event path from a fresh stale ol
    expireLock();
    editor.innerHTML = '';
    api.addBlock('111');
    const b2 = document.createElement('div');
    b2.className = 'block';
    b2.setAttribute('data-raw', 'hello');
    b2.innerHTML = '<ol start="1"><li>hello</li></ol>';
    editor.appendChild(b2);
    placeCaretStart(b2);
    const r = runPhysicalBackspace();
    assert(
        r.lines[0] === '111' && r.lines[1] === 'hello' && !r.browserMerged,
        `dual-event strip after reconstruct (got ${JSON.stringify(r.lines)} merged=${r.browserMerged})`
    );
}

console.log('\n=== Summary (backspace) ===');
console.log(`passed=${passed} failed=${failed}`);
if (failed) {
    console.error('\nBACKSPACE SELFTEST FAILED');
    process.exit(1);
}
console.log('\nBACKSPACE SELFTEST PASSED');
process.exit(0);
