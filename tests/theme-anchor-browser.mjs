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
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('THEME ANCHOR FAILED'); process.exit(1); }
console.log('THEME ANCHOR PASSED');
