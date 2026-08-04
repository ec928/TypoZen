/**
 * Self-test: every theme produces a selection you can actually see.
 *
 * The toolbar paints a selected control by laying the theme's Hi colour over the theme's
 * Bg at some opacity. That opacity used to be a flat 0x28, which silently assumed every
 * theme's accent contrasts with its background. Measured across the set it did not:
 *
 *     Night Reading  1.076      Kindle Oat  1.095      best of any theme  1.576
 *
 * (1.0 means the fill is indistinguishable from the surface.) On Kindle Oat the selected
 * button was effectively invisible.
 *
 * This checks the theme data, not the C# -- it asks whether each theme *can* produce a
 * visible selection within the opacity range the app is willing to use, so adding a new
 * low-contrast theme fails here rather than shipping an invisible selection. The
 * constants are read back out of TypoZen_App.cs so the two cannot drift apart.
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

/** Read the constants the app actually uses, so this test cannot drift from it. */
function constFromApp(re, label, fallback) {
    const m = appCs.match(re);
    if (!m) { failed++; console.error('  FAIL could not read ' + label + ' from TypoZen_App.cs'); return fallback; }
    return m[1].startsWith('0x') ? parseInt(m[1], 16) : parseFloat(m[1]);
}
const TARGET = constFromApp(/const double target = ([\d.]+);/, 'target ratio', 1.25);
const MAX_ALPHA = constFromApp(/const byte min = 0x28, max = (0x[0-9A-Fa-f]+);/, 'max alpha', 0x70);
const MIN_ALPHA = 0x28;

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

/** Mirrors SelectionAlphaFor: raise opacity until the fill is visible, then stop. */
function alphaFor(hi, bg) {
    for (let a = MIN_ALPHA; a < MAX_ALPHA; a += 2) {
        if (ratio(blend(hi, bg, a / 255), bg) >= TARGET) return a;
    }
    return MAX_ALPHA;
}

console.log('--- constants come from the app ---');
assert(TARGET > 1 && TARGET < 2, 'target contrast ratio read from TypoZen_App.cs (' + TARGET + ')');
assert(MAX_ALPHA > MIN_ALPHA && MAX_ALPHA <= 0xC0,
    'alpha cap read from TypoZen_App.cs (0x' + MAX_ALPHA.toString(16) + ') keeps a selection a tint, not a slab');

console.log('\n--- every theme reaches a visible selection ---');
const bad = [];
const unchanged = [];
for (const t of themes) {
    const bg = hex(t.Bg), hi = hex(t.Hi);
    const a = alphaFor(hi, bg);
    const got = ratio(blend(hi, bg, a / 255), bg);
    if (got < TARGET - 0.02) bad.push(t.Name + ' (' + got.toFixed(3) + ' at cap)');
    if (a === MIN_ALPHA) unchanged.push(t.Name);
}
assert(bad.length === 0,
    'all ' + themes.length + ' themes reach the target within the alpha cap' +
    (bad.length ? ' -- short: ' + bad.join(', ') : ''));
assert(unchanged.length > 0,
    'themes that already contrasted keep the original light tint (' + unchanged.length + ' of ' + themes.length + ')');

console.log('\n--- the fixed-alpha regression cannot come back ---');
// The specific failure: a flat 0x28 for every theme.
const flatWorst = themes
    .map(t => ratio(blend(hex(t.Hi), hex(t.Bg), MIN_ALPHA / 255), hex(t.Bg)))
    .reduce((a, b) => Math.min(a, b), Infinity);
assert(flatWorst < TARGET,
    'a flat ' + MIN_ALPHA + ' alpha really would be invisible somewhere (worst ' +
    flatWorst.toFixed(3) + '), so the adaptive path is doing work');
assert(!/c\.A = 0x28;/.test(appCs), 'the app no longer hardcodes the selection alpha');

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nTHEME CONTRAST SELFTEST FAILED');
    process.exit(1);
}
console.log('\nTHEME CONTRAST SELFTEST PASSED');
process.exit(0);
