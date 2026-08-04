/**
 * Virt scroll stability contracts:
 * - Do not mass-backfill all blockHeights on every remount (causes reverse jumps)
 * - mountVirtWindow must pin scroll to a content anchor after measure
 * - Fixture large-scroll-4000.md exists for manual dogfood
 *
 * node tests/virt-scroll-stability-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const fixturePath = path.join(__dirname, 'large-scroll-4000.md');
const mainScript = [...fs.readFileSync(templatePath, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).sort((a, b) => b.length - a.length)[0];

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

console.log('=== fixture large-scroll-4000.md ===');
{
    assert(fs.existsSync(fixturePath), 'tests/large-scroll-4000.md exists');
    const text = fs.readFileSync(fixturePath, 'utf8');
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    assert(lines.length === 4000, 'exactly 4000 lines (got ' + lines.length + ')');
    assert(/^Line 1 of 4000/.test(lines[0]), 'line 1 labeled');
    assert(/^Line 2000 of 4000/.test(lines[1999]), 'line 2000 labeled');
    assert(/^Line 4000 of 4000/.test(lines[3999]), 'line 4000 labeled');
    // Unique markers for visual dogfood
    assert(lines[1499].includes('row 1500'), 'mid marker 1500');
    assert(lines[2499].includes('row 2500'), 'mid marker 2500');
}

console.log('=== mountVirtWindow stability contracts (template) ===');
{
    assert(mainScript.includes('function mountVirtWindow'), 'mountVirtWindow present');
    assert(mainScript.includes('pinScrollToAnchor') || mainScript.includes('anchorIdx'),
        'scroll content anchor present');
    assert(mainScript.includes('_virtMounting'), 're-entry guard');
    // Must NOT mass-rewrite unmeasured heights on every remount
    assert(!/for\s*\(\s*let\s+hi\s*=\s*0\s*;\s*hi\s*<\s*DocumentModel\.blockHeights\.length/.test(mainScript)
        || !mainScript.includes('Backfill unmeasured plain rows'),
        'no full-map backfill loop (or comment removed with loop)');
    // Stronger: the old backfill phrase must be gone
    assert(!mainScript.includes('Backfill unmeasured plain rows toward the measured average'),
        'old global backfill comment removed');
    assert(mainScript.includes('never rewrite unmeasured')
        || mainScript.includes('never rewrite the entire height map')
        || mainScript.includes('Measure mounted blocks only'),
        'documents measure-mounted-only policy');
    assert(mainScript.includes('prefixHeight(anchorIdx)')
        || mainScript.includes('prefixHeight(anchor'),
        'anchor pin uses prefixHeight');
}

console.log('=== height map: local measure must not move distant prefix ===');
{
    // Simulate the bug: global backfill changes prefix of unvisited region
    const n = 4000;
    const est = 28;
    const heights = new Array(n).fill(est);
    function prefix(end) {
        let y = 0;
        for (let i = 0; i < end; i++) y += heights[i];
        return y;
    }
    const scrollAt2000 = prefix(1999); // top of line 2000 (0-based 1999)
    // Old bug: remount near 2000 measures 32px, backfills ALL to 32
    const heightsBuggy = heights.slice();
    for (let i = 0; i < n; i++) heightsBuggy[i] = 32;
    function prefixB(end) {
        let y = 0;
        for (let i = 0; i < end; i++) y += heightsBuggy[i];
        return y;
    }
    // Same scrollTop now maps earlier
    function indexAt(st, arr) {
        let y = 0;
        for (let i = 0; i < arr.length; i++) {
            if (y + arr[i] > st) return i;
            y += arr[i];
        }
        return arr.length - 1;
    }
    const idxBefore = indexAt(scrollAt2000, heights);
    const idxAfterBug = indexAt(scrollAt2000, heightsBuggy);
    assert(idxBefore === 1999, 'before: scroll at line 2000 (got ' + idxBefore + ')');
    assert(idxAfterBug < idxBefore,
        'global backfill makes same scrollTop map earlier (got ' + idxAfterBug + ' < ' + idxBefore + ')');

    // Fixed policy: only measure window ~1960..2040 (overscan around viewport)
    const heightsFixed = heights.slice();
    for (let i = 1960; i < 2040; i++) heightsFixed[i] = 32;
    const idxAfterFix = indexAt(scrollAt2000, heightsFixed);
    // Local measure can shift a few lines (heights above anchor in the window) —
    // but must be tiny vs global backfill (~250 lines).
    const localDrift = Math.abs(idxAfterFix - 1999);
    const globalDrift = Math.abs(idxAfterBug - 1999);
    assert(localDrift < 20, 'local measure drift small (got ' + localDrift + ' lines)');
    assert(localDrift * 5 < globalDrift,
        'local drift << global backfill drift (' + localDrift + ' vs ' + globalDrift + ')');

    // Anchor pin: after local measure, adjust scrollTop so line 2000 stays
    const anchorIdx = 1999;
    const anchorOffset = 0;
    const newScroll = (function () {
        let y = 0;
        for (let i = 0; i < anchorIdx; i++) y += heightsFixed[i];
        return y + anchorOffset;
    })();
    const idxPinned = indexAt(newScroll, heightsFixed);
    assert(idxPinned === 1999, 'after pinScroll, still line 2000 (got ' + idxPinned + ')');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nVIRT SCROLL STABILITY SELFTEST FAILED');
    process.exit(1);
}
console.log('\nVIRT SCROLL STABILITY SELFTEST PASSED');
