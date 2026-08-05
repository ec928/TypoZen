/**
 * Pasted code keeps its fence, its indentation, and its plain keywords.
 *
 * Almost nothing puts code on a clipboard as <pre><code>. An editor or a chat page emits
 * one styled <div> per line with a coloured <span> per token, and some of those spans are
 * bold -- so a pasted function arrived as prose with its indentation collapsed and its
 * keywords turned into **def** and **return**. The fence was never lost; nothing had ever
 * said "code" except the font.
 *
 * Run in a real browser because the converter is DOMParser and inline styles: jsdom would
 * be asserting against a different implementation of the thing under test.
 *
 *   node tests/paste-code-browser.mjs
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

const MONO = 'font-family: Consolas, monospace';

const CASES = [
    {
        name: 'a <pre><code> block stays a fence',
        html: '<pre><code>def foo():\n    return 1</code></pre>',
        want: '```\ndef foo():\n    return 1\n```'
    },
    {
        name: 'a bare <pre> stays a fence',
        html: '<pre>def foo():\n    return 1</pre>',
        want: '```\ndef foo():\n    return 1\n```'
    },
    {
        name: 'styled lines with coloured, bold tokens become one fence',
        html: '<div style="' + MONO + '"><span style="color:#569cd6;font-weight:600">def</span> ' +
              '<span style="color:#dcdcaa">foo</span>():</div>' +
              '<div style="' + MONO + '">    <span style="color:#c586c0;font-weight:700">return</span> 1</div>',
        want: '```\ndef foo():\n    return 1\n```'
    },
    {
        name: 'consecutive monospace paragraphs are one fence, not two paragraphs',
        html: '<p style="font-family: monospace">git status</p>' +
              '<p style="font-family: monospace">git commit</p>',
        want: '```\ngit status\ngit commit\n```'
    },
    {
        name: 'snippets separated by prose stay separate',
        html: '<div style="font-family: monospace">one</div><p>Text between.</p>' +
              '<div style="font-family: monospace">two</div>',
        want: '```\none\n```\n\nText between.\n\n```\ntwo\n```'
    },
    {
        name: 'a monospaced run inside a sentence is inline code',
        html: '<p>Run <span style="' + MONO + '">npm test</span> first.</p>',
        want: 'Run `npm test` first.'
    },
    {
        name: '<code> in prose is still inline code',
        html: '<p>Run <code>npm test</code> first.</p>',
        want: 'Run `npm test` first.'
    },
    {
        name: 'prose that opts back out of a monospace wrapper stays prose',
        html: '<div style="font-family: monospace">' +
              '<p style="font-family: Georgia, serif">Ordinary prose here.</p></div>',
        want: 'Ordinary prose here.'
    },
    {
        name: 'emphasis in ordinary prose survives all of this',
        html: '<p>Really <span style="font-weight:700">important</span> point.</p>',
        want: 'Really **important** point.'
    }
];

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/');
    await page.goto(url, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 1500));

    const got = await page.evaluate((cases) => cases.map(c => htmlToMarkdown(c.html)), CASES);

    for (let i = 0; i < CASES.length; i++) {
        assert(got[i] === CASES[i].want,
            CASES[i].name + (got[i] === CASES[i].want ? '' :
                ' (got ' + JSON.stringify(got[i]) + ', wanted ' + JSON.stringify(CASES[i].want) + ')'));
    }
} finally {
    await browser.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'PASTE CODE FAILED' : 'PASTE CODE PASSED');
process.exit(failed ? 1 : 0);
