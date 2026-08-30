/**
 * Self-test: pasting rich HTML from a browser (Chrome/Edge) or Word.
 *
 * htmlToMarkdown() is the whole external-paste path: editor's paste handler prefers
 * text/html over text/plain for anything that did not originate in TypoZen. It is pure
 * DOM->string work, so it runs under jsdom without booting the editor.
 *
 * Regression guarded here: walkTable() used to call walkNode(cell), but walkNode returns
 * '' for th/td because it defers table handling back to walkTable. Every cell therefore
 * came out empty and any pasted table arrived as a correctly shaped grid of blanks.
 *
 * node tests/paste-html-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'TypoZen_Template_Test.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

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

// htmlToMarkdown needs a DOMParser; jsdom supplies a real one.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const htmlToMarkdown = new Function(
    'DOMParser',
    extractFunction('htmlToMarkdown') + '\nreturn htmlToMarkdown;'
)(dom.window.DOMParser);

let passed = 0;
let failed = 0;
function eq(got, want, msg) {
    if (got === want) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        console.error('        want: ' + JSON.stringify(want));
        console.error('        got : ' + JSON.stringify(got));
    }
}
function has(got, needle, msg) {
    if (String(got).indexOf(needle) !== -1) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        console.error('        needle : ' + JSON.stringify(needle));
        console.error('        in     : ' + JSON.stringify(got));
    }
}

function ok(cond, msg, show) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        if (show !== undefined) console.error('        got : ' + JSON.stringify(show));
    }
}

console.log('--- tables ---');
{
    // Shape Chrome puts on the clipboard: full document, fragment markers, thead/tbody.
    const chrome = `<html><body><!--StartFragment-->` +
        `<table><thead><tr><th>Region</th><th>Revenue</th></tr></thead>` +
        `<tbody><tr><td>North</td><td>1,200</td></tr>` +
        `<tr><td>South</td><td>950</td></tr></tbody></table>` +
        `<!--EndFragment--></body></html>`;
    const md = htmlToMarkdown(chrome);
    eq(md, [
        '| Region | Revenue |',
        '| --- | --- |',
        '| North | 1,200 |',
        '| South | 950 |'
    ].join('\n'), 'a Chrome table keeps its cell text');

    // A table with no thead (very common in real pages)
    const bare = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>';
    has(htmlToMarkdown(bare), '| a | b |', 'a thead-less table keeps its first row');
    has(htmlToMarkdown(bare), '| c | d |', 'a thead-less table keeps its body row');

    // Inline formatting inside cells must survive
    const rich = '<table><tr><th>Name</th></tr><tr><td><strong>bold</strong> and <em>it</em></td></tr></table>';
    has(htmlToMarkdown(rich), '| **bold** and *it* |', 'inline formatting inside a cell survives');

    // A pipe in cell text must not break the row
    const piped = '<table><tr><th>h</th></tr><tr><td>a|b</td></tr></table>';
    has(htmlToMarkdown(piped), 'a\\|b', 'a literal pipe in a cell is escaped');

    // A cell containing a line break must stay on one markdown row
    const broken = '<table><tr><th>h</th></tr><tr><td>one<br>two</td></tr></table>';
    has(htmlToMarkdown(broken), '| one two |', 'a <br> inside a cell collapses to a space');
}

console.log('\n--- headings ---');
{
    for (let lvl = 1; lvl <= 6; lvl++) {
        const md = htmlToMarkdown('<h' + lvl + '>Title ' + lvl + '</h' + lvl + '>');
        eq(md.trim(), '#'.repeat(lvl) + ' Title ' + lvl, 'h' + lvl + ' becomes ' + lvl + ' hashes');
    }
    // Chrome wraps headings in spans carrying inline styles
    const styled = '<h2><span style="font-weight:700">Quarterly</span> Results</h2>';
    eq(htmlToMarkdown(styled).trim(), '## Quarterly Results', 'a span-wrapped heading keeps one hash run');
}

console.log('\n--- mixed document ---');
{
    const doc = '<h2>Results</h2><p>Intro text.</p>' +
        '<table><tr><th>K</th><th>V</th></tr><tr><td>x</td><td>1</td></tr></table>' +
        '<ul><li>first</li><li>second</li></ul>';
    const md = htmlToMarkdown(doc);
    has(md, '## Results', 'heading survives in a mixed paste');
    has(md, 'Intro text.', 'paragraph survives in a mixed paste');
    has(md, '| x | 1 |', 'table row survives in a mixed paste');
    has(md, '- first', 'list item survives in a mixed paste');
}

console.log('--- block containers separate ---');
{
    // A <div> used to fall through to `default: return kids`, contributing no separator at
    // all, so two adjacent blocks ran together mid-sentence. From a real paste:
    // "...the same underlying habit.Four distinct defects...".
    const md = htmlToMarkdown('<div>the same underlying habit.</div><div>Four distinct defects.</div>');
    ok(/habit\.\s*\n\s*\n\s*Four/.test(md), 'adjacent divs do not run together', md);

    // Same cause: a code block built as one div per line collapsed onto a single line.
    const lines = htmlToMarkdown('<div><div>line one</div><div>line two</div><div>line three</div></div>');
    ok(/line one[\s\S]*\n[\s\S]*line two[\s\S]*\n[\s\S]*line three/.test(lines),
        'one div per line keeps its lines', lines);
    has(htmlToMarkdown('<pre><code>const a = 1;\nconst b = 2;</code></pre>'), '```',
        'a real <pre> still fences');
}

console.log('--- emphasis carried by CSS ---');
{
    // Most rich sources style rather than mark up: a chat transcript italicises with a
    // class on a <div>, Word and Docs emit <span style="font-weight:700">. Recognising
    // only <em>/<b> threw all of that away silently -- a whole italic paragraph arrived as
    // plain text with nothing to show it had ever been emphasised.
    ok(/\*a thought\*/.test(htmlToMarkdown('<div style="font-style: italic">a thought</div>')),
        'a div styled italic becomes emphasis');
    ok(/a \*\*bold\*\* word/.test(htmlToMarkdown('<p>a <span style="font-weight:700">bold</span> word</p>')),
        'a span styled bold becomes strong (Word / Docs shape)');
    ok(!/\*\*/.test(htmlToMarkdown('<p>a <span style="font-weight:400">plain</span> word</p>')),
        'font-weight under 600 is not bold');

    // "** bold **" is not emphasis in Markdown, it is literal asterisks.
    ok(/x \*spaced\* y/.test(htmlToMarkdown('<p>x<span style="font-style:italic"> spaced </span>y</p>')),
        'marks hug the text, not the surrounding spaces');

    // A heading already carries its meaning; marking it again yields "## **Guards**".
    eq(htmlToMarkdown('<h2 style="font-weight:700">Guards</h2>').trim(), '## Guards',
        'a styled heading is not double-marked');
    ok(!/\*/.test(htmlToMarkdown('<div style="font-style:italic"></div><p>text</p>')),
        'an empty styled wrapper adds no stray marks');
    has(htmlToMarkdown('<p><em>i</em> and <strong>b</strong></p>'), '*i* and **b**',
        'semantic em/strong are unaffected');
}


