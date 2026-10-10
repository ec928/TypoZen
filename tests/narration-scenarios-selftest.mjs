/**
 * How people write dialogue, against what the README requires ("Characters, voices and directing a
 * line"): who reads each piece, and what each voice is told. Includes lines from real books that
 * were read in the wrong voice.
 *
 *   node tests/narration-scenarios-selftest.mjs
 */
// Cast: Tom (box "gruff"), Anna ("bright"), Jill ("calm"); Mara has no voice. Narrator box "measured". Emotion cues on.
// Each piece is [voice, told]; told is what the narrator process ends up with ("x | cue: y" when a cue is wrapped).
import fs from 'fs';
const src = fs.readFileSync(new URL('../js/modules/09-speech.js', import.meta.url), 'utf8');
const start = src.indexOf('const NARRATION_PIECE_CAP'), at = src.indexOf('function narrationBatches');
let i = src.indexOf('{', at), d = 0, end = -1;
for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) { end = i; break; } }
const box0 = { model: null };
const api = new Function('document', 'window', 'box', ['let DocumentModel = box.model; let _narrCast = {}; let _narrCastSay = {}; const NARRATION_BATCH = 8; function narrLog() {}', src.slice(start, end + 1),
  'return { narrationBatches, setCast: c => { _narrCast = c; }, setSay: c => { _narrCastSay = c; }, setModel: m => { DocumentModel = m; } };'].join('\n'))(
  { querySelectorAll() { return []; } }, { chrome: { webview: { postMessage() {} } } }, box0);
