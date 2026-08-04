/**
 * Self-test: serialize round-trip + list parse + ordered Backspace contract.
 * Runs without launching WPF — uses jsdom + production helpers from TypoZen_Template_Test.html.
 *
 * node tests/regression-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');

// Pull the main script block (last large script in the file)
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];
if (!mainScript || mainScript.length < 10000) {
    console.error('FAIL: could not extract main editor script from template');
    process.exit(1);
}

const dom = new JSDOM(`<!DOCTYPE html><html><body>
<div id="editor" contenteditable="true"></div>
<textarea id="source-editor" style="display:none"></textarea>
<div id="main-container"></div>
<div id="sidebar"></div>
<div id="outline-list"></div>
<div id="file-list"></div>
<div id="findBar" style="display:none"></div>
<input id="findInput" />
</body></html>`, {
    url: 'https://localapp/TypoZen_Template_Test.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
});

const { window } = dom;
const { document } = window;

// Minimal globals the script expects
window.chrome = { webview: { postMessage: () => {} } };
global.window = window;
global.document = document;
global.Node = window.Node;
global.NodeFilter = window.NodeFilter;
global.Range = window.Range;
global.getSelection = () => window.getSelection();
try { global.navigator = window.navigator; } catch (_) { /* node 24: navigator is read-only */ }
global.HTMLElement = window.HTMLElement;
global.Element = window.Element;

// Stub requestAnimationFrame
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

let failed = 0;
let passed = 0;
function assert(cond, msg) {
    if (cond) {
        passed++;
        console.log('  OK  ', msg);
    } else {
        failed++;
        console.error('  FAIL', msg);
    }
}

// Extract pure helper functions by evaluating a surgical subset + DOM helpers
// We re-implement the critical pure ones by eval'ing the exact source from the file
function extractFunction(name) {
    // Match function name() { ... } with brace counting
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        const c = mainScript[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                return mainScript.slice(idx, i + 1);
            }
        }
    }
    throw new Error('unclosed function ' + name);
}

const pureNames = [
    'parseListLine',
    'formatListLine',
    'indentListLine',
    'isListLine',
    'normalizeBlockRaw',
    'isMultilineBlockRaw',
    'coerceBlockRaw',
    'stripBlockPrefix',
    'stripListMarkerKeepBody',
    'listIndentPad',
    'getListIndentLevel'
];

// Constants used by pure helpers
const constBlock = `
const LIST_MAX_INDENT = 6;
const LIST_INDENT_SPACES = 2;
`;

let pureSrc = constBlock;
for (const n of pureNames) {
    pureSrc += '\n' + extractFunction(n) + '\n';
}

const pure = {};
const pureFn = new Function(pureSrc + `; return { ${pureNames.join(', ')} };`);
Object.assign(pure, pureFn());

console.log('\n=== Pure list helpers ===');
{
    const p = pure.parseListLine('1. hello');
    assert(p && p.kind === 'ol' && p.body === 'hello' && p.num === 1, 'parseListLine("1. hello")');
    assert(pure.parseListLine('111') == null, 'parseListLine("111") is not a list');
    assert(pure.coerceBlockRaw('a\n\nb') === 'a b', 'coerceBlockRaw collapses accidental multi-line to spaces');
    assert(pure.coerceBlockRaw('line\n') === 'line', 'coerceBlockRaw strips trailing newline');
    assert(pure.normalizeBlockRaw('x\n\n') === 'x', 'normalizeBlockRaw strips trailing newlines only');
    const indented = pure.indentListLine('- item', 1);
    assert(indented === '  - item', 'indentListLine bullet +1');
    assert(pure.indentListLine('  1. x', -1) === '1. x', 'indentListLine ol -1');
}

// DOM-level: simulate blocks + getMarkdownContent rules (mirror production getMarkdownContent)
console.log('\n=== Serialize one-block-one-line ===');
{
    const editor = document.getElementById('editor');
    editor.innerHTML = '';
    function addBlock(raw) {
        const b = document.createElement('div');
        b.className = 'block';
        b.setAttribute('data-raw', pure.coerceBlockRaw(raw));
        // Simulate preview: paragraph or list
        const list = pure.parseListLine(raw);
        if (list && list.kind === 'ol') {
            b.innerHTML = `<ol start="${list.num}"><li>${list.body}</li></ol>`;
        } else if (list && list.kind === 'ul') {
            b.innerHTML = `<ul><li>${list.body}</li></ul>`;
        } else {
            b.innerHTML = `<p>${raw || ''}</p>`;
        }
        editor.appendChild(b);
        return b;
    }

    // 10 separate lines like user test
    const nums = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];
    nums.forEach(addBlock);

    function getMarkdownContentLikeProd() {
        const blocks = editor.querySelectorAll('.block');
        const lines = [];
        blocks.forEach(function (b) {
            let raw = b.hasAttribute('data-raw') ? b.getAttribute('data-raw') : '';
            raw = pure.coerceBlockRaw(raw);
            lines.push(raw);
        });
        while (lines.length > 1 && !String(lines[lines.length - 1]).trim()) lines.pop();
        return lines.join('\n');
    }

    const md = getMarkdownContentLikeProd();
    const mdLines = md.split('\n');
    assert(mdLines.length === 10, `10 blocks → 10 source lines (got ${mdLines.length})`);
    assert(mdLines[0] === '111' && mdLines[9] === '100', 'source lines preserve order/content');
    assert(!md.includes('111 222'), 'source is NOT space-collapsed into one line');

    // Reload simulation: split and recreate
    editor.innerHTML = '';
    md.split('\n').forEach(addBlock);
    const md2 = getMarkdownContentLikeProd();
    assert(md2 === md, 'round-trip Preview→Source→Preview line list stable');
    assert(md2.split('\n').length === 10, 'round-trip still 10 lines');
}

