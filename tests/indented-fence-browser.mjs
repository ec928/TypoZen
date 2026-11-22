/**
 * A code fence indented by up to three spaces is a code block in Preview, as in Markdown and
 * in Source (2026-11-22).
 *
 * Preview took a fence only in column 0. A code block in a list item ("- step" then
 * "  ```js") showed as one paragraph per code line, and Heading on one of them made it a
 * heading where Source, knowing it was code, did nothing. A closing fence indented by one
 * to three spaces ("   ```") was missed, so the block ran on into the text after it. The code
 * lines are drawn and saved as written, indent and all. A line that only starts with
 * backticks and has more after them ("```` ```css ```` and") is inline code, not a fence.
 *
 *   node tests/indented-fence-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (60 s)'); process.exit(1); }, 60000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++; console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}
const B = '```';
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const view = (md) => page.evaluate(async (m) => {
        setSourceDocExt('md'); handleCommand('view_set:mode:wysiwyg'); loadMarkdownContent(m);
        await new Promise(r => setTimeout(r, 120));
        return { blocks: [...document.querySelectorAll('#editor .block')].map(b => (b.firstElementChild || b).tagName + ':' + b.innerText), saved: getMarkdownContent(false) };
    }, md);

    let md = '- Ensure it:\n  ' + B + 'csharp\n  if (a)\n      run();\n  ' + B + '\nAfter';
    let v = await view(md);
    same('a fence in a list item is one code block', v.blocks.join(' | '), 'UL:Ensure it: | PRE:  if (a)\n      run(); | P:After');
    same('and saves exactly', v.saved, md);

    md = 'Para\n' + B + '\ncode();\n   ' + B + '\nAfter';
    v = await view(md);
    same('a closing fence indented by three spaces ends the block', v.blocks.join(' | '), 'P:Para | PRE:code(); | P:After');
    same('and saves exactly', v.saved, md);

    md = 'Intro\n  ```` ```css ```` and more\nEnd';
    v = await view(md);
    same('backticks with more backticks after them are inline code, not a fence', v.blocks.length, 3);
    same('and save exactly', v.saved, md);

    md = 'Top\n\n    ' + B + '\nnot code\n    ' + B;
    v = await view(md);
    same('four spaces is not a fence', v.blocks.some(b => b.startsWith('PRE:')), false);

    // Heading on a line of indented code: Preview and Source both leave it alone.
    md = '- step\n  ' + B + '\n  int slot = 1;\n  ' + B + '\nEnd';
    const out = await page.evaluate(async (m) => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        handleCommand('view_set:mode:source'); loadMarkdownContent(m); await wait(150);
        const off = m.indexOf('int slot');
        sourceEditor.focus(); sourceEditor.setSelectionRange(off, off);
        freezeFormatSelection(); applyFormatting('h2'); await wait(80);
        const src = sourceEditor.value.replace(/\n+$/, '');
        handleCommand('view_set:mode:wysiwyg'); loadMarkdownContent(m); await wait(150);
        const code = document.querySelector('#editor pre code');
        const t = code.firstChild; const r = document.createRange(); r.setStart(t, 4); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        freezeFormatSelection(); applyFormatting('h2'); await wait(80);
        return { src, preview: getMarkdownContent(false).replace(/\n+$/, '') };
    }, md);
    same('Heading on a code line: Preview gives what Source gives', out.preview, out.src);
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
