/**
 * Automated format stress test on ONE sentence.
 *
 * Applies many bold/italic/strike operations (scripted dogfood path + systematic
 * ranges + seeded random multi-char ranges) and asserts rendered mark state matches
 * the toggle model. This replaces screenshot dogfood for nested formatting.
 *
 * node tests/inline-format-fuzz-selftest.mjs
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
if (!mainScript || mainScript.length < 10000) {
    console.error('FAIL: could not extract main editor script');
    process.exit(1);
}

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localapp/TypoZen_Template_Test.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.Node = window.Node;

function extractFunction(name) {
    const startRe = new RegExp('function\\s+' + name + '\\s*\\(');
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        const c = mainScript[i];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return mainScript.slice(idx, i + 1);
    }
    throw new Error('unclosed function ' + name);
}

const names = [
    'escapeHtml', 'safeUrl', 'parseInline',
    'plainAndMarksFromMarkdown', 'emitInlineMarkdownFromMarks', 'applyInlineFormatToRaw',
    'plainRangeToRawOffsets'
];
let src = 'const _tzImageData = {}; function tzRequestPendingImages() {}\n';
for (const n of names) src += extractFunction(n) + '\n';
src += 'return {' + names.join(',') + '};';
const api = new Function('window', 'document', 'Node', src)(window, window.document, window.Node);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) passed++;
    else { failed++; console.error('  FAIL ' + msg); }
}

function marksKey(m) {
    return (m.bold ? 'B' : '-') + (m.italic ? 'I' : '-') + (m.strike ? 'S' : '-');
}
function marksSignature(marks) {
    return marks.map(marksKey).join('');
}
function cloneMarks(marks) {
    return marks.map(m => ({ bold: !!m.bold, italic: !!m.italic, strike: !!m.strike }));
}

function expectToggle(plain, marks, a, b, flag) {
    const next = cloneMarks(marks);
    const idxs = [];
    for (let i = a; i < b; i++) {
        if (i < plain.length && !/\s/.test(plain.charAt(i))) idxs.push(i);
    }
    if (!idxs.length) return next;
    let allOn = true;
    for (const i of idxs) {
        if (!next[i] || !next[i][flag]) { allOn = false; break; }
    }
    for (const i of idxs) {
        if (!next[i]) next[i] = { bold: false, italic: false, strike: false };
        next[i][flag] = !allOn;
    }
    for (let i = 0; i < plain.length; i++) {
        if (/\s/.test(plain.charAt(i))) next[i] = { bold: false, italic: false, strike: false };
    }
    return next;
}

function applyAndCheck(raw, a, b, type, label) {
    const pref = String(raw).match(/^(#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]?\]\s+)?|\d+\.\s+)/);
    const body = pref ? raw.slice(pref[0].length) : raw;
    const pm0 = api.plainAndMarksFromMarkdown(body);
    const aa = Math.max(0, Math.min(a, pm0.plain.length));
    const bb = Math.max(0, Math.min(b, pm0.plain.length));
    if (aa >= bb) return raw;

    const expected = expectToggle(pm0.plain, pm0.marks, aa, bb, type);
    const next = api.applyInlineFormatToRaw(raw, aa, bb, type);
    const bodyNext = pref ? next.slice(pref[0].length) : next;
    const pm1 = api.plainAndMarksFromMarkdown(bodyNext);

    assert(pm1.plain === pm0.plain,
        label + ' plain stable\n    before=' + JSON.stringify(pm0.plain) +
        '\n    after =' + JSON.stringify(pm1.plain) + '\n    raw=' + JSON.stringify(next));

    const expSig = marksSignature(expected);
    const gotSig = marksSignature(pm1.marks);
    assert(gotSig === expSig,
        label + ' marks match model\n    exp=' + expSig + '\n    got=' + gotSig +
        '\n    raw=' + JSON.stringify(next));

    const re = api.emitInlineMarkdownFromMarks(pm1.plain, pm1.marks);
    const pm2 = api.plainAndMarksFromMarkdown(re);
    assert(marksSignature(pm2.marks) === gotSig && pm2.plain === pm1.plain,
        label + ' emit round-trip\n    raw=' + JSON.stringify(re));

    return next;
}

// ---------------------------------------------------------------------------
console.log('=== dogfood path (user repro) ===');
{
    // vfff… aaaa ssss aaaa BBBB aaaa ffff
    const SENT = 'vffffffffffffaaaaassssssssssssaaaaBBBBBBBBBBBBBaaaafffffffffffffffffffffffffff';
    let raw = SENT;

    raw = applyAndCheck(raw, 0, SENT.length, 'bold', '1 bold whole line');

    // aaaaBBBB…aaa band before the f's
    const selStart = 13 + 4 + 12; // after v + aaaa + ssss
    const selEnd = selStart + 4 + 13 + 3; // aaaa + BBB + aaa
    raw = applyAndCheck(raw, selStart, selEnd, 'italic', '2 italic aaaaBBBaaa band');

    const bbbStart = 13 + 4 + 12 + 4;
    const bbbEnd = bbbStart + 13;
    raw = applyAndCheck(raw, bbbStart, bbbEnd, 'bold', '3 unbold BBB only');
    raw = applyAndCheck(raw, 13 + 4, 13 + 4 + 12, 'strike', '4 strike ssss');
    raw = applyAndCheck(raw, bbbStart, bbbEnd, 'bold', '5 re-bold BBB');
    raw = applyAndCheck(raw, selStart, selEnd, 'italic', '6 unitalic mid band');
    raw = applyAndCheck(raw, 0, SENT.length, 'bold', '7 toggle bold whole again');

    // Verify BBB not bold while neighbors stay bold+italic after step 3 pattern
    let raw2 = SENT;
    raw2 = applyAndCheck(raw2, 0, SENT.length, 'bold', 'A bold all');
    raw2 = applyAndCheck(raw2, selStart, selEnd, 'italic', 'B italic band');
    raw2 = applyAndCheck(raw2, bbbStart, bbbEnd, 'bold', 'C unbold BBB');
    const pm = api.plainAndMarksFromMarkdown(raw2);
    for (let i = bbbStart; i < bbbEnd; i++) {
        assert(pm.marks[i] && pm.marks[i].bold === false,
            'BBB[' + i + '] not bold after mid unbold');
        assert(pm.marks[i] && pm.marks[i].italic === true,
            'BBB[' + i + '] stays italic after mid unbold');
    }
    // neighbor a before BBB should still be bold+italic
    assert(pm.marks[bbbStart - 1].bold && pm.marks[bbbStart - 1].italic,
        'char before BBB stays bold+italic');

    console.log('  dogfood final:', raw2);
}

// ---------------------------------------------------------------------------
console.log('=== emit combo round-trips (multi-char runs) ===');
{
    const combos = [];
    for (let b = 0; b < 2; b++)
        for (let i = 0; i < 2; i++)
            for (let s = 0; s < 2; s++)
                combos.push({ bold: !!b, italic: !!i, strike: !!s });
    for (const c of combos) {
        const plain = 'word';
        const marks = plain.split('').map(() => ({ ...c }));
        const em = api.emitInlineMarkdownFromMarks(plain, marks);
        const pm = api.plainAndMarksFromMarkdown(em);
        assert(pm.plain === plain, 'combo plain ' + marksKey(c) + ' emit=' + em);
        assert(marksSignature(pm.marks) === marksSignature(marks),
            'combo marks ' + marksKey(c) + ' emit=' + em);
    }
    // adjacent multi-char runs
    const plain = 'aaaabbbbcccc';
    const marks = [
        ...Array(4).fill({ bold: true, italic: false, strike: false }),
        ...Array(4).fill({ bold: true, italic: true, strike: false }),
        ...Array(4).fill({ bold: false, italic: true, strike: true })
    ];
    const em = api.emitInlineMarkdownFromMarks(plain, marks);
    const pm = api.plainAndMarksFromMarkdown(em);
    assert(pm.plain === plain, 'adj plain ' + em);
    assert(marksSignature(pm.marks) === marksSignature(marks), 'adj marks emit=' + em);
}

// ---------------------------------------------------------------------------
console.log('=== systematic grid (clean base each pair of ops) ===');
{
    const S = 'aaaabbbbccccddddeeee';
    const types = ['bold', 'italic', 'strike'];
    const ranges = [
        [0, 20], [0, 4], [4, 8], [8, 12], [12, 16], [16, 20],
        [2, 10], [6, 14], [0, 10], [10, 20], [5, 15]
    ];
    for (const t1 of types) {
        for (const r1 of ranges) {
            let raw = applyAndCheck(S, r1[0], r1[1], t1, t1 + '@' + r1.join('..'));
            for (const t2 of types) {
                for (const r2 of ranges) {
                    applyAndCheck(raw, r2[0], r2[1], t2,
                        t1 + '@' + r1.join('..') + '→' + t2 + '@' + r2.join('..'));
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
console.log('=== seeded random multi-char ops on one sentence ===');
{
    const S = 'The quick brown fox jumps over the lazy dog.';
    function mulberry32(a) {
        return function () {
            let t = a += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    const types = ['bold', 'italic', 'strike'];
    for (let seed = 1; seed <= 30; seed++) {
        const rnd = mulberry32(seed * 9973);
        let raw = S;
        for (let step = 0; step < 15; step++) {
            const t = types[Math.floor(rnd() * types.length)];
            let a = Math.floor(rnd() * (S.length - 2));
            let len = 2 + Math.floor(rnd() * 10);
            let b = Math.min(S.length, a + len);
            // snap off if range is only whitespace
            let hasNonSpace = false;
            for (let i = a; i < b; i++) if (!/\s/.test(S[i])) hasNonSpace = true;
            if (!hasNonSpace) { a = 0; b = 5; }
            raw = applyAndCheck(raw, a, b, t, 'seed' + seed + '#' + step + ' ' + t + ' ' + a + '..' + b);
        }
    }
}

// ---------------------------------------------------------------------------
console.log('=== list / heading prefixes ===');
{
    let raw = applyAndCheck('- hello world item', 0, 5, 'bold', 'list bold hello');
    assert(raw.startsWith('- '), 'list prefix after bold: ' + raw);
    raw = applyAndCheck(raw, 6, 11, 'italic', 'list italic world');
    assert(raw.startsWith('- '), 'list prefix after italic: ' + raw);
    raw = applyAndCheck('## Title here now', 0, 5, 'bold', 'heading bold');
    assert(raw.startsWith('## '), 'heading prefix: ' + raw);
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nINLINE FORMAT FUZZ SELFTEST FAILED');
    process.exit(1);
}
console.log('\nINLINE FORMAT FUZZ SELFTEST PASSED');
