/**
 * Every key at every kind of block. A gate suite, and compare-release.mjs runs it on two builds.
 *
 *   node tests/key-fuzz.mjs [appDir] [out.json] [budgetSeconds]
 *
 * Writes what each case saved, and any broken invariant: letters and digits lost beyond the
 * keys pressed, a line more than two away from the edit changed, Ctrl+Z not restoring. Those
 * count letters, so they cannot see lost markup or a flattened table: the diff against the last
 * release is what shows those, and it has to be read.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = process.argv[3];
const budget = Number(process.argv[4] || 200) * 1000;
const started = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DOC = [
    'Top line.', '',
    '# W01 Heading one', '',
    'W02 plain para with **W03 bold** and *W04 ital* and `W05 code` text.', '',
    '- W06 bullet', '  - W07 nested', '- [ ] W08 task', '- [x] W09 done', '',
    '1. W10 first', '2. W11 second', '',
    '> W12 quote one', '> W13 quote two', '>', '> W14 quote three', '',
    '> [!NOTE]', '> W15 callout body', '> W16 callout second', '',
    '> [!WARNING] W17 title', '',
    '```js', 'W18 code', '  W19 indented', '```', '',
    '| W20 | W21 |', '|---|---|', '| W22 | W23 |', '',
    '---', '',
    'W24 link [W25 text](https://example.com/W26) end.', '',
    '  W29 indented para', '',
    '~~~', '',
    'W30 last line'
].join('\n');
const TOKENS = ['W01', 'W02', 'W03', 'W04', 'W05', 'W06', 'W07', 'W08', 'W09', 'W10', 'W11', 'W12', 'W13', 'W14', 'W15', 'W16', 'W17', 'W18', 'W19', 'W20', 'W22', 'W24', 'W25', 'W29', 'W30'];
const EDITS = {
    'type x': { keys: ['x'], del: 0, undo: true },
    'Enter': { keys: ['Enter'], del: 0, undo: true },
    'Enter Y': { keys: ['Enter', 'Y'], del: 0 },
    'Backspace': { keys: ['Backspace'], del: 1, undo: true },
    'Delete': { keys: ['Delete'], del: 1, undo: true },
    'Backspace x2': { keys: ['Backspace', 'Backspace'], del: 2 },
    'Home Backspace': { keys: ['Home', 'Backspace'], del: 1, undo: true },
    'End Delete': { keys: ['End', 'Delete'], del: 1, undo: true },
    'Home Backspace x2': { keys: ['Home', 'Backspace', 'Backspace'], del: 2 },
    'End Delete x2': { keys: ['End', 'Delete', 'Delete'], del: 2 },
};
// Expected extra digits: a new numbered item, and a split link keeps its address on both halves.
const MAY_GAIN = { W10: 2, W11: 2, W25: 18 };
const alnum = s => (String(s).match(/[A-Za-z0-9]/g) || []).length;

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 15000 });
const out = [];
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 3000 });
    let pageErr = null;
    page.on('pageerror', e => { pageErr = e.message; });
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto(pathToFileURL(path.join(appDir, 'TypoZen_Template.html')).href, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const load = async () => { await page.evaluate((d) => { localStorage.clear(); handleCommand('view_set:mode:preview'); loadMarkdownContent(d); }, DOC); await sleep(80); };
    const md = () => page.evaluate(() => getMarkdownContent(false));
    const click = async (tok, pos) => {
        const pt = await page.evaluate((w, pos) => {
            const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
            let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf(w) < 0) {}
            if (!t) return null;
            const i = t.nodeValue.indexOf(w) + (pos === 'start' ? 0 : w.length);
            const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i);
            const b = r.getBoundingClientRect(); return { x: b.left + (pos === 'start' ? 1 : 0), y: b.top + b.height / 2 };
        }, tok, pos);
        if (!pt) return false;
        await page.mouse.click(pt.x, pt.y); await sleep(60); return true;
    };
    const docLines = DOC.split('\n');
    const n0 = alnum(DOC);
    outer:
    for (const tok of TOKENS) for (const pos of ['start', 'end']) for (const [name, e] of Object.entries(EDITS)) {
        if (Date.now() - started > budget) { console.log('over budget at case ' + out.length); break outer; }
        pageErr = null;
        const rec = { tok, pos, name };
        try {
            await load();
            if (!await click(tok, pos)) { rec.skip = 'token not on screen'; out.push(rec); continue; }
            for (const k of e.keys) { if (k.length > 1) await page.keyboard.press(k); else await page.keyboard.type(k); }
            await sleep(60);
            const after = await md();
            rec.after = after;
            const issues = [];
            const lost = n0 - alnum(after);
            if (lost > e.del) issues.push('lost ' + lost + ' letters/digits (allowed ' + e.del + ')');
            const gained = alnum(after) - n0 - e.keys.filter(k => k.length === 1).length;
            if (gained > (MAY_GAIN[tok] || 0)) issues.push('gained ' + gained + ' letters/digits');
            const li = docLines.findIndex(l => l.includes(tok));
            const afterLines = after.split('\n');
            for (let i = 0; i < docLines.length; i++) {
                if (Math.abs(i - li) <= 2 || !docLines[i].trim()) continue;
                if (!afterLines.includes(docLines[i])) issues.push('far line changed: ' + docLines[i]);
            }
            if (e.undo) {
                await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
                await sleep(60);
                const u = await md();
                if (u !== DOC && after !== DOC) issues.push('Ctrl+Z did not restore');
            }
            if (pageErr) issues.push('page threw: ' + pageErr);
            rec.issues = issues;
        } catch (err) { rec.issues = ['harness: ' + err.message]; }
        out.push(rec);
    }
} finally { await browser.close(); }
if (outFile) fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`cases=${out.length} withIssues=${out.filter(r => r.issues && r.issues.length).length} seconds=${Math.round((Date.now() - started) / 1000)}`);
const broken = out.filter(r => r.issues && r.issues.length);
broken.slice(0, 20).forEach(r => console.error('  FAIL ' + r.tok + ' ' + r.pos + ' ' + r.name + ': ' + r.issues.join('; ').slice(0, 170)));
if (out.length < 400) { console.error('  FAIL only ' + out.length + ' cases ran'); process.exit(1); }
process.exit(broken.length ? 1 : 0);
