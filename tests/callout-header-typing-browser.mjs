/**
 * Typing in a callout's header line in Preview saves what was typed, not the name the
 * header shows. With no title written, "> [!CAUTION]" shows "Caution"; typing X after it
 * saved "> [!CAUTION] CautionX" (found 2026-11-21, in every version before).
 *
 *   node tests/callout-header-typing-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (30 s)'); process.exit(1); }, 30000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++;
    console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    const saved = () => page.evaluate(() => getMarkdownContent(false));
    const typeInHeader = async (md, keys, home) => {
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
        await settled(page);
        const el = await page.$('#editor .block[data-model-index="0"]');
        await el.click();
        await page.keyboard.press(home ? 'Home' : 'End');
        await page.keyboard.type(keys);
        await settled(page);
        return saved();
    };

    same('typed after the shown name: only the typing is saved',
        await typeInHeader('> [!CAUTION]\n> body', 'X'), '> [!CAUTION] X\n> body');
    same('typed before the shown name: the same',
        await typeInHeader('> [!TIP]\n> body', 'Y', true), '> [!TIP] Y\n> body');
    same('a written title is edited as text',
        await typeInHeader('> [!NOTE] Mine\n> body', 's'), '> [!NOTE] Mines\n> body');
    same('a written title that is the name is edited as text',
        await typeInHeader('> [!NOTE] Note\n> body', 's'), '> [!NOTE] Notes\n> body');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
