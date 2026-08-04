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

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nPARSE CHECK FAILED');
    process.exit(1);
}
console.log('\nPARSE CHECK PASSED');
