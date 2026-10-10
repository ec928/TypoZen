/**
 * The user guide for narration is true, word for word.
 *
 * Every example the README section "Characters, voices and directing a line" and Help > Narration
 * show a user is checked twice: that it is printed there exactly, and that reading it through the
 * page's own entry point (narrationBatches, the path Read Aloud takes) does what the guide says.
 * The rules are the README's: a bracket inside a quote directs that quote, outside quotes the narrator,
 * each until the next one or the end of the quote or paragraph; [words] are added to the voice's
 * instruction and the cue words follow, [[words]] replace both; built-in tags are performed; ePub
 * brackets are text.
 *
 * When the rules change, this fails until the guide says the new thing.
 *
 *   node tests/narration-guide-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = fs.readFileSync(path.join(root, 'js', 'modules', '09-speech.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const template = fs.readFileSync(path.join(root, 'TypoZen_Template.html'), 'utf8').replace(/\r\n/g, '\n');
const guide = readme.slice(readme.indexOf('### Characters, voices and directing a line'), readme.indexOf('## Files & Export'));
const help = template.slice(template.indexOf('id="narrHelpModal"'), template.indexOf('id="narrHelpOk"'));
if (guide.length < 1000 || help.length < 1000) throw new Error('guide or help section not found');

const start = src.indexOf('const NARRATION_PIECE_CAP');
const at = src.indexOf('function narrationBatches');
let i = src.indexOf('{', at), depth = 0, end = -1;
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i; break; } }
const box = { model: null };
const api = new Function('document', 'window', 'box', [
    'let DocumentModel = box.model; let _narrCast = {}; let _narrCastSay = {}; const NARRATION_BATCH = 8; function narrLog() {}',
    src.slice(start, end + 1),
    'return { narrationBatches, setCast: c => { _narrCast = c; }, setSay: c => { _narrCastSay = c; }, setModel: m => { DocumentModel = m; } };'
].join('\n'))({ querySelectorAll() { return []; } }, { chrome: { webview: { postMessage() {} } } }, box);
const ci = src.indexOf('function cueInstruction');
let j = src.indexOf('{', ci), d2 = 0, e2 = -1;
for (; j < src.length; j++) { if (src[j] === '{') d2++; else if (src[j] === '}' && --d2 === 0) { e2 = j; break; } }
const cueInstruction = new Function(src.slice(ci, e2 + 1) + '\nreturn cueInstruction;')();

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
    if (ok) passed++; else failed++;
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '\n         ' + detail));
};

const CAST = { tom: 'TOM', anna: 'ANNA', jill: 'JILL', paul: 'PAUL' };
// Read paragraphs as Read Aloud does; each piece as [voice, text spoken, what it is told].
function read(paras, { cast = CAST, epub = false, say = {}, box = '' } = {}) {
    api.setCast(cast);
    api.setSay(say);
    api.setModel({ kind: epub ? 'epub' : 'markdown', blocks: [] });
    const els = paras.map(t => ({ innerText: t, getAttribute: () => null }));
    return api.narrationBatches(els, 0, 4).flat().map(p => {
        const c = cueInstruction(p, true, box);
        // The narrator's box is what the narrator process uses when a piece brings no instruction.
        return [p.voice || 'narrator', p.text, c.instruction || (c.direction ? 'cue: ' + c.direction : (p.role === 'dialogue' ? '' : box))];
    });
}
const voices = r => r.filter(p => p[0] !== 'narrator').map(p => p[0]);
const told = (r, voice) => r.filter(p => p[0] === voice).map(p => p[2]);
const html = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// [example as printed, where it is printed, the paragraphs read, how, what the guide promises]
const GRUFF = { say: { tom: 'gruff and slow' } };
const MEASURED = { say: { tom: 'gruff and slow' }, box: 'measured' };
const examples = [
    // Who reads a line of dialogue
    ['"Go," Tom said.', 'both', null, {}, r => voices(r).join() === 'TOM'],
    ['Tom asked, "Where?"', 'readme', null, {}, r => voices(r).join() === 'TOM'],
    ['"Go," said Tom.', 'readme', null, {}, r => voices(r).join() === 'TOM'],
    ['"Go," Jill told Paul.', 'readme', null, {}, r => voices(r).join() === 'JILL'],
    ['Tom turned to Anna. "We have to go."', 'both', null, {}, r => voices(r).join() === 'TOM'],
    ['Anna stood up. "Go," she said.', 'both', null, {}, r => voices(r).join() === 'ANNA'],
    ['"Go," she told Tom.', 'both', null, {}, r => voices(r).length === 0],
    ['"How are you?"', 'readme', ['"Hello," Tom said.', '"Hi," Anna said.', '"How are you?"'], {}, r => voices(r).join() === 'TOM,ANNA,TOM'],
    ['**Mr Bennet** and **Mrs Bennet** are two characters', 'readme', ['"Yes," said Mr Bennet.', '"No," said Mrs Bennet.'],
        { cast: { 'mr bennet': 'MR', 'mrs bennet': 'MRS' } }, r => voices(r).join() === 'MR,MRS'],
    // The two rules, on the README's worked example: Tom's box is "gruff and slow", the narrator's "measured"
    ['`"Go," Tom said.` | `gruff and slow` | `measured`', 'readme', ['"Go," Tom said.'], MEASURED,
        r => told(r, 'TOM').join() === 'gruff and slow' && told(r, 'narrator').join() === 'measured'],
    ['`"Go," Tom said quietly.` | `gruff and slow, quietly` | `measured`', 'readme', ['"Go," Tom said quietly.'], MEASURED,
        r => told(r, 'TOM').join() === 'gruff and slow, quietly' && told(r, 'narrator').join() === 'measured'],
    ['`"[angrily] Go," Tom said quietly.` | `gruff and slow, angrily, quietly` | `measured`', 'readme', ['"[angrily] Go," Tom said quietly.'], MEASURED,
        r => told(r, 'TOM').join() === 'gruff and slow, angrily, quietly' && told(r, 'narrator').join() === 'measured'],
    ['`"[[angrily]] Go," Tom said quietly.` | `angrily` | `measured`', 'readme', ['"[[angrily]] Go," Tom said quietly.'], MEASURED,
        r => told(r, 'TOM').join() === 'angrily' && told(r, 'narrator').join() === 'measured'],
    ['`"[angrily] Get out. [softly] Please," Tom said.` | `gruff and slow, angrily` for *Get out.*, then `gruff and slow, softly` for *Please,* | `measured`', 'readme',
        ['"[angrily] Get out. [softly] Please," Tom said.'], MEASURED,
        r => JSON.stringify(r.filter(p => p[0] === 'TOM').map(p => [p[1], p[2]])) === JSON.stringify([['Get out.', 'gruff and slow, angrily'], ['Please,', 'gruff and slow, softly']])
            && told(r, 'narrator').join() === 'measured'],
    ['`[angrily] "Go," Tom said.` | `gruff and slow` | `measured, angrily` — the bracket is outside the quote', 'readme', ['[angrily] "Go," Tom said.'], MEASURED,
        r => told(r, 'TOM').join() === 'gruff and slow' && told(r, 'narrator').join() === 'measured, angrily'],
    ['`"Go," Tom [wearily] said.` | `gruff and slow` | `measured, wearily`', 'readme', ['"Go," Tom [wearily] said.'], MEASURED,
        r => told(r, 'TOM').join() === 'gruff and slow' && told(r, 'narrator').join() === 'measured, wearily'],
    ['`[slowly] The door opened. "Go," Tom said.` | `gruff and slow` | `measured, slowly`, for *The door opened.* and *Tom said.*', 'readme',
        ['[slowly] The door opened. "Go," Tom said.'], MEASURED,
        r => told(r, 'TOM').join() === 'gruff and slow' && told(r, 'narrator').join('|') === 'measured, slowly|measured, slowly'],
    ['`[[slowly]] The door opened. "Go," Tom said.` | `gruff and slow` | `slowly`, for both', 'readme',
        ['[[slowly]] The door opened. "Go," Tom said.'], MEASURED,
        r => told(r, 'TOM').join() === 'gruff and slow' && told(r, 'narrator').join('|') === 'slowly|slowly'],
    // Ed's example: each instruction runs to the next one, or to the end of its quote or paragraph
    ['`[steady, whisper] Anna said "[Angry] I am mad at you. [Softly] But I forgive you anyway." [excited, loud] Surprising even herself.`', 'readme',
        ['[steady, whisper] Anna said "[Angry] I am mad at you. [Softly] But I forgive you anyway." [excited, loud] Surprising even herself.'], { box: 'measured' },
        r => JSON.stringify(r.map(p => [p[0], p[2]])) === JSON.stringify([['narrator', 'measured, steady, whisper'], ['ANNA', ''], ['ANNA', 'Softly'], ['narrator', 'measured, excited, loud']])
            && r[1][1].indexOf('[Angry]') === 0],
    // A character with no voice: the quote's own bracket, else the narrator's
    ['`[slowly] The door opened. "Go," Mara said.` is all `measured, slowly`', 'readme', ['[slowly] The door opened. "Go," Mara said.'], { box: 'measured' },
        r => r.length === 1 && r[0][2] === 'measured, slowly'],
    ['Brackets side by side are one instruction: two singles are both added, in order; a double overrides them.', 'readme',
        ['"[angrily] [softly] Go," Tom said.', '"[angrily] [[shouts]] Go," Tom said.'], GRUFF,
        r => told(r, 'TOM').join('|') === 'gruff and slow, angrily, softly|shouts'],
    ['[Read it plainly. Speak softly]', 'readme', ['"[Read it plainly. Speak softly] Go," Tom said.'], {},
        r => told(r, 'TOM').join() === 'Read it plainly. Speak softly'],
    ['"[shouts:9] Get out!"', 'readme', ['"[shouts:9] Get out!" Anna said.'], {}, r => told(r, 'ANNA').join() === 'shouts:9, emphatic'],
    ['[shouts:9]', 'help', ['"[shouts:9] Get out!" Anna said.'], {}, r => told(r, 'ANNA').join() === 'shouts:9, emphatic'],
    ['`(giggles)`, are not tags: they are sent to the narrator as written', 'readme', ['"[softly] I forgive you (giggles)," Anna said.'], {},
        r => r.some(p => p[0] === 'ANNA' && p[1].indexOf('(giggles)') >= 0)],
    ['"[shouts loudly] Get out!" Anna said.', 'help', null, {}, r => told(r, 'ANNA').join() === 'shouts loudly, emphatic'],
    ['[measured and quiet] The door opened.', 'help', null, {}, r => r.length === 1 && r[0][2] === 'measured and quiet'],
    // Built-in tags are performed, single or double
    ['"[laughing] Stop it," Anna said.', 'help', ['"[laughing] Stop it," Anna said.', '"[[laughing]] Stop it," Anna said.'], {},
        r => r.filter(p => p[0] === 'ANNA').length === 2 && r.filter(p => p[0] === 'ANNA').every(p => p[1].indexOf('[laughing]') >= 0 && p[2] === '')],
    // Emotion cues colour the quote only
    ['"Go," she whispered.', 'both', null, { cast: {} }, r => r.length === 1 && r[0][2] === 'cue: whispered'],
    // In an ePub, brackets are the book's text
    ['any other brackets are read aloud as part of the text', 'readme', ['[angrily] "Go," Tom said.'], { epub: true },
        r => r.some(p => p[1].indexOf('[angrily]') >= 0) && r.every(p => p[2].indexOf('angrily') < 0)],
];

console.log('--- each example is printed in the guide, and does what the guide says');
for (const [example, where, paras, how, promise] of examples) {
    if (where === 'readme' || where === 'both') check('README shows ' + example, guide.indexOf(example) >= 0);
    if (where === 'help' || where === 'both') check('Help shows ' + example, help.indexOf(example) >= 0 || help.indexOf(html(example)) >= 0);
    const result = read(paras || [example], how);
    check('it does what the guide says: ' + example, promise(result), JSON.stringify(result));
}

console.log(failed ? 'NARRATION-GUIDE FAILED (' + failed + ' of ' + (passed + failed) + ')'
                   : 'NARRATION-GUIDE PASSED (' + passed + ')');
process.exitCode = failed ? 1 : 0;
