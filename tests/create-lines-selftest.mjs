/**
 * FUNDAMENTAL: creating lines.
 *
 * One visual row = one .block = one Source line separated by \n.
 * If this fails, every multi-select format / bullet test is meaningless.
 *
 * node tests/create-lines-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const htmlFile = fs.readFileSync(templatePath, 'utf8');
const scripts = [...htmlFile.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
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

const pureNames = [
    'parseListLine', 'formatListLine', 'normalizeBlockRaw', 'isMultilineBlockRaw',
    'coerceBlockRaw', 'stripListMarkerKeepBody', 'stripBlockPrefix', 'listIndentPad',
    'getListIndentLevel', 'transformRawForFormat'
];
const pure = new Function(
    'const LIST_MAX_INDENT=6;const LIST_INDENT_SPACES=2;\n' +
    pureNames.map(n => extractFunction(n)).join('\n') +
    `;\nreturn { ${pureNames.join(', ')} };`
)();

let passed = 0, failed = 0;
function assert(c, m) {
    if (c) { passed++; console.log('  OK  ', m); }
    else { failed++; console.error('  FAIL', m); }
}

console.log('\n=== FUNDAMENTAL: 10 createBlock rows → 10 source lines ===');
{
    const dom = new JSDOM('<!DOCTYPE html><div id="editor" contenteditable="true"></div>');
    const { document } = dom.window;
    const editor = document.getElementById('editor');
    const nums = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];
    nums.forEach(function (raw) {
        const b = document.createElement('div');
        b.className = 'block';
        b.setAttribute('data-raw', pure.coerceBlockRaw(raw));
        b.innerHTML = '<p>' + raw + '</p>';
        editor.appendChild(b);
    });

    function getMarkdownContentLikeProd() {
        const blocks = editor.querySelectorAll('.block');
        const lines = [];
        blocks.forEach(function (b) {
            let raw = b.hasAttribute('data-raw') ? b.getAttribute('data-raw') : '';
            raw = pure.coerceBlockRaw(raw);
            lines.push(raw);
        });
        while (lines.length > 1 && !String(lines[lines.length - 1]).trim()) lines.pop();
        return lines.join('\n');
    }

    const md = getMarkdownContentLikeProd();
    const mdLines = md.split('\n');
    assert(editor.querySelectorAll('.block').length === 10, '10 .block elements');
    assert(mdLines.length === 10, 'Source has 10 lines (got ' + mdLines.length + ': ' + JSON.stringify(md) + ')');
    assert(mdLines[0] === '111' && mdLines[9] === '100', 'first/last content preserved');
    assert(!md.includes('111222'), 'NOT concatenated without separators');
    assert(!md.includes('111 222 333') || md.split('\n').length === 10,
        'NOT space-collapsed into fewer lines');
    assert(md === nums.join('\n'), 'exact join with \\n');
}

console.log('\n=== FUNDAMENTAL: browser soft-break in ONE .block must expand ===');
{
    // Chrome Enter-without-handler injects sibling <div>s inside one .block
    const dom = new JSDOM('<!DOCTYPE html><div id="editor" contenteditable="true"></div>');
    const { document } = dom.window;
    const editor = document.getElementById('editor');
    const block = document.createElement('div');
    block.className = 'block';
    block.setAttribute('data-raw', '111'); // stale — DOM has more
    block.innerHTML = '<div>111</div><div>222</div><div>333</div>';
    editor.appendChild(block);

    // Production collectVisualLineTexts + expand logic (mirror)
    function collectVisualLineTexts(b) {
        const children = Array.prototype.slice.call(b.children || []);
        if (children.length > 1) {
            return children.map(function (ch) {
                const tag = (ch.tagName || '').toLowerCase();
                if (tag === 'br') return '';
                return String(ch.innerText || ch.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .replace(/\n+/g, ' ')
                    .trim();
            });
        }
        return [b.getAttribute('data-raw') || ''];
    }

    const pieces = collectVisualLineTexts(block);
    assert(pieces.length === 3, 'detect 3 visual lines in fragmented block (got ' + pieces.length + ')');
    assert(pieces[0] === '111' && pieces[1] === '222' && pieces[2] === '333',
        'pieces are 111,222,333');

    // Expand like production
    block.setAttribute('data-raw', pure.coerceBlockRaw(pieces[0]));
    block.innerHTML = '<p>' + pieces[0] + '</p>';
    let prev = block;
    for (let i = 1; i < pieces.length; i++) {
        const nb = document.createElement('div');
        nb.className = 'block';
        nb.setAttribute('data-raw', pure.coerceBlockRaw(pieces[i]));
        nb.innerHTML = '<p>' + pieces[i] + '</p>';
        editor.insertBefore(nb, prev.nextSibling);
        prev = nb;
    }

    assert(editor.querySelectorAll('.block').length === 3, 'expanded to 3 .blocks');
    const lines = [...editor.querySelectorAll('.block')].map(b => b.getAttribute('data-raw'));
    assert(lines.join('\n') === '111\n222\n333', 'Source after expand is 3 lines');
    assert(lines.join('\n') !== '111222333', 'source is not one glued string');
    assert(lines[0] === '111' && lines[1] === '222' && lines[2] === '333', 'each line separate');
}

console.log('\n=== FUNDAMENTAL: coerce must not eat newlines into no-space glue ===');
{
    // coerce collapses multi-line single-block with spaces (not empty join)
    const c = pure.coerceBlockRaw('aaa\nbbb\nccc');
    assert(c === 'aaa bbb ccc', 'coerce joins with spaces not empty (got ' + JSON.stringify(c) + ')');
    assert(c !== 'aaabbbccc', 'coerce must NEVER produce aaabbbccc');
}

console.log('\n=== Template contracts for line creation ===');
{
    assert(mainScript.includes('handleEnterAtBlock'), 'handleEnterAtBlock present');
    assert(mainScript.includes('onEditorEnterCapture') || mainScript.includes('Enter always creates'),
        'editor-level Enter capture present');
    assert(mainScript.includes('expandFragmentedBlock'), 'expandFragmentedBlock present');
    assert(mainScript.includes('collectVisualLineTexts'), 'collectVisualLineTexts present');
    assert(mainScript.includes('expandAllFragmentedBlocks'), 'expandAllFragmentedBlocks present');
}

console.log(`\npassed=${passed} failed=${failed}`);
if (failed) {
    console.error('\nCREATE-LINES FUNDAMENTAL SELFTEST FAILED');
    process.exit(1);
}
console.log('\nCREATE-LINES FUNDAMENTAL SELFTEST PASSED');
process.exit(0);
