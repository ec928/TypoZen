/**
 * The test gate: every suite in tests/, run the way run-tests.ps1 and Build_TypoZen.ps1 both
 * need, from one place.
 *
 * Headless suites (*-selftest, *-browser and the rest) run several at a time. Each one is
 * its own node process with its own headless Chrome and nothing shared, and run one after
 * another the gate took 7.5 minutes while the machine sat mostly idle (453 s, 2026-10-06;
 * keyboard-editing-browser alone was 109 s of it). They start longest-first, from the
 * timings of the last run, so a long suite is not left to finish on its own at the end.
 *
 * *-app.mjs suites launch the real TypoZen.exe, which is single-instance, so they never run
 * in parallel: one at a time, after the rest, and only with RUN_APP_E2E=1.
 *
 *   node tests/run-gate.mjs              # the gate (template regenerated first)
 *   node tests/run-gate.mjs --jobs 1     # one at a time, as before
 *   TZ_GATE_JOBS=6 node tests/run-gate.mjs
 *   node tests/run-gate.mjs --quiet      # PASS lines suppressed (the build uses this)
 *
 * A suite fails only on a non-zero exit. A sandbox crash on launch (TargetCloseError,
 * Protocol error) is retried up to three times, as run-tests.ps1 did; anything else is not.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const args = process.argv.slice(2);
const argJobs = args.indexOf('--jobs') >= 0 ? +args[args.indexOf('--jobs') + 1] : 0;
const jobs = Math.max(1, argJobs || +process.env.TZ_GATE_JOBS || 4);
const quiet = args.includes('--quiet');
const HEADLESS_LIMIT_MS = 300000, APP_LIMIT_MS = 600000;
const timesFile = path.join(os.tmpdir(), 'typozen-gate-times.json');

// Helpers and generators, not suites; the same rule run-tests.ps1 and the build used.
const helpers = new Set(['app-harness.mjs', 'build-test-template.mjs', 'engine-source.mjs', 'settle.mjs', 'epub-zip.mjs',
    'fonts-ab.mjs', 'scripts-ab.mjs', 'cm-ab.mjs', 'narrator-sidecar.mjs', 'run-gate.mjs', 'keyboard-editing-cases.mjs']);
const all = fs.readdirSync(here).filter(f => f.endsWith('.mjs') && !helpers.has(f)
    && !f.startsWith('make-') && !f.startsWith('_')).sort();
const pending = all.filter(f => f.endsWith('-pending.mjs'));
const app = all.filter(f => f.endsWith('-app.mjs'));
let headless = all.filter(f => !f.endsWith('-pending.mjs') && !f.endsWith('-app.mjs'));
if (process.env.RUN_PENDING_E2E === '1') headless = headless.concat(pending);

let past = {};
try { past = JSON.parse(fs.readFileSync(timesFile, 'utf8')); } catch (e) { }
headless.sort((a, b) => (past[b] || 0) - (past[a] || 0) || a.localeCompare(b));

console.log('Running TypoZen self-tests (' + headless.length + ' suites, ' + jobs + ' at a time)...');
const regen = spawnSync('node', [path.join(here, 'build-test-template.mjs')], { cwd: root, encoding: 'utf8' });
if (regen.status !== 0) {
    console.log('Could not regenerate TypoZen_Template_Test.html - aborting.');
    console.log(regen.stdout + regen.stderr);
    process.exit(1);
}

function runOnce(name, limitMs) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn('node', [path.join(here, name)], { cwd: root, env: process.env });
        let out = '', err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        const timer = setTimeout(() => {
            err += '\n[run-gate] over ' + (limitMs / 1000) + ' s - stopped';
            try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch (e) { child.kill(); }
        }, limitMs);
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0 }); });
    });
}
async function runSuite(name, limitMs) {
    let r;
    for (let i = 0; i < 3; i++) {
        r = await runOnce(name, limitMs);
        if (r.code === 0 || !/TargetCloseError|Protocol error/.test(r.err)) break;
        console.log('  RETRY ' + name + ' (sandbox crash, attempt ' + (i + 1) + ' of 3)');
    }
    return r;
}

const failed = [], took = {};
function report(name, r) {
    took[name] = r.ms;
    if (r.code === 0) { if (!quiet) console.log('  PASS ' + name + '  (' + (r.ms / 1000).toFixed(1) + ' s)'); return; }
    failed.push(name);
    console.log('  FAIL ' + name);
    for (const l of (r.out + '\n' + r.err).split(/\r?\n/)) if (l.trim()) console.log('      ' + l);
}

const t0 = Date.now();
const queue = headless.slice();
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) { const name = queue.shift(); report(name, await runSuite(name, HEADLESS_LIMIT_MS)); }
}));
if (process.env.RUN_APP_E2E === '1') {
    for (const name of app) report(name, await runSuite(name, APP_LIMIT_MS));
}
try { fs.writeFileSync(timesFile, JSON.stringify(Object.assign(past, took))); } catch (e) { }

if (process.env.RUN_PENDING_E2E !== '1' && pending.length)
    console.log('\n  SKIPPED, not built yet (set RUN_PENDING_E2E=1): ' + pending.join(', '));
if (process.env.RUN_APP_E2E !== '1' && app.length)
    console.log('\n  SKIPPED, drives the real .exe (set RUN_APP_E2E=1): ' + app.length + ' suites');
const secs = Math.round((Date.now() - t0) / 1000);
const ran = headless.length + (process.env.RUN_APP_E2E === '1' ? app.length : 0);
if (failed.length) { console.log('FAILED (' + failed.length + ' of ' + ran + ', ' + secs + ' s): ' + failed.join(', ')); process.exit(1); }
console.log('All ' + ran + ' suites passed in ' + secs + ' s.');
process.exit(0);