console.log('--- Firefox Ctrl+A fragment (opening sentence must not reappear at the end) ---');
{
    const first = 'The quick brown fox jumps over the lazy dog.';
    const rest = 'Then it sat down and thought about lunch.';
    // Firefox Select-All: the selection is the fragment; a copy of the lead
    // sentence sits after EndFragment (and sometimes a skip-link before it).
    const fx = '<html><body>'
        + '<a href="#main" style="display:none">Skip to content</a>'
        + '<!--StartFragment-->'
        + '<p>' + first + '</p><p>' + rest + '</p>'
        + '<!--EndFragment-->'
        + '<p>' + first + '</p>'
        + '</body></html>';
    const md = htmlToMarkdown(fx);
    has(md, first, 'the selected opening sentence is kept');
    has(md, rest, 'the rest of the selection is kept');
    const lastHit = md.lastIndexOf(first);
    const firstHit = md.indexOf(first);
    ok(firstHit >= 0 && lastHit === firstHit, 'the opening sentence is not repeated after the fragment', md);

    const hidden = '<p>Visible lead.</p><p aria-hidden="true">Visible lead.</p><p>Body copy here.</p>';
    const hid = htmlToMarkdown(hidden);
    ok((hid.match(/Visible lead/g) || []).length === 1, 'aria-hidden clones are not pasted', hid);

    // No fragment markers, but the last block is an exact copy of the first.
    const trail = htmlToMarkdown(
        '<p>The quick brown fox jumps over the lazy dog.</p>'
        + '<p>Middle of the article stays.</p>'
        + '<p>The quick brown fox jumps over the lazy dog.</p>');
    has(trail, 'Middle of the article stays.', 'the middle of a no-fragment paste is kept');
    ok((trail.match(/quick brown fox/g) || []).length === 1,
        'a trailing copy of the opening paragraph is dropped', trail);
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nPASTE HTML SELFTEST FAILED');
    process.exit(1);
}
console.log('\nPASTE HTML SELFTEST PASSED');
process.exit(0);
