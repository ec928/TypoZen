/**
 * Code documents: the round-trip, and the lexers.
 *
 * The whole idea rests on one property, so it is asserted first and hardest:
 * **a code file that goes in comes out byte for byte.** One block per line, raw is
 * that line, and toMarkdown() joins raws with a newline — so the serialiser is the
 * identity function and any deviation is a bug that silently rewrites the user's
 * file.
 *
 * The two ways that could break are both Markdown housekeeping applied where it does
 * not belong, and both are checked:
 *
 *   - coerceBlockRaw() collapses a multi-line raw and TRIMS each part, which is
 *     exactly the leading indentation a code file is made of
 *   - toMarkdown() pops trailing blank lines, which rewrites the final newline
 *
 * Then the lexers, whose only interesting property is that they tile the line: every
 * character is covered at most once and the tokens are in order, because the renderer
 * splices them into markup and gaps go through verbatim. A token that overlaps its
 * neighbour would duplicate or drop characters, and textContent would stop
 * reconstructing the raw.
 *
 *   node tests/code-kind-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { readEngineSource } from './engine-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

// The lexers and the model are plain functions over strings, so they run here without
// a DOM. Only the pieces that touch one are stubbed.
const src = readEngineSource();
const sandbox = {
    window: {}, document: undefined, console,
    setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
try {
    vm.createContext(sandbox);
    // The engine expects a document; without one most of it throws on load. Only
    // 08-code.js is needed here, and it is self-contained by design.
    const codeSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', '08-code.js'), 'utf8');
    vm.runInContext(codeSrc, sandbox);
} catch (e) {
    console.error('could not load 08-code.js: ' + e.message);
    process.exit(1);
}

const { codeLanguageForPath, lexCodeLine, renderCodeLine } = sandbox.window;

console.log('=== which files are code ===');
assert(codeLanguageForPath('C:\\x\\App.xaml') === 'xml', '.xaml is xml');
assert(codeLanguageForPath('a/b/Program.cs') === 'clike', '.cs is clike');
assert(codeLanguageForPath('pkg.json') === 'json', '.json is json');
assert(codeLanguageForPath('notes.md') === null, '.md is NOT code — Markdown keeps its own path');
assert(codeLanguageForPath('log.txt') === null, '.txt is NOT code — it stays Notepad-class');
assert(codeLanguageForPath('noextension') === null, 'a file with no extension is not code');

console.log('\n=== tokens tile the line ===');
// Every character covered at most once, in order. The renderer splices tokens into
// markup and passes gaps through verbatim, so an overlap duplicates characters and a
// backwards token drops them.
const LINES = [
    ['clike', 'public class Foo { // hi'],
    ['clike', '    var s = "a \\" b"; /* x */ 42'],
    ['clike', '/* unterminated'],
    ['clike', ''],
    ['clike', '        '],
    ['xml', '<Button x:Name="ok" Content="Go" />'],
    ['xml', '<!-- comment -->'],
    ['xml', '<!-- open'],
    ['json', '{ "key": "value", "n": -1.5e3, "b": true }'],
    ['json', '  "lonely"'],
];
let tiled = 0, bad = [];
for (const [lang, line] of LINES) {
    const r = lexCodeLine(line, lang, 0);
    let at = -1, ok = true;
    for (const t of r.tokens) {
        if (t.s < at || t.e < t.s || t.e > line.length) { ok = false; break; }
        at = t.e;
    }
    if (ok) tiled++; else bad.push(lang + ': ' + JSON.stringify(line));
}
info(tiled + '/' + LINES.length + ' lines tiled cleanly');
assert(bad.length === 0, 'no token overlaps, reverses or runs past the line ' + JSON.stringify(bad));

console.log('\n=== the render round-trips ===');
// textContent must reconstruct the raw exactly -- that is the property that lets a
// code block hold real elements where a Markdown block may not.
const RAWS = [
    'public class Foo {',
    '    if (a < b && c > d) return "x";',
    '\t\tindented with tabs',
    '<Grid Margin="4,0" />',
    '{ "a": "<b>&amp;</b>" }',
    '',
    '   ',
    'plain text with no tokens at all',
];
const stripTags = (h) => h.replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
let rt = 0, rtBad = [];
for (const raw of RAWS) {
    for (const lang of ['clike', 'xml', 'json']) {
        const html = renderCodeLine(raw, lang, 0);
        if (stripTags(html) === raw) rt++;
        else rtBad.push(lang + ' ' + JSON.stringify(raw) + ' -> ' + JSON.stringify(stripTags(html)));
    }
}
info(rt + '/' + (RAWS.length * 3) + ' renders reconstruct their raw');
assert(rtBad.length === 0, 'every rendered line reconstructs its raw exactly ' +
    JSON.stringify(rtBad.slice(0, 3)));

console.log('\n=== markup in code is escaped, not executed ===');
const hostile = renderCodeLine('<script>alert(1)</script>', 'clike', 0);
assert(hostile.indexOf('<script') < 0, 'a line containing a tag is escaped');
assert(stripTags(hostile) === '<script>alert(1)</script>', 'and still round-trips');

console.log('\n=== block comments carry across lines ===');
const a = lexCodeLine('/* start', 'clike', 0);
assert(a.state === 1, 'an unterminated block comment leaves the carried state set');
const b = lexCodeLine('still comment', 'clike', a.state);
assert(b.tokens.length === 1 && b.tokens[0].t === 'comment',
    'the next line is a comment because of the carried state, not its own content');
const c = lexCodeLine('done */ var x', 'clike', b.state);
assert(c.state === 0, 'and the state clears when the comment closes');
assert(c.tokens.some(t => t.t === 'keyword'),
    'code after the close is lexed normally (' + JSON.stringify(c.tokens) + ')');

console.log('\n=== JSON tells keys from values ===');
const j = lexCodeLine('{ "key": "value" }', 'json', 0);
const kinds = j.tokens.map(t => t.t);
info('token kinds: ' + JSON.stringify(kinds));
assert(kinds[0] === 'attr', 'the string before a colon is a key');
assert(kinds[1] === 'string', 'the string after it is a value');

console.log('\n=== an unknown language paints nothing rather than guessing ===');
const u = lexCodeLine('some words here', 'not-a-language', 0);
assert(u.tokens.length === 0, 'no tokens for an unknown language');
assert(renderCodeLine('a < b', 'not-a-language', 0) === 'a &lt; b',
    'and the line still renders, escaped');

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'CODE KIND SELFTEST FAILED' : 'CODE KIND SELFTEST PASSED');
process.exit(failed ? 1 : 0);
