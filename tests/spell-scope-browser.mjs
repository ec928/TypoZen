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

    // Scrolled away: requests still waiting for pages no longer on screen are dropped
    // (spell_drop:), so the host does not work through pages already left (2026-09-29).
    // Headless has no host, so every request stays pending -- exactly the case.
    const drops = await page.evaluate(async () => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        const sent = [];
        const real = postMsg;
        window.postMsg = postMsg = function (m) { const s = String(m); if (/^spell_(check|drop):/.test(s)) sent.push(s.split('\n')[0]); return real.apply(this, arguments); };
        setSourceDocExt('md'); handleCommand('view_set:mode:preview');
        handleCommand('view_set:columns:1'); handleCommand('view_set:scroll:scroll');   // after the 2-Col check
        // Words of its own in every paragraph: checks go by word, and a request holding a
        // word the new screen still needs is rightly kept.
        const own = (i) => { let s = ''; do { s += String.fromCharCode(97 + i % 26); i = Math.floor(i / 26); } while (i); return 'zq' + s; };
        finishLoadContent(Array.from({ length: 3000 }, (_, i) => own(i) + 'x ' + own(i) + 'y ' + own(i) + 'z.').join('\n\n'), false, false);
        await wait(600);
        _spellCache.clear(); _spellWords.clear(); _spellWordPending.clear(); _spellRequests.clear(); sent.length = 0;   // forget the load's own pass
        runSpellCheckNow(); await wait(100);
        const first = sent.filter(s => s.startsWith('spell_check:')).map(s => s.slice(12));
        const before = previewSpellItems().map(i => i.text.slice(0, 14));
        document.getElementById('main-container').scrollTop = 60000; await wait(300);
        const after = previewSpellItems().map(i => i.text.slice(0, 14));
        runSpellCheckNow(); await wait(100);
        window.postMsg = postMsg = real;
        const dropped = sent.filter(s => s.startsWith('spell_drop:')).map(s => s.slice(11));
        return { first, dropped, before: before.slice(0, 3), after: after.slice(0, 3), pending: _spellRequests.size, st: document.getElementById('main-container').scrollTop };
    });
    console.log('  ..   ' + JSON.stringify({ before: drops.before, after: drops.after, pending: drops.pending, scrollTop: drops.st }));
    assert(drops.first.length > 0 && drops.first.every(id => drops.dropped.includes(id)),
        'scrolling away drops the requests for the pages left (' + drops.dropped.length + ' of ' + drops.first.length + ')');

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
        _spellCache.clear(); _spellWords.clear(); _spellWordPending.clear(); _spellRequests.clear();
        sourceEditor.recheckSpelling();
        await wait(600);
        out.source = window.__spellSends.join('\n');
        handleCommand('view_set:mode:preview');
        return out;
    });
    assert(/teh/.test(md.preview) && !/recieve/.test(md.preview), 'Preview checks the prose and skips the fence');
    assert(/teh/.test(md.source) && !/recieve/.test(md.source), 'Source checks the prose and skips the fence');

    // By word (2026-09-29): the checker costs ~4-5 ms a character, so it is sent each new
    // word once, not paragraphs. The host's answer is played here; its offsets are into the
    // word list, and must land on every paragraph holding the word.
    const words = await page.evaluate(async () => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        const out = {};
        setSourceDocExt('md'); handleCommand('view_set:mode:preview');
        _spellCache.clear(); _spellWords.clear(); _spellWordPending.clear(); _spellRequests.clear();
        const sent = [];
        const real = postMsg;
        window.postMsg = postMsg = function (m) { if (String(m).startsWith('spell_check:')) sent.push(String(m).slice(12)); return real.apply(this, arguments); };
        finishLoadContent('The cat sat on teh mat, and the "dog" sat on teh rug.\n\nAnother teh here, at 10:30 in C:/tmp for NASA.', false, false);
        await wait(700);
        window.postMsg = postMsg = real;
        out.sends = sent.length;
        const nl = sent[0] ? sent[0].indexOf('\n') : -1;
        const id = nl > 0 ? sent[0].slice(0, nl) : '';
        const list = nl > 0 ? sent[0].slice(nl + 1).split('\n') : [];
        out.list = list;
        const at = list.join('\n').indexOf('teh');
        applySpellHits(id + '\t1\n' + at + '\t3\tteh');
        await wait(50);
        const items = previewSpellItems();
        out.a = items[0] && spellCached(items[0].text);
        out.b = items[1] && spellCached(items[1].text);
        out.underlines = _spellHits.length;
        out.pending = _spellRequests.size;
        return out;
    });
    console.log('  ..   sent ' + JSON.stringify(words.list));
    assert(words.sends === 1 && words.list.filter(w => w === 'teh').length === 1 && words.list.includes('dog'),
        'each word goes to the checker once, quotes trimmed (' + words.list.length + ' words)');
    assert(!words.list.some(w => /\d|\/|:|^NASA$/.test(w)), 'times, paths and short acronyms are not sent');
    assert(JSON.stringify((words.a || []).map(h => [h.start, h.word])) === '[[15,"teh"],[45,"teh"]]'
        && JSON.stringify((words.b || []).map(h => [h.start, h.word])) === '[[8,"teh"]]' && words.pending === 0,
        'the answer lands on every place the word appears (' + JSON.stringify(words.a) + ' / ' + JSON.stringify(words.b) + ')');
    assert(words.underlines === 3, 'Preview underlines all three (' + words.underlines + ')');
} finally {
    clearTimeout(deadline);
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('SPELL SCOPE FAILED'); process.exit(1); }
console.log('SPELL SCOPE PASSED');
