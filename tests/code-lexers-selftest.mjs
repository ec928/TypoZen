/**
 * The code lexers, over strings.
 *
 * These paint fenced code with the CSS Custom Highlight API, so the property that
 * matters most is that **tokens tile the line**: in order, non-overlapping, inside
 * the line. Overlapping ranges double-paint, and a token running past the line end
 * throws when a Range is built from it -- neither is visible in a screenshot.
 *
 * What is NOT here any more: renderCodeLine and the per-document state cache. They
 * existed for a whole-file code document kind, which was built, corrupted real
 * files, and is parked at tag code-kind-parked. See
 * docs/developer-editor-analysis.md. The lexers survived that attempt because they
 * are surface-independent; the machinery around them did not.
 *
 *   node tests/code-lexers-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

// The module is self-contained by design: no DOM needed for the lexers themselves.
const sandbox = { window: {}, document: { getElementById: () => null }, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', '08-code.js'), 'utf8'),
    sandbox);

const { codeLanguageForPath, codeLanguageForFence, lexCodeLine } = sandbox.window;

console.log('=== which fences and files get a lexer ===');
assert(codeLanguageForFence('json') === 'json', '```json');
assert(codeLanguageForFence('xml') === 'xml', '```xml');
assert(codeLanguageForFence('cs') === 'clike', '```cs');
assert(codeLanguageForFence('js') === 'clike', '```js');
assert(codeLanguageForFence('') === null, 'a bare ``` gets none');
assert(codeLanguageForFence('brainfuck') === null, 'an unknown language gets none');
assert(codeLanguageForFence('  JSON  ') === 'json', 'case and padding do not matter');
assert(codeLanguageForFence('js title="x"') === 'clike',
    'an info string with attributes still resolves its language');
assert(codeLanguageForPath('a/App.xaml') === 'xml', 'and file extensions share the table');
assert(codeLanguageForPath('notes.md') === null, '.md is not code');

console.log('\n=== tokens tile the line ===');
// The property the painter depends on. A token that overlaps its neighbour paints
// twice; one that runs past the line end throws when a Range is built from it.
const LINES = [
    ['clike', 'public class Foo { // hi'],
    ['clike', '    var s = "a \\" b"; /* x */ 42'],
    ['clike', '/* unterminated'],
    ['clike', ''],
    ['clike', '        '],
    ['clike', 'x.y(1); // trailing'],
    ['xml', '<Button x:Name="ok" Content="Go" />'],
    ['xml', '<!-- comment -->'],
    ['xml', '<!-- open'],
    ['xml', '<Grid Margin="4,0"><TextBlock/></Grid>'],
    ['json', '{ "key": "value", "n": -1.5e3, "b": true }'],
    ['json', '  "lonely"'],
];
const bad = [];
for (const [lang, line] of LINES) {
    const r = lexCodeLine(line, lang, 0);
    let at = -1;
    for (const t of r.tokens) {
        if (t.s < at || t.e < t.s || t.e > line.length) {
            bad.push(lang + ' ' + JSON.stringify(line) + ' -> ' + JSON.stringify(t));
            break;
        }
        at = t.e;
    }
}
info(LINES.length - bad.length + '/' + LINES.length + ' lines tiled cleanly');
assert(bad.length === 0, 'no token overlaps, reverses or runs past the line ' +
    JSON.stringify(bad.slice(0, 2)));

console.log('\n=== a block comment carries across lines ===');
const a = lexCodeLine('/* start', 'clike', 0);
assert(a.state === 1, 'an unterminated block comment leaves the carried state set');
const b = lexCodeLine('still comment', 'clike', a.state);
assert(b.tokens.length === 1 && b.tokens[0].t === 'comment',
    'the next line is a comment from the carried state, not its own content');
const c = lexCodeLine('done */ var x', 'clike', b.state);
assert(c.state === 0, 'the state clears when the comment closes');
assert(c.tokens.some(t => t.t === 'keyword'), 'and code after it is lexed normally');

const x = lexCodeLine('<!-- open', 'xml', 0);
assert(x.state === 2, 'xml comments carry their own state');
assert(lexCodeLine('any text', 'xml', x.state).tokens[0].t === 'comment',
    'and the next xml line is a comment because of it');

console.log('\n=== JSON tells keys from values ===');
const kinds = lexCodeLine('{ "key": "value" }', 'json', 0).tokens.map(t => t.t);
info('token kinds: ' + JSON.stringify(kinds));
assert(kinds[0] === 'attr', 'the string before a colon is a key');
assert(kinds[1] === 'string', 'the string after it is a value');

console.log('\n=== every lexer finishes, on any input ===');
// 2026-09-27: '@' could start a clike word but not continue one, so the scan never advanced
// and the page hung on the first '@' in any CSS, JS or C# file -- @font-face in the test
// template froze Source outright. A lexer that stalls hangs the app, so these run inside
// the VM with a timeout: a stall is a failure here, not a frozen test.
{
    const printable = [];
    for (let k = 32; k < 127; k++) printable.push(String.fromCharCode(k));
    const inputs = ['@', '@media screen', '@font-face {', 'a@b', '@"verbatim"', '@@', '$@_', '<@>', '"@', '-', '<', '<a', '<!', '"'];
    for (const p of printable) { inputs.push(p); for (const q of printable) inputs.push(p + q); }
    const template = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
    if (fs.existsSync(template)) inputs.push(...fs.readFileSync(template, 'utf8').split('\n'));
    sandbox.__inputs = inputs;
    let result = null, err = null;
    try {
        result = vm.runInContext(`(function () {
            var n = 0;
            for (var L of ['clike', 'xml', 'json']) {
                var st = 0;
                for (var s of __inputs) { st = lexCodeLine(s, L, st).state; n++; }
            }
            return n;
        })()`, sandbox, { timeout: 20000 });
    } catch (e) { err = e; }
    info((result || 0) + ' lines lexed across three lexers' + (err ? ' -- ' + err.message : ''));
    assert(!err && result === inputs.length * 3, 'no lexer stalls: every character and pair, and every line of the 2.2 MB template');
    // Nothing below may call a lexer outside the VM on '@' input: on a regression it would
    // hang this test instead of failing it.
}

console.log('\n=== an unknown language paints nothing rather than guessing ===');
assert(lexCodeLine('some words here', 'not-a-language', 0).tokens.length === 0,
    'no tokens for an unknown language');
assert(lexCodeLine(null, 'clike', 0).tokens.length === 0, 'and null is survivable');

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'CODE LEXERS SELFTEST FAILED' : 'CODE LEXERS SELFTEST PASSED');
process.exit(failed ? 1 : 0);
