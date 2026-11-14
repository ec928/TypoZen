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
const explicitBudget = !!process.argv[2];
const budget = Number(process.argv[2] || 50) * 1000;
// A new seed every run unless one is given: with a fixed seed the gate pressed the same cases
// each time (88 of several thousand), and a different seed found a failure in a minute.
// The seed is printed; pass it back to repeat a run.
let seed = Number(process.argv[3] || process.env.TZ_SEED || (Date.now() % 1000000) + 1);
const seed0 = seed;
const only = process.argv[4] && process.argv[4] !== '-' ? process.argv[4] : '';
const outFile = process.argv[5];
const LAYOUT_LIST = process.env.TZ_LAYOUT
    ? [process.env.TZ_LAYOUT]
    : (explicitBudget ? ['scroll1'] : ['scroll1', 'scroll2', 'pages']);
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
// For a word in a table row: which column (0-based).
const colOf = {}; LINES.forEach((l) => { if (/^\s*\|/.test(l)) toks(l).forEach(t => { colOf[t] = l.slice(0, l.indexOf(t)).split('|').length - 2; }); });
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

const ACTIONS = ['Delete', 'Backspace', 'typeQ', 'Enter', 'shiftEnter', 'cutPaste', 'paste1', 'paste2', 'bold', 'italic', 'copyPasteEnd', 'fmtList', 'fmtQuote', 'fmtH2', 'fmtOl'];
// The lines a heading, list or quote format must leave exactly as they are: code blocks,
// tables, rules and a callout's marker line.
const STRUCTURE = (() => { let fence = false; return LINES.filter(l => { const d = /^(```|~~~)/.test(l); const keep = d || fence || /^\||^---+$|^>\s*\[!/.test(l); if (d) fence = !fence; return keep; }); })();

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
const fails = []; let cases = 0, premiseSkips = 0; const byAction = {};
try {
    const page = await browser.newPage();
    let pageErr = null;
    page.on('pageerror', e => { pageErr = e.message; });
    try { await browser.defaultBrowserContext().overridePermissions('file://', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']); } catch (e) {}
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto(pathToFileURL(path.join(appDir, 'TypoZen_Template.html')).href, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    console.log('alive: page loaded in ' + (Date.now() - started) + ' ms, seed ' + seed0);
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
    const load = async (layout) => {
        await page.evaluate((d, l) => {
            localStorage.clear(); handleCommand('view_set:mode:preview');
            if (l === 'pages') { handleCommand('view_set:columns:2'); handleCommand('view_set:scroll:pagination'); }
            else if (l === 'scroll2') { handleCommand('view_set:columns:2'); handleCommand('view_set:scroll:scroll'); }
            else { handleCommand('view_set:columns:1'); handleCommand('view_set:scroll:scroll'); }
            loadMarkdownContent(d);
        }, DOC, layout);
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
    // The words on screen, line by line, with runs of spaces as one.
    const shownText = () => page.evaluate(() => [...editor.querySelectorAll('.block')].map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()).join('\n'));
    // Which words are drawn bold (or italic): { T001: false, T008: true, ... }
    const markedWords = (sel) => page.evaluate((sel) => {
        const out = {};
        const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
        let t; while ((t = tw.nextNode())) for (const w of (t.nodeValue.match(/T\d{3,5}/g) || [])) out[w] = !!(t.parentElement && t.parentElement.closest(sel));
        return out;
    }, sel);
    const firstDiff =(a, b) => { a = a.split('\n'); b = b.split('\n'); for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return [a[i], b[i]]; return []; };

    const sliceMs = Math.floor(budget / LAYOUT_LIST.length);
    for (let li = 0; li < LAYOUT_LIST.length; li++) {
        const LAYOUT = LAYOUT_LIST[li];
        const sliceEnd = li === LAYOUT_LIST.length - 1 ? started + budget : Date.now() + sliceMs;
        await page.setViewport({ width: 1200, height: LAYOUT === 'scroll1' ? 3000 : 900 });
        while (Date.now() < sliceEnd) {
        const ia = Math.floor(rnd() * (ALL.length - 1));
        const span = rnd() < 0.5 ? 1 + Math.floor(rnd() * 4) : 1 + Math.floor(rnd() * (ALL.length - ia - 1));
        const ib = Math.min(ALL.length - 1, ia + span);
        const A = ALL[ia], B = ALL[ib];
        // The filter is an action's name, or the start of several ("fmt", "paste").
        const action = pick(only ? (ACTIONS.includes(only) ? [only] : ACTIONS.filter(a => a.startsWith(only))) : ACTIONS);
        const gesture = lineOf[A] === lineOf[B] ? 'drag' : pick(['shiftclick', 'drag']);
        const after2 = rnd() < 0.5 ? 'undo' : 'caret';
        const rec = { layout: LAYOUT, A, B, kinds: kindOf(A) + '>' + kindOf(B), action, gesture, after2 };
        const issues = [];
        pageErr = null;
        try {
            await load(LAYOUT);
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
            const selText = await selToks();
            if (toks(selText).join() !== sel.join()) { premiseSkips++; continue; }
            // The click can land a character into the word the selection should stop before
            // ("... T" of T028). That is a different selection from the one being checked.
            const tailBit = (selText.match(/(\S+)\s*$/) || ['', ''])[1];
            if (tailBit && tailBit !== sel[sel.length - 1] && B.startsWith(tailBit)) { premiseSkips++; continue; }
            cases++; byAction[action] = (byAction[action] || 0) + 1;
            const shown0 = (action === 'bold' || action === 'italic') ? await shownText() : '';
            const markSel = action === 'bold' ? 'strong, b' : 'em, i';
            const marked0 = (action === 'bold' || action === 'italic') ? await markedWords(markSel) : null;

            let want, wantQ = null, undoSteps = 1, checkTail = true, keepsSel = false;
            switch (action) {
                case 'Delete': await kb.press('Delete'); want = before.concat(after); break;
                case 'Backspace': await kb.press('Backspace'); want = before.concat(after); break;
                case 'typeQ': await kb.type('Q'); want = before.concat(after); wantQ = before.concat(['Q'], after); break;
                case 'Enter': await kb.press('Enter'); want = before.concat(after); break;
                case 'shiftEnter': await chord(['Shift'], 'Enter'); want = before.concat(after); break;
                case 'cutPaste': await chord(['Control'], 'x'); await stable(); await chord(['Control'], 'v'); want = ALL; undoSteps = 2; break;
                case 'paste1': await page.evaluate(() => navigator.clipboard.writeText('Q1 Q2')); await chord(['Control'], 'v'); want = before.concat(after); wantQ = before.concat(['Q1', 'Q2'], after); break;
                case 'paste2': await page.evaluate(() => navigator.clipboard.writeText('Q1\nQ2')); await chord(['Control'], 'v'); want = before.concat(after); wantQ = before.concat(['Q1', 'Q2'], after); break;
                case 'bold': await chord(['Control'], 'b'); want = ALL; keepsSel = true; break;
                case 'italic': await chord(['Control'], 'i'); want = ALL; keepsSel = true; break;
                case 'fmtList': case 'fmtQuote': case 'fmtH2': case 'fmtOl':
                    // What the toolbar buttons and the Format menu call.
                    await page.evaluate((t) => applyFormatting(t), { fmtList: 'list', fmtQuote: 'quote', fmtH2: 'h2', fmtOl: 'ol' }[action]);
                    want = ALL; keepsSel = true; checkTail = false; break;
                case 'copyPasteEnd': {
                    await chord(['Control'], 'c'); await sleep(60);
                    const pe = await page.evaluate(() => { const bl = editor.querySelectorAll('.block'); const b = bl[bl.length - 1].getBoundingClientRect(); return { x: b.right - 3, y: b.top + b.height / 2 }; });
                    await page.mouse.click(pe.x, pe.y); await sleep(50); await kb.press('End');
                    await chord(['Control'], 'v'); want = ALL.concat(sel); checkTail = false; break;
                }
            }
            const s1 = await stable();
            rec.saved = s1;
            // A mark may start or end inside a word when the click lands a character in
            // ("**T027 T**028"): the word is still there.
            const got = toks((action === 'bold' || action === 'italic') ? s1.replace(/\*+/g, '') : s1);
            // A list marker joined into a line as words ("1. one 2. three").
            if (!keepsSel && action !== 'copyPasteEnd') {
                const stray = s1.split('\n').find(l => /^\s*(?:[-*+]|\d+\.)\s.*\s(?:\d+\.|- \[[ x]\]|-)\s+T\d{3}/.test(l));
                if (stray) issues.push('a list marker became words: ' + JSON.stringify(stray));
            }
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
            // Enter adds a line, so a numbered list below it counts on: "2." becoming "3." is right.
            // So does a paste of several lines into a numbered item: they are items too.
            const num = (l) => (action === 'Enter' || action === 'shiftEnter' || action === 'paste2' || action === 'cutPaste') ? String(l).replace(/^(\s*)\d+\. /, '$1N. ') : l;
            if (checkTail) for (let k = 1; k < LINES.length - lb; k++) if (num(sl[sl.length - k]) !== num(LINES[LINES.length - k])) { issues.push('line after the selection changed: ' + JSON.stringify(LINES[LINES.length - k]) + ' -> ' + JSON.stringify(sl[sl.length - k])); break; }
            // Counting words cannot see a cell that moved to another column, and the table's
            // own lines are excused above. A word that was in a table and is still in one
            // must be in the column it was in. Only words outside the selection: a table's
            // words are cut as text, so pasted back they are not promised their cells.
            for (const t of before.concat(after)) {
                if (colOf[t] == null) continue;
                const row = sl.find(l => l.includes(t));
                if (!row || !/^\s*\|/.test(row)) continue;
                const c = row.slice(0, row.indexOf(t)).split('|').length - 2;
                if (c !== colOf[t]) { issues.push('table cell moved: ' + t + ' was in column ' + (colOf[t] + 1) + ', now ' + (c + 1)); break; }
            }
            // Bold and italic change marks, never the words shown: stray "**" on screen, a
            // code block run into one line or a table turned into text all change them.
            if (action === 'bold' || action === 'italic') {
                const shown = await shownText();
                if (shown !== shown0) issues.push(action + ' changed the words shown: ' + JSON.stringify(firstDiff(shown0, shown)));
                // What is selected is marked, and nothing else: not the rest of the first
                // and last lines. Selected words that can take the mark end up all alike.
                const marked1 = await markedWords(markSel);
                const outside = before.concat(after).filter(t => marked1[t] !== undefined && marked1[t] !== marked0[t]);
                if (outside.length) issues.push(action + ' marked words outside the selection: ' + outside.join(' '));
                const canMark = sel.filter(t => !['code', 'table'].includes(kindOf(t)));
                if (s1 !== DOC && new Set(canMark.map(t => marked1[t])).size > 1) issues.push(action + ' left the selection partly marked: ' + canMark.map(t => t + (marked1[t] ? '+' : '-')).join(' '));
            }
            if (action.startsWith('fmt')) {
                const gone = STRUCTURE.filter(l => !sl.includes(l));
                if (gone.length) issues.push('a code block, table, rule or callout line was changed: ' + JSON.stringify(gone[0]) + ' -> ' + JSON.stringify(sl.find(l => toks(gone[0]).length && toks(gone[0]).every(t => l.includes(t))) || '(gone)'));
                // Words are never cut in two by a format: every line still starts and ends on a whole word.
                const cut = sl.find(l => /(^|\s)\d{1,2}(\s|$)|T\d{0,2}$/.test(l.replace(/^\s*\d+\. /, '')));
                if (cut) issues.push('a word was cut in two: ' + JSON.stringify(cut));
                if (s1 === DOC) keepsSel = false;
            }
            if (action === 'cutPaste' && s1 !== DOC) rec.inexact = true;
            if (action === 'bold' || action === 'italic') {
                const touchesFormattable = LINES.slice(lineOf[A], lineOf[B] + 1).some(l => {
                    const t = l.trim();
                    return t && !/^(```|~~~|\||---+$|>\s*\[!)/.test(t) && kindOf((toks(l)[0] || '')) !== 'code';
                });
                // Only when a word that can take the mark is selected: a selection that ends
                // at the start of a line has none of that line in it.
                const canTake = sel.some(t => !['code', 'table'].includes(kindOf(t)));
                if (touchesFormattable && canTake && s1 === DOC) issues.push(action + ' changed nothing');
                if (s1 === DOC) keepsSel = false; // no undo needed when inline format intentionally skipped structural blocks
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
    }
} finally { await browser.close(); }

console.log(`cases=${cases} failing=${fails.length} premiseSkips=${premiseSkips} seconds=${Math.round((Date.now() - started) / 1000)} layouts=${LAYOUT_LIST.join(',')}`);
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
