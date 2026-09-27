/**
 * Source-mode search highlighting.
 *
 * Source draws its search marks as CodeMirror decorations on the real text
 * (js/modules/01a-source.js; docs/codemirror-source-plan.md). The reader's promises: every
 * hit marked, the marks on the matched characters, the ring on the current hit and
 * following the keyboard, no stale marks after an edit, a late jump actually shown, and
 * nothing left behind on leaving Source. Decorations cannot drift, so the checks read them
 * back (sourceEditor.searchMarks()) against findState.matches, and the rendered marks' own
 * text against the document.
 *
 * (Until Phase 4 this suite also covered the textarea's painted mirror, with geometric
 * checks; the textarea and its mirror are gone.)
 *
 *   RUN_APP_E2E=1 node tests/source-highlight-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';
import { settledApp } from './settle.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const FILE = 'tests/large-scroll-mixed.md';

async function openInSource() {
    const app = await launchApp({ file: FILE, settleMs: 5000, view: true });
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

// ---------------------------------------------------------------- run
const app = await openInSource();
try {
    assert(await app.eval(() => !!document.querySelector('#source-cm .cm-editor')), 'Source is CodeMirror, mounted in #source-cm');
    await codemirrorChecks(app);
} finally { await app.close(); }

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('SOURCE HIGHLIGHT FAILED'); process.exit(1); }
console.log('SOURCE HIGHLIGHT PASSED');
