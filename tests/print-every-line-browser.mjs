/**
 * Print / Export PDF loses nothing: every block of a real document is in the PDF, in order,
 * in every layout (2026-11-22).
 *
 * print-layout-browser counts pages ("more than 60"); a PDF one page short would pass it.
 * This reads the text of every page and finds each block's text there, in document order
 * (whitespace ignored, so line wrapping and table cells cannot fail it). A missing page, a
 * cut-off last page or a dropped block is a FAIL that names the first missing block.
 *
 *   node tests/print-every-line-browser.mjs     (about 30 s; FILES=a.md,b.md to choose)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.TZ_ROOT || path.join(here, '..');
const FILES = (process.env.FILES || [path.join(here, '..', 'README.md'), path.join(here, '..', 'docs', 'known-issues.md'), path.join(here, 'large-scroll-mixed.md')].join(',')).split(',');
const LAYOUTS = {
    'Preview, Scroll': ['view_set:mode:preview', 'view_set:columns:1', 'view_set:scroll:scroll'],
    'Preview, 2-Col Scroll': ['view_set:mode:preview', 'view_set:columns:2', 'view_set:scroll:scroll'],
    'Preview, 2-Col Pages': ['view_set:mode:preview', 'view_set:columns:2', 'view_set:scroll:pagination'],
};
let passed = 0, failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 120000 });
const deadline = setTimeout(() => { console.error('  FAIL over budget (150 s)'); try { browser.process().kill('SIGKILL'); } catch (e) { } process.exit(1); }, 150000);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const squash = (s) => String(s || '').replace(/[\s ​﻿]+/g, '');
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    for (const file of FILES) {
        const md = fs.readFileSync(file, 'utf8');
        for (const [label, cmds] of Object.entries(LAYOUTS)) {
            const tag = path.basename(file) + ', ' + label;
            await page.evaluate((c) => c.forEach(x => handleCommand(x)), cmds);
            await page.evaluate((m) => { setSourceDocExt('md'); loadMarkdownContent(m); }, md);
            await new Promise(r => setTimeout(r, 900));
            // A document that is all on screen prints the live editor ('' = already whole);
            // a longer one prints a whole copy built from the model.
            const prep = await page.evaluate(() => tzPreparePrint());
            const total = await page.evaluate(() => DocumentModel.blocks.length);
            if (prep !== '' && prep !== 'ok:' + total) { assert(false, tag + ': a whole copy to print from (' + prep + ' of ' + total + ')'); continue; }
            await page.emulateMediaType('print');
            await new Promise(r => setTimeout(r, 300));
            // What each block shows, from what is printed. Pictures and empty lines have no
            // text to find; they are skipped, not passed.
            const blocks = await page.evaluate((copy) => [...document.querySelectorAll(copy ? '#editor.tz-print-copy .block' : '#editor .block')].map(b => b.innerText || ''), prep !== '');
            if (blocks.length !== total) { assert(false, tag + ': what prints has every block (' + blocks.length + ' of ' + total + ')'); continue; }
            // CONTROL=1: hide one block from print, as a lost page would; this must FAIL.
            if (process.env.CONTROL) await page.evaluate((copy) => { const bs = document.querySelectorAll(copy ? '#editor.tz-print-copy .block' : '#editor .block'); const b = [...bs].reverse().find(x => (x.innerText || '').trim().length > 20); b.style.display = 'none'; }, prep !== '');
            const pdf = await page.pdf({ format: 'A4' });
            const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
            let text = '';
            for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map(it => it.str).join('');
            try { await doc.cleanup(); } catch (e) { }
            const hay = squash(text);
            let at = 0, missing = -1, checked = 0;
            // A block's own text, or the start of it for a long one. Text that occurs once in
            // the document must be found in order; repeated text (a fixture's repeated table)
            // only present, or the search jumps to a later copy and everything after "misses".
            // The first line only: a page break inside a table or code block puts the page
            // number and a repeated table header between its lines, which is printing, not loss.
            const probes = blocks.map(b => { const first = String(b || '').split('\n').find(l => squash(l)) || ''; const w = squash(first); return w.length > 60 ? w.slice(0, 60) : w; });
            const seen = {}; probes.forEach(p => { if (p) seen[p] = (seen[p] || 0) + 1; });
            for (let i = 0; i < blocks.length; i++) {
                const probe = probes[i];
                if (!probe) continue;
                if (seen[probe] > 1) { if (hay.indexOf(probe) < 0) { missing = i; break; } checked++; continue; }
                const k = hay.indexOf(probe, at);
                // A table or code block's last line too: a block cut off at a page edge keeps
                // its first line.
                if (k >= 0) {
                    const lines = String(blocks[i] || '').split('\n').filter(l => squash(l));
                    if (lines.length > 1) {
                        const lastLine = squash(lines[lines.length - 1]).slice(0, 60);
                        if (hay.indexOf(lastLine, k) < 0) { missing = i; break; }
                    }
                }
                if (k < 0) {
                    if (process.env.DEBUG) {
                        let j = i - 1; while (j > 0 && !probes[j]) j--;
                        const pk = hay.indexOf(probes[j], Math.max(0, at - probes[j].length - 5));
                        const m = probe.match(/v\d+_/); const vk = m ? hay.indexOf(m[0]) : -1;
                        console.log('  ..   miss at block ' + i + ' probe=' + JSON.stringify(probe.slice(0, 50)) + '\n       PDF after previous block: ' + JSON.stringify(hay.slice(pk, pk + 260)) + (m ? '\n       first ' + m[0] + ' in PDF: ' + JSON.stringify(hay.slice(Math.max(0, vk - 40), vk + 200)) : ''));
                    }
                    missing = i; break;
                }
                at = k + probe.length; checked++;
            }
            const lastShown = squash(blocks.filter(b => squash(b)).pop()).slice(-40);
            assert(missing < 0 && hay.indexOf(lastShown) >= 0,
                tag + ': every block is in the PDF, in order (' + checked + ' blocks with text, ' + doc.numPages + ' pages)'
                + (missing >= 0 ? ' -- first missing is block ' + missing + ': ' + JSON.stringify(blocks[missing].slice(0, 60)) : ''));
            await page.emulateMediaType('screen');
            await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
        }
        // Source prints the source text: every line of the file, in order.
        {
            const tag = path.basename(file) + ', Source';
            await page.evaluate((m) => { setSourceDocExt('md'); handleCommand('view_set:mode:source'); loadMarkdownContent(m); }, md);
            await new Promise(r => setTimeout(r, 900));
            const prep = await page.evaluate(() => tzPreparePrint());
            await page.emulateMediaType('print');
            await new Promise(r => setTimeout(r, 300));
            const pdf = await page.pdf({ format: 'A4' });
            const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false }).promise;
            let text = '';
            for (let i = 1; i <= doc.numPages; i++) text += (await (await doc.getPage(i)).getTextContent()).items.map(it => it.str).join('');
            try { await doc.cleanup(); } catch (e) { }
            // The PDF's text layer gives a no-break hyphen back as "-".
            const norm = (s) => squash(s).replace(/‑/g, '-');
            const hay = norm(text);
            const lines = md.replace(/\r\n/g, '\n').split('\n').map(l => norm(l).slice(0, 50)).filter(Boolean);
            const seen = {}; lines.forEach(l => { seen[l] = (seen[l] || 0) + 1; });
            let at = 0, missing = '';
            for (const l of lines) {
                if (seen[l] > 1) { if (hay.indexOf(l) < 0) { missing = l; break; } continue; }
                const k = hay.indexOf(l, at);
                if (k < 0) { missing = l; break; }
                at = k + l.length;
            }
            assert(!missing, tag + ': every line is in the PDF, in order (' + lines.length + ' lines, ' + doc.numPages + ' pages, ' + prep + ')' + (missing ? ' -- first missing: ' + JSON.stringify(missing) : ''));
            await page.emulateMediaType('screen');
            await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
            const left = await page.evaluate(() => ({ copy: !!document.getElementById('tzPrintSource'), cls: document.body.classList.contains('tz-print-source') }));
            assert(!left.copy && !left.cls, tag + ': after printing the copy is gone');
            await page.evaluate(() => handleCommand('view_set:mode:preview'));
        }
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
