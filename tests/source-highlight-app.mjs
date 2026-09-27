/**
 * Source-mode search highlighting, on both of Source's surfaces.
 *
 * Source runs on CodeMirror by default and on the textarea when switched to it
 * (js/modules/01a-source.js; docs/codemirror-source-plan.md). The reader's promises are
 * the same on both -- every hit marked, the marks on the matched characters, the ring on
 * the current hit and following the keyboard, no stale marks after an edit, a late jump
 * actually shown, nothing left behind on leaving Source -- but how they are kept differs,
 * so the checks do too:
 *
 *  - CodeMirror draws the marks as decorations on the real text. They cannot drift, so
 *    the checks read the decorations back (sourceEditor.searchMarks()) against
 *    findState.matches, and the rendered marks' own text against the document.
 *  - The textarea cannot be styled, so its marks are painted on a mirror div behind it,
 *    and "it looked right in a screenshot" is how a mirror rots: a font, padding or wrap
 *    change slides every mark. Those checks are geometric. The load-bearing one is
 *    scrollHeight equality: if the mirror wrapped one line differently across 200k
 *    characters its laid-out height could not match the textarea's.
 *
 * The first launch runs on the default (CodeMirror); the second on the textarea, chosen by
 * TYPOZEN_SOURCE_ENGINE (a --debug-only seam the host passes on as ?source=). Each asserts
 * which surface it got -- a silent fallback would pass while testing nothing.
 *
 *   RUN_APP_E2E=1 node tests/source-highlight-app.mjs
 */
import { execSync } from 'child_process';
import { launchApp, sleep } from './app-harness.mjs';
import { settledApp } from './settle.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const FILE = 'tests/large-scroll-mixed.md';

/**
 * TypoZen is single-instance, and close() ends the process without waiting for it. A
 * relaunch while the last one is still going hands the file to the old process and exits
 * -- the suite then talks to the wrong instance on the wrong surface. Wait it out.
 */
async function untilNoTypoZen(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        let out = '';
        try { out = execSync('tasklist /FI "IMAGENAME eq TypoZen.exe" /NH', { encoding: 'utf8' }); } catch (e) { }
        if (!/TypoZen\.exe/i.test(out)) return true;
        await sleep(200);
    }
    return false;
}

async function openInSource(engine) {
    const app = await launchApp({ file: FILE, settleMs: 5000, view: true,
        env: engine ? { TYPOZEN_SOURCE_ENGINE: engine } : {} });
    await settledApp(app, 15000);
    await app.eval(() => handleCommand('view_set:mode:source'));
    await app.page.waitForFunction(() => state.mode === 'source', { timeout: 5000 });
    return app;
}

