/**
 * Author stage directions and the cast scan (js/modules/09-speech.js).
 *
 * A bracket stays in the spoken text of whoever says that part of the line. A span tag
 * that opens a split piece is repeated on the later pieces. A tag against a quotation
 * goes with the speaker, still as a bracket. Find characters reads the whole markdown
 * or text file, and only the loaded chapter of an epub.
 *
 *   node tests/narration-tags-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'modules', '09-speech.js'), 'utf8');

const start = src.indexOf('const NARRATION_PIECE_CAP');
const at = src.indexOf('function castPieces');
if (start < 0 || at < start) throw new Error('narration slice not found');
let i = src.indexOf('{', at), depth = 0, end = -1;
for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
}
if (end < 0) throw new Error('castPieces did not close');

const posted = [];
const document = {
    blocks: [],
    querySelectorAll(sel) {
        if (sel !== '#editor .block') throw new Error('unexpected selector ' + sel);
        return this.blocks;
    }
};
const window = { chrome: { webview: { postMessage(m) { posted.push(m); } } } };
const box = { model: null };
const api = new Function('document', 'window', 'box', [
    'let DocumentModel = box.model;',
    'let _narrCast = {};',
    'let _narrCastSay = {};',
    'function narrLog() {}',
    src.slice(start, end + 1),
    'return {',
    '  paragraphPieces: paragraphPieces,',
    '  castPieces: castPieces,',
    '  narrationQuotes: narrationQuotes,',
    '  narrationCastScan: window.narrationCastScan,',
    '  setCast: function (c) { _narrCast = c; },',
    '  setCastSay: function (c) { _narrCastSay = c || {}; },',
    '  setModel: function (m) { DocumentModel = m; }',
    '};'
].join('\n'))(document, window, box);

let passed = 0, failed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; console.log('  OK   ' + name); }
    else { failed++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
}
function eq(name, got, want) {
    const same = JSON.stringify(got) === JSON.stringify(want);
    check(name, same, 'got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want));
}

console.log('--- brackets stay in the spoken text');
{
    const pieces = api.paragraphPieces('[crying] Please let me go.', null);
    eq('a span tag is spoken', pieces.map(p => p.text), ['[crying] Please let me go.']);
    eq('a span tag is not an instruction', pieces.map(p => p.direction), ['']);
}
{
    const pieces = api.paragraphPieces('hello[gasp]world', null);
    eq('a glued tag gets one space each side', pieces.map(p => p.text), ['hello [gasp] world']);
}
{
    const pieces = api.paragraphPieces('See [check spelling] here.', null);
    eq('an unknown bracket is read', pieces.map(p => p.text), ['See [check spelling] here.']);
    eq('an unknown bracket is not a cue', pieces.map(p => p.direction), ['']);
}
{
    const sentence = 'She walked to the door and stood there looking out at the road. ';
    let body = '';
    while (body.length < 450) body += sentence;
    const pieces = api.paragraphPieces('[panicked] ' + body, null);
    check('a long paragraph is more than one piece', pieces.length >= 2, 'pieces ' + pieces.length);
    check('a span tag opens every piece of the split', pieces.every(p => p.text.indexOf('[panicked]') === 0));
    check('the span is not turned into an instruction', pieces.every(p => p.direction === ''));
}
eq('a line that is only a tag is spoken', api.paragraphPieces('[laughing]', null).map(p => p.text), ['[laughing]']);

console.log('--- a tag against a quotation goes with the speaker');
api.setCast({ anna: 'qwen-ryan' });
{
    const text = '[crying]   "Please let me go," Anna said.';
    const pieces = api.castPieces(text, api.narrationQuotes(text), 0);
    const talk = pieces.filter(p => p.role === 'dialogue');
    const narr = pieces.filter(p => p.role === 'narration');
    eq('dialogue text', talk.map(p => p.text), ['[crying] Please let me go,']);
    eq('dialogue voice', talk.map(p => p.voice), ['qwen-ryan']);
    eq('dialogue direction', talk.map(p => p.direction), ['']);
    eq('narration does not say the tag', narr.map(p => p.text), ['Anna said.']);
}
{
    const text = '"Please [crying] let me go," Anna said.';
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    eq('tag inside the quote is spoken', talk.map(p => p.text), ['Please [crying] let me go,']);
    eq('tag inside the quote is not an instruction', talk.map(p => p.direction), ['']);
}
{
    const text = '"Get out," Anna snapped.';
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    eq('a speech verb is still a cue', talk.map(p => p.direction), ['sharp and angry']);
}
{
    const text = '"Hmm." Anna was quietly snoring.';
    const pieces = api.castPieces(text, api.narrationQuotes(text), 0);
    eq('the next sentence is not the cue', pieces.filter(p => p.role === 'dialogue').map(p => p.direction), ['']);
    eq('the next sentence stays narration', pieces.filter(p => p.role === 'narration').map(p => p.text), ['Anna was quietly snoring.']);
}
{
    const text = '"Get out," Anna snapped. She was quietly snoring.';
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    eq('a speech tag still cues when another sentence follows', talk.map(p => p.direction), ['sharp and angry']);
}
{
    const text = 'Anna said quietly "Hello there."';
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    eq('an adverb in the same sentence still cues', talk.map(p => p.direction), ['quiet and soft']);
}
{
    const text = 'She was shouting. "Hello," Anna said.';
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    eq('the previous sentence is not the cue', talk.map(p => p.direction), ['']);
}
{
    const text = '[sad] "Get out," Anna snapped.';
    const pieces = api.castPieces(text, api.narrationQuotes(text), 0);
    eq('the bracket stays on the speaker', pieces.filter(p => p.role === 'dialogue').map(p => p.text), ['[sad] Get out,']);
    eq('the speech verb is still the cue', pieces.filter(p => p.role === 'dialogue').map(p => p.direction), ['sharp and angry']);
    check('the tag is not in the narration', pieces.filter(p => p.role === 'narration').every(p => p.text.indexOf('[') < 0));
}
{
    const text = 'He was [sad] for a while. "Hello," Anna said.';
    const pieces = api.castPieces(text, api.narrationQuotes(text), 0);
    eq('a tag with words after it stays narration', pieces.filter(p => p.role === 'narration').map(p => p.text), ['He was [sad] for a while.', 'Anna said.']);
    eq('that narration is not given an instruction', pieces.filter(p => p.role === 'narration').map(p => p.direction), ['', '']);
    eq('the quotation is not given it', pieces.filter(p => p.role === 'dialogue').map(p => p.direction), ['']);
}
{
    const sentence = 'Please let me go, I have been standing here since morning and I will not leave without an answer. ';
    let inner = '';
    while (inner.length < 450) inner += sentence;
    const text = '[panicked] "' + inner + '" Anna said.';
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    check('a long quotation is more than one piece', talk.length >= 2, 'pieces ' + talk.length);
    check('each piece of the quotation keeps the span tag', talk.every(p => p.text.indexOf('[panicked]') === 0));
}

console.log('--- a character instruction goes out with that character');
{
    api.setCastSay({ anna: '  Speak in a sad, sorrowful tone, voice low and heavy.  ' });
    const text = '"Get out," Anna snapped.';
    const pieces = api.castPieces(text, api.narrationQuotes(text), 0);
    const talk = pieces.filter(p => p.role === 'dialogue');
    eq('the character instruction is on the line', talk.map(p => p.instruction),
        ['Speak in a sad, sorrowful tone, voice low and heavy.']);
    eq('the speech verb is still recorded', talk.map(p => p.direction), ['sharp and angry']);
    check('narration is not given the character instruction',
        pieces.filter(p => p.role === 'narration').every(p => !p.instruction));
}
{
    api.setCastSay({});
    const text = '"Hello," Anna said.';
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    eq('a character with no instruction sends none', talk.map(p => p.instruction), ['']);
}

console.log('--- a lead-in cut off by a quote does not end on a comma');
{
    const line = 'Get out of this house and do not come back until I say so.';
    const text = 'Anna whispered, "' + line + '"';
    const pieces = api.castPieces(text, api.narrationQuotes(text), 0);
    eq('the lead-in comma is closed', pieces.filter(p => p.role === 'narration').map(p => p.text), ['Anna whispered.']);
    eq('the quote stays with the character', pieces.filter(p => p.role === 'dialogue').map(p => p.text), [line]);
}
{
    const text = 'Anna whispered: "Get out."';
    const pieces = api.castPieces(text, api.narrationQuotes(text), 0);
    eq('a lead-in colon stays', pieces.filter(p => p.role === 'narration').map(p => p.text), ['Anna whispered:']);
}
{
    const text = '"Get out," Anna whispered.';
    const pieces = api.castPieces(text, api.narrationQuotes(text), 0);
    eq('a tag after the quote keeps its period', pieces.filter(p => p.role === 'narration').map(p => p.text), ['Anna whispered.']);
}

console.log('--- a quotation is enough; the comma is not');
function speakerKeys(text) {
    return api.narrationQuotes(text).map(q => q.key);
}
eq('Jill said "hello"', speakerKeys('Jill said "Hello there."'), ['jill']);
eq('Jill said, "hello"', speakerKeys('Jill said, "Hello there."'), ['jill']);
eq('Jill: "hello"', speakerKeys('Jill: "Hello there."'), ['jill']);
eq('Jill said quietly "hello"', speakerKeys('Jill said quietly "Hello there."'), ['jill']);
eq('"hello" Jill said', speakerKeys('"Hello there." Jill said.'), ['jill']);
eq('"hello" said Jill', speakerKeys('"Hello there," said Jill.'), ['jill']);
eq('said Jill, "hello"', speakerKeys('said Jill, "Hello there."'), ['jill']);
eq('Jill, after a long wait, said:', speakerKeys('Jill, after a long wait, said: "Hello there."'), ['jill']);
eq('Jill, said', speakerKeys('Jill, said "Hello there."'), ['jill']);
eq('Jill said, after a long wait,', speakerKeys('Jill said, after a long wait, "Hello there."'), ['jill']);
eq('a name six words away', speakerKeys('Jill one two three four five "Hello there."'), ['jill']);
eq('a name seven words away', speakerKeys('Jill one two three four five six "Hello there."'), ['']);
eq('the nearer name wins', speakerKeys('Bob talked, then Jill said "Hello there."'), ['jill']);
eq('Jill told Paul', speakerKeys('Jill told Paul "Hello there."'), ['jill']);
eq('Jill asked Paul', speakerKeys('Jill asked Paul "Hello there."'), ['jill']);
eq('Jill told Paul, after a pause', speakerKeys('Jill told Paul, after a pause, "Hello there."'), ['jill']);
eq('said Jill to Paul', speakerKeys('"Hello there," said Jill to Paul.'), ['jill']);
eq('Jill told Paul afterwards', speakerKeys('"Hello there," Jill told Paul.'), ['jill']);
eq('she told Paul is not Paul', speakerKeys('She told Paul "Hello there."'), ['']);
{
    document.blocks = [];
    api.setModel({
        kind: 'markdown',
        blocks: [
            { raw: 'Jill said "Hello."' },
            { raw: 'Jill: "Again."' },
            { raw: 'Bob: "Once."' }
        ]
    });
    posted.length = 0;
    const list = api.narrationCastScan();
    eq('both shapes count as Jill', list.map(c => c.key), ['jill']);
    eq('Jill has both lines', list.map(c => c.lines), [2]);
}

console.log('--- Find characters reads the whole markdown or text file');
document.blocks = [
    { innerText: '"Nope," Zara said.' },
    { innerText: '"Still," Zara said.' }
];
api.setModel({
    kind: 'markdown',
    blocks: [
        { raw: '"Hello," Anna said.' },
        { raw: '"Again," Anna said.' },
        { raw: '"Once," Bob said.' }
    ]
});
{
    posted.length = 0;
    const list = api.narrationCastScan();
    eq('markdown scan names', list.map(c => c.key), ['anna']);
    const msg = JSON.parse(posted[0].slice('host_narrator_cast:'.length));
    eq('markdown scan is the whole book', msg.whole, true);
    eq('a single line is left out', msg.characters.map(c => c.key), ['anna']);
}
api.setModel({
    kind: 'epub',
    blocks: [
        { raw: '"Hello," Anna said.' },
        { raw: '"Again," Anna said.' }
    ]
});
{
    posted.length = 0;
    const list = api.narrationCastScan();
    eq('epub scan stays on the loaded chapter', list.map(c => c.key), ['zara']);
    const msg = JSON.parse(posted[0].slice('host_narrator_cast:'.length));
    eq('epub scan is not the whole book', msg.whole, false);
}

console.log('--- emotion cues still gate the instruction');
check('narration blanks direction when cues are off',
    /direction: _narrDirect \? \(p\.direction \|\| ''\) : ''/.test(src));
check('Try it blanks direction when cues are off',
    /direction: o\.direct \? p\.direction : ''/.test(src));

console.log(failed ? 'NARRATION-TAGS FAILED (' + failed + ' of ' + (passed + failed) + ')'
                   : 'NARRATION-TAGS PASSED (' + passed + ')');
process.exitCode = failed ? 1 : 0;
