/**
 * Search mode keeps Up/Down after the sidebar and the Find bar are both closed.
 * The notice is the warning, and Clear search is the way out.
 *
 *   node tests/search-mode-notice-browser.mjs
 */
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

async function notice(page) {
    return page.evaluate(() => {
        const el = document.getElementById('searchModeNotice');
        const text = document.getElementById('searchModeNoticeText');
        const bar = document.getElementById('findBar');
        const side = document.getElementById('sidebar');
        const cs = el ? getComputedStyle(el) : null;
        return {
            hidden: !el || !!el.hidden,
            display: cs ? cs.display : '',
            text: text ? text.textContent : '',
            matches: (findState.matches && findState.matches.length) || 0,
            findOpen: !!(bar && bar.classList.contains('open')),
            sidebarCollapsed: !!(side && side.classList.contains('collapsed')),
            sideValue: (document.getElementById('sidebarSearchInput') || {}).value || '',
            findValue: (document.getElementById('findInput') || {}).value || '',
            mode: state.mode,
            paged: !!(state.pageAdvance && typeof isPaginatedLayout === 'function' && isPaginatedLayout())
        };
    });
}

async function main() {
    const deadline = setTimeout(() => {
        console.error('FAIL budget 40s');
        process.exit(1);
    }, 40000);
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1100, height: 800 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function' && typeof runFind === 'function', { timeout: 15000 });

        await page.evaluate(() => loadMarkdownContent('alpha one\nbeta\nalpha two\n'));
        await settled(page);

        let n = await notice(page);
        assert(n.hidden && n.display === 'none', 'no notice before a search (' + n.display + ')');

        await page.evaluate(() => runFind('zzzz-no-such', false, { navigate: false }));
        await settled(page);
        n = await notice(page);
        assert(n.matches === 0 && n.hidden, 'a query with no hits is not search mode');

        // The ZenSeek path: query filled, sidebar shut, Find bar hidden, matches live.
        await page.evaluate(() => {
            document.getElementById('sidebarSearchInput').value = 'alpha';
            document.getElementById('findInput').value = 'alpha';
            document.getElementById('sidebar').classList.add('collapsed');
            runFind('alpha', false, { navigate: false });
            hideFindBarChrome();
        });
        await settled(page);
        n = await notice(page);
        assert(n.matches === 2, 'two hits (' + n.matches + ')');
        assert(n.sidebarCollapsed && !n.findOpen, 'sidebar shut and Find bar closed');
        assert(!n.hidden && n.display === 'flex', 'notice is on screen (hidden=' + n.hidden + ' display=' + n.display + ')');
        assert(n.text.indexOf('Up and Down step through matches') >= 0, 'Preview names the keys (' + n.text + ')');
        assert(n.text.indexOf('1/2') >= 0, 'notice shows which hit (' + n.text + ')');
        assert(!n.paged ? n.text.indexOf('Left and Right') < 0 : true,
            'scroll Preview does not claim Left and Right page (' + n.text + ')');

        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await settled(page);
        n = await notice(page);
        assert(n.mode === 'reader' && n.paged, 'Reader is paginated');
        assert(!n.hidden && n.text.indexOf('Up and Down step through matches') >= 0
            && n.text.indexOf('Left and Right turn the page') >= 0,
            'Reader names both key changes (' + n.text + ')');

        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await settled(page);
        n = await notice(page);
        assert(n.mode === 'source' && !n.hidden, 'Source still shows that search mode is on');
        assert(n.text.indexOf('Up and Down') < 0 && n.text.indexOf('Search mode') === 0,
            'Source does not claim arrows step matches (' + n.text + ')');

        await page.evaluate(() => handleCommand('view_set:mode:preview'));
        await settled(page);
        // A caret in "be|ta" before Clear search. In 0.20.2 Clear put it at the start of
        // the reading line, so the next letter went somewhere the reader was not.
        const betaPt = await page.evaluate(() => {
            const b = Array.from(editor.querySelectorAll('.block')).find(x => x.textContent === 'beta');
            const t = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
            const r = document.createRange(); r.setStart(t, 2); r.collapse(true);
            const q = r.getBoundingClientRect();
            return { x: q.left + 1, y: q.top + q.height / 2 };
        });
        await page.mouse.click(betaPt.x, betaPt.y);
        await settled(page);
        await page.click('#searchModeNoticeClear');
        await settled(page);
        await page.keyboard.type('Q');
        const typed = await page.evaluate(() => getMarkdownContent(false));
        assert(/^alpha one\nbeQta\nalpha two/.test(typed),
            'Clear search keeps the caret where it was (' + JSON.stringify(typed) + ')');
        await page.keyboard.press('Backspace');
        n = await notice(page);
        assert(n.matches === 0 && n.hidden, 'Clear search leaves search mode');
        assert(n.sideValue === '' && n.findValue === '',
            'both query fields are empty (' + JSON.stringify(n.sideValue) + ' / ' + JSON.stringify(n.findValue) + ')');

        const after = await page.evaluate(() => {
            const ed = document.getElementById('editor');
            ed.focus();
            const before = findState.index;
            ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
            return { before: before, after: findState.index, matches: findState.matches.length };
        });
        assert(after.matches === 0 && after.after === after.before,
            'Down after clearing does not step a hit (' + after.before + ' -> ' + after.after + ')');

        console.log('\n' + passed + ' passed, ' + failed + ' failed');
        if (failed) process.exitCode = 1;
    } finally {
        clearTimeout(deadline);
        await browser.close();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
