/**
 * Property-based virt/DocumentModel invariants over a full mid/large document.
 * Pulls real methods from TypoZen_Template_Test.html (no stubs).
 *
 * node tests/virt-invariants.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');
const mainScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).sort((a, b) => b.length - a.length)[0];

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

/** Extract a method body `name: function (...) { ... },` from DocumentModel-ish region. */
function extractMethod(name) {
    const re = new RegExp(name + '\\s*:\\s*function\\s*\\(');
    const idx = mainScript.search(re);
    if (idx < 0) throw new Error('missing method ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        if (mainScript[i] === '{') depth++;
        else if (mainScript[i] === '}') {
            depth--;
            if (depth === 0) {
                // include trailing comma-friendly end
                return mainScript.slice(idx, i + 1);
            }
        }
    }
    throw new Error('unclosed ' + name);
}

function extractFunction(name) {
    const startRe = new RegExp('function\\s+' + name + '\\s*\\(');
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx), depth = 0;
    for (; i < mainScript.length; i++) {
        if (mainScript[i] === '{') depth++;
        else if (mainScript[i] === '}' && --depth === 0) return mainScript.slice(idx, i + 1);
    }
    throw new Error('unclosed ' + name);
}

// Constants from template
const VIRT_MIN_CHARS = 120000;
const VIRT_MIN_BLOCKS = 2000;

// Build a live DocumentModel object from production method sources
const modelSrc = `
function coerceBlockRaw(raw) {
  return String(raw == null ? '' : raw);
}
${extractFunction('splitMarkdownToBlockRaws')}
const DocumentModel = {
  blocks: [],
  _nextId: 1,
  virtEnabled: false,
  virtStart: 0,
  virtEnd: 0,
  rowHeight: 28,
  overscan: 40,
  blockHeights: null,
  ${extractMethod('fromMarkdown')},
  ${extractMethod('toMarkdown')},
  ${extractMethod('setBlockRaw')},
  ${extractMethod('modelIndexOfEl')},
  ${extractMethod('estimateBlockHeight')},
  ${extractMethod('ensureHeights')},
  ${extractMethod('invalidateHeights')},
  ${extractMethod('setMeasuredHeight')},
  ${extractMethod('prefixHeight')},
  ${extractMethod('totalHeight')},
  ${extractMethod('indexAtScrollTop')},
  ${extractMethod('shouldVirtualize')},
  ${extractMethod('insertBlockAfterIndex')},
  ${extractMethod('removeBlockAt')},
  ${extractMethod('removeBlockRange')}
};
return DocumentModel;
`;

let DocumentModel;
try {
    // shouldVirtualize() reads the `editor` global to bail out in 2-column layout.
    // These methods run outside the app here, so the global has to be supplied or the
    // bare reference throws ReferenceError rather than short-circuiting.
    // shouldVirtualize() also asks isPaginatedLayout(): virtualisation is refused while
    // the document is laid out as pages, because the browser can only break content it
    // has actually laid out. Outside the app that helper does not exist, so stub it as
    // "not paginated" -- these invariants are about the scrolling path.
    const editorStub = { classList: { contains: () => false } };
    const isPaginatedLayout = () => false;
    DocumentModel = new Function(
        'VIRT_MIN_CHARS', 'VIRT_MIN_BLOCKS', 'editor', 'isPaginatedLayout',
        modelSrc
    )(VIRT_MIN_CHARS, VIRT_MIN_BLOCKS, editorStub, isPaginatedLayout);
} catch (e) {
    console.error('Failed to build DocumentModel from template:', e);
    process.exit(1);
}

console.log('=== Section 1: build large doc + round-trip ===');
{
    const lines = [];
    for (let i = 0; i < 2926; i++) {
        if (i % 200 === 0 && i > 0) {
            lines.push('```\n' + 'code line\n'.repeat(5) + '```');
        } else if (i % 350 === 0 && i > 0) {
            lines.push('![img](pic-' + i + '.png)');
        } else if (i % 100 === 0) {
            lines.push('# Section ' + (i / 100));
        } else {
            lines.push('row content ' + i + ' with some filler text');
        }
    }
    const md = lines.join('\n');
    DocumentModel.fromMarkdown(md);
    const back = DocumentModel.toMarkdown();
    // fromMarkdown uses splitMarkdownToBlockRaws — fences become one block
    assert(DocumentModel.blocks.length > 2000, 'large doc has many blocks (got ' + DocumentModel.blocks.length + ')');
    assert(back.length > 100000, 'markdown size > 100KB (got ' + back.length + ')');
    // Round-trip: re-parse should preserve block count
    const n1 = DocumentModel.blocks.length;
    DocumentModel.fromMarkdown(DocumentModel.toMarkdown());
    assert(DocumentModel.blocks.length === n1, 'round-trip preserves block count (got ' + DocumentModel.blocks.length + ' vs ' + n1 + ')');
}

