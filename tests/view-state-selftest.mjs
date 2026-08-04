/**
 * Self-test: Phase 3B view-selector auto-resolution (Mode / Column / Scroll).
 *
 * resolveViewState() is a pure function of (state, one change) -> state + lock flags, so
 * the entire rule set can be checked exhaustively rather than by clicking around. The
 * two tests that matter most are at the bottom:
 *
 *   - every reachable state is one of the combinations the spec calls valid
 *   - no state leaves the user stuck, i.e. from anywhere you can always get back to
 *     plain Preview / 1-column / Scroll using only unlocked controls
 *
 * node tests/view-state-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'TypoZen_Template_Test.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

function extractFunction(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        const c = mainScript[i];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return mainScript.slice(idx, i + 1);
    }
    throw new Error('unclosed function ' + name);
}

const names = ['resolveViewState', 'viewLocksFor', 'viewStateOf', 'defaultViewStateFor'];
let src = '';
for (const n of names) src += extractFunction(n) + '\n';
src += 'return {' + names.join(',') + '};';
const api = new Function(src)();

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function eq(got, want, msg) {
    if (got === want) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        console.error('        want: ' + JSON.stringify(want));
        console.error('        got : ' + JSON.stringify(got));
    }
}
const S = (s) => s.mode + '/' + s.columns + '/' + s.scroll +
    (s.columnsLocked ? ' [colLock]' : '') + (s.scrollLocked ? ' [scrLock]' : '');
const st = (mode, columns, scroll) => api.viewStateOf(mode, columns, scroll);

console.log('--- Initial State ---');
{
    eq(S(api.defaultViewStateFor('preview')), 'preview/1/scroll', 'Preview defaults to 1-column, Scroll');
    eq(S(api.defaultViewStateFor('reader')), 'reader/1/pagination [scrLock]',
        'Reader defaults to 1-column, Pagination');
    eq(S(api.defaultViewStateFor('source')), 'source/1/scroll [colLock] [scrLock]',
        'Source is 1-column, Scroll, both locked');
}

console.log('\n--- Rule A: Mode is master ---');
{
    // Source forces 1-column + Scroll and locks both, from any starting point.
    for (const from of [st('preview', 1, 'scroll'), st('preview', 2, 'pagination'), st('reader', 2, 'pagination')]) {
        const r = api.resolveViewState(from, { mode: 'source' });
        eq(S(r), 'source/1/scroll [colLock] [scrLock]', 'Source from ' + S(from) + ' forces 1-col + Scroll, both locked');
    }

    // Preview unlocks; it forces nothing of its own.
    const p = api.resolveViewState(st('source', 1, 'scroll'), { mode: 'preview' });
    eq(S(p), 'preview/1/scroll', 'Preview from Source unlocks both selectors');
    const p2 = api.resolveViewState(st('reader', 2, 'pagination'), { mode: 'preview' });
    eq(S(p2), 'preview/2/pagination [scrLock]',
        'Preview keeps 2-col + Pagination, and Scroll stays locked because 2 columns are showing');

    // Reader forces Pagination and locks Scroll, but leaves Columns free.
    const r1 = api.resolveViewState(st('preview', 1, 'scroll'), { mode: 'reader' });
    eq(S(r1), 'reader/1/pagination [scrLock]', 'Reader forces Pagination and locks Scroll');
    const r2 = api.resolveViewState(st('preview', 2, 'pagination'), { mode: 'reader' });
    eq(S(r2), 'reader/2/pagination [scrLock]', 'Reader leaves the Column selector unlocked');
}

console.log('\n--- Rule B: Column is master ---');
{
    const two = api.resolveViewState(st('preview', 1, 'scroll'), { columns: 2 });
    eq(S(two), 'preview/2/pagination [scrLock]', '2-Column forces Pagination and locks Scroll');

    const one = api.resolveViewState(st('preview', 2, 'pagination'), { columns: 1 });
    eq(S(one), 'preview/1/pagination', '1-Column forces nothing and unlocks Scroll in Preview');

    const readerOne = api.resolveViewState(st('reader', 2, 'pagination'), { columns: 1 });
    eq(S(readerOne), 'reader/1/pagination [scrLock]', '1-Column in Reader leaves Scroll locked, since Reader is pages only');

    // Locked means inert: Source must not accept a column change.
    const blocked = api.resolveViewState(st('source', 1, 'scroll'), { columns: 2 });
    eq(S(blocked), 'source/1/scroll [colLock] [scrLock]', 'a locked Column selector ignores clicks in Source');
}

console.log('\n--- Rule C: Scroll is master ---');
{
    const sc = api.resolveViewState(st('preview', 1, 'pagination'), { scroll: 'scroll' });
    eq(S(sc), 'preview/1/scroll', 'Scroll from 1-col Pagination stays 1-col');

    const pg = api.resolveViewState(st('preview', 1, 'scroll'), { scroll: 'pagination' });
    eq(S(pg), 'preview/1/pagination', 'Pagination forces nothing and leaves Columns unlocked');
    assert(!pg.columnsLocked, 'Pagination leaves the Column selector unlocked');

    // With 2 columns showing, Scroll is locked, so the click is inert. The way back is
    // 1-Column first (which unlocks Scroll) -- not a deadlock, just an ordering.
    const inert = api.resolveViewState(st('preview', 2, 'pagination'), { scroll: 'scroll' });
    eq(S(inert), 'preview/2/pagination [scrLock]', 'a locked Scroll selector ignores clicks while 2-col');
    const viaOneCol = api.resolveViewState(inert, { columns: 1 });
    eq(S(api.resolveViewState(viaOneCol, { scroll: 'scroll' })), 'preview/1/scroll',
        '1-Column then Scroll gets back to continuous scrolling');
}

console.log('\n--- Rule C interaction called out in the spec ---');
{
    // "If the user subsequently clicks 2-Column, Rule B will auto-resolve Scroll back."
    let s = st('preview', 2, 'pagination');
    s = api.resolveViewState(s, { columns: 1 });          // unlocks Scroll
    s = api.resolveViewState(s, { scroll: 'scroll' });    // back to scrolling
    eq(S(s), 'preview/1/scroll', 'Scroll click leaves 1-column continuous');
    s = api.resolveViewState(s, { columns: 2 });          // Rule B resolves it again
    eq(S(s), 'preview/2/pagination [scrLock]', 'clicking 2-Column again auto-resolves Scroll to Pagination');
}

console.log('\n--- every reachable state is valid ---');
{
    const VALID = new Set([
        'source/1/scroll',
        'preview/1/scroll', 'preview/1/pagination', 'preview/2/pagination',
        'reader/1/pagination', 'reader/2/pagination'
    ]);
    const key = (s) => s.mode + '/' + s.columns + '/' + s.scroll;
    const clicks = [
        { mode: 'source' }, { mode: 'preview' }, { mode: 'reader' },
        { columns: 1 }, { columns: 2 },
        { scroll: 'scroll' }, { scroll: 'pagination' }
    ];

    // Breadth-first over every state reachable by any sequence of clicks.
    const start = api.defaultViewStateFor('preview');
    const seen = new Map([[key(start), start]]);
    const queue = [start];
    let bad = null;
    while (queue.length) {
        const cur = queue.shift();
        for (const c of clicks) {
            const next = api.resolveViewState(cur, c);
            const k = key(next);
            if (!VALID.has(k) && !bad) bad = k + ' reached from ' + key(cur) + ' via ' + JSON.stringify(c);
            if (!seen.has(k)) { seen.set(k, next); queue.push(next); }
        }
    }
    assert(bad === null, 'no click sequence reaches an invalid combination' + (bad ? ' (' + bad + ')' : ''));
    assert(seen.size === VALID.size,
        'all ' + VALID.size + ' valid combinations are reachable (got ' + seen.size + ')');

    // The invalid ones the spec calls out explicitly, stated as their own checks.
    for (const k of ['preview/2/scroll', 'reader/1/scroll', 'reader/2/scroll', 'source/2/scroll', 'source/1/pagination']) {
        assert(!seen.has(k), k + ' is never reachable');
    }

    console.log('\n--- no state is a dead end ---');
    for (const [k, s] of seen) {
        // From anywhere, only-unlocked clicks must get back to plain Preview/1/Scroll.
        let cur = s;
        cur = api.resolveViewState(cur, { mode: 'preview' });
        if (cur.columns === 2) cur = api.resolveViewState(cur, { columns: 1 });
        cur = api.resolveViewState(cur, { scroll: 'scroll' });
        assert(key(cur) === 'preview/1/scroll', 'escapable back to Preview/1/Scroll from ' + k);
    }
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nVIEW STATE SELFTEST FAILED');
    process.exit(1);
}
console.log('\nVIEW STATE SELFTEST PASSED');
process.exit(0);
