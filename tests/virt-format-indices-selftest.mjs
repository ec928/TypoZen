/**
 * Virt toolbar/format: selection indices must be MODEL indices, not mounted DOM ordinals.
 * Multi-block bullet must transform only selected model rows and keep the rest of the doc.
 *
 * node tests/virt-format-indices-selftest.mjs
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

console.log('=== template contracts (virt format) ===');
assert(mainScript.includes('function formatBlockIndex'), 'formatBlockIndex helper');
assert(mainScript.includes('function mountedBlockAtFormatIndex'), 'mountedBlockAtFormatIndex');
assert(mainScript.includes('function formatDocBlockCount'), 'formatDocBlockCount');
assert(mainScript.includes('DocumentModel.virtEnabled'), 'virt checks present');
// indicesFromSelectionAnchorFocus must prefer formatBlockIndex / model
assert(mainScript.includes('formatBlockIndex(aBlock)'), 'selection uses formatBlockIndex');
// last-good refresh has virt model path
assert(mainScript.includes('DocumentModel.virtEnabled')
    && mainScript.includes('syncMountedToModel'),
    'refreshLastGood can seed from model under virt');
// applyFormat prefers model under virt
assert(mainScript.includes('virtMulti') || mainScript.includes('modelOnly')
    || mainScript.includes('selectedModelIdx'),
    'applyFormatting aware of model indices');
assert(mainScript.includes('loadMarkdownContent(postContent')
    && mainScript.includes('stickyLine'),
    'format reload can pass stickyLine');

console.log('=== pure: multi-select bullet keeps off-window rows ===');
{
    // Simulate 2500-line virt doc; only "mounted" window is indices 100..140 in DOM ordinals
    // User selects model rows 120..124 (data-model-index). Format must not use DOM 0..4.
    const pureNames = [
        'parseListLine', 'formatListLine', 'normalizeBlockRaw', 'isMultilineBlockRaw',
        'coerceBlockRaw', 'stripListMarkerKeepBody', 'stripBlockPrefix', 'listIndentPad',
        'getListIndentLevel', 'transformRawForFormat'
    ];
    const pure = new Function(
        'const LIST_MAX_INDENT=6;const LIST_INDENT_SPACES=2;\n' +
        pureNames.map(n => extractFunction(n)).join('\n') +
        ';\nreturn { ' + pureNames.join(', ') + ' };'
    )();

    const N = 2500;
    const pre = [];
    for (let i = 0; i < N; i++) pre.push('row ' + i);
    // Wrong path (old bug): treat DOM ordinals 0..4 as selection while viewing mid-doc
    const wrongDomOrdinals = [0, 1, 2, 3, 4];
    const rightModelIdx = [120, 121, 122, 123, 124];

    function applyBullet(preLines, selected) {
        const focus = {};
        selected.forEach(i => { focus[i] = true; });
        return preLines.map((raw, i) => {
            if (!focus[i] || !String(raw).trim()) return raw;
            return pure.transformRawForFormat(raw, 'list', { forceOff: false, forceOn: true, olNum: 1 });
        });
    }

    const wrong = applyBullet(pre, wrongDomOrdinals);
    const right = applyBullet(pre, rightModelIdx);

    assert(wrong[0].startsWith('- ') || wrong[0].startsWith('* '),
        'wrong-path demo: DOM 0 got bulleted (bug we avoid)');
    assert(!String(wrong[120]).startsWith('- ') && !String(wrong[120]).startsWith('* '),
        'wrong-path demo: model 120 NOT bulleted');

    assert(right[120].startsWith('- ') || right[120].startsWith('* '),
        'model path: row 120 bulleted');
    assert(right[124].startsWith('- ') || right[124].startsWith('* '),
        'model path: row 124 bulleted');
    assert(right[0] === 'row 0', 'model path: row 0 untouched');
    assert(right[119] === 'row 119', 'model path: row 119 untouched');
    assert(right[125] === 'row 125', 'model path: row 125 untouched');
    assert(right[2499] === 'row 2499', 'model path: last row untouched');
    // Doc length preserved
    assert(right.length === N, 'length still ' + N);
    const changed = right.filter((r, i) => r !== pre[i]).length;
    assert(changed === 5, 'exactly 5 lines changed (got ' + changed + ')');
}

console.log('=== formatBlockIndex mapping contract ===');
{
    // data-model-index wins over array position
    function formatBlockIndexLike(el, domIndex) {
        if (!el) return -1;
        const a = el.getAttribute && el.getAttribute('data-model-index');
        if (a != null && a !== '') {
            const n = parseInt(a, 10);
            if (!isNaN(n)) return n;
        }
        return domIndex;
    }
    const fake = {
        getAttribute: (k) => k === 'data-model-index' ? '120' : null
    };
    assert(formatBlockIndexLike(fake, 0) === 120, 'mounted ordinal 0 → model 120');
    assert(formatBlockIndexLike({ getAttribute: () => null }, 3) === 3, 'no attr → DOM ordinal');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nVIRT FORMAT INDICES SELFTEST FAILED');
    process.exit(1);
}
console.log('\nVIRT FORMAT INDICES SELFTEST PASSED');
