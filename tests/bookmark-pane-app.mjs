/**
 * The Marks pane, driven the way a person drives it: by clicking.
 *
 * The place marker this replaces went unused because it was two shortcuts and nothing on
 * screen. So the assertions are about the pointer path — the button marks the page, the
 * list shows the marks in reading order, clicking a row goes there, × removes one — and
 * not about the functions underneath, which bookmark-anchor-selftest already covers.
 *
 *   RUN_APP_E2E=1 node tests/bookmark-pane-app.mjs
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
let restore = null;
try { restore = fs.readFileSync(STORE, 'utf8'); } catch (e) {}
function putBack() {
    try {
        if (restore !== null) fs.writeFileSync(STORE, restore);
        else fs.unlinkSync(STORE);
    } catch (e) {}
}

/** What the pane is showing, read from the DOM rather than from _marks. */
const paneState = () => {
    const rows = [...document.querySelectorAll('#marks-list .mark-item')];
    const btn = document.getElementById('markAddBtn');
    return {
        rows: rows.map(r => ({
            name: r.querySelector('.mark-name').textContent,
            where: (r.querySelector('.mark-where') || {}).textContent || '',
            page: r.querySelector('.mark-page').textContent,
            active: r.classList.contains('active'),
            lost: r.classList.contains('lost')
        })),
        empty: !!document.querySelector('#marks-list .mark-empty'),
        count: document.getElementById('marksCount').textContent,
        btnLabel: btn.lastElementChild.textContent,
        btnOn: btn.classList.contains('on')
    };
};

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    // Open the pane the way a person does.
    await app.eval(() => switchTab('marks'));
    await sleep(700);

    console.log('\n=== an empty pane says so ===');
    let s = await app.eval(paneState);
    info('button reads ' + JSON.stringify(s.btnLabel) + ', count ' + JSON.stringify(s.count));
    assert(s.empty, 'the empty state is shown rather than a blank pane');
    assert(s.btnLabel === 'Mark this page', 'the button offers to mark the page');
    assert(!s.btnOn, 'and does not claim the page is already marked');

    console.log('\n=== the button marks the page ===');
    await app.eval(() => document.getElementById('markAddBtn').click());
    await sleep(600);
    s = await app.eval(paneState);
    info('rows: ' + JSON.stringify(s.rows));
    assert(s.rows.length === 1, 'a row appears');
    assert(s.rows[0].name.length > 0 && s.rows[0].name !== '(untitled mark)',
        'named from the text it was set on');
    assert(s.count === '1 mark', 'the footer counts it, in the singular');
    assert(s.btnLabel === 'Remove this mark' && s.btnOn,
        'and the button now offers the opposite, so the toggle is visible');

    console.log('\n=== marks appear in reading order, not the order they were made ===');
    const made = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        // Deliberately out of order: a later block, then an earlier one.
        goToModelBlock(1200); await sleep(700);
        document.getElementById('markAddBtn').click(); await sleep(200);
        goToModelBlock(400); await sleep(700);
        document.getElementById('markAddBtn').click(); await sleep(200);
        return _marks.map(m => m.block);
    });
    await sleep(600);
    s = await app.eval(paneState);
    info('blocks in the model: ' + JSON.stringify(made));
    assert(made.length === 3, 'three marks exist');
    assert(made[0] <= made[1] && made[1] <= made[2],
        'held in ascending document order (' + made.join(', ') + ')');
    assert(s.count === '3 marks', 'the footer pluralises');
    assert(s.rows.filter(r => r.active).length === 1,
        'exactly one row is marked as the nearest');

    console.log('\n=== clicking a row goes there, and leaves a way back ===');
    const jump = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        goToModelBlock(2500); await sleep(900);
        const before = currentReadingBlock();
        const target = _marks[0].block;
        // The first row: the earliest mark, far behind where we are now.
        document.querySelector('#marks-list .mark-item').click();
        await sleep(1400);
        const after = currentReadingBlock();
        // What matters is that the marked paragraph is in front of the reader, not that it
        // is the topmost block: the jump scrolls it into view, so the block reported as
        // "current" is legitimately a little above it.
        let onScreen = false;
        try {
            const el = document.querySelector('[data-model-index="' + target + '"]');
            const host = document.getElementById('main-container') || document.body;
            if (el) {
                const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
                onScreen = r.bottom > h.top && r.top < h.bottom;
            }
        } catch (e) {}
        handleCommand('return_jump');
        await sleep(1400);
        return { before, after, back: currentReadingBlock(), target, onScreen };
    });
    info('at ' + jump.before + ' → clicked row 1 (block ' + jump.target + ') → ' +
         jump.after + ' (marked block on screen: ' + jump.onScreen + ') → return_jump → ' + jump.back);
    assert(jump.onScreen,
        'the marked paragraph is on screen after the jump (landed near ' + jump.after + ')');
    assert(Math.abs(jump.back - jump.before) <= 40,
        'and Ctrl+Shift+J returns to where reading was (' + jump.back + ' vs ' + jump.before + ')');

    console.log('\n=== × removes one, Clear all removes the rest ===');
    await app.eval(() => switchTab('marks'));
    await sleep(500);
    await app.eval(() => document.querySelector('#marks-list .mark-item .mark-del').click());
    await sleep(500);
    s = await app.eval(paneState);
    assert(s.rows.length === 2, 'one row goes (' + s.rows.length + ' left)');

    await app.eval(() => document.getElementById('marksClearBtn').click());
    await sleep(600);
    s = await app.eval(paneState);
    assert(s.rows.length === 0 && s.empty, 'Clear all empties the pane');
    assert(s.count === '0 marks', 'and the count follows');

    await sleep(900);
    const onDisk = fs.existsSync(STORE) ? fs.readFileSync(STORE, 'utf8') : '';
    assert(onDisk.indexOf('large-scroll-mixed.md') < 0,
        'the document is dropped from the store, not left holding an empty list');
} finally {
    await app.close();
    putBack();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'BOOKMARK PANE FAILED' : 'BOOKMARK PANE PASSED');
process.exit(failed ? 1 : 0);
