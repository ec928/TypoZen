/**
 * The empty-editor hint is not document text.
 *
 *   node tests/scratch-hint-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', '01-core.js'), 'utf8');
const m = src.match(/function isScratchHintText\([\s\S]*?\n        \}/);
if (!m) {
    console.error('FAIL could not extract isScratchHintText from 01-core.js');
    process.exit(1);
}

const ctx = { window: {} };
vm.runInNewContext(m[0] + '\nthis.fn = isScratchHintText;', ctx);
const fn = ctx.fn;

let passed = 0, failed = 0;
function assert(c, msg) {
    if (c) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

assert(fn('Start typing here...'), 'old new_document body is a hint');
assert(fn('Start typing... (F1 or Help menu for markdown syntax)'),
    'CSS overlay sentence is a hint');
assert(fn('S\nt\na\nr\nt\n \nt\ny\np\ni\nn\ng\n.\n.\n.\n \n(\nF\n1\n \no\nr\n \nH\ne\nl\np\n \nm\ne\nn\nu\n \nf\no\nr\n \nm\na\nr\nk\nd\no\nw\nn\n \ns\ny\nn\nt\na\nx\n)'),
    '10px-gutter wrap of that sentence is still a hint');
assert(fn('# Untitled Document'), 'old H1 is a hint');
assert(!fn('# Hello\n\nworld'), 'real markdown is not a hint');
assert(!fn('Start typing my novel'), 'user text that merely starts similarly is kept');
assert(!fn(''), 'empty is empty, not a hint');

const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'typozen.css'), 'utf8');
assert(!/#editor \.block:only-child:empty::before/.test(css),
    'hint is not on .block::before (that is the 10px gutter)');
assert(/#editor-wrapper\.scratch-empty::after/.test(css),
    'hint lives on the wrapper overlay');

const shell = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', '03-shell.js'), 'utf8');
assert(!/Untitled Document\\n\\nStart typing here/.test(shell),
    'new_document does not inject fake markdown');

const layout = fs.readFileSync(path.join(__dirname, '..', 'js', 'modules', '02-layout.js'), 'utf8');
assert(/e\.key === 'F1'/.test(layout) && /help_syntax/.test(layout),
    'F1 in the page opens Syntax & Shortcuts (not only F7/F8/F9)');
assert(/cmd === "help_syntax"/.test(shell) && /openTzOverlay\('helpModal'/.test(shell),
    'host cmd:help_syntax opens #helpModal');

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SCRATCH HINT SELFTEST FAILED'); process.exit(1); }
console.log('SCRATCH HINT SELFTEST PASSED');
