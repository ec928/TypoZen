/**
 * Export to HTML holds the whole document, including what was typed a moment ago, in every
 * layout and in Source (2026-11-22).
 *
 * The export is built from the document model, not the screen, so a long document is not cut
 * to the part on screen. This checks it: every block's text is in the exported page, in order,
 * for real files in three layouts; and a word typed just before exporting is in it -- typed in
 * Preview, and typed in Source without switching back.
 *
 *   node tests/export-html-whole-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.TZ_ROOT || path.join(here, '..');
const FILES = [path.join(here, '..', 'README.md'), path.join(here, '..', 'docs', 'known-issues.md'), path.join(here, 'large-scroll-mixed.md')];
const LAYOUTS = {
    'Preview, Scroll': ['view_set:mode:preview', 'view_set:columns:1', 'view_set:scroll:scroll'],
    'Preview, 2-Col Pages': ['view_set:mode:preview', 'view_set:columns:2', 'view_set:scroll:pagination'],
};
let passed = 0, failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }
const squash = (s) => String(s || '').replace(/[\s ​﻿]+/g, '');
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 120000 });
const deadline = setTimeout(() => { console.error('  FAIL over budget (120 s)'); try { browser.process().kill('SIGKILL'); } catch (e) { } process.exit(1); }, 120000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    // The export's text, block by block, as a reader of the HTML file would see it.
    const exported = () => page.evaluate(() => {
        const d = new DOMParser().parseFromString(generateExportHtml(), 'text/html');
        return d.body.textContent;
    });
    for (const file of FILES) {
        const md = fs.readFileSync(file, 'utf8');
        for (const [label, cmds] of Object.entries(LAYOUTS)) {
            const tag = path.basename(file) + ', ' + label;
            await page.evaluate((c) => c.forEach(x => handleCommand(x)), cmds);
            await page.evaluate((m) => { setSourceDocExt('md'); loadMarkdownContent(m); }, md);
            await new Promise(r => setTimeout(r, 800));
            // Every block, rendered on its own from the model: its first line must be in the export, in order.
            const blocks = await page.evaluate(() => DocumentModel.blocks.map((b, i) => { const el = createPreviewBlockEl(b.raw, false, i); document.body.appendChild(el); const t = el.textContent; el.remove(); return t; }));
            const hay = squash(await exported());
            const probes = blocks.map(b => { const first = String(b || '').split('\n').find(l => squash(l)) || ''; return squash(first).slice(0, 60); });
            const seen = {}; probes.forEach(p => { if (p) seen[p] = (seen[p] || 0) + 1; });
            let at = 0, missing = -1, checked = 0;
            for (let i = 0; i < probes.length; i++) {
                const p = probes[i]; if (!p) continue;
                if (seen[p] > 1) { if (hay.indexOf(p) < 0) { missing = i; break; } checked++; continue; }
                const k = hay.indexOf(p, at); if (k < 0) { missing = i; break; }
                at = k + p.length; checked++;
            }
            assert(missing < 0, tag + ': every block is in the export, in order (' + checked + ' of ' + blocks.length + ' blocks with text)' + (missing >= 0 ? ' -- first missing ' + missing + ': ' + JSON.stringify(blocks[missing].slice(0, 60)) : ''));
        }
    }
    // A word typed just now is in the export: Preview, then Source without switching back.
    const md = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8');
    await page.evaluate((m) => { handleCommand('view_set:columns:1'); handleCommand('view_set:scroll:scroll'); handleCommand('view_set:mode:preview'); loadMarkdownContent(m); }, md);
    await new Promise(r => setTimeout(r, 800));
    const at = await page.evaluate(() => { const b = [...document.querySelectorAll('#editor .block')].find(x => x.querySelector('p') && x.textContent.length > 40 && !x.querySelector('code, a, strong')); b.scrollIntoView(); const r = b.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; });
    await page.mouse.click(at.x, at.y); await page.keyboard.press('End'); await page.keyboard.type(' QzPreviewWord');
    assert(squash(await exported()).indexOf('QzPreviewWord') >= 0, 'a word typed in Preview a moment ago is in the export');
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(() => { const se = sourceEditor; se.focus(); se.setSelectionRange(se.value.length, se.value.length); });
    await page.keyboard.type(' QzSourceWord');
    const src = squash(await exported());
    assert(src.indexOf('QzSourceWord') >= 0, 'a word typed in Source a moment ago is in the export, without switching back');
    assert(src.indexOf('QzPreviewWord') >= 0, 'and so is the one typed in Preview before');
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
