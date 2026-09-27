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

    // Nothing changed: the next check repaints from memory and asks the host nothing.
    const sentBefore = await app.eval(() => {
        window.__spellSent = 0;
        const real = window.chrome.webview.postMessage.bind(window.chrome.webview);
        window.chrome.webview.postMessage = (m) => { if (String(m).startsWith('spell_check:')) window.__spellSent++; return real(m); };
        scheduleSpellCheck();
        return window.__spellSent;
    });
    await sleep(900);                                   // past the 420 ms pause
    const sentAfter = await app.eval(() => window.__spellSent);
    const stillPainted = await app.eval(() => { const h = CSS.highlights.get('typozen-spell'); return h ? h.size : 0; });
    assert(sentAfter === sentBefore && stillPainted > 0,
        'with nothing changed, a check sends nothing to the host and keeps the underline (' + sentAfter + ' sent)');

    // Suggestions come only when the word is selected (spell_suggest:), not with the check.
    assert(!/\tthe\b/.test(last.split('\n')[1] || ''), 'the check itself carries no suggestions');
    await app.eval(() => {
        const t = document.querySelector('#editor .block');
        const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode()) && !n.nodeValue.includes('teh')) {}
        const r = document.createRange(); const i = n.nodeValue.indexOf('teh'); r.setStart(n, i); r.setEnd(n, i + 3);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        const box = r.getBoundingClientRect();
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: box.left + 2, clientY: box.top + 2 }));
    });
    let suggs = [];
    for (let i = 0; i < 25 && !suggs.includes('the'); i++) {
        await sleep(150);
        suggs = await app.eval(() => Array.from(document.querySelectorAll('#selPopSpell [data-spell-fix]')).map(b => b.textContent));
    }
    assert(suggs.includes('the'), 'selecting the underlined word shows its suggestions (got ' + JSON.stringify(suggs) + ')');
    await app.eval(() => { try { hideSelPop(); } catch (e) {} });

    // Source: the same engine, its visible lines drawn as decorations (01a-source.js).
    const underlinedInSource = () => app.eval(() =>
        Array.from(document.querySelectorAll('#source-cm .typozen-spell')).map(e => e.textContent));
    await app.eval(() => handleCommand('view_set:mode:source'));
    let src = [];
    for (let i = 0; i < 25 && !src.some(w => /teh/i.test(w)); i++) { await sleep(150); src = await underlinedInSource(); }
    assert(src.some(w => /teh/i.test(w)), 'Source underlines the misspelling (got ' + JSON.stringify(src) + ')');
    const chromium = await app.eval(() => (document.querySelector('#source-cm .cm-content') || {}).spellcheck);
    assert(chromium === false, 'Chromium\'s own checker is off in Source');

    // Ignore, through the popover's own button, in Source: the word is forgotten and the
    // underline goes (it used to stay until the text itself changed).
    await app.eval(() => {
        sourceEditor.focus();
        sourceEditor.setSelectionRange(0, 3);
        const box = document.getElementById('source-cm').getBoundingClientRect();
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: box.left + 20, clientY: box.top + 20 }));
    });
    let ignore = null;
    for (let i = 0; i < 25 && !ignore; i++) {
        await sleep(150);
        ignore = await app.eval(() => !!document.querySelector('#selPopSpell [data-spell-ignore]'));
    }
    assert(ignore, 'selecting the underlined word in Source offers Ignore');
    await app.eval(() => { const b = document.querySelector('#selPopSpell [data-spell-ignore]'); if (b) b.click(); });
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
