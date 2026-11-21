/**
 * Link and table commands, Preview against Source.
 *
 * Link (through its dialog) on a word, on a bare caret, over two lines; Insert Table (through
 * its picker) mid-line, on an empty line and at the end; Bold on a word in a table cell; Heading
 * and Quote on a table. Then a letter is typed. Prints both views side by side and fails where
 * the saved text, or the text after the typed letter, differs between them.
 *
 *   node tests/link-table-consistency-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (200 s)'); process.exit(1); }, 200000);
let passed = 0, failed = 0;
const VERBOSE = !!process.env.VERBOSE;

const TABLE = '| a | b |\n| --- | --- |\n| cell one | two |';
const CASES = [
    // [label, doc, where: {line, from, to} (to -1 = Shift+Down), action]
    ['link on a word', 'One two three\nFour five', { line: 0, from: 4, to: 7 }, 'link'],
    ['link on a caret', 'One two three\nFour five', { line: 0, from: 4, to: 4 }, 'link'],
    ['link over two lines', 'One two three\nFour five', { line: 0, from: 4, to: -1 }, 'link'],
    ['table mid-line', 'One two three\nFour five', { line: 0, from: 4, to: 4 }, 'table'],
    ['table on an empty line', 'One\n\nFour five', { line: 1, from: 0, to: 0 }, 'table'],
    ['table at the end', 'One two', { line: 0, from: 7, to: 7 }, 'table'],
    ['bold in a table cell', 'Intro\n' + TABLE, { cell: 'cell one', from: 0, to: 4 }, 'bold'],
    ['heading on a table', 'Intro\n' + TABLE, { cell: 'cell one', from: 2, to: 2 }, 'h2'],
    ['quote on a table', 'Intro\n' + TABLE, { cell: 'cell one', from: 2, to: 2 }, 'quote'],
];

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    await page.evaluate(() => { postMsg = function () {}; });
    const saved = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));

    for (const [label, doc, where, action] of CASES) {
        const res = {};
        for (const mode of ['wysiwyg', 'source']) {
            await page.evaluate((m) => { setSourceDocExt('md'); loadMarkdownContent(m); }, doc);
            await page.evaluate((m) => handleCommand('view_set:mode:' + m), mode);
            await settled(page);
            if (mode === 'source') {
                // Character offset of the start point in the raw text.
                const base = await page.evaluate((w, d) => {
                    if (w.cell) return d.indexOf(w.cell) + w.from;
                    return d.split('\n').slice(0, w.line).reduce((n, l) => n + l.length + 1, 0) + w.from;
                }, where, doc);
                await page.evaluate((x) => { sourceEditor.focus(); sourceEditor.setSelectionRange(x, x); }, base);
            } else if (where.cell) {
                await page.evaluate((txt, off) => {
                    const td = [...document.querySelectorAll('#editor td')].find(c => c.textContent.trim() === txt);
                    const tn = document.createTreeWalker(td, NodeFilter.SHOW_TEXT).nextNode();
                    const r = document.createRange(); r.setStart(tn, off); r.collapse(true);
                    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                    document.getElementById('editor').focus();
                }, where.cell, where.from);
            } else {
                const el = await page.$('#editor .block[data-model-index="' + where.line + '"]');
                await el.click(); await page.keyboard.press('Home');
                for (let i = 0; i < where.from; i++) await page.keyboard.press('ArrowRight');
            }
            await page.keyboard.down('Shift');
            if (where.to > where.from) for (let i = where.from; i < where.to; i++) await page.keyboard.press('ArrowRight');
            if (where.to < 0) await page.keyboard.press('ArrowDown');
            await page.keyboard.up('Shift');
            await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, action);
            await settled(page);
            let note = '';
            if (action === 'link') {
                const open = await page.evaluate(() => { const m = document.getElementById('linkModal'); return !!m && !m.hidden; });
                if (open) {
                    await page.focus('#linkModalHref');
                    await page.keyboard.type('https://x.com');
                    await page.keyboard.press('Enter');
                    await settled(page);
                } else note = '(no dialog)';
            }
            if (action === 'table') {
                const cell = await page.evaluate(() => {
                    const cs = [...document.querySelectorAll('#tableSizePicker .tz-table-picker-cell')];
                    if (!cs.length) return null;
                    const r = cs[11].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                });
                if (cell) { await page.mouse.move(cell.x, cell.y); await page.mouse.click(cell.x, cell.y); await settled(page); }
                else note = '(no picker)';
            }
            const out = await saved();
            await page.keyboard.type('Z');
            await settled(page);
            res[mode] = { out, typed: await saved(), note };
        }
        const typedSame = res.wysiwyg.typed === res.source.typed;
        const ok = res.wysiwyg.out === res.source.out && typedSame;
        if (ok) passed++; else failed++;
        console.log((ok ? (typedSame ? '  OK   ' : '  ~~   ') : '  FAIL ') + label + (typedSame ? '' : ' (a typed letter lands differently)'));
        if (VERBOSE || !ok || !typedSame) {
            console.log('       P ' + res.wysiwyg.note + JSON.stringify(res.wysiwyg.out) + '  Z=' + JSON.stringify(res.wysiwyg.typed));
            console.log('       S ' + res.source.note + JSON.stringify(res.source.out) + '  Z=' + JSON.stringify(res.source.typed));
        }
    }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