console.log('=== Section 2: prefixHeight / indexAtScrollTop invariants ===');
{
    DocumentModel.blockHeights = null;
    DocumentModel.ensureHeights();
    const n = DocumentModel.blocks.length;
    let monoOk = true;
    let mapOk = true;
    let failAt = -1;
    for (let i = 0; i < n; i++) {
        const p = DocumentModel.prefixHeight(i);
        if (i > 0 && p < DocumentModel.prefixHeight(i - 1)) {
            monoOk = false;
            failAt = i;
            break;
        }
        const at = DocumentModel.indexAtScrollTop(p);
        // At exact block start, indexAtScrollTop should return i
        // (first block whose bottom is past scrollTop; at y=prefix(i), block i starts)
        if (at !== i) {
            // edge: if height is 0 somehow
            if (DocumentModel.blockHeights[i] > 0) {
                mapOk = false;
                failAt = i;
                break;
            }
        }
    }
    assert(monoOk, 'prefixHeight monotonic (failAt=' + failAt + ')');
    assert(mapOk, 'indexAtScrollTop(prefixHeight(i)) === i for all i (failAt=' + failAt + ')');
    assert(DocumentModel.totalHeight() === DocumentModel.prefixHeight(n),
        'totalHeight === prefixHeight(n)');
    assert(DocumentModel.prefixHeight(0) === 0, 'prefixHeight(0) === 0');
}

console.log('=== Section 3: measure refinement keeps map ===');
{
    // Override ~1/3 of heights with "measured" values
    const n = DocumentModel.blocks.length;
    let overrides = 0;
    for (let i = 0; i < n; i += 3) {
        const h = (DocumentModel.blockHeights[i] || 28) + ((i % 17) - 8);
        DocumentModel.setMeasuredHeight(i, Math.max(14, h));
        overrides++;
    }
    let mapOk = true;
    let failAt = -1;
    for (let i = 0; i < n; i++) {
        const at = DocumentModel.indexAtScrollTop(DocumentModel.prefixHeight(i));
        if (at !== i && (DocumentModel.blockHeights[i] || 0) > 0) {
            mapOk = false;
            failAt = i;
            break;
        }
    }
    assert(overrides > 500, 'applied many measured overrides (got ' + overrides + ')');
    assert(mapOk, 'map still holds after measure overrides (failAt=' + failAt + ')');
}

console.log('=== Section 4: image estimates ===');
{
    const plain = DocumentModel.estimateBlockHeight('hello');
    const img = DocumentModel.estimateBlockHeight('![a](x.png)');
    const two = DocumentModel.estimateBlockHeight('![a](x.png)\n![b](y.png)');
    assert(img >= 100 && img > plain * 2, 'image estimate tall (got ' + img + ')');
    assert(two >= img, 'two images stack >= one');
    assert(img <= 900, 'image estimate capped');
}

console.log('=== Section 5: shouldVirtualize thresholds ===');
{
    // Behavioural: build docs of known sizes
    function docOfBlocks(n) {
        const lines = [];
        for (let i = 0; i < n; i++) lines.push('x' + i);
        DocumentModel.fromMarkdown(lines.join('\n'));
        return DocumentModel.shouldVirtualize();
    }
    function docOfChars(targetChars) {
        // One long line-ish via many medium lines
        const line = 'word '.repeat(20);
        const lines = [];
        let len = 0;
        while (len < targetChars) {
            lines.push(line);
            len += line.length + 1;
        }
        DocumentModel.fromMarkdown(lines.join('\n'));
        return { virt: DocumentModel.shouldVirtualize(), len: DocumentModel.toMarkdown().length, n: DocumentModel.blocks.length };
    }
    assert(!docOfBlocks(100), '100 blocks → not virt');
    assert(!docOfBlocks(1999), '1999 blocks → not virt');
    assert(docOfBlocks(2000), '2000 blocks → virt');
    const justOver16k = docOfChars(17000);
    assert(!justOver16k.virt || justOver16k.n >= VIRT_MIN_BLOCKS,
        'just over 16KB alone does not force virt (virt=' + justOver16k.virt + ' n=' + justOver16k.n + ' len=' + justOver16k.len + ')');
    // Force chars without 2000 blocks: long lines, fewer blocks
    {
        const big = 'Z'.repeat(120000);
        DocumentModel.fromMarkdown(big);
        assert(DocumentModel.shouldVirtualize(), '120KB single-ish content → virt');
        assert(DocumentModel.blocks.length < 2000, 'char-triggered virt without 2000 blocks');
    }
}

