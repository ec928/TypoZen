/**
 * Inline code is not spell-checked, in Preview or Source, and an underline is a squiggle
 * with no box behind it. Headless; the host's checker is played by a stub.
 *
 * 2026-10-17: the README's `.epub` was underlined in Preview, and every flagged word also
 * carried a red tinted box.
 */
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

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
const deadline = setTimeout(() => {
    console.error('SPELL INLINE CODE: deadline');
    try { browser.process().kill('SIGKILL'); } catch (e) {}
    process.exit(3);
}, 40000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof finishLoadContent === 'function', { timeout: 15000 });
    // The host: "recieve" and "epbu" are misspelled, wherever they appear.
    await page.evaluate(() => {
        const real = postMsg;
        window.postMsg = postMsg = function (m) {
            m = String(m);
            if (m.startsWith('spell_check:')) {
                const nl = m.indexOf('\n'), id = m.slice(12, nl), body = m.slice(nl + 1);
                let out = 'spell_hits:' + id + '\t1';
                for (const bad of ['recieve', 'epbu']) {
                    let i = -1;
                    while ((i = body.indexOf(bad, i + 1)) >= 0) out += '\n' + i + '\t' + bad.length + '\t' + bad;
                }
                // hits in body order
                const lines = out.split('\n'), head = lines.shift();
                lines.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
                setTimeout(() => applySpellHits([head].concat(lines).join('\n').slice(11)), 0);
                return;
            }
            return real.apply(this, arguments);
        };
    });
    const text = 'We recieve files.\n\nOpen `.epbu` and `recieve` here.\n';
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    await page.evaluate((text) => {
        setSourceDocExt('md');
        if (state.mode !== 'preview') handleCommand('view_set:mode:preview');
        finishLoadContent(text, false, false);
        scheduleSpellCheck();
    }, text);
    await wait(900);
    const prev = await page.evaluate(() => {
        const h = CSS.highlights.get('typozen-spell');
        const words = h ? [...h].map(r => r.toString()) : [];
        return { words };
    });
    assert(prev.words.length === 1 && prev.words[0] === 'recieve',
        'Preview underlines the prose misspelling only (got ' + JSON.stringify(prev.words) + ')');

    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await wait(1000);
    const src = await page.evaluate(() => {
        const els = [...document.querySelectorAll('#source-cm .typozen-spell')];
        const bg = els.length ? getComputedStyle(els[0]).backgroundColor : '';
        return { words: els.map(e => e.textContent), bg };
    });
    assert(src.words.length === 1 && src.words[0] === 'recieve',
        'Source underlines the prose misspelling only (got ' + JSON.stringify(src.words) + ')');
    assert(src.bg === 'rgba(0, 0, 0, 0)' || src.bg === 'transparent',
        'an underline has no box behind it (background ' + src.bg + ')');
} catch (e) {
    failed++;
    console.error('  FAIL ' + (e && e.stack || e));
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`passed=${passed} failed=${failed}`);
if (failed) { console.log('SPELL INLINE CODE FAILED'); process.exit(1); }
console.log('SPELL INLINE CODE PASSED');
