/**
 * Changing theme keeps the reader on the paragraph they were reading.
 *
 * A theme carries a font and a size. Both re-break every line, so the same page NUMBER
 * holds different text afterwards. applyTheme set them straight onto the root, the book
 * repaginated underneath, and the reader was left wherever the old page number now fell.
 * Font Appearance and spacing already went through applySpacing -- read the block on
 * screen, change, seek back -- and themes did not.
 *
 * The control matters: if the size change did not move the anchor onto a different page,
 * the anchor staying visible would prove nothing. So the suite also asserts that the
 * relayout genuinely moved it.
 *
 * The second half is the case a BLOCK anchor gets wrong. A page that opens partway
 * through a paragraph has, as its first block of its own, whatever starts below that
 * paragraph -- so returning to that block lands on the page where the next paragraph
 * begins, which after a size change can be the page after the text being read. Measured
 * in a real book: the first text on screen was the tail of a paragraph from the previous
 * page. So that half asserts on the first CHARACTER on screen, and its control is that
 * the page really does open mid-paragraph.
 *
 *   node tests/theme-anchor-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled, sleep } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const FONT = "'Literata', 'Merriweather', serif";

/** Is the block visible on the page currently in view? */
function anchorState(mi) {
    const ed = document.getElementById('editor');
    const host = ed.getBoundingClientRect();
    const el = elementForModelIndex(mi);
    let visible = false;
    if (el) {
        for (const r of el.getClientRects()) {
            if (r.width < 1 || r.height < 1) continue;
            if (r.right <= host.left + 1 || r.left >= host.right - 1) continue;
            if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) continue;
            visible = true;
            break;
        }
    }
    return {
        visible,
        page: PageMap.current(),
        pageOfAnchor: PageMap.pageOfBlock(mi),
        count: PageMap.count(),
        fs: document.documentElement.style.getPropertyValue('--fs')
    };
}

/** Poll for the anchor to be on screen, then hold past the settle chain and re-check. */
async function landed(page, mi) {
    const start = Date.now();
    let st = null;
    while (Date.now() - start < 3000) {
        st = await page.evaluate(anchorState, mi);
        if (st.visible) break;
        await sleep(100);
    }
    // applySpacing's settle chain keeps correcting for ~1.5s. A late correction that
    // moved the view off the anchor would be the bug in another form, so look again once
    // the chain has run out.
    const waited = Date.now() - start;
    if (waited < 1800) await sleep(1800 - waited);
    return await page.evaluate(anchorState, mi);
}

/** The first character actually on screen, remembered in the page for later. */
function markFirstChar() {
    const ed = document.getElementById('editor');
    const host = ed.getBoundingClientRect();
    const on = (rc) => rc && rc.width >= 1 && rc.right > host.left + 1 && rc.left < host.right - 1
        && rc.bottom > host.top + 1 && rc.top < host.bottom - 1;
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n, hit = null;
    while (!hit && (n = w.nextNode())) {
        if (!n.nodeValue.trim()) continue;
        const whole = document.createRange();
        whole.selectNodeContents(n);
        if (!Array.from(whole.getClientRects()).some(on)) continue;
        const r = document.createRange();
        for (let i = 0; i < n.nodeValue.length; i++) {
            r.setStart(n, i); r.setEnd(n, i + 1);
            if (on(r.getClientRects()[0])) { hit = { n, i }; break; }
        }
    }
    window.__firstChar = hit;
    const mi = topLeftModelIndexTwoCol();
    const bel = mi >= 0 ? elementForModelIndex(mi) : null;
    return {
        page: PageMap.current(),
        text: hit ? hit.n.nodeValue.substr(hit.i, 40) : null,
        charInAnchor: !!(hit && bel && bel.contains(hit.n))
    };
}

