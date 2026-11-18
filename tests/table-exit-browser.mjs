/**
 * The caret used to fall out of a table and stay there. Letters typed on the
 * border were drawn and then dropped, because a table saves only its cells.
 *
 *   node tests/table-exit-browser.mjs
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import puppeteer from 'puppeteer';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { settled, sleep } = await import(pathToFileURL(path.join(appDir, 'tests', 'settle.mjs')).href);

const TABLE = [
    '| Header 1 | Header 2 | Header 3 | Header 4 |',
    '| --- | --- | --- | --- |',
    '| Cell1,1 | Cell1,2 | Cell1,3 | Cell1,4 |',
    '| Cell2,1 | Cell2,2 | Cell2,3 | Cell2,4 |',
    '| Cell6,1 | Cell6,2 | Cell6,3 | Cell6,4 |'
].join('\n');

let passed = 0, failed = 0;
function check(ok, msg, got) {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + (got !== undefined ? '\n         ' + JSON.stringify(got) : '')); }
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
const timer = setTimeout(() => { console.error('FAIL over budget'); browser.close().catch(() => {}); process.exit(1); }, 40000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => check(false, 'page threw: ' + e.message));
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });

    async function load(doc) {
        await page.evaluate((d) => {
            localStorage.clear();
            handleCommand('view_set:mode:preview');
            handleCommand('view_set:columns:1');
            handleCommand('view_set:scroll:scroll');
            loadMarkdownContent(d);
        }, doc);
        await settled(page);
    }
    const where = () => page.evaluate(() => {
        const sel = getSelection();
        const n = sel && sel.anchorNode;
        const el = n && (n.nodeType === 1 ? n : n.parentElement);
        const cell = el && el.closest ? el.closest('td, th') : null;
        const block = el && el.closest ? el.closest('#editor .block') : null;
        const blocks = Array.prototype.slice.call(document.querySelectorAll('#editor .block'));
        return {
            inCell: !!cell,
            cell: cell ? cell.textContent : '',
            blockIndex: block ? blocks.indexOf(block) : -1,
            blocks: blocks.length,
            hasTable: !!(block && block.querySelector('table')),
            raw: block ? (block.getAttribute('data-raw') || '') : '',
            md: getMarkdownContent(false)
        };
    });
    async function clickCell(sel) {
        const pt = await page.evaluate((s) => {
            const cell = document.querySelector(s);
            const r = cell.getBoundingClientRect();
            return { x: r.left + 10, y: r.top + r.height / 2 };
        }, sel);
        await page.mouse.click(pt.x, pt.y);
        await sleep(80);
    }

    console.log('\n=== a short table\'s frame sits on the last column ===');
    await load(TABLE);
    const edge = await page.evaluate(() => {
        const w = document.querySelector('#editor .table-wrapper').getBoundingClientRect();
        const cell = document.querySelector('#editor tbody tr:last-child td:last-child').getBoundingClientRect();
        const ed = document.getElementById('editor').getBoundingClientRect();
        return { gap: w.right - cell.right, wrap: w.width, ed: ed.width };
    });
    check(edge.gap < 3 && edge.wrap < edge.ed - 40, 'the frame closes on the last column instead of stretching across the page', edge);
    await load([
        '| Media Type | Extensions | Default Layout (User Editable?) |',
        '|---|---|---|',
        '| Code | .html, .css, .js, .cs, .json, .bat, .ps1, .log, .csv | Scroll (Fixed) |'
    ].join('\n'));
    const wide = await page.evaluate(() => {
        const w = document.querySelector('#editor .table-wrapper');
        const wr = w.getBoundingClientRect();
        const cell = w.querySelector('td:last-child').getBoundingClientRect();
        const ed = document.getElementById('editor').getBoundingClientRect();
        return { gap: wr.right - cell.right, wrap: wr.width, ed: ed.width, scroll: w.scrollWidth > w.clientWidth + 2, h: cell.height };
    });
    check(wide.gap < 3 && wide.wrap <= wide.ed + 2 && !wide.scroll, 'a wider table stays inside the page, with the frame on the last column', wide);

    console.log('\n=== last row leaves downward, and the table stays ===');
    await load(TABLE);
    await clickCell('#editor tbody tr:last-child td:last-child');
    await page.keyboard.press('ArrowDown');
    await settled(page);
    let w = await where();
    check(!w.hasTable && w.blockIndex === 1 && w.raw === '', 'ArrowDown from the last row opens a paragraph after the table', w);
    check(w.md.indexOf('Cell6,4') >= 0 && w.md.indexOf('| Header 1 |') === 0, 'the table text is unchanged', w.md);
    await page.keyboard.type('After');
    await settled(page);
    w = await where();
    check(w.raw === 'After' && w.md.endsWith('\nAfter') && !w.hasTable, 'typing lands in that paragraph and is saved', w);

    console.log('\n=== a middle row does not leave, and Enter still does not split ===');
    await load(TABLE);
    await clickCell('#editor tbody tr:first-child td:first-child');
    await page.keyboard.press('ArrowDown');
    await sleep(40);
    w = await where();
    check(w.hasTable && w.inCell && w.blocks === 1, 'ArrowDown from the first data row stays in the table', w);
    await page.keyboard.press('Enter');
    await settled(page);
    w = await where();
    check(w.hasTable && w.blocks === 1 && w.md.indexOf('\nAfter') < 0, 'Enter in a cell leaves the table one block', w.md);
    await page.keyboard.press('Tab');
    await sleep(40);
    w = await where();
    check(w.hasTable && w.inCell && w.blocks === 1 && w.cell !== 'Cell1,1', 'Tab still moves to another cell', w);

    console.log('\n=== a click in a cell stays there ===');
    await clickCell('#editor tbody tr:last-child td:first-child');
    w = await where();
    check(w.hasTable && w.inCell && w.cell.indexOf('Cell6,1') >= 0 && w.blocks === 1, 'a click in a cell does not leave the table', w);

    console.log('\n=== clicks under the table leave ===');
    await load(TABLE);
    // The table toolbar sits just under the grid when there is no room above it.
    // A click on it inserts a row; the exit click has to land on the page instead.
    const spots = await page.evaluate(() => {
        const b = document.querySelector('#editor .block').getBoundingClientRect();
        const ed = document.getElementById('editor').getBoundingClientRect();
        const wrap = document.getElementById('editor-wrapper').getBoundingClientRect();
        function describe(n) {
            if (!n) return 'none';
            if (n.closest && n.closest('#tablePop, #selPop, #linkPop')) return 'popover';
            return n.id || n.tagName;
        }
        let gap = null;
        for (let y = b.bottom + 4; y < b.bottom + 160 && !gap; y += 6) {
            const x = b.left + 36;
            const n = document.elementFromPoint(x, y);
            if (!n || !n.closest) continue;
            if (n.closest('#tablePop, #selPop, #linkPop, button')) continue;
            if (n.closest('td, th')) continue;
            if (n.id === 'editor' || n.id === 'editor-wrapper' || n.closest('#editor'))
                gap = { x: x, y: y, hit: describe(n) };
        }
        const far = { x: ed.left + 30, y: Math.min(ed.bottom - 8, wrap.bottom - 8) };
        const padY = Math.min(wrap.bottom - 24, Math.max(ed.bottom + 40, b.bottom + 80));
        const pad = { x: wrap.left + 48, y: padY };
        return {
            gap: gap, far: far, pad: pad,
            farHit: describe(document.elementFromPoint(far.x, far.y)),
            padHit: describe(document.elementFromPoint(pad.x, pad.y)),
            blockBottom: b.bottom, edBottom: ed.bottom, wrapBottom: wrap.bottom
        };
    });
    console.log('  hits ' + JSON.stringify(spots));
    check(!!spots.gap, 'found a point under the table that is not the toolbar', spots);
    if (spots.gap) {
        await page.mouse.click(spots.gap.x, spots.gap.y);
        await settled(page);
        w = await where();
        check(!w.hasTable && w.blockIndex === 1 && w.md.indexOf('| Header 1 |') === 0, 'a click just under the table opens the next paragraph', w);
    }
    await load(TABLE);
    await page.mouse.click(spots.far.x, spots.far.y);
    await settled(page);
    w = await where();
    check(!w.hasTable && w.blockIndex === 1, 'a click in the empty editor under the table does too', w);
    await load(TABLE);
    await page.mouse.click(spots.pad.x, spots.pad.y);
    await settled(page);
    w = await where();
    check(!w.hasTable && w.blockIndex === 1, 'a click in the empty page under the editor does too', w);

    console.log('\n=== a caret already outside the cells can still be clicked out ===');
    await load(TABLE);
    const beforeMd = await page.evaluate(() => getMarkdownContent(false));
    await page.evaluate(() => {
        const block = document.querySelector('#editor .block');
        const t = document.createTextNode('');
        block.appendChild(t);
        const sel = getSelection();
        const r = document.createRange();
        r.setStart(t, 0);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    });
    await sleep(80);
    const under = await page.evaluate(() => {
        const b = document.querySelector('#editor .block').getBoundingClientRect();
        const x = b.left + 30;
        const y = b.bottom + 6;
        const n = document.elementFromPoint(x, y);
        const pop = n && n.closest && n.closest('#tablePop');
        return { x: x, y: y, pop: !!pop };
    });
    if (!under.pop) {
        await page.mouse.click(under.x, under.y);
        await settled(page);
        w = await where();
        check(!w.hasTable && w.blockIndex === 1 && w.md === beforeMd, 'clicking the border below a stuck caret leaves, and the table is unchanged', w);
    } else {
        check(false, 'the toolbar was still covering the border after the caret left the cells', under);
    }

    console.log('\n=== an existing paragraph is used, not duplicated ===');
    await load(TABLE + '\nAlready here.');
    await clickCell('#editor tbody tr:last-child td:last-child');
    await page.keyboard.press('ArrowDown');
    await settled(page);
    w = await where();
    check(w.raw === 'Already here.' && w.blocks === 2 && w.md.indexOf('\n\n\n') < 0, 'ArrowDown moves into the paragraph that was already there', w);

    console.log('\n=== Backspace from a list into a table leaves the caret in the cell ===');
    await load('1. Keep this\n2. Drop this\n\n| A | B |\n|---|---|\n| C | D |\n');
    const from = await page.evaluate(() => {
        const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
        let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('Drop') < 0) {}
        const i = t.nodeValue.indexOf('Drop');
        const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + 1, y: b.top + b.height / 2 };
    });
    const to = await page.evaluate(() => {
        const cell = document.querySelector('#editor tbody td');
        const r = cell.getBoundingClientRect();
        return { x: r.left + 8, y: r.top + r.height / 2 };
    });
    await page.mouse.click(from.x, from.y);
    await sleep(40);
    await page.keyboard.down('Shift');
    await page.mouse.click(to.x, to.y);
    await page.keyboard.up('Shift');
    await sleep(40);
    await page.keyboard.press('Backspace');
    await settled(page);
    w = await where();
    check(w.inCell && w.cell.indexOf('C') >= 0, 'the caret stays in the cell the selection ended in', w);
    await page.keyboard.type('Q');
    await settled(page);
    w = await where();
    check(w.inCell && w.cell.indexOf('Q') >= 0 && w.cell.indexOf('C') >= 0, 'the next letter is typed in that cell', w);
    check(w.md.indexOf('\nQ\n') < 0 && w.md.indexOf('| Q') >= 0, 'the letter is not a paragraph after the table', w.md);

    console.log('\n=== ArrowUp from the header leaves upward ===');
    await load('Before.\n' + TABLE);
    await clickCell('#editor thead th:first-child');
    await page.keyboard.press('ArrowUp');
    await settled(page);
    w = await where();
    check(w.raw === 'Before.' && !w.hasTable && w.blockIndex === 0, 'ArrowUp from the header moves to the paragraph above', w);

    console.log('\n=== letters already painted on the border are kept ===');
    await load(TABLE);
    await page.evaluate(() => {
        const block = document.querySelector('#editor .block');
        const t = document.createTextNode(',kpo');
        block.appendChild(t);
        const sel = getSelection();
        const r = document.createRange();
        r.setStart(t, t.nodeValue.length);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    });
    await page.keyboard.type('x');
    await settled(page);
    w = await where();
    check(w.raw === ',kpox' && w.md.endsWith('\n,kpox') && !w.hasTable, 'text on the border plus the next letter is its own paragraph', w);
    check(w.md.indexOf('| Header 1 |') === 0 && w.md.indexOf('Cell6,4') >= 0, 'and the table is still there', w.md);
} finally {
    clearTimeout(timer);
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
process.exit(failed ? 1 : 0);
