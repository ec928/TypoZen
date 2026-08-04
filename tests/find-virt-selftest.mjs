/**
 * Virt find: full-document search must use model markdown, not only mounted DOM.
 * Also exercises markdownOffset → block mapping used to scroll/mount hits.
 *
 * node tests/find-virt-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>', {
    url: 'https://localapp/TypoZen_Template_Test.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
});
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;

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

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

console.log('=== template contains virt find paths ===');
assert(mainScript.includes("kind: 'model'") || mainScript.includes('kind: "model"')
    || mainScript.includes("kind = 'model'") || mainScript.includes("kind === 'model'"),
    'model find kind present');
assert(mainScript.includes('function markdownOffsetToBlock'), 'markdownOffsetToBlock');
assert(mainScript.includes('function revealModelMatch'), 'revealModelMatch');
assert(mainScript.includes('function highlightModelMatchInMountedDom'), 'highlightModelMatchInMountedDom');
assert(mainScript.includes('DocumentModel.virtEnabled'), 'checks virtEnabled for haystack');
assert(mainScript.includes('refreshFindAfterVirtMount'), 'refresh after virt mount');
// Must search model when virt — not only buildWysiwygSearchIndex
assert(mainScript.includes('virtEnabled') && mainScript.includes('toMarkdown'),
    'virt path uses model toMarkdown');

console.log('=== findAllIndices (shared) ===');
{
    const src = extractFunction('findAllIndices') + '\n'
        + extractFunction('isWordChar') + '\n'
        + 'return { findAllIndices, isWordChar };';
    const api = new Function(src)();
    const m = api.findAllIndices('aaa bbb aaa', 'aaa', {});
    assert(m.length === 2 && m[0].start === 0 && m[1].start === 8, 'two matches');
    const ww = api.findAllIndices('cat catalog cat', 'cat', { wholeWord: true });
    assert(ww.length === 2, 'whole word skips catalog (got ' + ww.length + ')');
}

console.log('=== markdownOffsetToBlock mapping ===');
{
    // Standalone copy of the function logic with a mock DocumentModel
    const src = `
        const DocumentModel = {
            blocks: [
                { raw: 'alpha' },
                { raw: 'needle here' },
                { raw: 'omega' }
            ]
        };
        ${extractFunction('markdownOffsetToBlock')}
        return markdownOffsetToBlock;
    `;
    const markdownOffsetToBlock = new Function(src)();
    // 'alpha\nneedle here\nomega'
    // 012345 6...
    const a = markdownOffsetToBlock(0);
    assert(a.blockIndex === 0 && a.offsetInBlock === 0, 'offset 0 → block 0');
    const n = markdownOffsetToBlock(6); // start of 'needle'
    assert(n.blockIndex === 1 && n.offsetInBlock === 0,
        'offset 6 → block 1 start (got block ' + n.blockIndex + ' off ' + n.offsetInBlock + ')');
    const mid = markdownOffsetToBlock(6 + 'needle '.length);
    assert(mid.blockIndex === 1 && mid.offsetInBlock === 'needle '.length,
        'mid needle block (got ' + mid.offsetInBlock + ')');
    // Full doc search would find 'needle' at 6
    const hay = DocumentModelBlocksJoin([
        { raw: 'alpha' }, { raw: 'needle here' }, { raw: 'omega' }
    ]);
    function DocumentModelBlocksJoin(blocks) {
        return blocks.map(b => b.raw).join('\n');
    }
    assert(hay.indexOf('needle') === 6, 'haystack offset for needle is 6');
    const loc = markdownOffsetToBlock(hay.indexOf('needle'));
    assert(loc.blockIndex === 1, 'needle maps to middle block');
}

console.log('=== model haystack includes off-screen content (logic) ===');
{
    // Simulate: only block 0 mounted in DOM, but model has needle in block 50
    const blocks = [];
    for (let i = 0; i < 60; i++) {
        blocks.push({ raw: i === 50 ? 'the needle is here' : ('line ' + i) });
    }
    const md = blocks.map(b => b.raw).join('\n');
    const mountedHaystack = 'line 0'; // pretend only first block mounted
    assert(mountedHaystack.indexOf('needle') < 0, 'mounted DOM would miss needle');
    assert(md.indexOf('needle') >= 0, 'full model haystack finds needle');
    const start = md.indexOf('needle');
    // Map to block
    let pos = 0, bi = -1;
    for (let i = 0; i < blocks.length; i++) {
        const end = pos + blocks[i].raw.length;
        if (start < end || (start === end && i === blocks.length - 1)) { bi = i; break; }
        pos = end + 1;
    }
    assert(bi === 50, 'needle at block 50 (got ' + bi + ')');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nFIND VIRT SELFTEST FAILED');
    process.exit(1);
}
console.log('\nFIND VIRT SELFTEST PASSED');