/** Is the remembered character on screen now? */
function firstCharVisible() {
    const hit = window.__firstChar;
    if (!hit || !hit.n.isConnected) return false;
    const ed = document.getElementById('editor');
    const host = ed.getBoundingClientRect();
    const r = document.createRange();
    r.setStart(hit.n, hit.i); r.setEnd(hit.n, hit.i + 1);
    const rc = r.getClientRects()[0];
    return !!(rc && rc.width >= 1 && rc.right > host.left + 1 && rc.left < host.right - 1
        && rc.bottom > host.top + 1 && rc.top < host.bottom - 1);
}

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
    await page.evaluate((m) => loadMarkdownContent(m), md);
    await settled(page);
    // A baseline theme first, so the change below is not the first application (which
    // is deliberately left to the resume logic).
    await page.evaluate((f) => applyTheme({ Name: 'Base', Bg: '#282828', Tx: '#EBDBB2', FN: f, FS: 16 }), FONT);
    await settled(page);
    await page.evaluate(() => handleCommand('view_set:mode:reader'));
    await settled(page);
    await page.evaluate(() => handleCommand('view_set:columns:2'));
    await settled(page);
    const paged = await page.evaluate(() => isPaginatedLayout());
    assert(paged, 'control: the layout is paginated');

    // Out-wait the column switch before moving. Its settle chain re-seeks to the
    // remembered anchor for ~1.5s, and a goto issued inside that window gets dragged back
    // to block 0 -- which made one run of this suite read page 0, where nothing can move
    // and every "still visible" check passes for free.
    await sleep(2000);
    await page.evaluate(() => PageMap.goto(12));
    for (let i = 0; i < 20; i++) {
        if (await page.evaluate(() => PageMap.current()) === 12) break;
        await sleep(100);
    }
    await sleep(600);
    const anchor = await page.evaluate(() => topLeftModelIndexTwoCol());
    const before = await page.evaluate(anchorState, anchor);
    info('reading block ' + anchor + ' on page ' + before.page + ' of ' + before.count + ' at ' + before.fs);
    assert(anchor > 0 && before.visible, 'control: an anchor block is on screen before the change');

    for (const fsNew of [22, 14]) {
        console.log('\n=== theme change to ' + fsNew + 'px ===');
        const pageBefore = await page.evaluate(() => PageMap.current());
        await page.evaluate((a) => applyTheme({ Name: 'T' + a.fs, Bg: '#1d2021', Tx: '#ebdbb2', FN: a.font, FS: a.fs }),
            { fs: fsNew, font: FONT });
        const st = await landed(page, anchor);
        info('now page ' + st.page + ' of ' + st.count + ' at ' + st.fs
            + '; the anchor is on page ' + st.pageOfAnchor + (st.visible ? ' (visible)' : ' (NOT visible)'));
        assert(st.fs === fsNew + 'px', 'control: the theme size was applied');
        assert(st.pageOfAnchor !== pageBefore,
            'control: the relayout moved the paragraph to a different page (' + pageBefore + ' -> ' + st.pageOfAnchor + ')');
        assert(st.visible, 'the reader is still on the paragraph they were reading');
    }
    console.log('\n=== long paragraphs: the page opens mid-paragraph ===');
    const sentence = 'The margin held the line where he had left off the night before, and the page turned under his hand as it always had. ';
    const longMd = Array.from({ length: 80 }, (_, i) => 'Paragraph ' + (i + 1) + '. ' + sentence.repeat(14)).join('\n\n');
    await page.evaluate((m) => loadMarkdownContent(m), longMd);
    await settled(page);
    await page.evaluate((f) => applyTheme({ Name: 'Base2', Bg: '#282828', Tx: '#EBDBB2', FN: f, FS: 16 }), FONT);
    await sleep(2000);
    assert(await page.evaluate(() => isPaginatedLayout()), 'control: still paginated after loading the second document');

    let mark = null;
    for (let p = 6; p <= 16 && !(mark && !mark.charInAnchor); p++) {
        await page.evaluate((x) => PageMap.goto(x), p);
        await sleep(700);
        mark = await page.evaluate(markFirstChar);
    }
    info('page ' + mark.page + ' opens with ' + JSON.stringify(mark.text) + ' (inside the anchor block: ' + mark.charInAnchor + ')');
    assert(mark && !mark.charInAnchor,
        'control: the page opens mid-paragraph, so the first text on screen is not in the first block that starts there');

    for (const fsNew of [22, 13]) {
        const pageBefore = await page.evaluate(() => PageMap.current());
        const m = await page.evaluate(markFirstChar);
        await page.evaluate((a) => applyTheme({ Name: 'L' + a.fs, Bg: '#1d2021', Tx: '#ebdbb2', FN: a.font, FS: a.fs }),
            { fs: fsNew, font: FONT });
        const start = Date.now();
        let vis = false;
        while (Date.now() - start < 3000) {
            vis = await page.evaluate(firstCharVisible);
            if (vis) break;
            await sleep(100);
        }
        const waited = Date.now() - start;
        if (waited < 1800) await sleep(1800 - waited);
        vis = await page.evaluate(firstCharVisible);
        const after = await page.evaluate(() => PageMap.current());
        info(fsNew + 'px: page ' + pageBefore + ' -> ' + after + '; ' + JSON.stringify(m.text)
            + (vis ? ' is on screen' : ' is NOT on screen'));
        assert(after !== pageBefore, 'control: the ' + fsNew + 'px change moved the text to a different page');
        assert(vis, 'the text at the top of the page is still on screen after a ' + fsNew + 'px theme');
    }
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('THEME ANCHOR FAILED'); process.exit(1); }
console.log('THEME ANCHOR PASSED');
