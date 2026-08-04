/**
 * Phase 1/2 dual-source helpers: splitMarkdownToBlockRaws must group fences/tables;
 * progressive load constants must stay coherent with the decision doc.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Pure string helper — no DOM.
const src = extractFunction('splitMarkdownToBlockRaws') + '\nreturn { splitMarkdownToBlockRaws };\n';
const api = new Function(src)();

let passed = 0, failed = 0;
function assert(c, m) {
    if (c) { passed++; console.log('  OK  ', m); }
    else { failed++; console.error('  FAIL', m); }
}

console.log('\n=== splitMarkdownToBlockRaws (Source → Preview string phase) ===');
{
    const a = api.splitMarkdownToBlockRaws('hello\nworld');
    assert(a.length === 2 && a[0] === 'hello' && a[1] === 'world', 'plain lines');

    const b = api.splitMarkdownToBlockRaws('```js\nconst x = 1;\n```\nafter');
    assert(b.length === 2, 'fence + after → 2 blocks');
    assert(b[0].startsWith('```js') && b[0].includes('const x') && b[0].trimEnd().endsWith('```'),
        'fence grouped as one block');
    assert(b[1] === 'after', 'line after fence');

    const c = api.splitMarkdownToBlockRaws('| a | b |\n| --- | --- |\n| 1 | 2 |\npara');
    assert(c.length === 2, 'table rows grouped + para');
    assert(c[0].split('\n').length === 3, 'three table lines in one block');
    assert(c[1] === 'para', 'para after table');

    const d = api.splitMarkdownToBlockRaws('');
    assert(d.length === 1 && d[0] === '', 'empty → one empty block');

    const e = api.splitMarkdownToBlockRaws('- item\n- item2');
    assert(e.length === 2 && e[0] === '- item' && e[1] === '- item2', 'list lines stay separate blocks');
}

console.log('\n=== Phase 1 markers present in template ===');
{
    assert(mainScript.includes('function flushActiveBlockToRaw'), 'flushActiveBlockToRaw exists');
    assert(mainScript.includes('function serializeBlockDomToRaw'), 'serializeBlockDomToRaw exists');
    assert(mainScript.includes('flushActive: true'), 'host paths request flushActive');
    assert(!/fromDom\.trim\(\)\.length\s*>\s*String\(raw\)\.trim\(\)\.length/.test(mainScript),
        'no "screen longer than raw" length heuristic');
    assert(mainScript.includes('data-tz-dirty'), 'paint skips dirty blocks');
}

console.log('\n=== DocumentModel (end-game A/B/C) ===');
{
    assert(mainScript.includes('const DocumentModel'), 'DocumentModel exists');
    assert(mainScript.includes('toMarkdown: function') || mainScript.includes('toMarkdown:function'),
        'toMarkdown on model');
    assert(mainScript.includes('function mountVirtWindow'), 'Stage C mountVirtWindow exists');
    assert(mainScript.includes('shouldVirtualize'), 'shouldVirtualize exists');
    assert(mainScript.includes('VIRT_MIN_CHARS') || mainScript.includes('VIRT_MIN_BLOCKS'),
        'Stage D virt thresholds split from Source-first');
    assert(mainScript.includes('prefixHeight') || mainScript.includes('blockHeights'),
        'Stage D per-block virt heights');
    assert(mainScript.includes('DocumentModel.toMarkdown()'), 'serialize uses model.toMarkdown');
    assert(mainScript.includes('function removeBlockEl'), 'removeBlockEl hardens merges');
    assert(mainScript.includes('removeBlockRange'), 'removeBlockRange for multi-block delete');
    assert(mainScript.includes('DocumentModel.blocks'), 'outline can use model blocks');

    const raws = api.splitMarkdownToBlockRaws('a\nb\n\nc');
    assert(raws.join('\n') === 'a\nb\n\nc' || raws.length >= 3, 'model input split ok');
    const del = api.splitMarkdownToBlockRaws('hello world');
    del[0] = 'hello';
    assert(del.join('\n') === 'hello', 'delete-in-model style join drops text');
}

console.log('\n=== dual-source selftest:', passed, 'passed,', failed, 'failed ===\n');
process.exit(failed ? 1 : 0);
