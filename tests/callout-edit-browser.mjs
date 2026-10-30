/**
 * GFM callouts (> [!NOTE]) and quotes, edited by pressing keys.
 *
 * 0.19.2 merged each run of quote lines into one block: two Backspaces at the start of a
 * callout body deleted the body, Enter in a quote dropped the next line's ">", Read Aloud
 * ran the lines together ("Line oneline two"), and a "~~~" scene break turned the prose up
 * to the next one into code. Each line is its own block again; this pins all four.
 *
 *   node tests/callout-edit-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = process.env.TZ_APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function check(ok, msg, got) {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + (got !== undefined ? '   got ' + JSON.stringify(got) : '')); }
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 15000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800 });
    page.on('pageerror', e => check(false, 'page threw: ' + e.message));
    await page.evaluateOnNewDocument(() => {
        window.__L = [];
        window.chrome = { webview: { postMessage: () => {}, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });

    const load = async (d) => { await page.evaluate((d) => { localStorage.clear(); handleCommand('view_set:mode:preview'); loadMarkdownContent(d); }, d); await settled(page); };
    // Click just before (atStart) or just after a word.
    async function clickAt(word, atStart) {
        const pt = await page.evaluate((w, s) => {
            const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
            let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf(w) < 0) {}
            const at = t.nodeValue.indexOf(w) + (s ? 0 : w.length);
            const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at);
            const b = r.getBoundingClientRect(); return { x: b.left + (s ? 1 : 0), y: b.top + b.height / 2 };
        }, word, atStart);
        await page.mouse.click(pt.x, pt.y);
        await settled(page);
        if (atStart) await page.keyboard.press('Home');
    }
    const saved = async () => {
        await settled(page);
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await settled(page);
        return page.evaluate(() => getMarkdownContent(false));
    };

    console.log('=== keys in a callout and a quote ===');
    await load('Intro.\n\n> [!NOTE]\n> Body text.\n\nEnd.');
    await clickAt('Body', true);
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    let s = await saved();
    check(s.includes('Body text.'), 'Backspace x2 at the start of a callout body keeps the body', s);

    await load('> Para one.\n>\n> Para two.\n\nAfter.');
    await clickAt('Para one.', false);
    await page.keyboard.press('Enter'); await page.keyboard.type('Y');
    s = await saved();
    check(s.includes('\n> Para two.') && !s.includes('YPara'), 'Enter in a quote keeps the next line as its own quote line', s);

    await load('Intro.\n\n> [!TIP]\n> Body one.\n\nEnd.');
    await clickAt('Tip', false);
    await page.keyboard.type('s');
    s = await saved();
    check(s.includes('> [!TIP] Tips\n> Body one.'), 'typing in the header title saves it as the callout title', s);

    console.log('\n=== what is shown and read ===');
    await load('Intro.\n\n> [!WARNING]\n> Do not do this.\n> Second.\n\nEnd.');
    const shown = await page.evaluate(() => [...document.querySelectorAll('#editor .block')].map(b => b.className));
    check(shown.filter(c => /tz-callout-body/.test(c) && /tz-alert-warning/.test(c)).length === 2, 'both body lines are styled as the warning body', shown);

    const spoken = await page.evaluate(async () => {
        const posts = [];
        window.chrome.webview.postMessage = (m) => posts.push(String(m));
        setSourceDocExt('md');
        if (state.mode !== 'preview') handleCommand('view_set:mode:preview');
        finishLoadContent('Intro.\n\n> [!WARNING]\n> Do not do this.\n> Line two\n\nEnd.', false, false);
        await new Promise(r => setTimeout(r, 300));
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        speakSelection();
        await new Promise(r => setTimeout(r, 300));
        const first = posts.filter(p => p.startsWith('host_tts_play:')).map(p => JSON.parse(p.substring(14)).text);
        const rest = (_ttsChunks || []).map(c => chunkSpeechText(c));
        try { handleCommand('tts_stop'); } catch (e) {}
        return first.concat(rest);
    });
    check(spoken.includes('Warning') && spoken.includes('Do not do this.') && spoken.includes('Line two'),
        'Read Aloud says the title, then each line on its own', spoken);

    await load('Chapter.\n\n~~~\n\nScene two.\n\n# Heading Two\n\n~~~\n\nScene three.');
    const h = await page.evaluate(() => !!document.querySelector('#editor h1') && !document.querySelector('#editor pre'));
    check(h, 'a "~~~" scene break is text, and the heading after it stays a heading');
} finally {
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
