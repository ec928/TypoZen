/**
 * Read aloud with nothing selected starts at the text cursor.
 *
 * With a selection it reads the selection; with nothing selected it used to start at the
 * top of the page (a book in Pages) or of the document, wherever the cursor was. Now a
 * cursor in the text is the starting point -- from the start of the word it is in -- and
 * the reach is unchanged: the rest of the page in Pages, the rest of the document
 * otherwise. No cursor in the text, or a cursor left on another page, starts where it
 * always did. The text the page would send to the speech engine is caught before it
 * reaches the host, so nothing is spoken.
 *
 *   RUN_APP_E2E=1 node tests/read-aloud-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { launchApp } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** In the page: put the cursor inside `word` in the first block matching `blockRe`
 *  (visible blocks only when `visibleOnly`), press Read aloud, return what would be read. */
const readFrom = async (a) => {
    const { blockRe, word, visibleOnly, none, keepCaret } = a;
    const sel = window.getSelection();
    if (!keepCaret) sel.removeAllRanges();
    if (!none) {
        const editor = document.getElementById('editor');
        const host = editor.getBoundingClientRect();
        const vis = (b) => { const r = b.getBoundingClientRect(); return r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom && r.bottom > 0 && r.top < window.innerHeight; };
        const block = [...editor.querySelectorAll('.block')].find(b => new RegExp(blockRe).test(b.textContent) && (!visibleOnly || vis(b)) && (visibleOnly !== 'hidden' || !vis(b)));
        if (!block) return { error: 'no block for ' + blockRe };
        const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let t = null;
        while (tw.nextNode()) { if (tw.currentNode.nodeValue.includes(word)) { t = tw.currentNode; break; } }
        if (!t) return { error: 'no text node with ' + word };
        const r = document.createRange();
        r.setStart(t, t.nodeValue.indexOf(word) + 2);   // mid-word
        r.collapse(true);
        sel.addRange(r);
    }
    const wv = window.chrome.webview, real = wv.postMessage, sent = [];
    wv.postMessage = (m) => { sent.push(String(m)); };
    try { speakSelection(); stopReading(); } finally { wv.postMessage = real; }
    const play = sent.find(m => m.startsWith('host_tts_play:'));
    return { text: play ? JSON.parse(play.substring(14)).text : '' };
};

// textContent, not innerText: a book's CSS can uppercase a heading on screen, and the
// cursor is placed by searching the underlying text.
const firstVisibleBlockText = () => {
    const editor = document.getElementById('editor');
    const host = editor.getBoundingClientRect();
    const b = [...editor.querySelectorAll('.block')].find(x => { const r = x.getBoundingClientRect(); return r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom && r.bottom > 0 && r.top < window.innerHeight && x.textContent.trim().length > 20; });
    return b ? b.textContent.trim() : '';
};

// ---- A Markdown document -------------------------------------------------------------
let app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000, view: true });
try {
    console.log('\n=== a document: from the cursor to the end ===');
    await app.eval(async () => { goToModelBlock(4); await new Promise(r => setTimeout(r, 600)); });
    let r = await app.eval(readFrom, { blockRe: 'scroll marker row 5\\b', word: 'marker' });
    info(JSON.stringify((r.text || r.error || '').slice(0, 70)));
    assert(/^marker row 5/.test(r.text || ''), 'starts at the word the cursor is in, from its first letter');
    assert(/Line 6 of 4582/.test(r.text || '') && !/Line 4 of 4582/.test(r.text || ''), 'carries on past it, and nothing before it is read');
    assert((r.text || '').length > 100000, 'and to the end of the document, not just the part on screen (' + (r.text || '').length + ' chars)');

    r = await app.eval(readFrom, { none: true });
    assert(/Section 1 of 140/.test((r.text || '').slice(0, 200)), 'no cursor in the text: from the top, as before');

    console.log('\n=== Source mode ===');
    await app.eval(async () => { handleCommand('view_set:mode:source'); await new Promise(r => setTimeout(r, 800)); });
    r = await app.eval(() => {
        const ta = document.getElementById('source-editor');
        const at = ta.value.indexOf('scroll marker row 5');
        ta.focus(); ta.setSelectionRange(at, at);
        const wv = window.chrome.webview, real = wv.postMessage, sent = [];
        wv.postMessage = (m) => { sent.push(String(m)); };
        try { speakSelection(); stopReading(); } finally { wv.postMessage = real; }
        const play = sent.find(m => m.startsWith('host_tts_play:'));
        return { text: play ? JSON.parse(play.substring(14)).text : '' };
    });
    assert(/^scroll marker row 5/.test(r.text || ''), 'in Source, from the cursor in the raw text');
} finally {
    await app.close();
}

