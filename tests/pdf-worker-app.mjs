/**
 * Opening PDF after PDF keeps one PDF.js worker, not one per PDF.
 *
 * Until 0.20.12 each PDF opened left its worker behind for the rest of the session:
 * getDocument made a worker per document and destroying the document did not end it. In
 * the app that was nine workers and over 1 GB after four round trips to a 536-page PDF.
 * The viewer, export and OCR now share one worker (10-pdf.js, sharedWorker).
 *
 * The real app on a hidden desktop: PDF.js is served from the app's own virtual host, so a
 * headless page cannot open a PDF.
 *
 *   RUN_APP_E2E=1 node tests/pdf-worker-app.mjs        (about 15 seconds)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, profileDir } from './app-harness.mjs';
import { sleep } from './settle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const assert = (ok, msg) => { console.log((ok ? '  OK   ' : '  FAIL ') + msg); if (!ok) failed++; };
const watchdog = setTimeout(() => { console.error('  FAIL budget 60 s'); process.exit(1); }, 60000);
let app = null;
try {
    fs.mkdirSync(profileDir, { recursive: true });
    const start = path.join(profileDir, 'start.md');
    fs.writeFileSync(start, 'Start.\n');
    app = await launchApp({ file: start });
    const page = app.page;
    await sleep(1500);
    // The two fixtures have different page counts: a change of count is the next one open.
    let prevPages = 0;
    const openAndWait = async (file) => {
        const p = path.join(here, file);
        await page.evaluate((x) => window.chrome.webview.postMessage('open_file_path:' + x), p);
        await page.waitForFunction((prev) => {
            try { const n = window.tzPdfActive ? window.tzPdfState().pages : 0; return n > 0 && n !== prev; } catch (e) { return false; }
        }, { timeout: 15000 }, prevPages);
        prevPages = await page.evaluate(() => window.tzPdfState().pages);
        await sleep(400);
    };
    await openAndWait('pdf-sample.pdf');
    const first = page.workers().length;
    assert(first === 1, 'a PDF opened, with one worker (' + first + ')');
    for (let i = 0; i < 3; i++) { await openAndWait('alices-adventures-in-wonderland.pdf'); await openAndWait('pdf-sample.pdf'); }
    const after = page.workers().length;
    assert(after === first, 'six more PDFs opened: still ' + first + ' worker, now ' + after);
    const pages = await page.evaluate(() => window.tzPdfState().pages);
    assert(pages > 0, 'the last PDF is open (' + pages + ' pages)');
} catch (e) {
    assert(false, 'threw ' + e.message);
} finally {
    clearTimeout(watchdog);
    if (app) await app.close();
}
console.log(failed ? '\nPDF-WORKER FAILED' : '\nPDF-WORKER PASSED');
process.exitCode = failed ? 1 : 0;
