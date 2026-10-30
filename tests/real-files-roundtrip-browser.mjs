/**
 * Every line of every real Markdown file on this machine, through the save logic.
 *
 * Two checks on each line, with no exceptions for "harmless" differences:
 *   1. render it and serialize it: the result is the line, byte for byte.
 *   2. edit it (one character into its first and last text), save, take the character out:
 *      the result is the line, byte for byte. An edit changes what was edited.
 *
 * This found, in two seconds, bugs that about a hundred suites had not: "0.48s" at the start
 * of a line saved as "1. 48s", "\|" in a table became a new column, a titled image was lost on
 * save. The suites check what someone thought of; this checks whatever people actually write.
 *
 * Files: everything in this repo, and the rest of the development folder when it is there, plus
 * the list below, so the check means the same on any machine.
 *
 *   node tests/real-files-roundtrip-browser.mjs
 *   TZ_APP_DIR=path node tests/real-files-roundtrip-browser.mjs     another build, as a control
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const appDir = process.env.TZ_APP_DIR || repo;
const started = Date.now();
const deadline = setTimeout(() => { console.error('FAIL over budget (120 s)'); process.exit(1); }, 120000);

// What real files may not happen to contain today. One line each; tables and fences at the end.
const HOSTILE = [
    'alpha **bold** omega', 'alpha __bold__ omega', 'alpha *ital* omega', 'alpha _ital_ omega', 'alpha ***both*** omega',
    'alpha ___both___ omega', 'alpha ~~gone~~ omega', 'alpha `code` omega', 'alpha `a  b` omega', 'alpha ``a`b`` omega', 'alpha ==mark== omega',
    'alpha [text](https://e.com/p) omega', 'alpha [text](https://e.com/p "Title") omega', "alpha [text](https://e.com/p 'Title') omega",
    'alpha [t](javascript:alert(1)) omega', 'alpha [t](<a b.md>) omega', 'alpha [ref][1] omega', '[1]: https://e.com "T"',
    'alpha <https://e.com> omega', 'alpha https://e.com/a_b_c omega', 'alpha ![pic](a.png) omega', 'alpha ![pic](a.png "T") omega',
    'alpha ![pic](a%20b.png) omega', 'alpha ![p](javascript:x) omega', '![only](a.png)', 'alpha <u>under</u> omega',
    'alpha <span style="color:red">red</span> omega', 'alpha <br> omega', 'alpha &amp; &lt; omega', 'alpha \\*not\\* omega',
    'alpha 2 * 3 * 4 omega', 'alpha snake_case_word omega', 'alpha [x] [ ] omega', 'alpha a|b omega', 'alpha [^1] omega',
    'alpha H~2~O x^2^ omega', 'alpha $x_1$ omega', 'alpha {{tag}} omega', 'alpha [narrator] omega', 'alpha  two   spaces omega',
    'alpha \ttab omega', 'alpha 日本語 emoji 😀 omega', 'alpha trailing  ', '  leading space', '    four spaces', '\ttab first',
    '- bullet', '* bullet', '+ bullet', '*   wide bullet', '   * three spaces', '     - five spaces', '- [ ] task', '- [x] done',
    '* [X] star task', '1. one', '1.nospace', '0. zero', '10.   wide', '   1. indented', '# h1', '###### h6', '## closed ##',
    '#  wide heading', '# C#', '> quote', '>no space', '>', '>   wide quote', '> > nested', '> [!NOTE]', '> [!note] Custom title',
    '> [!TIP]', '> [!UNKNOWN] x', '---', '-----', '- - -', '***', '___', '0.48s of spread', '3.14 is pi', '1.5 million', '2026.',
    '~~~', '\\# not heading', '1\\. not list', 'alpha # hash omega', '<div>html</div>', '<!-- comment -->', '|not a table',
    '| a | b |\n|---|---|\n| 1 | 2 |', '|a|b|\n|-|-|\n|1|2|', '| a | b |\n|:---|---:|\n| 1 | 2 |', '| a |\n|---|\n| x \\| y |',
    '  | a | b |\n  |---|---|\n  | 1 | 2 |', '| a | b |\n|---|---|\n| 1 |', '```\ncode\n```', '```js\nlet a = 1;\n\n  b();\n```',
    '````c++\n```\ninner\n```\n````', '```\nunclosed', '```\n| a | b |\n|---|---|\n```',
];

const files = [];
(function walk(d, depth) {
    if (depth > 6) return;
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
        if (/^(node_modules|\.git|bin|obj|dist|dist-\w+|packages|vendor)$/i.test(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/\.(md|markdown|txt)$/i.test(e.name)) { try { if (fs.statSync(p).size < 400000) files.push(p); } catch (x) {} }
    }
})(fs.existsSync(path.join(repo, '..', 'MediaSuite.slnx')) ? path.join(repo, '..') : repo, 0);

// Runs in the page: both checks on each block of a text.
function checkText(text) {
    const bad = [];
    // The browser cannot hold these in a text node. Load keeps them in data-raw; check 2 covers it.
    const unholdable = /[\x00-\x08\x0b-\x1f]/;
    const MARK = '';
    const textNodes = (el) => {
        const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const out = []; let t;
        while ((t = tw.nextNode())) { if (t.nodeValue.trim() && !t.parentElement.closest('.tz-tab')) out.push(t); }
        return out;
    };
    const raws = splitMarkdownToBlockRaws(text);
    let lines = 0;
    for (const raw of raws) {
        if (!raw.trim()) continue;
        lines++;
        const fresh = createPreviewBlockEl(raw, false);
        const shown = blockDomToMarkdown(fresh);
        if (shown !== raw && !unholdable.test(raw)) bad.push({ check: 'roundtrip', raw, got: shown });
        // A callout with no title of its own shows the type's name, which is not in the line:
        // typing there gives it a title, correctly, and the title stays when the letter goes.
        const nodes = /^>\s*\[!\w+\]\s*$/.test(raw) ? 0 : textNodes(fresh).length;
        for (const where of nodes ? [0, nodes - 1] : []) {
            const el = createPreviewBlockEl(raw, false);
            const node = textNodes(el)[where];
            const at = where === 0 ? 0 : node.nodeValue.length;
            node.nodeValue = node.nodeValue.slice(0, at) + MARK + node.nodeValue.slice(at);
            let got = blockHtmlToMarkdown(el);
            if (got.indexOf(MARK) < 0) { bad.push({ check: 'edit vanished', raw, got }); continue; }
            got = got.replace(MARK, '');
            if (got !== raw) bad.push({ check: 'edit', raw, got });
        }
    }
    return { lines, bad };
}

let lines = 0, ok = true;
const failures = [];
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000 });
try {
    const page = await browser.newPage();
    page.on('pageerror', e => { ok = false; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    await page.evaluate(() => { localStorage.clear(); handleCommand('view_set:mode:preview'); setSourceDocExt('md'); });

    for (const line of HOSTILE) {
        const r = await page.evaluate(checkText, line);
        lines += r.lines;
        for (const b of r.bad) failures.push(Object.assign({ file: '(hostile list)' }, b));
        if (!r.lines) failures.push({ file: '(hostile list)', check: 'no block', raw: line, got: '' });
    }
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
        const r = await page.evaluate(checkText, text);
        lines += r.lines;
        for (const b of r.bad) failures.push(Object.assign({ file: path.relative(repo, f) }, b));
    }
} finally {
    await browser.close();
    clearTimeout(deadline);
}

const show = (s) => JSON.stringify(String(s).length > 170 ? String(s).slice(0, 170) + '...' : s);
const byCheck = {};
failures.forEach(b => { byCheck[b.check] = (byCheck[b.check] || 0) + 1; });
const seen = new Set();
const unique = failures.filter(b => { const k = b.check + b.raw; if (seen.has(k)) return false; seen.add(k); return true; });
unique.slice(0, Number(process.env.TZ_SHOW || 30)).forEach(b =>
    console.error('  FAIL ' + b.check + ' in ' + b.file + '\n         line ' + show(b.raw) + '\n         got  ' + show(b.got)));
if (lines < 100) { ok = false; console.error('  FAIL only ' + lines + ' lines checked: the check is not looking at anything'); }
if (failures.length) ok = false;
console.log(`files=${files.length} lines=${lines} differences=${failures.length} ${JSON.stringify(byCheck)} seconds=${Math.round((Date.now() - started) / 1000)}`);
console.log(ok ? 'REAL FILES ROUND TRIP PASSED' : 'REAL FILES ROUND TRIP FAILED');
process.exit(ok ? 0 : 1);
