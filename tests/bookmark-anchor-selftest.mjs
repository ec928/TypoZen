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
 * exhaustively, rather than by clicking around a running editor.
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

const names = ['markFingerprint', 'markNameFromRaw', 'resolveMarkIndex',
               'serializeMarks', 'parseMarks', 'htmlFragmentToText'];
let src = 'const MARK_FP_CHARS = 80, MARK_SEARCH_RADIUS = 400;\n' +
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

console.log('\n=== the search is bounded ===');
{
    // Moved further than the radius: not found, and -- the point of the bound -- not
    // fingerprinting the whole document to find that out.
    const raws = doc(2000);
    const m = markAt(raws, 10);
    const edited = doc(900, 'inserted').concat(raws);
    let seen = 0;
    const counting = new Proxy(edited, {
        get(t, k) { if (typeof k === 'string' && /^\d+$/.test(k)) seen++; return t[k]; }
    });
    const at = api.resolveMarkIndex(m, counting);
    info('moved 900 blocks with a 400 radius: resolved ' + at + ', read ' + seen + ' blocks');
    assert(at === -1, 'beyond the radius it reports unresolved');
    assert(seen < 1100, 'without scanning the whole document (' + seen + ' reads)');
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'BOOKMARK ANCHOR FAILED' : 'BOOKMARK ANCHOR PASSED');
process.exit(failed ? 1 : 0);
