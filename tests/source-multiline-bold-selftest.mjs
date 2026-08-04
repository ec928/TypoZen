/**
 * Source multi-line bold must format each hard line, not wrap the whole span in **…**.
 * Cross-line wrap breaks when the model splits on \\n → marker soup (r**ow 2001*).
 *
 * node tests/source-multiline-bold-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'TypoZen_Template_Test.html'), 'utf8');
const mainScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).sort((a, b) => b.length - a.length)[0];

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

function extractFunction(name) {
    const startRe = new RegExp('function\\s+' + name + '\\s*\\(');
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing ' + name);
    let i = mainScript.indexOf('{', idx), depth = 0;
    for (; i < mainScript.length; i++) {
        if (mainScript[i] === '{') depth++;
        else if (mainScript[i] === '}' && --depth === 0) return mainScript.slice(idx, i + 1);
    }
    throw new Error('unclosed ' + name);
}

console.log('=== template contracts ===');
assert(mainScript.includes('_sourceFormatSel'), 'source selection freeze');
assert(mainScript.includes('takeSourceFormatSelection'), 'take frozen source range');
assert(mainScript.includes('rememberSourceFormatSelection'), 'remember source range');
// Multi-line path must call transformRawForFormat per line
assert(mainScript.includes("indexOf('\\n')") || mainScript.includes('indexOf("\\n")'),
    'detects multi-line selection');
assert(mainScript.includes('transformRawForFormat(line, type'),
    'per-line transform for multi-line inline');
assert(mainScript.includes('withSourceScrollPreserved')
    || mainScript.includes('sourceSetRangeTextPreserveScroll'),
    'source format preserves scrollTop (no 1–2 line jump)');

console.log('=== pure: per-line bold on 3 rows ===');
{
    const pureNames = [
        'parseListLine', 'formatListLine', 'normalizeBlockRaw', 'isMultilineBlockRaw',
        'coerceBlockRaw', 'stripListMarkerKeepBody', 'stripBlockPrefix', 'listIndentPad',
        'getListIndentLevel', 'splitInlineFormatPrefix', 'transformRawForFormat'
    ];
    let src = 'const LIST_MAX_INDENT=6;const LIST_INDENT_SPACES=2;\n';
    // splitInlineFormatPrefix may be needed
    for (const n of pureNames) {
        try { src += extractFunction(n) + '\n'; } catch (e) {
            if (n === 'splitInlineFormatPrefix') {
                // might be inline in transform only
            } else throw e;
        }
    }
    // If splitInlineFormatPrefix missing from extract, pull from template differently
    if (!src.includes('function splitInlineFormatPrefix')) {
        src += extractFunction('splitInlineFormatPrefix') + '\n';
    }
    src += 'return { transformRawForFormat };';
    const api = new Function(src)();

    const lines = [
        'Line 1999 of 4000 — scroll test marker row 1999',
        'Line 2000 of 4000 — scroll test marker row 2000',
        'Line 2001 of 4000 — scroll test marker row 2001'
    ];
    const out = lines.map(l => api.transformRawForFormat(l, 'bold', {})).join('\n');
    assert(out.includes('**Line 1999 of 4000 — scroll test marker row 1999**'),
        'line 1999 fully bold-wrapped');
    assert(out.includes('**Line 2000 of 4000 — scroll test marker row 2000**'),
        'line 2000 fully bold-wrapped');
    assert(out.includes('**Line 2001 of 4000 — scroll test marker row 2001**'),
        'line 2001 fully bold-wrapped');
    assert(!out.includes('r**ow'), 'no mid-word r**ow soup');
    assert(!/^\*\*/.test(out.split('\n')[0]) || out.split('\n')[0].endsWith('**'),
        'line 0 opens and closes on same line');
    // Bad old path: wrap whole selection
    const bad = '**' + lines.join('\n') + '**';
    const badBlocks = bad.split('\n');
    assert(badBlocks[0].startsWith('**') && !badBlocks[0].endsWith('**'),
        'documents bad cross-line wrap leaves open ** on first line');
    assert(badBlocks[2].endsWith('**') && !badBlocks[2].startsWith('**'),
        'documents bad cross-line wrap leaves close ** on last line');
}

console.log('=== pure: frozen selection survives collapse ===');
{
    // Simulate takeSourceFormatSelection
    function take(liveStart, liveEnd, frozen) {
        let start = liveStart, end = liveEnd;
        if (start === end && frozen && frozen.start !== frozen.end) {
            start = frozen.start;
            end = frozen.end;
        }
        return { start, end };
    }
    const frozen = { start: 100, end: 250 };
    const t = take(250, 250, frozen); // collapsed after toolbar steal
    assert(t.start === 100 && t.end === 250, 'frozen range used after collapse');
    const live = take(10, 40, frozen);
    assert(live.start === 10 && live.end === 40, 'live non-empty range preferred');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nSOURCE MULTILINE BOLD SELFTEST FAILED');
    process.exit(1);
}
console.log('\nSOURCE MULTILINE BOLD SELFTEST PASSED');
