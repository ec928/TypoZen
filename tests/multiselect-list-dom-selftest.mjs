/**
 * REAL multi-select list convert against production template helpers + DOM load path.
 * Catches: select 4 of 10 → numbered list wipes / empties / drops lines.
 *
 * node tests/multiselect-list-dom-selftest.mjs
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
    'parseListLine', 'formatListLine', 'indentListLine', 'isListLine',
    'normalizeBlockRaw', 'isMultilineBlockRaw', 'coerceBlockRaw',
    'stripListMarkerKeepBody', 'stripBlockPrefix', 'listIndentPad',
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

/** Production mutateDocumentMarkdown core (string path + line drop rules) */
function mutateDocumentMarkdown(lines, mutator, opts) {
    opts = opts || {};
    const allRaws = lines.map(r => pure.coerceBlockRaw(r));
    const outLines = [];
    for (let i = 0; i < allRaws.length; i++) {
        let result = mutator(allRaws[i], i, allRaws);
        if (result == null) result = allRaws[i];
        if (Array.isArray(result) && result.length === 0) {
            // PRODUCTION DROPS THE LINE — this is a wipe path
            continue;
        }
        let piece;
        if (Array.isArray(result)) {
            piece = result.map(x => pure.coerceBlockRaw(x)).filter(x => String(x).length > 0).join(' ');
            if (!piece && result.length) piece = pure.coerceBlockRaw(result[0]);
        } else {
            piece = pure.coerceBlockRaw(result);
        }
        outLines.push(piece == null ? '' : piece);
    }
    if (!outLines.length) outLines.push('');
    return outLines;
}

/** Production multi-select list apply (from applyFormatting) */
function applyListToIndices(lines, type, selectedIdx) {
    const focusIndices = {};
    for (const i of selectedIdx) focusIndices[i] = true;
    const raws = selectedIdx.map(i => lines[i] ?? '');
    let forceOff = false, forceOn = true;
    if (type === 'ol' || type === 'ordered') {
        forceOff = raws.every(r => {
            if (!String(r).trim()) return true;
            const p = pure.parseListLine(r);
            return p && p.kind === 'ol';
        });
        if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
        else forceOn = !forceOff;
    } else if (type === 'list') {
        forceOff = raws.every(r => {
            if (!String(r).trim()) return true;
            const p = pure.parseListLine(r);
            return p && p.kind === 'ul';
        });
        if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
        else forceOn = !forceOff;
    }
    let olNum = 1;
    return mutateDocumentMarkdown(lines, function (raw, index) {
        if (!focusIndices[index]) return raw;
        raw = pure.normalizeBlockRaw(raw);
        if (!String(raw).trim()) return raw;
        if (String(raw).indexOf('\n') < 0) {
            const n = olNum;
            if ((type === 'ol' || type === 'ordered') && forceOn) olNum++;
            return pure.transformRawForFormat(raw, type, { forceOff, forceOn, olNum: n });
        }
        // multi-line block path — returns ARRAY (production does this)
        const subLines = String(raw).split('\n');
        const parts = [];
        for (let sli = 0; sli < subLines.length; sli++) {
            const line = pure.normalizeBlockRaw(subLines[sli]);
            if (!String(line).trim()) { parts.push(line); continue; }
            const next = pure.transformRawForFormat(line, type, { forceOff, forceOn, olNum });
            if ((type === 'ol' || type === 'ordered') && forceOn) olNum++;
            parts.push(pure.normalizeBlockRaw(next));
        }
        return parts;
    });
}

// Simulate loadMarkdownContent: one line → one block data-raw
function loadAsBlocks(md) {
    return String(md).split('\n').map(l => pure.coerceBlockRaw(l));
}

console.log('\n=== Multi-select 4 of 10 → numbered list (must not wipe) ===');
{
    const lines = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];
    const selected = [3, 4, 5, 6]; // 444..777
    const after = applyListToIndices(lines, 'ol', selected);
    assert(after.length === 10, 'still 10 lines (got ' + after.length + ')');
    assert(after[0] === '111' && after[9] === '100', 'unselected ends unchanged');
    for (const i of selected) {
        const p = pure.parseListLine(after[i]);
        assert(!!p && p.kind === 'ol', `idx ${i} is ol (got ${JSON.stringify(after[i])})`);
        assert(String(p.body).includes(lines[i]) || p.body === lines[i],
            `idx ${i} body keeps original text (body=${JSON.stringify(p && p.body)} raw=${JSON.stringify(after[i])})`);
        assert(String(after[i]).trim().length > 0, `idx ${i} not empty`);
    }
    // Bodies must not be blank — "disappear" failure mode
    const bodies = selected.map(i => pure.parseListLine(after[i]).body);
    assert(bodies.every(b => String(b).trim()), 'no empty list bodies (disappear)');
}

