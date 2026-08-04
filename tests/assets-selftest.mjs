/**
 * Bundled assets + no-network guard.
 *
 * Two failure modes neither the other suites nor the parse check can see:
 *
 *  1. A font file renamed, moved or not copied. Every @font-face still parses, the app
 *     still runs, and typography silently falls back — no error anywhere.
 *  2. A remote <link>/@import creeping back into the page. That is how the editor ended
 *     up render-blocked on a round trip to fonts.googleapis.com on every cold start.
 *
 * node tests/assets-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const templatePath = path.join(APP, 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

console.log('\n=== every relative url() resolves to a real file ===');
{
    const refs = [...html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
        .map(m => m[1].trim())
        .filter(u => !/^(data:|https?:|blob:|about:|#)/i.test(u));
    const unique = [...new Set(refs)];
    assert(unique.length > 0, 'template references at least one bundled asset');
    for (const rel of unique) {
        assert(fs.existsSync(path.join(APP, rel)), 'exists: ' + rel);
    }
}

console.log('\n=== bundled font faces are complete ===');
{
    const faces = [...html.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map(m => m[1]);
    assert(faces.length >= 10, 'at least 10 @font-face rules (' + faces.length + ')');

    const families = new Set();
    for (const f of faces) {
        const fam = /font-family:\s*['"]([^'"]+)['"]/.exec(f);
        if (fam) families.add(fam[1]);
        // local() must come first, or an installed copy is shadowed and the bundled
        // file loads needlessly — the exact defect that motivated bundling.
        const src = /src:\s*([^;]+);/.exec(f);
        if (src) {
            assert(/^\s*local\(/.test(src[1]),
                'local() first for ' + (fam ? fam[1] : '?') + ' ' +
                (/font-style:\s*italic/.test(f) ? 'italic' : 'normal'));
        }
    }
    for (const want of ['Inter', 'Literata', 'Merriweather', 'Source Sans 3']) {
        assert(families.has(want), 'bundled family present: ' + want);
    }
}

console.log('\n=== no remote resources on the page ===');
{
    // Strip comments first: the head carries an explanatory note naming the old URL.
    const stripped = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const head = stripped.slice(0, stripped.search(/<\/head>/i));

    assert(!/<link[^>]+href\s*=\s*["']https?:/i.test(head),
        'no remote <link> in <head> (render-blocking network round trip)');
    assert(!/@import\s+(url\()?["']?https?:/i.test(stripped),
        'no remote @import');
    assert(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(stripped),
        'no Google Fonts reference outside comments');
    assert(!/<script[^>]+src\s*=\s*["']https?:/i.test(stripped),
        'no remote <script>');
}

console.log('\n=== assets selftest:', passed, 'passed,', failed, 'failed ===\n');
process.exit(failed ? 1 : 0);
