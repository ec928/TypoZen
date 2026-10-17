/**
 * Delete at the end of a long file's last line, and Backspace at the start of its first, change
 * nothing.
 *
 * Scrolling Preview mounts a window of a long file (2,000 lines or more), with a .virt-spacer
 * element after the last line. The last line has nothing to pull up, so the key went to the
 * browser, whose own Delete merged in a space from the spacer: "KEEP-2999" was saved as
 * "KEEP-2999 " (0.17.1). Each case clicks the line and presses the key.
 *
 *   node tests/virt-delete-end-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 3000;
const LINES = [];
for (let i = 0; i < N; i++) LINES.push('KEEP-' + String(i).padStart(4, '0'));

let passed = 0, failed = 0;
function check(ok, msg, detail) {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + (detail ? '\n         ' + detail : '')); }
}

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    for (const [name, line, key, side] of [['Delete at the end of the last line', N - 1, 'Delete', 'end'],
                                            ['Backspace at the start of the first line', 0, 'Backspace', 'start']]) {
        await page.evaluate(md => loadMarkdownContent(md), LINES.join('\n'));
        await settled(page);
        await page.evaluate(() => { handleCommand('view_set:columns:1'); handleCommand('view_set:scroll:scroll'); });
        await settled(page);
        await page.evaluate(i => goToModelBlock(i), line);
        await settled(page);
        const pt = await page.evaluate((i, s) => {
            const el = editor.querySelector('.block[data-model-index="' + i + '"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: s === 'end' ? r.right - 2 : r.left + 2, y: r.top + r.height / 2, virt: DocumentModel.virtEnabled };
        }, line, side);
        if (!pt) { check(false, name, 'line ' + line + ' is not mounted'); continue; }
        check(pt.virt, name + ': the file is windowed (the case this is about)');
        await page.mouse.click(pt.x, pt.y);
        await page.keyboard.press(side === 'end' ? 'End' : 'Home');
        await page.keyboard.press(key);
        await settled(page);
        const saved = await page.evaluate(() => getMarkdownContent(false));
        check(saved === LINES.join('\n'), name + ' leaves the file exactly as it was',
            saved === LINES.join('\n') ? '' : 'ends ' + JSON.stringify(saved.slice(-14)) + ', starts ' + JSON.stringify(saved.slice(0, 14)) + ', length ' + saved.length);
    }
} finally {
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('\nVIRT DELETE END FAILED'); process.exitCode = 1; }
else console.log('\nVIRT DELETE END PASSED');
