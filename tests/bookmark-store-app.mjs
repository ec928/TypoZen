/**
 * A mark set in one session is found in the next — including after the file was edited.
 *
 * bookmark-anchor-selftest proves the resolver in isolation. This proves the loop it sits
 * in: page fingerprints the block, host writes it against the document's path, and on the
 * next launch the page resolves it against a model that may have moved underneath it.
 * Every step of that crosses the WebView bridge or the disk, so none of it is exercised by
 * a pure test.
 *
 *   RUN_APP_E2E=1 node tests/bookmark-store-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, sleep } from './app-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const STORE = path.join(process.env.LOCALAPPDATA || '', 'TypoZen_Cache', 'bookmarks.txt');
const DOC = path.join(appDir, 'tests', '_bookmark_fixture.md');

// The real profile's store; put it back whatever happens.
let restore = null;
try { restore = fs.readFileSync(STORE, 'utf8'); } catch (e) {}
function putBack() {
    try {
        if (restore !== null) fs.writeFileSync(STORE, restore);
        else fs.unlinkSync(STORE);
    } catch (e) {}
    try { fs.unlinkSync(DOC); } catch (e) {}
}

/** A document whose paragraphs are told apart by their text, not their position. */
function writeFixture(prefixParas) {
    const body = [];
    for (let i = 0; i < prefixParas; i++) body.push('Inserted paragraph ' + i + ' added later.');
    for (let i = 0; i < 60; i++) {
        body.push('Original paragraph ' + i + ', with enough words in it to be identified.');
    }
    fs.writeFileSync(DOC, '# Fixture\n\n' + body.join('\n\n') + '\n');
}

const marksNow = () => (typeof _marks === 'undefined') ? null
    : _marks.map(m => ({ block: m.block, name: m.name }));

writeFixture(0);

console.log('\n=== set a mark, and it reaches the disk ===');
let app = await launchApp({ file: 'tests/_bookmark_fixture.md', settleMs: 5000 });
let marked = null;
try {
    marked = await app.eval(() => {
        // The 10th original paragraph, wherever the model put it.
        const i = DocumentModel.blocks.findIndex(b => /Original paragraph 9,/.test(b.raw));
        toggleMarkAtBlock(i);
        return { at: i, marks: _marks.map(m => ({ block: m.block, name: m.name, fp: m.fp })) };
    });
    info('marked block ' + marked.at + ': ' + JSON.stringify(marked.marks[0].name));
    assert(marked.marks.length === 1, 'the page holds one mark');
    assert(marked.marks[0].name.indexOf('Original paragraph 9') === 0,
        'named from its own text, not "Bookmark 1"');
    assert(marked.marks[0].fp.length > 0, 'and carries a fingerprint');
    await sleep(1200);

    const onDisk = fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8') : '';
    info('store: ' + JSON.stringify(onDisk.slice(0, 90)) + '…');
    assert(onDisk.indexOf('_bookmark_fixture.md') >= 0,
        'the host wrote it against the document path');
    assert(onDisk.split('\n').filter(Boolean).length === 1,
        'as a single line for the document');
} finally {
    await app.close();
}

console.log('\n=== it comes back on the next launch ===');
app = await launchApp({ file: 'tests/_bookmark_fixture.md', settleMs: 6000 });
try {
    const back = await app.eval(marksNow);
    info('restored: ' + JSON.stringify(back));
    assert(back && back.length === 1, 'the mark survived the restart');
    assert(back[0].block === marked.at,
        'at the same block (' + (back && back[0] && back[0].block) + ' vs ' + marked.at + ')');
} finally {
    await app.close();
}

console.log('\n=== and after eight paragraphs are inserted above it ===');
writeFixture(8);
app = await launchApp({ file: 'tests/_bookmark_fixture.md', settleMs: 6000 });
try {
    const moved = await app.eval(() => ({
        marks: _marks.map(m => ({ block: m.block, name: m.name })),
        textAtMark: (_marks[0] && _marks[0].block >= 0 &&
                     DocumentModel.blocks[_marks[0].block])
            ? DocumentModel.blocks[_marks[0].block].raw : null,
        // Where the paragraph actually lives now, asked of the model rather than worked
        // out here. A blank line is a block too, so "eight paragraphs" is sixteen blocks
        // -- an arithmetic detail of the fixture that the assertion should not depend on.
        truth: DocumentModel.blocks.findIndex(b => /Original paragraph 9,/.test(b.raw)),
        textAtOldIndex: DocumentModel.blocks[20] ? DocumentModel.blocks[20].raw : null
    }));
    info('mark now at ' + JSON.stringify(moved.marks) + '; its text lives at ' + moved.truth);
    info('what sits at the old index instead: ' + JSON.stringify(moved.textAtOldIndex));
    assert(moved.marks.length === 1, 'the mark is still there');
    assert(moved.truth > marked.at,
        'the edit really did move the paragraph (' + marked.at + ' -> ' + moved.truth + ')');
    assert(moved.marks[0].block === moved.truth,
        'the mark followed it (' + moved.marks[0].block + ' vs ' + moved.truth + ')');
    assert(/Original paragraph 9,/.test(moved.textAtMark || ''),
        'and points at the paragraph it was set on, not the one at the old index');
    assert(!/Original paragraph 9,/.test(moved.textAtOldIndex || ''),
        'which a stored index alone would not have done');
} finally {
    await app.close();
}

console.log('\n=== removing it clears the document from the store ===');
app = await launchApp({ file: 'tests/_bookmark_fixture.md', settleMs: 6000 });
try {
    const gone = await app.eval(() => {
        const b = _marks[0] ? _marks[0].block : -1;
        toggleMarkAtBlock(b);
        return _marks.length;
    });
    await sleep(1200);
    const onDisk = fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8') : '';
    assert(gone === 0, 'the page has no marks left');
    assert(onDisk.indexOf('_bookmark_fixture.md') < 0,
        'and the document is dropped from the store rather than left as an empty entry');
} finally {
    await app.close();
    putBack();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'BOOKMARK STORE FAILED' : 'BOOKMARK STORE PASSED');
process.exit(failed ? 1 : 0);
