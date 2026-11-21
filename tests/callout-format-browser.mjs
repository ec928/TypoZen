/**
 * Format > Callout and Format > Normal text, in Preview and Source.
 *
 * The rules are in 04-lists.js above calloutPlan (Ed approved 2026-11-21): a header above
 * the selected lines and "> " on each; ">" for a blank line inside; a blank line before
 * the header inside a quote and after the box when text follows; another type retypes
 * the header; the same type takes the box apart and keeps a title. Each case checks the
 * whole saved file, so "nothing else changed" is checked too.
 *
 *   node tests/callout-format-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
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

    const saved = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
    const load = async (md, mode) => {
        await page.evaluate((m) => { try { setSourceDocExt('md'); } catch (e) {} loadMarkdownContent(m); }, md);
        await page.evaluate((m) => handleCommand('view_set:mode:' + m), mode || 'wysiwyg');
        await settled(page);
    };
    // The host's path for a menu or toolbar click: freeze the selection, then format.
    const fmt = async (t) => { await page.evaluate((x) => { freezeFormatSelection(); applyFormatting(x); }, t); await settled(page); };
    const clickLine = async (i) => {
        const el = await page.$('#editor .block[data-model-index="' + i + '"]');
        await el.click();
    };
    // Select lines a..b as a writer would: click the first, Shift+click the last.
    // (Not Shift+ArrowDown: the caret steps over blank lines, so a count of presses does
    // not say which line it reaches.)
    const selectLines = async (a, b) => {
        await clickLine(a);
        await page.keyboard.press('Home');
        const el = await page.$('#editor .block[data-model-index="' + b + '"]');
        const box = await el.boundingBox();
        await page.keyboard.down('Shift');
        await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
        await page.keyboard.up('Shift');
    };
    const srcSelect = async (from, to) => {
        await page.evaluate((f, t) => { sourceEditor.focus(); sourceEditor.setSelectionRange(f, t); }, from, to);
    };

    console.log('\n=== Preview: making a callout ===');
    await load('Intro.\n\nSome text.\n\nOutro.');
    await clickLine(2); await fmt('callout:note');
    same('a line becomes the body under a header', await saved(), 'Intro.\n\n> [!NOTE]\n> Some text.\n\nOutro.');
    same('Undo puts the line back', await page.evaluate(() => { HistoryManager.undo(); return getMarkdownContent(false); }), 'Intro.\n\nSome text.\n\nOutro.');

    await load('One\n\nTwo\nThree\n\nAfter');
    await selectLines(0, 3); await fmt('callout:tip');
    same('three lines with a blank between: one box, the blank becomes ">"', await saved(),
        '> [!TIP]\n> One\n>\n> Two\n> Three\n\nAfter');

    await load('Para\nNext line');
    await clickLine(0); await fmt('callout:warning');
    same('text right after the box gets a blank line before it', await saved(), '> [!WARNING]\n> Para\n\nNext line');

    await load('> q1\n> q2\n> q3');
    await clickLine(1); await fmt('callout:important');
    same('inside a quote: a blank line first, and after, so the box stands alone', await saved(),
        '> q1\n\n> [!IMPORTANT]\n> q2\n\n> q3');

    await load('Top\n\n\nBottom');
    await clickLine(1); await fmt('callout:caution');
    same('an empty line is replaced by a header and an empty body line', await saved(), 'Top\n> [!CAUTION]\n> \n\nBottom');
    await page.keyboard.type('Typed');
    await settled(page);
    same('and typing goes into the box', await saved(), 'Top\n> [!CAUTION]\n> Typed\n\nBottom');

    await load('- item one\n## A heading');
    await selectLines(0, 1); await fmt('callout:note');
    same('lists and headings go in as they are', await saved(), '> [!NOTE]\n> - item one\n> ## A heading');

    console.log('\n=== Preview: changing and removing ===');
    await load('> [!NOTE] My title\n> Body\n\nAfter');
    await clickLine(1); await fmt('callout:warning');
    same('another type changes the header and keeps the title', await saved(), '> [!WARNING] My title\n> Body\n\nAfter');
    await clickLine(1); await fmt('callout:warning');
    same('its own type takes the box apart and keeps the title as a line', await saved(), 'My title\nBody\n\nAfter');

    await load('> [!TIP]\n> a\n>\n> b\nafter');
    await clickLine(0); await fmt('callout:tip');
    same('from the header line too; the ">" line becomes blank', await saved(), 'a\n\nb\nafter');

    console.log('\n=== Preview: refused ===');
    await load('Text\n```js\nx = 1\n```\nMore');
    await selectLines(0, 2); const before = await saved(); await fmt('callout:note');
    same('a code block in the selection refuses the whole command', await saved(), before);
    await load('Above\n| a | b |\n| - | - |\n| 1 | 2 |');
    await selectLines(0, 1); await fmt('callout:note');
    same('a table in the selection refuses it', await saved(), 'Above\n| a | b |\n| - | - |\n| 1 | 2 |');

    console.log('\n=== Preview: Normal text ===');
    await load('## Head\n- item\n- [ ] task\n> quote\n  indented plain\n1. num');
    await selectLines(0, 5); await fmt('para');
    same('heading, list, task, quote and numbered lose their marker; plain keeps its indent', await saved(),
        'Head\nitem\ntask\nquote\n  indented plain\nnum');
    await load('> [!NOTE]\n> Body');
    await clickLine(0); await fmt('para');
    same('Normal text leaves a callout header alone', await saved(), '> [!NOTE]\n> Body');

    console.log('\n=== the ticks: what the line at the caret is ===');
    await load('> [!TIP]\n> Body\n## H\n- l\nplain');
    const st = async (i) => { await clickLine(i); return page.evaluate(() => JSON.stringify(formatStateAtCaret())); };
    same('callout body', await st(1), '{"block":"quote","callout":"tip"}');
    same('heading', await st(2), '{"block":"h2","callout":null}');
    same('list', await st(3), '{"block":"list","callout":null}');
    same('plain', await st(4), '{"block":"para","callout":null}');

    console.log('\n=== Source ===');
    await load('Intro.\nSome text.\nOutro.', 'source');
    await srcSelect(7, 7); await fmt('callout:note');
    same('Source: a line becomes a box, text after gets its blank line', await saved(),
        'Intro.\n> [!NOTE]\n> Some text.\n\nOutro.');
    await srcSelect(20, 20); await fmt('callout:note');
    same('Source: the same type takes it apart', await saved(), 'Intro.\nSome text.\n\nOutro.');
    await load('a\nb\nc', 'source');
    await srcSelect(0, 4); await fmt('callout:tip');
    same('Source: a selection ending at the start of a line leaves that line out', await saved(), '> [!TIP]\n> a\n> b\n\nc');

    console.log('\n=== a code file takes no Markdown formatting ===');
    await load('int x = 1;\nint y = 2;', 'source');
    await page.evaluate(() => setSourceDocExt('cs'));
    await srcSelect(0, 0); await fmt('h2'); await fmt('callout:note'); await fmt('bold');
    same('H2, Callout and Bold change nothing in a .cs file', await saved(), 'int x = 1;\nint y = 2;');
    await page.evaluate(() => setSourceDocExt('md'));

    console.log('\n=== a long document: the edit lands on its line, the rest is untouched ===');
    const lines = [];
    for (let i = 0; i < 3000; i++) lines.push('Line ' + i + ' of the long file.');
    const big = lines.join('\n');
    await load(big);
    const mounted = await page.evaluate(() => document.querySelectorAll('#editor .block').length);
    same('premise: only part of the document is mounted', mounted < 3000, true);
    await page.evaluate(() => ensureModelBlockVisible(2000, { topPad: 48 }));
    await settled(page);
    await clickLine(2000); await fmt('callout:note');
    const want = lines.slice(0, 2000).concat(['> [!NOTE]', '> Line 2000 of the long file.', '']).concat(lines.slice(2001)).join('\n');
    const got = await saved();
    same('line 2000 became the box and the other 2999 lines are as they were', got === want, true);
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
