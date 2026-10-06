/**
 * Replace and Replace All, driven from the Find bar the way a writer uses it: type the
 * query and the replacement, click the button, read back what would be saved.
 *
 *   - offsets survive characters whose lowercase is longer ('İ' -> 'i̇'): matching on a
 *     lowercased copy shifted every later match and Replace All wrote "cdog" into the text
 *   - Replace All is one pass: splicing per match was quadratic (213 ms for 234 matches
 *     in 206 KB, seconds at 1 MB)
 *   - Source's "Ln" comes from CodeMirror's own line index and agrees with the text
 *
 *   node tests/find-replace-browser.mjs
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

async function typeInto(page, sel, text) {
    await page.click(sel);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text);
}

async function replaceAllFromBar(page, query, rep) {
    await page.evaluate(() => openFindBar('', true));
    await settled(page);
    await typeInto(page, '#findInput', query);
    await typeInto(page, '#replaceInput', rep);
    await settled(page);
    const t0 = Date.now();
    await page.click('#findReplaceAll');
    await settled(page);
    return Date.now() - t0;
}

/** Last "Ln" the page sent the host: stats:words,chars,rt,dirty,lines,caretLine,... */
async function lastStats(page) {
    return page.evaluate(() => {
        const s = (window.__sent || []).filter(m => m.startsWith('stats:')).pop() || '';
        const p = s.slice(6).split(',');
        return { lines: +p[4], line: +p[5] };
    });
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
        // Stand in for the host so the stats messages can be read back.
        await page.evaluateOnNewDocument(() => {
            window.__sent = [];
            window.chrome = window.chrome || {};
            window.chrome.webview = {
                postMessage: (m) => { if (typeof m === 'string') window.__sent.push(m); },
                addEventListener: () => {}, removeEventListener: () => {}
            };
        });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        const doc = 'İstanbul cat cat.\n\nThe Cat sat on the mat.';
        const want = 'İstanbul dog dog.\n\nThe dog sat on the mat.';

        for (const mode of ['wysiwyg', 'source']) {
            console.log('\n=== Replace All after İ (' + mode + ') ===');
            await page.evaluate((m) => loadMarkdownContent(m), doc);
            await page.evaluate((m) => handleCommand('view_set:mode:' + m), mode);
            await settled(page);
            await replaceAllFromBar(page, 'cat', 'dog');
            const got = await page.evaluate(() => getMarkdownContent(false));
            assert(got === want, 'text is replaced, nothing around it damaged (got ' + JSON.stringify(got) + ')');
            const status = await page.evaluate(() => (document.getElementById('findStatus') || {}).textContent || '');
            assert(/Replaced 3/.test(status), 'reports 3 replaced (' + status + ')');
            await page.evaluate(() => { try { closeFindBar(); } catch (e) {} });
        }

        console.log('\n=== Replace All on the large fixture (source) ===');
        const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await settled(page);
        const n = (md.match(/the/gi) || []).length;
        const ms = await replaceAllFromBar(page, 'the', 'THE');
        const big = await page.evaluate(() => getMarkdownContent(false));
        const expect = md.replace(/\r\n?/g, '\n').replace(/the/gi, 'THE');
        assert(big === expect, n + ' replacements match a plain regex replace');
        info('click to settled: ' + ms + ' ms for ' + n + ' matches in ' + md.length + ' chars');
        await page.evaluate(() => { try { closeFindBar(); } catch (e) {} });

        console.log('\n=== Source Ln follows the caret ===');
        await page.click('#source-cm .cm-content');
        await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
        await settled(page);
        const total = big.split('\n').length;
        let s = await lastStats(page);
        assert(s.lines === total, 'total lines ' + s.lines + ' = text ' + total);
        assert(s.line === total, 'Ctrl+End: Ln ' + s.line + ' = last line ' + total);
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
        await settled(page);
        s = await lastStats(page);
        const pos = await page.evaluate(() => sourceEditor.selectionStart);
        const byText = big.slice(0, pos).split('\n').length;
        assert(s.line === byText, 'after 5 x Up: Ln ' + s.line + ' = counted from the text ' + byText);
        assert(s.line < total, 'Ln moved up from the last line');
        const perMove = await page.evaluate(() => {
            const t = performance.now();
            for (let i = 0; i < 50; i++) getCaretLineNumber();
            return (performance.now() - t) / 50;
        });
        info('caret line in Source: ' + perMove.toFixed(2) + ' ms a call');

        console.log('\n=== Preview Ln follows a scroll, without re-reading the text ===');
        // The caret line only moved, so the stats pass keeps its content cache: scrolling
        // used to throw it away and re-join the whole document every pass.
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
        await settled(page);
        const virt = await page.evaluate(() => !!DocumentModel.virtEnabled);
        info('virtualized: ' + virt);
        await page.evaluate(() => { try { window.getSelection().removeAllRanges(); } catch (e) {} });
        await page.evaluate(() => { _contentCache = 'cached'; window.__sent.length = 0; });
        const before = (await lastStats(page)).line;
        for (let i = 1; i <= 6; i++) {
            await page.evaluate((k) => {
                const c = document.getElementById('main-container');
                c.scrollTop = k * c.scrollHeight / 10;
            }, i);
            await settled(page);
        }
        info('scrollTop ' + await page.evaluate(() => document.getElementById('main-container').scrollTop | 0));
        await new Promise(r => setTimeout(r, 900));
        const after = await lastStats(page);
        assert(after.line > 1 && after.line !== before, 'Ln moved with the scroll (' + before + ' -> ' + after.line + ')');
        assert(await page.evaluate(() => _contentCache === 'cached'), 'content cache kept while scrolling');
        await page.evaluate(() => { _contentCache = null; });
    } finally {
        await browser.close();
    }
    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.log('\nFIND REPLACE BROWSER FAILED'); process.exit(1); }
    console.log('\nFIND REPLACE BROWSER PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