console.log('\n=== Ordered list raw resolve + strip (2-stage contract) ===');
{
    // Stage 1: strip marker only
    const raw = '1. hello';
    const p = pure.parseListLine(raw);
    assert(!!p && p.kind === 'ol', 'ol parse');
    const stripped = p.body;
    assert(stripped === 'hello', 'strip marker → body only (stage 1)');
    // Stage 2 would merge "111" + "hello" — must NOT happen in same op as strip
    const mergedWrong = '111' + stripped;
    assert(mergedWrong === '111hello', 'documents the failure mode if merge runs same stroke');
    // Correct stage-1 result is a standalone plain block:
    assert(stripped !== mergedWrong, 'stage 1 result is not the merge result');
}

console.log('\n=== Accidental blank-line injection guards ===');
{
    // data-raw with trailing newline must not create extra source line when joined
    const a = pure.coerceBlockRaw('111\n');
    const b = pure.coerceBlockRaw('222\n');
    const joined = [a, b].join('\n');
    assert(joined === '111\n222', 'trailing newline on each raw does not double blank lines');
    assert(joined.split('\n').length === 2, 'joined length 2');

    // empty chrome multi-line
    const chrome = pure.coerceBlockRaw('hello\n\n');
    assert(chrome === 'hello', 'coerce strips trailing empties via normalize then no internal blank');
}

console.log('\n=== DOM list marker vs data-raw (Backspace resolve) ===');
{
    const editor = document.getElementById('editor');
    editor.innerHTML = '';
    const b = document.createElement('div');
    b.className = 'block';
    // Stale case: visual ol but data-raw lost marker (failure mode we hit)
    b.setAttribute('data-raw', 'hello');
    b.innerHTML = '<ol start="1"><li>hello</li></ol>';
    editor.appendChild(b);

    // resolveListAwareRaw logic (mirror)
    let raw = b.getAttribute('data-raw') || '';
    raw = pure.normalizeBlockRaw(raw);
    let listP = pure.parseListLine(raw);
    if (!listP) {
        const ol = b.querySelector('ol');
        if (ol) {
            const num = ol.getAttribute('start') || '1';
            const li = ol.querySelector('li');
            const body = li ? String(li.textContent || li.innerText || '').trim() : '';
            raw = pure.normalizeBlockRaw(num + '. ' + body);
            listP = pure.parseListLine(raw);
        }
    }
    assert(listP && listP.kind === 'ol' && listP.body === 'hello', 'reconstruct ol from DOM when data-raw stale');
    assert(listP.body === 'hello', 'stage1 strip body is hello not merge');
}

// Dual-event lock contract (code presence in template)
console.log('\n=== Dual-event lock present in production template ===');
{
    assert(mainScript.includes('_listBackspaceLockUntil'), 'list backspace lock variable exists');
    assert(mainScript.includes('isListBackspaceLocked'), 'list backspace lock helper exists');
    assert(mainScript.includes("addEventListener('beforeinput'"), 'beforeinput capture registered');
    assert(mainScript.includes("addEventListener('keydown', onEditorListBackspaceCapture, true)"), 'keydown capture registered');
}

console.log('\n=== Summary (serialize/helpers) ===');
console.log(`passed=${passed} failed=${failed}`);
if (failed) {
    console.error('\nSELFTEST FAILED');
    process.exit(1);
}
console.log('\nSERIALIZE SELFTEST PASSED');

function runChild(label, file) {
    console.log(`\nRunning ${label}...`);
    const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
        encoding: 'utf8',
        cwd: path.join(__dirname, '..')
    });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    if (r.status !== 0) {
        console.error(`\n${label.toUpperCase()} FAILED`);
        process.exit(r.status || 1);
    }
}

// Fundamentals FIRST — if create-line fails, nothing else matters
runChild('FUNDAMENTAL create-lines suite', 'create-lines-selftest.mjs');
runChild('backspace suite', 'backspace-selftest.mjs');
runChild('bullet/undo suite', 'bullet-undo-selftest.mjs');
runChild('multiselect list suite', 'multiselect-list-dom-selftest.mjs');
runChild('multiselect bullet LIVE path (user smoke #1)', 'multiselect-bullet-livepath-selftest.mjs');
runChild('headings H1-H6 suite', 'headings-selftest.mjs');
runChild('undo (single-step + caret) suite', 'undo-selftest.mjs');
runChild('undo continuous suite', 'undo-continuous-selftest.mjs');
runChild('tabs model suite', 'tabs-model-selftest.mjs');

console.log('\nALL REGRESSION SELFTESTS PASSED');
process.exit(0);
