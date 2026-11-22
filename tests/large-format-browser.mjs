/**
 * Formatting over a selection of hundreds of lines in a LARGE document, every layout
 * (2026-11-22). From the Format menu (fmt:<type>, as the host sends it): Heading 2, Quote,
 * bullet list, numbered list, checklist, Italic, inline code, strikethrough, Paragraph, over Shift+PageDown x3 from the middle of the
 * 4,582-line large-scroll-mixed.md. The lines above and below the selection must not change, the
 * text inside it must be the same text (only marks added or taken away), and one Undo must give
 * the file back.
 *
 *   node tests/large-format-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = process.env.TZ_ROOT || path.join(here, '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (240 s)'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }, 240000);
let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; } else { failed++; console.error('  FAIL ' + msg); } }
const TEXT = fs.readFileSync(path.join(here, 'large-scroll-mixed.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const LAYOUTS = { '1-column': ['view_set:columns:1', 'view_set:scroll:scroll'], '2-column': ['view_set:columns:2', 'view_set:scroll:scroll'], 'two pages': ['view_set:columns:2', 'view_set:scroll:pagination'] };
const FORMATS = ['h2', 'quote', 'list', 'ol', 'checklist', 'italic', 'code', 'strike', 'para'];
// The words of a stretch of Markdown, without any of its marks.
const words = (t) => t.replace(/^\s*(#{1,6} |> ?|[-*+] |\d+[.)] |\[[ xX]\] )+/gm, '').replace(/[*_`~#>|\\]/g, '').replace(/\s+/g, '');

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message.slice(0, 160)); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80)))));
    const doc = () => page.evaluate(() => getMarkdownContent(false).replace(/\n+$/, ''));
    const ctrl = async (k) => { await page.keyboard.down('Control'); await page.keyboard.press(k); await page.keyboard.up('Control'); };
    const O = TEXT.split('\n');

    for (const [layout, cmds] of Object.entries(LAYOUTS)) {
        const selectBig = async () => {
            await page.evaluate((t, c) => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, TEXT, cmds);
            await quiet(); await quiet();
            const at = await page.evaluate(async () => {
                const bi = DocumentModel.blocks.findIndex(b => String(b.raw).indexOf('Line 2002 of') >= 0);
                goToModelBlock(bi); await new Promise(r => setTimeout(r, 250));
                const b = document.querySelector('#editor .block[data-model-index="' + bi + '"]'); if (!b) return null;
                const r = b.getBoundingClientRect(); return { x: r.left + 4, y: r.top + Math.min(r.height / 2, 10) };
            });
            if (!at) throw new Error(layout + ': could not put the cursor on Line 2002');
            await page.mouse.click(at.x, at.y); await page.keyboard.press('Home'); await quiet();
            await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) { await page.keyboard.press('PageDown'); await quiet(); } await page.keyboard.up('Shift');
        };
        // Where the selection ends, from typing over it (large-selection-browser checks that).
        await selectBig(); await page.keyboard.type('Z'); await quiet();
        const R = (await doc()).split('\n'), top = R.findIndex(l => l.indexOf('Z') >= 0), tailN = R.length - top - 1;
        const zLine = R[top];
        for (const f of FORMATS) {
            await selectBig();
            await page.evaluate((type) => { freezeFormatSelection(); applyFormatting(type); }, f); await quiet(); await quiet();
            const t = await doc(); const T = t.split('\n');
            const above = T.slice(0, top).join('\n') === O.slice(0, top).join('\n');
            const below = T.slice(T.length - tailN).join('\n') === O.slice(O.length - tailN).join('\n');
            const inT = T.slice(top, T.length - tailN).join('\n'), inO = O.slice(top, O.length - tailN).join('\n');
            ok(t !== TEXT, layout + ', ' + f + ' over hundreds of lines changes something');
            ok(above && below, layout + ', ' + f + ': nothing above or below the selection changes' + (above ? '' : ' (above changed)') + (below ? '' : ' (below changed)'));
            ok(words(inT) === words(inO), layout + ', ' + f + ': inside the selection, the same text (' + O.length + ' -> ' + T.length + ' lines; ' + words(inO).length + ' vs ' + words(inT).length + ' characters)');
            await ctrl('KeyZ'); await quiet();
            ok((await doc()) === TEXT, layout + ', ' + f + ': one Undo gives the file back');
        }
        console.log('  ..   ' + layout + ': ' + passed + ' passed, ' + failed + ' failed so far');
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