// ---- A book, in Pages and then in scroll ---------------------------------------------
const book = fs.readdirSync('tests').filter(f => f.toLowerCase().endsWith('.epub'))
    .map(f => ({ f, s: fs.statSync(path.join('tests', f)).size })).sort((a, b) => a.s - b.s)[0];
app = await launchApp({ file: path.join('tests', book.f), settleMs: 8000, view: { scroll: 'pages', columns: 1 } });
try {
    console.log('\n=== a book in Pages: from the cursor to the end of the page ===');
    // Turn pages until one has two paragraphs to choose between: front matter is sparse.
    const pageParas = () => {
        const editor = document.getElementById('editor');
        const host = editor.getBoundingClientRect();
        return [...editor.querySelectorAll('.block')].filter(x => { const r = x.getBoundingClientRect(); return r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom; })
            .map(x => x.innerText.trim()).filter(t => t.split(/\s+/).length > 4);
    };
    let blocks = await app.eval(pageParas);
    for (let i = 0; i < 25 && blocks.length < 2; i++) {
        await app.eval(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })); await new Promise(r => setTimeout(r, 350)); });
        blocks = await app.eval(pageParas);
    }
    info(blocks.length + ' visible paragraphs on the page');
    if (blocks.length >= 2) {
        const second = blocks[1];
        const word = second.split(/\s+/).find(w => /^[A-Za-z]{5,}$/.test(w)) || second.split(/\s+/)[2];
        const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const r = await app.eval(readFrom, { blockRe: esc(second.slice(0, 40)), word, visibleOnly: true });
        info(JSON.stringify((r.text || r.error || '').slice(0, 70)));
        assert((r.text || '').startsWith(word), 'starts at the word the cursor is in (' + word + ')');
        assert(!(r.text || '').includes(blocks[0].slice(0, 30)), 'the paragraph above it on the page is not read');

        // Turn the page with the cursor left behind: this page from its top, as before.
        await app.eval(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })); await new Promise(r => setTimeout(r, 500)); });
        const top = await app.eval(firstVisibleBlockText);
        const r2 = await app.eval(readFrom, { none: true, keepCaret: true });
        info('next page starts: ' + JSON.stringify(top.slice(0, 40)));
        assert(top && (r2.text || '').startsWith(top.slice(0, 30)) && !(r2.text || '').startsWith(word),
            'a cursor left on the previous page: this page from its top, as before');
    } else {
        assert(false, 'a page with at least two paragraphs to test with');
    }

    console.log('\n=== the same book in scroll ===');
    await app.eval(async () => { handleCommand('view_set:scroll:scroll'); await new Promise(r => setTimeout(r, 1500)); });
    const para = await app.eval(firstVisibleBlockText);
    const w = para.split(/\s+/).find(x => /^[A-Za-z]{5,}$/.test(x));
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const r3 = await app.eval(readFrom, { blockRe: esc(para.slice(0, 40)), word: w, visibleOnly: true });
    assert((r3.text || '').startsWith(w), 'starts at the word the cursor is in (' + w + ')');
    assert((r3.text || '').length > para.length, 'and carries on past that paragraph');

    // Leave the cursor there and scroll well away: it no longer counts.
    const away = await app.eval(async () => {
        // Jump well past the cursor with the app's own navigation.
        const s0 = window.getSelection(), n0 = s0.anchorNode, e0 = n0 && (n0.nodeType === 1 ? n0 : n0.parentElement);
        const at = parseInt((e0 && e0.closest('.block') || {}).getAttribute?.('data-model-index') || '0', 10);
        goToModelBlock(at + 120);
        await new Promise(r => setTimeout(r, 1500));
        const sel = window.getSelection();
        const node = sel.anchorNode, el = node && (node.nodeType === 1 ? node : node.parentElement);
        const b = el && el.closest('.block');
        const host = document.getElementById('editor').getBoundingClientRect(), rc = b ? b.getBoundingClientRect() : null;
        return { collapsedCaret: sel.isCollapsed && !!b, caretVisible: !!rc && rc.bottom > host.top && rc.top < host.bottom && rc.bottom > 0 && rc.top < window.innerHeight };
    });
    if (away.collapsedCaret && !away.caretVisible) {
        const r4 = await app.eval(readFrom, { keep: true, none: true, keepCaret: true });
        assert(!(r4.text || '').startsWith(w), 'a cursor scrolled out of view is ignored: from the top, as before');
    } else info('could not scroll the cursor out of view here (' + JSON.stringify(away) + ') -- not checked');
} finally {
    await app.close();
}

console.log(`\npassed=${passed} failed=${failed}`);
console.log(failed ? 'READ ALOUD FAILED' : 'READ ALOUD PASSED');
process.exit(failed ? 1 : 0);
