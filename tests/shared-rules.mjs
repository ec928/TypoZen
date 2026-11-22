/**
 * The page's shared rules, for selftests that build a sandbox from extracted functions.
 *
 * Those selftests pull named functions out of js/modules and run them with new Function, so
 * a rule kept once in 01-core.js -- the code-fence rule, tzFence* -- is not in their sandbox
 * and the extracted functions fail with "tzFenceOpen is not defined". Importing this module
 * defines those rules on globalThis, read from 01-core.js itself so they cannot drift from
 * what the app runs. Not a suite: listed with the helpers in run-gate.mjs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = fs.readFileSync(path.join(here, '..', 'js', 'modules', '01-core.js'), 'utf8');

function extract(name) {
    const start = core.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('shared-rules: ' + name + ' is not in 01-core.js');
    let depth = 0;
    for (let i = core.indexOf('{', start); i < core.length; i++) {
        if (core[i] === '{') depth++;
        else if (core[i] === '}') { depth--; if (depth === 0) return core.slice(start, i + 1); }
    }
    throw new Error('shared-rules: ' + name + ' is not closed');
}

// The constants the rules are made of, one line each in 01-core.js.
function extractConst(name) {
    const m = new RegExp('const ' + name + ' = [^\\n]*;').exec(core);
    if (!m) throw new Error('shared-rules: const ' + name + ' is not in 01-core.js');
    return m[0];
}
export const SHARED_CONSTS = ['TZ_MARKER_PREFIX_RE', 'TZ_STARTS_WITH_MARKER_RE'];
export const SHARED_RULES = ['tzFenceOpen', 'tzFenceClose', 'tzFenceRaw', 'tzFenceRawClosed', 'tzFenceLineStates', 'tzFenceAt',
    'tzMarkerPrefix', 'tzStartsWithMarker'];
const all = SHARED_CONSTS.concat(SHARED_RULES);
const made = new Function(SHARED_CONSTS.map(extractConst).join('\n') + '\n' + SHARED_RULES.map(extract).join('\n')
    + '\nreturn { ' + all.join(', ') + ' };')();
for (const n of all) globalThis[n] = made[n];
