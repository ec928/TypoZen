/**
 * A/B: nine classic <script src> tags vs one concatenated runtime file.
 *
 * Production loads js/modules/*.js in load-order.json, one blocking tag each.
 * The proposal was: at the same stamp that writes TypoZen_Template.runtime.html,
 * concat those files and leave a single <script src="js/typozen.runtime.js">.
 *
 * This is the fetch/parse/eval part of "template navigation", in headless Chrome
 * (same engine as WebView2). It does not include WPF or WebView2 process create.
 *
 *   node tests/scripts-ab.mjs
 *
 * Not a gate. Verdict is whether A and B differ by more than noise.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { readEngineSource, engineModuleNames } from './engine-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const html0 = fs.readFileSync(path.join(appDir, 'TypoZen_Template.html'), 'utf8');

const RUNS = 7;
const SCRIPT_RE = /<!-- Classic scripts[\s\S]*?<script src="js\/modules\/08-code\.js"><\/script>/;

function fileUrl(p) {
    return 'file:///' + p.split(path.sep).join('/');
}
function median(xs) {
    const a = xs.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function fmt(n, d) {
    return (Math.round(n * (10 ** d)) / (10 ** d)).toFixed(d);
}

function htmlNine() {
    if (!SCRIPT_RE.test(html0)) throw new Error('script block not found');
    return html0;
}

function htmlOne() {
    if (!SCRIPT_RE.test(html0)) throw new Error('script block not found');
    return html0.replace(
        SCRIPT_RE,
        '<!-- A/B one file --><script src="js/_ab-runtime.js"></script>'
    );
}

async function measure(browser, htmlPath) {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1280, height: 900 });
    const jsReqs = [];
    page.on('request', (req) => {
        const u = req.url();
        if (/\.js(\?|$)/i.test(u) && !/puppeteer/i.test(u)) jsReqs.push(u);
    });

    const t0 = Date.now();
    const nav = page.goto(fileUrl(htmlPath), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
        () => typeof paintCodeFences === 'function' && typeof handleCommand === 'function',
        { timeout: 20000 }
    );
    const engineMs = Date.now() - t0;
    await nav;
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 });
    const loadMs = Date.now() - t0;

    const timing = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0];
        const scripts = performance.getEntriesByType('resource').filter((e) =>
            /\.js(\?|$)/i.test(e.name)
            && /modules\/|_ab-runtime/.test(e.name)
        );
        return {
            dcl: n ? n.domContentLoadedEventEnd : 0,
            load: n ? n.loadEventEnd : 0,
            scripts: scripts.map((e) => ({
                name: decodeURIComponent((e.name.split('/').pop() || '').split('?')[0]),
                ms: Math.round(e.duration),
                start: Math.round(e.startTime),
                end: Math.round(e.responseEnd)
            }))
        };
    });
    await page.close();

    const names = jsReqs
        .filter((u) => /modules\/|_ab-runtime/.test(u))
        .map((u) => {
            try { return decodeURIComponent(u.split('/').pop().split('?')[0]); }
            catch (e) { return u; }
        });
    return {
        engineMs,
        loadMs,
        dcl: timing.dcl,
        loadNav: timing.load,
        jsCount: names.length,
        jsNames: names,
        scriptTiming: timing.scripts
    };
}

function summarise(label, rows) {
    const eng = rows.map((r) => r.engineMs);
    const load = rows.map((r) => r.loadMs);
    const last = rows[rows.length - 1];
    console.log('\n=== ' + label + ' ===');
    console.log('  nav → last module eval (ms):  ' + eng.map((n) => fmt(n, 0)).join(', ')
        + '   median ' + fmt(median(eng), 0));
    console.log('  nav → load complete (ms):     ' + load.map((n) => fmt(n, 0)).join(', ')
        + '   median ' + fmt(median(load), 0));
    console.log('  JS requests (last run):       ' + last.jsCount + '  [' + last.jsNames.join(', ') + ']');
    if (last.scriptTiming.length) {
        const span = last.scriptTiming.reduce((a, s) => Math.max(a, s.end), 0)
            - last.scriptTiming.reduce((a, s) => Math.min(a, s.start), 1e9);
        console.log('  resource span (last run):     ' + span + ' ms across '
            + last.scriptTiming.length + ' entries');
    }
    return { engine: median(eng), load: median(load), jsCount: last.jsCount };
}

async function main() {
    const ninePath = path.join(appDir, '_scripts-ab-nine.html');
    const onePath = path.join(appDir, '_scripts-ab-one.html');
    const runtimePath = path.join(appDir, 'js', '_ab-runtime.js');

    fs.writeFileSync(ninePath, htmlNine());
    fs.writeFileSync(runtimePath, readEngineSource());
    fs.writeFileSync(onePath, htmlOne());
    console.log('concatenated ' + engineModuleNames().length + ' modules, '
        + fs.statSync(runtimePath).size + ' bytes');

    const browser = await puppeteer.launch({ headless: 'new' });
    let a, b;
    try {
        await measure(browser, ninePath); // warmup: Chrome, not the scripts
        const rowsA = [];
        for (let i = 0; i < RUNS; i++) rowsA.push(await measure(browser, ninePath));
        a = summarise('A  nine <script src> tags  — current shipping HTML', rowsA);

        const rowsB = [];
        for (let i = 0; i < RUNS; i++) rowsB.push(await measure(browser, onePath));
        b = summarise('B  one concatenated js/_ab-runtime.js  — proposed stamp', rowsB);
    } finally {
        await browser.close();
        for (const p of [ninePath, onePath, runtimePath]) {
            try { fs.unlinkSync(p); } catch (e) {}
        }
    }

    console.log('\n=== verdict ===');
    const dEng = b.engine - a.engine;
    const dLoad = b.load - a.load;
    console.log('Δ last-module-eval  ' + fmt(dEng, 0) + ' ms   (B minus A; negative = concat faster)');
    console.log('Δ load complete     ' + fmt(dLoad, 0) + ' ms');
    console.log('JS requests         A=' + a.jsCount + '  B=' + b.jsCount);

    const abs = Math.max(Math.abs(dEng), Math.abs(dLoad));
    if (abs < 40) {
        console.log('\nResult: no meaningful saving. Nine local script tags are not the');
        console.log('cost that is worth a stamp-time concat and a 1 MB generated file.');
    } else if (dEng < 0) {
        console.log('\nResult: concat is faster by more than noise. Revisit the stamp step.');
    } else {
        console.log('\nResult: nine tags were faster, or the gap is not a concat win.');
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