console.log('=== Section 6: insertBlockAfterIndex returns real index ===');
{
    DocumentModel.fromMarkdown('a\nb\nc'); // 3 blocks, indices 0,1,2
    assert(DocumentModel.blocks.length === 3, 'start with 3 blocks');

    // Insert after last in-range
    let ni = DocumentModel.insertBlockAfterIndex(2, 'after-last');
    assert(ni === 3, 'insert after last → index 3 (got ' + ni + ')');
    assert(DocumentModel.blocks[ni].raw === 'after-last', 'raw at returned index');
    assert(DocumentModel.blocks.length === 4, 'length 4');

    // OOB high: push, must return actual end index not index+1
    ni = DocumentModel.insertBlockAfterIndex(99, 'oob-high');
    assert(ni === DocumentModel.blocks.length - 1, 'OOB high returns last index (got ' + ni + ')');
    assert(ni === 4, 'OOB high → 4 not 100 (got ' + ni + ')');
    assert(DocumentModel.blocks[ni].raw === 'oob-high', 'oob-high content at returned index');

    // OOB negative
    DocumentModel.fromMarkdown('a\nb\nc');
    ni = DocumentModel.insertBlockAfterIndex(-1, 'oob-neg');
    assert(ni === DocumentModel.blocks.length - 1, 'OOB -1 returns last index (got ' + ni + ')');
    assert(ni === 3, 'OOB -1 → 3 not 0 (got ' + ni + ')');
    assert(DocumentModel.blocks[ni].raw === 'oob-neg', 'oob-neg at returned index');
    assert(DocumentModel.blocks[0].raw === 'a', 'index 0 still a');
}

console.log('=== Section 7: modelIndexOfEl bounds ===');
{
    DocumentModel.fromMarkdown('a\nb\nc');
    function fakeEl(idx) {
        return { getAttribute: (k) => (k === 'data-model-index' ? String(idx) : null) };
    }
    assert(DocumentModel.modelIndexOfEl(fakeEl(0)) === 0, 'valid 0');
    assert(DocumentModel.modelIndexOfEl(fakeEl(2)) === 2, 'valid 2');
    assert(DocumentModel.modelIndexOfEl(fakeEl(7)) === -1, 'stale 7 on 3-block model → -1');
    assert(DocumentModel.modelIndexOfEl(fakeEl(-3)) === -1, 'negative → -1');
    assert(DocumentModel.modelIndexOfEl(fakeEl('x')) === -1, 'NaN → -1');
    assert(DocumentModel.modelIndexOfEl(null) === -1, 'null → -1');

    // Stale tag must not reach setBlockRaw (syncElToModel contract)
    const stale = {
        getAttribute: (k) => {
            if (k === 'data-model-index') return '7';
            if (k === 'data-raw') return 'LOST_EDIT';
            return null;
        }
    };
    const before = DocumentModel.toMarkdown();
    const mi = DocumentModel.modelIndexOfEl(stale);
    assert(mi < 0, 'stale el → modelIndexOfEl < 0 (got ' + mi + ')');
    if (mi >= 0) DocumentModel.setBlockRaw(mi, 'LOST_EDIT'); // would be the silent-loss path
    assert(DocumentModel.toMarkdown() === before, 'stale index path does not mutate model');
    assert(DocumentModel.blocks.length === 3, 'still 3 blocks after stale sync attempt');
}

console.log('=== Section 8: delete integrity + remap ===');
{
    DocumentModel.fromMarkdown('a\nb\nc\nd\ne');
    DocumentModel.ensureHeights();
    DocumentModel.removeBlockAt(2); // remove c
    assert(DocumentModel.blocks.map(b => b.raw).join(',') === 'a,b,d,e',
        'remove middle (got ' + DocumentModel.blocks.map(b => b.raw).join(',') + ')');
    // Heights invalidated
    DocumentModel.ensureHeights();
    const n = DocumentModel.blocks.length;
    let ok = true;
    for (let i = 0; i < n; i++) {
        if (DocumentModel.indexAtScrollTop(DocumentModel.prefixHeight(i)) !== i) ok = false;
    }
    assert(ok, 'scroll map holds after delete');
    DocumentModel.removeBlockRange(0, 1);
    assert(DocumentModel.blocks.map(b => b.raw).join(',') === 'd,e',
        'remove range (got ' + DocumentModel.blocks.map(b => b.raw).join(',') + ')');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nVIRT INVARIANTS SELFTEST FAILED');
    process.exit(1);
}
console.log('\nVIRT INVARIANTS SELFTEST PASSED');