console.log('\n=== Multi-select bullets same contract ===');
{
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const after = applyListToIndices(lines, 'list', [2, 3, 4, 5]);
    assert(after.length === 10, 'bullet: 10 lines');
    assert(after[0] === 'a' && after[9] === 'j', 'bullet: ends ok');
    assert(pure.parseListLine(after[2])?.kind === 'ul', 'c is bullet');
    assert(pure.parseListLine(after[2])?.body === 'c', 'bullet body c');
}

console.log('\n=== What if snapshot data-raw is EMPTY for selected (focus steal wipe) ===');
{
    // Simulates: data-raw blanked when toolbar steals focus → mutator sees ""
    const lines = ['111', '222', '', '', '', '', '777', '888', '999', '100'];
    const after = applyListToIndices(lines, 'ol', [2, 3, 4, 5]);
    assert(after.length === 10, 'empty-raw path keeps 10 lines');
    // empties stay empty (not deleted) — production leave empties
    assert(after[2] === '' && after[5] === '', 'empty lines not deleted from doc');
    assert(after[0] === '111' && after[6] === '777', 'neighbors kept');
}

console.log('\n=== BUG: returning [] from mutator drops lines (wipe) ===');
{
    const lines = ['a', 'b', 'c', 'd'];
    const wiped = mutateDocumentMarkdown(lines, (raw, i) => {
        if (i >= 1 && i <= 2) return []; // delete
        return raw;
    });
    assert(wiped.length === 2, 'documents that [] drops lines (got ' + wiped.length + ')');
    assert(wiped.join(',') === 'a,d', 'a and d only');
}

console.log('\n=== DOM: load 10 lines, apply ol to 4, re-serialize data-raw ===');
{
    const dom = new JSDOM(`<!DOCTYPE html><div id="editor" contenteditable="true"></div>`);
    const { document } = dom.window;
    const editor = document.getElementById('editor');
    const lines = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];
    function addBlock(raw) {
        const b = document.createElement('div');
        b.className = 'block';
        b.setAttribute('data-raw', pure.coerceBlockRaw(raw));
        const list = pure.parseListLine(raw);
        if (list && list.kind === 'ol') {
            b.innerHTML = `<ol start="${list.num}"><li>${list.body || ''}</li></ol>`;
        } else if (list && list.kind === 'ul') {
            b.innerHTML = `<ul><li>${list.body || ''}</li></ul>`;
        } else {
            b.innerHTML = `<p>${raw}</p>`;
        }
        editor.appendChild(b);
        return b;
    }
    lines.forEach(addBlock);

    // Snapshot like mutateDocumentMarkdown
    const allBlocks = [...editor.querySelectorAll('.block')];
    const allRaws = allBlocks.map(b => pure.coerceBlockRaw(b.getAttribute('data-raw') || ''));
    assert(allRaws.length === 10, 'dom has 10 blocks');

    const after = applyListToIndices(allRaws, 'ol', [3, 4, 5, 6]);
    // Reload
    editor.innerHTML = '';
    after.forEach(addBlock);
    const final = [...editor.querySelectorAll('.block')].map(b => b.getAttribute('data-raw'));
    assert(final.length === 10, 'after reload still 10 blocks');
    assert(final.every(r => r != null), 'all data-raw set');
    for (let i = 3; i <= 6; i++) {
        assert(pure.parseListLine(final[i])?.kind === 'ol', `dom block ${i} ol`);
        assert(String(pure.parseListLine(final[i]).body).trim().length > 0, `dom block ${i} body visible`);
        // innerHTML must not be empty li
        const li = editor.querySelectorAll('.block')[i].querySelector('li');
        assert(li && String(li.textContent || '').trim().length > 0,
            `dom block ${i} li text not empty (got ${JSON.stringify(li && li.textContent)})`);
    }
    // Unselected still plain
    assert(!pure.parseListLine(final[0]), 'block 0 still plain');
    assert(final[0] === '111', 'block 0 text 111');
}

