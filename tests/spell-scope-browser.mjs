/**
 * Code is not spell-checked, and a large code file opens and scrolls in Source without
 * asking the spell checker anything. Headless.
 *
 * 2026-09-27: opening TypoZen_Template_Test.html (2.2 MB, one line of 356 KB) in Source froze
 * the app. Source sent the lines on screen to the Windows checker, which runs on the host's
 * UI thread and took 13 s over 500 characters of minified script. Code -- HTML, XML, CSS, JS
 * and the rest of 08-code.js's table -- is now never checked, in either view; nor is a fenced
 * code block inside Markdown. The prose around it still is.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const big = fs.readFileSync(path.join(appDir, 'TypoZen_Template_Test.html'), 'utf8');
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
const deadline = setTimeout(() => {
    console.error('SPELL SCOPE: deadline');
    try { browser.process().kill('SIGKILL'); } catch (e) {}
    process.exit(3);
}, 90000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof finishLoadContent === 'function', { timeout: 15000 });
    // Count what would reach the host's checker.
    await page.evaluate(() => {
        window.__spellSends = [];
        const real = postMsg;
        window.postMsg = postMsg = function (m) {
            if (String(m).startsWith('spell_check:')) window.__spellSends.push(String(m));
            return real.apply(this, arguments);
        };
    });

    // Open `text` as a `.ext` file in Source, scroll to the end and back; ms per step and sends.
    const openAndScroll = (text, ext) => page.evaluate(async (text, ext) => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        window.__spellSends = [];
        const t0 = performance.now();
        setSourceDocExt(ext);
        if (state.mode !== 'source') handleCommand('view_set:mode:source');
        finishLoadContent(text, false, false);
        const load = performance.now() - t0;
        await wait(50);
        const t1 = performance.now();
        sourceEditor.scrollToOffset(sourceEditor.value.length, 0);
        await new Promise(r => requestAnimationFrame(() => r()));
        const toEnd = performance.now() - t1;
        await wait(600);                                   // past the 420 ms spelling pause
        sourceEditor.scrollToOffset(0, 0);
        await wait(600);
        return { load: Math.round(load), toEnd: Math.round(toEnd), sends: window.__spellSends.length,
                 underlines: document.querySelectorAll('#source-cm .typozen-spell').length };
    }, text, ext);

    let r = await openAndScroll(big, 'html');
    console.log('  ..   2.2 MB HTML: load ' + r.load + ' ms, to the end ' + r.toEnd + ' ms');
    assert(r.sends === 0 && r.underlines === 0, 'a 2.2 MB HTML file in Source asks the spell checker nothing (' + r.sends + ' sends)');
    assert(r.load < 3000 && r.toEnd < 1500, 'it opens and reaches the end quickly (' + r.load + ' / ' + r.toEnd + ' ms)');

    // The same file through the C-family highlighter: its '@font-face' used to stall the lexer
    // for good (08-code.js, lexClike) -- the page never answered again.
    r = await openAndScroll(big, 'css');
    console.log('  ..   2.2 MB as CSS: load ' + r.load + ' ms, to the end ' + r.toEnd + ' ms');
    assert(r.load < 3000 && r.toEnd < 1500 && r.sends === 0, 'the same file as .css opens, reaches the end, and asks nothing (' + r.load + ' / ' + r.toEnd + ' ms)');

    const huge = Array(10).fill(big).join('\n');           // ~22 MB: bigger files exist
    r = await openAndScroll(huge, 'xml');
    console.log('  ..   22 MB XML: load ' + r.load + ' ms, to the end ' + r.toEnd + ' ms');
    assert(r.sends === 0, 'a 22 MB XML file in Source asks the spell checker nothing (' + r.sends + ' sends)');
    assert(r.load < 15000 && r.toEnd < 3000, 'it opens and reaches the end (' + r.load + ' / ' + r.toEnd + ' ms)');

    // Preview of a code file: nothing either.
    const pv = await page.evaluate(async () => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        setSourceDocExt('js');
        finishLoadContent('const teh = recieve();\n// definately\n', false, false);
        handleCommand('view_set:mode:preview');
        window.__spellSends = [];
        scheduleSpellCheck();
        await wait(600);
        return window.__spellSends.length;
    });
    assert(pv === 0, 'Preview of a .js file asks the spell checker nothing (' + pv + ' sends)');

    // Correction on request: selecting a word in a code file asks the host about that one
    // word, and a misspelling gets its suggestions even though nothing was underlined. The
    // host's answer is played here (headless has no host); spell-app.mjs has the real one.
    const pick = await page.evaluate(async () => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        const out = {};
        setSourceDocExt('js');
        handleCommand('view_set:mode:source');
        finishLoadContent('const x = recieve(1);\nconst y = 2;\n', false, false);
        await wait(300);
        const asked = [];
        const real = postMsg;
        window.postMsg = postMsg = function (m) { if (String(m).startsWith('spell_suggest:')) asked.push(String(m).slice(14)); return real.apply(this, arguments); };
        const select = async (word) => {
            const at = sourceEditor.value.indexOf(word);
            sourceEditor.focus();
            sourceEditor.setSelectionRange(at, at + word.length);
            const box = document.getElementById('source-cm').getBoundingClientRect();
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: box.left + 20, clientY: box.top + 10 }));
            await wait(150);
        };
        await select('recieve');
        out.asked = asked.slice();
        applySpellSuggestions('recieve\treceive|relieve');
        const row = document.getElementById('selPopSpell');
        out.fixes = Array.from(row.querySelectorAll('[data-spell-fix]')).map(b => b.textContent);
        out.shown = !row.hidden;
        try { hideSelPop(); } catch (e) {}
        await select('const');
        applySpellSuggestions('const\t');
        out.correctShown = !document.getElementById('selPopSpell').hidden;
        try { hideSelPop(); } catch (e) {}
        window.postMsg = postMsg = real;
        handleCommand('view_set:mode:preview');
        return out;
    });
    assert(pick.asked.includes('recieve'), 'selecting a word in a .js file asks the host about that word (asked ' + JSON.stringify(pick.asked) + ')');
    assert(pick.shown && pick.fixes.includes('receive'), 'a misspelled selection offers its suggestions (' + JSON.stringify(pick.fixes) + ')');
    assert(!pick.correctShown, 'a correctly spelled selection shows no spelling row');

    // 2-Col: only the pages on screen are checked. Every mounted page sits in the same
    // vertical band, and a vertical-only test sent 87,000 characters of the README in one
    // pass -- which froze the app when the checker still ran on the UI thread (2026-09-27).
    const readme = fs.readFileSync(path.join(appDir, 'README.md'), 'utf8');
    const cols = await page.evaluate(async (md) => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        setSourceDocExt('md'); handleCommand('view_set:mode:preview');
        finishLoadContent(md, false, false); await wait(800);
        handleCommand('view_set:columns:2'); await wait(1500);
        const paged = document.body.classList.contains('tz-pages');
        const chars = previewSpellItems().reduce((a, i) => a + i.text.length, 0);
        handleCommand('view_set:columns:1'); await wait(500);
        return { paged, chars, total: md.length };
    }, readme);
    assert(cols.paged && cols.chars > 0 && cols.chars < 12000,
        '2-Col checks only the pages on screen (' + cols.chars + ' of ' + cols.total + ' characters)');

    // Markdown: prose is checked, a fence is not -- in both views.
    const md = await page.evaluate(async () => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        const out = {};
        setSourceDocExt('md');
        finishLoadContent('Prose with teh typo.\n\n```js\nconst recieve = 1;\n```\n', false, false);
        handleCommand('view_set:mode:preview');
        window.__spellSends = [];
        scheduleSpellCheck();
        await wait(600);
        out.preview = window.__spellSends.join('\n');
        handleCommand('view_set:mode:source');
        window.__spellSends = [];
        _spellCache.clear();
        sourceEditor.recheckSpelling();
        await wait(600);
        out.source = window.__spellSends.join('\n');
        handleCommand('view_set:mode:preview');
        return out;
    });
    assert(/teh/.test(md.preview) && !/recieve/.test(md.preview), 'Preview checks the prose and skips the fence');
    assert(/teh/.test(md.source) && !/recieve/.test(md.source), 'Source checks the prose and skips the fence');
} finally {
    clearTimeout(deadline);
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SPELL SCOPE FAILED'); process.exit(1); }
console.log('SPELL SCOPE PASSED');
