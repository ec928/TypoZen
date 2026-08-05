/**
 * Every font the app declares or a theme asks for must actually resolve.
 *
 * Two themes named 'Bookerly' in their font stack and quietly rendered Georgia for months.
 * Nothing was broken in an obvious way -- the stack has a fallback, which is exactly why
 * nobody noticed. The font was installed "for me only", which registers under HKCU, and
 * the WebView2 renderer sandbox does not enumerate per-user fonts, so local('Bookerly')
 * found nothing and there was no bundled file behind it.
 *
 * A font stack silently degrading is not detectable at runtime without measuring glyphs,
 * so it is pinned here instead:
 *   - every url() in the bundled-fonts block points at a file that exists
 *   - every family a theme asks for first is one the app bundles
 *   - variable fonts declare their weight axis, or the browser pins them at 400 and
 *     synthesises faux-bold instead of using the real Bold design
 *
 *   node tests/fonts-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(appDir, 'TypoZen_Template.html'), 'utf8');
const themes = JSON.parse(fs.readFileSync(path.join(appDir, 'TypoZen_Themes.json'), 'utf8'));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const block = (html.match(/<style id="bundled-fonts">([\s\S]*?)<\/style>/) || [])[1] || '';
assert(block.length > 0, 'the bundled-fonts style block is present');

const faces = [];
const re = /@font-face\s*\{([\s\S]*?)\}/g;
let m;
while ((m = re.exec(block))) {
    const body = m[1];
    const fam = (body.match(/font-family:\s*'([^']+)'/) || [])[1];
    const url = (body.match(/url\('([^']+)'\)/) || [])[1];
    const weight = (body.match(/font-weight:\s*([^;]+);/) || [])[1];
    const style = (body.match(/font-style:\s*([^;]+);/) || [])[1];
    if (fam && url) faces.push({ fam, url, weight: (weight || '').trim(), style: (style || '').trim() });
}

console.log('\n--- 1. every declared font file exists ---');
{
    const missing = faces
        .filter(f => !fs.existsSync(path.join(appDir, decodeURIComponent(f.url))))
        .map(f => f.url);
    assert(missing.length === 0,
        'all ' + faces.length + ' declared font files are present' +
        (missing.length ? ' -- missing: ' + missing.join(', ') : ''));
}

console.log('\n--- 2. every family a theme asks for first is bundled ---');
{
    const bundled = new Set(faces.map(f => f.fam.toLowerCase()));
    // Families Windows ships itself, which are legitimate first choices.
    const system = new Set(['segoe ui', 'georgia', 'palatino', 'palatino linotype',
        'sitka text', 'cascadia mono', 'cascadia code', 'consolas', 'courier new',
        'times new roman', 'arial', 'calibri']);
    const bad = [];
    for (const t of themes) {
        const first = String(t.FN || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
        if (!first) continue;
        const k = first.toLowerCase();
        if (bundled.has(k) || system.has(k) || k === 'serif' || k === 'sans-serif' || k === 'monospace') continue;
        bad.push(t.Name + ' -> ' + first);
    }
    assert(bad.length === 0,
        'no theme leads with a font the app neither bundles nor gets from Windows' +
        (bad.length ? ' -- ' + bad.join(', ') : ' (' + themes.length + ' themes)'));
}

console.log('\n--- 3. variable fonts declare their weight axis ---');
{
    // A variable font declared at a single weight is pinned there, and bold is then
    // synthesised by smearing the regular outlines rather than using the real design.
    const bad = [];
    for (const f of faces) {
        const file = path.join(appDir, decodeURIComponent(f.url));
        if (!fs.existsSync(file)) continue;
        const b = fs.readFileSync(file);
        let variable = false;
        try {
            const n = b.readUInt16BE(4);
            for (let i = 0; i < n; i++) {
                if (b.toString('ascii', 12 + i * 16, 16 + i * 16) === 'fvar') { variable = true; break; }
            }
        } catch (e) { continue; }
        if (variable && !/\s/.test(f.weight)) {
            bad.push(f.url + ' (variable, declared font-weight: ' + f.weight + ')');
        }
    }
    assert(bad.length === 0,
        'every variable font declares a weight range, so bold is real and not synthesised' +
        (bad.length ? ' -- ' + bad.join(', ') : ''));
}

console.log('\n--- 4. static families declare a bold face ---');
{
    // Without one the browser synthesises bold for these too. Variable families are
    // exempt: their range already covers it.
    const byFam = {};
    for (const f of faces) {
        (byFam[f.fam] = byFam[f.fam] || []).push(f);
    }
    const bad = [];
    for (const fam of Object.keys(byFam)) {
        const list = byFam[fam];
        const anyRange = list.some(f => /\s/.test(f.weight));
        if (anyRange) continue;
        const hasBold = list.some(f => parseInt(f.weight, 10) >= 600 && f.style === 'normal');
        if (!hasBold) bad.push(fam);
    }
    assert(bad.length === 0,
        'every static family ships a real bold' + (bad.length ? ' -- missing for: ' + bad.join(', ') : ''));
}

console.log('\n--- 5. the theme editor never substitutes a font ---');
{
    // The editor offers families, not hand-written CSS stacks, and matches a theme on the
    // family it leads with. Whole-string matching against ten literals fell back to index 0
    // for anything it did not recognise -- and the dialog previews AND saves from that
    // selection, so opening Customize Theme on Solarized Light and saving rewrote its font
    // to Inter. The font was installed and offered; only the stack text differed.
    const appCs = fs.readFileSync(path.join(appDir, "TypoZen_App.cs"), "utf8");
    assert(/int selectedFont = -1;/.test(appCs),
        "the editor does not default the font selection to preset 0");
    assert(/LeadingFamily\(_fontPresets\[i\]\[1\]\)/.test(appCs),
        "the editor matches on the leading family, not the whole stack string");
    assert(/\? _resetFn/.test(appCs),
        "saving without changing the family keeps the theme stack verbatim");
    // The picker lists typefaces, not one row per hand-written stack. Asserted on the
    // declaration itself -- an earlier version of this grepped the whole file for "(Serif)"
    // and failed on the comment explaining the change.
    assert(/FontFamilies = new string\[\]\[\]/.test(appCs),
        "font choices are declared as families with a generic fallback");

    // Every family a theme leads with must be one the editor can actually offer.
    const fams = new Set();
    const pre = /new string\[\]\s*\{\s*"([^"]+)",\s*"(?:sans-serif|serif|monospace)"\s*\}/g;
    let mm;
    while ((mm = pre.exec(appCs))) fams.add(mm[1].trim().toLowerCase());
    assert(fams.size > 4, "the family list was parsed (" + fams.size + " families)");
    const orphans = themes
        .map(t => ({ n: t.Name, f: String(t.FN || "").split(",")[0].trim().replace(/^['"]|['"]$/g, "") }))
        .filter(x => x.f && !fams.has(x.f.toLowerCase()))
        .map(x => x.n + " -> " + x.f);
    assert(orphans.length === 0,
        "every theme leads with a font the editor offers" +
        (orphans.length ? " -- missing: " + orphans.join("; ") : " (" + themes.length + " themes)"));
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nFONTS SELFTEST FAILED');
    process.exit(1);
}
console.log('\nFONTS SELFTEST PASSED');
process.exit(0);
