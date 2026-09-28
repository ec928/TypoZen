/**
 * A/B: what CodeMirror costs at startup (docs/archive/codemirror-source-plan.md, Phase 0).
 *
 * A is the template as it ships. B adds js/vendor/codemirror/codemirror.js ahead of the
 * modules and creates one empty EditorView after them, which is what Source mode will do
 * at startup. Same method as scripts-ab.mjs: headless Chrome (WebView2's engine), cache
 * off, one warmup, then RUNS each; the metric is navigation until the last module has
 * evaluated. B also times the bundle's own evaluation and the view's creation in-page.
 *
 *   node tests/cm-ab.mjs
 *
 * Not a gate. The plan's go / no-go line is 15 ms.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const html0 = fs.readFileSync(path.join(appDir, 'TypoZen_Template.html'), 'utf8');
const RUNS = 7;
const deadline = setTimeout(() => { console.log('DEADLINE'); process.exit(3); }, 60000);

const FIRST = '<!-- Classic scripts';
const LAST = '<script src="js/modules/10-pdf.js"></script>';

function htmlWithCm() {
    if (!html0.includes(FIRST) || !html0.includes(LAST)) throw new Error('script block not found');
    return html0
        .replace(FIRST, '<script>window.__cmT0 = performance.now();</script>'
            + '<script src="js/vendor/codemirror/codemirror.js"></script>'
            + '<script>window.__cmT1 = performance.now();</script>\n    ' + FIRST)
        .replace(LAST, LAST + '<script>(function () {'
            + ' var t = performance.now(); var host = document.createElement("div");'
            + ' host.style.display = "none"; document.body.appendChild(host);'
            + ' new TzCM.EditorView({ state: TzCM.EditorState.create({ doc: "" }), parent: host });'
            + ' window.__cmCreate = performance.now() - t; })();</script>');
}

const fileUrl = (p) => 'file:///' + p.split(path.sep).join('/');
const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

async function measure(browser, htmlPath) {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 900 });
    const t0 = Date.now();
    const nav = page.goto(fileUrl(htmlPath), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => typeof paintCodeFences === 'function' && typeof handleCommand === 'function', { timeout: 15000 });
    const engineMs = Date.now() - t0;
    await nav;
    const inPage = await page.evaluate(() => ({
        evalMs: window.__cmT1 != null ? window.__cmT1 - window.__cmT0 : null,
        createMs: window.__cmCreate != null ? window.__cmCreate : null
    }));
    await page.close();
    return { engineMs, ...inPage };
}

const aPath = path.join(appDir, '_cm-ab-a.html');
const bPath = path.join(appDir, '_cm-ab-b.html');
fs.writeFileSync(aPath, html0);
fs.writeFileSync(bPath, htmlWithCm());
const browser = await puppeteer.launch({ headless: 'new' });
try {
    await measure(browser, aPath);
    const a = [], b = [];
    // Interleaved, so drift over the run (thermal, disk cache) lands on both sides.
    for (let i = 0; i < RUNS; i++) { a.push(await measure(browser, aPath)); b.push(await measure(browser, bPath)); }
    const f = (n) => n == null ? '-' : n.toFixed(1);
    console.log('A (as shipped)   nav -> last module: ' + a.map(r => r.engineMs).join(', ') + '   median ' + median(a.map(r => r.engineMs)));
    console.log('B (+CodeMirror)  nav -> last module: ' + b.map(r => r.engineMs).join(', ') + '   median ' + median(b.map(r => r.engineMs)));
    console.log('B bundle evaluation (ms):  ' + b.map(r => f(r.evalMs)).join(', ') + '   median ' + f(median(b.map(r => r.evalMs))));
    console.log('B empty view creation (ms): ' + b.map(r => f(r.createMs)).join(', ') + '   median ' + f(median(b.map(r => r.createMs))));
    console.log('delta (B - A) median: ' + (median(b.map(r => r.engineMs)) - median(a.map(r => r.engineMs))) + ' ms   (go / no-go line: 15 ms)');
} finally {
    await browser.close();
    for (const p of [aPath, bPath]) { try { fs.unlinkSync(p); } catch (e) { } }
    clearTimeout(deadline);
}
