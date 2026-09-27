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

const xaml = fs.readFileSync(path.join(root, 'TypoZen.xaml'), 'utf8');
// Edit > Spelling (Check Document / Next Issue) was removed on 2026-09-27: every misspelling on
// screen is underlined, and nobody used the walk.
assert(!/mSpellCheck|mSpellNext|menuSpelling/.test(xaml), 'no Edit > Spelling submenu');

const layout = fs.readFileSync(path.join(root, 'js', 'modules', '02-layout.js'), 'utf8');
assert(/function scheduleSpellCheck/.test(layout), 'page schedules a check after typing');
assert(/typozen-spell/.test(layout), 'page paints CSS highlight typozen-spell');
assert(/applySpellFix/.test(layout), 'replacement is applied into the document');
assert(/data-spell-ignore/.test(layout) && /data-spell-add/.test(layout),
    'popover offers Ignore and Add to dictionary');

const shell = fs.readFileSync(path.join(root, 'js', 'modules', '03-shell.js'), 'utf8');
assert(/spell_hits:/.test(shell), 'host hits reach the page');

const css = fs.readFileSync(path.join(root, 'css', 'typozen.css'), 'utf8');
assert(/::highlight\(typozen-spell\)/.test(css), 'wavy underline style exists');

const html = fs.readFileSync(path.join(root, 'TypoZen_Template.html'), 'utf8');
assert(/id="selPopSpell"/.test(html), 'selection popover has a spelling row');
// One engine in both views: the host's Windows checker, drawn by the page. Chromium's own
// checker is off in both -- inside CodeMirror its squiggles came and went with every redraw.
const source = fs.readFileSync(path.join(root, 'js', 'modules', '01a-source.js'), 'utf8');
assert(/id="source-cm"/.test(html) && /contentAttributes\.of\(\{\s*spellcheck:\s*'false'/.test(source),
    'Source (CodeMirror in #source-cm) has Chromium spellcheck off');
assert(/id="editor"[^>]*spellcheck="false"/.test(html), 'Preview editor has Chromium spellcheck off');
assert(/spellCheckTexts/.test(source) && /spellCached/.test(source) && /typozen-spell/.test(source) && /recheckSpelling\(\)/.test(source),
    'Source checks its visible lines through the shared, remembering checker and draws typozen-spell');
// Suggestions only when a word is selected: a check finds misspellings, nothing more.
const checkBody = (spellCs.match(/public static Hit\[\] Check\(string text\)[\s\S]*?\n        }\r?\n/) || [''])[0];
assert(checkBody && !/GetSpellingError\(/.test(checkBody), 'the host\'s check does not work out suggestions');
assert(/public static string\[\] Suggest\(string word\)/.test(spellCs) && /spell_suggest:/.test(app), 'the host suggests for one word on request');
assert(/spell_suggestions:/.test(shell) && /spell_suggest:/.test(layout), 'the page asks for suggestions when a word is selected');
assert(/function spellCheckTexts/.test(layout) && /_spellCache/.test(layout), 'answers are remembered per text');
assert(/sourceEditor\.recheckSpelling\(\)/.test(layout), 'scheduleSpellCheck re-checks Source when Source is showing');
assert(/::highlight\(typozen-spell\),\s*#source-cm \.typozen-spell/.test(css), 'one underline rule for both views');

// The checker never runs on the UI thread: its cost grows faster than the text, and a big
// pass there froze the window (2026-09-27). The host posts to it and gets a callback.
assert(/Thread\(/.test(spellCs) && /ApartmentState\.STA/.test(spellCs) && /CheckAsync/.test(spellCs),
    'the checker has a thread of its own');
{
    const handler = (app.match(/private void HandleSpellCheck[\s\S]*?\n        }\r?\n/) || [''])[0];
    assert(/WindowsSpell\.CheckAsync\(/.test(handler) && !/WindowsSpell\.Check\(/.test(handler),
        'the host checks through the spelling thread, never directly');
    const sugg = (app.match(/private void HandleSpellSuggest[\s\S]*?\n        }\r?\n/) || [''])[0];
    assert(/WindowsSpell\.SuggestAsync\(/.test(sugg), 'suggestions go through the spelling thread too');
}

const csproj = fs.readFileSync(path.join(root, 'TypoZen.csproj'), 'utf8');
assert(/SpellCheck\.cs/.test(csproj), 'SpellCheck.cs is in the project');

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SPELL SELFTEST FAILED'); process.exit(1); }
console.log('SPELL SELFTEST PASSED');
