/**
 * Self-test: a bookmark survives the document being edited underneath it.
 *
 * This is the case the whole feature stands or falls on. A block index is stable for a
 * book and unstable for Markdown -- insert a paragraph near the top and every index below
 * it shifts -- so a mark stored as an index alone would point at a different sentence the
 * next time the file was opened, with nothing to say it had moved. Silently wrong is worse
 * than missing: the reader trusts it.
 *
 * resolveMarkIndex is therefore a pure function of (mark, blocks) and is tested as one,
 * exhaustively, rather than by clicking around a running editor. It is a thin wrapper over
 * resolveMarksAgainstRaws -- the same matcher the application runs -- so these assertions
 * guard the live code path and not a second copy of it that could be tuned separately.
 *
 * node tests/bookmark-anchor-selftest.mjs
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

const names = ['markFingerprint', 'markNameFromRaw', 'buildMarkFingerprintIndex',
               'nearestOccurrence', 'resolveMarksAgainstRaws', 'resolveMarkIndex',
               'markSnapToInk', 'serializeMarks', 'parseMarks', 'htmlFragmentToText'];
let src = 'const MARK_FP_CHARS = 80;\n' +
          "const MARK_FS = '\\u001f', MARK_RS = '\\u001e';\n";
for (const n of names) src += extractFunction(n) + '\n';
src += 'return {' + names.join(',') + '};';
const api = new Function(src)();

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** A document of distinguishable paragraphs. */
const doc = (n, tag) => Array.from({ length: n }, (_, i) =>
    'Paragraph ' + i + ' of the ' + (tag || 'original') + ' document, with enough words in it to fingerprint.');

const markAt = (raws, i) => ({ block: i, named: false, fp: api.markFingerprint(raws[i]),
                               name: api.markNameFromRaw(raws[i]) });

console.log('\n=== an untouched document resolves to itself ===');
{
    const raws = doc(500);
    const m = markAt(raws, 300);
    assert(api.resolveMarkIndex(m, raws) === 300, 'the mark is where it was left (300)');
    assert(api.resolveMarkIndex(markAt(raws, 0), raws) === 0, 'the first block resolves');
    assert(api.resolveMarkIndex(markAt(raws, 499), raws) === 499, 'the last block resolves');
}

console.log('\n=== text inserted above a mark ===');
{
    const raws = doc(500);
    const m = markAt(raws, 300);
    const edited = doc(7, 'inserted').concat(raws);
    const at = api.resolveMarkIndex(m, edited);
    info('mark left at 300, seven paragraphs inserted above it, found at ' + at);
    assert(at === 307, 'the mark follows its text down the document (307)');
    assert(api.markFingerprint(edited[at]) === m.fp, 'and it is the same paragraph');
}

console.log('\n=== text removed above a mark ===');
{
    const raws = doc(500);
    const m = markAt(raws, 300);
    const edited = raws.slice(12);
    const at = api.resolveMarkIndex(m, edited);
    info('twelve paragraphs removed above it, found at ' + at);
    assert(at === 288, 'the mark follows its text up the document (288)');
}

console.log('\n=== the marked paragraph itself is deleted ===');
{
    const raws = doc(500);
    const m = markAt(raws, 300);
    const edited = raws.slice(0, 300).concat(raws.slice(301));
    const at = api.resolveMarkIndex(m, edited);
    info('the paragraph is gone; resolve returned ' + at);
    assert(at === -1, 'the mark is unresolved rather than pointed at its neighbour');
}

console.log('\n=== the same text twice: nearest to the hint wins ===');
{
    // The identical paragraph at 100 and at 400. A mark set on the second must not
    // resolve to the first just because the first is found by an earlier scan.
    const raws = doc(500);
    raws[400] = raws[100];
    const m = { block: 400, named: false, fp: api.markFingerprint(raws[100]), name: 'x' };
    assert(api.resolveMarkIndex(m, raws) === 400, 'resolves to the occurrence it was set on');

    // Shift everything down four; both copies move, and the nearer one is still the right one.
    const edited = doc(4, 'inserted').concat(raws);
    const at = api.resolveMarkIndex(m, edited);
    info('two identical paragraphs, four inserted above; resolved to ' + at);
    assert(at === 404, 'and still does after an edit moves both (404, not 104)');
}

