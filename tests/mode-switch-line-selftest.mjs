/**
 * Source ↔ Preview sticky line: capture line N, restore line N, never drift.
 *
 * node tests/mode-switch-line-selftest.mjs
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

console.log('=== sticky helpers exist ===');
assert(mainScript.includes('function captureStickyDocumentLine'), 'captureStickyDocumentLine');
assert(mainScript.includes('function restoreStickyDocumentLine'), 'restoreStickyDocumentLine');
assert(mainScript.includes('function ensureModelBlockVisible'), 'ensureModelBlockVisible (DOM snap)');
assert(mainScript.includes('function lineFromMarkdownOffset'), 'lineFromMarkdownOffset');
assert(mainScript.includes('function modelLocationFromDocumentLine'), 'modelLocationFromDocumentLine');
assert(mainScript.includes('_stickyLineCache'), 'focus-steal sticky cache');
assert(mainScript.includes('rememberStickyFromSourceIfFocused'), 'source focus cache bump');
// Mode switch must use sticky helpers + loadMarkdownContent stickyLine
assert(mainScript.includes('captureStickyDocumentLine()'), 'toggle_mode calls capture');
assert(mainScript.includes('restoreStickyDocumentLine(stickyLine)'), 'toggle_mode calls restore');
assert(mainScript.includes('stickyLine: stickyLine') || mainScript.includes('stickyLine:stickyLine'),
    'loadMarkdownContent receives stickyLine');
assert(mainScript.includes('stickyWanted'), 'load skips forced top/Ln1 when sticky');
// Preview restore must snap with real geometry, not prefixHeight alone
assert(mainScript.includes('ensureModelBlockVisible(bi'),
    'restoreStickyDocumentLine uses ensureModelBlockVisible');
assert(mainScript.includes('getBoundingClientRect()'),
    'geometric snap uses getBoundingClientRect');
// Find must not scroll when navigate:false
assert(mainScript.includes('navigate=false: update count/highlights only')
    || mainScript.includes('do NOT move caret/scroll'),
    'find navigate=false documented');

console.log('=== focus-steal capture contract ===');
{
    // Mirrors captureStickyDocumentLine poison guard:
    // selectionStart===0 with cache>1 must not clobber sticky to line 1.
    let cache = 1;
    let lastCaret = 1;
    function remember(n) {
        if (n >= 1) { cache = n; lastCaret = n; }
    }
    function capture(mode, activeIsSource, selectionStart, value) {
        const frozen = Math.max(1, cache, lastCaret);
        if (mode === 'source') {
            if (activeIsSource) {
                let line = 1;
                for (let i = 0; i < selectionStart; i++) if (value.charCodeAt(i) === 10) line++;
                // poison: offset 0 → line 1 while we already know a higher line
                if (line <= 1 && cache > 1 && (selectionStart | 0) === 0) return frozen;
                remember(line);
                return line;
            }
            return frozen;
        }
        return frozen;
    }
    const md = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq'; // 17 lines
    // walk to line 16
    let pos = 0, ln = 1;
    while (ln < 16 && pos < md.length) {
        if (md.charCodeAt(pos) === 10) ln++;
        pos++;
    }
    assert(capture('source', true, pos, md) === 16, 'focused on L16 → capture 16');
    assert(capture('source', false, 0, md) === 16, 'after blur selectionStart=0 → still 16 from cache');
    assert(capture('source', false, 0, md) !== 1 || cache === 16, 'never collapse to 1 after blur');
    // Host chrome can zero selectionStart while focus still reports the textarea
    assert(capture('source', true, 0, md) === 16,
        'focused but selectionStart=0 (poison) → still 16 from cache, not 1');
}

console.log('=== lineFromMarkdownOffset (pure) ===');
{
    const fn = new Function(
        extractFunction('lineFromMarkdownOffset') +
        '; return lineFromMarkdownOffset;'
    )();
    const md = 'a\nb\nc\nd\ne';
    assert(fn(md, 0) === 1, 'offset 0 → line 1');
    assert(fn(md, 1) === 1, 'offset on first line → 1');
    assert(fn(md, 2) === 2, 'offset after first \\n → 2');
    assert(fn(md, md.length) === 5, 'EOF → last line 5');
    // 4532-line style
    const lines = [];
    for (let i = 1; i <= 4532; i++) lines.push('row ' + i);
    const big = lines.join('\n');
    assert(fn(big, 0) === 1, 'big L1');
    // offset at start of line 2200
    let pos = 0, ln = 1;
    while (ln < 2200 && pos < big.length) {
        if (big.charCodeAt(pos) === 10) ln++;
        pos++;
    }
    assert(fn(big, pos) === 2200, 'big L2200 (got ' + fn(big, pos) + ')');
    // start of last line
    pos = 0; ln = 1;
    while (ln < 4532 && pos < big.length) {
        if (big.charCodeAt(pos) === 10) ln++;
        pos++;
    }
    assert(fn(big, pos) === 4532, 'big L4532 (got ' + fn(big, pos) + ')');
}

console.log('=== model line ↔ block round-trip (no drift) ===');
{
    // One hard line per block (typical note)
    const blocks = [];
    for (let i = 1; i <= 200; i++) blocks.push({ raw: 'line content ' + i });
    const src =
        'const DocumentModel = { blocks: ' + JSON.stringify(blocks) + ' };\n' +
        extractFunction('linesInBlockRaw') + '\n' +
        extractFunction('modelBlockStartLine') + '\n' +
        extractFunction('modelLocationFromDocumentLine') + '\n' +
        'return { modelBlockStartLine, modelLocationFromDocumentLine, linesInBlockRaw };';
    const api = new Function(src)();

    let drift = 0;
    for (let L = 1; L <= 200; L++) {
        const loc = api.modelLocationFromDocumentLine(L);
        const back = api.modelBlockStartLine(loc.blockIndex) + loc.within;
        if (back !== L) {
            drift++;
            if (drift <= 3) console.error('    drift L=' + L + ' → block ' + loc.blockIndex +
                ' within ' + loc.within + ' → ' + back);
        }
    }
    assert(drift === 0, '200 single-line blocks: location round-trip (drift=' + drift + ')');

    // Multi-line fence block in the middle
    const blocks2 = [
        { raw: 'aaa' },
        { raw: '```\ncode1\ncode2\ncode3\n```' },
        { raw: 'bbb' },
        { raw: 'ccc' }
    ];
    // lines: 1=aaa, 2-6=fence (5 lines), 7=bbb, 8=ccc
    const src2 =
        'const DocumentModel = { blocks: ' + JSON.stringify(blocks2) + ' };\n' +
        extractFunction('linesInBlockRaw') + '\n' +
        extractFunction('modelBlockStartLine') + '\n' +
        extractFunction('modelLocationFromDocumentLine') + '\n' +
        'return { modelBlockStartLine, modelLocationFromDocumentLine };';
    const api2 = new Function(src2)();
    assert(api2.modelBlockStartLine(0) === 1, 'block0 starts line 1');
    assert(api2.modelBlockStartLine(1) === 2, 'fence starts line 2');
    assert(api2.modelBlockStartLine(2) === 7, 'bbb starts line 7');
    const loc5 = api2.modelLocationFromDocumentLine(5);
    assert(loc5.blockIndex === 1, 'line 5 is inside fence block');
    const back5 = api2.modelBlockStartLine(loc5.blockIndex) + loc5.within;
    assert(back5 === 5, 'line 5 round-trips (got ' + back5 + ')');
}

console.log('=== sticky simulation: N switches without drift ===');
{
    // Pure simulation of capture/restore contract for single-line blocks
    const N = 100;
    const blocks = [];
    for (let i = 1; i <= N; i++) blocks.push({ raw: 'L' + i });
    const src =
        'const DocumentModel = { blocks: ' + JSON.stringify(blocks) + ' };\n' +
        extractFunction('linesInBlockRaw') + '\n' +
        extractFunction('modelBlockStartLine') + '\n' +
        extractFunction('modelLocationFromDocumentLine') + '\n' +
        extractFunction('lineFromMarkdownOffset') + '\n' +
        extractFunction('countHardLines') + '\n' +
        extractFunction('sourceOffsetAtHardLine') + '\n' +
        'return { modelBlockStartLine, modelLocationFromDocumentLine, lineFromMarkdownOffset, countHardLines, sourceOffsetAtHardLine };';
    const api = new Function(src)();
    const md = blocks.map(b => b.raw).join('\n');

    function captureFromSource(line) {
        const off = api.sourceOffsetAtHardLine(md, line);
        return api.lineFromMarkdownOffset(md, off);
    }
    function captureFromPreview(line) {
        const loc = api.modelLocationFromDocumentLine(line);
        return api.modelBlockStartLine(loc.blockIndex) + loc.within;
    }
    // Simulate: start line 1, alternate source/preview capture 20 times
    let line = 1;
    for (let i = 0; i < 20; i++) {
        line = captureFromSource(line);
        line = captureFromPreview(line);
    }
    assert(line === 1, '20 mode switches from L1 stay at L1 (got ' + line + ')');

    line = 50;
    for (let i = 0; i < 20; i++) {
        line = captureFromSource(line);
        line = captureFromPreview(line);
    }
    assert(line === 50, '20 mode switches from L50 stay at L50 (got ' + line + ')');

    line = N;
    for (let i = 0; i < 20; i++) {
        line = captureFromSource(line);
        line = captureFromPreview(line);
    }
    assert(line === N, '20 mode switches from last line stay (got ' + line + ')');
}

console.log('=== proportional source scroll: last line → max, first → 0 ===');
{
    // Contract of scrollSourceToHardLine without DOM
    function scrollTopForLine(line, total, maxScroll) {
        if (total <= 1 || maxScroll <= 0 || line <= 1) return 0;
        if (line >= total) return maxScroll;
        return Math.round(maxScroll * ((line - 1) / (total - 1)));
    }
    assert(scrollTopForLine(1, 4532, 100000) === 0, 'L1 → scroll 0');
    assert(scrollTopForLine(4532, 4532, 100000) === 100000, 'last → max');
    const mid = scrollTopForLine(2266, 4532, 100000);
    assert(mid > 40000 && mid < 60000, 'mid line near mid scroll (got ' + mid + ')');
}

console.log('=== source viewport sticky (scroll without caret) ===');
{
    // Invert proportional map — hardLineFromSourceScrollTop contract
    function lineFromScroll(st, total, maxScroll) {
        if (total <= 1 || maxScroll <= 0) return 1;
        if (st <= 2) return 1;
        if (st >= maxScroll - 2) return total;
        return Math.max(1, Math.min(total, Math.round(1 + (st / maxScroll) * (total - 1))));
    }
    function modeSwitchChoose(viewLine, caretLine) {
        return (Math.abs(viewLine - caretLine) > 12) ? viewLine : caretLine;
    }
    assert(lineFromScroll(0, 4000, 100000) === 1, 'scroll top → L1');
    assert(lineFromScroll(100000, 4000, 100000) === 4000, 'scroll end → last');
    const midSt = Math.round(100000 * (3000 - 1) / (4000 - 1));
    const midLn = lineFromScroll(midSt, 4000, 100000);
    assert(Math.abs(midLn - 3000) <= 2, 'scroll mid → ~L3000 (got ' + midLn + ')');
    // User scrolled to 3000, caret still at 700
    assert(modeSwitchChoose(3000, 700) === 3000, 'viewport wins over stale caret 700');
    assert(modeSwitchChoose(2000, 1995) === 1995, 'near caret preferred when close');
    assert(mainScript.includes('hardLineFromSourceScrollTop'), 'hardLineFromSourceScrollTop exists');
    assert(mainScript.includes('captureSourceStickyLineForModeSwitch'),
        'mode switch uses source viewport capture');
    assert(mainScript.includes('function hardLineFromPreviewViewport'),
        'hardLineFromPreviewViewport exists (Preview scroll sticky)');
    assert(mainScript.includes('rememberStickyFromPreviewScroll'),
        'Preview scroll updates sticky cache');
    assert(mainScript.includes('snapshotMultiBlockSelectionFromLive'),
        'multi-block Delete freezes model selection for Shift+scroll');
    assert(mainScript.includes('applyModelMultiBlockDelete'),
        'multi-block Delete mutates full DocumentModel not only mounted DOM');
    assert(mainScript.includes('anchorIndex'), 'virt mount accepts locked anchor');
}

console.log('=== preview geometric snap contract (overshoot fix) ===');
{
    // prefixHeight estimate too high → scrollTop places block above viewport.
    // Snap: newScroll = oldScroll + (rect.top - (cRect.top + pad))
    function snapScrollTop(scrollTop, blockTop, containerTop, pad) {
        const delta = blockTop - (containerTop + pad);
        return Math.max(0, scrollTop + delta);
    }
    // Simulated overshoot: estimate put us 200px past the real block
    const pad = 48;
    const containerTop = 100;
    const realBlockTop = 40; // above viewport (containerTop=100)
    const overshotScroll = 500;
    const fixed = snapScrollTop(overshotScroll, realBlockTop, containerTop, pad);
    // After snap, blockTop should map to containerTop+pad
    // delta = 40 - (100+48) = -108 → scroll 500-108 = 392
    assert(fixed === 392, 'overshoot snap reduces scroll (got ' + fixed + ')');
    // Undershoot: block is too low in viewport
    const undershot = snapScrollTop(100, 400, 100, pad);
    // delta = 400 - 148 = 252 → scroll 352
    assert(undershot === 352, 'undershoot snap increases scroll (got ' + undershot + ')');
    // Already aligned: delta ~0
    const aligned = snapScrollTop(200, 148, 100, pad);
    assert(aligned === 200, 'aligned leaves scroll unchanged (got ' + aligned + ')');
    // Case 1/2 regression: status Ln 16 with block above fold must still correct scroll
    assert(fixed < overshotScroll, 'Case1/2: overshoot correction moves scroll up');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nMODE SWITCH LINE SELFTEST FAILED');
    process.exit(1);
}
console.log('\nMODE SWITCH LINE SELFTEST PASSED');
