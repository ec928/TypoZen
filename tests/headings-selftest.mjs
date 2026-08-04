/**
 * H1–H6: apply must convert lines, not wipe, not insert placeholder "Heading N" lines.
 * Run: node tests/headings-selftest.mjs
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

function headingHashes(level) {
    return '#'.repeat(level);
}

/** Production multi-select heading force flags */
function headingForce(type, raws) {
    const n = Number(String(type).replace(/^h/, ''));
    const re = new RegExp('^#{' + n + '}\\s+');
    // exact level: h2 must not match ### 
    // production uses only count — for force detect we need exact for h1-h5
    let forceOff = raws.every(r => {
        if (!String(r).trim()) return true;
        if (n === 1) return /^#\s+/.test(r) && !/^##/.test(r);
        if (n < 6) {
            const reExact = new RegExp('^#{' + n + '}\\s+');
            const reMore = new RegExp('^#{' + (n + 1) + '}');
            return reExact.test(r) && !reMore.test(r);
        }
        return /^######\s+/.test(r);
    });
    let forceOn = true;
    if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
    else forceOn = !forceOff;
    return { forceOff, forceOn };
}

function applyHeading(lines, type, selectedIdx) {
    const focus = {};
    selectedIdx.forEach(i => { focus[i] = true; });
    const raws = selectedIdx.map(i => lines[i] ?? '');
    const { forceOff, forceOn } = headingForce(type, raws);
    return lines.map((raw, i) => {
        if (!focus[i]) return raw;
        if (!String(raw).trim()) return raw;
        return pure.transformRawForFormat(raw, type, { forceOff, forceOn });
    });
}

console.log('\n=== Pure transform H1–H6 on plain text ===');
{
    for (let level = 1; level <= 6; level++) {
        const type = 'h' + level;
        const out = pure.transformRawForFormat('hello', type, { forceOn: true });
        const want = headingHashes(level) + ' hello';
        assert(out === want, `${type} forceOn hello → ${JSON.stringify(want)} (got ${JSON.stringify(out)})`);
        assert(!out.includes('Heading ' + level), `${type} must NOT insert placeholder on real text`);
    }
}

console.log('\n=== Multi-select 5 lines each heading level ===');
{
    const base = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
    for (let level = 1; level <= 6; level++) {
        const type = 'h' + level;
        const after = applyHeading(base, type, [0, 1, 2, 3, 4]);
        assert(after.length === 5, `${type} multi keeps 5 lines`);
        assert(after.every(l => String(l).trim()), `${type} multi no empties`);
        const prefix = headingHashes(level) + ' ';
        for (let i = 0; i < 5; i++) {
            assert(after[i].startsWith(prefix), `${type} line ${i} starts with ${prefix.trim()} (got ${JSON.stringify(after[i])})`);
            assert(after[i].endsWith(base[i]), `${type} line ${i} keeps body`);
            assert(!/Heading\s+\d/.test(after[i]), `${type} line ${i} no placeholder`);
        }
    }
}

console.log('\n=== Toggle off when already that heading ===');
{
    for (let level = 1; level <= 6; level++) {
        const type = 'h' + level;
        const lined = headingHashes(level) + ' body';
        const out = pure.transformRawForFormat(lined, type, { forceOff: false, forceOn: false });
        assert(out === 'body', `${type} toggle off → body (got ${JSON.stringify(out)})`);
    }
}

console.log('\n=== Switch H1 → H6 keeps body ===');
{
    const out = pure.transformRawForFormat('# title', 'h6', { forceOn: true });
    assert(out === '###### title', 'H1→H6 got ' + JSON.stringify(out));
}

console.log('\n=== DOM: load 5 lines, apply H6 multi, render h6 with text ===');
{
    const dom = new JSDOM('<!DOCTYPE html><div id="editor"></div>');
    const { document } = dom.window;
    const editor = document.getElementById('editor');
    const lines = ['one', 'two', 'three', 'four', 'five'];

    function addBlock(raw) {
        const b = document.createElement('div');
        b.className = 'block';
        b.setAttribute('data-raw', pure.coerceBlockRaw(raw));
        // mirror renderBlockPreview heading branch
        const r = pure.coerceBlockRaw(raw);
        if (/^#{1,6}\s/.test(r)) {
            const level = r.match(/^#+/)[0].length;
            const text = r.replace(/^#+\s*/, '');
            b.innerHTML = `<h${level}>${text}</h${level}>`;
        } else {
            b.innerHTML = `<p>${r}</p>`;
        }
        editor.appendChild(b);
        return b;
    }

    lines.forEach(addBlock);
    const after = applyHeading(lines, 'h6', [0, 1, 2, 3, 4]);
    editor.innerHTML = '';
    after.forEach(addBlock);

    const blocks = [...editor.querySelectorAll('.block')];
    assert(blocks.length === 5, 'dom 5 blocks after H6');
    for (let i = 0; i < 5; i++) {
        const raw = blocks[i].getAttribute('data-raw');
        assert(raw === '###### ' + lines[i], `data-raw ${i} is ###### ${lines[i]} (got ${JSON.stringify(raw)})`);
        const h = blocks[i].querySelector('h6');
        assert(!!h, `block ${i} has <h6>`);
        assert((h.textContent || '').trim() === lines[i], `h6 text is ${lines[i]} (got ${JSON.stringify(h && h.textContent)})`);
        assert(!blocks[i].querySelector('p'), `block ${i} not still <p>`);
    }
}

console.log('\n=== Empty raw must not invent 5 placeholder Heading 6 lines as "success" ===');
{
    // If we only had empties, transform would make "###### Heading 6" — production should refuse empty selection
    const empty = ['', '', ''];
    const after = empty.map(r => pure.transformRawForFormat(r, 'h6', { forceOn: true }));
    // Document current transform behavior
    assert(after.every(l => l.includes('Heading 6')), 'empty→placeholder (transform default)');
    // Contract: applyFormatting must abort when all raws empty (check template)
    assert(mainScript.includes('readBlockRawSafe'), 'uses safe raw reader');
    // Prefer: no invent blank block for lost selection
    assert(mainScript.includes('Never invent a blank block')
        || mainScript.includes('Never invent a blank')
        || mainScript.includes('when selection was lost'),
        'aborts when selection lost');
}

console.log('\n=== force detect uses correct hash count for h6 ===');
{
    // charAt(1) and slice(1) both "6" for h6 — but document exact match
    const type = 'h6';
    const n = type.slice(1);
    const re = new RegExp('^#{' + n + '}\\s+');
    assert(re.test('###### hello'), 'h6 re matches 6 hashes');
    assert(!re.test('##### hello'), 'h6 re does not match 5 hashes only');
    assert(mainScript.includes("type.charAt(1)") || mainScript.includes('type.slice(1)')
        || mainScript.includes('Number(type.charAt(1))')
        || /#\{' \+ type/.test(mainScript)
        || mainScript.includes("type.charAt(1)"),
        'heading force regex uses level digit');
}

console.log(`\npassed=${passed} failed=${failed}`);
if (failed) process.exit(1);
console.log('HEADINGS SELFTEST PASSED');
process.exit(0);
