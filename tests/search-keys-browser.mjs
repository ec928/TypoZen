/**
 * Stepping through search results without the sidebar, and the two options that shape them.
 *
 *   - ',' and '.' (and '<' '>') move to the previous and next hit while reading, with focus
 *     on the document and the sidebar shut
 *   - they do nothing in an editable mode, where a comma is a comma
 *   - match case and whole word are reachable from the sidebar and change the result count
 *   - the sidebar buttons and the Ctrl+F checkboxes are one setting, not two
 *
 * Browser tier on purpose: all of it is page behaviour, and a few seconds means it can be
 * run on every change rather than once at the end.
 *
 *   node tests/search-keys-browser.mjs
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

/** A real key press on the document, the way a reader produces one. */
async function pressOnEditor(page, key) {
    await page.evaluate((k) => {
        const ed = document.getElementById('editor');
        ed.focus({ preventScroll: true });
        ed.dispatchEvent(new KeyboardEvent('keydown', {
            key: k, bubbles: true, cancelable: true
        }));
    }, key);
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        const md = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await settled(page);

        console.log('\n=== stepping with , and . while reading ===');
        await page.evaluate(() => handleCommand('view_set:mode:reader'));
        await settled(page);
        // Search the way the sidebar does, then shut the sidebar entirely.
        await page.evaluate(() => {
            runFind('scroll marker', false, { navigate: false });
            const sb = document.getElementById('sidebar');
            if (sb) sb.classList.add('collapsed');
        });
        await settled(page);

        const total = await page.evaluate(() => findState.matches.length);
        info(total + ' matches, sidebar collapsed, focus on the document');
        assert(total > 5, 'there is something to step through (' + total + ')');

        await page.evaluate(() => window.findJumpTo(0));
        await settled(page);

        const seen = [await page.evaluate(() => findState.index)];
        for (const k of ['.', '.', '>']) {
            await pressOnEditor(page, k);
            await settled(page);
            seen.push(await page.evaluate(() => findState.index));
        }
        info('forward: ' + JSON.stringify(seen));
        assert(seen[1] === seen[0] + 1 && seen[2] === seen[1] + 1,
            "'.' moves to the next match");
        assert(seen[3] === seen[2] + 1, "'>' does the same as '.'");

        const back = [];
        for (const k of [',', '<']) {
            await pressOnEditor(page, k);
            await settled(page);
            back.push(await page.evaluate(() => findState.index));
        }
        info('back: ' + JSON.stringify(back));
        assert(back[0] === seen[3] - 1, "',' moves to the previous match");
        assert(back[1] === back[0] - 1, "'<' does the same as ','");

        // The reader is looking at the match, not at wherever they were.
        const onScreen = await page.evaluate(() => {
            const hl = CSS.highlights.get('typozen-find-current');
            return { marked: hl ? hl.size : 0, index: findState.index };
        });
        assert(onScreen.marked === 1,
            'the match it stepped to is the one marked as current (' + onScreen.marked + ')');

        console.log('\n=== a comma is a comma in an editable mode ===');
        await page.evaluate(() => handleCommand('view_set:mode:preview'));
        await settled(page);
        const before = await page.evaluate(() => findState.index);
        await pressOnEditor(page, '.');
        await settled(page);
        const after = await page.evaluate(() => findState.index);
        assert(after === before,
            'the step keys do nothing in Preview, where they are text (' +
            before + ' -> ' + after + ')');

        console.log('\n=== match case and whole word ===');
        await page.evaluate(() => {
            const sb = document.getElementById('sidebar');
            if (sb) sb.classList.remove('collapsed');
            handleCommand('view_set:mode:reader');
        });
        await settled(page);

        const opts = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const input = document.getElementById('sidebarSearchInput');
            const mcBtn = document.getElementById('sidebarMatchCase');
            const wwBtn = document.getElementById('sidebarWholeWord');
            const mcBox = document.getElementById('findMatchCase');
            const wwBox = document.getElementById('findWholeWord');
            wireSidebarSearch();

            const out = { present: !!(mcBtn && wwBtn) };
            if (!out.present) return out;

            // "Section" appears capitalised in headings; "section" lower case does not.
            input.value = 'section';
            runFind(input.value, false, { navigate: false });
            out.insensitive = findState.matches.length;

            mcBtn.click();
            await sleep(150);
            out.caseSensitive = findState.matches.length;
            out.boxFollowed = !!mcBox.checked;
            out.pressed = mcBtn.getAttribute('aria-pressed');

            mcBtn.click();
            await sleep(150);

            // "row" occurs 2147 times alone and 140 times inside a longer word, so the
            // count has to move. "column" does not -- it only ever appears whole in this
            // fixture, and a test that cannot tell the option from a no-op passes either way.
            input.value = 'row';
            runFind(input.value, false, { navigate: false });
            out.anySubstring = findState.matches.length;
            wwBtn.click();
            await sleep(150);
            out.wholeWordOnly = findState.matches.length;
            out.wwBoxFollowed = !!wwBox.checked;

            // The find bar is the same setting seen from the other side.
            wwBox.checked = false;
            wwBox.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(50);
            out.buttonFollowedBox = wwBtn.getAttribute('aria-pressed');
            return out;
        });

        assert(opts.present, 'the sidebar offers match case and whole word');
        info('"section": ' + opts.insensitive + ' any case, ' + opts.caseSensitive + ' exact');
        assert(opts.caseSensitive < opts.insensitive,
            'match case narrows the results (' + opts.insensitive + ' -> ' + opts.caseSensitive + ')');
        assert(opts.boxFollowed && opts.pressed === 'true',
            'and it is the same setting the Ctrl+F bar holds');
        info('"row": ' + opts.anySubstring + ' anywhere, ' + opts.wholeWordOnly + ' whole word');
        assert(opts.wholeWordOnly < opts.anySubstring,
            'whole word narrows the results (' + opts.anySubstring + ' -> ' + opts.wholeWordOnly + ')');
        assert(opts.wwBoxFollowed, 'whole word reaches the find bar too');
        assert(opts.buttonFollowedBox === 'false',
            'and changing it in the find bar shows in the sidebar');
    } finally {
        await browser.close();
    }

    console.log('\npassed=' + passed + ' failed=' + failed);
    console.log(failed ? 'SEARCH KEYS FAILED' : 'SEARCH KEYS PASSED');
    process.exit(failed ? 1 : 0);
}

main();
