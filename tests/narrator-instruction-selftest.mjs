/**
 * What each narrator is told for a voiced character's line (instruction() in
 * tools/qwen-narrator/sidecar.py and tools/breeze-narrator/sidecar.py). The functions are
 * taken from the source and run in Python on their own: no model is loaded.
 *
 * An empty cast box is no instruction, as an empty narrator box is; a cue is the reader's
 * cue wording on its own. Both engines are told the same.
 *
 *   node tests/narrator-instruction-selftest.mjs
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.join(here, '..', 'tools');

// [engine, style, direction, role, whole, cue, own] for each case, run through both engines.
const cases = [
    ['empty box, no cue', '', '', 'dialogue', '', '', ''],
    ['empty box, no cue, narrator box filled', '', '', 'dialogue', 'Read it plainly.', '', ''],
    ['empty box, punctuation cue', '', 'breaking off', 'dialogue', '', 'Voice the lines in quotation marks as {cue}.', ''],
    ['empty box, cue, default wording', '', 'emphatic', 'dialogue', '', '', ''],
    ['empty box, thought', '', 'thought', 'dialogue', '', '', ''],
    ['cast box, no cue', '', '', 'dialogue', '', '', 'gruff and slow'],
    ['no Narrator Manager settings sent', '', '', 'dialogue', null, '', ''],
];
const py = `
import ast, json, re, sys
def load(path, cls):
    tree = ast.parse(open(path, encoding='utf-8').read())
    ns = {'re': re}
    for node in tree.body:
        if isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) and t.id.isupper() for t in node.targets):
            try: exec(compile(ast.Module([node], []), path, 'exec'), ns)
            except Exception: pass
        nodes = [node]
        if cls and isinstance(node, ast.ClassDef) and node.name == cls:
            nodes = node.body
        for sub in nodes:
            if isinstance(sub, ast.FunctionDef) and sub.name == 'instruction':
                sub.decorator_list = []
                exec(compile(ast.Module([sub], []), path, 'exec'), ns)
    return ns['instruction']
q = load(sys.argv[1], 'Narrator')
b = load(sys.argv[2], None)
out = []
for c in json.loads(sys.stdin.read()):
    out.append([q(*c[1:]), b(*c[1:])])
print(json.dumps(out))
`;
const r = spawnSync('python', ['-I', '-c', py, path.join(tools, 'qwen-narrator', 'sidecar.py'), path.join(tools, 'breeze-narrator', 'sidecar.py')],
    { input: JSON.stringify(cases), encoding: 'utf8', timeout: 20000 });
if (r.error || r.status !== 0) {
    console.log('NARRATOR-INSTRUCTION FAILED: python did not run   ' + (r.error ? r.error.message : r.stderr));
    process.exit(1);
}
const got = JSON.parse(r.stdout);
let failed = 0, passed = 0;
const eq = (name, a, want) => {
    const ok = a === want;
    if (ok) passed++; else failed++;
    console.log((ok ? '  OK    ' : '  FAIL  ') + name + (ok ? '' : '   got ' + JSON.stringify(a) + ', want ' + JSON.stringify(want)));
};
const told = name => got[cases.findIndex(c => c[0] === name)];
for (const [i, c] of cases.entries()) eq('both engines agree: ' + c[0], got[i][1], got[i][0]);
eq('an empty cast box is no instruction', told('empty box, no cue')[0], '');
eq('the narrator box does not reach a voiced character', told('empty box, no cue, narrator box filled')[0], '');
eq('a cue on an empty box is the cue wording alone', told('empty box, punctuation cue')[0],
    'Voice the lines in quotation marks as breaking off.');
eq('with the default wording too', told('empty box, cue, default wording')[0], 'Voice the lines in quotation marks as emphatic.');
eq('a cast box is sent as written', told('cast box, no cue')[0], 'gruff and slow');
eq('a thought on an empty box is the thought wording alone', told('empty box, thought')[0],
    "This passage is a character's private thought: read it quieter and more inward.");
console.log(failed ? 'NARRATOR-INSTRUCTION FAILED (' + failed + ' of ' + (passed + failed) + ')'
                   : 'NARRATOR-INSTRUCTION PASSED (' + passed + ')');
process.exitCode = failed ? 1 : 0;
