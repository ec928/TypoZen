/**
 * Enter in a quote or callout goes on in it, as Enter goes on in a list, and Enter on an
 * empty quote line leaves it (Ed approved 2026-11-21). Keys are pressed, in Preview and
 * Source, and each case checks the whole saved file.
 *
 *   node tests/quote-enter-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { padPage, LARGE } from './large-pad.mjs';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (45 s)'); process.exit(1); }, 45000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++;
    console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await padPage(page);   // cases in the middle of a long file (large-pad.mjs)
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    const saved = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
    const load = async (md, mode) => {
        await page.evaluate((m) => { setSourceDocExt('md'); loadMarkdownContent(m); }, md);
        await page.evaluate((m) => handleCommand('view_set:mode:' + m), mode || 'wysiwyg');
        await settled(page);
    };
    const at = async (i, key) => {
        const el = await page.$('#editor .block[data-model-index="' + i + '"]');
        await el.click();
        await page.keyboard.press(key || 'End');
    };
    const keys = async (...seq) => {
        for (const k of seq) {
            if (['Enter', 'Home', 'End', 'Backspace'].indexOf(k) >= 0) await page.keyboard.press(k);
            else await page.keyboard.type(k);
        }
        await settled(page);
    };
    const srcAt = async (pos) => page.evaluate((p) => { sourceEditor.focus(); sourceEditor.setSelectionRange(p, p); }, pos);

    console.log('\n=== Preview ===');
    // Typed on the file's empty last line: about the end of the FILE, so the small file only.
    if (!LARGE) {
        await load('Intro\n');
        await at(1);
        await keys('> [!TIP]', 'Enter', 'Body', 'Enter', 'Enter', 'After');
        same('type a callout header, Enter, a body, Enter twice to leave', await saved(), 'Intro\n> [!TIP]\n> Body\n\nAfter');
    }

    await load('> [!NOTE]\n> Body line\n\nNext.');
    await at(1); await keys('Enter', 'Added');
    same('Enter at the end of a body line goes on in the box', await saved(), '> [!NOTE]\n> Body line\n> Added\n\nNext.');
    same('Undo takes it back', await page.evaluate(() => { HistoryManager.undo(); HistoryManager.undo(); return getMarkdownContent(false); }),
        '> [!NOTE]\n> Body line\n\nNext.');

    await load('> [!WARNING]\n> Body');
    await at(0); await keys('Enter', 'X');
    same('Enter at the end of the header starts a body line', await saved(), '> [!WARNING]\n> X\n> Body');

    await load('> Hello world');
    await at(0);
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
    await keys('Enter');
    same('Enter in the middle of a quote line: both halves stay in the quote', await saved(), '> Hello\n> world');

    await load('> [!NOTE]\n> Body');
    await at(1, 'Home'); await keys('Enter');
    same('Enter at the start of a body line leaves an empty quote line, not a gap in the box', await saved(), '> [!NOTE]\n> \n> Body');

    await load('> a');
    await at(0); await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
    await keys('X');
    same('Shift+Enter gives a line without the marker', await saved(), '> a\nX');

    await load('- one');
    await at(0); await keys('Enter', 'two');
    same('lists are as before', await saved(), '- one\n- two');

    console.log('\n=== Source ===');
    await load('> [!NOTE]\n> a', 'source');
    await srcAt(13); await keys('Enter', 'b');
    same('Source: Enter at the end of a callout line goes on in it', await saved(), '> [!NOTE]\n> a\n> b');
    await load('> a\n> ', 'source');
    await srcAt(6); await keys('Enter', 'c');
    same('Source: Enter on an empty quote line leaves the quote', await saved(), '> a\n\nc');
    await load('> text', 'source');
    await srcAt(2); await keys('Enter');
    same('Source: Enter right after the marker of a line with text does not end the quote', await saved(), '> \n> text');
    await load('> > deep', 'source');
    await srcAt(8); await keys('Enter', 'x');
    same('Source: a nested quote keeps its depth', await saved(), '> > deep\n> > x');
    await load('```\n> prompt\n```', 'source');
    await srcAt(12); await keys('Enter', 'x');
    same('Source: inside a code fence ">" is left alone', await saved(), '```\n> prompt\nx\n```');
    await load('- one', 'source');
    await srcAt(5); await keys('Enter', 'two');
    same('Source: lists are as before', await saved(), '- one\n- two');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
