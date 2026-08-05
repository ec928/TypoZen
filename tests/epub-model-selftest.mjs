/**
 * A block's raw can be a book's HTML instead of Markdown, and everything else carries on.
 *
 * The point of the document kind is that only three things need to know about it -- how a
 * block renders, what its text is, and which Markdown-shaped assumptions to stop making.
 * Everything else in the application works on blocks and must not care. These are the
 * properties that make that true.
 *
 * Run in jsdom because they are all model and string logic. What a book LOOKS like is a
 * browser suite; this is about what the model holds.
 *
 *   node tests/epub-model-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(appDir, 'js', 'typozen.js'), 'utf8');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

function extractFn(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('not found: ' + name);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced: ' + name);
}

const dom = new JSDOM('<!doctype html><body></body>');
const { htmlFragmentToText, sanitizeBookHtml } = new Function('DOMParser',
    extractFn('htmlFragmentToText') + '\n' + extractFn('sanitizeBookHtml') +
    '\nreturn { htmlFragmentToText, sanitizeBookHtml };')(dom.window.DOMParser);

console.log('--- 1. a block’s text is what a reader sees, never markup ---');
{
    // Search, the outline and the word count all run on this. Matching inside class or href
    // would be wrong and invisible at the same time.
    assert(htmlFragmentToText('<p class="calibre1">Hello <i>there</i></p>') === 'Hello there',
        'tags and attributes are gone, the words are not');
    assert(htmlFragmentToText('<p><a href="chapter7.xhtml">See chapter seven</a></p>')
        === 'See chapter seven',
        'a link contributes its text, not its href');
    assert(htmlFragmentToText('<p>Nested <b>bold <i>and italic</i></b> here</p>')
        === 'Nested bold and italic here',
        'nested inline markup flattens to one run');
    assert(htmlFragmentToText('plain text') === 'plain text',
        'text with no markup passes straight through');
    assert(htmlFragmentToText('') === '' && htmlFragmentToText(null) === '',
        'empty and null are empty, not "null"');
    assert(htmlFragmentToText('<p>&amp; &lt;tag&gt; &#8212;</p>') === '& <tag> —',
        'entities are decoded, so searching for an em dash finds one');
    assert(htmlFragmentToText('<p>a  \t b</p>') === 'a b',
        'runs of whitespace collapse, including the non-breaking spaces books are full of');
}

console.log('');
console.log('--- 2. book markup is rendered, minus anything executable ---');
{
    // The HTML comes from a file the user opened, which is not the same as trusting it.
    const out = sanitizeBookHtml(
        '<p onclick="steal()">hi</p><script>steal()</script>' +
        '<a href="javascript:steal()">x</a><img src="javascript:steal()">');
    assert(out.indexOf('<script') === -1, 'scripts are removed');
    assert(out.indexOf('onclick') === -1, 'event handler attributes are removed');
    assert(!/javascript:/i.test(out), 'javascript: URLs are removed from href and src');
    assert(out.indexOf('hi') !== -1, 'and the text survives all of that');

    // Fidelity is the entire reason for carrying HTML, so structure must be untouched.
    const rich = '<h2 class="chapter">One</h2>' +
        '<p class="epigraph-right">an epigraph</p>' +
        '<p><span class="smallcaps">HE SAID</span> and <em>meant</em> it</p>' +
        '<figure><img src="../images/plate1.jpg" alt="a plate"/>' +
        '<figcaption>Plate 1</figcaption></figure>' +
        '<ul><li>one</li><li>two</li></ul>';
    const kept = sanitizeBookHtml(rich);
    for (const bit of ['<h2', 'class="chapter"', 'class="epigraph-right"',
                       'class="smallcaps"', '<em>', '<figure', '<img', 'alt="a plate"',
                       '<figcaption', '<ul', '<li']) {
        assert(kept.indexOf(bit) !== -1, 'kept: ' + bit);
    }
}

console.log('');
console.log('--- 3. the losses that made conversion the wrong answer do not happen ---');
{
    // Measured against Blindsight, converting to Markdown dropped every one of these.
    const chapter = '<h2>Prologue</h2><p><img src="i/cover.jpg" alt="cover"/></p>' +
        '<ul><li>first</li><li>second</li></ul>' +
        '<p>see <a href="notes.xhtml#n1">note</a><sup><a href="#fn1">1</a></sup></p>';
    const kept = sanitizeBookHtml(chapter);
    assert((kept.match(/<img/g) || []).length === 1, 'the image is still there');
    assert((kept.match(/<a /g) || []).length === 2, 'both links are still there');
    assert((kept.match(/<li/g) || []).length === 2, 'both list items are still there');
    assert(kept.indexOf('<sup') !== -1, 'the footnote reference is still there');
    assert(/<h2[^>]*>Prologue<\/h2>/.test(kept),
        'the heading is intact, not a hash on a line of its own');
}

console.log('');
console.log('--- 4. the document kind is a property of the document ---');
{
    // Regression shape rather than behaviour: fromMarkdown must reset the kind, or opening
    // a .md after a book would keep rendering Markdown as HTML.
    assert(/kind: 'markdown'/.test(src), 'the model defaults to Markdown');
    assert(/fromBookBlocks: function/.test(src), 'a book is loaded as blocks of HTML');
    const fm = src.slice(src.indexOf('fromMarkdown: function'),
                         src.indexOf('toMarkdown: function'));
    assert(/this\.kind = 'markdown'/.test(fm),
        'fromMarkdown resets the kind, so a Markdown file after a book renders as Markdown');
    const rbp = src.slice(src.indexOf('function renderBlockPreview'),
                          src.indexOf('function renderBlockPreview') + 1600);
    assert(/DocumentModel\.kind === 'epub'/.test(rbp) && /sanitizeBookHtml/.test(rbp),
        'renderBlockPreview takes the book path before any Markdown parsing');
}

console.log('');
console.log('passed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('');
    console.error('EPUB MODEL SELFTEST FAILED');
    process.exit(1);
}
console.log('');
console.log('EPUB MODEL SELFTEST PASSED');
process.exit(0);
