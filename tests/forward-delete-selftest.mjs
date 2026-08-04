/**
 * Self-test: forward Delete joins the next line up.
 *
 * Blocks are sibling <div>s, so contenteditable cannot merge them on its own. Delete
 * was only wired for cross-block SELECTIONS, so a collapsed caret at end-of-line — and
 * in particular Delete on an empty line — did nothing at all, unlike every other editor.
 *
 * node tests/forward-delete-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'TypoZen_Template_Test.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

function extractFunction(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        const c = mainScript[i];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return mainScript.slice(idx, i + 1);
    }
    throw new Error('unclosed function ' + name);
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

// The join rule, lifted from the Delete branch, exercised directly.
const names = ['parseListLine', 'formatListLine', 'listIndentPad', 'isListLine',
    'stripListMarkerKeepBody', 'stripBlockPrefix', 'normalizeBlockRaw', 'coerceBlockRaw',
    'getListIndentLevel', 'isMultilineBlockRaw'];
let src = 'const LIST_MAX_INDENT = 6; const LIST_INDENT_SPACES = 2;\n';
for (const n of names) src += extractFunction(n) + '\n';
src += 'return {' + names.join(',') + '};';
const api = new Function(src)();

function joinForward(curRaw, nextRaw) {
    let tail = api.normalizeBlockRaw(nextRaw);
    const cur = api.normalizeBlockRaw(curRaw);
    if (cur !== '') {
        tail = api.isListLine(tail) ? api.stripListMarkerKeepBody(tail) : api.stripBlockPrefix(tail);
    }
    return cur + tail;
}

console.log('--- Delete on an empty line pulls the next line up intact ---');
assert(joinForward('', 'second line') === 'second line', 'empty + text');
assert(joinForward('', '- list item') === '- list item', 'empty + list keeps its bullet');
assert(joinForward('', '# Heading') === '# Heading', 'empty + heading keeps its hashes');
assert(joinForward('', '') === '', 'empty + empty');

console.log('--- Delete at end of a real line joins the text ---');
assert(joinForward('first', 'second') === 'firstsecond', 'text + text joins with no separator');
assert(joinForward('first ', 'second') === 'first second', 'trailing space is preserved by the join');

console.log('--- joining onto text drops the pulled-up marker ---');
assert(joinForward('one', '- two') === 'onetwo', 'bullet marker dropped when joining onto text');
assert(joinForward('one', '1. two') === 'onetwo', 'numbered marker dropped when joining onto text');
assert(joinForward('one', '# two') === 'onetwo', 'heading marker dropped when joining onto text');
assert(joinForward('- one', '- two') === '- onetwo', 'list line keeps ITS marker, absorbs the next body');

console.log('--- the wiring exists ---');
const blockSrc = mainScript;
assert(/e\.key === 'Delete'/.test(blockSrc), 'a collapsed-caret Delete branch exists');
assert(/function isCaretAtEndOfBlock/.test(blockSrc), 'end-of-block caret test exists');
const endFn = extractFunction('isCaretAtEndOfBlock');
assert(/setStart\(r\.endContainer, r\.endOffset\)/.test(endFn), 'it measures what follows the caret');
assert(/isCaretAtEndOfBlock\(block\)/.test(blockSrc), 'Delete only merges at end of line');
assert(/removeBlockEl\s*\(\s*next\s*\)|next\.remove\s*\(\s*\)/.test(blockSrc),
    'the pulled-up block is removed');

console.log('--- browser filler <br> must not become a blank line ---');
{
    // Chrome drops a bogus <br> into a block whose text you just deleted. Counting it as
    // a visual line made emptying a line spawn phantom blank blocks below it.
    const drop = new Function(extractFunction('dropTrailingFillerLines') + '\nreturn dropTrailingFillerLines;')();

    assert(JSON.stringify(drop(['text', ''])) === JSON.stringify(['text']),
        'trailing filler after text is dropped');
    assert(JSON.stringify(drop(['', ''])) === JSON.stringify(['']),
        'an emptied line collapses to a single empty line');
    assert(JSON.stringify(drop(['', '', ''])) === JSON.stringify(['']),
        'multiple filler pieces collapse to one');
    assert(JSON.stringify(drop(['one', 'two'])) === JSON.stringify(['one', 'two']),
        'real two-line content is left alone');
    assert(JSON.stringify(drop(['one', '', 'two'])) === JSON.stringify(['one', '', 'two']),
        'a blank line BETWEEN content is preserved');
    assert(JSON.stringify(drop([''])) === JSON.stringify(['']), 'a lone empty piece survives');

    const collect = extractFunction('collectVisualLineTexts');
    assert((collect.match(/dropTrailingFillerLines/g) || []).length === 2,
        'both split paths filter filler (children walk and <br> split)');
}

console.log('--- copied text is one line per line ---');
{
    // Blocks are div > p; the browser's text/plain gives paragraphs blank-line separation.
    const sel = extractFunction('selectionToPlainText');
    assert(/lines\.join\('\\n'\)/.test(sel), 'selected blocks are joined with single newlines');
    assert(/replace\(\/\[\\r\\n\]\+\/g, ' '\)/.test(sel), 'newlines inside one block are flattened');
    assert(/intersectsNode/.test(sel), 'only blocks touched by the selection are included');
    assert(/setData\('text\/plain'/.test(mainScript), 'the copy handler writes our own text/plain');
    assert(/setData\('text\/html'/.test(mainScript), 'rich paste is preserved too');
}

console.log('--- serializing must not mutate on timer paths ---');
const getMd = extractFunction('getMarkdownContent');
assert(/repairFragments/.test(getMd), 'getMarkdownContent takes a repair flag');
assert(/repairFragments !== false/.test(getMd), 'expansion is skipped when repair is off');
const statsNow = extractFunction('updateStatsNow');
assert(/getMarkdownContent\(false\)/.test(statsNow), 'the debounced stats pass is a pure read');
const savePrefs = extractFunction('savePreferences');
assert(/getMarkdownContent\(false\)/.test(savePrefs), 'the prefs autosave is a pure read');

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nFORWARD DELETE SELFTEST FAILED');
    process.exit(1);
}
console.log('\nFORWARD DELETE SELFTEST PASSED');
