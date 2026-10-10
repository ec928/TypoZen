/**
 * Read Aloud on a selection follows the same rules as reading through: the pieces narrateSelection
 * sends must be the paragraph path's. It used to send the selection as written -- brackets read
 * aloud, every quotation to the narrator (2026-10-10).
 *
 *   node tests/narration-selection-selftest.mjs
 */
import fs from 'fs';
const src = fs.readFileSync(process.argv[2] || new URL('../js/modules/09-speech.js', import.meta.url), 'utf8');
const body = name => { const a = src.indexOf(name); let i = src.indexOf('{', a), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(a, i + 1); } };
const start = src.indexOf('const NARRATION_PIECE_CAP'), at = src.indexOf('function narrationBatches');
const slice = src.slice(start, at) + body('function narrationBatches');
const sel = body('async function narrateSelection');
const stubs = `var _narrationReading = 0, _narrationBase, _narrActive, _narrSilentSince, sent = [];
function readingBlocks() { return []; } function narrationDocIndex() { return 0; }
function narrWait() {} function narrWaitEnd() {} function narrPhase() {} function startReadingChunks() {}
function showKokoroStatus() {} function batchRenderEstimate() { return 0; }
async function renderNarration(b, batch) { sent.push(...batch); return [1]; }`;
const api = new Function('document', 'window', ['let DocumentModel = null; let _narrCast = {}; let _narrCastSay = {}; const NARRATION_BATCH = 8; function narrLog() {}',
  slice, stubs, sel,
  'return { narrateSelection, narrationBatches, sent: () => sent.splice(0), setCast: c => { _narrCast = c; }, setModel: m => { DocumentModel = m; } };'].join('\n'))(
  { querySelectorAll() { return []; }, getElementById() { return null; } }, { chrome: { webview: { postMessage() {} } }, __narrLog: [] });
const lines = ['[[say "hush" softly]] "Wait—" Anna said.', '"Wait—" Anna said [[Read it plainly. Speak softly]].', 'End test 1'];
const show = ps => ps.map(p => `  ${(p.voice || 'N').padEnd(5)} ${JSON.stringify(p.text)}  instr=${JSON.stringify(p.instruction || '')}${p.soft ? ' soft' : ''}`).join('\n');
let bad = 0;
for (const [label, cast, model] of [['no cast', {}, 'markdown'], ['Anna voiced', { anna: 'ANNA' }, 'markdown'], ['ePub, Anna voiced', { anna: 'ANNA' }, 'epub']]) {
  api.setCast(cast); api.setModel({ kind: model, blocks: [] });
  await api.narrateSelection('http://x', { el: null, text: lines.join('\n') });
  const s = api.sent();
  const p = api.narrationBatches(lines.map(t => ({ innerText: t, getAttribute() { return null; } })), 0, 4).flat();
  const key = ps => JSON.stringify(ps.map(x => [x.voice || '', x.text, x.instruction || '', !!x.soft, x.direction || '']));
  if (key(s) !== key(p)) { bad++; console.log(`FAIL ${label}: the selection differs from the paragraph path\n${show(s)}`); }
}
console.log(bad ? 'NARRATION-SELECTION FAILED (' + bad + ' of 3)' : 'NARRATION-SELECTION PASSED (3)');
process.exitCode = bad ? 1 : 0;