console.log('\n=== a book block is HTML, and fingerprints as its text ===');
{
    const raws = [
        '<p class="calibre1">The Oct had been given the <i>Tower</i>, and the Tower gave them the levels beneath it.</p>',
        '<h2 class="chapter">Sursamen</h2>',
        '<p>A shellworld is not a planet, whatever the charts say.</p>'
    ];
    const fp = api.markFingerprint(raws[0]);
    info('fingerprint: ' + JSON.stringify(fp.slice(0, 46)) + '…');
    assert(fp.indexOf('<') < 0, 'no markup survives into the fingerprint');
    assert(fp.indexOf('tower') >= 0, 'the words do');
    // Retagging the same sentence -- a different wrapper, same text -- must still match.
    const retagged = ['<div><span>The Oct had been given the Tower, and the Tower gave them ' +
                      'the levels beneath it.</span></div>'].concat(raws.slice(1));
    assert(api.resolveMarkIndex({ block: 0, fp: fp }, retagged) === 0,
        'the same sentence in different markup still resolves');
}

console.log('\n=== marks name themselves ===');
{
    assert(api.markNameFromRaw('## Sursamen') === 'Sursamen',
        'a heading loses its Markdown prefix');
    assert(api.markNameFromRaw('<p>A shellworld is not a planet.</p>') ===
        'A shellworld is not a planet.', 'a book block loses its markup');
    const long = api.markNameFromRaw('The Oct had been given the Tower, and the Tower gave them the levels beneath it, and so by the reckoning of the Nariscene they had been given rather more than they were owed.');
    info('long paragraph names itself: ' + JSON.stringify(long));
    assert(long.length <= 50 && long.endsWith('…'), 'a long one is cut and marked as cut');
    assert(!/\s…$/.test(long), 'and not left with a dangling space before the ellipsis');
}

console.log('\n=== a mark never lands on a blank line ===');
{
    // Markdown puts a blank line between paragraphs, so every other block is empty and the
    // block at the top of the viewport is very often one of them. A mark there names itself
    // nothing and fingerprints as the empty string, which leaves it with no anchor at all --
    // two faults from one cause, both found by driving the real pane.
    const raws = ['# Fixture', '', 'The first paragraph.', '', 'The second paragraph.', ''];
    assert(api.markSnapToInk(1, raws) === 2, 'a blank between paragraphs snaps to the one below');
    assert(api.markSnapToInk(3, raws) === 4, 'and so does the next');
    assert(api.markSnapToInk(2, raws) === 2, 'a block with text is left where it is');
    assert(api.markSnapToInk(5, raws) === 4,
        'a trailing blank has nothing below it, so it snaps back to the last real block');
    assert(api.markFingerprint(raws[api.markSnapToInk(1, raws)]).length > 0,
        'the snapped block has a fingerprint, which is the point');

    const allBlank = ['', '', ''];
    assert(api.markSnapToInk(1, allBlank) === 1, 'a document with no text leaves the mark alone');
    assert(api.markSnapToInk(0, []) === 0, 'and an empty document does not throw');
}

console.log('\n=== the stored form survives a round trip ===');
{
    const marks = [
        { block: 41, named: false, fp: 'the culture had a word for it', name: 'the Culture had a word for it' },
        { block: 206, named: true, fp: 'a shellworld is not a planet', name: 'check this against the appendix' }
    ];
    const back = api.parseMarks(api.serializeMarks(marks));
    assert(back.length === 2, 'both marks come back');
    assert(back[0].block === 41 && back[1].block === 206, 'with their positions');
    assert(back[0].named === false && back[1].named === true, 'and whether they were renamed');
    assert(back[1].name === 'check this against the appendix', 'and the name as given');

    // Text containing the separators must not be able to forge a record.
    const nasty = [{ block: 1, named: false, fp: 'a\u001fb\u001ec', name: 'x\u001ey' }];
    const parsed = api.parseMarks(api.serializeMarks(nasty));
    assert(parsed.length === 1, 'separators inside the text cannot split one mark into two');

    assert(api.parseMarks('').length === 0, 'an empty payload is no marks, not a crash');
    assert(api.parseMarks('rubbish').length === 0, 'a malformed payload is dropped, not guessed at');
    assert(api.parseMarks(null).length === 0, 'and so is nothing at all');
}

