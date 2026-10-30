/**
 * Every build gets this, and it has an aggressive budget: 20 seconds, and going over IS a
 * failure. Checks that have earned their place, all at once:
 *
 *   - the built exe says the version the source says
 *   - real-files-roundtrip: every line of every real file through the save logic
 *   - real-files-properties, quick: whole files, Read Aloud, nothing in a file can run
 *   - key-smoke: the keys that have done the most damage, pressed for real
 *   - core-smoke-app: the real app opens a book, then edits and saves a document to disk
 *
 * Runs from Build_TypoZen_NoTest.ps1, from tools/hooks/pre-commit when AppVersion changes, and
 * from Build-Installer. It runs on a hidden desktop, so no window appears. The app
 * check is skipped, loudly, while a TypoZen is open: the app is single-instance, and a test must
 * never close someone's editor.
 *
 *   node tests/version-smoke.mjs
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const BUDGET_MS = 20000;
const started = Date.now();
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

const src = fs.readFileSync(path.join(repo, 'TypoZen_App.cs'), 'utf8').match(/AppVersion = "([\d.]+)"/);
const wanted = src ? src[1] : '?';
const exePath = process.env.TYPOZEN_EXE || path.join(repo, 'TypoZen.exe');
const built = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exePath}').VersionInfo.FileVersion`], { encoding: 'utf8' }).stdout.trim();
let failed = [];
if (built.indexOf(wanted) !== 0) failed.push(`the exe is ${built || 'missing'}, the source says ${wanted}: build it first`);
else console.log(`  OK   ${secs(Date.now() - started)}  exe is ${wanted}`);

const open = spawnSync('tasklist', ['/FI', 'IMAGENAME eq TypoZen.exe', '/NH'], { encoding: 'utf8' }).stdout.indexOf('TypoZen.exe') >= 0;
const jobs = [
    ['real-files-roundtrip-browser.mjs', {}],
    ['real-files-properties-browser.mjs', { PROPERTIES_QUICK: '1' }],
    ['key-smoke-browser.mjs', {}],
];
if (open) console.log('  SKIP core-smoke-app: a TypoZen is open. THE REAL APP WAS NOT TESTED.');
else jobs.push(['core-smoke-app.mjs', { RUN_APP_E2E: '1' }]);

// One try: every check at once, killed at the deadline. A check killed there has no result.
async function attempt() {
    const t0 = Date.now();
    const children = [];
    let hit = false;
    const deadline = setTimeout(() => {
        hit = true;
        children.forEach(p => { try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} });
    }, BUDGET_MS);
    const results = await Promise.all(jobs.map(([name, env]) => new Promise(res => {
        const j0 = Date.now();
        const p = spawn(process.execPath, [path.join(here, name)], { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(p);
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        p.on('exit', code => res({ name, ok: code === 0, ms: Date.now() - j0, out, killed: hit }));
    })));
    clearTimeout(deadline);
    return { results, took: Date.now() - t0, hit };
}

let run = await attempt();
// A machine that stalled is not a bug: everything slows together and nothing has failed. One more
// try, once. A check that failed by itself is a real failure and is never retried.
if (run.hit && run.results.every(r => r.ok || r.killed)) {
    console.log('  ...   over budget with no check failing: the machine is busy. One more try.');
    run = await attempt();
}
for (const r of run.results) {
    if (r.ok) console.log(`  OK   ${secs(r.ms)}  ${r.name}`);
    else {
        failed.push(r.killed ? r.name + ' did not finish in time' : r.name);
        console.error(`  FAIL ${secs(r.ms)}  ${r.name}`);
        const lines = r.out.split('\n').map(l => l.trim()).filter(Boolean);
        const why = lines.filter(l => /FAIL|REFUSED|Error|got  |want /.test(l)).slice(0, 8);
        console.error((why.length ? why : lines.slice(-6)).map(l => '       ' + l.slice(0, 170)).join('\n'));
    }
}
if (run.took > BUDGET_MS) failed.push(`over budget: ${secs(run.took)} against ${secs(BUDGET_MS)}. Going over is a failure: make it faster, do not raise the number`);
console.log(`\n${failed.length ? 'VERSION SMOKE FAILED' : 'VERSION SMOKE PASSED'} in ${secs(run.took)} (budget ${secs(BUDGET_MS)})`);
failed.forEach(f => console.error('  ' + f));
process.exit(failed.length ? 1 : 0);