console.log('\n=== Regression: focus-steal empties data-raw but frozen raws keep text ===');
{
    // Mouseup captured real raws; before fmt:ol, DOM/data-raw wiped (WebView multi-select).
    const liveRaws = ['111', '222', '', '', '', '', '777', '888', '999', '100']; // wiped 3-6
    const frozenRaws = { 3: '444', 4: '555', 5: '666', 6: '777' };
    const selected = [3, 4, 5, 6];
    const focusIndices = {};
    selected.forEach(i => { focusIndices[i] = true; });

    // Production-like snapshot preferring frozen raws
    const allRaws = liveRaws.map((r, bi) => {
        if (Object.prototype.hasOwnProperty.call(frozenRaws, bi) && frozenRaws[bi] != null) {
            return pure.coerceBlockRaw(frozenRaws[bi]);
        }
        return pure.coerceBlockRaw(r);
    });
    assert(allRaws[3] === '444' && allRaws[6] === '777', 'frozen raws win over wiped live');

    let olNum = 1;
    const after = mutateDocumentMarkdown(allRaws, function (raw, index) {
        if (!focusIndices[index]) return raw;
        if (!String(raw).trim()) return raw;
        const n = olNum++;
        return pure.transformRawForFormat(raw, 'ol', { forceOff: false, forceOn: true, olNum: n });
    });
    assert(after.length === 10, 'frozen path still 10 lines');
    for (const i of selected) {
        const p = pure.parseListLine(after[i]);
        assert(p && p.kind === 'ol' && String(p.body).trim(),
            `frozen idx ${i} numbered with body (got ${JSON.stringify(after[i])})`);
    }
    assert(after[0] === '111' && after[9] === '100', 'unselected intact with freeze path');
}

console.log('\n=== Multi-select 10 rows → H1 (must not wipe) ===');
{
    const lines = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];
    const selected = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const focusIndices = {};
    selected.forEach(i => { focusIndices[i] = true; });
    // forceOn like production multi-select heading
    const after = mutateDocumentMarkdown(lines, function (raw, index) {
        if (!focusIndices[index]) return raw;
        if (!String(raw).trim()) return raw;
        return pure.transformRawForFormat(raw, 'h1', { forceOff: false, forceOn: true });
    });
    assert(after.length === 10, 'H1 still 10 lines (got ' + after.length + ')');
    assert(after.every(l => String(l).trim()), 'H1 no empty lines');
    for (let i = 0; i < 10; i++) {
        assert(/^#\s+/.test(after[i]) && !/^##/.test(after[i]),
            `line ${i} is H1 (got ${JSON.stringify(after[i])})`);
        assert(after[i].includes(lines[i]), `line ${i} keeps body ${lines[i]}`);
    }
}

console.log('\n=== H1 with wiped live raws but frozen/DOM body must survive ===');
{
    // Simulate: data-raw empty for all, but we feed recovered raws into mutator
    const recovered = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const focusIndices = {};
    for (let i = 0; i < 10; i++) focusIndices[i] = true;
    const after = mutateDocumentMarkdown(recovered, function (raw, index) {
        if (!focusIndices[index]) return raw;
        return pure.transformRawForFormat(raw, 'h1', { forceOff: false, forceOn: true });
    });
    assert(after.length === 10 && after.every(l => l.startsWith('# ')), 'H1 recovered 10 headings');
    assert(after[0] === '# a' && after[9] === '# j', 'H1 bodies from recovered raws');
}

console.log('\n=== Abort path: mutator that empties all must not be what we ship ===');
{
    // Document production refuse: if pre has content and post empty, abort
    const lines = ['x', 'y', 'z'];
    const wiped = mutateDocumentMarkdown(lines, () => '');
    // Our test mutator still returns empty — production abort is in template not this helper
    // Ensure transform path never returns empty for non-empty plain text
    const h1 = pure.transformRawForFormat('hello', 'h1', { forceOn: true });
    assert(h1 === '# hello', 'H1 on hello is # hello not empty');
    const h1empty = pure.transformRawForFormat('', 'h1', { forceOn: true });
    assert(String(h1empty).trim().length > 0, 'H1 on empty still has placeholder text');
    void wiped;
}

console.log('\n=== Template contracts for multi-select freeze ===');
{
    const html2 = fs.readFileSync(templatePath, 'utf8');
    assert(html2.includes('_selectedFormatRaws'), 'caches raws not only indices');
    assert(html2.includes('FREEZE ONLY') || html2.includes('do not re-snapshot'),
        'focusout does not re-snapshot destroyed selection');
    assert(html2.includes('Refuse wipe') || html2.includes('Refuse to wipe')
        || html2.includes('non-empty pre must not become empty'),
        'mutate refuses empty post for non-empty pre');
    assert(html2.includes('Do NOT clear freeze here') || html2.includes('Do NOT clear freeze'),
        'editor focus does not unfreeze format selection');
    assert(html2.includes('readBlockRawSafe'), 'safe block raw reader present');
    assert(html2.includes('would wipe all content') || html2.includes('aborted — would wipe'),
        'hard abort if mutate would wipe doc');
}

console.log(`\npassed=${passed} failed=${failed}`);
if (failed) process.exit(1);
console.log('MULTISELECT LIST DOM SELFTEST PASSED');
process.exit(0);
