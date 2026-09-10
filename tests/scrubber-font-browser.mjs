/**
 * The page scrubber stays on screen whatever the theme's font size.
 *
 * The scrubber is fixed-size chrome: a 16px strip, an 11px thumb. It must not care what
 * size the text is. It did: the range input was the UA default inline-block, so it sat
 * on a line inside #page-scrubber whose height came from the inherited theme font. A
 * larger theme pushed the input down out of its own 16px box -- at 26px the thumb was
 * painted past the bottom of the page, cut off at the status bar.
 *
 * Measure the INPUT, not #page-scrubber. The container never moved, so asserting on it
 * passed against the broken build; the first round of diagnosis did exactly that.
 *
 *   node tests/scrubber-font-browser.mjs
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

function scrubberGeometry() {
    const box = document.getElementById('page-scrubber');
    const input = document.getElementById('page-scrubber-range');
    const b = box.getBoundingClientRect();
    const r = input.getBoundingClientRect();
    const pcs = getComputedStyle(box);
    return {
        boxTop: b.top, boxBottom: b.bottom,
        inputTop: r.top, inputBottom: r.bottom,
        viewport: window.innerHeight,
        shown: getComputedStyle(box).display !== 'none',
        parentFont: pcs.fontSize, parentLine: pcs.lineHeight,
        inputDisplay: getComputedStyle(input).display,
        fs: document.documentElement.style.getPropertyValue('--fs')
    };
}

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
    await page.evaluate((m) => loadMarkdownContent(m), md);
    await settled(page);
    await page.evaluate((f) => applyTheme({ Name: 'Base', Bg: '#1d2021', Tx: '#ebdbb2', FN: f, FS: 16 }), FONT);
    await settled(page);
    await page.evaluate(() => handleCommand('view_set:mode:reader'));
    await sleep(2000);

    for (const fsz of [16, 26]) {
        await page.evaluate((a) => applyTheme({ Name: 'S' + a.fs, Bg: '#1d2021', Tx: '#ebdbb2', FN: a.font, FS: a.fs }),
            { fs: fsz, font: FONT });
        await sleep(1200);
        const g = await page.evaluate(scrubberGeometry);
        info(g.fs + ': box ' + Math.round(g.boxTop) + '-' + Math.round(g.boxBottom)
            + ', input ' + Math.round(g.inputTop) + '-' + Math.round(g.inputBottom)
            + ', viewport ' + g.viewport + ', inherited ' + g.parentFont + ' / ' + g.parentLine
            + ', input display ' + g.inputDisplay);
        assert(g.shown, 'control: the scrubber is shown at ' + fsz + 'px');
        assert(g.inputTop >= g.boxTop - 1 && g.inputBottom <= g.boxBottom + 1,
            'at ' + fsz + 'px the slider sits inside its own 16px strip');
        assert(g.inputBottom <= g.viewport,
            'at ' + fsz + 'px the slider is on screen, not pushed past the bottom of the page');
    }
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('SCRUBBER FONT FAILED'); process.exit(1); }
console.log('SCRUBBER FONT PASSED');
