/**
 * A large code file in the real app: open it, reach its longest line and its end in Source,
 * and the app still answers. Hidden desktop; ~30 s.
 *
 *   RUN_APP_E2E=1 node tests/big-file-app.mjs
 *
 * 2026-09-27: TypoZen_Template_Test.html (2.2 MB, 29,600 lines, one line of 356 KB) froze the
 * app in Source -- twice over. The Windows spell checker, on the host's UI thread, was sent the
 * lines on screen and took 13 s over 500 characters of script; and the C-family highlighter
 * looped forever on the first '@'. Every Source test until then used Markdown of short lines,
 * so neither was seen. The headless suites (spell-scope-browser, code-lexers-selftest) cover
 * the page; this one proves the host stays free, which only the real app can.
 *
 * The file is opened as .xml and as .css copies: both open straight into the editor, through
 * the xml highlighter HTML's Source uses and the C-family one that looped. An .html file opens
 * as a rendered page first and reaches Source only by the Mode button (OpenAsEditorText), which
 * needs a visible window to click -- that one step is not driven here.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, profileFile, killSuiteApps } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

let app = null;
const trace = [];            // steps logged from the page, printed if it stops answering
const deadline = setTimeout(() => {
    console.error(trace.join('\n')); console.error('BIG FILE APP: deadline -- the app stopped answering');
    // A frozen app does not close when asked: end the one this suite started (by its
    // throwaway profile folder -- no other TypoZen can match). Proven by harness-kill-app.mjs.
    killSuiteApps();
    process.exit(3);
}, 150000);

async function run(ext) {
    console.log('\n=== the 2.2 MB template as .' + ext + ', in the real app ===');
    const file = profileFile('big-template.' + ext);
    fs.copyFileSync(TEMPLATE, file);
    const t0 = Date.now();
    app = await launchApp({ file: file });
    app.page.on('console', m => { if (m.text().startsWith('T ')) trace.push('  ..   ' + m.text()); });
    await settledApp(app, 20000);
    try {
        const r = await app.eval(async () => {
            const wait = (ms) => new Promise(res => setTimeout(res, ms));
            const t0 = performance.now(), T = (s) => console.log('T ' + Math.round(performance.now() - t0) + ' ms ' + s);
            for (let i = 0; i < 100 && !(sourceEditor.value && sourceEditor.value.length > 1000000); i++) await wait(100);
            const out = { ext: state.docExt, mode: state.mode, chars: sourceEditor.value.length, loadWait: Math.round(performance.now() - t0) };
            T('ext ' + out.ext + ', mode ' + out.mode + ', chars ' + out.chars);
            if (state.mode !== 'source') handleCommand('view_set:mode:source');
            const lines = sourceEditor.value.split('\n');
            let longest = 0; for (let i = 1; i < lines.length; i++) if (lines[i].length > lines[longest].length) longest = i;
            T('scroll to line ' + (longest + 1));
            const b = performance.now();
            sourceEditor.scrollToOffset(sourceOffsetAtHardLine(sourceEditor.value, longest + 1) + 1000, 0);
            await wait(0);
            out.toLongLine = Math.round(performance.now() - b);
            await wait(700);                                    // past the spelling pause
            T('scroll to end');
            const c = performance.now();
            sourceEditor.scrollToOffset(sourceEditor.value.length, 0);
            await wait(0);
            out.toEnd = Math.round(performance.now() - c);
            await wait(700);
            out.underlines = document.querySelectorAll('#source-cm .typozen-spell').length;
            T('done');
            return out;
        });
        console.log('  ..   opened in ' + (Date.now() - t0) + ' ms (' + r.chars + ' chars, .' + r.ext + ', ' + r.mode + '); to the 356 KB line ' + r.toLongLine + ' ms, to the end ' + r.toEnd + ' ms');
        assert(r.chars > 2000000 && r.ext === ext, 'the whole file is in Source as .' + ext);
        assert(r.toLongLine < 2000 && r.toEnd < 2000, 'Source reaches the longest line and the end promptly');
        assert(r.underlines === 0, 'code is not spell-checked: nothing underlined');

        // The host's UI thread is free: a page -> host -> page round trip, which is also the
        // real single-word correction (spell_suggest:) a selection makes.
        const trip = await app.eval(async () => {
            const got = new Promise(res => {
                const prev = window.applySpellSuggestions;
                window.applySpellSuggestions = function (p) { window.applySpellSuggestions = prev; try { prev(p); } catch (e) {} res(String(p)); };
            });
            const a = performance.now();
            postMsg('spell_suggest:recieve');
            const p = await Promise.race([got, new Promise(res => setTimeout(() => res(null), 10000))]);
            return { ms: Math.round(performance.now() - a), payload: p };
        });
        console.log('  ..   host round trip ' + trip.ms + ' ms: ' + JSON.stringify(trip.payload));
        assert(trip.payload !== null && trip.ms < 1000, 'the host answers within a second -- its UI thread is free');
        assert(/[\t|]receive(\||$)/.test(trip.payload || ''), 'and a selected misspelling gets real suggestions (receive)');

        if (ext === 'xml') {
            // The queue (2026-09-29): a selected word's suggestions go ahead of queued checks,
            // and checks the page drops are skipped. Near-clean 1,500-character paragraphs
            // (a clean 7,500 takes this checker ~10 s) -- a check already running cannot be interrupted, so what is
            // asserted is order: the suggestion arrives before the second queued check.
            const queue = await app.eval(async () => {
                const prose = ('The quick brown fox jumps over the lazy dog, and the cat sat on it. ').repeat(22).slice(0, 1490) + ' teh';
                const replies = [], order = [];
                const prevHits = applySpellHits, prevSugg = window.applySpellSuggestions;
                window.applySpellHits = applySpellHits = function (p) { const h = String(p).split('\n')[0]; replies.push(h); order.push(h.split('\t')[0]); try { prevHits(p); } catch (e) {} };
                window.applySpellSuggestions = function (p) { order.push('suggest'); try { prevSugg(p); } catch (e) {} };
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                for (let i = 0; i < 4; i++) postMsg('spell_check:qa' + i + '\n' + prose + i);
                await wait(50);
                postMsg('spell_suggest:quikc');
                for (let i = 0; i < 120 && replies.filter(r => r.startsWith('qa')).length < 4; i++) await wait(250);
                for (let i = 0; i < 6; i++) postMsg('spell_check:qb' + i + '\n' + prose + 'b' + i);
                for (let i = 1; i < 6; i++) postMsg('spell_drop:qb' + i);
                const b = performance.now();
                for (let i = 0; i < 300 && replies.filter(r => r.startsWith('qb')).length < 6; i++) await wait(100);
                const dropMs = Math.round(performance.now() - b);
                window.applySpellHits = applySpellHits = prevHits; window.applySpellSuggestions = prevSugg;
                const qb = replies.filter(r => r.startsWith('qb'));
                return { order: order.filter(o => /^(suggest|qa)/.test(o)), dropMs, qb: qb.length, dropped: qb.filter(r => /\tdropped$/.test(r)).length };
            });
            console.log('  ..   reply order: ' + queue.order.join(', ') + '; five dropped of six answered in ' + queue.dropMs + ' ms');
            const sAt = queue.order.indexOf('suggest'), qa1At = queue.order.indexOf('qa1');
            assert(sAt >= 0 && qa1At >= 0 && sAt < qa1At, "a selected word's suggestions go ahead of queued checks");
            assert(queue.qb === 6 && queue.dropped === 5, 'checks the page dropped are skipped and answered as dropped (' + queue.dropped + ' of 5)');

            // The spell checker never blocks the window (2026-09-27: a 2-Col pass over a README
            // froze the app and it had to be killed). Hand the host a chunk known to take the
            // checker many seconds -- 2,000 characters of minified script -- and ask for a
            // definition, which the host answers on its UI thread. It must come straight back.

            const free = await app.eval(async () => {
                const defined = () => new Promise(res => {
                    const prev = window.showDefinition;
                    window.showDefinition = function () {
                        window.showDefinition = prev;
                        try { return prev.apply(this, arguments); } catch (e) {} finally { res(true); }
                    };
                });
                const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(false), ms))]);
                let p = defined(); postMsg('define:house');
                await within(p, 15000);                          // the dictionary loads once
                const v = sourceEditor.value, i = Math.max(0, v.indexOf('!function'));
                postMsg('spell_check:free1\n' + v.slice(i, i + 2000));
                await new Promise(r => setTimeout(r, 300));      // the check is under way
                p = defined();
                const a = performance.now();
                postMsg('define:garden');
                const ok = await within(p, 10000);
                return { ok, ms: Math.round(performance.now() - a) };
            });
            console.log('  ..   a definition during a slow spell check came back in ' + free.ms + ' ms');
            assert(free.ok && free.ms < 1000, 'the window stays responsive while the spell checker works (' + free.ms + ' ms)');

        }
    } finally {
        try { await app.close(); } catch (e) {}
        app = null;
        await sleep(1500);                                  // single-instance: let it go before the next launch
    }
}

try {
    await run('xml');
    await run('css');
} catch (e) {
    failed++;
    console.error('  FAIL ' + (e && e.message ? e.message.split('\n')[0] : e));
    console.error(trace.join('\n'));
} finally {
    clearTimeout(deadline);
    try { if (app) await app.close(); } catch (e) {}
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('BIG FILE APP FAILED'); process.exit(1); }
console.log('BIG FILE APP PASSED');
