/**
 * A book opened after another one starts where IT should, not where the other one was.
 *
 * One reported symptom -- "the new book opens on the other tab's page" -- had three
 * separate causes, each hidden behind the one before it:
 *
 *   1. the scroller's offset survived loadBookPayload, so a book with no remembered
 *      position opened on the previous book's page NUMBER;
 *   2. a pending jump to the previous book's remembered block was never cancelled, so a
 *      switch inside its retry window moved the next book there;
 *   3. _readingAnchor was never cleared, so a book sitting on page 1 kept the previous
 *      book's anchor and the next remount (a column switch) moved it there.
 *
 * Driven through the same host messages the app sends (fetch_and_load_book, then the
 * columns and resume_at that follow load_done), with the WebView2 bridge stubbed. Each
 * case is also checked the other way: a book with a remembered position must still
 * land on it, because every fix here is a "forget" and forgetting too much is the
 * obvious regression.
 *
 *   node tests/tab-position-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

/** A synthetic book: n paragraphs long enough that 700 of them run to ~70 pages. */
function book(tag, n) {
    let html = '<html><body>';
    for (let i = 0; i < n; i++) {
        html += '<p>' + tag + ' paragraph ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(12) + '</p>';
    }
    return JSON.stringify({ docs: [{ href: tag + '.xhtml', html: html + '</body></html>' }], toc: [] });
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
        await page.evaluateOnNewDocument(() => {
            window.chrome = { webview: {
                postMessage(m) { if (m === 'load_done') window.__loadDone = (window.__loadDone || 0) + 1; },
                addEventListener(t, f) { if (t === 'message') window.__host = f; }
            } };
        });
        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof window.__host === 'function'
            && typeof loadBookPayload === 'function', { timeout: 5000 });

        const r = await page.evaluate(async (a, b) => {
            const w = ms => new Promise(res => setTimeout(res, ms));
            const urls = { A: URL.createObjectURL(new Blob([a])), B: URL.createObjectURL(new Blob([b])) };
            const send = m => window.__host({ data: m });
            // The host's order for a book tab.
            async function open(u, at) {
                const n = window.__loadDone || 0;
                send('fetch_and_load_book:' + u + (at > 0 ? '|at=' + at : ''));
                for (let i = 0; i < 100 && (window.__loadDone || 0) === n; i++) await w(10);
                send('cmd:view_set:columns:1');
                if (at > 0) send('resume_at:' + at);
            }
            const out = {};

            // 1. Page number carried by the scroll offset.
            await open(urls.A, 0); await w(300);
            PageMap.goto(15); await w(200);
            await open(urls.B, 0); await w(300);
            out.offset = PageMap.current();

            // 2. A pending resume for A, then B within its window.
            await open(urls.A, 450); await w(300);
            await open(urls.B, 0); await w(2500);
            out.fastSwitch = PageMap.current();

            // 3. A turned to page 5 by hand, B opens on page 1, then a column remount.
            await open(urls.A, 0); await w(300);
            for (let i = 0; i < 4; i++) { PageMap.step(1); await w(30); }
            await open(urls.B, 0); await w(300);
            handleCommand('set_column_mode:1'); await w(800);
            out.anchorRemount = PageMap.current();

            // The other way: a remembered position still lands, including straight after
            // a switch that cancelled one.
            await open(urls.A, 450); await w(300);
            await open(urls.B, 0); await w(300);
            await open(urls.A, 450); await w(2500);
            out.resume = PageMap.current();
            out.resumeExpected = PageMap.pageOfBlock(450);
            return out;
        }, book('A', 700), book('B', 700));

        assert(r.offset === 0,
            'a book with no remembered position opens on page 1, not the previous book\'s page (' + (r.offset + 1) + ')');
        assert(r.fastSwitch === 0,
            'a fast switch does not carry the previous book\'s pending jump (' + (r.fastSwitch + 1) + ')');
        assert(r.anchorRemount === 0,
            'a remount does not move a book on page 1 to the previous book\'s anchor (' + (r.anchorRemount + 1) + ')');
        assert(r.resume > 0 && r.resume === r.resumeExpected,
            'a remembered position still lands, after a cancelled one (page ' + (r.resume + 1) +
            ', expected ' + (r.resumeExpected + 1) + ')');

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) {
            console.error('\nTAB POSITION FAILED');
            process.exitCode = 1;
            return;
        }
        console.log('\nTAB POSITION PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
