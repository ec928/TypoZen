/**
 * Edits on a real document, in every layout: what must always hold (2026-11-22).
 *
 * Example tests check the cases their authors thought of; the bugs found on 2026-11-22 sat
 * where a layout met an edit met a real file. This presses real keys at seeded positions of
 * the README in 1-column, 2-column and two-page Preview, and checks, for every edit:
 *   - Undo gives the file back exactly, and Redo the edit;
 *   - only lines near the edit change;
 *   - what was typed lands exactly once;
 *   - a block format at a caret gives the same file in Preview as in Source.
 * It found the two-line Undo bug (0.22.2) and the indented-fence one (0.22.3) when it ran as
 * a one-off. Seeded, so a failure repeats.
 *
 *   node tests/cross-mode-sweep-browser.mjs     (about 70 s; SWEEP_SEED=n, SWEEP_PER=n)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.TZ_ROOT || path.join(here, '..');
const PER = +(process.env.SWEEP_PER || 2);
let seed = +(process.env.SWEEP_SEED || 20261122);
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const deadline = setTimeout(() => { console.error('  FAIL over budget (150 s)'); report(); process.exit(1); }, 150000);
const LAYOUTS = {
    '1-column': ['view_set:columns:1', 'view_set:scroll:scroll'],
    '2-column': ['view_set:columns:2', 'view_set:scroll:scroll'],
    'two pages': ['view_set:columns:2', 'view_set:scroll:pagination'],
};
const EDITS = ['type', 'enter', 'backspace-start', 'over-word', 'over-2-lines', 'paste-plain-2', 'paste-rich', 'bold-word', 'h2', 'quote', 'list'];
const BLOCK = new Set(['h2', 'quote', 'list']);
let passed = 0, failed = 0; const fails = [];
function fail(msg) { failed++; fails.push(msg); console.error('  FAIL ' + msg); }
function report() { console.log(`\n${passed} passed, ${failed} failed`); }
function region(a, b) {
    const A = a.split('\n'), Bl = b.split('\n');
    let p = 0; while (p < A.length && p < Bl.length && A[p] === Bl[p]) p++;
    let s = 0; while (s < A.length - p && s < Bl.length - p && A[A.length - 1 - s] === Bl[Bl.length - 1 - s]) s++;
    return { from: p, to: A.length - s };
}

const text = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
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

    for (const [layout, cmds] of Object.entries(LAYOUTS)) {
        const load = async () => {
            await page.evaluate((t, c) => { setSourceDocExt('md'); if (state.mode !== 'wysiwyg') handleCommand('view_set:mode:wysiwyg'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, text, cmds);
            await quiet(); await quiet();
        };
        await load();
        const orig = await doc();
        // Ordinary one-line blocks long enough to put a caret into, and not code, tables or HTML,
        // with another such line straight after: a selection over two lines must span two
        // lines of text, not run into a blank one (where the two-line Undo bug hid).
        const cands = await page.evaluate(() => {
            const ok = (r) => r.indexOf('\n') < 0 && r.trim().length >= 12 && !/^\s*(`{3}|\||<)/.test(r);
            const bs = DocumentModel.blocks.map(b => String(b.raw));
            return bs.map((r, i) => i).filter(i => ok(bs[i]) && i + 1 < bs.length && ok(bs[i + 1]));
        });
        let parityDone = false;
        for (let n = 0; n < PER; n++) {
            const bi = cands[Math.floor(rnd() * cands.length)];
            for (const edit of EDITS) {
                const tag = layout + ' #' + bi + ' ' + edit;
                if ((await doc()) !== orig) await load();
                await page.evaluate((i) => goToModelBlock(i), bi); await quiet();
                const at = await page.evaluate((i) => {
                    const ed = document.getElementById('editor'); const v = ed.getBoundingClientRect();
                    const b = ed.querySelector('.block[data-model-index="' + i + '"]'); if (!b) return null;
                    const r = Array.from(b.getClientRects()).find(r => r.width > 0 && r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom);
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
                else if (edit === 'backspace-start') { await key('Backspace'); }
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
                await key('KeyZ', 'Control'); await quiet();
                if ((await doc()) !== orig) { fail(tag + ': Undo did not give the file back'); await load(); continue; }
                await key('KeyY', 'Control'); await quiet();
                if ((await doc()) !== after) fail(tag + ': Redo did not give the edit back');
                await key('KeyZ', 'Control'); await quiet();
                passed++;
            }
        }
        console.log('  ..   ' + layout + ': ' + passed + ' passed so far');
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
report();
process.exit(failed ? 1 : 0);
