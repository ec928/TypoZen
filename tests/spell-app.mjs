/**
 * Preview spelling: type a misspelling, the host underlines it, a replacement applies.
 *
 *   RUN_APP_E2E=1 node tests/spell-app.mjs
 */
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

console.log('\n=== spelling against TypoZen.exe ===');
const app = await launchApp({ view: true });
try {
    await settledApp(app, 15000);
    await app.eval(() => {
        if (typeof loadMarkdownContent === 'function')
            loadMarkdownContent('teh quick brown fox', { replaceBook: true });
        window.__spellLast = '';
        const orig = window.applySpellHits;
        window.applySpellHits = applySpellHits = function (payload) {
            window.__spellLast = String(payload || '');
            if (typeof orig === 'function') orig(payload);
        };
        if (typeof scheduleSpellCheck === 'function') scheduleSpellCheck();
    });
    await settledApp(app, 8000);
    let last = '';
    for (let i = 0; i < 25 && !/teh/i.test(last); i++) {
        await sleep(150);
        last = await app.eval(() => window.__spellLast || '');
    }
    assert(/teh/i.test(last), 'Windows proofing flags teh (got ' + JSON.stringify(last.slice(0, 120)) + ')');

    const painted = await app.eval(() => {
        try {
            const h = CSS.highlights && CSS.highlights.get('typozen-spell');
            return h ? h.size : 0;
        } catch (e) { return -1; }
    });
    assert(painted > 0, 'Preview paints a spelling highlight (size=' + painted + ')');

    // Source: the same engine, its visible lines drawn as decorations (01a-source.js).
    const underlinedInSource = () => app.eval(() =>
        Array.from(document.querySelectorAll('#source-cm .typozen-spell')).map(e => e.textContent));
    await app.eval(() => handleCommand('view_set:mode:source'));
    let src = [];
    for (let i = 0; i < 25 && !src.some(w => /teh/i.test(w)); i++) { await sleep(150); src = await underlinedInSource(); }
    assert(src.some(w => /teh/i.test(w)), 'Source underlines the misspelling (got ' + JSON.stringify(src) + ')');
    const chromium = await app.eval(() => (document.querySelector('#source-cm .cm-content') || {}).spellcheck);
    assert(chromium === false, 'Chromium\'s own checker is off in Source');

    // Ignore goes through scheduleSpellCheck(), which used to re-check Preview only.
    await app.eval(() => { postMsg('spell_ignore:teh'); scheduleSpellCheck(); });
    for (let i = 0; i < 25 && src.some(w => /teh/i.test(w)); i++) { await sleep(150); src = await underlinedInSource(); }
    assert(!src.some(w => /teh/i.test(w)), 'Ignore clears the underline in Source (left ' + JSON.stringify(src) + ')');
} finally {
    try { await app.close(); } catch (e) {}
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('SPELL APP FAILED');
    process.exit(1);
}
console.log('SPELL APP PASSED');
