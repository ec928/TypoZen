/**
 * The page's half of "right-click is where you change text" (Ed, 2026-11-21):
 *   - a right-click in an editable document asks the host for TypoZen's menu
 *     (format_menu: with the caret line's type) instead of the browser's, and does not
 *     also raise the selection popup; a code file asks for it too, with md: false
 *     (clipboard items only)
 *   - the Menu key sends where the caret is ("at"), so the menu opens there; a mouse
 *     right-click does not (the menu opens at the pointer)
 *   - Ctrl+1..6 make headings, the same key again makes normal text, Ctrl+Alt+2 does not
 *   - the selection popup holds reading tools only: no Bold, no More
 * The host's half (the WPF menu, its items and ticks, placing it, the host key filter)
 * is not reachable from here.
 *
 *   node tests/format-menu-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled, untilPage } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (40 s)'); process.exit(1); }, 40000);
let passed = 0, failed = 0;
function same(msg, got, want) {
    if (got === want) { passed++; console.log('  OK   ' + msg); return; }
    failed++;
    console.error('  FAIL ' + msg + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want));
}

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 20000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    // Record what the page sends the host, and whether a right-click's default survived.
    await page.evaluate(() => {
        window.__sent = [];
        postMsg = function (m) { window.__sent.push(String(m)); };
        window.__ctxDefault = null;
        document.addEventListener('contextmenu', (e) => { window.__ctxDefault = !e.defaultPrevented; });
    });
    const saved = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
    const load = async (md, ext, mode) => {
        await page.evaluate((m, x) => { setSourceDocExt(x); loadMarkdownContent(m); }, md, ext || 'md');
        await page.evaluate((m) => handleCommand('view_set:mode:' + m), mode || 'wysiwyg');
        await settled(page);
        await page.evaluate(() => { window.__sent = []; window.__ctxDefault = null; });
    };
    const lineBox = async (i) => (await page.$('#editor .block[data-model-index="' + i + '"]')).boundingBox();
    const menuMsgs = () => page.evaluate(() => window.__sent.filter(m => m.indexOf('format_menu:') === 0));
    const popShown = () => page.evaluate(() => { const p = document.getElementById('selPop'); return !!p && !p.hidden; });
    // Drag across the start of a line. (Not clickCount: 2 -- Puppeteer's is no real double-click.)
    const dragSelect = async (box) => {
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + 2, y);
        await page.mouse.down();
        await page.mouse.move(box.x + 40, y, { steps: 4 });
        await page.mouse.up();
        await new Promise(r => setTimeout(r, 120));   // the popup is raised 10 ms after mouseup
    };

    console.log("\n=== right-click in Markdown: TypoZen's menu, not the browser's ===");
    await load('## Heading\n> [!TIP]\n> Tip body\nPlain');
    let b = await lineBox(2);
    await page.mouse.click(b.x + 20, b.y + b.height / 2, { button: 'right' });
    await settled(page);
    let msgs = await menuMsgs();
    same("one format_menu: request, with the line's type and no caret point", JSON.stringify(msgs),
        JSON.stringify(['format_menu:{"block":"quote","callout":"tip","md":true}']));
    same("the browser's own menu is cancelled", await page.evaluate(() => window.__ctxDefault), false);
    // Right-click on a selection: the menu, and no popup over it.
    b = await lineBox(3);
    await dragSelect(b);
    same('premise: the drag selected text and raised the popup', await popShown(), true);
    await page.evaluate(() => { window.__sent = []; hideSelPop(); });
    await page.mouse.click(b.x + 20, b.y + b.height / 2, { button: 'right' });
    await new Promise(r => setTimeout(r, 120));   // the popup is raised 10 ms after mouseup
    same('right-click on a selection does not raise the popup', await popShown(), false);
    same('and asks for the menu', (await menuMsgs()).length, 1);

    console.log("\n=== a picture keeps the browser's own menu ===");
    await load('Text above\n![sample](tests/native-sample.png)\nText below');
    await page.waitForFunction(() => { const i = document.querySelector('#editor img'); return i && i.complete && i.naturalWidth > 0; }, { timeout: 5000 });
    // native-sample.png is 1x1 and #editor .block img sets width/height: auto !important;
    // override with !important so the picture renders at a real size and the click lands on it.
    const img = await page.evaluate(() => { const i = document.querySelector('#editor img'); i.style.setProperty('width', '80px', 'important'); i.style.setProperty('height', '80px', 'important'); const r = i.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; });
    same('premise: the picture is on the page with a size', img.w > 10 && img.h > 10, true);
    await page.evaluate(() => { window.__sent = []; window.__ctxDefault = null; });
    await page.mouse.click(img.x, img.y, { button: 'right' });
    await settled(page);
    same('right-click on the picture asks for no TypoZen menu', (await menuMsgs()).length, 0);
    same("and the browser's menu is left to open", await page.evaluate(() => window.__ctxDefault), true);
    b = await lineBox(0);
    await page.mouse.click(b.x + 20, b.y + b.height / 2, { button: 'right' });
    await settled(page);
    same('control: right-click on the text beside it still gets the TypoZen menu', (await menuMsgs()).length, 1);

    console.log('\n=== the Menu key: the menu opens at the caret ===');
    await load('First line\nSecond line here');
    b = await lineBox(1);
    await page.mouse.click(b.x + 30, b.y + b.height / 2);
    await new Promise(r => setTimeout(r, 1100));   // well past the last right mousedown
    await page.evaluate(() => { window.__sent = []; });
    await page.keyboard.press('ContextMenu');
    await settled(page);
    msgs = await menuMsgs();
    if (!msgs.length) {
        // Headless Chromium may not turn the key into a contextmenu event. Raise the event
        // the key raises, with no right mousedown before it.
        await page.evaluate(() => {
            const el = document.querySelector('#editor .block[data-model-index="1"]');
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 0 }));
        });
        msgs = await menuMsgs();
        console.log('  ..   the ContextMenu key raised no event headless; dispatched the event instead');
    }
    const kb = msgs.length ? JSON.parse(msgs[0].slice('format_menu:'.length)) : {};
    const caret = await page.evaluate(() => {
        const r = getSelection().getRangeAt(0).cloneRange(); r.collapse(false);
        const q = r.getClientRects()[0] || r.getBoundingClientRect();
        return [Math.round(q.left * devicePixelRatio), Math.round(q.bottom * devicePixelRatio)];
    });
    same("it carries the caret's point", JSON.stringify(kb.at), JSON.stringify(caret));
    same('premise: the caret is not at the top left', caret[0] > 0 && caret[1] > 0, true);

    console.log("\n=== a code file: TypoZen's menu, clipboard only ===");
    await load('int x = 1;', 'cs', 'source');
    const cm = await page.$('#source-cm .cm-content');
    b = await cm.boundingBox();
    await page.mouse.click(b.x + 10, b.y + 8, { button: 'right' });
    await settled(page);
    same('a .cs file asks for the menu with md: false', JSON.stringify(await menuMsgs()), JSON.stringify(['format_menu:{"md":false}']));
    same("and the browser's menu is cancelled", await page.evaluate(() => window.__ctxDefault), false);

    console.log('\n=== Ctrl+1..6 ===');
    await load('Title line\nSecond');
    b = await lineBox(0);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.keyboard.down('Control'); await page.keyboard.press('Digit2'); await page.keyboard.up('Control');
    await settled(page);
    same('Ctrl+2 makes a level 2 heading', await saved(), '## Title line\nSecond');
    b = await lineBox(0);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.keyboard.down('Control'); await page.keyboard.press('Digit2'); await page.keyboard.up('Control');
    await settled(page);
    same('Ctrl+2 again: normal text', await saved(), 'Title line\nSecond');
    b = await lineBox(1);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.keyboard.down('Control'); await page.keyboard.down('Alt');
    await page.keyboard.press('Digit2');
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await settled(page);
    same('Ctrl+Alt+2 (AltGr) changes nothing', await saved(), 'Title line\nSecond');

    console.log('\n=== every paragraph format puts a collapsed caret at the end of the block ===');
    const caretAtStart = () => page.evaluate(() => {
        const el = document.querySelector('#editor .block[data-model-index="0"]');
        focusBlock(el, 0);
    });
    const isCaretCollapsed = () => page.evaluate(() => { const s = getSelection(); return !!s && s.isCollapsed; });

    await load('Keep this heading\nSecond');
    await caretAtStart();
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('h2'); });
    await settled(page);
    same('heading from offset 0 leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('typing after heading appends at the end', await saved(), '## Keep this heading!\nSecond');

    await load('Keep this quote\nSecond');
    await caretAtStart();
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('quote'); });
    await settled(page);
    same('quote from offset 0 leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('typing after quote appends at the end', await saved(), '> Keep this quote!\nSecond');

    await load('## Keep this normal\nSecond');
    await caretAtStart();
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('para'); });
    await settled(page);
    same('normal text from offset 0 leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('typing after normal text appends at the end', await saved(), 'Keep this normal!\nSecond');

    await load('Keep this callout\nSecond');
    await caretAtStart();
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('callout:note'); });
    await settled(page);
    same('callout from offset 0 leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('typing after callout appends at the end', await saved(), '> [!NOTE]\n> Keep this callout!\n\nSecond');

    await load('Keep this list\nSecond');
    await caretAtStart();
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('list'); });
    await settled(page);
    await new Promise(r => setTimeout(r, 60));
    same('list from offset 0 leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('typing after list appends at the end', await saved(), '- Keep this list!\nSecond');

    await load('First line\nSecond line');
    await page.evaluate(() => {
        const b0 = document.querySelector('#editor .block[data-model-index="0"]');
        const b1 = document.querySelector('#editor .block[data-model-index="1"]');
        const t0 = document.createTreeWalker(b0, NodeFilter.SHOW_TEXT).nextNode();
        const t1 = document.createTreeWalker(b1, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t0, 0); r.setEnd(t1, t1.nodeValue.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('h2'); });
    await settled(page);
    await new Promise(r => setTimeout(r, 60));
    same('multi-block heading leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('typing after multi-block heading appends to the last altered block', await saved(), '## First line\n## Second line!');

    await load('Before part after');
    await page.evaluate(() => {
        const el = document.querySelector('#editor .block[data-model-index="0"]');
        const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t, 7); r.setEnd(t, 11);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('h2'); });
    await settled(page);
    same('partial selection + heading leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('partial selection + heading formats the entire block and appends at the end', await saved(), '## Before part after!');

    await load('Before part after');
    await page.evaluate(() => {
        const el = document.querySelector('#editor .block[data-model-index="0"]');
        const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t, 7); r.setEnd(t, 11);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('quote'); });
    await settled(page);
    same('partial selection + quote leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('partial selection + quote formats the entire block and appends at the end', await saved(), '> Before part after!');

    await load('## Before part after');
    await page.evaluate(() => {
        const el = document.querySelector('#editor .block[data-model-index="0"]');
        const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t, 7); r.setEnd(t, 11);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('quote'); });
    await settled(page);
    same('partial selection in heading + quote leaves a collapsed caret', await isCaretCollapsed(), true);
    await page.keyboard.type('!');
    await settled(page);
    same('partial selection in heading + quote converts the entire block and appends at the end', await saved(), '> Before part after!');

    await load('Source heading\nSecond', 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(0, 0); });
    await page.evaluate(() => { applyFormatting('h2'); });
    await settled(page);
    same('Source heading leaves a collapsed caret', await page.evaluate(() => sourceEditor.selectionStart === sourceEditor.selectionEnd), true);
    await page.keyboard.type('!');
    await settled(page);
    same('typing after Source heading appends at the end', await saved(), '## Source heading!\nSecond');

    await load('Chain test');
    await caretAtStart();
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('h2'); });
    await settled(page);
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('callout:note'); });
    await settled(page);
    same('chained menu format sees updated block rather than stale freeze', await saved(), '> [!NOTE]\n> ## Chain test');

    console.log('\n=== Undo and Redo of paragraph formats keep a collapsed caret at the end of the block ===');
    const DOC_U = 'First line\nSecond line here\nThird line';
    const settleQuick = async () => {
        await page.evaluate(() => {
            window.__tzTick = false;
            setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => { window.__tzTick = true; })), 25);
        });
        await untilPage(page, () => window.__tzTick === true, 3000);
    };
    const loadQuick = async (md, ext, mode) => {
        await page.evaluate((m, x, mo) => {
            setSourceDocExt(x);
            loadMarkdownContent(m);
            if (state.mode !== mo) handleCommand('view_set:mode:' + mo);
        }, md, ext || 'md', mode || 'wysiwyg');
        await settleQuick();
    };
    const undoSnap = () => page.evaluate(() => {
        const s = getSelection();
        if (state.mode === 'source') {
            return { mode: 'source', start: sourceEditor.selectionStart, end: sourceEditor.selectionEnd };
        }
        const blk = s && s.anchorNode ? getAncestorBlock(s.anchorNode) : null;
        const off = blk ? getPlainOffsetsInBlock(blk) : null;
        return {
            collapsed: !!(s && s.isCollapsed),
            blkIdx: blk ? blk.getAttribute('data-model-index') : null,
            blkLen: blk ? (blk.textContent || '').length : null,
            off: off ? [off.start, off.end] : null
        };
    });
    const focusAt = (bi, off) => page.evaluate((i, o) => {
        const el = document.querySelector('#editor .block[data-model-index="' + i + '"]');
        focusBlock(el, o);
        snapshotFormatSelectionFromEditor();
    }, bi, off);
    const selectPart = (bi, a, z) => page.evaluate((i, s0, s1) => {
        const el = document.querySelector('#editor .block[data-model-index="' + i + '"]');
        const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t, s0); r.setEnd(t, s1);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        snapshotFormatSelectionFromEditor();
        cacheInlineSelection();
    }, bi, a, z);
    const selectBlocks = (bi0, bi1) => page.evaluate((i0, i1) => {
        const b0 = document.querySelector('#editor .block[data-model-index="' + i0 + '"]');
        const b1 = document.querySelector('#editor .block[data-model-index="' + i1 + '"]');
        const t0 = document.createTreeWalker(b0, NodeFilter.SHOW_TEXT).nextNode();
        const t1 = document.createTreeWalker(b1, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t0, 0); r.setEnd(t1, t1.nodeValue.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        snapshotFormatSelectionFromEditor();
    }, bi0, bi1);
    const checkEndCaret = (st, wantIdx, label) => {
        same(label + ' collapsed at end of block ' + wantIdx,
            st.collapsed && st.blkIdx === String(wantIdx) && st.off && st.off[0] === st.blkLen && st.off[1] === st.blkLen,
            true);
    };

    for (const [cmd, preDoc, wantUndoIdx, wantRedoIdx, wantPostDoc] of [
        ['h2', DOC_U, 1, 1, 'First line\n## Second line here\nThird line'],
        ['quote', DOC_U, 1, 1, 'First line\n> Second line here\nThird line'],
        ['para', 'First line\n## Second line here\nThird line', 1, 1, DOC_U],
        ['callout:note', DOC_U, 1, 2, 'First line\n> [!NOTE]\n> Second line here\n\nThird line'],
        ['list', DOC_U, 1, 1, 'First line\n- Second line here\nThird line'],
        ['ol', DOC_U, 1, 1, 'First line\n1. Second line here\nThird line'],
        ['checklist', DOC_U, 1, 1, 'First line\n- [ ] Second line here\nThird line']
    ]) {
        await loadQuick(preDoc);
        await focusAt(1, 5);
        await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
        await settleQuick();
        same(cmd + ' format doc matches', await saved(), wantPostDoc);
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        same(cmd + ' Undo restores preDoc', await saved(), preDoc);
        checkEndCaret(await undoSnap(), wantUndoIdx, cmd + ' Undo');
        await page.evaluate(() => HistoryManager.redo());
        await settleQuick();
        same(cmd + ' Redo restores postDoc', await saved(), wantPostDoc);
        checkEndCaret(await undoSnap(), wantRedoIdx, cmd + ' Redo');
        await page.keyboard.type('!');
        await settleQuick();
        same(cmd + ' typing after Redo appends at end of block', await saved(),
            wantPostDoc.replace('Second line here', 'Second line here!'));
    }

    for (const [cmd, wantRedoIdx, wantPostDoc] of [
        ['h2', 1, '## First line\n## Second line here\nThird line'],
        ['quote', 1, '> First line\n> Second line here\nThird line'],
        ['callout:note', 2, '> [!NOTE]\n> First line\n> Second line here\n\nThird line'],
        ['list', 1, '- First line\n- Second line here\nThird line']
    ]) {
        await loadQuick(DOC_U);
        await selectBlocks(0, 1);
        await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
        await settleQuick();
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        checkEndCaret(await undoSnap(), 1, 'multi ' + cmd + ' Undo');
        await page.evaluate(() => HistoryManager.redo());
        await settleQuick();
        checkEndCaret(await undoSnap(), wantRedoIdx, 'multi ' + cmd + ' Redo');
        same('multi ' + cmd + ' Redo doc', await saved(), wantPostDoc);
    }

    for (const [cmd, wantRedoIdx] of [['h2', 1], ['quote', 1], ['callout:note', 2]]) {
        await loadQuick(DOC_U);
        await selectPart(1, 7, 11);
        await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
        await settleQuick();
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        checkEndCaret(await undoSnap(), 1, 'partial ' + cmd + ' Undo');
        await page.evaluate(() => HistoryManager.redo());
        await settleQuick();
        checkEndCaret(await undoSnap(), wantRedoIdx, 'partial ' + cmd + ' Redo');
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        await page.keyboard.type('!');
        await settleQuick();
        same('partial ' + cmd + ' typing after Undo appends at end', await saved(), 'First line\nSecond line here!\nThird line');
    }

    await loadQuick(DOC_U);
    await selectPart(1, 7, 11);
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('bold'); });
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const boldU = await undoSnap();
    same('inline bold Undo places collapsed caret at span end (11)', boldU.collapsed && boldU.blkIdx === '1' && boldU.off[0] === 11, true);
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const boldR = await undoSnap();
    same('inline bold Redo places collapsed caret at span end (11)', boldR.collapsed && boldR.blkIdx === '1' && boldR.off[0] === 11, true);

    await loadQuick(DOC_U, 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(16, 16); applyFormatting('h2'); });
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const srcH2U = await undoSnap();
    same('Source h2 Undo places caret at end of restored line (27)', srcH2U.start === 27 && srcH2U.end === 27, true);
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const srcH2R = await undoSnap();
    same('Source h2 Redo places caret at end of heading line (30)', srcH2R.start === 30 && srcH2R.end === 30, true);

    await loadQuick(DOC_U, 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(16, 16); applyFormatting('callout:note'); });
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const srcCoU = await undoSnap();
    same('Source callout Undo places caret at end of restored line (27)', srcCoU.start === 27 && srcCoU.end === 27, true);
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const srcCoR = await undoSnap();
    same('Source callout Redo places caret at end of body line (39)', srcCoR.start === 39 && srcCoR.end === 39, true);

    // 1. Cross-mode Undo / Redo (Source <-> Preview)
    await loadQuick(DOC_U, 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(16, 16); applyFormatting('h2'); });
    await settleQuick();
    await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const s2pU = await undoSnap();
    const s2pEdActive = await page.evaluate(() => {
        const ed = document.getElementById('editor');
        return document.activeElement === ed || (ed && ed.contains(document.activeElement));
    });
    same('Source h2 -> Preview Undo focuses Preview editor (not hidden Source)', s2pEdActive, true);
    checkEndCaret(s2pU, 1, 'Source h2 -> Preview Undo');
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    checkEndCaret(await undoSnap(), 1, 'Source h2 -> Preview Redo');
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    await page.keyboard.type('!');
    await settleQuick();
    same('Source h2 -> Preview Undo then typing appends at end', await saved(), 'First line\nSecond line here!\nThird line');

    await loadQuick('Alpha beta', 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(10, 10); });
    await page.keyboard.type('XYZ');
    await page.evaluate(() => HistoryManager.snapshot(true));
    await settleQuick();
    await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const s2pTypeFocus = await page.evaluate(() => {
        const ed = document.getElementById('editor');
        return document.activeElement === ed || (ed && ed.contains(document.activeElement));
    });
    same('Source typing -> Preview Undo focuses Preview editor', s2pTypeFocus, true);
    await page.keyboard.type('!');
    await settleQuick();
    same('Source typing -> Preview Undo then typing works in Preview', await saved(), 'Alpha beta!');

    for (const [cmd, wantRedoStart] of [['h2', 30], ['callout:note', 39]]) {
        await loadQuick(DOC_U, 'md', 'wysiwyg');
        await focusAt(1, 5);
        await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
        await settleQuick();
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await settleQuick();
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        const p2sU = await undoSnap();
        same('Preview ' + cmd + ' -> Source Undo places caret at end of restored line (27)', p2sU.start === 27 && p2sU.end === 27, true);
        await page.evaluate(() => HistoryManager.redo());
        await settleQuick();
        const p2sR = await undoSnap();
        same('Preview ' + cmd + ' -> Source Redo places caret at end of formatted line (' + wantRedoStart + ')',
            p2sR.start === wantRedoStart && p2sR.end === wantRedoStart, true);
    }

    // 2. Source inline bold Undo / Redo & Preview multi-block inline Undo / Redo
    await loadQuick(DOC_U, 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(18, 22); applyFormatting('bold'); });
    await settleQuick();
    same('Source inline bold doc matches', await saved(), 'First line\nSecond **line** here\nThird line');
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const srcBoldU = await undoSnap();
    same('Source inline bold Undo places collapsed caret at end of original word (22)', srcBoldU.start === 22 && srcBoldU.end === 22, true);
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const srcBoldR = await undoSnap();
    same('Source inline bold Redo places collapsed caret after closing ** (26)', srcBoldR.start === 26 && srcBoldR.end === 26, true);

    await loadQuick('First line here\nSecond line tail', 'md', 'wysiwyg');
    await page.evaluate(() => {
        const b0 = document.querySelector('#editor .block[data-model-index="0"]');
        const b1 = document.querySelector('#editor .block[data-model-index="1"]');
        const t0 = document.createTreeWalker(b0, NodeFilter.SHOW_TEXT).nextNode();
        const t1 = document.createTreeWalker(b1, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange();
        r.setStart(t0, 6);
        r.setEnd(t1, 11);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        snapshotFormatSelectionFromEditor();
        if (typeof snapshotMultiBlockSelectionFromLive === 'function') snapshotMultiBlockSelectionFromLive();
        cacheInlineSelection();
        freezeFormatSelection();
        applyFormatting('bold');
    });
    await settleQuick();
    same('Preview multi-block partial inline bold doc matches', await saved(), 'First **line here**\n**Second line** tail');
    const mbBoldF = await undoSnap();
    same('Preview multi-block inline bold Format places caret at span end on block 1 (11)',
        mbBoldF.collapsed && mbBoldF.blkIdx === '1' && mbBoldF.off[0] === 11 && mbBoldF.off[1] === 11, true);
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const mbBoldU = await undoSnap();
    same('Preview multi-block inline bold Undo places caret at span end on block 1 (11)',
        mbBoldU.collapsed && mbBoldU.blkIdx === '1' && mbBoldU.off[0] === 11, true);
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const mbBoldR = await undoSnap();
    same('Preview multi-block inline bold Redo places caret at span end on block 1 (11)',
        mbBoldR.collapsed && mbBoldR.blkIdx === '1' && mbBoldR.off[0] === 11, true);

    for (const mode of ['wysiwyg', 'source']) {
        await loadQuick('First line\n\nSecond line', 'md', mode);
        if (mode === 'wysiwyg') {
            await focusAt(0, 3);
            await page.evaluate(() => { freezeFormatSelection(); applyFormatting('bold'); });
        } else {
            await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(3, 3); applyFormatting('bold'); });
        }
        await settleQuick();
        same(mode + ' collapsed bold toggles whole line', await saved(), '**First line**\n\nSecond line');
        const cb1 = await undoSnap();
        same(mode + ' collapsed bold leaves end-of-line caret',
            mode === 'source' ? (cb1.start === 14 && cb1.end === 14) : (cb1.collapsed && cb1.blkIdx === '0' && cb1.off[0] === 10), true);
        await page.evaluate(() => applyFormatting('bold'));
        await settleQuick();
        same(mode + ' collapsed bold toggles whole line off', await saved(), 'First line\n\nSecond line');
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        same(mode + ' collapsed bold Undo restores bold line', await saved(), '**First line**\n\nSecond line');
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        same(mode + ' collapsed bold Undo x2 restores plain', await saved(), 'First line\n\nSecond line');
        const cb2 = await undoSnap();
        same(mode + ' collapsed bold Undo x2 leaves end-of-line caret',
            mode === 'source' ? (cb2.start === 10 && cb2.end === 10) : (cb2.collapsed && cb2.blkIdx === '0' && cb2.off[0] === 10), true);
        if (mode === 'wysiwyg') {
            await focusAt(1, 0);
            await page.evaluate(() => { freezeFormatSelection(); applyFormatting('bold'); });
        } else {
            await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(11, 11); applyFormatting('bold'); });
        }
        await settleQuick();
        same(mode + ' collapsed bold on empty line is a no-op', await saved(), 'First line\n\nSecond line');
    }

    // 3. Shift+Enter block formatting keeps caret on the formatted line (not trailing line)
    await loadQuick('FirstSecond', 'md', 'wysiwyg');
    await focusAt(0, 5);
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
    await settleQuick();
    await focusAt(0, 2);
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('h2'); });
    await settleQuick();
    same('Shift+Enter line 0 h2 formats only line 0', await saved(), '## First\nSecond');
    checkEndCaret(await undoSnap(), 0, 'Shift+Enter line 0 h2 Format');
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    same('Shift+Enter h2 Undo restores original block', await saved(), 'First\nSecond');
    checkEndCaret(await undoSnap(), 0, 'Shift+Enter h2 Undo');
    await loadQuick('plain', 'md', 'wysiwyg');

    console.log('\n=== Alt underlines the menus\' access keys while held ===');
    await load('Some text');
    b = await lineBox(0);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    const cues = () => page.evaluate(() => window.__sent.filter(m => m.indexOf('alt_cues:') === 0));
    await page.evaluate(() => { window.__sent = []; });
    await page.keyboard.down('Alt');
    same('Alt down asks for the underlines', JSON.stringify(await cues()), JSON.stringify(['alt_cues:1']));
    await page.keyboard.up('Alt');
    same('Alt up takes them away', JSON.stringify(await cues()), JSON.stringify(['alt_cues:1', 'alt_cues:0']));
    await page.evaluate(() => { window.__sent = []; });
    await page.keyboard.down('Control'); await page.keyboard.down('Alt');
    same('not for AltGr (Ctrl+Alt)', JSON.stringify(await cues()), JSON.stringify([]));
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');

    console.log('\n=== a read-only view or a text field takes no formatting ===');
    const chord = async (key) => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); await settled(page); };
    await load('Plain line here\n## Head');
    b = await lineBox(0);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await page.evaluate(() => handleCommand('view_set:mode:reader'));
    await settled(page);
    same('premise: Reader made the document read-only', await page.evaluate(() => document.getElementById('editor').isContentEditable), false);
    await chord('Digit2'); await chord('KeyB');
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('callout:note'); });
    await settled(page);
    same('Ctrl+2, Ctrl+B and Callout change nothing in Reader', await saved(), 'Plain line here\n## Head');
    await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
    await settled(page);
    b = await lineBox(0);
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    await chord('Digit3');
    same('control: back in Preview, Ctrl+3 makes a heading', await saved(), '### Plain line here\n## Head');
    await page.evaluate(() => handleCommand('toggle_search_sidebar'));
    await settled(page);
    await page.evaluate(() => { const i = document.getElementById('sidebarSearchInput'); i.focus(); });
    same('premise: the sidebar search box has the keyboard', await page.evaluate(() => document.activeElement && document.activeElement.id), 'sidebarSearchInput');
    await chord('KeyB'); await chord('Digit1');
    same('Ctrl+B and Ctrl+1 typed in the search box leave the document alone', await saved(), '### Plain line here\n## Head');
    // The Link dialog's Enter is a text field's key too, and must still make the link.
    await load('word here');
    b = await lineBox(0);
    await page.mouse.move(b.x + 2, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 3 }); await page.mouse.up();
    await page.evaluate(() => hideSelPop());
    await chord('KeyK');
    await page.waitForSelector('#linkModal:not([hidden])', { timeout: 3000 });
    await page.focus('#linkModalHref');
    await page.keyboard.type('https://x.com');
    await page.keyboard.press('Enter');
    await settled(page);
    const linked = await saved();
    same('the Link dialog: Enter in the address makes the link', /^\[wo[^\]]*\]\(https:\/\/x\.com\)/.test(linked), true);

    console.log('\n=== the selection popup: reading tools only ===');
    await load('Some words here');
    b = await lineBox(0);
    await dragSelect(b);
    same('premise: the popup is up', await popShown(), true);
    const pop = await page.evaluate(() => {
        const shown = (id) => {
            const e = document.getElementById(id);
            if (!e || e.hidden) return false;
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };
        return {
            reading: ['selPopFind', 'selPopRead', 'selPopReadFromHere', 'selPopMark', 'selPopSearchWeb'].filter(shown),
            formatting: ['selPopBold', 'selPopItalic', 'selPopStrike', 'selPopCode', 'selPopLink', 'selPopMore', 'selPopOverflow']
                .filter(id => document.getElementById(id))
        };
    });
    same('the popup shows the reading tools, Search web among them', pop.reading.join(','),
        'selPopFind,selPopRead,selPopReadFromHere,selPopMark,selPopSearchWeb');
    same('and no formatting and no More', pop.formatting.join(','), '');
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
