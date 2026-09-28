/**
 * How fast Source answers a keystroke, and how long switching into Source takes.
 *
 * docs/archive/codemirror-source-plan.md: Source is moving from a textarea to CodeMirror, and
 * "no slowdown" is a claim to measure, not to assume. This records the textarea's numbers
 * as the baseline (SOURCE_LATENCY_RECORD=1 writes tests/source-latency-baseline.json) and,
 * once a baseline exists, fails if the median is more than 10% (and 2 ms) slower.
 *
 * Keystroke latency is keydown -> the app's own input handling done -> the next frame.
 * The hook is added through sourceEditor.addEventListener('input'), after the app's own
 * listeners, so the same measurement holds for whatever Source is built on.
 *
 * Numbers are machine-local: record the baseline on the machine that compares against it.
 *
 *   RUN_APP_E2E=1 node tests/source-latency-app.mjs
 *   SOURCE_LATENCY_RECORD=1 RUN_APP_E2E=1 node tests/source-latency-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, 'source-latency-baseline.json');
const LOG = path.join(__dirname, '_source-latency.log');
const KEYS = 25;

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }
const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const p90 = (xs) => { const a = xs.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * 0.9))]; };
const r1 = (n) => Math.round(n * 10) / 10;

/** Type KEYS characters at the middle of Source; per key: handler done and next frame. */
async function typeSamples(app) {
    await app.eval(() => {
        window.__lat = [];
        window.__latT0 = 0;
        document.addEventListener('keydown', () => { window.__latT0 = performance.now(); }, true);
        sourceEditor.addEventListener('input', () => {
            const t0 = window.__latT0, t1 = performance.now();
            requestAnimationFrame(() => setTimeout(() => window.__lat.push({ handler: t1 - t0, frame: performance.now() - t0 }), 0));
        });
        const mid = Math.floor(sourceEditor.value.length / 2);
        sourceEditor.focus();
        sourceEditor.setSelectionRange(mid, mid);
    });
    await app.page.bringToFront().catch(() => { });
    info('typing ' + KEYS + ' keys');
    for (let i = 0; i < KEYS; i++) {
        await app.page.keyboard.type('a');
        await app.page.waitForFunction((n) => window.__lat.length >= n, { timeout: 5000 }, i + 1);
    }
    const s = await app.eval(() => window.__lat);
    return s.slice(3);   // the first few pay for warm-up (JIT, first snapshot)
}

const deadline = setTimeout(() => { console.error('DEADLINE'); process.exit(3); }, 150000);
const results = {};
try {
    // 1. Markdown, 74 KB: switch into Source, then type.
    console.log('=== Markdown, band-1600.md (74 KB) ===');
    let app = await launchApp({ file: 'tests/band-1600.md', settleMs: 8000, view: true });
    try {
        // The switch runs synchronously inside handleCommand; the time is that plus the
        // frame it paints in. One question per eval; waiting is done from outside (house
        // rule: never park a loop inside app.eval). Preview is 'wysiwyg' in state.mode.
        const switches = [];
        for (let i = 0; i < 3; i++) {
            info('switch ' + (i + 1));
            const r = await app.eval(async () => {
                const t0 = performance.now();
                handleCommand('view_set:mode:source');
                const sync = state.mode;
                await new Promise(res => requestAnimationFrame(() => setTimeout(res, 0)));
                return { ms: performance.now() - t0, sync };
            });
            if (r.sync !== 'source') info('mode was ' + r.sync + ' right after the command');
            switches.push(r.ms);
            await app.eval(() => handleCommand('view_set:mode:preview'));
            await app.page.waitForFunction(() => state.mode === 'wysiwyg', { timeout: 5000 });
        }
        await app.eval(() => handleCommand('view_set:mode:source'));
        await app.page.waitForFunction(() => state.mode === 'source', { timeout: 5000 });
        const s = await typeSamples(app);
        results.md = {
            switchMs: r1(median(switches)),
            keyFrameMedian: r1(median(s.map(x => x.frame))), keyFrameP90: r1(p90(s.map(x => x.frame))),
            keyHandlerMedian: r1(median(s.map(x => x.handler)))
        };
        info('switch into Source: ' + switches.map(r1).join(', ') + ' ms');
        info('keystroke to frame: median ' + results.md.keyFrameMedian + ' ms, p90 ' + results.md.keyFrameP90 + ' ms (handler median ' + results.md.keyHandlerMedian + ' ms)');
    } finally { await app.close(); }

    // 2. A 5 MB log: plain, opens straight into Source.
    console.log('=== Plain log, 5 MB ===');
    const line = (i) => '2026-09-27 12:' + String(i % 60).padStart(2, '0') + ':00.' + String(i % 1000).padStart(3, '0')
        + ' INFO  worker-' + (i % 16) + '  request ' + i + ' finished in ' + (i % 997) + ' ms status=200\n';
    const parts = []; let size = 0;
    for (let i = 0; size < 5 * 1024 * 1024; i++) { const l = line(i); parts.push(l); size += l.length; }
    fs.writeFileSync(LOG, parts.join(''));
    app = await launchApp({ file: LOG, settleMs: 8000 });
    try {
        await app.page.waitForFunction(() => state.mode === 'source' && sourceEditor.value.length > 5000000, { timeout: 15000 });
        const s = await typeSamples(app);
        results.log = {
            keyFrameMedian: r1(median(s.map(x => x.frame))), keyFrameP90: r1(p90(s.map(x => x.frame))),
            keyHandlerMedian: r1(median(s.map(x => x.handler)))
        };
        info('keystroke to frame: median ' + results.log.keyFrameMedian + ' ms, p90 ' + results.log.keyFrameP90 + ' ms (handler median ' + results.log.keyHandlerMedian + ' ms)');
    } finally { await app.close(); }

    if (process.env.SOURCE_LATENCY_RECORD === '1') {
        fs.writeFileSync(BASELINE, JSON.stringify(Object.assign({ recorded: new Date().toISOString() }, results), null, 2) + '\n');
        info('baseline written to ' + path.basename(BASELINE));
    } else if (fs.existsSync(BASELINE)) {
        const b = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
        const within = (now, was) => now <= Math.max(was * 1.1, was + 2);
        assert(within(results.md.keyFrameMedian, b.md.keyFrameMedian), 'Markdown keystroke median ' + results.md.keyFrameMedian + ' ms within 10% of ' + b.md.keyFrameMedian);
        assert(within(results.md.switchMs, b.md.switchMs), 'switch into Source ' + results.md.switchMs + ' ms within 10% of ' + b.md.switchMs);
        assert(within(results.log.keyFrameMedian, b.log.keyFrameMedian), 'log keystroke median ' + results.log.keyFrameMedian + ' ms within 10% of ' + b.log.keyFrameMedian);
    } else info('no baseline yet: record one with SOURCE_LATENCY_RECORD=1');
} finally {
    try { fs.unlinkSync(LOG); } catch (e) { }
    clearTimeout(deadline);
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) process.exitCode = 1;
else console.log('SOURCE LATENCY DONE');
