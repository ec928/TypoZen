/**
 * Author stage directions and the cast scan (js/modules/09-speech.js).
 *
 * A bracket stays in the spoken text of whoever says that part of the line, except a
 * line instruction: a bracket to the right of a named speaker, or, with no speaker,
 * a bracket beside the quotation. That one is told and not spoken, and it replaces
 * the cast instruction or the narrator's for that quotation. [[tag]] anywhere in
 * that quotation's sentence does the same and beats the cast box, the narrator box,
 * a speech tag, and a single bracket. A span tag that opens a
 * split piece is repeated on the later pieces. Find characters reads the whole
 * markdown or text file, and only the loaded chapter of an epub.
 *
 *   node tests/narration-tags-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'modules', '09-speech.js'), 'utf8');

const start = src.indexOf('const NARRATION_PIECE_CAP');
const at = src.indexOf('function narrationBatches');
if (start < 0 || at < start) throw new Error('narration slice not found');
let i = src.indexOf('{', at), depth = 0, end = -1;
for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
}
if (end < 0) throw new Error('narrationBatches did not close');

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
    'const NARRATION_BATCH = 8;',
    'function narrLog() {}',
    src.slice(start, end + 1),
    'return {',
    '  paragraphPieces: paragraphPieces,',
    '  castPieces: castPieces,',
    '  narrationQuotes: narrationQuotes,',
    '  narrationBatches: narrationBatches,',
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
    eq('a speech verb is still a cue', talk.map(p => p.direction), ['snapped']);
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
    eq('a speech tag still cues when another sentence follows', talk.map(p => p.direction), ['snapped']);
}
{
    const text = 'Anna said quietly "Hello there."';
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    eq('an adverb in the same sentence still cues', talk.map(p => p.direction), ['said quietly']);
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
    eq('the speech verb is still the cue', pieces.filter(p => p.role === 'dialogue').map(p => p.direction), ['snapped']);
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
    eq('the speech verb is still recorded', talk.map(p => p.direction), ['snapped']);
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
eq('a name eight words away', speakerKeys('Jill one two three four five six seven "Hello there."'), ['jill']);
eq('a name nine words away', speakerKeys('Jill one two three four five six seven eight "Hello there."'), ['']);
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

console.log('--- a bracket to the right of a character replaces that character\'s instruction');
function lineOf(text) {
    return api.castPieces(text, api.narrationQuotes(text), 0);
}
api.setCast({ anna: 'qwen-ryan' });
api.setCastSay({ anna: 'Sad, low pitched, slow speech' });
{
    const text = 'Anna [whispers softly with slow speech], "Get out."';
    const pieces = lineOf(text);
    const talk = pieces.filter(p => p.role === 'dialogue');
    eq('the bracket is not spoken on her line', talk.map(p => p.text), ['Get out.']);
    eq('the bracket replaces the cast instruction', talk.map(p => p.instruction),
        ['whispers softly with slow speech']);
    eq('the name stays with the narrator', pieces.filter(p => p.role === 'narration').map(p => p.text), ['Anna.']);
    eq('softly inside the bracket is not a cue', talk.map(p => p.direction), ['']);
    check('the narrator is not given her instruction',
        pieces.filter(p => p.role === 'narration').every(p => !p.instruction));
}
{
    const text = '"Get out," Anna [whispers softly].';
    const pieces = lineOf(text);
    const talk = pieces.filter(p => p.role === 'dialogue');
    eq('a trailing bracket replaces the cast instruction', talk.map(p => p.instruction), ['whispers softly']);
    eq('a trailing bracket is not spoken', talk.map(p => p.text), ['Get out,']);
    eq('the trailing name stays narration', pieces.filter(p => p.role === 'narration').map(p => p.text), ['Anna.']);
}
{
    const text = 'Anna [whispers softly] "Get out."';
    const talk = lineOf(text).filter(p => p.role === 'dialogue');
    eq('a glued bracket is an instruction, not a spoken tag', talk.map(p => p.text), ['Get out.']);
    eq('a glued bracket is the line instruction', talk.map(p => p.instruction), ['whispers softly']);
}
eq('a long bracket does not hide the name',
    api.narrationQuotes('Anna [one two three four five six seven], "Hello there."').map(q => q.key), ['anna']);
{
    const text = '[sad] Anna, "Hello."';
    const pieces = lineOf(text);
    eq('a bracket to the left of the name stays spoken',
        pieces.filter(p => p.role === 'narration').map(p => p.text), ['[sad] Anna.']);
    eq('a bracket to the left does not replace the cast instruction',
        pieces.filter(p => p.role === 'dialogue').map(p => p.instruction), ['Sad, low pitched, slow speech']);
}
{
    const text = 'Anna said "[whispered] Get out."';
    const talk = lineOf(text).filter(p => p.role === 'dialogue');
    eq('a bracket inside the quote stays spoken', talk.map(p => p.text), ['[whispered] Get out.']);
    eq('a bracket inside the quote is not the line instruction', talk.map(p => p.instruction),
        ['Sad, low pitched, slow speech']);
}
{
    api.setCast({});
    const text = 'Anna [whispers softly], "Get out."';
    const pieces = lineOf(text);
    eq('an unvoiced name stays narration', pieces.filter(p => p.role === 'narration' && p.text.indexOf('Anna') >= 0).map(p => p.text), ['Anna.']);
    const quote = pieces.filter(p => p.text.indexOf('Get out') >= 0);
    eq('an unvoiced quote is spoken by the narrator', quote.map(p => p.role), ['narration']);
    eq('an unvoiced quote keeps its marks', quote.map(p => p.text), ['"Get out."']);
    eq('an unvoiced quote takes the bracket', quote.map(p => p.instruction), ['whispers softly']);
}

console.log('--- with no character, a bracket beside a quote replaces the narrator\'s instruction');
function read(text) {
    api.setCast({ anna: 'qwen-ryan' });
    api.setCastSay({ anna: 'Sad, low pitched, slow speech' });
    const el = { innerText: text, getAttribute: function () { return null; } };
    const batches = api.narrationBatches([el], 0, 1);
    return batches.length ? batches[0] : [];
}
{
    const pieces = read('She shut the door. [whispers softly with slow speech] "Get out." Then she waited.');
    eq('the quotation is its own piece', pieces.map(p => p.text),
        ['She shut the door.', '"Get out."', 'Then she waited.']);
    eq('only the quotation takes the bracket', pieces.map(p => p.instruction || ''),
        ['', 'whispers softly with slow speech', '']);
    eq('the quotation stays with the narrator', pieces.map(p => p.role),
        ['narration', 'narration', 'narration']);
}
{
    const pieces = read('[whispers softly with slow speech] "Get out."');
    eq('a leading bracket on a bare quote is the instruction', pieces.map(p => p.instruction || ''),
        ['whispers softly with slow speech']);
    eq('a leading bracket on a bare quote is not spoken', pieces.map(p => p.text), ['"Get out."']);
}
{
    const pieces = read('"Get out." [whispers softly]');
    eq('a trailing bracket on a bare quote is the instruction', pieces.map(p => p.instruction || ''),
        ['whispers softly']);
    eq('a trailing bracket on a bare quote is not spoken', pieces.map(p => p.text), ['"Get out."']);
}
{
    const pieces = read('"Hi". [whispers]');
    eq('a bracket after the sentence is not an instruction', pieces.map(p => p.instruction || ''), ['']);
    check('a bracket after the sentence stays spoken', pieces.some(p => p.text.indexOf('[whispers]') >= 0));
}
{
    api.setCast({});
    api.setCastSay({});
    const el = { innerText: '[whispers softly] "Get out."', getAttribute: function () { return null; } };
    const pieces = api.narrationBatches([el], 0, 1)[0];
    eq('no cast at all still gives the narrator the bracket', pieces.map(p => p.instruction || ''),
        ['whispers softly']);
    eq('no cast at all does not speak the bracket', pieces.map(p => p.text), ['"Get out."']);
}
{
    const pieces = read('Anna [whispers softly with slow speech], "Get out."');
    const talk = pieces.filter(p => p.role === 'dialogue');
    eq('a cast line still uses the bracket when the book is read', talk.map(p => p.instruction),
        ['whispers softly with slow speech']);
    eq('a cast line still does not speak the bracket', talk.map(p => p.text), ['Get out.']);
}

console.log('--- [[tag]] overrides every other instruction and is not spoken');
{
    const whisper = 'whispers, speaks very quietly, softly, low pitched and very slowly';
    api.setCast({ anna: 'qwen-ryan' });
    api.setCastSay({ anna: whisper });
    {
        const text = 'Anna [[shouts loudly]] sadly said "Goodbye everyone"';
        const pieces = lineOf(text);
        const talk = pieces.filter(p => p.role === 'dialogue');
        eq('a double bracket is not spoken', talk.map(p => p.text), ['Goodbye everyone']);
        eq('a double bracket replaces the cast box', talk.map(p => p.instruction), ['shouts loudly']);
        eq('a double bracket is marked as the line instruction', talk.map(p => p.bracket), [true]);
        check('the lead-in does not speak the double bracket',
            pieces.filter(p => p.role === 'narration').every(p => p.text.indexOf('[[') < 0 && p.text.indexOf('shouts') < 0));
        check('the lead-in keeps the narrator instruction',
            pieces.filter(p => p.role === 'narration').every(p => !p.instruction));
    }
    {
        const text = '[[shouts loudly]] "Goodbye," Anna said.';
        const pieces = lineOf(text);
        const talk = pieces.filter(p => p.role === 'dialogue');
        eq('a double bracket to the left of the name is the instruction', talk.map(p => p.instruction), ['shouts loudly']);
        eq('a double bracket to the left is not spoken', talk.map(p => p.text), ['Goodbye,']);
        check('the name is still found to the right of a double bracket',
            pieces.some(p => p.role === 'narration' && p.text.indexOf('Anna') >= 0));
    }
    {
        const text = 'Anna said "[[shouts loudly]] Goodbye everyone"';
        const pieces = lineOf(text);
        const talk = pieces.filter(p => p.role === 'dialogue');
        eq('a double bracket inside the quote is the instruction', talk.map(p => p.instruction), ['shouts loudly']);
        eq('a double bracket inside the quote is not spoken', talk.map(p => p.text), ['Goodbye everyone']);
        check('no piece speaks a double bracket', pieces.every(p => p.text.indexOf('[[') < 0 && p.text.indexOf(']]') < 0));
    }
    {
        const text = 'Anna [whispers softly] [[shouts loudly]], "Get out."';
        const pieces = lineOf(text);
        const talk = pieces.filter(p => p.role === 'dialogue');
        eq('a double bracket beats a single bracket', talk.map(p => p.instruction), ['shouts loudly']);
        eq('neither bracket is spoken', talk.map(p => p.text), ['Get out.']);
        check('the single bracket is not left in the lead-in',
            pieces.filter(p => p.role === 'narration').every(p => p.text.indexOf('[') < 0));
    }
    eq('a long double bracket does not hide the name',
        api.narrationQuotes('Anna [[one two three four five six seven eight nine]], "Hello there."').map(q => q.key), ['anna']);
    {
        const text = '[[shouts loudly]] The door opened. Anna said "Hello."';
        const pieces = lineOf(text);
        const talk = pieces.filter(p => p.role === 'dialogue');
        eq('a double bracket in the previous sentence does not replace Anna', talk.map(p => p.instruction), [whisper]);
        eq('that earlier tag is the narrator\'s instruction',
            pieces.filter(p => p.role === 'narration').map(p => p.instruction), ['shouts loudly']);
        check('that earlier tag is not spoken',
            pieces.every(p => p.text.indexOf('[[') < 0 && p.text.indexOf('shouts') < 0));
    }
    {
        const pieces = api.paragraphPieces('[[measured and quiet]] The door opened.', null);
        eq('narration keeps the double bracket as its instruction', pieces.map(p => p.instruction), ['measured and quiet']);
        eq('narration does not speak the double bracket', pieces.map(p => p.text), ['The door opened.']);
        eq('narration marks the double bracket', pieces.map(p => p.bracket), [true]);
    }
    {
        api.setCast({});
        api.setCastSay({});
        const el = { innerText: '[[measured and quiet]] The door opened.', getAttribute: function () { return null; } };
        const pieces = api.narrationBatches([el], 0, 1)[0];
        eq('a reading with no cast sends the double bracket', pieces.map(p => p.instruction || ''), ['measured and quiet']);
        eq('a reading with no cast does not speak it', pieces.map(p => p.text), ['The door opened.']);
    }
    // A full stop inside a bracket does not end the quotation's sentence. It used to: the
    // bracket was lost and its tail, "]]" and all, was sent as the speech tag.
    api.setCast({ anna: 'qwen-ryan', tom: 'qwen-aiden' });
    api.setCastSay({});
    {
        const said = 'Read it plainly. Voice the lines in quotation marks as breaking off.';
        const pieces = lineOf('[[' + said + ']] "Wait—" Anna said.');
        const talk = pieces.filter(p => p.role === 'dialogue');
        eq('a double bracket with a full stop inside reaches the voiced line whole', talk.map(p => p.instruction), [said]);
        check('none of that bracket is taken for a speech tag',
            pieces.every(p => (p.direction || '').indexOf(']') < 0 && (p.direction || '').indexOf('lines') < 0),
            JSON.stringify(pieces.map(p => p.direction)));
        eq('after the speech tag, it still reaches the voiced line whole',
            lineOf('"Wait—" Anna said [[Read it plainly. Speak softly]].').filter(p => p.role === 'dialogue').map(p => p.instruction),
            ['Read it plainly. Speak softly']);
    }
    {
        const pieces = lineOf('"Wait—" Anna said. [[Read it plainly. Speak softly]] "Go," Tom said quietly.');
        eq('between two quotations, it goes to the quotation of its own sentence',
            pieces.filter(p => p.role === 'dialogue').map(p => p.instruction), ['', 'Read it plainly. Speak softly']);
        check('and not to the narration before it', pieces.filter(p => p.role === 'narration').every(p => !p.instruction),
            JSON.stringify(pieces.map(p => [p.role, p.text, p.instruction])));
    }
    {
        // Quote marks inside a bracket are the instruction's, not a quotation. They used to
        // split the bracket into three spoken pieces in two voices.
        const pieces = lineOf('[[say "hush" softly]] "Wait—" Anna said.');
        eq('quote marks inside a double bracket do not make a quotation',
            pieces.map(p => [p.role, p.text]), [['dialogue', 'Wait—'], ['narration', 'Anna said.']]);
        eq('and the bracket is the instruction, quote marks and all',
            pieces.filter(p => p.role === 'dialogue').map(p => p.instruction), ['say "hush" softly']);
        eq('a quotation with a bracket inside it keeps the bracket in its words',
            api.narrationQuotes('"Please [crying] let me go," Anna said.').map(q => q.inner), ['Please [crying] let me go,']);
        check('the narrator path does not take bracket quote marks for a quotation either',
            api.paragraphPieces('[as if shouting "no!"] The door shut.', null).every(p => !p.direction));
    }
    {
        // A named speaker with no voice is read by the narrator: a bracket against the quotation
        // is the narrator's instruction for it, as with no speaker (Ed, 2026-10-10). It used to be
        // read aloud. The models' own tags stay in the text, performed, as they were.
        api.setCast({ anna: 'qwen-ryan' });
        const told = text => api.castPieces(text, api.narrationQuotes(text), 0).map(p => [p.role, p.text, p.instruction]);
        eq('unvoiced speaker: a bracket before the quotation is the narrator\'s instruction',
            told('[Read it angry] "You are late," Tom said quietly.'),
            [['narration', '"You are late,"', 'Read it angry'], ['narration', 'Tom said quietly.', '']]);
        eq('unvoiced speaker: and after it',
            told('"You are late," [Read it angry] Tom said quietly.')[0], ['narration', '"You are late,"', 'Read it angry']);
        eq('unvoiced speaker: a model tag against the quotation stays spoken',
            api.narrationQuotes('[laughing] "Stop it," Tom said.').map(q => q.instruct || ''), ['']);
        eq('unvoiced speaker: so does a span tag with a strength',
            api.narrationQuotes('[sad:9] "Stop it," Tom said.').map(q => q.instruct || ''), ['']);
        eq('a voiced speaker\'s bracket before the quotation is still spoken',
            api.narrationQuotes('[Read it angry] "Stop it," Anna said.').map(q => q.instruct || ''), ['']);
    }
    {
        const pieces = lineOf('Anna [whispers. slowly], "Get out."');
        eq('a single bracket with a full stop inside is still the line instruction',
            pieces.filter(p => p.role === 'dialogue').map(p => p.instruction), ['whispers. slowly']);
        check('and is not spoken', pieces.every(p => p.text.indexOf('[') < 0), JSON.stringify(pieces.map(p => p.text)));
    }
    api.setCast({ anna: 'qwen-ryan' });
    api.setCastSay({ anna: 'Sad, low pitched, slow speech' });
}

console.log('--- a speech tag is the instruction, in the words written there');
{
    const text = 'Anna shouts, speaks loudly, forcefully, fast: "Get out of this house and do not come back until I say so."';
    const pieces = api.paragraphPieces(text, null);
    eq('the clause, without the name, is the cue', pieces.map(p => p.direction),
        ['shouts, speaks loudly, forcefully, fast']);
    api.setCast({ anna: 'qwen-ryan' });
    api.setCastSay({ anna: 'Sad, low pitched, slow speech' });
    const talk = api.castPieces(text, api.narrationQuotes(text), 0).filter(p => p.role === 'dialogue');
    eq('Anna still speaks the quote', talk.map(p => p.text),
        ['Get out of this house and do not come back until I say so.']);
    eq('the same clause is on her line', talk.map(p => p.direction),
        ['shouts, speaks loudly, forcefully, fast']);
    check('a bracket is what wins over that clause', talk.every(p => !p.bracket));
}

console.log('--- a speech tag is added to the standing instruction');
{
    const at = src.indexOf('function cueInstruction');
    let i = src.indexOf('{', at), depth = 0, end = -1;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const cueInstruction = new Function(src.slice(at, end + 1) + '\nreturn cueInstruction;')();
    const whisper = 'whispers, speaks very quietly, softly, low pitched and very slowly';
    eq('sadly is added to Anna\'s default',
        cueInstruction({ role: 'dialogue', instruction: whisper, direction: 'sadly said' }, true).instruction,
        whisper + ', sadly');
    eq('with no default the speech tag is the instruction',
        cueInstruction({ role: 'dialogue', instruction: '', direction: 'sadly said' }, true).instruction,
        'sadly');
    eq('cues off keeps the default',
        cueInstruction({ role: 'dialogue', instruction: whisper, direction: 'sadly said' }, false).instruction,
        whisper);
    eq('a bracket still replaces the default',
        cueInstruction({ role: 'dialogue', instruction: 'shouts loudly', direction: 'sadly said', bracket: true }, true).instruction,
        'shouts loudly');
    api.setCast({ anna: 'qwen-ryan' });
    api.setCastSay({ anna: whisper });
    {
        const talk = api.castPieces(
            'Anna [[shouts loudly]] sadly said "Goodbye everyone"',
            api.narrationQuotes('Anna [[shouts loudly]] sadly said "Goodbye everyone"'), 0)
            .filter(p => p.role === 'dialogue')[0];
        eq('the sent instruction is only the double bracket',
            cueInstruction(talk, true, whisper).instruction, 'shouts loudly');
        eq('cues off still sends only the double bracket',
            cueInstruction(talk, false, whisper).instruction, 'shouts loudly');
    }
    eq('the narrator default keeps the speech tag too',
        cueInstruction({ role: 'narration', direction: 'sadly said' }, true, 'measured and unhurried').instruction,
        'measured and unhurried, sadly');

    // What a voiced line, and the narration beside it, are told.
    api.setCast({ anna: 'qwen-ryan', tom: 'qwen-aiden' });
    const told = (text, box) => lineOf(text).map(p => [p.role, cueInstruction(p, true, box || '').instruction]);
    const plain = (text, box) => api.paragraphPieces(text, null).map(p => cueInstruction(Object.assign({ role: 'narration' }, p), true, box).instruction);
    api.setCastSay({ tom: 'Speak softly.', anna: 'Speak up!' });
    eq('a box ending in a full stop takes the tag as a clause',
        told('"You are late," Tom said quietly.')[0], ['dialogue', 'Speak softly, quietly']);
    eq('a box ending in ! keeps it, and the tag starts a new sentence',
        told('"Go," Anna snapped.')[0], ['dialogue', 'Speak up! Snapped']);
    eq('the narrator box is joined the same way',
        plain('"You are late," Tom said quietly.', 'Read it plainly.'), ['Read it plainly, quietly']);
    check('an ellipsis is not taken for a full stop',
        plain('"You are late," Tom said quietly.', 'Slowly...')[0] === 'Slowly... Quietly', plain('"You are late," Tom said quietly.', 'Slowly...')[0]);
    api.setCastSay({});
    eq('who was spoken to is not an instruction: told him angrily',
        plain('"Go," she told him angrily.', ''), ['angrily']);
    eq('said to her brother leaves nothing',
        told('"Sit down," Anna said to her brother.').map(r => r[1]), ['', '']);
    eq('asked her again leaves nothing',
        told('Tom asked her again: "Where were you?"').filter(r => r[0] === 'dialogue').map(r => r[1]), ['']);
    eq('a trailing then is not an instruction',
        told('"Come here," Tom said softly; then, "Now."')[0], ['dialogue', 'softly']);
    eq('parentheses are not sent', told('"Leave," Anna said (coldly).')[0], ['dialogue', 'coldly']);
    eq('the name after the verb is not sent',
        plain('"Fine," said Tom, turning away.', ''), ['turning away']);
    eq('a tag with nothing left is not sent as a cue either',
        cueInstruction({ role: 'dialogue', direction: 'asked her again' }, true).direction, '');
    eq('a stock cue is still sent', cueInstruction({ role: 'dialogue', direction: 'emphatic' }, true).direction, 'emphatic');
    eq('his voice breaking stays', plain('"No," he said, his voice breaking.', ''), ['his voice breaking']);

    // [[tag]] after the speech tag is that quotation's, not the narration's too.
    {
        const pieces = told('"Wait—" Anna said [[Read it plainly. Speak softly]].');
        eq('a double bracket after the speech tag is the line\'s only', pieces,
            [['dialogue', 'Read it plainly. Speak softly'], ['narration', '']]);
        const two = told('"Wait—" Anna said [[hushed]]. "Go," Tom said.');
        eq('nor the narration before the next quotation', two.filter(r => r[0] === 'narration').map(r => r[1]), ['', '']);
        eq('a double bracket in a sentence of its own stays the narration\'s',
            told('The door opened [[measured]]. "Go," Tom said.').filter(r => r[0] === 'narration').map(r => r[1]), ['measured', '']);
    }

    // Read from here inside a quotation, nobody voiced: the cue survives.
    {
        api.setCast({});
        const el = { innerText: '"You are late," Tom said quietly.', getAttribute: function () { return null; } };
        const fromWord = api.narrationBatches([el], 0, 1, false, 'You are late," Tom said quietly.')[0];
        eq('read from the first word inside a quotation keeps the cue',
            fromWord.map(p => cueInstruction(p, true, '').instruction), ['quietly']);
        eq('and starts at that word, with its opening mark', fromWord.map(p => p.text), ['"You are late," Tom said quietly.']);
        const fromTom = api.narrationBatches([el], 0, 1, false, 'Tom said quietly.')[0];
        eq('read from after the quotation starts there', fromTom.map(p => p.text), ['Tom said quietly.']);
    }
    api.setCast({ anna: 'qwen-ryan' });
}
check('cues off sends no direction',
    /direction: cuesOn && stock \? dir : ''/.test(src));
check('reading and Try it both pass the standing instruction',
    /cueInstruction\(p, _narrDirect, _narrInstruction\)/.test(src)
    && /cueInstruction\(p, !!o\.direct, o\.instruction\)/.test(src));

console.log(failed ? 'NARRATION-TAGS FAILED (' + failed + ' of ' + (passed + failed) + ')'
                   : 'NARRATION-TAGS PASSED (' + passed + ')');
process.exitCode = failed ? 1 : 0;
