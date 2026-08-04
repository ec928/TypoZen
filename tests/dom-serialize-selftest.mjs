/**
 * DOM serialize tests: blockHtmlToMarkdown must not invent blank lines
 * or collapse separate blocks into one spaced line.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

function extractFunction(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        if (mainScript[i] === '{') depth++;
        else if (mainScript[i] === '}') {
            depth--;
            if (depth === 0) return mainScript.slice(idx, i + 1);
        }
    }
    throw new Error('unclosed ' + name);
}

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>', {
    url: 'https://localapp/test',
    pretendToBeVisual: true
});
const { window } = dom;
const { document } = window;
global.window = window;
global.document = document;
global.Node = window.Node;

const names = [
    'parseListLine', 'formatListLine', 'normalizeBlockRaw', 'isMultilineBlockRaw',
    'coerceBlockRaw', 'listIndentPad', 'stripListMarkerKeepBody', 'stripBlockPrefix'
];
let src = 'const LIST_MAX_INDENT=6; const LIST_INDENT_SPACES=2;\n';
for (const n of names) src += extractFunction(n) + '\n';
src += extractFunction('blockHtmlToMarkdown') + '\n';
src += 'return { ' + names.join(',') + ', blockHtmlToMarkdown };\n';

const api = new Function(src)();

let passed = 0, failed = 0;
function assert(c, m) {
    if (c) { passed++; console.log('  OK  ', m); }
    else { failed++; console.error('  FAIL', m); }
}

console.log('\n=== blockHtmlToMarkdown chrome / blank injection ===');
{
    // Normal paragraph
    const b1 = document.createElement('div');
    b1.className = 'block';
    b1.setAttribute('data-raw', '111');
    b1.innerHTML = '<p>111</p>';
    assert(api.blockHtmlToMarkdown(b1) === '111', 'plain p → 111');

    // Chrome: extra empty div/br siblings (contenteditable junk)
    const b2 = document.createElement('div');
    b2.className = 'block';
    b2.setAttribute('data-raw', '222');
    b2.innerHTML = '<p>222</p><div><br></div><br>';
    const r2 = api.blockHtmlToMarkdown(b2);
    assert(r2 === '222', `p+empty chrome → single line "222" (got ${JSON.stringify(r2)})`);
    assert(!r2.includes('\n'), 'chrome must not inject \\n into data-raw');

    // Ordered list
    const b3 = document.createElement('div');
    b3.className = 'block';
    b3.setAttribute('data-raw', '1. hello');
    b3.setAttribute('data-list-indent', '0');
    b3.innerHTML = '<ol start="1"><li value="1">hello</li></ol>';
    const r3 = api.blockHtmlToMarkdown(b3);
    assert(r3 === '1. hello' || r3.startsWith('1.'), `ol serializes with marker (got ${JSON.stringify(r3)})`);
    assert(!String(r3).includes('\n\n'), 'ol serialize has no blank lines');

    // 10-block document serialize
    const editor = document.getElementById('editor');
    editor.innerHTML = '';
    const nums = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];
    nums.forEach(n => {
        const b = document.createElement('div');
        b.className = 'block';
        b.setAttribute('data-raw', n);
        b.innerHTML = `<p>${n}</p>`;
        editor.appendChild(b);
    });
    const lines = [];
    editor.querySelectorAll('.block').forEach(b => {
        let raw = b.getAttribute('data-raw') || '';
        lines.push(api.coerceBlockRaw(raw));
    });
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    const md = lines.join('\n');
    assert(md.split('\n').length === 10, '10 blocks → 10 lines');
    assert(md === nums.join('\n'), 'exact multi-line source');
    assert(md !== nums.join(' '), 'not space-joined');
}

console.log(`\npassed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
