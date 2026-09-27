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
import { readEngineSource } from './engine-source.mjs';

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
console.log('--- 3. search highlighting is theme-derived and visible in every theme ---');
{
    const css = fs.readFileSync(path.join(appDir, 'css', 'typozen.css'), 'utf8');
    const js = readEngineSource();

    // It was #f59e0b over rgba(255,180,0,.45): deliberate-looking on a warm light theme,
    // arbitrary on the other twenty-five. Same lesson as the accents themselves -- the
    // colour belongs to the palette, not to a literal in a stylesheet.
    const findRule = (css.match(/::highlight\(typozen-find\)\s*\{([^}]*)\}/) || [])[1] || '';
    const curRule = (css.match(/::highlight\(typozen-find-current\)\s*\{([^}]*)\}/) || [])[1] || '';
    assert(/var\(--find-soft/.test(findRule), 'every-match highlight uses the theme accent');
    assert(/var\(--accent/.test(curRule) && /var\(--accent-tx/.test(curRule),
        'current-match highlight uses the accent and its contrast-checked text colour');
    assert(/--find-soft/.test(js), 'the theme code actually sets --find-soft');

    // Every match is underlined in the accent -- that is what makes a page of hits
    // visible, and what keeps them apart from a selection, which is an accent fill.
    assert(/text-decoration:\s*underline[^;]*var\(--accent/.test(findRule),
        'every match is underlined in the accent');
    // The fill under it is deliberately faint (selection is the stronger fill), but it
    // must still register. Alphas mirror the ones applied in applyTheme.
    const SOFT_MIN = 1.12;
    const results = themes.map(t => {
        const bgc = hex(t.Bg);
        const isLight = lum(bgc) > 0.5;
        const a = isLight ? 0.14 : 0.18;
        return { n: t.Name, r: ratio(blend(hex(t.Hi), bgc, a), bgc) };
    });
    const faint = results.filter(x => x.r < SOFT_MIN).map(x => x.n + ' (' + x.r.toFixed(3) + ')');
    const worst = results.reduce((p, q) => (q.r < p.r ? q : p));
    assert(faint.length === 0,
        'the every-match tint is visible against every background (worst: ' +
        worst.n + ' ' + worst.r.toFixed(3) + ')' +
        (faint.length ? ' -- too faint: ' + faint.join(', ') : ''));

    // And the current match must be readable, since it paints text on solid accent.
    const bad = themes.map(t => {
        const a = hex(t.Hi);
        // Mirrors applyTheme: whichever of black/white measures higher against the accent.
        const best = Math.max(ratio([0, 0, 0], a), ratio([255, 255, 255], a));
        return { n: t.Name, r: best };
    }).filter(x => x.r < 4.5).map(x => x.n + ' (' + x.r.toFixed(2) + ')');
    assert(bad.length === 0,
        'text on the solid current-match highlight clears 4.5' +
        (bad.length ? ' -- short: ' + bad.join(', ') : ' (' + themes.length + ' themes)'));

    // The highlighter (Hi2) is a colour of its own because it must not read as the
    // accent: on Gruvbox and Ayu, whose accents are orange, a fixed amber made selection,
    // search and highlights one colour. Its wash (26% in typozen.css) must also show.
    const hueOf = (c) => {
        const [r, g, b] = c.map(v => v / 255);
        const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
        if (d === 0) return null;
        const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return h * 60;
    };
    const hi2Bad = themes.map(t => {
        if (!/^#[0-9a-f]{6}$/i.test(t.Hi2 || '')) return t.Name + ' (no Hi2)';
        const h1 = hueOf(hex(t.Hi)), h2 = hueOf(hex(t.Hi2));
        const apart = (h1 === null || h2 === null) ? 180 : Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2));
        if (apart < 40) return t.Name + ' (Hi2 only ' + apart.toFixed(0) + ' deg from Hi)';
        const r = ratio(blend(hex(t.Hi2), hex(t.Bg), 0.26), hex(t.Bg));
        if (r < 1.12) return t.Name + ' (Hi2 wash ' + r.toFixed(3) + ')';
        return null;
    }).filter(Boolean);
    assert(hi2Bad.length === 0,
        'every theme has a highlighter apart from its accent and visible as a wash' +
        (hi2Bad.length ? ' -- ' + hi2Bad.join(', ') : ''));
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
