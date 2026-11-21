/**
 * The menus' Paste does what Ctrl+V does; Paste as Plain Text pastes the words only.
 *
 * Found 2026-11-21: Edit > Paste and right-click > Paste sent only the clipboard's plain
 * text, so a paste from a web page lost its bold and links by menu and kept them by Ctrl+V.
 * The host now sends the clipboard's HTML too (paste_rich:, as WPF reads it: CF_HTML with
 * its header and fragment markers), and the page pastes it through the same function as
 * the paste event (pasteLikeCtrlV). Paste as Plain Text is paste_text:. Ctrl+Shift+V asks
 * the host for it (paste_plain). Preview and Source.
 *
 *   node tests/paste-menu-browser.mjs
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

const FRAGMENT = '<p>A <b>bold</b> word and <a href="https://y.com">a link</a></p>';
const PLAIN = 'A bold word and a link';
// The clipboard's own HTML layout, as WPF hands it to the host.
const cfHtml = (frag) => {
    const body = '<html><body>\r\n<!--StartFragment-->' + frag + '<!--EndFragment-->\r\n</body></html>';
    return 'Version:0.9\r\nStartHTML:00000097\r\nEndHTML:' + String(97 + body.length).padStart(8, '0')
        + '\r\nStartFragment:00000133\r\nEndFragment:' + String(133 + frag.length).padStart(8, '0') + '\r\n' + body;
};

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => {
        window.__L = []; window.__sent = [];
        window.chrome = { webview: { postMessage: (m) => window.__sent.push(String(m)), addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() {} } };
        window.__host = (m) => window.__L.forEach(fn => fn({ data: m }));
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });

    const saved = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
    const startAtEnd = async (mode) => {
        await page.evaluate(() => { setSourceDocExt('md'); loadMarkdownContent('Start.'); });
        await page.evaluate((m) => handleCommand('view_set:mode:' + m), mode);
        await settled(page);
        if (mode === 'source') await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(6, 6); });
        else { const el = await page.$('#editor .block'); await el.click(); await page.keyboard.press('End'); }
    };
    const pasteEvent = (html, plain) => page.evaluate((h, p) => {
        const dt = new DataTransfer();
        if (h) dt.setData('text/html', h);
        dt.setData('text/plain', p);
        const target = state.mode === 'source' ? document.querySelector('#source-cm .cm-content') : document.getElementById('editor');
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, html, plain);

    for (const mode of ['wysiwyg', 'source']) {
        console.log('\n=== ' + mode + ' ===');
        await startAtEnd(mode);
        await pasteEvent(FRAGMENT, PLAIN);
        await settled(page);
        const byKey = await saved();
        same(mode + ': premise: Ctrl+V keeps the formatting as Markdown', /\*\*bold\*\*/.test(byKey) && /\]\(https:\/\/y\.com\)/.test(byKey), true);

        await startAtEnd(mode);
        await page.evaluate((m) => window.__host(m), 'paste_rich:' + JSON.stringify({ html: cfHtml(FRAGMENT), text: PLAIN }));
        await settled(page);
        same(mode + ': the menus\' Paste writes exactly what Ctrl+V writes', await saved(), byKey);

        await startAtEnd(mode);
        await page.evaluate((m) => window.__host(m), 'paste_text:' + PLAIN);
        await settled(page);
        same(mode + ': Paste as Plain Text writes the words only', await saved(), 'Start.' + PLAIN);

        // TypoZen's own copy carries its Markdown as plain text: that is what is pasted.
        await startAtEnd(mode);
        await page.evaluate((m) => window.__host(m), 'paste_rich:' + JSON.stringify({ html: cfHtml('<div data-source="typozen"><b>x</b></div>'), text: '**x** own' }));
        await settled(page);
        same(mode + ': TypoZen\'s own copy pastes its Markdown', await saved(), 'Start.**x** own');

        await startAtEnd(mode);
        await page.evaluate(() => { window.__sent = []; });
        await page.keyboard.down('Control'); await page.keyboard.down('Shift');
        await page.keyboard.press('KeyV');
        await page.keyboard.up('Shift'); await page.keyboard.up('Control');
        await settled(page);
        same(mode + ': Ctrl+Shift+V asks the host for Paste as Plain Text', JSON.stringify(await page.evaluate(() => window.__sent.filter(m => m === 'paste_plain'))), JSON.stringify(['paste_plain']));
    }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
