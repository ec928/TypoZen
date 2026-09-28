/**
 * Source hands the host exactly the text a <textarea> would.
 *
 * docs/archive/codemirror-source-plan.md, section 5.1: Source is moving from a textarea to
 * CodeMirror, and the host's save path reads Source's text directly
 * (FetchDocumentStateBlocking in TypoZen_App.cs, reproduced below as HOST_READ). A
 * difference of one byte there is a changed file on disk.
 *
 * The reference is a plain textarea created in the same page: whatever Source is built
 * on, it must give back what that textarea gives back for the same input -- the text,
 * the "unsaved" flag the host reads with it, and the text after an edit is made and
 * undone by hand. Nothing here asserts what the right normalisation IS; only that Source
 * does not differ from a textarea -- the control Source replaced, and the behaviour the
 * host's save path was written against.
 *
 *   node tests/source-roundtrip-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg, detail) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + (detail ? '   ' + detail : '')); }
}
function info(msg) { console.log('  ..   ' + msg); }

const CORPUS = [
    ['empty', ''],
    ['one line, no final newline', 'hello'],
    ['only newlines', '\n\n\n'],
    ['CRLF', 'first\r\nsecond\r\n'],
    ['lone CR', 'first\rsecond'],
    ['mixed endings', 'a\r\nb\nc\rd\n'],
    ['BOM', '﻿# Title\n\nBody\n'],
    ['tabs and trailing spaces', '\tindented  \n  \t\nhard break  \nend'],
    ['NUL', 'a\u0000b\n'],
    ['lone surrogates', 'x\uD800y\uDC00z\n'],
    ['emoji ZWJ sequence', '👩‍👩‍👧 family\n'],
    ['line and paragraph separators', 'a b c\n'],
    ['100,000-character line', 'w'.repeat(100000) + '\n'],
    ['Markdown with markers', '# H\n\n- a\n  - b\n\n> q\n\n```js\nconst x = 1;\n```\n\n**b** *i* [l](u)\n']
];

// FetchDocumentStateBlocking's script, as the host sends it.
const HOST_READ = "(function(){ try {" +
    "  if (state && state.mode === 'source' && sourceEditor) {" +
    "    var c = sourceEditor.value || '';" +
    "    return (c !== state.lastSavedContent ? '1' : '0') + c;" +
    "  }" +
    "  return getDocumentStateTagged();" +
    "} catch(e) { try { return getMarkdownContent(false); } catch(e2) { return null; } } })()";

const show = (s) => JSON.stringify(s == null ? s : (s.length > 60 ? s.slice(0, 60) + '...(' + s.length + ')' : s));

const deadline = setTimeout(() => { console.error('DEADLINE'); process.exit(3); }, 60000);
const browser = await puppeteer.launch({ headless: 'new' });
try {
  for (const engine of ['codemirror']) {
    console.log('\n##### Source on ' + engine + ' #####');
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && typeof finishLoadContent === 'function', { timeout: 15000 });
    assert(await page.evaluate(() => !!document.querySelector('#source-cm .cm-editor')), 'Source is CodeMirror, mounted in #source-cm');

    for (const [name, text] of CORPUS) {
        console.log('=== ' + name + ' ===');
        const r = await page.evaluate((text, hostRead) => {
            const ref = document.createElement('textarea');
            ref.value = text;
            const expected = ref.value;
            // A plain file: the host's forcePlain load, straight into Source.
            finishLoadContent(text, false, true);
            const mode = state.mode;
            const tagged = (0, eval)(hostRead);
            // An edit made and taken back by hand leaves the text as it was.
            const before = sourceEditor.value;
            const end = before.length;
            sourceEditor.setRangeText('X', end, end, 'end');
            const withX = sourceEditor.value;
            sourceEditor.setRangeText('', end, end + 1, 'end');
            const after = sourceEditor.value;
            return {
                mode, expected, value: before,
                flag: tagged == null ? null : tagged.charAt(0),
                hostText: tagged == null ? null : tagged.slice(1),
                refFlag: expected !== text ? '1' : '0',
                editOk: withX === before + 'X', after
            };
        }, text, HOST_READ);
        assert(r.mode === 'source', 'opens in Source');
        assert(r.value === r.expected, 'Source text equals the textarea\'s', show(r.value) + ' vs ' + show(r.expected));
        assert(r.hostText === r.expected, 'the host\'s save read returns that text', show(r.hostText));
        assert(r.flag === r.refFlag, 'the unsaved flag is the textarea\'s (' + r.refFlag + ')', 'got ' + r.flag);
        // The host turns CRLF into LF before a file reaches the page (TypoZen_App.cs, load
        // path) and back on save, so only a lone CR can get this far in the app.
        if (r.refFlag === '1') info('a textarea rewrites this input, so the page alone would flag it unsaved');
        assert(r.editOk && r.after === r.value, 'an edit made and removed leaves the text byte for byte');
    }

    // A Markdown document shown in Source: Source holds what the mode switch serialises
    // (getMarkdownContent -- which keeps a final newline DocumentModel.toMarkdown() drops).
    console.log('=== Markdown document switched to Source ===');
    const md = CORPUS[CORPUS.length - 1][1];
    await page.evaluate((m) => { finishLoadContent(m, false, false); handleCommand('view_set:mode:source'); }, md);
    await page.waitForFunction(() => state.mode === 'source', { timeout: 5000 });
    const m = await page.evaluate((hostRead) => {
        const ref = document.createElement('textarea');
        ref.value = getMarkdownContent(false, { flushActive: false });
        const tagged = (0, eval)(hostRead);
        return { expected: ref.value, value: sourceEditor.value, hostText: tagged == null ? null : tagged.slice(1) };
    }, HOST_READ);
    assert(m.value === m.expected, 'Source text equals the document\'s Markdown through a textarea', show(m.value) + ' vs ' + show(m.expected));
    assert(m.hostText === m.expected, 'the host\'s save read returns that text');
    await page.close();
  }
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) process.exitCode = 1;
else console.log('SOURCE ROUNDTRIP PASSED');
