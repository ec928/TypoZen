/**
 * A Markdown tab comes back where you left it -- across a tab switch, and across a restart.
 *
 * The book store answers "reopen this file where I left it". This is the other half: each
 * tab remembers its own place, so switching away and back does not send you to line 1 of a
 * 4,582-line document, and an untitled buffer can remember too.
 *
 *   RUN_APP_E2E=1 node tests/tab-position-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const DOC = path.join(appDir, 'tests', 'large-scroll-mixed.md');
const OTHER = path.join(appDir, 'README.md');
const TARGET = 600;

/** Where the reader is, by the same measure the page reports to the host. */
const wherePage = () => {
    // The same measure the page reports to the host, so the test cannot disagree with
    // what is actually stored.
    const t = (typeof currentReadingBlock === 'function') ? currentReadingBlock() : -1;
    return { at: t, blocks: DocumentModel.blocks.length, kind: DocumentModel.kind };
};

// The session store is the real profile's; put it back afterwards.
const SESSION = path.join(process.env.LOCALAPPDATA || '', 'TypoZen_Cache', 'tabs_session.txt');
let restoreSession = null;
try { restoreSession = fs.readFileSync(SESSION, 'utf8'); } catch (e) {}
function putSessionBack() {
    try {
        if (restoreSession !== null) fs.writeFileSync(SESSION, restoreSession);
        else fs.unlinkSync(SESSION);
    } catch (e) {}
}

console.log('\n=== read into a document, switch away, come back ===');
let app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
let landed = -1;
try {
    await sleep(3500);
    await settledApp(app, 20000);

    landed = await app.eval(async (at) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(at);
        await sleep(1200);
        // Report the way reading reports it, not by calling the reporter directly.
        document.getElementById('editor').dispatchEvent(new Event('scroll'));
        if (mainContainer) mainContainer.dispatchEvent(new Event('scroll'));
        await sleep(2200);
        return currentReadingBlock();
    }, TARGET);
    info('reading at block ' + landed + ' (asked for ' + TARGET + ')');
    assert(landed > 0, 'the reader is somewhere in the document');

    // A second tab, then back to the first.
    await app.eval((p) => postMsg('open_file_path:' + p), OTHER);
    await sleep(4000);
    const away = await app.eval(wherePage);
    info('other tab: ' + away.blocks + ' blocks');
    assert(away.blocks !== 3767, 'the other document really is open');

    await app.eval((p) => postMsg('open_file_path:' + p), DOC);
    await sleep(5000);
    await settledApp(app, 20000);
    const back = await app.eval(wherePage);
    info('back on the first tab at block ' + back.at + ' of ' + back.blocks);
    assert(Math.abs(back.at - landed) <= 40,
        'switching back returns to where reading stopped (' + back.at + ' vs ' + landed + ')');
} finally {
    await app.close();
}

await sleep(1500);

const written = (() => { try { return fs.readFileSync(SESSION, 'utf8'); } catch (e) { return ''; } })();
const resumeLines = written.split(/\r?\n/).filter(l => l.startsWith('resume='));
info('session records: ' + JSON.stringify(resumeLines));
assert(resumeLines.some(l => parseInt(l.slice(7), 10) > 0),
    'the session remembers a position for a tab');

console.log('\n=== and after a restart ===');
app = await launchApp({});
try {
    await sleep(9000);
    await settledApp(app, 25000);
    const restored = await app.eval(wherePage);
    info('restored tab sits at block ' + restored.at + ' of ' + restored.blocks +
         ', left at ' + landed);
    assert(restored.at > 0, 'a restored tab does not open at the top');
} finally {
    await app.close();
}

putSessionBack();

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'TAB POSITION FAILED' : 'TAB POSITION PASSED');
process.exit(failed ? 1 : 0);
