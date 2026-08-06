/**
 * bookGoToHref title fallback when a fragment is dangling but the link text is known.
 *
 * Matter-style: href resolves to a file (or fails), #filepos* does not exist, but the
 * outline already maps the chapter title. Title must win over a bare file start when
 * the fragment missed.
 *
 *   node tests/book-href-selftest.mjs
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

// Minimal harness: stub the globals bookGoToHref closes over, then exercise the fallback.
const harness = `
var _bookDocIndex = { 'Text/ch01.xhtml': 10, 'Text/ch02.xhtml': 50 };
var _bookAnchorIndex = { 'real-id': 77 };
var _bookTitleIndex = null;
var DocumentModel = {
    kind: 'epub',
    toc: [
        { title: '1. Factory', level: 1, blockIndex: 143 },
        { title: '2. The Ship', level: 1, blockIndex: 200 }
    ],
    blocks: [{ raw: '<p id="real-id">x</p>' }, { raw: '<p>y</p>' }]
};
var lastGoto = -1;
function goToModelBlock(idx) { lastGoto = idx; }
function bookNormalizeHref(h) {
    h = String(h || '');
    var hash = h.indexOf('#');
    if (hash >= 0) h = h.slice(0, hash);
    return h.replace(/^\\.\\//, '');
}
function bookHeadingIndex() { return {}; }
${extractFn('bookTitleKey')}
${extractFn('buildBookTitleIndex')}
${extractFn('buildBookAnchorIndex')}
${extractFn('findBookBlockWithId')}
${extractFn('bookGoToHref')}
return {
    go: function(href, text) { lastGoto = -1; var ok = bookGoToHref(href, text); return { ok: ok, idx: lastGoto }; },
    resetTitle: function() { _bookTitleIndex = null; }
};
`;

const api = new Function(harness)();

console.log('=== fragment hits keep exact target ===');
{
    const r = api.go('#real-id', '1. Factory');
    assert(r.ok && r.idx === 77, 'known id wins over title (' + r.idx + ')');
}

console.log('=== dangling fragment + title → outline target ===');
{
    api.resetTitle();
    const r = api.go('Text/ch01.xhtml#filepos3742', '1. Factory');
    assert(r.ok && r.idx === 143,
        'filepos miss + title lands on TOC block 143 (got ' + r.idx + ')');
}

console.log('=== bare file without title keeps file start ===');
{
    api.resetTitle();
    const r = api.go('Text/ch02.xhtml', '');
    assert(r.ok && r.idx === 50, 'file-only link lands at document start (' + r.idx + ')');
}

console.log('=== unknown everything fails closed ===');
{
    api.resetTitle();
    const r = api.go('#filepos999', 'No Such Chapter');
    assert(!r.ok && r.idx === -1, 'unknown link returns false');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nBOOK HREF SELFTEST FAILED');
    process.exit(1);
}
console.log('\nBOOK HREF SELFTEST PASSED');
process.exit(0);
