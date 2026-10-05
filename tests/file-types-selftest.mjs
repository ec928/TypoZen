/**
 * One list of file types, used everywhere.
 *
 * TypoZen_App.cs CodeExtensions decides the Code document type (its view settings) and which
 * files open straight into Source. Until 2026-09-29 there were several lists and they
 * disagreed: .xsl opened in Source with Documents settings, .js/.ts/.cs opened in Preview,
 * and neither the installer nor the Store package offered TypoZen for any code file.
 *
 *   node tests/file-types-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const app = read('TypoZen_App.cs');
const code = [...(app.match(/CodeExtensions = \{([^}]*)\}/) || ['', ''])[1].matchAll(/"(\.[a-z0-9]+)"/g)].map(m => m[1]);
assert(code.length >= 30, 'the host has one CodeExtensions list (' + code.length + ')');
assert(!/string\[\] codeExts/.test(app), 'no second, private list of code extensions in the host');
assert(/return IsCodePath\(path\);/.test(app), 'files open in Source by the same list');

// The page's code table: every language it highlights is of the Code type.
const sandbox = { window: {}, document: { getElementById: () => null }, console };
sandbox.window = sandbox; vm.createContext(sandbox);
vm.runInContext(read('js/modules/08-code.js'), sandbox);
const pageExts = Object.keys(sandbox.window.CODE_LANGUAGES || {}).map(e => '.' + e);
const missing = pageExts.filter(e => !code.includes(e));
assert(pageExts.length > 0 && missing.length === 0, "every extension 08-code.js highlights is Code in the host" + (missing.length ? ' (missing ' + missing.join(' ') + ')' : ''));

// "Open with": the installer and the Store package offer every type TypoZen edits or reads.
const want = ['.md', '.markdown', '.txt', '.epub', '.pdf', ...code];
const iss = read('tools/TypoZen.iss');
const issTypes = [...iss.matchAll(/SupportedTypes"; ValueType: string; ValueName: "(\.[a-z0-9]+)"/g)].map(m => m[1]);
const issMissing = want.filter(e => !issTypes.includes(e));
assert(issMissing.length === 0, 'the installer offers TypoZen for all ' + want.length + ' types' + (issMissing.length ? ' (missing ' + issMissing.join(' ') + ')' : ''));
assert(!/Software\\Classes\\\.(html|js|css|xml|json)\\/.test(iss), 'the installer does not make TypoZen the default for code files');
const msix = read('tools/Build-Msix.ps1');
const msixTypes = [...msix.matchAll(/<uap:FileType>(\.[a-z0-9]+)<\/uap:FileType>/g)].map(m => m[1]);
// MakeAppx rejects these. The installer still offers them; the Store package cannot.
const storeBlocked = ['.bat', '.cmd'];
const msixWant = want.filter(e => !storeBlocked.includes(e));
const msixMissing = msixWant.filter(e => !msixTypes.includes(e));
assert(msixMissing.length === 0, 'the Store package declares all ' + msixWant.length + ' types it is allowed' + (msixMissing.length ? ' (missing ' + msixMissing.join(' ') + ')' : ''));
assert(storeBlocked.every(e => !msixTypes.includes(e)), 'the Store package does not declare .bat or .cmd');
assert(new Set(msixTypes).size === msixTypes.length, 'no type declared twice in the Store package');

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('FILE TYPES SELFTEST FAILED'); process.exit(1); }
console.log('FILE TYPES SELFTEST PASSED');
