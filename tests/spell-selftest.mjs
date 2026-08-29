/**
 * Spelling is Windows proofing, not the WordNet dictionary.
 *
 *   node tests/spell-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(c, msg) {
    if (c) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const spellCs = fs.readFileSync(path.join(root, 'SpellCheck.cs'), 'utf8');
assert(/GetNextSpellingErrorCharacterIndex/.test(spellCs), 'host uses WPF TextBox spellcheck');
assert(/class WindowsSpell/.test(spellCs), 'WindowsSpell is the façade the app calls');
assert(/_userWordsPath/.test(spellCs) && /AppendAllText/.test(spellCs),
    'Add to dictionary persists a user word list');
assert(!/LoadLexicon/.test(spellCs), 'spell engine does not load the WordNet lexicon');

const app = fs.readFileSync(path.join(root, 'TypoZen_App.cs'), 'utf8');
assert(/user_words\.txt/.test(app), 'user dictionary file is user_words.txt in the cache');
assert(/HandleSpellCheck/.test(app), 'host answers spell_check:');
assert(/cmd:spell_check_doc/.test(app), 'Edit → Check Document posts cmd:spell_check_doc');
assert(/cmd:spell_next/.test(app), 'Next Issue posts cmd:spell_next');

const xaml = fs.readFileSync(path.join(root, 'TypoZen.xaml'), 'utf8');
assert(/mSpellCheck/.test(xaml) && /Check Document/.test(xaml), 'Edit menu has Check Document');
assert(/mSpellNext/.test(xaml), 'Edit menu has Next Issue');

const layout = fs.readFileSync(path.join(root, 'js', 'modules', '02-layout.js'), 'utf8');
assert(/function scheduleSpellCheck/.test(layout), 'page schedules a check after typing');
assert(/typozen-spell/.test(layout), 'page paints CSS highlight typozen-spell');
assert(/applySpellFix/.test(layout), 'replacement is applied into the document');
assert(/data-spell-ignore/.test(layout) && /data-spell-add/.test(layout),
    'popover offers Ignore and Add to dictionary');

const shell = fs.readFileSync(path.join(root, 'js', 'modules', '03-shell.js'), 'utf8');
assert(/spell_hits:/.test(shell), 'host hits reach the page');
assert(/spell_check_doc/.test(shell), 'Check Document command is handled');

const css = fs.readFileSync(path.join(root, 'css', 'typozen.css'), 'utf8');
assert(/::highlight\(typozen-spell\)/.test(css), 'wavy underline style exists');

const html = fs.readFileSync(path.join(root, 'TypoZen_Template.html'), 'utf8');
assert(/id="selPopSpell"/.test(html), 'selection popover has a spelling row');
assert(/id="source-editor"[^>]*spellcheck="true"/.test(html),
    'Source textarea has Chromium spellcheck on');
assert(/id="editor"[^>]*spellcheck="true"/.test(html),
    'Preview editor keeps spellcheck="true"');

const csproj = fs.readFileSync(path.join(root, 'TypoZen.csproj'), 'utf8');
assert(/SpellCheck\.cs/.test(csproj), 'SpellCheck.cs is in the project');

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SPELL SELFTEST FAILED'); process.exit(1); }
console.log('SPELL SELFTEST PASSED');
