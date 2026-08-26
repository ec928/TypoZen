/**
 * Spread ↔ leaf page display conversion (2-col numbering).
 *
 * PageMap counts spreads; the foot and scrubber bubble show leaf pages.
 * All *2 arithmetic must live in pageDisplayFromSpread — this extracts it.
 *
 *   node tests/page-display-selftest.mjs
 */
import { readEngineSource } from './engine-source.mjs';

const src = readEngineSource();
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

function extractFn(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('not found: ' + name);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced: ' + name);
}

const pageDisplayFromSpread = new Function(
    extractFn('pageDisplayFromSpread') + '\nreturn pageDisplayFromSpread;'
)();

console.log('=== 1-column: leaf === spread ===');
{
    const d = pageDisplayFromSpread(0, 10, false);
    assert(d.left === 1 && d.right === 1 && d.totalLeaves === 10, 'first page 1/10');
    assert(d.bubble === '1 / 10', 'bubble 1 / 10');
    const d2 = pageDisplayFromSpread(4, 10, false);
    assert(d2.left === 5 && d2.bubble === '5 / 10', 'spread 4 → page 5');
}

console.log('=== 2-column: two leaves per spread ===');
{
    const d = pageDisplayFromSpread(0, 5, true);
    assert(d.left === 1 && d.right === 2 && d.totalLeaves === 10, 'spread 0 → 1|2 of 10');
    assert(d.bubble === '1–2 / 10', 'bubble shows spread leaves / total leaves');
    const d2 = pageDisplayFromSpread(2, 5, true);
    assert(d2.left === 5 && d2.right === 6, 'spread 2 → 5|6');
    const last = pageDisplayFromSpread(4, 5, true);
    assert(last.left === 9 && last.right === 10, 'last spread → 9|10');
}

console.log('=== clamps ===');
{
    const over = pageDisplayFromSpread(99, 3, true);
    assert(over.spread0 === 2 && over.left === 5, 'spread clamps to last');
    const neg = pageDisplayFromSpread(-3, 3, false);
    assert(neg.left === 1, 'negative spread clamps to 0');
}

console.log('=== no ad-hoc * 2 outside the helper (display sites) ===');
{
    // updatePageIndicator / showBubble must call the helper, not reimplement * 2.
    assert(src.indexOf('pageDisplayFromSpread') >= 0, 'helper present');
    const ind = src.indexOf('function updatePageIndicator');
    const indBody = ind >= 0 ? src.slice(ind, ind + 2500) : '';
    assert(indBody.indexOf('pageDisplayFromSpread') >= 0, 'updatePageIndicator uses helper');
    const bub = src.indexOf('function showBubble');
    const bubBody = bub >= 0 ? src.slice(bub, bub + 800) : '';
    assert(bubBody.indexOf('pageDisplayFromSpread') >= 0, 'scrubber bubble uses helper');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nPAGE DISPLAY SELFTEST FAILED');
    process.exit(1);
}
console.log('\nPAGE DISPLAY SELFTEST PASSED');
process.exit(0);