/** Type a query into the find box and wait, from outside the page, for its hits. */
async function find(app, q, atLeast) {
    await app.eval((query) => {
        const input = document.getElementById('findInput');
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
    await app.page.waitForFunction((query, n) => findState.query === query && findState.matches.length > n,
        { timeout: 15000, polling: 150 }, q, atLeast);
}

// ---------------------------------------------------------------- CodeMirror
async function codemirrorChecks(app) {
    console.log('\n=== Ctrl+F marks every hit, with focus in the find box ===');
    await app.eval(() => handleCommand('find'));
    await app.page.waitForFunction(() => document.activeElement && document.activeElement.id === 'findInput', { timeout: 3000 }).catch(() => {});
    await find(app, 'scroll', 2000);
    const a = await app.eval(() => {
        const marks = sourceEditor.searchMarks();
        const m = findState.matches;
        const text = sourceEditor.value;
        let placed = marks.length === m.length, wordOk = true;
        for (let i = 0; i < marks.length && placed; i++) {
            if (marks[i].from !== m[i].start || marks[i].to !== m[i].end) placed = false;
            if (text.slice(marks[i].from, marks[i].to) !== text.slice(m[i].start, m[i].end)) wordOk = false;
        }
        const curs = marks.map((x, i) => x.cur ? i : -1).filter(i => i >= 0);
        return { matches: m.length, marks: marks.length, placed, wordOk, curs, index: findState.index,
            active: document.activeElement.id };
    });
    info('matches ' + a.matches + ', marks ' + a.marks + ', current ' + JSON.stringify(a.curs) + ' / index ' + a.index);
    assert(a.matches > 2000, 'Ctrl+F found the hits (' + a.matches + ')');
    assert(a.active === 'findInput', 'focus is in the find box, not in Source');
    assert(a.marks === a.matches && a.placed, 'one mark per hit, on exactly its range');
    assert(a.curs.length === 1 && a.curs[0] === a.index, 'exactly one hit is current, and it is findState\'s');

    console.log('\n=== the marks on screen hold the matched text ===');
    // Only the visible lines are drawn. Each drawn mark is read back to its position in
    // the document and compared with the text there -- a mark on the wrong characters
    // renders different characters.
    const drawn = await app.eval(() => {
        const els = document.querySelectorAll('#source-cm .tz-src-hit');
        const text = sourceEditor.value;
        let wrong = 0, firstBad = null;
        els.forEach((el) => {
            const at = sourceEditor.view.posAtDOM(el, 0);
            const want = text.slice(at, at + el.textContent.length);
            if (want !== el.textContent || !findState.matches.some(m => m.start === at)) {
                wrong++; if (!firstBad) firstBad = { at, got: el.textContent, want };
            }
        });
        return { n: els.length, wrong, firstBad };
    });
    info('drawn marks: ' + drawn.n);
    assert(drawn.n > 0, 'marks are drawn on the visible text');
    assert(drawn.wrong === 0, 'every drawn mark holds its hit' + (drawn.firstBad ? ' (first bad: ' + JSON.stringify(drawn.firstBad) + ')' : ''));

    console.log('\n=== an edit does not leave stale marks ===');
    await app.eval(() => {
        sourceEditor.setRangeText('ZZZZ', 0, 0, 'end');
        sourceEditor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await app.page.waitForFunction(() => {
        const marks = sourceEditor.searchMarks(), m = findState.matches;
        return sourceEditor.value.startsWith('ZZZZ') && marks.length === m.length && marks.length > 0
            && marks[0].from === m[0].start;
    }, { timeout: 5000, polling: 100 }).catch(() => {});
    const e = await app.eval(() => {
        const marks = sourceEditor.searchMarks(), m = findState.matches, text = sourceEditor.value;
        let ok = marks.length === m.length;
        for (let i = 0; i < marks.length && ok; i++) if (marks[i].from !== m[i].start || marks[i].to !== m[i].end) ok = false;
        const q = findState.query.toLowerCase();
        const onWord = marks.every(x => text.slice(x.from, x.to).toLowerCase() === q);
        return { ok, onWord, head: text.slice(0, 4) };
    });
    assert(e.head === 'ZZZZ', 'the edit landed');
    assert(e.ok && e.onWord, 'after the edit every mark is on a current hit');

    console.log('\n=== typing above the hits, find bar shut, keeps the marks on their words ===');
    // A live query with the find bar closed (the Search sidebar's case): the input path
    // used to repaint the pre-edit offsets onto the new text, and every mark slid left one
    // character per keystroke typed above it (Ed, 2026-09-27).
    await app.eval(() => { closeFindBar(); runFind('bullet', true, { navigate: false }); });
    await app.page.waitForFunction(() => findState.query === 'bullet' && findState.matches.length > 0, { timeout: 5000 });
    for (let i = 0; i < 6; i++) {
        await app.eval(() => {
            sourceEditor.setRangeText('d', 0, 0, 'end');
            sourceEditor.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    const onWord = () => app.eval(() => {
        const t = sourceEditor.value, marks = sourceEditor.searchMarks();
        return { n: marks.length, bad: marks.filter(x => t.slice(x.from, x.to).toLowerCase() !== 'bullet').length };
    });
    const during = await onWord();
    await app.page.waitForFunction(() => {
        const m = findState.matches, t = sourceEditor.value;
        return m.length > 0 && t.slice(m[0].start, m[0].end).toLowerCase() === 'bullet';
    }, { timeout: 3000 }).catch(() => { });
    const settledMarks = await onWord();
    info('while typing ' + JSON.stringify(during) + ', after ' + JSON.stringify(settledMarks));
    assert(during.n > 0 && during.bad === 0, 'while typing, every mark stays on "bullet"');
    assert(settledMarks.n > 0 && settledMarks.bad === 0, 'after the search re-runs, every mark is on "bullet"');
    await app.eval(() => { runFind('', false, { navigate: false }); openFindBar(); });
    await find(app, 'scroll', 2000);

    console.log('\n=== keyboard navigation moves the ring ===');
    // findStep (Up/Down, the find bar arrows) is a different path from findJumpTo (the
    // mouse). The ring once followed the mouse and ignored the keyboard.
    const ringAt = () => app.eval(() => ({ ring: sourceEditor.searchMarks().findIndex(x => x.cur), index: findState.index }));
    await app.eval(() => findJumpTo(20));
    await app.page.waitForFunction(() => findState.index === 20, { timeout: 3000 }).catch(() => {});
    const fromMouse = await ringAt();
    await app.eval(() => findStep(1));
    await app.page.waitForFunction(() => findState.index === 21, { timeout: 3000 }).catch(() => {});
    const afterDown = await ringAt();
    await app.eval(() => findStep(-1));
    await app.page.waitForFunction(() => findState.index === 20, { timeout: 3000 }).catch(() => {});
    const afterUp = await ringAt();
    info('ring/index ' + JSON.stringify({ fromMouse, afterDown, afterUp }));
    assert(fromMouse.ring === fromMouse.index, 'the ring is on the hit the mouse chose');
    assert(afterDown.index === fromMouse.index + 1 && afterDown.ring === afterDown.index, 'Down advanced it and the ring followed');
    assert(afterUp.ring === afterUp.index, 'the ring followed Up');

    console.log('\n=== clearing the query clears the marks ===');
    // Alt+S closing the Search sidebar clears the query through runFind(''), which returns
    // before the per-surface branches -- so the marks once survived it.
    await app.eval(() => runFind('', false, { navigate: false }));
    await app.page.waitForFunction(() => sourceEditor.searchMarks().length === 0, { timeout: 3000 }).catch(() => {});
    const cleared = await app.eval(() => ({ marks: sourceEditor.searchMarks().length,
        drawn: document.querySelectorAll('#source-cm .tz-src-hit').length }));
    assert(cleared.marks === 0 && cleared.drawn === 0, 'no marks left behind (' + JSON.stringify(cleared) + ')');

    console.log('\n=== jumping to a late match actually shows it ===');
    // A wrapped paragraph is many visual rows: mapping line index onto scrollHeight landed
    // far from the hit. CodeMirror scrolls to the laid-out position itself.
    await find(app, 'lorem', 20);
    await app.eval(() => findJumpTo(findState.matches.length - 1));
    await app.page.waitForFunction(() => !!document.querySelector('#source-cm .tz-src-hit.cur'), { timeout: 3000 }).catch(() => {});
    const jumped = await app.eval(() => {
        const mark = document.querySelector('#source-cm .tz-src-hit.cur');
        const sr = sourceEditor.view.scrollDOM.getBoundingClientRect();
        if (!mark) return { n: findState.matches.length, hasMark: false };
        const mr = mark.getBoundingClientRect();
        return { n: findState.matches.length, hasMark: true, inView: mr.bottom > sr.top + 2 && mr.top < sr.bottom - 2,
            markTop: Math.round(mr.top), viewTop: Math.round(sr.top), viewBottom: Math.round(sr.bottom) };
    });
    info('late jump: ' + JSON.stringify(jumped));
    assert(jumped.n > 20, 'the wrapping-paragraph query has enough hits (' + jumped.n + ')');
    assert(jumped.hasMark && jumped.inView, 'the current hit is drawn inside the visible part of Source');

    console.log('\n=== leaving Source takes the marks with it ===');
    await app.eval(() => handleCommand('view_set:mode:preview'));
    await app.page.waitForFunction(() => state.mode === 'wysiwyg', { timeout: 5000 });
    const left = await app.eval(() => ({ shown: isSourceShown(), marks: sourceEditor.searchMarks().length }));
    assert(!left.shown && left.marks === 0, 'Source is hidden and holds no marks (' + JSON.stringify(left) + ')');
}

// ---------------------------------------------------------------- textarea (mirror)
async function textareaChecks(app) {
    console.log('\n=== Ctrl+F paints, with focus in the find box ===');
    // Chromium paints no selection at all for an unfocused textarea, so before the mirror
    // this showed nothing whatsoever.
    await app.eval(() => handleCommand('find'));
    await sleep(400);
    await find(app, 'scroll', 2000);
    const typed = await app.eval(() => ({ matches: findState.matches.length, active: document.activeElement.id }));
    info('matches: ' + typed.matches + ', focus: ' + typed.active);
    assert(typed.matches > 2000, 'Ctrl+F found the hits (' + typed.matches + ')');
    assert(typed.active === 'findInput', 'focus is in the find box, not the textarea');

    const painted = await app.eval(() => {
        const layer = document.getElementById('source-highlights');
        if (!layer) return { layer: false };
        return { layer: true, visible: getComputedStyle(layer).display !== 'none',
            marks: layer.querySelectorAll('mark.tz-src-hit').length,
            current: layer.querySelectorAll('mark.tz-src-hit.cur').length };
    });
    assert(painted.layer, 'the mirror exists');
    assert(painted.visible, 'the mirror is visible');
    assert(painted.marks > 2000, 'every hit is marked (' + painted.marks + ')');
    assert(painted.current === 1, 'exactly one hit is the current one');

    console.log('\n=== the mirror lays out identically to the textarea ===');
    const geom = await app.eval(() => {
        const ta = sourceEditor, layer = document.getElementById('source-highlights');
        const tr = ta.getBoundingClientRect(), lr = layer.getBoundingClientRect();
        return { taH: ta.scrollHeight, layerH: layer.scrollHeight, dx: Math.abs(tr.left - lr.left),
            dy: Math.abs(tr.top - lr.top), textLen: ta.value.length };
    });
    info('scrollHeight ta=' + geom.taH + ' mirror=' + geom.layerH + ' over ' + geom.textLen + ' chars');
    assert(geom.taH === geom.layerH, 'identical laid-out height, so every line breaks in the same place');
    assert(geom.dx < 1 && geom.dy < 1, 'the boxes are in the same place');

    console.log('\n=== marks sit on the matched characters ===');
    const chars = await app.eval(() => {
        const ta = sourceEditor, marks = document.querySelectorAll('#source-highlights mark.tz-src-hit');
        let wrong = 0, checked = 0, firstBad = null;
        for (let i = 0; i < marks.length; i += 97) {
            const want = ta.value.slice(findState.matches[i].start, findState.matches[i].end);
            checked++;
            if (want !== marks[i].textContent) { wrong++; if (!firstBad) firstBad = { i, want, got: marks[i].textContent }; }
        }
        return { checked, wrong, firstBad };
    });
    info('sampled ' + chars.checked + ' marks across the document');
    assert(chars.wrong === 0, 'every sampled mark holds the matched text' + (chars.firstBad ? ' (first bad: ' + JSON.stringify(chars.firstBad) + ')' : ''));

    console.log('\n=== the mirror follows the textarea when it scrolls ===');
    await app.eval(() => { sourceEditor.scrollTop = 9000; sourceEditor.dispatchEvent(new Event('scroll')); });
    await sleep(200);
    const scrolled = await app.eval(() => ({ ta: Math.round(sourceEditor.scrollTop),
        layer: Math.round(document.getElementById('source-highlights').scrollTop) }));
    assert(scrolled.ta === scrolled.layer, 'mirror scrollTop tracks the textarea (' + scrolled.ta + ' / ' + scrolled.layer + ')');

    console.log('\n=== an edit does not leave stale marks ===');
    // The mirror holds its own copy of the text; same-length edits cannot be caught by a
    // length check, which is why editing invalidates outright.
    await app.eval(() => {
        const ta = sourceEditor;
        ta.focus(); ta.setSelectionRange(0, 0);
        ta.setRangeText('ZZZZ', 0, 0, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(800);
    const edited = await app.eval(() => {
        const layer = document.getElementById('source-highlights');
        return { after: layer.textContent.length, taLen: sourceEditor.value.length, head: layer.textContent.slice(0, 4) };
    });
    assert(edited.head === 'ZZZZ', 'the mirror picked up the edit');
    assert(edited.after === edited.taLen, 'the mirror holds exactly the textarea text');

    console.log('\n=== keyboard navigation moves the ring ===');
    const ringAt = () => app.eval(() => {
        const marks = document.querySelectorAll('#source-highlights mark.tz-src-hit');
        let ring = -1;
        for (let i = 0; i < marks.length; i++) if (marks[i].classList.contains('cur')) { ring = i; break; }
        return { ring, index: findState.index };
    });
    await app.eval(() => findJumpTo(20)); await sleep(300);
    const fromMouse = await ringAt();
    await app.eval(() => findStep(1)); await sleep(300);
    const afterDown = await ringAt();
    await app.eval(() => findStep(-1)); await sleep(300);
    const afterUp = await ringAt();
    info('ring/index ' + JSON.stringify({ fromMouse, afterDown, afterUp }));
    assert(fromMouse.ring === fromMouse.index, 'the ring is on the hit the mouse chose');
    assert(afterDown.index === fromMouse.index + 1 && afterDown.ring === afterDown.index, 'Down advanced it and the ring followed');
    assert(afterUp.ring === afterUp.index, 'the ring followed Up');

    console.log('\n=== clearing the query clears the marks ===');
    await app.eval(() => runFind('', false, { navigate: false }));
    await sleep(300);
    const cleared = await app.eval(() => {
        const layer = document.getElementById('source-highlights');
        return { display: getComputedStyle(layer).display, marks: layer.querySelectorAll('mark.tz-src-hit').length };
    });
    assert(cleared.marks === 0, 'no marks left behind');
    assert(cleared.display === 'none', 'the mirror is hidden');

    console.log('\n=== the mirror re-wraps when the pane resizes ===');
    // The textarea's width is a percentage of a pane the sidebar moves, so a resize reports
    // through no attribute at all; a stale width slides every mark off its word.
    await find(app, 'scroll', 0);
    const before = await app.eval(() => ({ ta: sourceEditor.scrollHeight, w: sourceEditor.clientWidth }));
    await app.eval((w) => { const wrap = document.getElementById('editor-wrapper'); wrap.dataset.prevWidth = wrap.style.width; wrap.style.width = w + 'px'; },
        Math.round(before.w * 0.6));
    await sleep(900);
    const after = await app.eval(() => ({ ta: sourceEditor.scrollHeight, layer: document.getElementById('source-highlights').scrollHeight,
        w: sourceEditor.clientWidth }));
    await app.eval(() => { const wrap = document.getElementById('editor-wrapper'); wrap.style.width = wrap.dataset.prevWidth || ''; });
    await sleep(600);
    info('width ' + before.w + ' -> ' + after.w + ', scrollHeight ta=' + after.ta + ' mirror=' + after.layer);
    assert(after.w < before.w, 'the textarea narrowed by layout alone');
    assert(after.ta > before.ta, 'narrowing it forced more wrapped rows');
    assert(after.ta === after.layer, 'the mirror re-wrapped with it (' + after.ta + ' / ' + after.layer + ')');

    console.log('\n=== jumping to a late match actually shows it ===');
    await find(app, 'lorem', 20);
    await app.eval(() => findJumpTo(findState.matches.length - 1));
    await sleep(400);
    const jumped = await app.eval(() => {
        const mark = document.querySelector('#source-highlights mark.tz-src-hit.cur');
        if (!mark) return { n: findState.matches.length, hasMark: false };
        const mr = mark.getBoundingClientRect(), tr = sourceEditor.getBoundingClientRect();
        return { n: findState.matches.length, hasMark: true, inView: mr.bottom > tr.top + 2 && mr.top < tr.bottom - 2 };
    });
    info('late jump: ' + JSON.stringify(jumped));
    assert(jumped.n > 20, 'the wrapping-paragraph query has enough hits (' + jumped.n + ')');
    assert(jumped.hasMark && jumped.inView, 'the current mark is inside the textarea viewport');

    console.log('\n=== leaving Source takes the marks with it ===');
    await app.eval(() => handleCommand('view_set:mode:preview'));
    await sleep(1200);
    const left = await app.eval(() => {
        const layer = document.getElementById('source-highlights');
        return layer ? getComputedStyle(layer).display : 'gone';
    });
    assert(left === 'none' || left === 'gone', 'no amber boxes stranded over the Preview editor (' + left + ')');
}

// ---------------------------------------------------------------- both surfaces
console.log('##### Source on codemirror (the default) #####');
let app = await openInSource();
try {
    const engine = await app.eval(() => window.__tzSourceEngine);
    assert(engine === 'codemirror', 'Source is on CodeMirror (' + engine + ')');
    if (engine === 'codemirror') await codemirrorChecks(app);
} finally { await app.close(); }

console.log('\n##### Source on textarea (TYPOZEN_SOURCE_ENGINE=textarea) #####');
assert(await untilNoTypoZen(15000), 'the first instance has exited before the second starts');
app = await openInSource('textarea');
try {
    const engine = await app.eval(() => window.__tzSourceEngine);
    assert(engine === 'textarea', 'Source is on the textarea (' + engine + ')');
    if (engine === 'textarea') await textareaChecks(app);
} finally { await app.close(); }
await untilNoTypoZen(15000);

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('SOURCE HIGHLIGHT FAILED'); process.exit(1); }
console.log('SOURCE HIGHLIGHT PASSED');