console.log('\n=== a mark from before fingerprints existed ===');
{
    const raws = doc(50);
    assert(api.resolveMarkIndex({ block: 20, fp: '' }, raws) === 20,
        'falls back to the index, which is all it has');
    assert(api.resolveMarkIndex({ block: 900, fp: '' }, raws) === -1,
        'and is dropped if that index is off the end');
}

console.log('\n=== a large shift is still found (whole-document match) ===');
{
    // An epub re-split, or a destroyed hint, can put the paragraph thousands of blocks
    // from the stored index. Reporting "lost" while the text is still in the book is the
    // one answer a bookmark may never give, so the match is whole-document: the index is
    // built once for every mark, which is what makes that affordable.
    const raws = doc(2000);
    const m = markAt(raws, 10);
    const edited = doc(900, 'inserted').concat(raws);
    const at = api.resolveMarkIndex(m, edited);
    info('moved 900 blocks: resolved ' + at);
    assert(at === 910, 'beyond the radius the full pass still finds the paragraph (910)');
    assert(api.markFingerprint(edited[at]) === m.fp, 'and it is the same paragraph');
}

console.log('\n=== a lost mark keeps a hint and still finds its text ===');
{
    const raws = doc(500);
    const m = markAt(raws, 300);
    // Same state as after a resolve against the wrong document: block cleared, hint kept.
    const lost = { block: -1, hint: 300, fp: m.fp, name: m.name };
    assert(api.resolveMarkIndex(lost, raws) === 300,
        'block -1 with a mid-book hint still resolves (not stuck searching from 0)');
    const noHint = { block: -1, fp: m.fp, name: m.name };
    assert(api.resolveMarkIndex(noHint, raws) === 300,
        'and a full pass finds it even with no hint at all');
}

console.log('\n=== serialize keeps a position when the live block is lost ===');
{
    const marks = [{ block: -1, hint: 1740, named: false, fp: 'oramen', name: 'Oramen' }];
    const back = api.parseMarks(api.serializeMarks(marks));
    assert(back.length === 1 && back[0].block === 1740,
        'the store gets the last good index, not -1 (which used to be dropped on load)');
}

console.log('\n=== the batch path is the same matcher, one index for every mark ===');
{
    // This is what the application actually calls: one fingerprint index shared by every
    // mark, rather than a walk per mark. It must agree with the single-mark answer, or the
    // suite above is guarding a path nobody runs.
    const raws = doc(3000);
    const at = [5, 900, 1500, 2999];
    const marks = at.map(i => markAt(raws, i));
    const gone = { block: 12, fp: api.markFingerprint('a paragraph this document never had'),
                   name: 'gone' };
    marks.push(gone);

    const edited = doc(40, 'inserted').concat(raws);
    const idx = api.buildMarkFingerprintIndex(edited);
    const changed = api.resolveMarksAgainstRaws(marks, null, { index: idx });

    info('four marks shifted by forty, one whose text is gone; changed=' + changed);
    assert(at.every((orig, k) => marks[k].block === orig + 40),
        'every mark follows its own paragraph down the document');
    assert(marks[4].block === -1, 'and the one whose text is gone is unresolved, not guessed');
    assert(at.every((orig, k) => api.resolveMarkIndex(markAt(raws, orig), edited) === orig + 40),
        'the single-mark wrapper gives the same answers as the batch');

    // onlyUnresolved is the rescue pass: it must not move a mark that already found a block,
    // because the same sentence can legitimately appear twice.
    const settled = [{ block: 100, hint: 100, fp: api.markFingerprint(raws[0]), name: 'x' }];
    api.resolveMarksAgainstRaws(settled, raws, { onlyUnresolved: true });
    assert(settled[0].block === 100, 'a rescue pass leaves an already-resolved mark alone');
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'BOOKMARK ANCHOR FAILED' : 'BOOKMARK ANCHOR PASSED');
process.exit(failed ? 1 : 0);
