/**
 * Self-test: every theme's accent works, both as a colour and as a selection fill.
 *
 * Two separate properties, fixed in two different places, and this holds both.
 *
 * 1. The accent must contrast with the background as a COLOUR. It is used as one:
 *    links, the active tab underline, the outline bar, focus rings. Kindle Oat sat at
 *    1.85 against its background, Night Reading 1.92, Nocturnal Library 2.21 -- below
 *    the 3.0 usually taken as the floor for UI text. That is a palette defect and was
 *    fixed in TypoZen_Themes.json, not worked around in code.
 *
 * 2. A selected control is that accent laid over the background at SelectionFillAlpha,
 *    and the result must still be distinguishable from the surface. The old 0x28 was
 *    too faint for every theme, not only the awkward ones: Obsidian Pure contrasts at
 *    19.5 as a colour and still produced a fill of just 1.400. Diluting anything to 16%
 *    gives a weak result, so that half is a rendering constant and belongs in code.
 *
 * Keeping both here is what stops either being "fixed" in the wrong layer later: a new
 * low-contrast theme fails on (1) rather than being papered over by raising (2).
 *
 * node tests/theme-contrast-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const themes = JSON.parse(fs.readFileSync(path.join(appDir, 'TypoZen_Themes.json'), 'utf8'));
const appCs = fs.readFileSync(path.join(appDir, 'TypoZen_App.cs'), 'utf8');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

/** Read the constant the app actually uses, so this test cannot drift from it. */
const alphaMatch = appCs.match(/const byte SelectionFillAlpha = (0x[0-9A-Fa-f]+);/);
if (!alphaMatch) {
    console.error('  FAIL SelectionFillAlpha not found in TypoZen_App.cs');
    process.exit(1);
}
const ALPHA = parseInt(alphaMatch[1], 16);

// Floors. FG_MIN is the usual bar for UI text; FILL_MIN is what makes a tinted fill
// distinguishable from the surface behind it.
const FG_MIN = 3.0;
const FILL_MIN = 1.25;

const hex = (h) => {
    h = String(h).replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const blend = (fg, bg, a) => fg.map((c, i) => Math.round(a * c + (1 - a) * bg[i]));

console.log('--- 1. the accent works as a colour (links, tab underline, focus rings) ---');
{
    const bad = themes
        .map(t => ({ n: t.Name, r: ratio(hex(t.Hi), hex(t.Bg)) }))
        .filter(x => x.r < FG_MIN)
        .map(x => x.n + ' (' + x.r.toFixed(2) + ')');
    assert(bad.length === 0,
        'every theme accent clears ' + FG_MIN + ' against its background' +
        (bad.length ? ' -- short: ' + bad.join(', ') : ' (' + themes.length + ' themes)'));

    // The three that were fixed at source, named so a revert is caught here rather than
    // silently re-hidden by raising the alpha.
    // Skipped rather than failed when a theme has been removed from the palette file:
    // this guards against the source fix being reverted, and a theme that no longer
    // exists cannot regress. Failing here told the user their build was broken when all
    // they had done was edit their own themes.
    for (const n of ['Kindle Oat', 'Night Reading', 'Nocturnal Library']) {
        const t = themes.find(x => x.Name === n);
        if (!t) { console.log('  --   ' + n + ' is no longer in the palette, nothing to regress'); continue; }
        const r = ratio(hex(t.Hi), hex(t.Bg));
        assert(r >= FG_MIN, n + ' accent is still readable (' + r.toFixed(2) + ')');
    }
}

console.log('');
console.log('--- 2. the selection fill is visible at the shipped alpha ---');
{
    const results = themes.map(t => ({
        n: t.Name,
        r: ratio(blend(hex(t.Hi), hex(t.Bg), ALPHA / 255), hex(t.Bg))
    }));
    const bad = results.filter(x => x.r < FILL_MIN).map(x => x.n + ' (' + x.r.toFixed(3) + ')');
    const worst = results.reduce((p, q) => (q.r < p.r ? q : p));
    assert(bad.length === 0,
        'all ' + themes.length + ' themes clear ' + FILL_MIN + ' at alpha 0x' +
        ALPHA.toString(16) + ' (worst: ' + worst.n + ' ' + worst.r.toFixed(3) + ')' +
        (bad.length ? ' -- short: ' + bad.join(', ') : ''));

    // Why one constant is enough, and why it has to be this big: the old 0x28 failed
    // widely, and failed even for themes whose accent is excellent.
    const at28 = themes.map(t => ratio(blend(hex(t.Hi), hex(t.Bg), 0x28 / 255), hex(t.Bg)));
    const shortAt28 = at28.filter(r => r < FILL_MIN).length;
    assert(shortAt28 > 0,
        'the previous 0x28 really was too faint (' + shortAt28 + ' themes under ' +
        FILL_MIN + '), so the higher constant is doing work');
    assert(ALPHA > 0x28, 'the app no longer ships the old 0x28 fill alpha');
}

console.log('');
console.log('passed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('');
    console.error('THEME CONTRAST SELFTEST FAILED');
    process.exit(1);
}
console.log('');
console.log('THEME CONTRAST SELFTEST PASSED');
process.exit(0);
