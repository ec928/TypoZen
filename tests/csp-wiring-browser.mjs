/**
 * The page runs under a Content-Security-Policy that allows no inline script, so every
 * handler that used to be an onclick="" / onerror="" attribute is now wired in a module.
 * This presses each of them and fails on any policy violation the page reports.
 *
 *   - the template has no inline <script> and no on*="" attributes
 *   - sidebar tabs switch panes
 *   - the table dialog: Enter inserts, Escape closes, the buttons work
 *   - search results: clicking a row jumps to it; "+N more" extends the list
 *   - a task checkbox toggles the Markdown
 *   - a Markdown link: Ctrl+click opens it, a plain click does not
 *   - an image that fails to load asks the host for its bytes
 *
 *   node tests/csp-wiring-browser.mjs
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
const hostMsgs = (page) => page.evaluate(() => window.__sent.filter(m =>
    !/^(stats:|typing|chapter:|save_prefs|prefs:|perf)/.test(m)));
const clearMsgs = (page) => page.evaluate(() => { window.__sent.length = 0; });

async function main() {
    console.log('=== template ===');
    const html = fs.readFileSync(path.join(appDir, 'TypoZen_Template.html'), 'utf8');
    const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
    assert(/http-equiv="Content-Security-Policy"/.test(html), 'declares a Content-Security-Policy');
    assert(!/<script>/i.test(noComments), 'no inline <script>');
    assert(!/\son[a-z]+\s*=\s*"/i.test(noComments), 'no inline event-handler attributes');

    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
        await page.evaluateOnNewDocument(() => {
            window.__sent = [];
            window.__csp = [];
            window.chrome = { webview: {
                postMessage: (m) => window.__sent.push(String(m)),
                addEventListener() {}, removeEventListener() {}
            } };
            document.addEventListener('securitypolicyviolation', (e) => {
                window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || ''));
            });
        });
        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
        assert(await page.evaluate(() => typeof window.__tzHead === 'number' && typeof window.__tzBeforeMain === 'number'),
            'start-up timing marks still set');

        console.log('\n=== sidebar tabs ===');
        for (const tab of ['search', 'marks', 'outline']) {
            await page.click('.sidebar-tab[data-tab="' + tab + '"]');
            await settled(page);
            const active = await page.evaluate(() => {
                const p = document.querySelector('.tab-pane.active'); return p ? p.id : '';
            });
            assert(active === 'tab-' + tab, 'clicking ' + tab + ' shows its pane (' + active + ')');
        }

        console.log('\n=== table dialog ===');
        await page.evaluate(() => loadMarkdownContent('Start.'));
        await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
        await settled(page);
        await (await page.$('#editor .block')).click();
        await page.keyboard.press('End');
        const shown = () => page.evaluate(() => document.getElementById('tableModal').style.display);
        await page.evaluate(() => openTableCustomModal());
        await page.keyboard.press('Escape');
        assert(await shown() === 'none', 'Escape closes it');
        await page.evaluate(() => openTableCustomModal());
        await page.click('#tblCancel');
        assert(await shown() === 'none', 'Cancel closes it');
        await page.evaluate(() => openTableCustomModal());
        await page.click('#tblCols', { clickCount: 3 }); await page.keyboard.type('2');
        await page.keyboard.press('Enter');
        await settled(page);
        let md = await page.evaluate(() => getMarkdownContent(false));
        assert(await shown() === 'none' && /\|/.test(md), 'Enter inserts a table');
        await page.evaluate(() => loadMarkdownContent('Start.'));
        await settled(page);
        await (await page.$('#editor .block')).click();
        await page.evaluate(() => openTableCustomModal());
        await page.click('#tblInsert');
        await settled(page);
        md = await page.evaluate(() => getMarkdownContent(false));
        assert(/\|/.test(md), 'Insert Table inserts a table');

        console.log('\n=== search results ===');
        const many = Array.from({ length: 400 }, (_, i) => 'Line ' + i + ' has the needle in it.').join('\n\n');
        await page.evaluate((m) => loadMarkdownContent(m), many);
        await settled(page);
        await page.click('.sidebar-tab[data-tab="search"]');
        await page.evaluate(() => { runFind('needle', false, { navigate: false }); updateSearchSidebar(); });
        await settled(page);
        const before = await page.$$eval('#search-results-list .search-item[data-i]', l => l.length);
        const rows = await page.$$('#search-results-list .search-item[data-i]');
        await rows[3].click();
        await settled(page);
        assert(await page.evaluate(() => findState.index) === 3, 'clicking row 4 jumps to match 4');
        const more = await page.$('#search-results-list .search-more');
        if (more) {
            await more.click();
            await settled(page);
            const after = await page.$$eval('#search-results-list .search-item[data-i]', l => l.length);
            assert(after > before, '"+N more" shows more rows (' + before + ' -> ' + after + ')');
        } else {
            assert(false, 'expected a "+N more" row with 400 matches (rendered ' + before + ')');
        }

        console.log('\n=== task checkbox ===');
        await page.evaluate(() => loadMarkdownContent('Intro.\n\n- [ ] buy milk'));
        await settled(page);
        await (await page.$('#editor .block')).click();
        await settled(page);
        await page.click('#editor .task-checkbox');
        await settled(page);
        md = await page.evaluate(() => getMarkdownContent(false));
        assert(/- \[x\] buy milk/.test(md), 'clicking the box checks it in the Markdown (' + JSON.stringify(md) + ')');

        console.log('\n=== links ===');
        await page.evaluate(() => loadMarkdownContent('First.\n\nSee [the other note](other.md) here.'));
        await settled(page);
        await (await page.$('#editor .block')).click();
        await settled(page);
        const a = await page.$('#editor a[href="other.md"]');
        await clearMsgs(page);
        await page.keyboard.down('Control'); await a.click(); await page.keyboard.up('Control');
        await settled(page);
        assert((await hostMsgs(page)).includes('open_doc:other.md'), 'Ctrl+click opens the linked note');
        await clearMsgs(page);
        const a2 = await page.$('#editor a[href="other.md"]');
        if (a2) { await a2.click(); await settled(page); }
        assert(!(await hostMsgs(page)).some(m => m.startsWith('open_')), 'a plain click does not');

        console.log('\n=== image fallback ===');
        await clearMsgs(page);
        await page.evaluate(() => loadMarkdownContent('Text.\n\n![pic](missing-picture.png)\n\nMore.'));
        await (await page.$('#editor .block')).click();
        await new Promise(r => setTimeout(r, 1500));
        const req = (await hostMsgs(page)).filter(m => m.startsWith('image_data_req:'));
        assert(req.some(m => m.indexOf('missing-picture.png') >= 0), 'a failed image asks the host for its bytes (' + JSON.stringify(req) + ')');

        console.log('\n=== policy ===');
        const csp = await page.evaluate(() => window.__csp);
        assert(csp.length === 0, 'no Content-Security-Policy violations (' + JSON.stringify(csp.slice(0, 5)) + ')');
    } finally {
        await browser.close();
    }
    console.log('\npassed=' + passed + ' failed=' + failed);
    if (failed) { console.log('\nCSP WIRING BROWSER FAILED'); process.exit(1); }
    console.log('\nCSP WIRING BROWSER PASSED');
}

main().catch(e => { console.error(e); process.exit(1); });
