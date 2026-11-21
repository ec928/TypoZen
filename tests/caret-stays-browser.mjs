/**
 * A block format leaves the caret where the user put it (Ed, 2026-11-21).
 *
 * The rule (README-level, agreed with Ed): Heading, Quote, Normal Text, the lists and
 * Callout keep the caret -- or a selection -- at the same point in the user's text,
 * whatever markers appear or disappear around it. A point inside a marker that goes lands
 * where the text resumes. Undo puts the caret or selection back exactly as it was before
 * the format; redo exactly as it was after. Preview (Reveal on and off) and Source.
 *
 * Until 0.21.16 every block format sent the caret to the end of the line, a retreat from
 * carets that landed at the start of the line or elsewhere (a reload's deferred restore
 * put it at offset 0 when the remount lost it).
 *
 * The caret is placed by keys (click, Home, arrows, Shift+arrows), at random points and
 * across lines in both directions; the format is applied by its shortcut, by the host's
 * fmt: message, or the way the right-click menu does it (the page loses its selection to
 * the menu first). The oracle is independent of the code under test: the point's line is
 * found by its text without markers, and the point must sit the same distance into that
 * text (or at its start, if it was inside a marker).
 *
 *   node tests/caret-stays-browser.mjs            (CASES=n per combination, SEED=n)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = parseInt(process.env.CASES || '15', 10);
let seed = parseInt(process.env.SEED || '20261121', 10);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const deadline = setTimeout(() => { console.error('  FAIL over budget (240 s)'); process.exit(1); }, 240000);

const DOC = [
    'Alpha line one',
    'Beta line two',
    'Gamma line three',
    '',
    '## Heading here',
    '> quoted text here',
    '',
    '- item one here',
    '1. numbered item here',
    '- [ ] task item here',
    '',
    '> [!NOTE] Title words',
    '> inside callout line',
    '',
    'Delta with **bold** word'
].join('\n');
// Lines a point may be put on (not blank).
const LINES = DOC.split('\n').map((l, i) => l.trim() ? i : -1).filter(i => i >= 0);
const TYPES = ['h1', 'h2', 'h3', 'quote', 'list', 'ol', 'checklist', 'para', 'callout:note', 'callout:tip'];

// Markers at the start of a line, as Source (and Reveal) show them.
const MARKER = /^(?:[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+|\[![A-Za-z]+\][ \t]*))*/;
const body = (t) => String(t).slice(String(t).match(MARKER)[0].length);

