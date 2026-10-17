/**
 * The reading bar: it shows and hides with the host's state, repaints from it,
 * and each button does its job -- page actions in the page, the rest as messages to the
 * host. Headless; the host is played by a stub.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const shots = process.env.READ_BAR_SHOTS || '';
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
const deadline = setTimeout(() => {
    console.error('READ BAR: deadline');
    try { browser.process().kill('SIGKILL'); } catch (e) {}
    process.exit(3);
}, 40000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 700 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof finishLoadContent === 'function' && typeof window.setReadBar === 'function', { timeout: 15000 });
    await page.evaluate(() => {
        window.__posts = []; window.__calls = [];
        const real = window.chrome && window.chrome.webview && window.chrome.webview.postMessage;
        window.chrome = window.chrome || {};
        window.chrome.webview = window.chrome.webview || {};
        window.chrome.webview.postMessage = (m) => { window.__posts.push(String(m)); };
        window.readAloudSkip = (d) => window.__calls.push('skip' + d);
        window.readAloudPause = () => window.__calls.push('pause');
        finishLoadContent('# Chapter\n\n' + 'A paragraph to read aloud. '.repeat(40) + '\n\nAnother one.\n', false, false);
    });
    const bar = () => page.evaluate(() => {
        const el = document.getElementById('tzReadBar');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
            hidden: el.hidden || getComputedStyle(el).display === 'none',
            voice: el.querySelector('.rb-voice-name').textContent,
            speed: el.querySelector('.rb-speed').textContent,
            play: el.querySelector('.rb-play').title,
            chapter: el.querySelector('.rb-chapter').getAttribute('aria-pressed'),
            slowerDisabled: el.querySelector('[data-a="slower"]').disabled,
            box: { x: r.x, y: r.y, w: r.width, h: r.height }
        };
    });

    assert(await bar() === null, 'no bar before a reading');
    await page.evaluate(() => window.setReadBar('{"show":true,"paused":false,"voice":"Breeze: Mary (RP, Breeze)","speed":1,"chapter":false}'));
    let b = await bar();
    assert(b && !b.hidden, 'the bar shows while reading');
    assert(b.voice === 'Breeze: Mary (RP, Breeze)' && b.speed === '1×' && b.play === 'Pause', 'it shows the voice, the speed and Pause (' + JSON.stringify(b) + ')');
    const mid = await page.evaluate(() => { const r = document.getElementById('main-container').getBoundingClientRect(); return r.left + r.width / 2; });
    assert(b.box.y + b.box.h <= 700 && b.box.y > 600 && Math.abs(b.box.x + b.box.w / 2 - mid) < 2, 'it floats at the bottom, centred under the text (' + JSON.stringify(b.box) + ', text centre ' + mid + ')');
    if (shots) await page.screenshot({ path: path.join(shots, 'bar-dark.png') });

    const click = (a) => page.evaluate((a) => document.querySelector('#tzReadBar [data-a="' + a + '"]').click(), a);
    await click('prev'); await click('pause'); await click('next');
    assert(JSON.stringify(await page.evaluate(() => window.__calls)) === '["skip-1","pause","skip1"]', 'Previous, Pause and Next act in the page');
    await click('menu'); await click('chapter');
    await click('faster');
    let posts = await page.evaluate(() => window.__posts.filter(p => p.startsWith('host_read_bar:')));
    assert(JSON.stringify(posts) === '["host_read_bar:menu","host_read_bar:chapter","host_read_bar:speed:1.25"]', 'menu, chapter and speed go to the host (' + JSON.stringify(posts) + ')');
    assert((await bar()).speed === '1.25×', 'the speed shows at once');

    await page.evaluate(() => window.setReadBar('{"show":true,"paused":true,"speed":0.5,"chapter":true}'));
    b = await bar();
    assert(b.play === 'Resume' && b.chapter === 'true' && b.slowerDisabled, 'paused: Resume; chapter on; Slower stops at 0.5x');
    assert(await page.evaluate(() => window._tzReadSpeed) === 0.5, 'Kokoro reads at the bar speed');
    if (shots) {
        await page.evaluate(() => { document.documentElement.style.setProperty('--bg', '#FBF8F1'); document.documentElement.style.setProperty('--tx', '#2b2b2b'); document.documentElement.style.setProperty('--border', '#d8d0c0'); });
        await page.screenshot({ path: path.join(shots, 'bar-light.png') });
    }

    const keepCaret = await page.evaluate(() => {
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        document.querySelector('#tzReadBar [data-a="next"]').dispatchEvent(ev);
        return ev.defaultPrevented;
    });
    assert(keepCaret, 'pressing the bar does not take the caret');

    await page.evaluate(() => window.setReadBar('{"show":false}'));
    assert((await bar()).hidden, 'it goes when the reading stops');
} catch (e) {
    failed++;
    console.error('  FAIL ' + (e && e.stack || e));
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`passed=${passed} failed=${failed}`);
if (failed) { console.log('READ BAR FAILED'); process.exit(1); }
console.log('READ BAR PASSED');
