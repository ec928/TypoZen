/**
 * The user guide for narration is true, word for word.
 *
 * Every example the README section "Characters, voices and directing a line" and Help > Narration
 * show a user is checked twice: that it is printed there exactly, and that reading it through the
 * page's own entry point (narrationBatches, the path Read Aloud takes) does what the guide says.
 * Plus the promise the guide makes as a whole: one bracket notation -- the guide never teaches
 * [[...]], and [...] and [[...]] give the same result wherever they are written.
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
    'return { narrationBatches, setCast: c => { _narrCast = c; }, setModel: m => { DocumentModel = m; } };'
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
function read(paras, { cast = CAST, epub = false } = {}) {
    api.setCast(cast);
    api.setModel({ kind: epub ? 'epub' : 'markdown', blocks: [] });
    const els = paras.map(t => ({ innerText: t, getAttribute: () => null }));
    return api.narrationBatches(els, 0, 4).flat().map(p => {
        const c = cueInstruction(p, true, '');
        return [p.voice || 'narrator', p.text, c.instruction || (c.direction ? 'cue: ' + c.direction : '')];
    });
}
const voices = r => r.filter(p => p[0] !== 'narrator').map(p => p[0]);
const told = (r, voice) => r.filter(p => p[0] === voice).map(p => p[2]);
const html = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// [example as printed, where it is printed, the paragraphs read, how, what the guide promises]
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
    ['‘We have to go,’ Tom said.', 'readme', null, {}, r => voices(r).join() === 'TOM'],
    ['**Mr Bennet** and **Mrs Bennet** are two characters', 'readme', ['"Yes," said Mr Bennet.', '"No," said Mrs Bennet.'],
        { cast: { 'mr bennet': 'MR', 'mrs bennet': 'MRS' } }, r => voices(r).join() === 'MR,MRS'],
    // Directing a line: one rule, wherever it is in the quote's sentence
    ['[shouts loudly] "Get out!" Anna said.', 'both', null, {},
        r => told(r, 'ANNA').join() === 'shouts loudly' && r.every(p => p[1].indexOf('shouts') < 0)],
    ['"Get out!" Anna [shouts loudly] said.', 'readme', null, {},
        r => told(r, 'ANNA').join() === 'shouts loudly' && r.every(p => p[1].indexOf('shouts') < 0)],
    ['"[shouts loudly] Get out!" Anna said.', 'readme', null, {},
        r => told(r, 'ANNA').join() === 'shouts loudly' && r.every(p => p[1].indexOf('shouts') < 0)],
    ['[Read it plainly. Speak softly]', 'readme', ['[Read it plainly. Speak softly] "Go," Tom said.'], {},
        r => told(r, 'TOM').join() === 'Read it plainly. Speak softly'],
    ['[measured and quiet] The door opened.', 'both', null, {},
        r => r.length === 1 && r[0][1] === 'The door opened.' && r[0][2] === 'measured and quiet'],
    ['[shouts:9] "Get out!" Anna said.', 'readme', null, {}, r => told(r, 'ANNA').join() === 'shouts:9'],
    // Built-in tags are performed, not followed
    ['[laughing] "Stop it," Anna said.', 'both', null, {},
        r => r.some(p => p[0] === 'ANNA' && p[1].indexOf('[laughing]') >= 0 && p[2] === '')],
    // Emotion cues colour the quote only
    ['"Go," she whispered.', 'both', null, { cast: {} }, r => r.length === 1 && r[0][2] === 'cue: whispered'],
    // In an ePub, brackets are the book's text
    ['In an ePub,', 'readme', ['[shouts loudly] "Get out!" Anna said.'], { epub: true },
        r => r.some(p => p[1].indexOf('[shouts loudly]') >= 0) && r.every(p => p[2].indexOf('shouts') < 0)],
];

console.log('--- each example is printed in the guide, and does what the guide says');
for (const [example, where, paras, how, promise] of examples) {
    if (where === 'readme' || where === 'both') check('README shows ' + example, guide.indexOf(example) >= 0);
    if (where === 'both') check('Help shows ' + example, help.indexOf(example) >= 0 || help.indexOf(html(example)) >= 0);
    const result = read(paras || [example], how);
    check('it does what the guide says: ' + example, promise(result), JSON.stringify(result));
}

console.log('--- one notation');
check('the README guide never teaches [[...]]', guide.indexOf('[[') < 0, (guide.match(/.{0,40}\[\[.{0,40}/g) || []).join(' | '));
check('Help > Narration never teaches [[...]]', help.indexOf('[[') < 0, (help.match(/.{0,40}\[\[.{0,40}/g) || []).join(' | '));
for (const line of ['[shouts loudly] "Get out!" Anna said.', '"Get out!" Anna [shouts loudly] said.', '"[shouts loudly] Get out!" Anna said.',
                    '[measured and quiet] The door opened.', '[shouts:9] "Get out!" Anna said.']) {
    for (const how of [{}, { cast: {} }]) {
        const single = read([line], how), double = read([line.replace(/\[([^\]]+)\]/, '[[$1]]')], how);
        check((how.cast ? 'no cast' : 'voiced') + ': [x] and [[x]] give the same result -- ' + line,
            JSON.stringify(single) === JSON.stringify(double), JSON.stringify(single) + ' vs ' + JSON.stringify(double));
    }
}

console.log(failed ? 'NARRATION-GUIDE FAILED (' + failed + ' of ' + (passed + failed) + ')'
                   : 'NARRATION-GUIDE PASSED (' + passed + ')');
process.exitCode = failed ? 1 : 0;
