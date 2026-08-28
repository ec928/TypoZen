/**
 * Source-mode search highlighting: the mirror must line up with the textarea.
 *
 * Source is a <textarea>, so the Custom Highlight API that marks Preview cannot reach
 * it and the marks are painted on a mirror div behind it. Every assertion here exists
 * because "it looked right in a screenshot" is exactly how a mirror rots: a font
 * change, a padding change or a wrap toggle slides every mark a few pixels and nothing
 * fails. So the checks are geometric, not visual.
 *
 * The load-bearing one is scrollHeight equality. If the mirror wrapped even one line
 * differently across a 200k-character document, its total laid-out height could not
 * match the textarea's -- so that single number covers every line break at once, which
 * no per-mark check could do.
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

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 5000, view: true });
try {
    await settledApp(app, 15000);
    await app.eval(() => handleCommand('view_set:mode:source'));
    await sleep(1500);

    console.log('\n=== Ctrl+F paints, with focus in the find box ===');
    // The case the whole feature exists for. Chromium paints no selection at all for an
    // unfocused textarea, so before the mirror this showed nothing whatsoever.
    await app.eval(() => handleCommand('find'));
    await sleep(400);
    const typed = await app.eval(async (q) => {
        const nap = (ms) => new Promise(r => setTimeout(r, ms));
        const input = document.getElementById('findInput');
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (findState.query === q && findState.matches.length > 0) break;
            await nap(150);
        }
        return { matches: findState.matches.length, active: document.activeElement.id };
    }, 'scroll');
    info('matches: ' + typed.matches + ', focus: ' + typed.active);
    assert(typed.matches > 2000, 'Ctrl+F found the hits (' + typed.matches + ')');
    assert(typed.active === 'findInput', 'focus is in the find box, not the textarea');

    const painted = await app.eval(() => {
        const layer = document.getElementById('source-highlights');
        if (!layer) return { layer: false };
        return {
            layer: true,
            visible: getComputedStyle(layer).display !== 'none',
            marks: layer.querySelectorAll('mark.tz-src-hit').length,
            current: layer.querySelectorAll('mark.tz-src-hit.cur').length
        };
    });
    assert(painted.layer, 'the mirror exists');
    assert(painted.visible, 'the mirror is visible');
    assert(painted.marks > 2000, 'every hit is marked (' + painted.marks + ')');
    assert(painted.current === 1, 'exactly one hit is the current one');

    console.log('\n=== the mirror lays out identically to the textarea ===');
    const geom = await app.eval(() => {
        const ta = document.getElementById('source-editor');
        const layer = document.getElementById('source-highlights');
        const tr = ta.getBoundingClientRect(), lr = layer.getBoundingClientRect();
        return {
            taH: ta.scrollHeight, layerH: layer.scrollHeight,
            taW: ta.clientWidth, layerW: layer.clientWidth,
            dx: Math.abs(tr.left - lr.left), dy: Math.abs(tr.top - lr.top),
            textLen: ta.value.length
        };
    });
    info('scrollHeight ta=' + geom.taH + ' mirror=' + geom.layerH + ' over ' + geom.textLen + ' chars');
    assert(geom.taH === geom.layerH,
        'identical laid-out height, so every line breaks in the same place');
    assert(geom.dx < 1 && geom.dy < 1, 'the boxes are in the same place');

    console.log('\n=== marks sit on the matched characters ===');
    // Compare each mark's own text to what findState says matched, in order. A mark that
    // has slid renders different characters, which no amount of pixel-eyeballing catches.
    const chars = await app.eval(() => {
        const ta = document.getElementById('source-editor');
        const layer = document.getElementById('source-highlights');
        const marks = layer.querySelectorAll('mark.tz-src-hit');
        let wrong = 0, checked = 0, firstBad = null;
        for (let i = 0; i < marks.length; i += 97) {          // spread across the document
            const want = ta.value.slice(findState.matches[i].start, findState.matches[i].end);
            const got = marks[i].textContent;
            checked++;
            if (want !== got) { wrong++; if (!firstBad) firstBad = { i, want, got }; }
        }
        return { checked, wrong, firstBad };
    });
    info('sampled ' + chars.checked + ' marks across the document');
    assert(chars.wrong === 0, 'every sampled mark holds the matched text'
        + (chars.firstBad ? ' (first bad: ' + JSON.stringify(chars.firstBad) + ')' : ''));

    console.log('\n=== the mirror follows the textarea when it scrolls ===');
    const scrolled = await app.eval(async () => {
        const nap = (ms) => new Promise(r => setTimeout(r, ms));
        const ta = document.getElementById('source-editor');
        const layer = document.getElementById('source-highlights');
        ta.scrollTop = 9000;
        ta.dispatchEvent(new Event('scroll'));
        await nap(200);
        return { ta: Math.round(ta.scrollTop), layer: Math.round(layer.scrollTop) };
    });
    assert(scrolled.ta === scrolled.layer,
        'mirror scrollTop tracks the textarea (' + scrolled.ta + ' / ' + scrolled.layer + ')');

    console.log('\n=== an edit does not leave stale marks ===');
    // The mirror holds its own copy of the text. Same-length edits cannot be caught by a
    // length check, which is why editing invalidates outright.
    const edited = await app.eval(async () => {
        const nap = (ms) => new Promise(r => setTimeout(r, ms));
        const ta = document.getElementById('source-editor');
        const layer = document.getElementById('source-highlights');
        const before = layer.textContent.length;
        ta.focus();
        ta.setSelectionRange(0, 0);
        ta.setRangeText('ZZZZ', 0, 0, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await nap(800);
        return { before, after: layer.textContent.length, taLen: ta.value.length,
                 head: layer.textContent.slice(0, 4) };
    });
    info('mirror text ' + edited.before + ' -> ' + edited.after + ', textarea ' + edited.taLen);
    assert(edited.head === 'ZZZZ', 'the mirror picked up the edit');
    assert(edited.after === edited.taLen, 'the mirror holds exactly the textarea text');

    console.log('\n=== keyboard navigation moves the ring ===');
    // findStep (Up/Down, and the find bar arrows) is a different path from findJumpTo
    // (the mouse). The ring followed the mouse and ignored the keyboard: the count and
    // the sidebar list moved on while the ring stayed where it was last clicked.
    const stepped = await app.eval(async () => {
        const nap = (ms) => new Promise(r => setTimeout(r, ms));
        const layer = document.getElementById('source-highlights');
        const ringed = () => {
            const marks = layer.querySelectorAll('mark.tz-src-hit');
            for (let i = 0; i < marks.length; i++) {
                if (marks[i].classList.contains('cur')) return i;
            }
            return -1;
        };
        findJumpTo(20);
        await nap(300);
        const fromMouse = { ring: ringed(), index: findState.index };
        findStep(1);
        await nap(300);
        const afterDown = { ring: ringed(), index: findState.index };
        findStep(-1);
        await nap(300);
        const afterUp = { ring: ringed(), index: findState.index };
        return { fromMouse, afterDown, afterUp };
    });
    info('ring/index ' + JSON.stringify(stepped));
    assert(stepped.fromMouse.ring === stepped.fromMouse.index,
        'the ring is on the hit the mouse chose');
    assert(stepped.afterDown.index === stepped.fromMouse.index + 1,
        'Down advanced the current hit');
    assert(stepped.afterDown.ring === stepped.afterDown.index,
        'the ring followed Down');
    assert(stepped.afterUp.ring === stepped.afterUp.index,
        'the ring followed Up');

    console.log('\n=== clearing the query clears the marks ===');
    // Alt+S closing the Search sidebar clears the query through runFind(''), which
    // returns before the per-surface branches -- so the marks used to survive it.
    const cleared = await app.eval(async () => {
        const nap = (ms) => new Promise(r => setTimeout(r, ms));
        runFind('', false, { navigate: false });
        await nap(300);
        const layer = document.getElementById('source-highlights');
        return { display: getComputedStyle(layer).display,
                 marks: layer.querySelectorAll('mark.tz-src-hit').length };
    });
    info('after clearing: display=' + cleared.display + ' marks=' + cleared.marks);
    assert(cleared.marks === 0, 'no marks left behind');
    assert(cleared.display === 'none', 'the mirror is hidden');

    console.log('\n=== the mirror re-wraps when the pane resizes ===');
    // The textarea's width is a percentage of a pane the sidebar moves, so a resize
    // reports through no attribute at all. A stale width re-wraps the mirror
    // differently and slides every mark off its word.
    const resized = await app.eval(async (q) => {
        const nap = (ms) => new Promise(r => setTimeout(r, ms));
        const input = document.getElementById('findInput');
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        let dl = Date.now() + 15000;
        while (Date.now() < dl) {
            if (findState.query === q && findState.matches.length > 0) break;
            await nap(150);
        }
        const ta = document.getElementById('source-editor');
        const layer = document.getElementById('source-highlights');
        const before = { ta: ta.scrollHeight, layer: layer.scrollHeight, w: ta.clientWidth };
        // Narrow the wrapper rather than pressing Alt+S: closing the Search sidebar also
        // clears the query, which would leave no marks to re-wrap and quietly assert
        // nothing. This is the same thing the sidebar does to the textarea -- a width
        // change with no attribute written on the textarea itself.
        const wrap = document.getElementById('editor-wrapper');
        const prev = wrap.style.width;
        wrap.style.width = Math.round(before.w * 0.6) + 'px';
        await nap(900);
        const after = { ta: ta.scrollHeight, layer: layer.scrollHeight, w: ta.clientWidth };
        wrap.style.width = prev;
        await nap(600);
        return { before, after };
    }, 'scroll');
    info('width ' + resized.before.w + ' -> ' + resized.after.w
        + ', scrollHeight ta=' + resized.after.ta + ' mirror=' + resized.after.layer);
    assert(resized.after.w < resized.before.w, 'the textarea narrowed by layout alone');
    assert(resized.after.ta > resized.before.ta, 'narrowing it forced more wrapped rows');
    assert(resized.after.ta === resized.after.layer,
        'the mirror re-wrapped with it (' + resized.after.ta + ' / ' + resized.after.layer + ')');

    console.log('\n=== leaving Source takes the marks with it ===');
    await app.eval(() => handleCommand('view_set:mode:preview'));
    await sleep(1200);
    const left = await app.eval(() => {
        const layer = document.getElementById('source-highlights');
        return layer ? getComputedStyle(layer).display : 'gone';
    });
    assert(left === 'none' || left === 'gone',
        'no amber boxes stranded over the Preview editor (' + left + ')');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('SOURCE HIGHLIGHT FAILED'); process.exit(1); }
console.log('SOURCE HIGHLIGHT PASSED');
