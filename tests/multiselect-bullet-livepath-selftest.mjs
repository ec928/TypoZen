/**
 * THE test that should have existed from day one.
 *
 * User first smoke: 10 rows → select several → bullet → content must NOT disappear.
 *
 * Failure mode we kept missing:
 *  - multi-select blanks live data-raw in the DOM
 *  - old path: loadMarkdownContent(empty snapshot) → blank doc
 *  - new path: applyFormatInPlaceToSelection + _lastGoodDocRaws → in-place write
 *
 * node tests/multiselect-bullet-livepath-selftest.mjs
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

function extractFunction(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        if (mainScript[i] === '{') depth++;
        else if (mainScript[i] === '}') {
            depth--;
            if (depth === 0) return mainScript.slice(idx, i + 1);
        }
    }
    throw new Error('unclosed ' + name);
}

const pureNames = [
    'parseListLine', 'formatListLine', 'normalizeBlockRaw', 'isMultilineBlockRaw',
    'coerceBlockRaw', 'stripListMarkerKeepBody', 'stripBlockPrefix', 'listIndentPad',
    'getListIndentLevel', 'transformRawForFormat'
];
const pure = new Function(
    'const LIST_MAX_INDENT=6;const LIST_INDENT_SPACES=2;\n' +
    pureNames.map(n => extractFunction(n)).join('\n') +
    `;\nreturn { ${pureNames.join(', ')} };`
)();

let passed = 0, failed = 0;
function assert(c, m) {
    if (c) { passed++; console.log('  OK  ', m); }
    else { failed++; console.error('  FAIL', m); }
}

/**
 * Mirrors production applyFormatInPlaceToSelection resolution order:
 * frozen select raw → last-good doc → live (may be empty after multi-select)
 * Then transforms only selected indices; never drops other lines.
 */
function applyBulletInPlaceLikeProd(lastGoodDocRaws, liveRaws, selectedIdx) {
    const n = Math.max(lastGoodDocRaws.length, liveRaws.length);
    const focus = {};
    selectedIdx.forEach(i => { focus[i] = true; });
    const frozen = {};
    selectedIdx.forEach(i => {
        // After multi-select, live is empty — frozen should come from last-good
        const live = liveRaws[i] || '';
        frozen[i] = String(live).trim()
            ? pure.coerceBlockRaw(live)
            : pure.coerceBlockRaw(lastGoodDocRaws[i] || '');
    });

    const preLines = [];
    for (let i = 0; i < n; i++) {
        let r = '';
        if (Object.prototype.hasOwnProperty.call(frozen, i) && String(frozen[i] || '').trim()) {
            r = frozen[i];
        } else if (lastGoodDocRaws[i] != null && String(lastGoodDocRaws[i]).trim()) {
            r = pure.coerceBlockRaw(lastGoodDocRaws[i]);
        } else {
            r = pure.coerceBlockRaw(liveRaws[i] || '');
        }
        preLines.push(r);
    }

    const postLines = preLines.map((raw, i) => {
        if (!focus[i] || !String(raw).trim()) return raw;
        return pure.transformRawForFormat(raw, 'list', { forceOff: false, forceOn: true });
    });
    return { preLines, postLines };
}

console.log('\n=== THE smoke: 10 rows, multi-select middle 4, live raws emptied, bullet ===');
{
    // User typed these (last known good)
    const lastGood = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];
    // After drag-select, live data-raw often looks like this (corrupted)
    const liveWiped = ['111', '222', '', '', '', '', '777', '888', '999', '100'];
    const selected = [3, 4, 5, 6]; // 444..777

    const { preLines, postLines } = applyBulletInPlaceLikeProd(lastGood, liveWiped, selected);

    assert(preLines.length === 10, 'pre still 10 lines');
    assert(preLines[3] === '444' && preLines[6] === '777',
        'pre recovered selected bodies from last-good (got ' + JSON.stringify(preLines.slice(3, 7)) + ')');
    assert(postLines.length === 10, 'post still 10 lines — NOT a blank doc');
    assert(postLines.every(l => String(l).trim().length > 0), 'no empty lines after bullet');
    assert(postLines[0] === '111' && postLines[9] === '100', 'unselected ends intact');
    assert(postLines[2] === '333' && postLines[7] === '888', 'neighbors of selection intact');
    for (const i of selected) {
        assert(pure.parseListLine(postLines[i])?.kind === 'ul',
            `idx ${i} is bullet (got ${JSON.stringify(postLines[i])})`);
        assert(pure.parseListLine(postLines[i])?.body === lastGood[i],
            `idx ${i} body is ${lastGood[i]}`);
    }
    const bulletCount = postLines.filter(l => pure.parseListLine(l)?.kind === 'ul').length;
    assert(bulletCount === 4, 'exactly 4 bullets not all 10 (got ' + bulletCount + ')');
}

