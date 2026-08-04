/**
 * Self-test: markdown table model + edit operations.
 *
 * A table is one .block whose data-raw holds the whole markdown, so every edit is a
 * pure string transform and can be tested here rather than only through the browser.
 *
 * node tests/table-edit-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

const names = ['splitTableRow', 'parseTableMarkdown', 'tableAlignToSep', 'formatTableMarkdown', 'tableOp'];
let src = '';
for (const n of names) src += extractFunction(n) + '\n';
src += 'return {' + names.join(',') + '};';
const api = new Function(src)();

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function eq(got, want, msg) {
    if (got === want) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        console.error('        want: ' + JSON.stringify(want));
        console.error('        got : ' + JSON.stringify(got));
    }
}

const TBL = [
    '| Name | Qty | Price |',
    '| --- | ---: | :---: |',
    '| Apple | 3 | 1.20 |',
    '| Pear | 5 | 2.40 |'
].join('\n');

console.log('--- parsing ---');
{
    const m = api.parseTableMarkdown(TBL);
    assert(m !== null, 'a table parses');
    eq(m.cols, 3, 'column count');
    eq(JSON.stringify(m.header), JSON.stringify(['Name', 'Qty', 'Price']), 'header cells');
    eq(JSON.stringify(m.align), JSON.stringify(['', 'right', 'center']), 'alignments read from the separator');
    eq(m.rows.length, 2, 'body row count');
    eq(JSON.stringify(m.rows[0]), JSON.stringify(['Apple', '3', '1.20']), 'first body row');

    assert(api.parseTableMarkdown('just a paragraph') === null, 'plain text is not a table');
    assert(api.parseTableMarkdown('| a | b |') === null, 'a single row is not a table (no separator)');
    assert(api.parseTableMarkdown('| a | b |\n| c | d |') === null, 'second row must be a separator');
}

console.log('--- ragged input is squared off ---');
{
    const m = api.parseTableMarkdown('| a | b | c |\n| --- | --- |\n| 1 |');
    assert(m !== null, 'ragged table still parses');
    eq(m.cols, 3, 'widest row wins');
    eq(JSON.stringify(m.rows[0]), JSON.stringify(['1', '', '']), 'short rows are padded');
    eq(m.align.length, 3, 'alignments padded to match');
}

console.log('--- round trip ---');
{
    const m = api.parseTableMarkdown(TBL);
    eq(api.formatTableMarkdown(m), TBL, 'parse -> format is byte-identical');
}

console.log('--- rows ---');
{
    const m = api.parseTableMarkdown(TBL);
    const below = api.tableOp(m, 'row_below', 0, 0, null);
    eq(below.rows.length, 3, 'insert row below adds a row');
    eq(JSON.stringify(below.rows[1]), JSON.stringify(['', '', '']), 'the new row is blank');
    eq(JSON.stringify(below.rows[2]), JSON.stringify(['Pear', '5', '2.40']), 'existing rows shift down');

    const above = api.tableOp(m, 'row_above', 1, 0, null);
    eq(JSON.stringify(above.rows[1]), JSON.stringify(['', '', '']), 'insert row above lands before the current row');
    eq(JSON.stringify(above.rows[2]), JSON.stringify(['Pear', '5', '2.40']), 'current row moves down');

    const fromHeader = api.tableOp(m, 'row_above', -1, 0, null);
    eq(fromHeader.rows.length, 3, 'insert above from the header adds a body row');
    eq(JSON.stringify(fromHeader.header), JSON.stringify(['Name', 'Qty', 'Price']), 'header is untouched');

    const del = api.tableOp(m, 'row_delete', 0, 0, null);
    eq(del.rows.length, 1, 'delete row removes one');
    eq(JSON.stringify(del.rows[0]), JSON.stringify(['Pear', '5', '2.40']), 'the right row is removed');

    const delHeader = api.tableOp(m, 'row_delete', -1, 0, null);
    eq(delHeader.rows.length, 2, 'the header row cannot be deleted');
    eq(JSON.stringify(delHeader.header), JSON.stringify(['Name', 'Qty', 'Price']), 'header survives');
}

console.log('--- columns ---');
{
    const m = api.parseTableMarkdown(TBL);
    const right = api.tableOp(m, 'col_right', 0, 0, null);
    eq(right.cols, 4, 'insert column right widens the table');
    eq(JSON.stringify(right.header), JSON.stringify(['Name', '', 'Qty', 'Price']), 'header gains a cell in place');
    eq(JSON.stringify(right.rows[0]), JSON.stringify(['Apple', '', '3', '1.20']), 'every body row widens too');
    eq(JSON.stringify(right.align), JSON.stringify(['', '', 'right', 'center']), 'alignments shift with the columns');

    const left = api.tableOp(m, 'col_left', 0, 2, null);
    eq(JSON.stringify(left.header), JSON.stringify(['Name', 'Qty', '', 'Price']), 'insert column left lands before the current one');

    const del = api.tableOp(m, 'col_delete', 0, 1, null);
    eq(del.cols, 2, 'delete column narrows the table');
    eq(JSON.stringify(del.header), JSON.stringify(['Name', 'Price']), 'the right column is removed');
    eq(JSON.stringify(del.rows[0]), JSON.stringify(['Apple', '1.20']), 'body rows lose the same column');
    eq(JSON.stringify(del.align), JSON.stringify(['', 'center']), 'alignments follow');

    const single = api.parseTableMarkdown('| only |\n| --- |\n| x |');
    const stillThere = api.tableOp(single, 'col_delete', 0, 0, null);
    eq(stillThere.cols, 1, 'the last column cannot be deleted');
}

console.log('--- alignment ---');
{
    const m = api.parseTableMarkdown(TBL);
    eq(api.formatTableMarkdown(api.tableOp(m, 'align', 0, 0, 'center')).split('\n')[1],
        '| :---: | ---: | :---: |', 'set centre alignment');
    eq(api.formatTableMarkdown(api.tableOp(m, 'align', 0, 1, 'left')).split('\n')[1],
        '| --- | :--- | :---: |', 'set left alignment');
    eq(api.formatTableMarkdown(api.tableOp(m, 'align', 0, 2, '')).split('\n')[1],
        '| --- | ---: | --- |', 'clear alignment back to default');
}

console.log('--- operations never corrupt the table ---');
{
    const ops = ['row_above', 'row_below', 'row_delete', 'col_left', 'col_right', 'col_delete'];
    let allValid = true;
    for (const op of ops) {
        for (let r = -1; r <= 1; r++) {
            for (let c = 0; c <= 2; c++) {
                const m = api.parseTableMarkdown(TBL);
                const out = api.formatTableMarkdown(api.tableOp(m, op, r, c, null));
                const reparsed = api.parseTableMarkdown(out);
                if (!reparsed) { allValid = false; console.error('   broke on ' + op + ' r=' + r + ' c=' + c); break; }
                // every row must have the same width as the header
                const widths = [reparsed.header.length, reparsed.align.length]
                    .concat(reparsed.rows.map(x => x.length));
                if (new Set(widths).size !== 1) {
                    allValid = false;
                    console.error('   ragged after ' + op + ' r=' + r + ' c=' + c + ': ' + JSON.stringify(widths));
                }
            }
        }
    }
    assert(allValid, 'every op at every caret position yields a valid, rectangular table');
}

console.log('--- alignment actually reaches the rendered cells ---');
{
    // Writing ":---:" is worthless if nothing renders it. The separator row used to be
    // parsed only to be skipped, so alignment was decoration that never moved any text.
    const render = extractFunction('renderMarkdownTable');
    assert(/parseTableMarkdown\(markdown\)/.test(render), 'the renderer builds from the shared model');
    assert(/text-align:/.test(render), 'the renderer emits text-align');
    assert(/alignStyle\(model\.align\[i\]\)/.test(render), 'per-column alignment is applied to each cell');

    const serialize = mainScript.slice(mainScript.indexOf('function blockHtmlToMarkdown'));
    assert(/tableAlignToSep\(a\)/.test(serialize), 'serializing reads alignment back off the cells');
    assert(!/headers\.map\(\(\) => '---'\)/.test(mainScript), 'the hardcoded "---" separator is gone');
}

console.log('--- alignment survives a markdown round trip ---');
{
    const aligned = '| A | B |\n| :---: | ---: |\n| 1 | 2 |';
    const m = api.parseTableMarkdown(aligned);
    eq(api.formatTableMarkdown(m), aligned, 'centre + right survive parse/format');

    const cleared = api.tableOp(m, 'align', 0, 0, '');
    eq(api.formatTableMarkdown(cleared).split('\n')[1], '| --- | ---: |', 'clearing one column leaves the other');
}

console.log('--- the DOM layer is wired ---');
{
    assert(/function getTableContext/.test(mainScript), 'caret -> table context helper exists');
    assert(/function applyTableOp/.test(mainScript), 'operations are applied to the block');
    assert(/function tableTabNavigate/.test(mainScript), 'Tab navigation exists');
    assert(/msg\.startsWith\("table:"\)/.test(mainScript), 'host table: messages are dispatched');
    assert(/writeBlockRaw\(ctx\.block, formatTableMarkdown/.test(mainScript), 'edits are written back to the block');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nTABLE EDIT SELFTEST FAILED');
    process.exit(1);
}
console.log('\nTABLE EDIT SELFTEST PASSED');
