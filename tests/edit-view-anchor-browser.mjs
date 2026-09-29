/**
 * An edit on screen stays where it is on screen.
 *
 * Edits that span paragraphs rewrite the text and reload the document: bold, italic,
 * strikethrough, code, heading, quote and list across several lines, Tab on list items,
 * a delete across lines, and undo/redo of any of them. The reload pinned the edited line
 * 48 px from the top (Tab: the top of the document), so bolding four lines half way down
 * the window threw them to the top (Ed, 2026-09-29). Each case puts the first edited line
 * 500 px down, applies the edit, and checks it is still there -- and that the edit really
 * happened, since a no-op would pass for free.
 *
 * The other half of the rule: an edit that is NOT on screen is brought into view (undo
 * from far away). And in 2-Col the page numbers survive the reload (0.10.15: pages 3-4
 * read 1-2 of ~36 after Ctrl+Y).
 *
 *   node tests/edit-view-anchor-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { sleep } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const big = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
const small = big.split('\n').slice(0, 400).join('\n');
const AT = 500;

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    const findRaw = (re, from) => page.evaluate((src, f) => {
        const r = new RegExp(src);
        for (let i = f || 0; i < DocumentModel.blocks.length; i++) if (r.test(DocumentModel.blocks[i].raw)) return i;
        return -1;
    }, re, from || 0);
    const rawOf = (bi) => page.evaluate((b) => DocumentModel.blocks[b].raw, bi);
    const topOf = (bi) => page.evaluate((b) => {
        const el = editor.querySelector('.block[data-model-index="' + b + '"]');
        if (!el) return null;
        return Math.round(el.getBoundingClientRect().top - mainContainer.getBoundingClientRect().top);
    }, bi);
    const place = (bi, at) => page.evaluate((b, y) => {
        ensureModelBlockVisible(b, { topPad: y });
        const el = editor.querySelector('.block[data-model-index="' + b + '"]');
        mainContainer.scrollTop += Math.round(el.getBoundingClientRect().top - mainContainer.getBoundingClientRect().top) - y;
    }, bi, at);
    // Select whole lines a..b the way a drag does, frozen as mouseup freezes it.
    const select = (a, b) => page.evaluate((x, y) => {
        _formatSelectionFrozen = false;
        const A = editor.querySelector('.block[data-model-index="' + x + '"]');
        const B = editor.querySelector('.block[data-model-index="' + y + '"]');
        focusEditorNoScroll();
        const r = document.createRange();
        r.selectNodeContents(B);
        r.setStart(A, 0);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        snapshotFormatSelectionFromEditor();
        _formatSelectionFrozen = true;
    }, a, b);

    async function steady(label, bi, op) {
        await place(bi, AT);
        await sleep(250);
        const before = await topOf(bi);
        const rawBefore = await rawOf(bi);
        await op();
        await sleep(700);   // past the load's deferred sticky re-apply
        const after = await topOf(bi);
        assert((await rawOf(bi)) !== rawBefore, label + ': control -- the edit was applied');
        assert(before === AT && after != null && Math.abs(after - before) <= 2,
            label + ': the line stays put (' + before + ' -> ' + after + ' px)');
        await page.evaluate(() => HistoryManager.undo());
        await sleep(500);
        const undone = await topOf(bi);
        assert((await rawOf(bi)) === rawBefore && undone != null && Math.abs(undone - before) <= 2,
            label + ': undo restores it in the same place (' + undone + ' px)');
    }

    for (const [name, md] of [['large, virtualised', big], ['small, fully mounted', small]]) {
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await sleep(1200);
        const virt = await page.evaluate(() => !!DocumentModel.virtEnabled);
        console.log('\n=== ' + name + ' (1-Col Scroll, virt ' + virt + ') ===');
        assert(virt === (md === big), 'control: the document is ' + (virt ? '' : 'not ') + 'virtualised');
        const bi = await findRaw('scroll marker row 92\\b');
        for (const t of ['bold', 'italic', 'strike', 'code', 'h2', 'quote', 'list']) {
            await steady(t + ' on 4 lines', bi, async () => {
                await select(bi, bi + 3);
                await page.evaluate((f) => applyFormatting(f), t);
            });
        }
        const bul = await findRaw('bullet item two', bi);
        await steady('Tab on 2 list items', bul, async () => {
            await select(bul, bul + 1);
            await page.evaluate(() => applyListIndentToSelection(1));
        });
        await steady('delete across 4 lines', bi, async () => {
            await select(bi, bi + 3);
            await page.keyboard.press('Backspace');
        });
    }

    console.log('\n=== an edit off screen is brought into view ===');
    {
        const bi = await findRaw('scroll marker row 92\\b');
        await place(bi, AT);
        await sleep(250);
        await select(bi, bi + 3);
        await page.evaluate(() => applyFormatting('bold'));
        await sleep(500);
        await page.evaluate(() => { mainContainer.scrollTop += 20000; });
        await sleep(500);
        const away = await topOf(bi);
        assert(away == null || away < 0 || away > 900, 'control: the edit is off screen (' + away + ')');
        await page.evaluate(() => HistoryManager.undo());
        await sleep(500);
        const back = await topOf(bi);
        assert(back != null && back >= 0 && back < 900, 'undo brings the edit into view (' + back + ' px)');
    }

    console.log('\n=== 2-Col: page numbers survive the reload ===');
    await page.evaluate((m) => loadMarkdownContent(m), big);
    await sleep(800);
    await page.evaluate(() => handleCommand('view_set:mode:preview'));
    await page.evaluate(() => handleCommand('view_set:columns:2'));
    await sleep(2000);
    await page.evaluate(() => PageMap.goto(1));
    await sleep(400);
    const pst = () => page.evaluate(() => ({
        text: (document.getElementById('page-indicator') || {}).textContent,
        cur: PageMap.current(),
        mounted: editor.querySelectorAll('.block').length
    }));
    const p0 = await pst();
    assert(p0.cur === 1 && p0.mounted <= 800, 'control: on spread 1 with one range mounted (' + p0.text + ')');
    const tl = await page.evaluate(() => topLeftModelIndexTwoCol() + 6);
    for (const step of ['bold', 'undo', 'redo']) {
        if (step === 'bold') {
            await select(tl, tl + 3);
            await page.evaluate(() => applyFormatting('bold'));
        } else {
            await page.evaluate((s) => HistoryManager[s](), step);
        }
        await sleep(600);
        const p = await pst();
        assert(p.text === p0.text && p.cur === p0.cur && p.mounted <= 800,
            step + ': same page and numbers, one range mounted (' + p.text + ', ' + p.mounted + ' blocks)');
    }
} finally {
    await browser.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