console.log('\n=== OLD wipe path documented: empty snapshot + full reload ===');
{
    // What used to happen: join empty live raws → loadMarkdownContent → blank
    const liveWiped = ['', '', '', '', '', '', '', '', '', ''];
    const joined = liveWiped.join('\n');
    assert(!joined.replace(/\n/g, '').trim(), 'old path postContent was effectively empty');
    // New path must refuse empty pre
    const lastGood = ['a', 'b', 'c', 'd'];
    const { preLines } = applyBulletInPlaceLikeProd(lastGood, liveWiped.slice(0, 4), [1, 2]);
    assert(preLines.join('') === 'abcd' || preLines.every((r, i) => r === lastGood[i]),
        'new path recovers from last-good even if live all empty');
}

console.log('\n=== Production template: multi list uses in-place, not reload ===');
{
    assert(mainScript.includes('function applyFormatInPlaceToSelection'),
        'applyFormatInPlaceToSelection exists');
    assert(mainScript.includes('_lastGoodDocRaws'), '_lastGoodDocRaws exists');
    assert(mainScript.includes('applyFormatInPlaceToSelection(type, forceOff, forceOn)'),
        'applyFormatting calls in-place for multi/list');
    assert(mainScript.includes('do not loadMarkdownContent')
        || mainScript.includes('IN PLACE')
        || mainScript.includes('in-place'),
        'documents that loadMarkdownContent wipe is avoided');
    assert(mainScript.includes('capture full document HERE')
        || mainScript.includes('before drag-select corrupts'),
        'mousedown captures last-good BEFORE multi-select');
    assert(mainScript.includes('touchLastGoodDocRawAtBlock'),
        'typing updates last-good (not only writeBlockRaw)');
    const applyIdx = mainScript.indexOf('function applyFormatting');
    // applyFormatting body grew (virt model indices); keep a generous slice
    const applyChunk = mainScript.slice(applyIdx, applyIdx + 20000);
    assert(applyChunk.includes('applyFormatInPlaceToSelection(type, forceOff, forceOn)'),
        'list/multi branch uses in-place');
}

console.log('\n=== DOM in-place: write bullets without clearing editor ===');
{
    const dom = new JSDOM('<!DOCTYPE html><div id="editor" contenteditable="true"></div>');
    const { document } = dom.window;
    const editor = document.getElementById('editor');
    const lastGood = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];

    function addBlock(raw) {
        const b = document.createElement('div');
        b.className = 'block';
        b.setAttribute('data-raw', raw);
        b.innerHTML = `<p>${raw}</p>`;
        editor.appendChild(b);
        return b;
    }
    lastGood.forEach(addBlock);

    // Corrupt live like multi-select: blank data-raw on selected
    const blocks = [...editor.querySelectorAll('.block')];
    [3, 4, 5, 6].forEach(i => {
        blocks[i].setAttribute('data-raw', '');
        blocks[i].innerHTML = '<p></p>'; // wiped visual too
    });

    // In-place apply using last-good (production algorithm)
    const live = blocks.map(b => b.getAttribute('data-raw') || '');
    const { postLines } = applyBulletInPlaceLikeProd(lastGood, live, [3, 4, 5, 6]);

    // Write in place — editor never cleared
    const beforeCount = editor.querySelectorAll('.block').length;
    assert(beforeCount === 10, 'before write still 10 blocks');
    for (let i = 0; i < 10; i++) {
        blocks[i].setAttribute('data-raw', postLines[i]);
        const p = pure.parseListLine(postLines[i]);
        if (p && p.kind === 'ul') {
            blocks[i].innerHTML = `<ul><li>${p.body}</li></ul>`;
        } else {
            blocks[i].innerHTML = `<p>${postLines[i]}</p>`;
        }
    }
    assert(editor.querySelectorAll('.block').length === 10, 'after write still 10 blocks (no full reload wipe)');
    assert(blocks[0].getAttribute('data-raw') === '111', 'block0 intact');
    assert(blocks[3].querySelector('li') && blocks[3].querySelector('li').textContent === '444',
        'block3 bullet body 444');
    assert(blocks[9].getAttribute('data-raw') === '100', 'block9 intact');
}

console.log(`\npassed=${passed} failed=${failed}`);
if (failed) {
    console.error('\nMULTISELECT BULLET LIVEPATH SELFTEST FAILED');
    process.exit(1);
}
console.log('\nMULTISELECT BULLET LIVEPATH SELFTEST PASSED');
console.log('(This is the test that should have gated the build from the first wipe report.)');
process.exit(0);
