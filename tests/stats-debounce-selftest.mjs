/**
 * Self-test: the per-keystroke stats path must stay cheap, and must not go stale.
 *
 * Background: updateStats() serialized the entire document on every keystroke, twice
 * (getCaretLineNumber -> getTotalLineCount -> getMarkdownContent again). Measured at
 * ~19 ms per keypress on a 3000-line file, growing linearly. It is now debounced.
 *
 * Guarded here:
 *   1. A burst of keystrokes triggers ONE serialize, not one per key.
 *   2. Continuous typing still refreshes: past STATS_MAX_STALE_MS a keystroke runs
 *      the work immediately, so the word count cannot freeze while you type.
 *   3. getCaretLineNumber accepts a precomputed document and does not re-serialize.
 *   4. Document-level operations (load, undo, save_success) call updateStatsNow().
 *
 * node tests/stats-debounce-selftest.mjs
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

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

// --- 1 & 2: debounce behaviour, driven with a fake clock ---
const debounceSrc = extractFunction('updateStats');
const constMatch = mainScript.match(/const STATS_DEBOUNCE_MS = (\d+);[\s\S]*?const STATS_MAX_STALE_MS = (\d+);/);
if (!constMatch) {
    console.error('FAIL: could not read STATS_DEBOUNCE_MS / STATS_MAX_STALE_MS');
    process.exit(1);
}
const DEBOUNCE = Number(constMatch[1]);
const MAX_STALE = Number(constMatch[2]);
assert(DEBOUNCE > 0 && DEBOUNCE <= 400, 'debounce interval is sane (' + DEBOUNCE + 'ms)');
assert(MAX_STALE >= DEBOUNCE && MAX_STALE <= 2000, 'max-stale interval is sane (' + MAX_STALE + 'ms)');

function makeHarness() {
    const env = {
        now: 10000,
        runs: 0,
        timers: [],
        _statsTimer: null,
        _statsLastRun: 0,
        _contentCache: 'stale'
    };
    const factory = new Function('env', `
        let _statsTimer = null;
        let _statsLastRun = 0;
        let _contentCache = null;
        // updateStats also pings the host so "hide while typing" can react
        let _lastTypingPing = 0;
        const postMsg = () => {};
        const STATS_DEBOUNCE_MS = ${DEBOUNCE};
        const STATS_MAX_STALE_MS = ${MAX_STALE};
        const Date = { now: () => env.now };
        const setTimeout = (fn, ms) => { const t = { fn, at: env.now + ms }; env.timers.push(t); return t; };
        const clearTimeout = (t) => { const i = env.timers.indexOf(t); if (i >= 0) env.timers.splice(i, 1); };
        const updateStatsNow = () => {
            if (_statsTimer) { clearTimeout(_statsTimer); _statsTimer = null; }
            _statsLastRun = env.now;
            env.runs++;
        };
        ${debounceSrc}
        return {
            updateStats,
            fire: () => {
                const due = env.timers.filter(t => t.at <= env.now);
                env.timers = env.timers.filter(t => t.at > env.now);
                due.forEach(t => t.fn());
            },
            cacheIsNull: () => _contentCache === null
        };
    `);
    return { env, api: factory(env) };
}

console.log('--- a burst of keystrokes collapses to one serialize ---');
{
    const { env, api } = makeHarness();
    env.now = 10000;
    for (let i = 0; i < 40; i++) { env.now += 20; api.updateStats(); } // 40 keys over 800ms
    const duringBurst = env.runs;
    env.now += DEBOUNCE + 1;
    api.fire();
    assert(duringBurst <= 2, 'at most 2 serializes during a 40-key burst (got ' + duringBurst + ')');
    assert(env.runs >= 1, 'work still runs after typing stops (total ' + env.runs + ')');
    assert(env.runs < 40, '40 keystrokes did NOT cause 40 serializes');
}

console.log('--- an edit invalidates the cached serialize ---');
{
    const { api } = makeHarness();
    api.updateStats();
    assert(api.cacheIsNull(), 'content cache cleared on edit');
}

console.log('--- continuous typing still refreshes ---');
{
    const { env, api } = makeHarness();
    env.now = 10000;
    // Type for 5 seconds without ever pausing long enough to let the timer fire.
    for (let i = 0; i < 250; i++) { env.now += 20; api.updateStats(); }
    assert(env.runs >= 5, 'refreshed repeatedly during 5s of nonstop typing (got ' + env.runs + ')');
    assert(env.runs <= 20, 'but still far fewer than one per keystroke (got ' + env.runs + ')');
}

console.log('--- caret line no longer re-serializes ---');
{
    const caretSrc = extractFunction('getCaretLineNumber');
    const totalSrc = extractFunction('getTotalLineCount');
    assert(/function getCaretLineNumber\(\s*precomputedContent\s*\)/.test(caretSrc),
        'getCaretLineNumber accepts a precomputed document');
    assert(/getTotalLineCount\(\s*precomputedContent\s*\)/.test(caretSrc),
        'it forwards that document to getTotalLineCount');
    assert(/precomputedContent\s*!=\s*null\s*\?\s*precomputedContent/.test(totalSrc),
        'getTotalLineCount uses it instead of serializing again');

    const statsNowSrc = extractFunction('updateStatsNow');
    assert(/getCaretLineNumber\(\s*content\s*\)/.test(statsNowSrc),
        'updateStatsNow passes its serialize to getCaretLineNumber');
    assert((statsNowSrc.match(/getMarkdownContent\(/g) || []).length === 1,
        'updateStatsNow serializes exactly once');
    // Serializing with repair rewrites innerHTML and detaches the caret's node. The
    // debounced pass runs on a timer with nothing to restore focus, so it must not.
    assert(/getMarkdownContent\(false\)/.test(statsNowSrc),
        'updateStatsNow serializes WITHOUT repairing fragments (pure read)');
}

console.log('--- document-level operations bypass the debounce ---');
{
    // load_content, new_document, save_success, undo/redo restore, loadMarkdownContent
    const immediateCallers = (mainScript.match(/updateStatsNow\(\);/g) || []).length;
    assert(immediateCallers >= 6, 'document-level operations call updateStatsNow (' + immediateCallers + ' sites)');

    const taggedSrc = extractFunction('getDocumentStateTagged');
    assert(/lastSavedContent/.test(taggedSrc) && /'1'/.test(taggedSrc),
        'host has an authoritative dirty probe that ignores the debounce');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nSTATS DEBOUNCE SELFTEST FAILED');
    process.exit(1);
}
console.log('\nSTATS DEBOUNCE SELFTEST PASSED');
