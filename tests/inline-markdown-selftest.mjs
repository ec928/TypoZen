/**
 * Self-test: inline markdown rendering + round-trip safety.
 *
 * Guards three regressions:
 *   1. Intraword underscores (snake_case, MAX_BUFFER_SIZE) must never become <em>.
 *      They used to, and blockHtmlToMarkdown then wrote "some*var*name" back to disk.
 *   2. Code span bodies must stay literal — no emphasis/link parsing inside backticks.
 *   3. Images must render as <img> (the link rule used to consume "![alt](src)" first),
 *      and no markdown URL may inject an HTML attribute or a script-bearing scheme.
 *
 * node tests/inline-markdown-selftest.mjs
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
if (!mainScript || mainScript.length < 10000) {
    console.error('FAIL: could not extract main editor script from template');
    process.exit(1);
}

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="editor"></div></body></html>', {
    url: 'https://localapp/TypoZen_Template_Test.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.Node = window.Node;
global.Element = window.Element;
global.HTMLElement = window.HTMLElement;

function extractFunction(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        const c = mainScript[i];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return mainScript.slice(idx, i + 1);
    }
    throw new Error('unclosed function ' + name);
}

const names = [
    'escapeHtml', 'safeUrl', 'parseInline', 'renderMarkdownTable', 'renderBlockPreview',
    'isThematicBreakLine',
    'clearListIndentClasses', 'setBlockListIndentAttr', 'parseListLine', 'formatListLine',
    'listIndentPad', 'coerceBlockRaw', 'normalizeBlockRaw', 'isMultilineBlockRaw', 'isInlineUnmarkableRaw',
    'blockHtmlToMarkdown', 'isListLine', 'getListIndentLevel',
    'plainRangeToRawOffsets', 'plainAndMarksFromMarkdown',
    'emitInlineMarkdownFromMarks', 'applyInlineFormatToRaw', 'applyMarksModelToBody', 'applyInlineFormatRest',
    'splitInlineFormatPrefix', 'stripListMarkerKeepBody', 'stripBlockPrefix', 'wholeLineInlineFormat',
    'transformRawForFormat', 'markRangeInLine', 'inlineMarksForSelectedLines', 'splitRawForBlockFormat',
    'boldAcrossLines', 'boldMarkersIn', 'withBoldAcross', 'splitLinkTitle', 'keptSourceAttr', 'blockDomToMarkdown', 'blockDomRebuild', 'applyEditToRaw', 'calloutTypeOfRaw',
    'parseTableMarkdown', 'splitTableRow', 'formatTableKeeping', 'formatTableMarkdown', 'tableAlignToSep'
];
// parseInline consults the image cache and kicks off byte requests; provide both so the
// extracted functions run standalone.
let src = 'const LIST_MAX_INDENT = 6; const LIST_INDENT_SPACES = 2;\n'
    + 'const _tzImageData = {};\n'
    + 'let _pendingLink = null;\n'
    + 'let _mbSelFreeze = null;\n'
    + 'function tzRequestPendingImages() {}\n'
    + 'function queueCalloutRestyle() {}\n'
    + 'const ALERT_ICONS = {};\n'
    + 'const BOLD_LOOK_LINES = 12;\n'
    + 'const CALLOUT_RE = /^>\\s*\\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\\]/i;\n';
for (const n of names) src += extractFunction(n) + '\n';
src += 'return {' + names.join(',') + ', setPendingLink: function (v) { _pendingLink = v; }, setMbFreeze: function (v) { _mbSelFreeze = v; }};';
const api = new Function('window', 'document', 'Node', src)(window, window.document, window.Node);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function renderEq(input, expected, msg) {
    const got = api.parseInline(input);
    if (got === expected) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        console.error('        in  : ' + JSON.stringify(input));
        console.error('        want: ' + JSON.stringify(expected));
        console.error('        got : ' + JSON.stringify(got));
    }
}
function renderHas(input, needle, msg) {
    assert(api.parseInline(input).indexOf(needle) >= 0, msg);
}
function renderLacks(input, needle, msg) {
    assert(api.parseInline(input).indexOf(needle) < 0, msg);
}

console.log('--- intraword underscores stay literal ---');
renderEq('call some_var_name here', 'call some_var_name here', 'snake_case untouched');
renderEq('MAX_BUFFER_SIZE and MIN_BUFFER_SIZE', 'MAX_BUFFER_SIZE and MIN_BUFFER_SIZE', 'SCREAMING_SNAKE untouched');
renderEq('C:\\path\\to_file and _leading', 'C:\\path\\to_file and _leading', 'path + dangling underscore untouched');
renderEq('a__b__c', 'a__b__c', 'intraword __ untouched');

console.log('--- code spans stay literal ---');
renderEq('a `code_with_underscore` b', 'a <code>code_with_underscore</code> b', 'no <em> inside code span');
renderEq('use `**not bold**` here', 'use <code>**not bold**</code> here', 'no <strong> inside code span');
renderEq('`[not](a link)`', '<code>[not](a link)</code>', 'no link inside code span');
renderEq('`a < b && c > d`', '<code>a &lt; b &amp;&amp; c &gt; d</code>', 'code body still escaped');

console.log('--- emphasis still works ---');
renderEq('use **bold** and *em*', 'use <strong>bold</strong> and <em>em</em>', 'bold + italic');
// data-mark="u" records that the author typed underscores, so the serializer can put
// underscores back instead of normalising them to asterisks.
renderEq('_real italic_ here', '<em data-mark="u">real italic</em> here', 'standalone _italic_');
renderEq('__real bold__ here', '<strong data-mark="u">real bold</strong> here', 'standalone __bold__');
renderEq('***all three***', '<strong><em>all three</em></strong>', 'triple asterisk');
renderEq('_a_ _b_', '<em data-mark="u">a</em> <em data-mark="u">b</em>', 'two adjacent italics');
renderEq('math: 2 * 3 = 6 and 4 * 5 = 20', 'math: 2 * 3 = 6 and 4 * 5 = 20', 'spaced asterisks stay literal');

console.log('--- strikethrough (GFM ~~) ---');
renderEq('done ~~old text~~ now', 'done <del>old text</del> now', '~~strikethrough~~ renders as <del>');
renderEq('~~a *b* c~~', '<del>a <em>b</em> c</del>', 'emphasis nests inside strike');
renderEq('keep ~~pair~~ intact', 'keep <del>pair</del> intact', 'simple strike');

console.log('--- images render as images ---');
// Relative image paths are relative to the DOCUMENT, but the page is served from
// https://localapp/ (the app folder). The host maps the document's folder to
// https://docfolder/, so display goes through that while data-src keeps the authored
// path — otherwise serializing back would bake an absolute URL into the markdown.
renderHas('![alt text](pic.png)', 'data-pending="1"', 'relative image starts as a placeholder awaiting host bytes');
renderHas('![alt text](pic.png)', 'data-src="pic.png"', 'the authored relative path is preserved');
renderHas('![x](https://example.com/a.png)', '<img src="https://example.com/a.png"', 'absolute image URLs are left alone');
renderLacks('![alt text](pic.png)', '<a href', 'image is not turned into a link');
renderHas('link [site](https://x.com)', '<a href="https://x.com"', 'ordinary link still a link');

console.log('--- url / attribute injection ---');
renderLacks('[click](" onmouseover="alert(1)" x=")', 'onmouseover=', 'quote breakout cannot create an attribute');
renderLacks('[click](javascript:alert(1))', 'javascript:', 'javascript: scheme dropped');
renderLacks('![x](vbscript:alert(1))', 'vbscript:', 'vbscript: scheme dropped');
renderLacks('[a](java\tscript:alert(1))', 'script:', 'whitespace-obfuscated scheme dropped');
renderLacks('<img src=x onerror=alert(1)>', '<img src=x', 'raw HTML is escaped');
renderHas('![i](data:image/png;base64,AAA)', 'src="data:image/png;base64,AAA"', 'data:image kept for <img>');
renderLacks('[i](data:text/html,evil)', 'data:text/html', 'data:text/html dropped for links');

console.log('--- formatting a list line keeps the list line ---');
{
    // Bolding indented numbered rows used to yield "**6. g**": indentation trimmed away
    // and the marker swallowed by the bold, so the line stopped being a list item —
    // nesting lost, numbering restarted, body destroyed by the next re-parse.
    const names2 = ['parseListLine', 'formatListLine', 'listIndentPad', 'isListLine', 'getListIndentLevel',
        'stripListMarkerKeepBody', 'stripBlockPrefix', 'normalizeBlockRaw', 'coerceBlockRaw',
        'isMultilineBlockRaw', 'isInlineUnmarkableRaw', 'splitInlineFormatPrefix', 'transformRawForFormat'];
    let s2 = 'const LIST_MAX_INDENT = 6; const LIST_INDENT_SPACES = 2;\n';
    for (const n of names2) s2 += extractFunction(n) + '\n';
    s2 += 'return {' + names2.join(',') + '};';
    const fmt = new Function(s2)();
    const eqv = (got, want, msg) => assert(got === want, msg + (got === want ? '' : '  -> got ' + JSON.stringify(got)));

    const cases = [
        ['5. vbgb',      'bold',   '5. **vbgb**'],
        ['  6. g',       'bold',   '  6. **g**'],
        ['    7. deep',  'bold',   '    7. **deep**'],
        ['- bullet',     'bold',   '- **bullet**'],
        ['  - nested',   'italic', '  - *nested*'],
        ['- [ ] task',   'bold',   '- [ ] **task**'],
        ['> quoted',     'bold',   '> **quoted**'],
        ['## heading',   'bold',   '## **heading**'],
        ['plain text',   'bold',   '**plain text**'],
        ['  6. g',       'strike', '  6. ~~g~~'],
        ['  6. g',       'code',   '  6. `g`']
    ];
    for (const [input, type, want] of cases) {
        eqv(fmt.transformRawForFormat(input, type, {}), want, type + ' on ' + JSON.stringify(input));
    }

    // and the result must still parse as the same list item
    const out = fmt.transformRawForFormat('  6. g', 'bold', {});
    const p = fmt.parseListLine(out);
    assert(p !== null, 'the formatted line is still a list line');
    assert(p && p.indent === 1, 'indent level is preserved');
    assert(p && p.num === 6, 'the item number is preserved');
    assert(p && p.body === '**g**', 'only the body carries the formatting');

    // toggling off restores the original
    eqv(fmt.transformRawForFormat('  6. **g**', 'bold', {}), '  6. g', 'bold toggles back off');
    // multi-span does not strip outer markers leaving broken middle markers
    eqv(fmt.transformRawForFormat('`a` and `b`', 'code', {}), '`a and b`', 'code merges multi-code-span line');
    eqv(fmt.transformRawForFormat('**a** and **b**', 'bold', {}), '****a** and **b****', 'bold does not unwrap multi-span');
    eqv(fmt.transformRawForFormat('*a* and *b*', 'italic', {}), '**a* and *b**', 'italic does not unwrap multi-span');
    eqv(fmt.transformRawForFormat('~~a~~ and ~~b~~', 'strike', {}), '~~~~a~~ and ~~b~~~~', 'strike does not unwrap multi-span');
}

console.log('--- render -> serialize round trip (the path that writes to disk) ---');
// jsdom has no innerText, so give blockHtmlToMarkdown the textContent fallback the
// browser provides natively. This is what makes the round trip observable in tests.
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
    set(v) { this.textContent = v; },
    configurable: true
});

function roundTrip(md) {
    const block = window.document.createElement('div');
    block.className = 'block';
    block.setAttribute('data-raw', md);
    api.renderBlockPreview(block, md);
    return api.blockHtmlToMarkdown(block);
}
function roundTripEq(md, msg) {
    const got = roundTrip(md);
    if (got === md) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        console.error('        in : ' + JSON.stringify(md));
        console.error('        out: ' + JSON.stringify(got));
    }
}
roundTripEq('call some_var_name here', 'snake_case survives round trip');
roundTripEq('MAX_BUFFER_SIZE and MIN_BUFFER_SIZE', 'SCREAMING_SNAKE survives round trip');
roundTripEq('a `code_with_underscore` b', 'code span survives round trip');
roundTripEq('use **bold** and *em*', 'bold + italic survive round trip');
roundTripEq('![alt text](pic.png)', 'image survives round trip');
roundTripEq('link [site](https://x.com)', 'link survives round trip');
roundTripEq('# Heading with some_snake_case', 'heading + snake_case survives round trip');
roundTripEq('- item with file_name_here.txt', 'list item + snake_case survives round trip');
roundTripEq('math: 2 * 3 = 6 and 4 * 5 = 20', 'spaced asterisks survive round trip');

console.log('--- emphasis markers are preserved, not normalised ---');
// An untouched file must not change on save: _italic_ used to come back as *italic*,
// and ***both*** as **both** (replacing <strong> destroyed the nested <em>).
roundTripEq('_italic_ stays underscored', 'underscore italic keeps its marker');
roundTripEq('__bold__ stays underscored', 'underscore bold keeps its marker');
roundTripEq('*italic* stays starred', 'asterisk italic keeps its marker');
roundTripEq('**bold** stays starred', 'asterisk bold keeps its marker');
roundTripEq('***both at once***', 'triple asterisk survives round trip');
roundTripEq('___both at once___', 'triple underscore survives round trip');
roundTripEq('mixed _under_ and *star* in one line', 'mixed markers each keep their own');
roundTripEq('done ~~old text~~ now', 'strikethrough survives round trip');
roundTripEq('~~nested *em* inside~~', 'strike + nested em survives round trip');
// Nested bold/italic/strike: the path that was dropping ~~ on Preview→Source
roundTripEq('***~~bold italic strike~~***', '***~~…~~*** nested triple survives round trip');
roundTripEq('**~~bold strike~~**', '**~~…~~** bold+strike survives round trip');
roundTripEq('*~~italic strike~~*', '*~~…~~* italic+strike survives round trip');
roundTripEq('~~***outer strike***~~', '~~***…***~~ outer strike survives round trip');
roundTripEq('**bold with *partial* italic**', 'bold containing italic survives round trip');

console.log('--- plainRangeToRawOffsets skips ~~ and *** ---');
{
    const off = api.plainRangeToRawOffsets('***~~hello~~***', 0, 5);
    assert(off.r0 === 5 && off.r1 === 10,
        'plain 0..5 on ***~~hello~~*** maps to raw hello (r0=' + off.r0 + ' r1=' + off.r1 + ')');
    const off2 = api.plainRangeToRawOffsets('**bold**', 0, 4);
    assert(off2.r0 === 2 && off2.r1 === 6,
        'plain 0..4 on **bold** maps past ** (r0=' + off2.r0 + ' r1=' + off2.r1 + ')');
    // literal underscores & spaced asterisks stay literal (not treated as markers)
    const offSnake = api.plainRangeToRawOffsets('call some_var_name **here**', 19, 23);
    assert(offSnake.r0 === 21 && offSnake.r1 === 25 && offSnake.plainLength === 23,
        'snake_case keeps literal underscores (r0=' + offSnake.r0 + ' r1=' + offSnake.r1 + ')');
    const offMath = api.plainRangeToRawOffsets('2 * 3 and **six**', 10, 13);
    assert(offMath.r0 === 12 && offMath.r1 === 15,
        'spaced * stays literal (r0=' + offMath.r0 + ' r1=' + offMath.r1 + ')');
    // safe image renders 0 plain chars
    const offImg = api.plainRangeToRawOffsets('a ![alt](pic.png) **b**', 3, 4);
    assert(offImg.r0 === 20 && offImg.r1 === 21 && offImg.plainLength === 4,
        'image counts as 0 plain chars (r0=' + offImg.r0 + ' r1=' + offImg.r1 + ')');
}

console.log('--- inline code wrapping, expansion, splitting, and toggling ---');
{
    const eqCode = (got, want, msg) => assert(got === want, msg + (got === want ? '' : ' -> got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));

    // Exact README.md line 8 repro: bold at start of block followed by plain text
    const readmeLine = '**Privacy-first and completely free.** There are no accounts.';
    const readmePlainLen = api.plainRangeToRawOffsets(readmeLine, 0, 0).plainLength;
    const readmeCoded = api.applyInlineFormatToRaw(readmeLine, 0, readmePlainLen, 'code');
    eqCode(readmeCoded, '`' + readmeLine + '`', 'README repro includes opening ** inside code span');
    const codedPlainLen = api.plainRangeToRawOffsets(readmeCoded, 0, 0).plainLength;
    eqCode(api.applyInlineFormatToRaw(readmeCoded, 0, codedPlainLen, 'code'), readmeLine, 'toggling code off restores bolded line');

    // Mirror case at end of block
    eqCode(api.applyInlineFormatToRaw('Hello **world**', 0, 11, 'code'), '`Hello **world**`', 'mirror end bold includes closing **');

    // Selecting ONLY inside bold keeps bold outside
    eqCode(api.applyInlineFormatToRaw('**world**', 0, 5, 'code'), '**`world`**', 'strictly inside bold keeps ** outside');
    eqCode(api.applyInlineFormatToRaw('**`world`**', 0, 5, 'code'), '**world**', 'toggling code off inside bold keeps **');

    // Nested link inside bold at start of selection
    eqCode(api.applyInlineFormatToRaw('**[Install](https://x.com)** (Recommended)', 0, 21, 'code'),
        '`**[Install](https://x.com)** (Recommended)`', 'nested bold+link swallows both markers');

    // Partial overlap splits cleanly on both sides
    eqCode(api.applyInlineFormatToRaw('**hello world** and more', 6, 20, 'code'),
        '**hello** `**world** and more`', 'partial overlap at start splits bold cleanly');
    eqCode(api.applyInlineFormatToRaw('more and *hello world*', 0, 14, 'code'),
        '`more and *hello*` *world*', 'partial overlap at end splits italic cleanly');
    eqCode(api.applyInlineFormatToRaw('**~~hello world~~** and more', 6, 20, 'code'),
        '**~~hello~~** `**~~world~~** and more`', 'nested partial overlap keeps LIFO nesting');
    eqCode(api.applyInlineFormatToRaw('see [hello world](https://x.com) tail', 10, 20, 'code'),
        'see [hello](https://x.com) `[world](https://x.com) tail`', 'partial overlap across link keeps valid links');

    // Existing code spans inside/crossing selection
    eqCode(api.applyInlineFormatToRaw('opens `.md`, `.txt` and PDF', 0, 23, 'code'),
        '`opens .md, .txt and PDF`', 'existing code spans merge cleanly');
    eqCode(api.applyInlineFormatToRaw('`.md`, `.txt` and PDF', 0, 17, 'code'),
        '`.md, .txt and PDF`', 'selection starting inside code span includes opening backtick');
    eqCode(api.applyInlineFormatToRaw('`foo` and `bar`', 0, 11, 'code'),
        '`foo and bar`', 'multi-code-span selection merges instead of inverting');
    eqCode(api.applyInlineFormatToRaw('`hello world`', 6, 11, 'code'),
        '`hello` world', 'tail sub-selection inside code span un-codes cleanly');
    eqCode(api.applyInlineFormatToRaw('`hello world`', 0, 5, 'code'),
        'hello `world`', 'head sub-selection inside code span un-codes cleanly');
    eqCode(api.applyInlineFormatToRaw('`hello world`', 3, 3, 'code'),
        null, 'collapsed caret inside code span is a no-op');

    // Multi-line table/fence rejected; closed ATX heading preserves suffix
    eqCode(api.applyInlineFormatToRaw('| a | b |\n|---|---|\n| c | d |', 0, 3, 'code'),
        null, 'multi-line raw returns null');
    eqCode(api.applyInlineFormatToRaw('## **Title** rest ##', 0, 10, 'code'),
        '## `**Title** rest` ##', 'closed ATX heading preserves closing ##');
}

console.log('--- applyInlineFormatToRaw nested toggle (mark model) ---');
{
    function marksOf(raw) {
        const body = raw.replace(/^(#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]?\]\s+)?|\d+\.\s+)/, '');
        return api.plainAndMarksFromMarkdown(body);
    }
    function flagAt(pm, i, flag) {
        return !!(pm.marks[i] && pm.marks[i][flag]);
    }
    // strike on bold+italic
    let r = api.applyInlineFormatToRaw('***hello***', 0, 5, 'strike');
    let pm = marksOf(r);
    assert(pm.plain === 'hello', 'strike keeps plain hello');
    assert(flagAt(pm, 0, 'bold') && flagAt(pm, 0, 'italic') && flagAt(pm, 0, 'strike'),
        'strike on ***hello*** → bold+italic+strike');
    // unbold on bold+italic+strike → italic+strike
    r = api.applyInlineFormatToRaw(r, 0, 5, 'bold');
    pm = marksOf(r);
    assert(!flagAt(pm, 0, 'bold') && flagAt(pm, 0, 'italic') && flagAt(pm, 0, 'strike'),
        'unbold keeps italic+strike');
    // unitalic on ***hello*** → bold only
    pm = marksOf(api.applyInlineFormatToRaw('***hello***', 0, 5, 'italic'));
    assert(flagAt(pm, 0, 'bold') && !flagAt(pm, 0, 'italic'), 'unitalic → bold only');
    // unbold on ***hello*** → italic only
    pm = marksOf(api.applyInlineFormatToRaw('***hello***', 0, 5, 'bold'));
    assert(!flagAt(pm, 0, 'bold') && flagAt(pm, 0, 'italic'), 'unbold → italic only');
    // bold on italic → bold+italic
    pm = marksOf(api.applyInlineFormatToRaw('*hello*', 0, 5, 'bold'));
    assert(flagAt(pm, 0, 'bold') && flagAt(pm, 0, 'italic'), 'bold on italic → both');
    // bold toggle off
    pm = marksOf(api.applyInlineFormatToRaw('**hello**', 0, 5, 'bold'));
    assert(!flagAt(pm, 0, 'bold'), 'bold toggles off');
    // italic on bold → both
    pm = marksOf(api.applyInlineFormatToRaw('**hello**', 0, 5, 'italic'));
    assert(flagAt(pm, 0, 'bold') && flagAt(pm, 0, 'italic'), 'italic on bold → both');
    // list prefix
    r = api.applyInlineFormatToRaw('- ***hello***', 0, 5, 'strike');
    assert(r.startsWith('- '), 'list prefix kept');
    pm = marksOf(r);
    assert(flagAt(pm, 0, 'strike') && flagAt(pm, 0, 'bold'), 'list item strike+bold');
}

console.log('--- interior mid-span bold (selection inside wider *** / **) ---');
{
    function marksOf(raw) {
        return api.plainAndMarksFromMarkdown(raw);
    }
    // **aaaaBBBBBaaaa** select BBBBB → plain middle, bold ends
    const raw1 = '**aaaaBBBBBaaaa**';
    const s1 = 'aaaaBBBBBaaaa'.indexOf('BBBBB');
    const out1 = api.applyInlineFormatToRaw(raw1, s1, s1 + 5, 'bold');
    const pm1 = marksOf(out1);
    assert(pm1.plain === 'aaaaBBBBBaaaa', 'mid unbold plain');
    assert(pm1.marks[0].bold && !pm1.marks[s1].bold && pm1.marks[s1 + 5].bold,
        'mid unbold: ends bold, BBB plain');

    // ***preBBBsuf*** select BBB → not bold, stays italic
    const raw2 = '***preBBBsuf***';
    const s2 = 'preBBBsuf'.indexOf('BBB');
    const out2 = api.applyInlineFormatToRaw(raw2, s2, s2 + 3, 'bold');
    const pm2 = marksOf(out2);
    assert(pm2.plain === 'preBBBsuf', '*** mid plain');
    assert(!pm2.marks[s2].bold && pm2.marks[s2].italic, 'BBB italic not bold');
    assert(pm2.marks[0].bold && pm2.marks[0].italic, 'pre stays bold+italic');
    assert(pm2.marks[s2 + 3].bold && pm2.marks[s2 + 3].italic, 'suf stays bold+italic');
}

console.log('--- link boundaries, raw emphasis fallback, block split, multi-line code ---');
{
    const eq = (got, want, msg) => assert(got === want, msg + (got === want ? '' : ' -> got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));

    // Link formatting over bold, existing links, code spans, and partial overlaps
    api.setPendingLink({ text: 'word', url: 'https://x.com' });
    eq(api.applyInlineFormatToRaw('**word**', 0, 4, 'link'), '**[word](https://x.com)**', 'link inside bold keeps ** outside');
    api.setPendingLink({ text: 'word rest', url: 'https://x.com' });
    eq(api.applyInlineFormatToRaw('**word** rest', 0, 9, 'link'), '[word rest](https://x.com)', 'link over bold+plain swallows opening **');
    api.setPendingLink({ text: 'here', url: 'https://new.com' });
    eq(api.applyInlineFormatToRaw('**[here](https://old.com)**', 0, 4, 'link'), '**[here](https://new.com)**', 'replacing link keeps bold and avoids [[text](new)](old)');
    api.setPendingLink({ text: 'code', url: 'https://x.com' });
    eq(api.applyInlineFormatToRaw('use `code` here', 4, 8, 'link'), 'use [code](https://x.com) here', 'link over code span replaces whole backticks cleanly');
    api.setPendingLink({ text: 'world', url: 'https://new.com' });
    eq(api.applyInlineFormatToRaw('**hello world** and more', 6, 20, 'link'), '**hello** [world](https://new.com)', 'link partial overlap closes bold on before');
    api.setPendingLink(null);
    eq(api.applyInlineFormatToRaw('see [hello world](https://old.com) tail', 10, 20, 'link'), 'see [hello](https://old.com) [world tail](https://)', 'link partial overlap across link stays balanced');

    // Bold/italic/strike raw fallback over code/link/emphasis
    eq(api.applyInlineFormatToRaw('`code` and rest', 0, 13, 'bold'), '**`code` and rest**', 'bold over code+plain wraps whole span');
    eq(api.applyInlineFormatToRaw('[link](https://x.com) rest', 0, 9, 'bold'), '**[link](https://x.com) rest**', 'bold over link+plain swallows opening [');
    eq(api.applyInlineFormatToRaw('[link](https://x.com) **word**', 5, 9, 'italic'), '[link](https://x.com) ***word***', 'italic on bold word next to link keeps bold');
    eq(api.applyInlineFormatToRaw('[link](https://x.com) **word**', 5, 9, 'bold'), '[link](https://x.com) word', 'bold toggle off next to link unwraps **');
    eq(api.applyInlineFormatToRaw('`hello world` [u](https://x.com)', 6, 11, 'bold'), null, 'partial bold inside code span refused cleanly');

    // splitRawForBlockFormat (partial-block H2 / Quote)
    const sp1 = api.splitRawForBlockFormat('**Privacy-first** and free.', 0, 17, 'h2', {});
    assert(JSON.stringify(sp1.pieces) === JSON.stringify(['## **Privacy-first** and', ' free.']),
        'partial H2 from bold start includes opening ** (got ' + JSON.stringify(sp1.pieces) + ')');
    const sp2 = api.splitRawForBlockFormat('Hello **world**', 6, 11, 'h2', {});
    assert(JSON.stringify(sp2.pieces) === JSON.stringify(['Hello ', '## **world**']),
        'partial H2 on trailing bold keeps ** together (got ' + JSON.stringify(sp2.pieces) + ')');
    const sp3 = api.splitRawForBlockFormat('**hello world** and more', 6, 20, 'h2', {});
    assert(JSON.stringify(sp3.pieces) === JSON.stringify(['**hello** ', '## **world** and more']),
        'partial H2 mid-bold closes before and re-opens mid (got ' + JSON.stringify(sp3.pieces) + ')');
    const sp4 = api.splitRawForBlockFormat('**a b c**', 2, 3, 'h2', {});
    assert(JSON.stringify(sp4.pieces) === JSON.stringify(['**a** ', '## **b**', ' **c**']),
        'partial H2 inside wider bold balances all three pieces (got ' + JSON.stringify(sp4.pieces) + ')');

    // inlineMarksForSelectedLines for partial & mixed multi-block code
    api.setMbFreeze({ fromIdx: 0, toIdx: 1, prefix: 'Intro ', suffix: ' tail' });
    const plan1 = api.inlineMarksForSelectedLines(['Intro **bold** rest', 'second line tail'], { 0: true, 1: true }, 'code');
    eq(plan1[0], 'Intro `**bold** rest`', 'multi-block partial code accepts newly visible ** markers');
    eq(plan1[1], '`second line` tail', 'multi-block partial code formats second line end');

    api.setMbFreeze(null);
    const planMixed = api.inlineMarksForSelectedLines(['`already`', 'plain line'], { 0: true, 1: true }, 'code');
    eq(planMixed[0], undefined, 'mixed multi-block code leaves already-coded line alone');
    eq(planMixed[1], '`plain line`', 'mixed multi-block code codes plain line');

    const planAllCode = api.inlineMarksForSelectedLines(['`one`', '`two`'], { 0: true, 1: true }, 'code');
    eq(planAllCode[0], 'one', 'all-code multi-block toggles line 0 off');
    eq(planAllCode[1], 'two', 'all-code multi-block toggles line 1 off');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nINLINE MARKDOWN SELFTEST FAILED');
    process.exit(1);
}
console.log('\nINLINE MARKDOWN SELFTEST PASSED');
