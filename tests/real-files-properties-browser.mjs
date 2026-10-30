/**
 * Things that must hold for every real file, not for a case someone thought of. The same idea as
 * real-files-roundtrip-browser, which found in seconds what about a hundred suites had not.
 *
 *   1. Whole file: load it, and what would be saved is the file. Toggle to Source and back, and
 *      it still is. (The roundtrip suite works a block at a time; this catches what happens
 *      between blocks: blank lines, splitting, joining.)
 *   2. Read Aloud never says markup: no **, ](, [!, or a line's own # or > marker.
 *   3. Nothing in a file can run: no script, iframe, object or embed, no on* attribute, no
 *      javascript: address, whatever the file says.
 *
 * With the rest of the development folder when it is there, and a list of hostile lines, so it
 * means the same on any machine.
 *
 *   node tests/real-files-properties-browser.mjs
 *   TZ_APP_DIR=path node tests/real-files-properties-browser.mjs     another build, as a control
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const appDir = process.env.TZ_APP_DIR || repo;
const started = Date.now();
const deadline = setTimeout(() => { console.error('FAIL over budget (150 s)'); process.exit(1); }, 150000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HOSTILE = [
    '<script>window.__pwned = 1</script>', '<img src=x onerror="window.__pwned=1">', '<iframe src="javascript:window.__pwned=1"></iframe>',
    '[x](javascript:window.__pwned=1)', '[x](JaVa\tScRiPt:window.__pwned=1)', '[x](vbscript:msgbox(1))', '[x](data:text/html,<script>1</script>)',
    '![x](javascript:window.__pwned=1)', '![x" onerror="window.__pwned=1](a.png)', '[x" onmouseover="window.__pwned=1](https://e.com)',
    '[x](https://e.com" onmouseover="window.__pwned=1)', '<svg onload="window.__pwned=1">', '<a href="javascript:window.__pwned=1">x</a>',
    '`<script>window.__pwned=1</script>`', '**<img src=x onerror=window.__pwned=1>**', '| <script>window.__pwned=1</script> |\n|---|\n| x |',
    '```html" onload="window.__pwned=1\ncode\n```', '> [!NOTE] <img src=x onerror=window.__pwned=1>', '# <img src=x onerror=window.__pwned=1>',
    '- <img src=x onerror=window.__pwned=1>', '@@TZTAG0@@ @@TZCODE0@@ literal placeholders',
];
const SPEECH = [
    ['**bold** word', 'bold word'], ['*it* word', 'it word'], ['~~gone~~ word', 'gone word'], ['`code` word', 'code word'],
    ['[text](https://e.com/p) word', 'text word'], ['[text](https://e.com "T") word', 'text word'], ['# Heading', 'Heading'], ['> Quote', 'Quote'],
    ['- item', 'item'], ['1. item', 'item'], ['> [!WARNING]', 'Warning'], ['> [!NOTE] My title', 'My title'], ['![a picture](a.png)', 'a picture'],
    ['![a picture](a.png "T")', 'a picture'],
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
        else if (/\.(md|markdown)$/i.test(e.name)) { try { if (fs.statSync(p).size < 400000) files.push(p); } catch (x) {} }
    }
})(fs.existsSync(path.join(repo, '..', 'MediaSuite.slnx')) ? path.join(repo, '..') : repo, 0);

const failures = [];
const fail = (check, where, detail) => failures.push({ check, where, detail });
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800 });
    page.on('pageerror', e => fail('page threw', '', e.message));
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    await page.evaluate(() => { localStorage.clear(); handleCommand('view_set:mode:preview'); setSourceDocExt('md'); });

    const norm = (s) => s.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const firstDiff = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
    let lines = 0, spoken = 0;

    // 1. Whole files. Compared without the file's final newlines, which the document does not hold.
    const trimEnd = (s) => s.replace(/\n+$/, '');
    for (const f of files) {
        const text = trimEnd(norm(fs.readFileSync(f, 'utf8'))).replace(/\0/g, '');
        lines += text.split('\n').length;
        const rel = path.relative(repo, f);
        const loaded = await page.evaluate((t) => { handleCommand('view_set:mode:preview'); loadMarkdownContent(t); return getMarkdownContent(false); }, text);
        if (trimEnd(loaded) !== text) { const i = firstDiff(trimEnd(loaded), text); fail('load then save', rel, JSON.stringify(text.slice(Math.max(0, i - 40), i + 40)) + ' became ' + JSON.stringify(trimEnd(loaded).slice(Math.max(0, i - 40), i + 40))); }
    }
    // Toggling is slow per file, so the ten largest, which have the most in them.
    const largest = files.slice().sort((a, b) => fs.statSync(b).size - fs.statSync(a).size).slice(0, 10);
    for (const f of largest) {
        const text = trimEnd(norm(fs.readFileSync(f, 'utf8'))).replace(/\0/g, '');
        await page.evaluate((t) => { handleCommand('view_set:mode:preview'); loadMarkdownContent(t); }, text);
        await sleep(100);
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await sleep(250);
        // Every moment after the switch, not only once it has settled: a save can come at any
        // time, and while Preview was still building this read part of the file, and Ctrl+S
        // wrote it to disk (1,500 lines of 1,600, 2026-10-30).
        const reads = await page.evaluate(async () => {
            const out = [];
            handleCommand('view_set:mode:preview');
            for (let i = 0; i < 30; i++) {
                out.push(getMarkdownContent(false, { flushActive: true }));
                await new Promise(r => setTimeout(r, 30));
            }
            return out;
        });
        const wrong = reads.findIndex(r => trimEnd(r) !== text);
        if (wrong >= 0) { const back = trimEnd(reads[wrong]); const i = firstDiff(back, text); fail('Source and back', path.relative(repo, f), 'read ' + wrong + ': ' + back.split('\n').length + ' lines of ' + text.split('\n').length + ' near ' + JSON.stringify(text.slice(Math.max(0, i - 40), i + 40))); }
    }

    // 2. Read Aloud: known lines exactly, then every real line for leftover markup.
    await page.evaluate(() => { handleCommand('view_set:mode:preview'); loadMarkdownContent('x'); });
    for (const [line, want] of SPEECH) {
        const said = await page.evaluate((l) => chunkSpeechText({ md: true, text: l }), line);
        if (said !== want) fail('Read Aloud says', line, JSON.stringify(said) + ' instead of ' + JSON.stringify(want));
    }
    for (const f of files) {
        const text = norm(fs.readFileSync(f, 'utf8'));
        const bad = await page.evaluate((text) => {
            const out = []; let n = 0;
            for (const raw of splitMarkdownToBlockRaws(text)) {
                // Code is said as written, and a literal marker in a sentence is the author's.
                if (!raw.trim() || raw.indexOf('\n') >= 0 || /`|\\/.test(raw)) continue;
                n++;
                const said = chunkSpeechText({ md: true, text: raw });
                // A bold that opens on one line and closes on the next has a lone ** (one line is
                // one paragraph here, so it shows as written). An indented # is not a heading.
                const pairs = (said.match(/\*\*/g) || []).length;
                if (pairs >= 2 && pairs % 2 === 0 || /\]\(|\[![A-Za-z]+\]/.test(said) || /^(#{1,6}\s|>\s)/.test(raw) && /^(#{1,6}\s|>\s)/.test(said)) out.push([raw, said]);
            }
            return { n, out };
        }, text);
        spoken += bad.n;
        bad.out.forEach(b => fail('markup read aloud', path.relative(repo, f), JSON.stringify(b[0].slice(0, 110)) + ' says ' + JSON.stringify(b[1].slice(0, 110))));
    }

    // 3. Nothing runs. In the page, connected, so an onerror would fire.
    const allText = HOSTILE.slice();
    for (const f of files) allText.push(norm(fs.readFileSync(f, 'utf8')));
    for (const t of allText) {
        const bad = await page.evaluate((text) => {
            const out = [];
            const check = (el) => {
                el.querySelectorAll('script,iframe,object,embed,link,meta,base').forEach(n => out.push('<' + n.tagName.toLowerCase() + '>'));
                el.querySelectorAll('*').forEach(n => {
                    for (const a of n.attributes) {
                        if (/^on/i.test(a.name)) out.push(n.tagName + ' ' + a.name);
                        if (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*(javascript|vbscript)\s*:/i.test(a.value.replace(/[\x00-\x20]/g, ''))) out.push(n.tagName + ' ' + a.name + '=' + a.value);
                    }
                });
            };
            for (const raw of splitMarkdownToBlockRaws(text)) {
                if (!raw.trim()) continue;
                const el = createPreviewBlockEl(raw, false);
                check(el);
                if (out.length) { out.unshift(raw.slice(0, 100)); break; }
            }
            return out;
        }, t);
        if (bad.length) fail('could run', bad[0], bad.slice(1).join(', '));
    }
    await page.evaluate((list) => {
        const box = document.createElement('div');
        document.body.appendChild(box);
        for (const raw of list) box.appendChild(createPreviewBlockEl(raw, false));
    }, HOSTILE);
    await sleep(300);
    if (await page.evaluate(() => window.__pwned)) fail('could run', 'hostile list', 'a hostile line actually ran');

    const byCheck = {};
    failures.forEach(b => { byCheck[b.check] = (byCheck[b.check] || 0) + 1; });
    failures.slice(0, Number(process.env.TZ_SHOW || 25)).forEach(b => console.error('  FAIL ' + b.check + ' in ' + b.where + '\n         ' + b.detail));
    if (lines < 100) fail('not looking', '', 'only ' + lines + ' lines');
    console.log(`files=${files.length} lines=${lines} spokenLines=${spoken} failures=${failures.length} ${JSON.stringify(byCheck)} seconds=${Math.round((Date.now() - started) / 1000)}`);
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(failures.length ? 'REAL FILES PROPERTIES FAILED' : 'REAL FILES PROPERTIES PASSED');
process.exit(failures.length ? 1 : 0);
