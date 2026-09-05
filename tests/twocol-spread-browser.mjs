/**
 * A 2-column page turn is a whole spread, not one column.
 *
 * Symptom: the right-hand leaf (page 104) slides onto the left (labeled 105) because
 * the view advanced by one column while the foot numbers advanced by two.
 *
 *   node tests/twocol-spread-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

function spreadState() {
    const ed = document.getElementById('editor');
    const host = ed.getBoundingClientRect();
    const mid = host.left + host.width / 2;
    const left = [];
    const right = [];
    const colLefts = new Set();
    for (const b of ed.querySelectorAll('.block')) {
        const mi = DocumentModel.modelIndexOfEl(b);
        for (const r of b.getClientRects()) {
            if (r.width < 1 || r.height < 1) continue;
            const x = r.left - host.left;
            if (x >= -2 && x < host.width - 2) colLefts.add(Math.round(x));
            if (r.right <= host.left + 1 || r.left >= host.right - 1) continue;
            if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) continue;
            if (mi < 0) continue;
            if (r.left + r.width / 2 < mid) left.push(mi);
            else right.push(mi);
        }
    }
    const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);
    const cs = getComputedStyle(ed);
    return {
        left: uniq(left),
        right: uniq(right),
        colLefts: [...colLefts].sort((a, b) => a - b),
        indicator: (document.getElementById('page-indicator') || {}).textContent || '',
        page: PageMap.current(),
        count: PageMap.count(),
        scrollLeft: ed.scrollLeft || 0,
        stride: PageGeometry.stride(),
        paneW: PageGeometry._paneW,
        twoCol: PageGeometry._twoCol,
        colW: cs.columnWidth,
        gap: cs.columnGap,
        clientW: ed.clientWidth,
        rectW: host.width,
        scrollW: ed.scrollWidth
    };
}

function shared(a, b) {
    const s = new Set(b);
    return a.filter((x) => s.has(x));
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1600, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await settled(page);
        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await settled(page);
        await page.evaluate(() => handleCommand('view_set:columns:2'));
        await settled(page);
        await page.evaluate(() => PageMap.goto(0));
        await settled(page);

        const geo = await page.evaluate(spreadState);
        info('geo paneW=' + geo.paneW + ' stride=' + geo.stride + ' colW=' + geo.colW
            + ' gap=' + geo.gap + ' clientW=' + geo.clientW + ' scrollW=' + geo.scrollW
            + ' twoCol=' + geo.twoCol);
        info('visible column lefts: ' + JSON.stringify(geo.colLefts));
        info('spread 0 ' + geo.indicator + ' left blocks ' + geo.left[0] + '..'
            + geo.left[geo.left.length - 1] + ' right ' + geo.right[0] + '..'
            + geo.right[geo.right.length - 1]);

        assert(geo.colLefts.length === 2, 'two columns are on screen (' + geo.colLefts.length + ')');
        const expectStride = geo.paneW + 60;
        info('expected stride paneW+gap=' + expectStride + ' actual=' + geo.stride
            + ' delta=' + (geo.stride - expectStride));
        info('half stride (one column) would be ' + (geo.stride / 2));

        // Walk every spread in the first range and across the first remount.
        // Sampling turns 1, 2, 10, 25 skipped the fault: an odd column count in a
        // range makes the last seek clamp to maxScroll, which is half a stride, so
        // the previous right-hand leaf slides onto the left. That is one turn.
        const firstRangePages = await page.evaluate(() => PageGeometry.localCount());
        info('first range has ' + firstRangePages + ' spreads');
        const walkUntil = firstRangePages + 3;
        let prev = geo;
        let worst = { frac: 0, turn: 0 };
        for (let t = 1; t <= walkUntil; t++) {
            const moved = await page.evaluate(() => PageMap.step(1));
            await settled(page);
            const cur = await page.evaluate(spreadState);
            const hit = shared(cur.left, prev.right);
            const frac = prev.right.length ? hit.length / prev.right.length : 0;
            if (frac > worst.frac) worst = { frac: frac, turn: t, indicator: cur.indicator,
                shared: hit.length, of: prev.right.length,
                sl: cur.scrollLeft, stride: cur.stride, units: cur.scrollLeft / cur.stride };
            if (frac >= 0.5 || t === 1 || t === firstRangePages || t === firstRangePages - 1) {
                info('turn ' + t + (moved ? '' : ' (step false)') + ': ' + cur.indicator
                    + ' sl=' + Math.round(cur.scrollLeft)
                    + ' strideUnits=' + (cur.scrollLeft / cur.stride).toFixed(3)
                    + ' sharedWithPrevRight=' + hit.length + '/' + prev.right.length
                    + ' (' + Math.round(frac * 100) + '%)');
            }
            assert(frac < 0.5,
                'turn ' + t + ': right leaf does not become the next left leaf ('
                + hit.length + ' of ' + prev.right.length + ' blocks reused, '
                + cur.indicator + ')');
            prev = cur;
        }
        info('worst overlap: turn ' + worst.turn + ' ' + Math.round(worst.frac * 100)
            + '% (' + (worst.shared || 0) + '/' + (worst.of || 0) + ') units='
            + (worst.units != null ? worst.units.toFixed(3) : '?'));

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) {
            console.error('\nTWO-COL SPREAD FAILED');
            process.exitCode = 1;
            return;
        }
        console.log('\nTWO-COL SPREAD PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
