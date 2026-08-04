/**
 * Stage D: virtualization thresholds + height helpers.
 * Guards against re-coupling SOURCE_FIRST open with virt (the 16KB dual-use bug).
 *
 * node tests/virt-thresholds-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

console.log('=== threshold constants present and split ===');
assert(/const SOURCE_FIRST_CHARS\s*=\s*16000/.test(mainScript), 'SOURCE_FIRST_CHARS = 16000');
assert(/const VIRT_MIN_CHARS\s*=\s*120000/.test(mainScript), 'VIRT_MIN_CHARS = 120000');
assert(/const VIRT_MIN_BLOCKS\s*=\s*2000/.test(mainScript), 'VIRT_MIN_BLOCKS = 2000');
assert(/const PROGRESSIVE_PAINT_BLOCKS\s*=\s*800/.test(mainScript), 'PROGRESSIVE_PAINT_BLOCKS = 800');
assert(/const PROGRESSIVE_CREATE_BATCH_BLOCKS\s*=\s*1500/.test(mainScript),
    'PROGRESSIVE_CREATE_BATCH_BLOCKS = 1500');
assert(mainScript.includes('const LARGE_DOC_CHARS = SOURCE_FIRST_CHARS'),
    'LARGE_DOC_CHARS aliases SOURCE_FIRST (not virt)');

// shouldVirtualize must not use LARGE_DOC_CHARS / 16000 as virt floor
const sv = mainScript.match(/shouldVirtualize:\s*function\s*\(\)\s*\{[\s\S]*?\n\s*\},/);
assert(!!sv, 'shouldVirtualize function found');
if (sv) {
    assert(sv[0].includes('VIRT_MIN_BLOCKS') && sv[0].includes('VIRT_MIN_CHARS'),
        'shouldVirtualize uses VIRT_MIN_* constants');
    assert(!/16000/.test(sv[0]), 'shouldVirtualize does not hardcode 16000');
    assert(!sv[0].includes('LARGE_DOC_CHARS'), 'shouldVirtualize does not use LARGE_DOC_CHARS');
}

console.log('=== progressive is M-band only (not Source-first chars) ===');
{
    // loadMarkdownContent progressive gate must not use LARGE_DOC_CHARS / text.length
    const loadIdx = mainScript.indexOf('function loadMarkdownContent');
    assert(loadIdx > 0, 'loadMarkdownContent found');
    // Slice until next top-level function after load body (insertPasted / similar)
    const loadChunk = mainScript.slice(loadIdx, loadIdx + 12000);
    assert(loadChunk.includes('PROGRESSIVE_PAINT_BLOCKS')
        || loadChunk.includes('paintFloor'),
        'progressive uses paint block floor');
    assert(loadChunk.includes('PROGRESSIVE_CREATE_BATCH_BLOCKS')
        || loadChunk.includes('createFloor'),
        'windowed create uses named create floor');
    // The dual-use bug: progressive = ... text.length >= LARGE_DOC_CHARS
    assert(!/text\.length\s*>=\s*LARGE_DOC_CHARS/.test(loadChunk),
        'progressive does NOT gate on text.length >= LARGE_DOC_CHARS');
    assert(!/progressive\s*=\s*[^\n]*LARGE_DOC_CHARS/.test(loadChunk),
        'progressive assignment does not reference LARGE_DOC_CHARS');
    // Virt still wins first
    assert(loadChunk.includes('shouldVirtualize'), 'virt check before progressive path');
}

console.log('=== progressive decision table (mirror) ===');
{
    const PROGRESSIVE_PAINT_BLOCKS = 800;
    const PROGRESSIVE_CREATE_BATCH_BLOCKS = 1500;
    const VIRT_MIN_BLOCKS = 2000;
    const VIRT_MIN_CHARS = 120000;
    function band(blocks, chars, deferPaint) {
        if (blocks >= VIRT_MIN_BLOCKS || chars >= VIRT_MIN_CHARS) return 'virt';
        const progressive = !!deferPaint || blocks >= PROGRESSIVE_PAINT_BLOCKS;
        if (!progressive) return 'immediate';
        if (blocks >= PROGRESSIVE_CREATE_BATCH_BLOCKS) return 'progressive+windowed';
        return 'progressive';
    }
    assert(band(100, 20000) === 'immediate',
        '100 blocks / 20KB → immediate (chars alone do not force progressive)');
    assert(band(800, 5000) === 'progressive', '800 blocks → progressive');
    assert(band(1500, 5000) === 'progressive+windowed', '1500 blocks → windowed create');
    assert(band(2000, 1000) === 'virt', '2000 blocks → virt (not progressive)');
    assert(band(10, 120000) === 'virt', '120KB → virt');
    assert(band(50, 5000, true) === 'progressive', 'explicit deferPaint → progressive');
}

console.log('=== height helpers present ===');
assert(mainScript.includes('estimateBlockHeight'), 'estimateBlockHeight');
assert(mainScript.includes('prefixHeight'), 'prefixHeight');
assert(mainScript.includes('indexAtScrollTop'), 'indexAtScrollTop');
assert(mainScript.includes('ensureHeights'), 'ensureHeights');
assert(mainScript.includes('setMeasuredHeight'), 'setMeasuredHeight');
assert(mainScript.includes('blockHeights'), 'blockHeights field');

// Extract a tiny harness for shouldVirtualize + estimate + prefix
function extractFunctionProp(objSrc, name) {
    // not needed — build minimal model
}

console.log('=== shouldVirtualize logic (in-process) ===');
{
    // Mirror the constants and function from template
    const VIRT_MIN_CHARS = 120000;
    const VIRT_MIN_BLOCKS = 2000;
    function shouldVirtualize(blocksLen, mdLen) {
        return blocksLen >= VIRT_MIN_BLOCKS || mdLen >= VIRT_MIN_CHARS;
    }
    assert(!shouldVirtualize(100, 10000), 'small note (100 blocks / 10KB) is NOT virtualized');
    assert(!shouldVirtualize(500, 50000), 'medium note (500 blocks / 50KB) is NOT virtualized');
    assert(shouldVirtualize(2000, 1000), '2000 blocks IS virtualized');
    assert(shouldVirtualize(10, 120000), '120KB IS virtualized');
    assert(!shouldVirtualize(799, 15999), 'old 16KB/800 threshold no longer forces virt alone');
}

console.log('=== estimate heights (fence vs plain) ===');
{
    // Pull estimateBlockHeight body by eval of a minimal DocumentModel slice
    const start = mainScript.indexOf('estimateBlockHeight: function');
    const end = mainScript.indexOf('ensureHeights: function');
    assert(start > 0 && end > start, 'can locate estimateBlockHeight');
    const slice = 'const obj = { rowHeight: 28, ' + mainScript.slice(start, end) + '}; return obj;';
    const obj = new Function(slice)();
    const plain = obj.estimateBlockHeight('hello world');
    const fence = obj.estimateBlockHeight('```js\n' + 'line\n'.repeat(40) + '```');
    const table = obj.estimateBlockHeight('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    assert(plain >= 18 && plain <= 40, 'plain ~rowHeight (got ' + plain + ')');
    assert(fence > plain * 2, 'fence taller than plain (fence=' + fence + ' plain=' + plain + ')');
    assert(table > plain, 'table taller than plain (table=' + table + ')');
    const img = obj.estimateBlockHeight('![alt](photo.png)');
    assert(img >= 100, 'image estimate much taller than plain row (got ' + img + ')');
    assert(img > plain * 2, 'image estimate > 2× plain');
    const twoImg = obj.estimateBlockHeight('![a](a.png)\n![b](b.png)');
    assert(twoImg >= img, 'two images >= one image estimate');
}

console.log('=== prefix sums monotonic ===');
{
    const start = mainScript.indexOf('estimateBlockHeight: function');
    const end = mainScript.indexOf('insertBlockAfterIndex: function');
    const slice = 'const obj = { rowHeight: 28, blocks: [], blockHeights: null, ' +
        mainScript.slice(start, end) + '}; return obj;';
    const obj = new Function(slice)();
    obj.blocks = [
        { raw: 'a' },
        { raw: '```\n' + 'x\n'.repeat(20) + '```' },
        { raw: 'b' }
    ];
    obj.blockHeights = null;
    obj.ensureHeights();
    const p0 = obj.prefixHeight(0);
    const p1 = obj.prefixHeight(1);
    const p2 = obj.prefixHeight(2);
    const p3 = obj.prefixHeight(3);
    assert(p0 === 0, 'prefix(0)=0');
    assert(p1 > 0 && p2 > p1 && p3 > p2, 'prefix heights increase');
    assert(obj.totalHeight() === p3, 'totalHeight = prefix(n)');
    assert(obj.indexAtScrollTop(0) === 0, 'scroll 0 → index 0');
    assert(obj.indexAtScrollTop(p1 + 1) >= 1, 'scroll past first → index >= 1');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nVIRT THRESHOLDS SELFTEST FAILED');
    process.exit(1);
}
console.log('\nVIRT THRESHOLDS SELFTEST PASSED');
