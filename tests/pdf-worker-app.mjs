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
    await sleep(1500);
    // The two fixtures have different page counts: a change of count is the next one open.
    // The PDF lives on its own page, and that page is replaced after five opens, so the
    // worker count is read from whichever page is showing the PDF now.
    let prevPages = 0;
    const openAndWait = async (file) => {
        const p = path.join(here, file);
        const host = await app.surface();
        await host.evaluate((x) => window.chrome.webview.postMessage('open_file_path:' + x), p);
        const end = Date.now() + 20000;
        let n = 0;
        while (Date.now() < end) {
            const view = await app.surface();
            n = await view.evaluate((prev) => {
                try {
                    const pages = window.tzPdfActive ? window.tzPdfState().pages : 0;
                    return pages > 0 && pages !== prev ? pages : 0;
                } catch (e) { return 0; }
            }, prevPages);
            if (n) break;
            await sleep(200);
        }
        if (!n) throw new Error('PDF did not open: ' + file);
        prevPages = n;
        await sleep(400);
    };
    await openAndWait('pdf-sample.pdf');
    const first = (await app.surface()).workers().length;
    assert(first === 1, 'a PDF opened, with one worker (' + first + ')');
    for (let i = 0; i < 3; i++) { await openAndWait('alices-adventures-in-wonderland.pdf'); await openAndWait('pdf-sample.pdf'); }
    const after = (await app.surface()).workers().length;
    assert(after === first, 'six more PDFs opened: still ' + first + ' worker, now ' + after);
    const pages = await (await app.surface()).evaluate(() => window.tzPdfState().pages);
    assert(pages > 0, 'the last PDF is open (' + pages + ' pages)');
} catch (e) {
    assert(false, 'threw ' + e.message);
} finally {
    clearTimeout(watchdog);
    if (app) await app.close();
}
console.log(failed ? '\nPDF-WORKER FAILED' : '\nPDF-WORKER PASSED');
process.exitCode = failed ? 1 : 0;
