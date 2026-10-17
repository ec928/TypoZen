/**
 * A link or picture and emphasis in the same paragraph: Preview shows them right, and typing
 * in the paragraph saves the Markdown unchanged around the edit. Headless; presses keys.
 *
 * 2026-10-17: emphasis ran over the finished link HTML, so the underscore of target="_blank"
 * opened an _italic_ later in the paragraph. Preview showed `blank">the docs`, and typing one
 * letter in the paragraph saved "See [blank\">the docs](https://x.y/z) and _soft text.".
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

// [markdown line, the text Preview should show]
const cases = [
    ['See [the docs](https://x.y/z) and _soft_ text.', 'See the docs and soft text.'],
    ['See [the docs](https://x.y/z) and *soft* text.', 'See the docs and soft text.'],
    ['A [link](https://a.b/_x_/*y*) and __strong__ here.', 'A link and strong here.'],
    ['A [**bold** label](https://a.b) and _soft_ words.', 'A bold label and soft words.'],
    ['_A whole [linked](https://a.b) phrase_ in italics.', 'A whole linked phrase in italics.'],
    ['Two [one](https://a.b) and [two_too](https://c.d/e_f) with _it_ and ___both___.', 'Two one and two_too with it and both.'],
    ['An ![alt_with_underscores](https://img.example/p_q.png) and _soft_ end.', 'An and soft end.'],
    ['Code `a_b_c` and [x](https://y.z) and _soft_.', 'Code a_b_c and x and soft.']
];

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
const deadline = setTimeout(() => {
    console.error('LINK EMPHASIS: deadline');
    try { browser.process().kill('SIGKILL'); } catch (e) {}
    process.exit(3);
}, 60000);
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof finishLoadContent === 'function', { timeout: 15000 });
    for (const [line, shown] of cases) {
        await page.evaluate((l) => {
            setSourceDocExt('md');
            if (state.mode !== 'preview') handleCommand('view_set:mode:preview');
            finishLoadContent('# Title\n\n' + l + '\n', false, false);
        }, line);
        await new Promise(r => setTimeout(r, 200));
        const got = await page.evaluate(() => {
            const b = [...document.querySelectorAll('#editor .block')].filter(x => x.innerText.trim())[1];
            return { text: b.innerText.replace(/\s+/g, ' ').trim(), links: [...b.querySelectorAll('a')].map(a => a.getAttribute('target') + '|' + a.getAttribute('href')) };
        });
        assert(got.text === shown && got.links.every(l => l.startsWith('_blank|http')),
            'shows ' + JSON.stringify(line) + ' as ' + JSON.stringify(got.text));
        // Type a letter at the end of the paragraph, as a writer would.
        const at = await page.evaluate(() => {
            const r = [...document.querySelectorAll('#editor .block')].filter(x => x.innerText.trim())[1].getBoundingClientRect();
            return { x: r.right - 3, y: r.top + r.height / 2 };
        });
        await page.mouse.click(at.x, at.y);
        await page.keyboard.press('End');
        await page.keyboard.type('Z');
        await new Promise(r => setTimeout(r, 250));
        const saved = await page.evaluate(() => DocumentModel.toMarkdown());
        assert(saved.includes(line + 'Z'), 'an edit keeps the Markdown (' + JSON.stringify(saved.split('\n')[2]) + ')');
    }
} catch (e) {
    failed++;
    console.error('  FAIL ' + (e && e.stack || e));
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`passed=${passed} failed=${failed}`);
if (failed) { console.log('LINK EMPHASIS FAILED'); process.exit(1); }
console.log('LINK EMPHASIS PASSED');
