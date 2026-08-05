/**
 * Full-template parse check: compiles the entire main <script> body.
 * Function-extraction selftests cannot catch syntax errors outside pulled snippets
 * or failures during whole-script parse. This closes that gap in milliseconds.
 *
 * node tests/parse-check.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

console.log('=== full template script parse ===');
assert(!!mainScript && mainScript.length > 50000,
    'main script extracted (bytes=' + (mainScript ? mainScript.length : 0) + ')');

// Sloppy mode (browser classic scripts are non-strict unless "use strict")
try {
    // new Function only parses; does not execute body until called.
    // Calling would need a full DOM — we only verify syntax here.
    // eslint-disable-next-line no-new-func
    const fn = new Function(mainScript + '\n; return true;');
    assert(typeof fn === 'function', 'sloppy mode: new Function compiles');
} catch (e) {
    assert(false, 'sloppy mode parse: ' + (e && e.message));
}

// Strict mode catches a few extra footguns
try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('"use strict";\n' + mainScript + '\n; return true;');
    assert(typeof fn === 'function', 'strict mode: new Function compiles');
} catch (e) {
    // Some browser-only globals / patterns may differ; report but allow note
    assert(false, 'strict mode parse: ' + (e && e.message));
}

// vm.Script is another parser path (V8)
try {
    // Wrap so top-level return is invalid — compile as script body only
    new vm.Script(mainScript, { filename: 'TypoZen_Template_Test.html#main' });
    assert(true, 'vm.Script compiles full main script');
} catch (e) {
    assert(false, 'vm.Script: ' + (e && e.message));
}


console.log('--- no stray control characters in the sources ---');
{
    // Three separate bugs in this project came from writing a regex through a tool that
    // interpreted the backslashes: \b became 0x08 and \1 became 0x01, leaving a pattern
    // that matches nothing and looks completely normal in an editor. Each time it presented
    // as a feature silently doing nothing -- "No headings found" on every book, every
    // internal link going nowhere -- rather than as an error.
    //
    // They are invisible by nature, so the only defence is to look for them.
    //
    // A fourth one landed in a test rather than in the sources: the carrier regex in
    // epub-open-app.mjs ended in a backspace byte, matched no block at all, and the
    // suite reported zero images instead of failing. The tests are sources too.
    const files = ['js/typozen.js', 'css/typozen.css', 'TypoZen_Template.html',
                   'TypoZen_App.cs', 'EpubReader.cs']
        .concat(fs.readdirSync(path.join(__dirname))
            .filter(f => f.endsWith('.mjs'))
            .map(f => 'tests/' + f));
    for (const rel of files) {
        const full = path.join(__dirname, '..', rel);
        if (!fs.existsSync(full)) continue;
        const text = fs.readFileSync(full, 'utf8');
        const found = [];
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            // Tab (9), LF (10), CR (13) are legitimate; nothing else below 32 is.
            if (c < 9 || (c > 13 && c < 32) || c === 11 || c === 12) {
                found.push('line ' + (text.slice(0, i).split('\n').length) +
                           ' code ' + c);
                if (found.length >= 3) break;
            }
        }
        assert(found.length === 0,
            rel + ' has no control characters' +
            (found.length ? ' -- ' + found.join(', ') : ''));
    }
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nPARSE CHECK FAILED');
    process.exit(1);
}
console.log('\nPARSE CHECK PASSED');
