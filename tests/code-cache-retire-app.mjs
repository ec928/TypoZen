/**
 * Stale compiled-script cache is retired when the page's scripts change.
 *
 * Scripts load as js/modules/x.js?v=<stamp> and Chromium keys its code cache by URL, so
 * every new stamp left the old entries behind for good (223 MB in a real profile,
 * 2026-10-07). At start the host compares the stamp with code_cache_stamp.txt; on a change
 * it renames EBWebView\Default\Code Cache aside before the browser starts and deletes it in
 * the background. This plants a stale cache and an old stamp, starts the app, and checks.
 *
 *   RUN_APP_E2E=1 node tests/code-cache-retire-app.mjs     (~10 s, hidden desktop)
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { launchApp, profileDir, sleep } from './app-harness.mjs';

// The browser processes of a closed app hold its profile for a moment; wait them out, as a
// person reopening the app later would have.
async function browserGone() {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
        const ps = "@(Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*"
            + path.basename(profileDir) + "*' }).Count";
        const n = +String(spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout || '0').trim();
        if (!n) return true;
        await sleep(300);
    }
    return false;
}

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 60000);
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

let app;
try {
    // A first start creates the profile; then plant the stale state into it.
    app = await launchApp({ file: path.resolve('tests', 'short-note.txt'), settleMs: 2000 });
    await app.close(); app = null;
    assert(await browserGone(), "the closed app's browser has exited");
    const def = path.join(profileDir, 'EBWebView', 'Default');
    const cache = path.join(def, 'Code Cache');
    const record = path.join(profileDir, 'code_cache_stamp.txt');
    assert(fs.existsSync(record), 'the first start recorded the scripts\' stamp');
    const current = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim() : '';
    fs.mkdirSync(path.join(cache, 'js'), { recursive: true });
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(cache, 'js', 'stale-' + i), Buffer.alloc(4096, i));
    fs.writeFileSync(record, '123');                                   // a stamp from an older build

    app = await launchApp({ file: path.resolve('tests', 'short-note.txt'), settleMs: 2000 });
    const end = Date.now() + 8000;
    const staleLeft = () => fs.existsSync(path.join(cache, 'js', 'stale-0'))
        || fs.readdirSync(def).some(d => d.startsWith('Code Cache.retired-'));
    while (Date.now() < end && staleLeft()) await sleep(200);
    assert(!staleLeft(), 'the old cache is gone, set aside and deleted');
    assert(fs.readFileSync(record, 'utf8').trim() === current, 'the current stamp is recorded again');
    assert(await app.eval(() => typeof handleCommand === 'function'), 'and the app started normally');
    await app.close(); app = null;
    assert(await browserGone(), "the closed app's browser has exited");

    // Same scripts, next start: nothing is retired.
    fs.mkdirSync(path.join(cache, 'js'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'js', 'keep-me'), 'x');
    app = await launchApp({ file: path.resolve('tests', 'short-note.txt'), settleMs: 2000 });
    await sleep(1500);
    assert(fs.existsSync(path.join(cache, 'js', 'keep-me')), 'with the same scripts, the cache is kept');
} catch (e) {
    failed++; console.error('  FAIL ' + e.message.split('\n')[0]);
} finally {
    if (app) await app.close();
    clearTimeout(killer);
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('\nCODE CACHE RETIRE APP FAILED'); process.exit(1); }
console.log('\nCODE CACHE RETIRE APP PASSED');
process.exit(0);
