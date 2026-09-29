/**
 * Print / Export PDF gets the whole document, in every layout. Headless.
 *
 * Chromium prints the layout on screen, and on screen the document lives inside one
 * window-sized box -- a scroller in Scroll view, a sideways band of columns in Pages. With no
 * print rules every print was a single sheet: a 134-page book printed its cover and nothing
 * else (Ed, 2026-09-29). Printing is a listed Store feature.
 *
 * Under print media the document must flow down the page: the page as tall as the text, the
 * last paragraph below the first rather than off to the right, no columns, no sidebar.
 *
 *   node tests/print-layout-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled, sleep } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function assert(c, msg) { if (c) { passed++; console.log('  OK   ' + msg); } else { failed++; console.error('  FAIL ' + msg); } }

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
const deadline = setTimeout(() => { console.error('PRINT LAYOUT: deadline'); try { browser.process().kill('SIGKILL'); } catch (e) {} process.exit(3); }, 60000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    const md = Array.from({ length: 120 }, (_, i) => 'Paragraph ' + i + '. ' + 'The margin held the line where he had left off the night before. '.repeat(6)).join('\n\n');
    await page.evaluate((m) => loadMarkdownContent(m), md);
    await settled(page);

    const printed = async () => {
        await page.emulateMediaType('print');
        await sleep(200);
        const r = await page.evaluate(() => {
            const blocks = document.querySelectorAll('#editor .block');
            const first = blocks[0].getBoundingClientRect(), last = blocks[blocks.length - 1].getBoundingClientRect();
            const sb = document.getElementById('sidebar');
            return {
                doc: document.documentElement.scrollHeight,
                edH: document.getElementById('editor').scrollHeight,
                cols: getComputedStyle(document.getElementById('editor')).columnWidth,
                firstLeft: Math.round(first.left), lastLeft: Math.round(last.left),
                lastBelow: last.top > first.top,
                sidebar: !!sb && getComputedStyle(sb).display !== 'none'
            };
        });
        await page.emulateMediaType('screen');
        return r;
    };
    const check = (label, r) => {
        console.log('  ..   ' + label + ': ' + JSON.stringify(r));
        assert(r.doc >= r.edH && r.doc > 5000, label + ': the printed page is as tall as the document (' + r.doc + ' px), not one window');
        assert(r.lastBelow && Math.abs(r.lastLeft - r.firstLeft) < 50 && r.cols === 'auto',
            label + ': the last paragraph prints below the first, in one column');
        assert(!r.sidebar, label + ': the sidebar is not printed');
    };

    check('Preview, Scroll', await printed());
    await page.evaluate(() => handleCommand('view_set:mode:reader')); await sleep(800);
    await page.evaluate(() => handleCommand('view_set:columns:2')); await sleep(1500);
    assert(await page.evaluate(() => document.body.classList.contains('tz-pages')), 'control: 2-Col Pages is really paginated on screen');
    check('Reader, 2-Col Pages', await printed());
    // Printing must not leave the screen layout changed.
    const back = await page.evaluate(() => ({ paged: document.body.classList.contains('tz-pages'), cols: getComputedStyle(document.getElementById('editor')).columnWidth }));
    assert(back.paged && back.cols !== 'auto', 'after printing, the screen is paginated again (columns ' + back.cols + ')');
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('PRINT LAYOUT FAILED'); process.exit(1); }
console.log('PRINT LAYOUT PASSED');
