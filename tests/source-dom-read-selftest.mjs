/**
 * Nothing reads Source's text from CodeMirror's DOM.
 *
 * docs/codemirror-source-plan.md, section 3. The code editor parked in
 * docs/developer-editor-analysis.md corrupted real files because TypoZen rebuilt text from
 * a contenteditable's DOM after each keystroke. CodeMirror owns its buffer (state.doc) and
 * draws the DOM from it; the text is safe exactly as long as nobody reads it back out of
 * that drawing. So: outside 01a-source.js, no module may name CodeMirror's DOM at all
 * (.cm-content, .cm-line, .cm-editor, contentDOM, scrollDOM), and 01a-source.js itself
 * never reads text from it (textContent / innerText / innerHTML of those elements).
 *
 * A scan, not a behaviour test -- the same kind as assets-selftest. Comments are stripped
 * first, so explaining the rule does not break it.
 *
 *   node tests/source-dom-read-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulesDir = path.join(__dirname, '..', 'js', 'modules');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

/** Drop // and block comments, leaving strings alone (good enough for these modules). */
function stripComments(src) {
    let out = '', i = 0, q = null;
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (q) {
            out += c;
            if (c === '\\') { out += d || ''; i += 2; continue; }
            if (c === q) q = null;
            i++; continue;
        }
        if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
        if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
        out += c; i++;
    }
    return out;
}

const CM_DOM = /\.cm-(content|line|editor|scroller)\b|cm-(content|line)['"\s]|\bcontentDOM\b|\bscrollDOM\b/;
const order = JSON.parse(fs.readFileSync(path.join(modulesDir, 'load-order.json'), 'utf8')).modules;
assert(order.includes('01a-source.js'), 'the Source surface module is loaded (01a-source.js)');

console.log('=== no module but the surface names CodeMirror\'s DOM ===');
for (const mod of order) {
    if (mod === '01a-source.js') continue;
    const code = stripComments(fs.readFileSync(path.join(modulesDir, mod), 'utf8'));
    const lines = code.split('\n');
    const hits = [];
    lines.forEach((l, n) => { if (CM_DOM.test(l)) hits.push((n + 1) + ': ' + l.trim().slice(0, 100)); });
    assert(hits.length === 0, mod + (hits.length ? ' names CodeMirror\'s DOM:\n        ' + hits.slice(0, 3).join('\n        ') : ''));
}

console.log('=== the surface itself never reads text back from it ===');
{
    const code = stripComments(fs.readFileSync(path.join(modulesDir, '01a-source.js'), 'utf8'));
    const reads = code.split('\n').filter(l => /(contentDOM|scrollDOM|\.dom\b|host)\s*\.\s*(textContent|innerText|innerHTML|outerHTML)\b(?!\s*=)/.test(l));
    assert(reads.length === 0, 'no textContent / innerText / innerHTML read from CodeMirror\'s elements'
        + (reads.length ? ': ' + reads[0].trim() : ''));
    assert(/state\.doc/.test(code), 'the text comes from view.state.doc');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SOURCE DOM READ SELFTEST FAILED'); process.exit(1); }
console.log('SOURCE DOM READ SELFTEST PASSED');