let passed = 0, failed = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) { passed++; return; }
    failed++;
    if (failures.length < 25) failures.push('  FAIL ' + label + (detail ? '\n       ' + detail : ''));
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    page.on('pageerror', e => { failed++; failures.push('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
        window.__host = (m) => window.__L.forEach(fn => fn({ data: m }));
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });

    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));

    // Each line of the document as its own line of text, in both modes: Source lines, or
    // Preview's model lines (one per Markdown line here) with the text the page shows.
    const readState = () => page.evaluate(() => {
        if (state.mode === 'source') {
            const v = sourceEditor.value, lines = v.split('\n');
            const at = (pos) => {
                let n = 0, ls = 0;
                for (let i = 0; i < pos; i++) if (v.charCodeAt(i) === 10) { n++; ls = i + 1; }
                return { line: n, off: pos - ls };
            };
            const s = sourceEditor.selectionStart, e = sourceEditor.selectionEnd, back = sourceEditor.selectionDirection === 'backward';
            return { md: v, lines, a: at(back ? e : s), f: at(back ? s : e) };
        }
        const blocks = [...document.querySelectorAll('#editor .block[data-model-index]')];
        const lines = [];
        blocks.forEach(b => { lines[+b.getAttribute('data-model-index')] = b.textContent || ''; });
        const sel = getSelection();
        const pt = (node, off) => {
            const b = node && getAncestorBlock(node);
            if (!b) return null;
            const r = document.createRange(); r.selectNodeContents(b); r.setEnd(node, off);
            return { line: +b.getAttribute('data-model-index'), off: r.toString().length };
        };
        return { md: getMarkdownContent(false), lines,
            a: sel.rangeCount ? pt(sel.anchorNode, sel.anchorOffset) : null, f: sel.rangeCount ? pt(sel.focusNode, sel.focusOffset) : null };
    });

    // Put the caret on line `line`, `off` characters in, by keys.
    const caretTo = async (mode, line, off) => {
        if (mode === 'source') {
            await page.evaluate((l) => {
                const v = sourceEditor.value; let p = 0;
                for (let i = 0; i < l; i++) p = v.indexOf('\n', p) + 1;
                sourceEditor.focus(); sourceEditor.setSelectionRange(p, p);
            }, line);
        } else {
            const box = await page.evaluate((l) => {
                const b = document.querySelector('#editor .block[data-model-index="' + l + '"]');
                b.scrollIntoView({ block: 'center' });
                const r = b.getBoundingClientRect();
                return { x: r.left + 4, y: r.top + Math.min(r.height / 2, 12) };
            }, line);
            await page.mouse.click(box.x, box.y);
        }
        await page.keyboard.press('Home');
        for (let i = 0; i < off; i++) await page.keyboard.press('ArrowRight');
    };
    const shiftTo = async (fromLine, toLine, off) => {
        await page.keyboard.down('Shift');
        const k = toLine > fromLine ? 'ArrowDown' : 'ArrowUp';
        for (let i = 0; i < Math.abs(toLine - fromLine); i++) await page.keyboard.press(k);
        await page.keyboard.press('Home');
        for (let i = 0; i < off; i++) await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
    };

    const apply = async (route, type) => {
        if (route === 'key') {
            await page.keyboard.down('Control'); await page.keyboard.press('Digit' + type.slice(1)); await page.keyboard.up('Control');
        } else if (route === 'host') {
            await page.evaluate((t) => window.__host('fmt:' + t), type);
        } else {
            // The right-click menu: contextmenu, then the menu takes the keyboard and the
            // page's selection goes; the command arrives; the menu closes and gives it back.
            await page.evaluate(() => {
                const s = getSelection();
                const n = s.focusNode && (s.focusNode.nodeType === 1 ? s.focusNode : s.focusNode.parentElement);
                if (n) n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
                if (document.activeElement) document.activeElement.blur();
                if (state.mode !== 'source') s.removeAllRanges();
            });
            await quiet();
            await page.evaluate((t) => window.__host('fmt:' + t), type);
            await quiet();
            await page.evaluate(() => window.__host('cmd:restore_editor_focus'));
        }
        await quiet();
    };

    // Where a point taken before the format must be after it (the oracle).
    const expected = (before, after, p) => {
        const t0 = before.lines[p.line] || '';
        const m0 = t0.length - body(t0).length;
        const want = body(t0);
        const hits = [];
        after.lines.forEach((t, i) => { if (t != null && body(t) === want) hits.push(i); });
        if (hits.length !== 1) return null;
        const t1 = after.lines[hits[0]];
        // A line the format left as it was (a callout's header takes no heading): the point stays.
        if (t1 === t0) return { line: hits[0], off: p.off };
        const m1 = t1.length - body(t1).length;
        return { line: hits[0], off: p.off >= m0 ? m1 + (p.off - m0) : m1 };
    };
    const same = (x, y) => x && y && x.line === y.line && x.off === y.off;
    const show = (p) => p ? p.line + ':' + p.off : 'none';

    // A long file is only partly mounted (the scroll window), and 2-Col lays lines out by
    // page: the layouts where carets have gone missing before.
    const LONG = DOC + '\n\n' + Array.from({ length: 3000 }, (_, i) => 'Filler line ' + i).join('\n');
    const combos = [
        ['wysiwyg', false, 1, DOC], ['wysiwyg', true, 1, DOC], ['source', false, 1, DOC],
        ['wysiwyg', false, 1, LONG], ['wysiwyg', false, 2, DOC], ['wysiwyg', true, 2, LONG], ['source', false, 1, LONG]
    ];
    let cases = 0;
    for (const [mode, reveal, cols, doc] of combos) {
        for (let c = 0; c < CASES; c++) {
            const type = pick(TYPES);
            const route = /^h\d$/.test(type) && rnd() < 0.4 ? 'key' : pick(['host', 'menu']);
            await page.evaluate((d, m, rv, n) => {
                state.revealOnFocus = rv;
                setSourceDocExt('md');
                handleCommand('view_set:columns:' + n);
                handleCommand('view_set:mode:' + m);
                loadMarkdownContent(d);
                HistoryManager.resetToCurrent && HistoryManager.resetToCurrent();
            }, doc, mode, reveal, cols);
            await quiet();
            if (doc === LONG || cols === 2) await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
            // A caret or a selection, by keys.
            const l1 = pick(LINES);
            await caretTo(mode, l1, 0);
            let st = await readState();
            const len1 = (st.lines[l1] || '').length;
            const o1 = Math.floor(rnd() * (len1 + 1));
            await caretTo(mode, l1, o1);
            if (rnd() < 0.4) {
                const near = LINES.filter(i => i !== l1 && Math.abs(i - l1) <= 3);
                const l2 = pick(near.length ? near : [l1]);
                const len2 = ((await readState()).lines[l2] || '').length;
                await shiftTo(l1, l2, Math.floor(rnd() * (len2 + 1)));
            }
            await quiet();
            const before = await readState();
            if (!before.a || !before.f) { check('premise: a caret was placed', false); continue; }
            const label = mode + (reveal ? '+reveal' : '') + (cols === 2 ? '+2col' : '') + (doc === LONG ? '+long' : '')
                + ' ' + type + ' by ' + route
                + ' at ' + show(before.a) + (same(before.a, before.f) ? '' : '..' + show(before.f));
            const skipA = !body(before.lines[before.a.line] || ''), skipF = !body(before.lines[before.f.line] || '');

            await apply(route, type);
            const after = await readState();
            const changed = after.md !== before.md;
            if (!changed) {
                check(label + ': nothing changed, nothing moved', same(after.a, before.a) && same(after.f, before.f),
                    'got ' + show(after.a) + '..' + show(after.f));
                cases++;
                continue;
            }
            if (!skipA) {
                const wa = expected(before, after, before.a);
                if (wa) check(label + ': anchor', same(after.a, wa), 'got ' + show(after.a) + ' want ' + show(wa)
                    + '  line now ' + JSON.stringify(after.lines[wa.line]));
            }
            if (!skipF) {
                const wf = expected(before, after, before.f);
                if (wf) check(label + ': focus', same(after.f, wf), 'got ' + show(after.f) + ' want ' + show(wf)
                    + '  line now ' + JSON.stringify(after.lines[wf.line]));
            }
            // Undo: exactly as before. Redo: exactly as after.
            await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
            await quiet();
            const undone = await readState();
            check(label + ': undo restores the text', undone.md === before.md,
                'got  ' + JSON.stringify(undone.md) + '\n       want ' + JSON.stringify(before.md));
            check(label + ': undo puts the caret back', same(undone.a, before.a) && same(undone.f, before.f),
                'got ' + show(undone.a) + '..' + show(undone.f) + ' want ' + show(before.a) + '..' + show(before.f));
            await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control');
            await quiet();
            const redone = await readState();
            check(label + ': redo puts the caret where the format did', same(redone.a, after.a) && same(redone.f, after.f),
                'got ' + show(redone.a) + '..' + show(redone.f) + ' want ' + show(after.a) + '..' + show(after.f));
            // And the next letter goes there.
            if (same(after.a, after.f) && !skipA) {
                await page.keyboard.type('Q');
                await quiet();
                const typed = await readState();
                const t = typed.lines[after.a.line] || '';
                const t0 = redone.lines[after.a.line] || '';
                check(label + ': a letter typed lands at the caret',
                    t === t0.slice(0, after.a.off) + 'Q' + t0.slice(after.a.off), 'line now ' + JSON.stringify(t));
            }
            cases++;
        }
        console.log('  .. ' + mode + (reveal ? '+reveal' : '') + (cols === 2 ? '+2col' : '') + (doc === LONG ? '+long' : '') + ' done');
    }
    console.log('  ' + cases + ' cases');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
failures.forEach(f => console.error(f));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
