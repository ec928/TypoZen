/**
 * The narration monitor, for a Windows, online or Kokoro voice: each paragraph reports the text
 * the voice is given -- after the respellings -- with the words changed, the voice and the
 * speed, and nothing at all while the monitor is closed. Headless; the host is a stub.
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
    console.error('MONITOR SPOKEN: deadline');
    try { browser.process().kill('SIGKILL'); } catch (e) {}
    process.exit(3);
}, 40000);
try {
    const page = await browser.newPage();
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof sendTTSPlay === 'function' && typeof window.nlp === 'function', { timeout: 20000 });
    await page.evaluate(() => {
        window.__posts = [];
        window.chrome = window.chrome || {};
        window.chrome.webview = window.chrome.webview || {};
        window.chrome.webview.postMessage = (m) => { window.__posts.push(String(m)); };
        window.setReadBar('{"show":false,"voice":"Windows: Microsoft Hazel","speed":1.25}');
    });
    const monitorPosts = () => page.evaluate(() => window.__posts.filter(p => p.startsWith('host_narr_monitor:')).map(p => JSON.parse(p.substring(18))));
    const line = 'The Harkonnen army came at dawn. She lives by the sea and works in the town.';

    await page.evaluate((l) => { window.setNarrMonitor(false); sendTTSPlay(l); }, line);
    assert((await monitorPosts()).length === 0, 'nothing is reported while the monitor is closed');

    await page.evaluate((l) => { window.setNarrMonitor(true); window.__posts = []; sendTTSPlay(l); }, line);
    const m = (await monitorPosts())[0];
    assert(!!m, 'a paragraph reports itself while the monitor is open');
    const p = m.parts[0];
    const played = await page.evaluate(() => {
        const s = window.__posts.find(x => x.startsWith('host_tts_play:'));
        return s ? JSON.parse(s.substring(14)).text : '';
    });
    assert(p.text === played, 'the monitor shows exactly the text the voice was given (' + JSON.stringify(p.text) + ')');
    assert(/Har-ko-nen/.test(p.text) && /livz/.test(p.text), 'the respellings are in it');
    assert(p.changes.includes('Harkonnen → Har-ko-nen') && p.changes.some(c => /^lives → livz$/.test(c)),
        'and each word changed is listed (' + JSON.stringify(p.changes) + ')');
    assert(m.settings.engine === 'voice' && m.settings.voice === 'Windows: Microsoft Hazel' && m.settings.speed === 1.25,
        'with the voice and the speed (' + JSON.stringify(m.settings) + ')');

    await page.evaluate(() => { window.__posts = []; sendTTSPlay('A plain line with nothing to change.'); });
    assert((await monitorPosts())[0].parts[0].changes.length === 0, 'a line nothing changed lists no changes');
} catch (e) {
    failed++;
    console.error('  FAIL ' + (e && e.stack || e));
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`passed=${passed} failed=${failed}`);
if (failed) { console.log('MONITOR SPOKEN FAILED'); process.exit(1); }
console.log('MONITOR SPOKEN PASSED');
