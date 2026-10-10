/**
 * What each narrator is told (instruction() in tools/qwen-narrator/sidecar.py and
 * tools/breeze-narrator/sidecar.py, and Breeze's translate() for span tags). The functions
 * are taken from the source and run in Python on their own: no model is loaded.
 *
 * An empty cast box is no instruction, as an empty narrator box is; a cue is the reader's
 * cue wording on its own. Two instructions are joined as two sentences, never run together.
 * Both engines are told the same.
 *
 *   node tests/narrator-instruction-selftest.mjs
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.join(here, '..', 'tools');
const WORDING = 'Voice the lines in quotation marks as {cue}.';

// [name, style, direction, role, whole, cue, own], run through both engines.
const cases = [
    ['empty box, no cue', '', '', 'dialogue', '', '', ''],
    ['empty box, no cue, narrator box filled', '', '', 'dialogue', 'Read it plainly.', '', ''],
    ['empty box, punctuation cue', '', 'breaking off', 'dialogue', '', WORDING, ''],
    ['empty box, cue, default wording', '', 'emphatic', 'dialogue', '', '', ''],
    ['empty box, thought', '', 'thought', 'dialogue', '', '', ''],
    ['cast box, no cue', '', '', 'dialogue', '', '', 'gruff and slow'],
    ['no Narrator Manager settings sent', '', '', 'dialogue', null, '', ''],
    ['cast box without a full stop, cue', '', 'breaking off', 'dialogue', '', WORDING, 'Speak softly'],
    ['cast box ending in !, cue', '', 'breaking off', 'dialogue', '', WORDING, 'Speak up!'],
    ['narrator box without a full stop, cue', '', 'emphatic', 'narration', 'Read it plainly', WORDING, null],
    ['narrator box with a full stop, cue', '', 'emphatic', 'narration', 'Read it plainly.', WORDING, null],
    ['narrator box without a full stop, thought', '', 'thought', 'narration', 'Read it plainly', '', null],
];
// Breeze: the instruction after a span tag, for each instruction before it.
const spans = ['Read it plainly', 'Read it plainly.', 'Read it plainly!', 'Read it plainly, quietly', ''];

const py = `
import ast, json, re, sys
def load(path):
    tree = ast.parse(open(path, encoding='utf-8').read())
    ns = {'re': re}
    want = {'instruction', 'sentence_join', 'translate', 'clamp_strength'}
    for node in tree.body:
        if isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) and t.id.isupper() for t in node.targets):
            try: exec(compile(ast.Module([node], []), path, 'exec'), ns)
            except Exception: pass
        for sub in (node.body if isinstance(node, ast.ClassDef) else [node]):
            if isinstance(sub, ast.FunctionDef) and sub.name in want:
                sub.decorator_list = []
                exec(compile(ast.Module([sub], []), path, 'exec'), ns)
    return ns
q = load(sys.argv[1])
b = load(sys.argv[2])
data = json.loads(sys.stdin.read())
print(json.dumps({
    'cases': [[q['instruction'](*c[1:]), b['instruction'](*c[1:])] for c in data['cases']],
    'spans': [[part[1] for part in b['translate']('Hello there. [sad] It is over.', t)] for t in data['spans']],
}))
`;
const r = spawnSync('python', ['-I', '-c', py, path.join(tools, 'qwen-narrator', 'sidecar.py'), path.join(tools, 'breeze-narrator', 'sidecar.py')],
    { input: JSON.stringify({ cases, spans }), encoding: 'utf8', timeout: 20000 });
if (r.error || r.status !== 0) {
    console.log('NARRATOR-INSTRUCTION FAILED: python did not run   ' + (r.error ? r.error.message : r.stderr));
    process.exit(1);
}
const got = JSON.parse(r.stdout);
let failed = 0, passed = 0;
const eq = (name, a, want) => {
    const ok = JSON.stringify(a) === JSON.stringify(want);
    if (ok) passed++; else failed++;
    console.log((ok ? '  OK    ' : '  FAIL  ') + name + (ok ? '' : '   got ' + JSON.stringify(a) + ', want ' + JSON.stringify(want)));
};
const told = name => got.cases[cases.findIndex(c => c[0] === name)][0];
const THOUGHT = "This passage is a character's private thought: read it quieter and more inward.";

for (const [i, c] of cases.entries()) eq('both engines agree: ' + c[0], got.cases[i][1], got.cases[i][0]);
eq('an empty cast box is no instruction', told('empty box, no cue'), '');
eq('the narrator box does not reach a voiced character', told('empty box, no cue, narrator box filled'), '');
eq('a cue on an empty box is the cue wording alone', told('empty box, punctuation cue'), 'Voice the lines in quotation marks as breaking off.');
eq('with the default wording too', told('empty box, cue, default wording'), 'Voice the lines in quotation marks as emphatic.');
eq('a cast box is sent as written', told('cast box, no cue'), 'gruff and slow');
eq('a thought on an empty box is the thought wording alone', told('empty box, thought'), THOUGHT);
eq('a cue after a cast box with no full stop starts a new sentence', told('cast box without a full stop, cue'),
    'Speak softly. Voice the lines in quotation marks as breaking off.');
eq('a box that already ends a sentence keeps its own mark', told('cast box ending in !, cue'),
    'Speak up! Voice the lines in quotation marks as breaking off.');
eq('the narrator box is joined the same way', told('narrator box without a full stop, cue'),
    'Read it plainly. Voice the lines in quotation marks as emphatic.');
eq('a box with its full stop is sent as before', told('narrator box with a full stop, cue'),
    'Read it plainly. Voice the lines in quotation marks as emphatic.');
eq('the thought wording is joined the same way', told('narrator box without a full stop, thought'), 'Read it plainly. ' + THOUGHT);
eq('Breeze: a span tag after each instruction is its own sentence', got.spans.map(s => s[1]), [
    'Read it plainly. Now sad.', 'Read it plainly. Now sad.', 'Read it plainly! Now sad.', 'Read it plainly, quietly. Now sad.', 'sad']);
console.log(failed ? 'NARRATOR-INSTRUCTION FAILED (' + failed + ' of ' + (passed + failed) + ')'
                   : 'NARRATOR-INSTRUCTION PASSED (' + passed + ')');
process.exitCode = failed ? 1 : 0;
