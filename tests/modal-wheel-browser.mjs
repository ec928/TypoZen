/**
 * A modal keeps its own wheel, even in Pages mode.
 *
 * The page-turn handler is capture-phase and calls preventDefault, so in Pages mode it
 * claimed every wheel event on the window. The sidebar was excused; the modals were not,
 * so About and Syntax & Shortcuts could not be scrolled with the wheel at all -- the page
 * turned behind them instead. From the outside that looks like a focus bug, which is what
 * makes it hard to place.
 *
 * The assertion is on defaultPrevented rather than on scrollTop: a synthetic wheel event
 * does not perform the browser's default scroll, so watching the panel move would report
 * failure against a working build. Whether the handler CLAIMS the event is exactly the
 * behaviour in question.
 *
 *   node tests/modal-wheel-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    const tpl = path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/');
    await page.goto('file:///' + tpl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    await page.evaluate(() => loadMarkdownContent('# One\n\nalpha\n\n# Two\n\nbeta\n'));
    await sleep(600);

    // Pages mode is the state that arms the page-turn handler. Without it the handler
    // returns early and this suite would pass on a broken build.
    await page.evaluate(() => { state.pageAdvance = true; });
    const armed = await page.evaluate(() => !!state.pageAdvance);
    assert(armed, 'control: the page-turn wheel handler is armed');

    const wheelOver = (selector) => page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { missing: true };
        const ev = new WheelEvent('wheel', {
            deltaY: 120, bubbles: true, cancelable: true, composed: true
        });
        el.dispatchEvent(ev);
        return { prevented: ev.defaultPrevented };
    }, selector);

    // The editor: the handler SHOULD claim this one and turn the page.
    const onEditor = await wheelOver('#editor');
    info('over #editor: ' + JSON.stringify(onEditor));
    assert(onEditor.prevented === true,
        'control: over the document the wheel still turns the page');

    // Every overlay that can scroll its own body.
    for (const id of ['aboutModal', 'helpModal']) {
        await page.evaluate((m) => {
            const el = document.getElementById(m);
            if (el) { el.hidden = false; el.style.display = 'flex'; }
        }, id);
        await sleep(150);
        const res = await wheelOver('#' + id + ' .tz-help-panel');
        info('over #' + id + ': ' + JSON.stringify(res));
        assert(!res.missing, id + ' has a panel to scroll');
        assert(res.prevented === false,
            id + ' keeps its own wheel instead of turning the page behind it');
        await page.evaluate((m) => {
            const el = document.getElementById(m);
            if (el) { el.hidden = true; el.style.display = ''; }
        }, id);
    }

    // The sidebar was already excused; it must stay that way.
    const onSidebar = await wheelOver('#sidebar');
    info('over #sidebar: ' + JSON.stringify(onSidebar));
    assert(onSidebar.prevented === false, 'the sidebar still keeps its own wheel');
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed > 0) { console.error('MODAL WHEEL FAILED'); process.exit(1); }
console.log('MODAL WHEEL PASSED');
