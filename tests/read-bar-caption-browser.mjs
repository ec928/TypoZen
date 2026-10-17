/**
 * The reading bar's caption: while the bar is up it is the one place a reading says what it is
 * doing -- a narrator starting, preparing, catching up, paused, or failed -- with the controls
 * that cannot act yet dimmed, and no pop-up on top. Headless; host messages are fed through
 * the page's own handler (a stubbed chrome.webview).
 *
 * 2026-10-17: "Starting the Breeze narrator..." popped up over the bar, the status bar said it
 * again, and the bar showed Pause and Next as if playing.
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
    console.error('READ BAR CAPTION: deadline');
    try { browser.process().kill('SIGKILL'); } catch (e) {}
    process.exit(3);
}, 40000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 760 });
    await page.evaluateOnNewDocument(() => {
        window.__posts = [];
        window.chrome = window.chrome || {};
        window.chrome.webview = {
            postMessage: (m) => window.__posts.push(String(m)),
            addEventListener: (type, fn) => { if (type === 'message') window.__host = (data) => fn({ data: data }); },
            removeEventListener: () => {}
        };
    });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__host === 'function' && typeof window.setReadBar === 'function', { timeout: 15000 });
    await page.evaluate(() => {
        setSourceDocExt('md');
        finishLoadContent('A paragraph to read.\n\nAnother one.\n', false, false);
    });
    const look = () => page.evaluate(() => {
        const el = document.getElementById('tzReadBar');
        const cap = el && el.querySelector('.rb-caption');
        const shown = (x) => !!x && getComputedStyle(x).display !== 'none';
        const pop = document.getElementById('kokoro-status');
        const bar = el ? el.getBoundingClientRect() : null;
        const pr = pop ? pop.getBoundingClientRect() : null;
        return {
            caption: shown(cap) ? cap.querySelector('.rb-caption-text').textContent : null,
            progress: shown(cap) && shown(cap.querySelector('.rb-progress')),
            retry: shown(cap) && shown(cap.querySelector('.rb-retry')),
            dimmed: ['prev', 'pause', 'next'].map(a => el.querySelector('[data-a="' + a + '"]').disabled),
            stopOk: !el.querySelector('[data-a="stop"]').disabled,
            popup: pop ? pop.innerText : null,
            popupOverBar: !!(pr && bar && pr.bottom > bar.top - 40 && pr.top < bar.bottom)
        };
    });

    // Read Aloud with Breeze: the host puts the bar up, then reports the start-up.
    await page.evaluate(() => {
        __host('cmd:read_bar:{"show":true,"paused":false,"voice":"Breeze: Mary (RP, Breeze)","speed":1,"chapter":false}');
        __host('cmd:narrator_status:Starting the Breeze narrator: loading the voice model and preparing the graphics card, 18s (usually about 40s).');
        __host('cmd:narrator_starting:{"engine":"Breeze","waited":18,"usual":40}');
    });
    let s = await look();
    assert(s.caption === 'Starting Breeze · 18 s of ~40 s' && s.progress, 'starting: the caption, with progress (' + JSON.stringify(s.caption) + ')');
    assert(s.dimmed.every(Boolean) && s.stopOk, 'starting: Previous, Pause and Next dimmed, Stop works');
    assert(s.popup === null, 'starting: no pop-up while the bar is up');
    if (shots) await page.screenshot({ path: path.join(shots, 'caption-starting.png') });

    await page.evaluate(() => __host('cmd:narrator_starting:{"engine":"Breeze","waited":52,"usual":40}'));
    s = await look();
    assert(/52 s · a first start takes longer/.test(s.caption) && !s.progress, 'past the usual time it says so, without a false progress line');

    // Up: the start caption goes; the page prepares the first passage.
    await page.evaluate(() => { __host('cmd:narrator_status:'); narrWait('is preparing the first passage', 3, 'Preparing'); });
    s = await look();
    assert(s.caption === 'Preparing · 0 s of ~3 s' && s.dimmed.every(Boolean), 'preparing: its own caption, still dimmed (' + JSON.stringify(s.caption) + ')');
    assert(s.popup === null, 'preparing: no pop-up');

    // Playing: no caption, everything live.
    await page.evaluate(() => narrWaitEnd());
    s = await look();
    assert(s.caption === null && !s.dimmed.some(Boolean), 'playing: no caption, controls live');

    // Catching up: said, but Pause and the rest still work.
    await page.evaluate(() => narrWait('is catching up with the next passage', 0, 'Catching up', false));
    s = await look();
    assert(/^Catching up/.test(s.caption) && !s.dimmed.some(Boolean), 'catching up: caption, controls live (' + JSON.stringify(s.caption) + ')');
    await page.evaluate(() => narrWaitEnd());

    // Paused.
    await page.evaluate(() => __host('cmd:read_bar:{"paused":true}'));
    s = await look();
    assert(s.caption === 'Paused' && !s.dimmed.some(Boolean), 'paused: "Paused"');
    await page.evaluate(() => __host('cmd:read_bar:{"paused":false}'));

    // A failed start: the bar stays, says so, offers Retry and Close.
    await page.evaluate(() => __host('cmd:narrate_failed:The narrator did not start.'));
    s = await look();
    assert(/Couldn.t start the narrator/.test(s.caption) && s.retry, 'failed: the reason and Retry, on the bar (' + JSON.stringify(s.caption) + ')');
    if (shots) await page.screenshot({ path: path.join(shots, 'caption-failed.png') });
    await page.evaluate(() => { window.__posts = []; document.querySelector('#tzReadBar [data-a="close"]').click(); });
    const closed = await page.evaluate(() => window.__posts.includes('host_tts_stop'));
    assert(closed, 'Close stops the reading (the host then takes the bar down)');

    // Any other pop-up while reading sits above the bar, not on it.
    await page.evaluate(() => { __host('cmd:read_bar:{"show":true}'); showKokoroStatus('Something else to say.'); });
    s = await look();
    assert(s.popup && !s.popupOverBar, 'a pop-up while reading sits above the bar');

    // No reading: the narrator's start-up is a pop-up, as before.
    await page.evaluate(() => { document.getElementById('kokoro-status')?.remove(); __host('cmd:read_bar:{"show":false}'); __host('cmd:narrator_status:Starting the narrator...'); });
    s = await page.evaluate(() => { const p = document.getElementById('kokoro-status'); return p ? p.innerText : null; });
    assert(s === 'Starting the narrator...', 'with no reading, a pop-up as before');
} catch (e) {
    failed++;
    console.error('  FAIL ' + (e && e.stack || e));
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`passed=${passed} failed=${failed}`);
if (failed) { console.log('READ BAR CAPTION FAILED'); process.exit(1); }
console.log('READ BAR CAPTION PASSED');
