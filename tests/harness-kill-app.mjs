/**
 * The harness can end a TypoZen whose page has hung -- and only the one it started.
 *
 *   RUN_APP_E2E=1 node tests/harness-kill-app.mjs
 *
 * big-file-app ends its app this way when it stops answering (killSuiteApps): a page stuck
 * in a loop cannot be closed by asking. Until 2026-09-29 that path had never run. Here the
 * page is hung on purpose, and the harness must end exactly that process. ~15 s.
 */
import { launchApp, killSuiteApps } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

let passed = 0, failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }
const deadline = setTimeout(() => { console.error('HARNESS KILL: deadline'); killSuiteApps(); process.exit(3); }, 60000);

const app = await launchApp({});
await settledApp(app, 20000);
const pid = await app.eval(() => 1).then(() => true, () => false);
assert(pid, 'the app answers before it is hung');
// Hang the page for good; do not wait for an answer that will never come.
app.page.evaluate(() => { for (;;) {} }).catch(() => {});
await sleep(2000);
const answered = await Promise.race([app.eval(() => 1).then(() => true, () => true), sleep(3000).then(() => false)]);
assert(!answered, 'premise: the page no longer answers');
const ended = killSuiteApps();
await sleep(1500);
assert(ended === 1, 'the harness ended exactly one TypoZen -- its own (' + ended + ')');
try { await app.browser.disconnect(); } catch (e) {}

clearTimeout(deadline);
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('HARNESS KILL FAILED'); process.exit(1); }
console.log('HARNESS KILL PASSED');
process.exit(0);
