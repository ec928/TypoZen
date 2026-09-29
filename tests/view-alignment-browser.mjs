/**
 * Preview and Source lay text out in the same place, headless.
 *
 * On 2026-09-27 a switch between the two moved the text: Preview's started 8px further in
 * (.block's side padding on top of the page margin), Source's lines were closer together
 * (no block padding or paragraph gap), and Source stopped 48px above the bottom of the pane.
 * Source now spaces each line as Preview spaces its block -- text, blank, list item, code
 * file -- and every line must sit at the same top, left and right in both views, before
 * and after scrolling. Preview's own layout is left alone: making its blank lines taller
 * moved page breaks in books (theme-anchor-browser caught it).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const deadline = setTimeout(() => { console.error('VIEW ALIGNMENT: deadline'); process.exit(3); }, 45000);
const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof finishLoadContent === 'function', { timeout: 15000 });

    // Line boxes in both views for `md`, Preview scrolled so hard line `at` is on top first.
    // Waits outlast the wrapper's 0.3s padding transition.
    const measure = (md, at, ext) => page.evaluate(async (md, at, ext) => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        setSourceDocExt(ext);
        finishLoadContent(md, false, false);
        if (state.mode !== 'wysiwyg') handleCommand('view_set:mode:preview');
        await wait(450);
        const mc = document.getElementById('main-container');
        const blocks = document.querySelectorAll('#editor .block');
        if (at > 1) { mc.scrollTop += blocks[at - 1].getBoundingClientRect().top - mc.getBoundingClientRect().top; await wait(100); }
        const box = mc.getBoundingClientRect();
        const textLeft = (el) => {
            const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
            while ((n = w.nextNode()) && !n.nodeValue.trim()) {}
            if (!n) return null;
            // The first visible character: Source's highlighter splits indentation into its
            // own text node, Preview does not.
            const i = n.nodeValue.search(/\S/);
            const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
            return Math.round(r.getBoundingClientRect().left - box.left);
        };
        const pv = Array.from(blocks).map(b => {
            const r = b.getBoundingClientRect();
            return { top: Math.round(r.top - box.top), x: textLeft(b), right: Math.round(r.right - parseFloat(getComputedStyle(b).paddingRight) - box.left) };
        });
        handleCommand('view_set:mode:source');
        await wait(450);
        // CodeMirror draws only the lines near the view; key them by document line.
        const sv = {};
        for (const l of document.querySelectorAll('#source-cm .cm-line')) {
            const view = sourceEditor.view, n = view.state.doc.lineAt(view.posAtDOM(l, 0)).number;
            const r = l.getBoundingClientRect();
            sv[n] = { top: Math.round(r.top - box.top), x: textLeft(l), right: Math.round(r.right - box.left) };
        }
        const bottomGap = Math.round(box.bottom - document.getElementById('source-cm').getBoundingClientRect().bottom);
        handleCommand('view_set:mode:preview');
        await wait(450);
        return { pv, sv, bottomGap };
    }, md, at, ext || 'md');

    // Compare every line Source drew that is on screen. List lines differ in x by design:
    // Preview draws a bullet where Source shows the literal "- ".
    const compare = (name, r, skipX) => {
        const bad = [];
        let n = 0;
        for (const [k, s] of Object.entries(r.sv)) {
            const p = r.pv[k - 1];
            if (!p || s.top < 0 || s.top > 760) continue;
            n++;
            if (p.top !== s.top || p.right !== s.right || (!skipX(k) && p.x !== s.x))
                bad.push('line ' + k + ' preview ' + p.top + '/' + p.x + '/' + p.right + ' source ' + s.top + '/' + s.x + '/' + s.right);
        }
        assert(n >= 5 && !bad.length, name + ': ' + n + ' lines at the same top/left/right' + (bad.length ? ' -- ' + bad.slice(0, 3).join('; ') : ''));
    };

    const long = 'word '.repeat(60).trim();
    const prose = 'Line one\nLine two\n\nPara after blank\n\n\nTwo blanks\n' + long + '\nEnd';
    let r = await measure(prose, 1);
    compare('plain lines, blank lines and a wrapped line', r, () => false);
    assert(Math.abs(r.bottomGap) <= 1, 'Source runs to the bottom of the pane (gap ' + r.bottomGap + 'px)');

    const list = 'Intro\n- one\n- two\n  - nested\n1. first\n2. second\n\nAfter';
    r = await measure(list, 1);
    compare('list items pack as tightly in Source as in Preview', r, (k) => k >= 2 && k <= 6);

    const doc = Array.from({ length: 120 }, (_, i) => i % 7 === 3 ? '' : 'L' + i + ' ' + (i % 3 ? 'word '.repeat(30).trim() : 'short')).join('\n');
    r = await measure(doc, 55);
    compare('scrolled to line 55, the switch keeps every line in place', r, () => false);

    // Ed's steps, 2026-09-27: open a 4000-line file in Source (showing line 1), switch to
    // Preview -- it opened at line 3979, because the switch took the largest of the view's
    // line and the caret's, and the caret had been left at the end of the file.
    const big = Array.from({ length: 4000 }, (_, i) => 'Line ' + (i + 1) + ' of 4000').join('\n');
    const topAfter = await page.evaluate(async (big) => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        const mc = document.getElementById('main-container');
        const previewTop = () => {
            const b = Array.from(document.querySelectorAll('#editor .block'))
                .find(x => x.getBoundingClientRect().bottom > mc.getBoundingClientRect().top + 1);
            return b ? b.textContent : null;
        };
        const sourceTop = () => 'Line ' + sourceEditor.topLine() + ' of 4000';
        const caretLine = () => sourceEditor.value.slice(0, sourceEditor.selectionStart).split('\n').length;
        const out = {};
        setSourceDocExt('md');
        handleCommand('view_set:mode:source');
        await wait(300);
        finishLoadContent(big, false, false);            // a file opened while in Source
        await wait(300);
        out.caretOnOpen = caretLine();
        handleCommand('view_set:mode:preview'); await wait(600);
        out.previewAfterOpen = previewTop();
        handleCommand('view_set:mode:source'); await wait(450);
        out.sourceBack = sourceTop();
        // Scrolled in Source without clicking: the caret stays on line 1.
        sourceEditor.scrollToOffset(sourceOffsetAtHardLine(sourceEditor.value, 1500), 0);
        await wait(200);
        handleCommand('view_set:mode:preview'); await wait(600);
        out.previewAfterScroll = previewTop();
        // And back, with Preview's caret left near the top.
        handleCommand('view_set:mode:source'); await wait(450);
        out.sourceAfterScroll = sourceTop();
        handleCommand('view_set:mode:preview'); await wait(450);
        // A document small enough that Preview mounts every block: Source -> Preview exact.
        const small = Array.from({ length: 120 }, (_, i) => 'Line ' + (i + 1) + ' of 4000').join('\n');
        handleCommand('view_set:mode:source'); await wait(450);
        finishLoadContent(small, false, false); await wait(300);
        sourceEditor.scrollToOffset(sourceOffsetAtHardLine(sourceEditor.value, 60), 0);
        await wait(200);
        handleCommand('view_set:mode:preview'); await wait(600);
        out.smallPreview = previewTop();
        const b60 = document.querySelector('#editor .block[data-model-index="59"]');
        out.smallTop = b60 ? Math.round(b60.getBoundingClientRect().top - mc.getBoundingClientRect().top) : null;
        return out;
    }, big);
    const lineOf = (s) => parseInt(String(s).replace(/\D+/, ''), 10);
    assert(topAfter.caretOnOpen === 1, 'a file opened in Source puts the caret on line 1 (got ' + topAfter.caretOnOpen + ')');
    assert(topAfter.previewAfterOpen === 'Line 1 of 4000' && topAfter.sourceBack === 'Line 1 of 4000',
        'opened in Source at line 1: Preview and back to Source stay on line 1 (got ' + topAfter.previewAfterOpen + ' / ' + topAfter.sourceBack + ')');
    // A document this size is virtualised in Preview. It used to land ~100px (3-5 lines) low:
    // block heights were recorded without the paragraph gap, 3px short per mounted block
    // (blockOuterHeight, 05-model.js; fixed 2026-09-29). Now exact, as for small documents.
    assert(topAfter.previewAfterScroll === 'Line 1500 of 4000' && topAfter.sourceAfterScroll === 'Line 1500 of 4000',
        'scrolled to line 1500 without moving the caret: both views are on line 1500 (got ' + topAfter.previewAfterScroll + ' / ' + topAfter.sourceAfterScroll + ')');
    assert(topAfter.smallPreview === 'Line 60 of 4000' && Math.abs(topAfter.smallTop) <= 1,
        'fully mounted Preview: Source at line 60 opens Preview with line 60 at the top (got ' + topAfter.smallPreview + ', line 60 at ' + topAfter.smallTop + 'px)');

    // A tab switch: the host sends the mode first, then the new tab's text (by fetch when it
    // is large, ~30 ms later). The mode switch's late restores used to land on the new
    // document -- Source at line 3904 of one file opened the other tab at 3904 (2026-09-27).
    const carried = await page.evaluate(async (big) => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        setSourceDocExt('html'); handleCommand('view_set:mode:source');
        finishLoadContent(big, false, false); await wait(300);
        sourceEditor.scrollToOffset(sourceOffsetAtHardLine(sourceEditor.value, 3904), 0); await wait(300);
        handleCommand('view_set:mode:preview');
        setSourceDocExt('md');
        setTimeout(() => finishLoadContent(Array.from({ length: 4000 }, (_, i) => 'Other ' + (i + 1)).join('\n'), false, false), 30);
        await wait(1000);
        const mc = document.getElementById('main-container');
        const b = Array.from(document.querySelectorAll('#editor .block')).find(x => x.getBoundingClientRect().bottom > mc.getBoundingClientRect().top + 1);
        return b ? b.textContent : null;
    }, Array.from({ length: 6000 }, (_, i) => '<p>Line ' + (i + 1) + '</p>').join('\n'));
    assert(carried === 'Other 1', 'a tab switch opens the new document at its own top, not the old one\'s line (got ' + carried + ')');

    // Source tells the host where it is (book_position:), as Preview does: after a load and
    // after scrolling. It never did, so a tab left in Source came back at an old Preview
    // report's line -- the top of an HTML file reopened at 3904 (2026-09-27).
    const reports = await page.evaluate(async () => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        const sent = [];
        const real = postMsg;
        window.postMsg = postMsg = function (m) { if (String(m).startsWith('book_position:')) sent.push(parseInt(String(m).slice(14), 10)); return real.apply(this, arguments); };
        setSourceDocExt('md'); handleCommand('view_set:mode:source');
        finishLoadContent(Array.from({ length: 3000 }, (_, i) => 'Row ' + (i + 1)).join('\n'), false, false);
        await wait(1600);
        const atLoad = sent.slice();
        sourceEditor.scrollToOffset(sourceOffsetAtHardLine(sourceEditor.value, 2000), 0);
        await wait(1600);
        window.postMsg = postMsg = real;
        handleCommand('view_set:mode:preview');
        return { atLoad, afterScroll: sent.slice(atLoad.length) };
    });
    assert(reports.atLoad.includes(0), 'Source reports its position after a load (' + JSON.stringify(reports.atLoad) + ')');
    assert(reports.afterScroll.some(b => Math.abs(b - 1999) <= 1), 'and after scrolling to line 2000 (' + JSON.stringify(reports.afterScroll) + ')');

    r = await measure('const a = 1;\n\nfunction f() {\n  return a;\n}\n\n\n// end', 1, 'js');
    // Line 4 is indented. Preview used to collapse its leading spaces, so it was excused
    // here; a code file now keeps them in Preview (body.tz-code-doc), so it must line up too.
    compare('a code file, blank lines and indentation included', r, () => false);
    assert(r.pv[3] && r.pv[0] && r.pv[3].x > r.pv[0].x + 5,
        'Preview shows a code line\'s indentation (' + (r.pv[3] && r.pv[3].x) + ' vs ' + (r.pv[0] && r.pv[0].x) + ')');
} finally {
    await browser.close();
    clearTimeout(deadline);
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('VIEW ALIGNMENT FAILED'); process.exit(1); }
console.log('VIEW ALIGNMENT PASSED');
