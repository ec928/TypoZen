/**
 * Headless browser E2E for inline `code`, Add Link, partial block split,
 * multi-block inline code, table cells, callouts, Source mode, and selection cache.
 *
 *   node tests/inline-code-format-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;

function assert(cond, msg, extra) {
    if (cond) { passed++; console.log('  OK   ' + msg); return; }
    failed++;
    console.error('  FAIL ' + msg + (extra ? '\n       ' + extra : ''));
}
function same(msg, got, want) {
    assert(got === want, msg, 'got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
        window.__host = (m) => window.__L.forEach(fn => fn({ data: m }));
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    await sleep(450);

    const load = async (md) => {
        await page.evaluate((d) => {
            localStorage.clear();
            setSourceDocExt('md');
            handleCommand('view_set:mode:preview');
            loadMarkdownContent(d);
        }, md);
        await sleep(100);
    };
    const md = () => page.evaluate(() => getMarkdownContent(false));

    // Helper: select plain range [start, end) inside block index `bi` using real DOM Range + mouseup
    const selectBlockPlain = async (bi, start, end) => {
        const pt = await page.evaluate((idx, sOff, eOff) => {
            const blocks = document.querySelectorAll('#editor .block');
            const b = blocks[idx];
            if (!b) return null;
            const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
            let n, count = 0, sn = null, so = 0, en = null, eo = 0, last = null;
            while ((n = tw.nextNode())) {
                last = n;
                const len = n.nodeValue.length;
                if (!sn && count + len >= sOff) { sn = n; so = sOff - count; }
                if (count + len >= eOff) { en = n; eo = eOff - count; break; }
                count += len;
            }
            if (!en && last) { en = last; eo = last.nodeValue.length; }
            const r = document.createRange();
            r.setStart(sn, Math.max(0, so));
            r.setEnd(en, Math.max(0, eo));
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
            const rect = r.getBoundingClientRect();
            return { x: Math.min(rect.right - 2, rect.left + 12), y: rect.top + Math.min(10, rect.height / 2) };
        }, bi, start, end);
        // Trigger editor selection & popover via mousedown -> mouseup (real drag lifecycle)
        await page.evaluate((p) => {
            const ed = document.getElementById('editor');
            ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: p.x, clientY: p.y }));
            ed.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: p.x, clientY: p.y }));
        }, pt);
        await sleep(120);
    };

    // 1. Real README.md line 8 repro via the right-click menu's Inline Code (the host sends
    //    fmt:code; until 2026-11-21 this was the popover's More -> Code) + full selection
    //    preserved + toggle off
    const README_P = '**Privacy-first and completely free.** There are no accounts, no sign-ins, and no tracking or telemetry; it just opens straight into your document. TypoZen goes online only for things you turn on yourself: downloading an extension, or Smart Cast with your own Google Gemini key. Turn on neither and it makes no network request at all.';
    await load(README_P);
    const plainLen = await page.evaluate(() => document.querySelector('#editor .block').textContent.length);
    await selectBlockPlain(0, 0, plainLen);
    await page.waitForSelector('#selPop:not([hidden])', { timeout: 5000 });
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(100);
    same('1a README repro via Inline Code wraps opening **', await md(), '`' + README_P + '`');
    const selectedAfter = await page.evaluate(() => getSelection().toString());
    assert(selectedAfter.endsWith('at all.'), '1b selection after code wrap still includes "at all."', 'got ' + JSON.stringify(selectedAfter.slice(-20)));
    assert(selectedAfter === README_P, '1c full code span content is selected after wrap');

    // Second click toggles back off cleanly
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(100);
    same('1d second code toggle restores original bolded paragraph', await md(), README_P);

    // 2. End-bold mirror case
    await load('Hello **world**');
    await selectBlockPlain(0, 0, 11);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    same('2 mirror end-bold includes closing **', await md(), '`Hello **world**`');

    // 3. Nested bold + link at start
    await load('**[Install](https://x.com)** (Recommended)');
    await selectBlockPlain(0, 0, 21);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    same('3 nested bold+link swallows both markers', await md(), '` **[Install](https://x.com)** (Recommended)`'.replace('` ', '`'));

    // 4. Inner code spans
    await load('It opens `.md`, `.txt` and PDF');
    await selectBlockPlain(0, 0, 'It opens .md, .txt and PDF'.length);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    same('4 existing code spans merge cleanly', await md(), '`It opens .md, .txt and PDF`');

    // 5. List item with leading bold
    await load('- **Bold** and rest');
    await selectBlockPlain(0, 0, 'Bold and rest'.length);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    same('5 list item keeps bullet prefix and wraps opening **', await md(), '- `**Bold** and rest`');

    // 6. Single table cell code format
    await load('| **bold** rest | b |\n|---|---|\n| c | d |');
    await page.evaluate(() => {
        const th = document.querySelector('#editor .block th');
        const tw = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
        const first = tw.nextNode();
        let last = first, n; while ((n = tw.nextNode())) last = n;
        const r = document.createRange();
        r.setStart(first, 0);
        r.setEnd(last, last.nodeValue.length);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        const ed = document.getElementById('editor');
        ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        ed.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await sleep(100);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    same('6 table single-cell code keeps table structure intact', await md(), '| `**bold** rest` | b |\n|---|---|\n| c | d |');

    // 7. Callout header protected
    await load('> [!NOTE] My Note');
    await selectBlockPlain(0, 0, 7);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    same('7 callout header stays untouched by code format', await md(), '> [!NOTE] My Note');

    // 8. Add Link via modal over bold, existing link, and code span
    await load('**word**');
    await selectBlockPlain(0, 0, 4);
    await page.evaluate(() => window.__host('fmt:link'));   // the right-click menu's Link... (and Ctrl+K)
    await page.waitForSelector('#linkModal:not([hidden])', { timeout: 5000 });
    await page.type('#linkModalHref', 'https://x.com');
    await page.click('#linkModalOk');
    await sleep(100);
    same('8a Add Link inside bold keeps ** outside', await md(), '**[word](https://x.com)**');

    await load('**[here](https://old.com)**');
    await selectBlockPlain(0, 0, 4);
    await page.evaluate(() => applyLinkAdd('here', 'https://new.com'));
    await sleep(80);
    same('8b Add Link replacing existing link avoids nested [[...]]', await md(), '**[here](https://new.com)**');

    await load('use `code` here');
    await selectBlockPlain(0, 4, 8);
    await page.evaluate(() => applyLinkAdd('code', 'https://x.com'));
    await sleep(80);
    same('8c Add Link over code span produces clean link', await md(), 'use [code](https://x.com) here');

    // 9. Partial selection inside a paragraph formats the whole block as H2 (never splits mid-line)
    await load('**Privacy-first** and completely free.');
    await selectBlockPlain(0, 0, 'Privacy-first and'.length);
    await page.evaluate(() => window.__host('fmt:h2'));
    await sleep(80);
    same('9 partial selection + H2 formats the whole block and keeps inline bold intact', await md(), '## **Privacy-first** and completely free.');

    // 10. Multi-block partial code across two lines
    await load('Intro **bold** rest\nsecond line tail');
    await page.evaluate(() => {
        const blocks = document.querySelectorAll('#editor .block');
        const b0 = blocks[0], b1 = blocks[1];
        const tw0 = document.createTreeWalker(b0, NodeFilter.SHOW_TEXT);
        let t0; while ((t0 = tw0.nextNode()) && t0.nodeValue.indexOf('bold') < 0) {}
        const t1 = document.createTreeWalker(b1, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange();
        r.setStart(t0, 0);
        r.setEnd(t1, 'second line'.length);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        const ed = document.getElementById('editor');
        ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        ed.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await sleep(100);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(100);
    same('10 multi-block partial code formats partial bold + partial second line', await md(), 'Intro `**bold** rest`\n`second line` tail');

    // 11. Source mode: literal * offset, around code toggle-off, multi-span code merge
    await load('2 * 3 and **six**');
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await sleep(250);
    await page.evaluate(() => {
        const se = sourceEditor;
        const a = se.value.indexOf('six');
        se.focus();
        se.setSelectionRange(a, a + 3);
    });
    await sleep(40);
    await page.evaluate(() => window.__host('fmt:bold'));
    await sleep(80);
    same('11a Source partial bold with literal * toggles **six** off', await page.evaluate(() => sourceEditor.value), '2 * 3 and six');

    await load('say `foo` now');
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await sleep(250);
    await page.evaluate(() => {
        const se = sourceEditor;
        const a = se.value.indexOf('foo');
        se.focus();
        se.setSelectionRange(a, a + 3);
    });
    await sleep(40);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    same('11b Source around code toggle-off strips surrounding backticks', await page.evaluate(() => sourceEditor.value), 'say foo now');

    await load('`a` and `b`');
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await sleep(250);
    await page.evaluate(() => {
        const se = sourceEditor;
        se.focus();
        se.setSelectionRange(0, se.value.length);
    });
    await sleep(40);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    same('11c Source multi-code-span merges cleanly', await page.evaluate(() => sourceEditor.value), '`a and b`');

    // 12. Stale _inlineSelCache cleared on click away (collapsed caret in another block)
    await load('First block\n\nSecond block');
    await selectBlockPlain(0, 0, 5);
    // Click inside block 2 (collapsed)
    const b2Pt = await page.evaluate(() => {
        const blocks = document.querySelectorAll('#editor .block');
        const r = blocks[2].getBoundingClientRect();
        return { x: r.left + 10, y: r.top + r.height / 2 };
    });
    await page.mouse.click(b2Pt.x, b2Pt.y);
    await sleep(80);
    await page.evaluate(() => window.__host('fmt:code'));
    await sleep(80);
    const after12 = await md();
    assert(after12.startsWith('First block\n\n'), '12 stale _inlineSelCache does not format First block after clicking Second block', 'got ' + JSON.stringify(after12));
} finally {
    await browser.close();
    clearTimeout(deadline);
}

console.log(`passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
