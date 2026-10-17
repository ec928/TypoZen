/**
 * Read-aloud transport: paragraph skip and stop-at-chapter (js/modules/09-speech.js).
 *
 * Previous and Next move by the highlighted paragraph, not by a narrator piece.
 * Stop at end of chapter uses a book's units, or heading entries when there are none.
 *
 *   node tests/read-aloud-transport-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'modules', '09-speech.js'), 'utf8');
const begin = src.indexOf('// --- read-aloud transport');
const end = src.indexOf('// --- end read-aloud transport ---');
if (begin < 0 || end < begin) throw new Error('transport slice not found');
const slice = src.slice(begin, end);

const fn = new Function(slice + '\nreturn { ttsBlockOf, ttsParagraphKey, ttsPastChapter, ttsChapterEnd, ttsSkipParagraph };');
const { ttsBlockOf, ttsParagraphKey, ttsPastChapter, ttsChapterEnd, ttsSkipParagraph } = fn();

let n = 0;
function check(cond, msg) {
    n++;
    if (!cond) throw new Error(msg);
}

function piece(idx, id) { return { idx: idx, id: id, text: id }; }

// One paragraph split into pieces shares a key. A neighbour does not.
check(ttsParagraphKey(piece(4, 'a')) === ttsParagraphKey(piece(4, 'b')), 'same paragraph, one key');
check(ttsParagraphKey(piece(4, 'a')) !== ttsParagraphKey(piece(5, 'c')), 'next paragraph, other key');
check(ttsBlockOf({ at: 12 }) === 12, 'narration piece uses at');
check(ttsBlockOf({ el: { getAttribute: function () { return '7'; } } }) === 7, 'element block index');
check(ttsParagraphKey({ id: 'solo' }) !== ttsParagraphKey({ id: 'other' }), 'chunks with no block stay separate');

// Next drops the rest of this paragraph and lands on the next one.
const p1a = piece(1, 'p1a'), p1b = piece(1, 'p1b'), p2a = piece(2, 'p2a'), p2b = piece(2, 'p2b'), p2c = piece(2, 'p2c'), p3 = piece(3, 'p3');
const next = ttsSkipParagraph([p1a, p1b, p2a], p2b, [p2c, p3], 1);
check(next.moved === true, 'next moves');
check(next.queue.length === 1 && next.queue[0] === p3, 'next queue is the following paragraph');
check(next.current === null, 'next leaves the target for the player');
check(next.played[next.played.length - 1] === p2b, 'next keeps the piece that was playing');

// Next at the last paragraph stays.
const stay = ttsSkipParagraph([p1a], p3, [], 1);
check(stay.moved === false, 'next at the end stays');
check(stay.current === p3 && stay.queue.length === 0, 'next at the end keeps the place');

// Previous from the first paragraph restarts it, pieces and all.
const restart = ttsSkipParagraph([p1a], p1b, [p2a], -1);
check(restart.moved === true, 'previous on the first paragraph restarts it');
check(restart.played.length === 0, 'restart has no older history');
check(restart.queue[0] === p1a && restart.queue[1] === p1b && restart.queue[2] === p2a, 'restart plays this paragraph then the rest');

// Previous from a later paragraph restores that paragraph ahead of this one.
const back = ttsSkipParagraph([p1a, p1b, p2a], p2b, [p2c, p3], -1);
check(back.moved === true, 'previous moves');
check(back.queue[0] === p1a && back.queue[1] === p1b, 'previous starts at the earlier paragraph');
check(back.queue[2] === p2a && back.queue[3] === p2b && back.queue[4] === p2c, 'then the paragraph that was playing, whole');
check(back.queue[5] === p3, 'then what was still queued');

// Chapter boundary. A book's units win over headings.
const units = [{ start: 0, end: 10 }, { start: 10, end: 40 }];
check(ttsChapterEnd(3, units, [{ bi: 4 }]) === 10, 'book chapter ends at the next unit');
check(ttsChapterEnd(10, units, null) === 40, 'the next unit has its own end');
check(ttsChapterEnd(39, units, null) === 40, 'last block of a unit still reports the end');
check(ttsPastChapter(piece(9, 'in'), 10) === false, 'last block of the chapter is read');
check(ttsPastChapter(piece(10, 'out'), 10) === true, 'the next chapter is not');
check(ttsChapterEnd(5, null, [{ bi: 0 }, { bi: 20 }, { bi: 50 }]) === 20, 'a heading section ends at the next heading');
check(ttsChapterEnd(50, null, [{ bi: 0 }, { bi: 50 }]) === null, 'the last heading has no end');
check(ttsChapterEnd(1, [], []) === null, 'no chapters means read on');
check(ttsPastChapter(piece(3, 'x'), null) === false, 'no boundary does not cut');

console.log('READ-ALOUD-TRANSPORT PASSED (' + n + ')');
