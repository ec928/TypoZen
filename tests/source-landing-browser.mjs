/**
 * Source lands where it should: switching modes keeps the line, and typewriter mode keeps
 * the caret.
 *
 * docs/codemirror-source-plan.md, Phase 2. On CodeMirror, Source reads and sets its
 * scroll position by real line layout (sourceEditor.topLine(), scrollToOffset); on the
 * textarea it can only estimate from the scroll fraction, which a wrapped paragraph
 * throws off. So the line checks are asserted on CodeMirror and recorded on the textarea.
 *
 * Typewriter mode is asserted on both: it scrolls on every caret move, and until
 * 2026-09-27 it also put the caret at the start of its line every time, on both surfaces.
 *
 *   node tests/source-landing-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const MD = fs.readFileSync(path.join(__dirname, 'large-scroll-mixed.md'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const deadline = setTimeout(() => { console.error('DEADLINE'); process.exit(3); }, 90000);
const browser = await puppeteer.launch({ headless: 'new' });
try {
  for (const engine of ['codemirror', 'textarea']) {
    console.log('\n##### Source on ' + engine + ' #####');
    const exact = engine === 'codemirror';
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/') + '?source=' + engine, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof finishLoadContent === 'function', { timeout: 15000 });
    assert((await page.evaluate(() => window.__tzSourceEngine)) === engine, 'Source is on ' + engine);
    await page.evaluate((md) => { finishLoadContent(md, false, false); }, MD);
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await page.waitForFunction(() => state.mode === 'source', { timeout: 5000 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))));

    console.log('=== the line put at the top is the line read back ===');
    for (const want of [900, 2000, 3500]) {
        await page.evaluate((n) => scrollSourceToHardLine(n, false), want);
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))));
        const got = await page.evaluate(() => hardLineFromSourceScrollTop());
        info('line ' + want + ' -> read back ' + got);
        if (exact) assert(Math.abs(got - want) <= 1, 'line ' + want + ' reads back as ' + got);
    }

    console.log('=== typewriter mode scrolls without moving the caret ===');
    const tw = await page.evaluate(() => {
        state.typewriterMode = true;
        const v = sourceEditor.value;
        // Mid-line on a line long enough to have a middle, so "moved to the line start"
        // is a difference the check can see.
        let line = 2500, ls = 0, le = 0;
        for (; line < 2600; line++) {
            ls = sourceOffsetAtHardLine(v, line);
            le = v.indexOf('\n', ls); if (le < 0) le = v.length;
            if (le - ls > 10) break;
        }
        const at = ls + 5;
        sourceEditor.focus();
        sourceEditor.setSelectionRange(at, at);
        const before = sourceEditor.selectionStart;
        applyTypewriterScroll(true);
        return { line, lineStart: ls, before, after: sourceEditor.selectionStart };
    });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))));
    assert(tw.before === tw.lineStart + 5, 'premise: the caret is mid-line on line ' + tw.line);
    assert(tw.after === tw.before, 'the caret stays where it was (' + tw.before + ' -> ' + tw.after + ')');
    if (exact) {
        const c = await page.evaluate(() => {
            const v = sourceEditor.view, r = v.coordsAtPos(sourceEditor.selectionStart), s = v.scrollDOM.getBoundingClientRect();
            return r ? { frac: ((r.top + r.bottom) / 2 - s.top) / s.height } : null;
        });
        info('caret at ' + (c ? Math.round(c.frac * 100) : '?') + '% of the view height');
        assert(c && c.frac > 0.35 && c.frac < 0.65, 'the caret\'s line is centred');
    }
    await page.evaluate(() => { state.typewriterMode = false; });

    console.log('=== Source -> Preview keeps the line on screen ===');
    await page.evaluate(() => { scrollSourceToHardLine(1500, false); });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))));
    const srcTop = await page.evaluate(() => hardLineFromSourceScrollTop());
    await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); handleCommand('view_set:mode:preview'); });
    await page.waitForFunction(() => state.mode === 'wysiwyg', { timeout: 5000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
    // "Keeps the line" means the line is on screen. Preview's own reading
    // (hardLineFromPreviewViewport) is the START line of the block at the view's CENTRE, so a
    // number comparison against Source's top line is off by a block's length on a correct
    // landing -- ask whether the line's block is inside the visible pane instead.
    const pv = await page.evaluate((line) => {
        const bi = modelLocationFromDocumentLine(line).blockIndex;
        const el = document.querySelector('#editor .block[data-model-index="' + bi + '"]');
        const c = document.getElementById('main-container').getBoundingClientRect();
        if (!el) return { bi, mounted: false, centre: hardLineFromPreviewViewport() };
        const r = el.getBoundingClientRect();
        return { bi, mounted: true, visible: r.bottom > c.top + 4 && r.top < c.bottom - 4, top: Math.round(r.top - c.top),
            centre: hardLineFromPreviewViewport() };
    }, srcTop);
    info('Source top ' + srcTop + ' -> Preview: block ' + pv.bi + (pv.mounted ? ' at ' + pv.top + 'px' : ' not mounted') + ', centre line ' + pv.centre);
    if (exact) assert(pv.mounted && pv.visible, 'Preview shows line ' + srcTop);

    console.log('=== Preview -> Source keeps the line on screen ===');
    await page.evaluate(() => restoreStickyDocumentLine(3000, true));
    await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
    const pv2 = await page.evaluate(() => hardLineFromPreviewViewport());
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await page.waitForFunction(() => state.mode === 'source', { timeout: 5000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
    const src2 = await page.evaluate(() => hardLineFromSourceScrollTop());
    info('Preview (centre block starts at line ' + pv2 + ') -> Source top ' + src2);
    if (exact) {
        // Line 3000 was restored in Preview; Source must show it.
        const shown = await page.evaluate((line) => {
            const v = sourceEditor.view, s = v.scrollDOM.getBoundingClientRect();
            const r = v.coordsAtPos(v.state.doc.line(line).from);
            return !!r && r.bottom > s.top && r.top < s.bottom;
        }, 3000);
        assert(shown, 'Source shows line 3000 (top line ' + src2 + ')');
    }
    await page.close();
  }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SOURCE LANDING FAILED'); process.exit(1); }
console.log('SOURCE LANDING PASSED');
