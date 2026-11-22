/**
 * Edits on real documents, large first, in every layout: what must always hold (2026-11-22).
 *
 * The editing bugs live where Preview holds only a window of a long document, so this sweeps a
 * LARGE document (large-scroll-mixed.md, 4,582 lines, past the windowing thresholds) in
 * 1-column, 2-column and two-page Preview, and then the README once, small, as the quick
 * check of the easy case (Ed, 2026-11-22: "use large documents for most edit testing, THEN a
 * quick check on the small doc"). Real keys at seeded positions; for every edit:
 *   - the caret is still in a line that is in the page, and the next typed letter lands
 *     exactly once, beside the edit (0.22.8: Delete on an empty line of a long document left
 *     no caret at all, and the next letter went nowhere);
 *   - only lines near the edit change;
 *   - Undo gives the file back exactly;
 *   - a block format at a caret gives the same file in Preview as in Source.
 * Seeded, so a failure repeats.
 *
 *   node tests/cross-mode-sweep-browser.mjs     (about 90 s; SWEEP_PER=2+ for more positions, SWEEP_SEED=n)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.TZ_ROOT || path.join(here, '..');
const PER = +(process.env.SWEEP_PER || 1);
let seed = +(process.env.SWEEP_SEED || 20261122);
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const deadline = setTimeout(() => { console.error('  FAIL over budget (280 s)'); report(); process.exit(1); }, 280000);
const LAYOUTS = {
    '1-column': ['view_set:columns:1', 'view_set:scroll:scroll'],
    '2-column': ['view_set:columns:2', 'view_set:scroll:scroll'],
    'two pages': ['view_set:columns:2', 'view_set:scroll:pagination'],
};
// On a line of text (caret at a seeded offset), and on an empty line between lines of text.
const TEXT_EDITS = ['type', 'enter', 'enter-at-end', 'delete-at-end', 'backspace-start', 'over-word', 'over-2-lines', 'paste-plain-2', 'paste-rich', 'bold-word', 'h2', 'quote', 'list'];
const EMPTY_EDITS = ['delete-on-empty', 'backspace-on-empty', 'enter-on-empty', 'type-on-empty'];
// On a heading, quote, bullet, task or numbered line: its own handlers (marker strip, outdent,
// renumbering) run for these keys.
const MARKER_EDITS = ['backspace-start', 'enter-at-end', 'delete-at-end', 'type', 'enter'];
const BLOCK = new Set(['h2', 'quote', 'list']);
const RUNS = [
    { file: path.join(here, 'large-scroll-mixed.md'), name: 'large', layouts: Object.keys(LAYOUTS), per: PER },
    { file: path.join(here, '..', 'README.md'), name: 'README', layouts: ['1-column'], per: 1 },
];
let passed = 0, failed = 0; const fails = [];
function fail(msg) { failed++; fails.push(msg); console.error('  FAIL ' + msg); }
function report() { console.log(`\n${passed} passed, ${failed} failed`); }
function region(a, b) {
    const A = a.split('\n'), Bl = b.split('\n');
    let p = 0; while (p < A.length && p < Bl.length && A[p] === Bl[p]) p++;
    let s = 0; while (s < A.length - p && s < Bl.length - p && A[A.length - 1 - s] === Bl[Bl.length - 1 - s]) s++;
    return { from: p, to: A.length - s };
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => fail('page threw: ' + e.message.slice(0, 160)));
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 40)))));
    const doc = () => page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''));
    const key = async (k, mod) => { if (mod) await page.keyboard.down(mod); await page.keyboard.press(k); if (mod) await page.keyboard.up(mod); };
    const caretLive = () => page.evaluate(() => {
        const s = getSelection();
        if (!s || !s.rangeCount || !s.anchorNode) return 'no selection';
        if (!document.getElementById('editor').contains(s.anchorNode)) return 'caret in a node that is not in the page';
        if (!getAncestorBlock(s.anchorNode)) return 'caret not in a line';
        return '';
    });

    for (const run of RUNS) {
        const text = fs.readFileSync(run.file, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
        for (const layout of run.layouts) {
            const cmds = LAYOUTS[layout];
            const load = async () => {
                await page.evaluate((t, c) => { setSourceDocExt('md'); if (state.mode !== 'wysiwyg') handleCommand('view_set:mode:wysiwyg'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, text, cmds);
                await quiet(); await quiet();
            };
            await load();
            const orig = await doc();
            const picks = await page.evaluate(() => {
                const ok = (r) => r.indexOf('\n') < 0 && r.trim().length >= 12 && !/^\s*(`{3}|\||<|#|>|[-*+] |\d+\. )/.test(r);
                const bs = DocumentModel.blocks.map(b => String(b.raw));
                const idx = bs.map((r, i) => i);
                return {
                    // A text line with another straight after: a selection over two lines spans two lines of text.
                    text: idx.filter(i => ok(bs[i]) && i + 1 < bs.length && ok(bs[i + 1])),
                    // An empty line with text either side.
                    empty: idx.filter(i => bs[i] === '' && i > 0 && i + 1 < bs.length && ok(bs[i - 1]) && ok(bs[i + 1])),
                    // Marker lines, one list per kind so each kind gets its turn.
                    markers: ['^#{1,6} ', '^> (?!\\[!)', '^[-*+] (?!\\[)', '^[-*+] \\[[ xX]\\] ', '^\\d+\\. '].map(re => idx.filter(i => new RegExp(re).test(bs[i]) && bs[i].indexOf('\n') < 0 && bs[i].length >= 8 && i + 1 < bs.length)),
                };
            });
            let parityDone = false;
            for (let n = 0; n < run.per; n++) {
                const plan = [];
                if (picks.text.length) { const bi = picks.text[Math.floor(rnd() * picks.text.length)]; TEXT_EDITS.forEach(e => plan.push([bi, e])); }
                if (picks.empty.length) { const bi = picks.empty[Math.floor(rnd() * picks.empty.length)]; EMPTY_EDITS.forEach(e => plan.push([bi, e])); }
                for (const list of picks.markers) if (list.length) { const bi = list[Math.floor(rnd() * list.length)]; MARKER_EDITS.forEach(e => plan.push([bi, e])); }
                for (const [bi, edit] of plan) {
                    const tag = run.name + ' ' + layout + ' #' + bi + ' ' + edit;
                    if ((await doc()) !== orig) await load();
                    await page.evaluate((i) => goToModelBlock(i), bi); await quiet();
                    const at = await page.evaluate((i) => {
                        const ed = document.getElementById('editor'); const v = ed.getBoundingClientRect();
                        const b = ed.querySelector('.block[data-model-index="' + i + '"]'); if (!b) return null;
                        const r = Array.from(b.getClientRects()).find(r => r.height > 0 && r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom);
                        if (!r) return null;
                        const line = DocumentModel.blocks.slice(0, i).reduce((s, x) => s + String(x.raw).split('\n').length, 0);
                        return { x: r.left + 4, y: r.top + Math.min(r.height / 2, 10), line };
                    }, bi);
                    if (!at) continue;
                    await page.mouse.click(at.x, at.y); await key('Home'); await quiet();
                    const k = 3 + Math.floor(rnd() * 5);
                    const TOK = 'Qz' + n + 'x';
                    const right = async (c) => { for (let j = 0; j < c; j++) await key('ArrowRight'); };
                    if (edit === 'type') { await right(k); await page.keyboard.type(TOK); }
                    else if (edit === 'enter') { await right(k); await key('Enter'); }
                    else if (edit === 'enter-at-end') { await key('End'); await key('Enter'); }
                    else if (edit === 'delete-at-end') { await key('End'); await key('Delete'); }
                    else if (edit === 'backspace-start' || edit === 'backspace-on-empty') { await key('Backspace'); }
                    else if (edit === 'delete-on-empty') { await key('Delete'); }
                    else if (edit === 'enter-on-empty') { await key('Enter'); }
                    else if (edit === 'type-on-empty') { await page.keyboard.type(TOK); }
                    else if (edit === 'over-word') { await right(k); await page.keyboard.down('Shift'); await right(4); await page.keyboard.up('Shift'); await page.keyboard.type(TOK); }
                    else if (edit === 'over-2-lines') { await right(k); await page.keyboard.down('Shift'); await key('ArrowDown'); await page.keyboard.up('Shift'); await page.keyboard.type(TOK); }
                    else if (edit === 'paste-plain-2') { await right(k); await page.evaluate((t) => pasteLikeCtrlV('', t + ' one\n' + t + ' two', false), TOK); }
                    else if (edit === 'paste-rich') { await right(k); await page.evaluate((t) => pasteLikeCtrlV('<b>' + t + '</b> and <i>it</i>', t + ' and it', false), TOK); }
                    else if (edit === 'bold-word') { await right(k); await page.keyboard.down('Shift'); await right(4); await page.keyboard.up('Shift'); await page.evaluate(() => { freezeFormatSelection(); applyFormatting('bold'); }); }
                    else await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, edit);
                    await quiet();
                    const after = await doc();
                    if (after === orig) { if (/^(type|over|paste)/.test(edit)) fail(tag + ': the edit did nothing'); else passed++; continue; }
                    const rg = region(orig, after);
                    if (rg.from < at.line - 2 || rg.to > at.line + 3) fail(tag + ': lines changed away from the edit (line ' + at.line + ', changed ' + rg.from + '..' + rg.to + ')');
                    if (/type|over|paste/.test(edit)) {
                        const cnt = after.split(TOK).length - 1;
                        if (cnt !== (edit === 'paste-plain-2' ? 2 : 1)) fail(tag + ': typed text is there ' + cnt + ' times');
                    }
                    if (BLOCK.has(edit) && !parityDone) {
                        parityDone = true;
                        const src = await page.evaluate(async (a) => {
                            const wait = (ms) => new Promise(r => setTimeout(r, ms));
                            loadMarkdownContent(a.orig); handleCommand('view_set:mode:source'); await wait(150);
                            const off = sourceEditor.value.split('\n').slice(0, a.line).reduce((s, l) => s + l.length + 1, 0);
                            sourceEditor.focus(); sourceEditor.setSelectionRange(off, off);
                            freezeFormatSelection(); applyFormatting(a.cmd); await wait(80);
                            const v = sourceEditor.value.replace(/\n+$/, '');
                            handleCommand('view_set:mode:wysiwyg'); await wait(150);
                            return v;
                        }, { orig, line: at.line, cmd: edit });
                        if (src !== after) fail(tag + ': Preview and Source give different files');
                        await load(); passed++; continue;
                    }
                    // The caret is still somewhere real, and the next letter lands once, by the edit.
                    const lost = await caretLive();
                    if (lost) { fail(tag + ': after the edit, ' + lost); await load(); continue; }
                    await page.keyboard.type('Qy'); await quiet();
                    const typed = await doc();
                    const nQy = typed.split('Qy').length - 1;
                    const tr = region(after, typed);
                    if (nQy !== 1) fail(tag + ': the next letters typed are there ' + nQy + ' times');
                    else if (tr.from < at.line - 2 || tr.to > at.line + 3) fail(tag + ': the next letters typed landed at line ' + tr.from + ', not by the edit (line ' + at.line + ')');
                    // Undo: the letters, then the edit -- the file comes back exactly.
                    await key('KeyZ', 'Control'); await quiet();
                    if ((await doc()) !== after) await key('KeyZ', 'Control'), await quiet();
                    if ((await doc()) === after) { await key('KeyZ', 'Control'); await quiet(); }
                    if ((await doc()) !== orig) { fail(tag + ': Undo did not give the file back'); await load(); continue; }
                    passed++;
                }
            }
            console.log('  ..   ' + run.name + ', ' + layout + ': ' + passed + ' passed so far');
        }
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
report();
process.exit(failed ? 1 : 0);
