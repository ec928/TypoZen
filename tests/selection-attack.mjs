/**
 * A selection from anywhere to anywhere, then an editing action, checked by what is saved.
 *
 *   node tests/selection-attack.mjs [budgetSeconds] [seed] [actionFilter] [out.json]
 *
 * Every word in the document is a unique token (T001...). A selection runs from the start of
 * one token to the start of a later one, made by a real gesture (Shift+click or a drag), and
 * then one action is pressed for real. Whatever the block kinds at either end, the rule is the
 * same: the tokens before the selection and after it stay, in order, exactly once; the
 * selected tokens go (or stay, for copy and bold); lines wholly outside the selection are
 * byte for byte; Ctrl+Z gives back the original; a letter typed afterwards lands at the cut.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_APPDIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const budget = Number(process.argv[2] || 50) * 1000;
let seed = Number(process.argv[3] || 1);
const only = process.argv[4] && process.argv[4] !== '-' ? process.argv[4] : '';
const outFile = process.argv[5];
const LAYOUT = process.env.TZ_LAYOUT || 'scroll1';
const started = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const DOC_LINES = [
    'T001 T002 T003 plain first.', '',
    '# T004 T005 T006 heading', '',
    'T007 plain **T008 T009 bold** and *T010 ital* and `T011 code` T012 text.', '',
    '- T013 T014 bullet', '  - T015 T016 nested', '- [ ] T017 T018 task', '- [x] T019 T020 done', '',
    '1. T021 T022 first', '2. T023 T024 second', '',
    '> T025 T026 quote one', '> T027 T028 quote two', '',
    '> [!NOTE]', '> T029 T030 callout body', '',
    '```js', 'T031 T032 code', '  T033 T034 indented', '```', '',
    '| T035 | T036 |', '|---|---|', '| T037 | T038 |', '| T039 | T040 |', '',
    '---', '',
    'T041 link [T042 T043 text](https://example.com/page) T044 end.', '',
    '**T045 T046 boldfirst:** T047 after', '',
    'T048 T049 T050 last line'
];
const DOC = (process.env.TZ_DOC ? fs.readFileSync(process.env.TZ_DOC, 'utf8').replace(/\r\n/g, '\n') : DOC_LINES.join('\n'));
const LINES = DOC.split('\n');
const toks = (s) => String(s).match(/T\d{3,5}/g) || [];
const toksQ = (s) => String(s).match(/T\d{3,5}|Q\d?/g) || [];
const ALL = toks(DOC);
const lineOf = {}; LINES.forEach((l, i) => toks(l).forEach(t => { lineOf[t] = i; }));
const kindOf = (t) => {
    const l = LINES[lineOf[t]];
    if (/^#/.test(l)) return 'heading';
    if (/^\s*- \[/.test(l)) return 'task';
    if (/^\s+- /.test(l)) return 'nested';
    if (/^- /.test(l)) return 'bullet';
    if (/^\d+\. /.test(l)) return 'ordered';
    if (/^> /.test(l)) return 'quote';
    if (/^\|/.test(l)) return 'table';
    let fence = false; for (let i = 0; i < lineOf[t]; i++) if (/^(```|~~~)/.test(LINES[i])) fence = !fence;
    if (fence) return 'code';
    return 'para';
};

const ACTIONS = ['Delete', 'Backspace', 'typeQ', 'Enter', 'cutPaste', 'paste1', 'paste2', 'bold', 'copyPasteEnd'];

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
const fails = []; let cases = 0, premiseSkips = 0; const byAction = {};
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: LAYOUT === 'scroll1' ? 3000 : 900 });
    let pageErr = null;
    page.on('pageerror', e => { pageErr = e.message; });
    try { await browser.defaultBrowserContext().overridePermissions('file://', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']); } catch (e) {}
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto(pathToFileURL(path.join(appDir, 'TypoZen_Template.html')).href, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    console.log('alive: page loaded in ' + (Date.now() - started) + ' ms');
    const kb = page.keyboard;
    const chord = async (mods, key) => { for (const m of mods) await kb.down(m); await kb.press(key); for (const m of mods.slice().reverse()) await kb.up(m); };
    const md = () => page.evaluate(() => getMarkdownContent(false));
    // Wait until what would be saved has held still for two reads.
    const stable = async () => {
        let last = null, same = 0;
        for (let i = 0; i < 40; i++) {
            await sleep(45);
            const now = await md();
            if (now === last) { if (++same >= 2) return now; } else { same = 0; last = now; }
        }
        return last;
    };
    const load = async () => {
        await page.evaluate((d, layout) => {
            localStorage.clear(); handleCommand('view_set:mode:preview');
            if (layout === 'pages') { handleCommand('view_set:columns:2'); handleCommand('view_set:scroll:pagination'); }
            else if (layout === 'scroll2') { handleCommand('view_set:columns:2'); handleCommand('view_set:scroll:scroll'); }
            loadMarkdownContent(d);
        }, DOC, LAYOUT);
        await sleep(90);
    };
    const pointOf = (tok) => page.evaluate((w) => {
        const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
        let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf(w) < 0) {}
        if (!t) return null;
        const i = t.nodeValue.indexOf(w);
        const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + 1, y: b.top + b.height / 2, on: b.top >= 0 && b.bottom <= innerHeight };
    }, tok);
    const selToks = () => page.evaluate(() => String(window.getSelection()));

    while (Date.now() - started < budget) {
        const ia = Math.floor(rnd() * (ALL.length - 1));
        const span = rnd() < 0.5 ? 1 + Math.floor(rnd() * 4) : 1 + Math.floor(rnd() * (ALL.length - ia - 1));
        const ib = Math.min(ALL.length - 1, ia + span);
        const A = ALL[ia], B = ALL[ib];
        const action = only || pick(ACTIONS);
        const gesture = lineOf[A] === lineOf[B] ? 'drag' : pick(['shiftclick', 'drag']);
        const after2 = rnd() < 0.5 ? 'undo' : 'caret';
        const rec = { A, B, kinds: kindOf(A) + '>' + kindOf(B), action, gesture, after2 };
        const issues = [];
        pageErr = null;
        try {
            await load();
            const pa = await pointOf(A), pb = await pointOf(B);
            if (!pa || !pb || !pa.on || !pb.on) { premiseSkips++; continue; }
            if (gesture === 'shiftclick') {
                await page.mouse.click(pa.x, pa.y); await sleep(50);
                await kb.down('Shift'); await page.mouse.click(pb.x, pb.y); await kb.up('Shift');
            } else {
                await page.mouse.move(pa.x, pa.y); await page.mouse.down();
                await page.mouse.move((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, { steps: 3 });
                await page.mouse.move(pb.x, pb.y, { steps: 3 }); await page.mouse.up();
            }
            await sleep(50);
            const before = ALL.slice(0, ia), sel = ALL.slice(ia, ib), after = ALL.slice(ib);
            if (toks(await selToks()).join() !== sel.join()) { premiseSkips++; continue; }
            cases++; byAction[action] = (byAction[action] || 0) + 1;

            let want, wantQ = null, undoSteps = 1, checkTail = true, keepsSel = false;
            switch (action) {
                case 'Delete': await kb.press('Delete'); want = before.concat(after); break;
                case 'Backspace': await kb.press('Backspace'); want = before.concat(after); break;
                case 'typeQ': await kb.type('Q'); want = before.concat(after); wantQ = before.concat(['Q'], after); break;
                case 'Enter': await kb.press('Enter'); want = before.concat(after); break;
                case 'cutPaste': await chord(['Control'], 'x'); await stable(); await chord(['Control'], 'v'); want = ALL; undoSteps = 2; break;
                case 'paste1': await page.evaluate(() => navigator.clipboard.writeText('Q1 Q2')); await chord(['Control'], 'v'); want = before.concat(after); wantQ = before.concat(['Q1', 'Q2'], after); break;
                case 'paste2': await page.evaluate(() => navigator.clipboard.writeText('Q1\nQ2')); await chord(['Control'], 'v'); want = before.concat(after); wantQ = before.concat(['Q1', 'Q2'], after); break;
                case 'bold': await chord(['Control'], 'b'); want = ALL; keepsSel = true; break;
                case 'copyPasteEnd': {
                    await chord(['Control'], 'c'); await sleep(60);
                    const pe = await page.evaluate(() => { const bl = editor.querySelectorAll('.block'); const b = bl[bl.length - 1].getBoundingClientRect(); return { x: b.right - 3, y: b.top + b.height / 2 }; });
                    await page.mouse.click(pe.x, pe.y); await sleep(50); await kb.press('End');
                    await chord(['Control'], 'v'); want = ALL.concat(sel); checkTail = false; break;
                }
            }
            const s1 = await stable();
            rec.saved = s1;
            const got = toks(s1);
            if (got.join() !== want.join()) {
                const lost = want.filter(t => !got.includes(t)), extra = got.filter(t => !want.includes(t) || got.indexOf(t) !== got.lastIndexOf(t));
                issues.push('tokens: lost [' + lost.join(' ') + '] extra/dup [' + [...new Set(extra)].join(' ') + ']' + (lost.length || extra.length ? '' : ' (order changed)'));
            }
            if (wantQ && toksQ(s1).join() !== wantQ.join()) issues.push('inserted text not at the cut: ' + toksQ(s1).filter((t, i, a) => t[0] === 'Q' || (a[i + 1] || '')[0] === 'Q' || (a[i - 1] || '')[0] === 'Q').join(' '));
            const sl = s1.split('\n');
            let la = lineOf[A], lb = lineOf[B];
            // Expand la/lb to the full enclosing multi-line block (table or fenced code block)
            // so re-serializing an edited table's separator row isn't flagged as an outside-line edit.
            while (la > 0 && /^\|/.test(LINES[la]) && /^\|/.test(LINES[la - 1])) la--;
            while (lb + 1 < LINES.length && /^\|/.test(LINES[lb]) && /^\|/.test(LINES[lb + 1])) lb++;
            for (let i = 0; i < la; i++) if (sl[i] !== LINES[i]) { issues.push('line before the selection changed: ' + JSON.stringify(LINES[i]) + ' -> ' + JSON.stringify(sl[i])); break; }
            if (checkTail) for (let k = 1; k < LINES.length - lb; k++) if (sl[sl.length - k] !== LINES[LINES.length - k]) { issues.push('line after the selection changed: ' + JSON.stringify(LINES[LINES.length - k]) + ' -> ' + JSON.stringify(sl[sl.length - k])); break; }
            if (action === 'cutPaste' && s1 !== DOC) rec.inexact = true;
            if (action === 'bold') {
                const touchesFormattable = LINES.slice(lineOf[A], lineOf[B] + 1).some(l => {
                    const t = l.trim();
                    return t && !/^(```|~~~|\||---+$|>\s*\[!)/.test(t) && kindOf((toks(l)[0] || '')) !== 'code';
                });
                if (touchesFormattable && s1 === DOC) issues.push('bold changed nothing');
                if (s1 === DOC) keepsSel = false; // no undo needed when bold intentionally skipped structural blocks
            }

            if (after2 === 'undo' || keepsSel || action === 'copyPasteEnd' || action === 'cutPaste') {
                let u = s1, n = 0;
                while (u !== DOC && n < 5) { await chord(['Control'], 'z'); u = await stable(); n++; }
                if (u !== DOC) issues.push('Ctrl+Z x5 did not restore the document');
                else if (n > undoSteps) issues.push('undo took ' + n + ' steps (expected ' + undoSteps + ')');
                rec.undoSteps = n;
            } else if (!wantQ) {
                await kb.type('Q');
                const s2 = await stable();
                const wq = before.concat(['Q'], after);
                if (toksQ(s2).join() !== wq.join()) issues.push('a letter typed after the action did not land at the cut: ' + (toksQ(s2).indexOf('Q') < 0 ? 'Q not in the document' : toksQ(s2).slice(Math.max(0, toksQ(s2).indexOf('Q') - 1), toksQ(s2).indexOf('Q') + 2).join(' ') + ' want ' + (before[before.length - 1] || '^') + ' Q ' + after[0]));
                rec.saved2 = s2;
            }
            if (pageErr) issues.push('page threw: ' + pageErr);
        } catch (err) { issues.push('harness: ' + err.message); }
        if (issues.length) { rec.issues = issues; fails.push(rec); }
    }
} finally { await browser.close(); }

console.log(`cases=${cases} failing=${fails.length} premiseSkips=${premiseSkips} seconds=${Math.round((Date.now() - started) / 1000)} layout=${LAYOUT}`);
console.log('per action: ' + JSON.stringify(byAction));
const groups = {};
for (const f of fails) for (const is of f.issues) {
    const key = f.action + ' | ' + is.replace(/\[.*?\]/g, '[..]').replace(/: .*/, '');
    (groups[key] = groups[key] || []).push(f);
}
for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${v.length} x ${k}`);
    const kinds = {}; v.forEach(f => { kinds[f.kinds] = (kinds[f.kinds] || 0) + 1; });
    console.log('   kinds: ' + Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([a, b]) => a + ' ' + b).join(', '));
    v.slice(0, 3).forEach(f => console.log('   e.g. ' + f.A + '..' + f.B + ' ' + f.gesture + ': ' + f.issues.join(' ; ').slice(0, 300)));
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(fails, null, 1));
process.exit(fails.length ? 1 : 0);