const ci = src.indexOf('function cueInstruction');
let j = src.indexOf('{', ci), d2 = 0, e2 = -1;
for (; j < src.length; j++) { if (src[j] === '{') d2++; else if (src[j] === '}' && --d2 === 0) { e2 = j; break; } }
const cue = new Function(src.slice(ci, e2 + 1) + '\nreturn cueInstruction;')();
api.setCast({ tom: 'TOM', anna: 'ANNA', jill: 'JILL', elizabeth: 'ELIZABETH', collins: 'COLLINS', 'mrs gardiner': 'MRS GARDINER', gardiner: 'GARDINER', jessica: 'JESSICA' });
api.setSay({ tom: 'gruff', anna: 'bright', jill: 'calm', elizabeth: 'clear' });
api.setModel({ kind: 'markdown', blocks: [] });
const NB = 'measured';
function read(paras) {
  const els = paras.map(t => ({ innerText: t, getAttribute() { return null; } }));
  return api.narrationBatches(els, 0, 4).flat().map(p => {
    const c = cue(p, true, NB);
    let told = c.instruction || (p.role === 'dialogue' ? '' : NB);
    if (c.direction) told += ' | cue: ' + c.direction;
    return { voice: p.voice || 'N', text: p.text, told };
  });
}
// [paragraphs, expected [voice, told] per piece (only pieces listed are compared, in order)]
const S = [
  [['"Go," Tom said.'], [['TOM', 'gruff'], ['N', NB]]],
  [['"Go," said Tom.'], [['TOM', 'gruff'], ['N', NB]]],
  [['Tom said, "Go."'], [['N', NB], ['TOM', 'gruff']]],
  [['"Wait," Tom said, "not yet."'], [['TOM', 'gruff'], ['N', NB], ['TOM', 'gruff']]],
  [['"Go," Tom said quietly.'], [['TOM', 'gruff, quietly'], ['N', NB]]],
  [['"Go," Tom whispered.'], [['TOM', 'gruff, whispered'], ['N', NB]]],
  [['"Late," Tom said. "I know," Anna replied.'], [['TOM', 'gruff'], ['N', NB], ['ANNA', 'bright'], ['N', NB]]],
  [['"Late," Tom said angrily. "I know," Anna replied softly.'], [['TOM', 'gruff, angrily'], ['N', NB], ['ANNA', 'bright, softly'], ['N', NB]]],
  [['[angrily] "Late," Tom said. [softly] "I know," Anna replied.'], [['TOM', 'gruff, angrily'], ['N', NB], ['ANNA', 'bright, softly'], ['N', NB]]],
  [['[[wearily]] The rain fell. [angrily] "Late," Tom said. [[softly]] "I know," Anna replied.'],
    [['N', 'wearily'], ['TOM', 'gruff, angrily'], ['N', 'wearily'], ['ANNA', 'softly'], ['N', 'wearily']]],
  [['"Late," [angrily] Tom said.'], [['TOM', 'gruff'], ['N', NB + ', angrily']]],
  [['"Go," Tom said [wearily].'], [['TOM', 'gruff'], ['N', NB + ', wearily']]],
  [['"Go," Tom said. [sadly]'], [['TOM', 'gruff'], ['N', NB + ', sadly']]],
  [['Tom [angrily] said, "Go."'], [['N', NB + ', angrily'], ['TOM', 'gruff']]],
  [['Anna [hushed], "Go."'], [['N', NB], ['ANNA', 'bright, hushed']]],
  [['Anna [whispers], "Go."'], [['N', NB], ['ANNA', 'bright']]],
  [['"[laughing] Stop it," Anna said.'], [['ANNA', 'bright'], ['N', NB]]],
  [['"Stop it," Anna said [laughing].'], [['ANNA', 'bright'], ['N', NB]]],
  [['[angrily] [softly] "Go," Tom said.'], [['TOM', 'gruff, angrily, softly'], ['N', NB]]],
  [['[angrily] [[shouts]] "Go," Tom said.'], [['TOM', 'shouts'], ['N', NB]]],
  [['"Hello!" Anna said.'], [['ANNA', 'bright | cue: emphatic'], ['N', NB]]],
  [['"Wait—" Anna said.'], [['ANNA', 'bright | cue: breaking off'], ['N', NB]]],
  [['Tom turned to Anna. "We have to go."'], [['N', NB], ['TOM', 'gruff']]],
  [['Anna stood up. "Go," she said.'], [['N', NB], ['ANNA', 'bright'], ['N', NB]]],
  [['"Go," she told Tom.'], [['N', NB]]],
  [['Tom looked at Anna. "Go," she said.'], [['N', NB]]],
  [['"Go," he said, turning to Anna.'], [['N', NB + ' | cue: turning']]],
  [['"Go," Anna said, and Tom nodded.'], [['ANNA', 'bright'], ['N', NB]]],
  [['"Go," Tom said to Anna.'], [['TOM', 'gruff'], ['N', NB]]],
  [['"Go," Tom told her quietly.'], [['TOM', 'gruff, quietly'], ['N', NB]]],
  [['Anna said, "Tom, wait!"'], [['N', NB], ['ANNA', 'bright | cue: emphatic']]],
  [['"Tom!" Anna shouted.'], [['ANNA', 'bright, shouted'], ['N', NB]]],
  [['"I am not going," Tom said, turning to Anna, "and you cannot make me."'], [['TOM', 'gruff, turning'], ['N', NB], ['TOM', 'gruff, turning']]],
  [['"Go," Tom said. "Now," Anna said. "Fine," Jill said.'], [['TOM', 'gruff'], ['N', NB], ['ANNA', 'bright'], ['N', NB], ['JILL', 'calm'], ['N', NB]]],
  [['"Hello," Tom said.', '"Hi," Anna said.', '"How are you?"'], [['TOM', 'gruff'], ['N', NB], ['ANNA', 'bright'], ['N', NB], ['TOM', 'gruff']]],
  [['[sadly]', '"Go," Tom said.'], [['TOM', 'gruff'], ['N', NB]]],
  [['"Go," Mara said.'], [['N', NB]]],
  [['[angrily] "Go," Mara said.'], [['N', NB + ', angrily'], ['N', NB]]],
  [['[sadly] The door opened. "Go," Mara said.'], [['N', NB + ', sadly'], ['N', NB + ', sadly'], ['N', NB + ', sadly']]],
  [['‘Go,’ Tom said. ‘Now,’ Anna said.'], [['TOM', 'gruff'], ['N', NB], ['ANNA', 'bright'], ['N', NB]]],
  [['"Go," said Mr Bennet. "No," said Mrs Bennet.'], [['N', NB]]],
  // Lines from real books that were read in the wrong voice.
  [['“Really, Mr. Collins,” cried Elizabeth with some warmth, “you puzzle me exceedingly.”'], [['ELIZABETH', 'clear, cried with some warmth'], ['N', NB], ['ELIZABETH', 'clear, cried with some warmth']]],
  [['“We have not quite determined how far it shall carry us,” said Mrs. Gardiner, “but perhaps to the Lakes.”'], [['MRS GARDINER', ''], ['N', NB], ['MRS GARDINER', '']]],
  [['“I enjoy watching the flights of birds,” the banker said, directing his words at Jessica.'], [['N', NB + ' | cue: directing his words']]],
  [['“Did you speak from your own observation,” said she, “when you told him?”'], [['N', NB]]],
];
let bad = 0;
for (const [paras, want] of S) {
  const got = read(paras);
  const g = got.map(p => [p.voice, p.told]);
  const ok = JSON.stringify(g.slice(0, want.length)) === JSON.stringify(want) && (want.length === g.length || want.length === 1 && want[0][0] === 'N' && g.every(p => p[0] === 'N'));
  if (!ok) bad++;
  console.log((ok ? 'OK   ' : 'FAIL ') + paras.join(' / '));
  if (!ok) {
    console.log('       want ' + want.map(w => w.join(': ')).join('  |  '));
    console.log('       got  ' + got.map(p => p.voice + ': ' + p.told + '  «' + p.text + '»').join('  |  '));
  }
}
console.log(bad ? 'NARRATION-SCENARIOS FAILED (' + bad + ' of ' + S.length + ')' : 'NARRATION-SCENARIOS PASSED (' + S.length + ')');
process.exitCode = bad ? 1 : 0;
