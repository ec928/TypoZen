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

    // The caret stays where the user put it (Ed, 2026-11-21; it went to the end of the line
    // until 0.21.16). tests/caret-stays-browser.mjs attacks the rule; these are the plain cases.
    console.log('\n=== every paragraph format leaves the caret where it was ===');
    const caretAt5 = () => page.evaluate(() => {
        const el = document.querySelector('#editor .block[data-model-index="0"]');
        focusBlock(el, 5);
    });
    const isCaretCollapsed = () => page.evaluate(() => { const s = getSelection(); return !!s && s.isCollapsed; });
    // The selection's two ends as line:offset in the text the line shows.
    const selEnds = () => page.evaluate(() => {
        const s = getSelection();
        const pt = (n, o) => {
            const b = n && getAncestorBlock(n);
            if (!b) return 'none';
            const r = document.createRange(); r.selectNodeContents(b); r.setEnd(n, o);
            return b.getAttribute('data-model-index') + ':' + r.toString().length;
        };
        return s.rangeCount ? pt(s.anchorNode, s.anchorOffset) + '..' + pt(s.focusNode, s.focusOffset) : 'none';
    });

    for (const [cmd, doc, want] of [
        ['h2', 'Keep this heading\nSecond', '## Keep !this heading\nSecond'],
        ['quote', 'Keep this quote\nSecond', '> Keep !this quote\nSecond'],
        ['para', '## Keep this normal\nSecond', 'Keep !this normal\nSecond'],
        ['callout:note', 'Keep this callout\nSecond', '> [!NOTE]\n> Keep !this callout\n\nSecond'],
        ['list', 'Keep this list\nSecond', '- Keep !this list\nSecond']
    ]) {
        await load(doc);
        await caretAt5();
        await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
        await settled(page);
        same(cmd + ' leaves a collapsed caret', await isCaretCollapsed(), true);
        await page.keyboard.type('!');
        await settled(page);
        same(cmd + ': the next letter goes where the caret was, five characters in', await saved(), want);
    }

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
    same('multi-block heading keeps the selection', await selEnds(), '0:0..1:11');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('!');
    await settled(page);
    same('and it is the selection: Right goes to its end', await saved(), '## First line\n## Second line!');

    for (const [cmd, doc, want] of [
        ['h2', 'Before part after', '## Before ! after'],
        ['quote', 'Before part after', '> Before ! after'],
        ['quote', '## Before part after', '> Before ! after']
    ]) {
        await load(doc);
        await page.evaluate(() => {
            const el = document.querySelector('#editor .block[data-model-index="0"]');
            const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
            const r = document.createRange(); r.setStart(t, 7); r.setEnd(t, 11);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        });
        await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
        await settled(page);
        same('partial selection in "' + doc + '" + ' + cmd + ' keeps the same word selected', await selEnds(), '0:7..0:11');
        await page.keyboard.type('!');
        await settled(page);
        same('partial selection in "' + doc + '" + ' + cmd + ' formats the whole line; typing replaces the word', await saved(), want);
    }

    await load('Source heading\nSecond', 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(0, 0); });
    await page.evaluate(() => { applyFormatting('h2'); });
    await settled(page);
    same('Source heading leaves a collapsed caret', await page.evaluate(() => sourceEditor.selectionStart === sourceEditor.selectionEnd), true);
    await page.keyboard.type('!');
    await settled(page);
    same('Source: a caret at the start of the line stays at the start of its text', await saved(), '## !Source heading\nSecond');

    await load('Chain test');
    await caretAt5();
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('h2'); });
    await settled(page);
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('callout:note'); });
    await settled(page);
    same('chained menu format sees updated block rather than stale freeze', await saved(), '> [!NOTE]\n> ## Chain test');

    console.log('\n=== Undo puts the caret back where it was before a paragraph format, Redo where it was after ===');
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
    const checkCaret = (st, wantIdx, wantOff, label) => {
        same(label + ' collapsed at ' + wantIdx + ':' + wantOff,
            st.collapsed && st.blkIdx === String(wantIdx) && st.off && st.off[0] === wantOff && st.off[1] === wantOff,
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
        checkCaret(await undoSnap(), wantUndoIdx, 5, cmd + ' Undo');
        await page.evaluate(() => HistoryManager.redo());
        await settleQuick();
        same(cmd + ' Redo restores postDoc', await saved(), wantPostDoc);
        checkCaret(await undoSnap(), wantRedoIdx, 5, cmd + ' Redo');
        await page.keyboard.type('!');
        await settleQuick();
        same(cmd + ' typing after Redo goes in at the caret', await saved(),
            wantPostDoc.replace('Second line here', 'Secon!d line here'));
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
        same('multi ' + cmd + ' Undo restores the selection', await selEnds(), '0:0..1:16');
        await page.evaluate(() => HistoryManager.redo());
        await settleQuick();
        same('multi ' + cmd + ' Redo restores the selection after the format', await selEnds(),
            (wantRedoIdx - 1) + ':0..' + wantRedoIdx + ':16');
        same('multi ' + cmd + ' Redo doc', await saved(), wantPostDoc);
    }

    for (const [cmd, wantRedoIdx] of [['h2', 1], ['quote', 1], ['callout:note', 2]]) {
        await loadQuick(DOC_U);
        await selectPart(1, 7, 11);
        await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
        await settleQuick();
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        same('partial ' + cmd + ' Undo restores the word selected', await selEnds(), '1:7..1:11');
        await page.evaluate(() => HistoryManager.redo());
        await settleQuick();
        same('partial ' + cmd + ' Redo selects the same word', await selEnds(), wantRedoIdx + ':7..' + wantRedoIdx + ':11');
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        await page.keyboard.type('!');
        await settleQuick();
        same('partial ' + cmd + ' typing after Undo replaces the selected word', await saved(), 'First line\nSecond ! here\nThird line');
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
    // 16 is "Secon|d": after "## " it is 19.
    const srcH2U = await undoSnap();
    same('Source h2 Undo puts the caret back where it was (16)', srcH2U.start === 16 && srcH2U.end === 16, true);
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const srcH2R = await undoSnap();
    same('Source h2 Redo puts it at the same point in the heading (19)', srcH2R.start === 19 && srcH2R.end === 19, true);

    await loadQuick(DOC_U, 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(16, 16); applyFormatting('callout:note'); });
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    // After "> [!NOTE]\n" and "> ", "Secon|d" is at 11 + 10 + 2 + 5 = 28.
    const srcCoU = await undoSnap();
    same('Source callout Undo puts the caret back where it was (16)', srcCoU.start === 16 && srcCoU.end === 16, true);
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const srcCoR = await undoSnap();
    same('Source callout Redo puts it at the same point in the box (28)', srcCoR.start === 28 && srcCoR.end === 28, true);

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
    checkCaret(s2pU, 1, 5, 'Source h2 -> Preview Undo');
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    checkCaret(await undoSnap(), 1, 5, 'Source h2 -> Preview Redo');
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    await page.keyboard.type('!');
    await settleQuick();
    same('Source h2 -> Preview Undo then typing goes in at the caret', await saved(), 'First line\nSecon!d line here\nThird line');

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

    for (const [cmd, wantRedoStart] of [['h2', 19], ['callout:note', 28]]) {
        await loadQuick(DOC_U, 'md', 'wysiwyg');
        await focusAt(1, 5);
        await page.evaluate((c) => { freezeFormatSelection(); applyFormatting(c); }, cmd);
        await settleQuick();
        await page.evaluate(() => handleCommand('view_set:mode:source'));
        await settleQuick();
        await page.evaluate(() => HistoryManager.undo());
        await settleQuick();
        const p2sU = await undoSnap();
        same('Preview ' + cmd + ' -> Source Undo puts the caret back where it was (16)', p2sU.start === 16 && p2sU.end === 16, true);
        await page.evaluate(() => HistoryManager.redo());
        await settleQuick();
        const p2sR = await undoSnap();
        same('Preview ' + cmd + ' -> Source Redo puts it at the same point in the formatted line (' + wantRedoStart + ')',
            p2sR.start === wantRedoStart && p2sR.end === wantRedoStart, true);
    }

    // Regression: late sticky-restore timers across mode switches never steal a placed caret.
    await loadQuick(DOC_U, 'md', 'source');
    await page.evaluate(() => {
        setSourceDocExt('md');
        loadMarkdownContent('First line\nSecond line here\nThird line');
        if (state.mode !== 'wysiwyg') handleCommand('view_set:mode:wysiwyg');
        const el = document.querySelector('#editor .block[data-model-index="1"]');
        focusBlock(el, 5);
        snapshotFormatSelectionFromEditor();
    });
    await new Promise(r => setTimeout(r, 85));
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('callout:note'); });
    await settleQuick();
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const r1U = await undoSnap();
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const r1R = await undoSnap();
    same('Race 1 regression: Source -> Preview immediate caret survives 48ms timer across callout Undo (16) and Redo (28)',
        r1U.start === 16 && r1U.end === 16 && r1R.start === 28 && r1R.end === 28, true);

    await loadQuick(DOC_U, 'md', 'wysiwyg');
    await focusAt(1, 5);
    await page.evaluate(() => {
        freezeFormatSelection();
        applyFormatting('callout:note');
        handleCommand('view_set:mode:source');
        sourceEditor.setSelectionRange(28, 28);
    });
    await new Promise(r => setTimeout(r, 60));
    const r2S = await undoSnap();
    same('Race 2 regression: Preview callout -> immediate Source caret stays at 28 across 20ms paint timer',
        r2S.start === 28 && r2S.end === 28, true);

    // 2. Source inline bold/italic selection span + Undo / Redo & Preview multi-block inline Undo / Redo
    await loadQuick(DOC_U, 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(18, 22); applyFormatting('bold'); });
    await settleQuick();
    same('Source inline bold doc matches', await saved(), 'First line\nSecond **line** here\nThird line');
    const srcBoldSel1 = await undoSnap();
    // Only the word stays selected, inside its markers, as in Preview (0.21.13).
    same('Source inline bold keeps ONLY the word selected, inside **...** (20..24)', srcBoldSel1.start === 20 && srcBoldSel1.end === 24, true);
    await page.evaluate(() => applyFormatting('bold'));
    await settleQuick();
    same('Source inline bold second toggle restores original line', await saved(), DOC_U);
    const srcBoldSel2 = await undoSnap();
    same('Source inline bold toggle-off keeps ONLY line selected (18..22)', srcBoldSel2.start === 18 && srcBoldSel2.end === 22, true);
    await page.evaluate(() => { applyFormatting('bold'); applyFormatting('italic'); });
    await settleQuick();
    same('Source inline bold then italic wraps span cleanly', await saved(), 'First line\nSecond ***line*** here\nThird line');
    const srcItalicSel = await undoSnap();
    same('Source inline bold+italic keeps ONLY the word selected, inside ***...*** (21..25)', srcItalicSel.start === 21 && srcItalicSel.end === 25, true);
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const srcBoldU = await undoSnap();
    same('Source inline Undo 1 restores **line** with caret at the word end (24)',
        (await saved()) === 'First line\nSecond **line** here\nThird line' && srcBoldU.start === 24 && srcBoldU.end === 24, true);
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const srcBoldU2 = await undoSnap();
    same('Source inline Undo 2 restores DOC_U with caret at original word end (22)',
        (await saved()) === DOC_U && srcBoldU2.start === 22 && srcBoldU2.end === 22, true);

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
        // At the end of the line, inside the closing marker, in both views (0.21.13).
        same(mode + ' collapsed bold leaves end-of-line caret',
            mode === 'source' ? (cb1.start === 12 && cb1.end === 12) : (cb1.collapsed && cb1.blkIdx === '0' && cb1.off[0] === 10), true);
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
    checkCaret(await undoSnap(), 0, 2, 'Shift+Enter line 0 h2 Format');
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    same('Shift+Enter h2 Undo restores original block', await saved(), 'First\nSecond');
    checkCaret(await undoSnap(), 0, 2, 'Shift+Enter h2 Undo');

    // 4. Insert Table leaves collapsed caret at start of Header 1 in both Source and Preview
    await loadQuick('Intro', 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(5, 5); insertMarkdownTable(2, 1); });
    await settleQuick();
    const tblSrcC = await undoSnap();
    same('Source Insert Table leaves collapsed caret at Header 1',
        tblSrcC.start === tblSrcC.end && (await page.evaluate((p) => sourceEditor.value.slice(p, p + 8), tblSrcC.start)) === 'Header 1', true);
    await page.keyboard.type('X');
    await settleQuick();
    same('Source typing after Insert Table inserts into Header 1 (does not overwrite table)',
        (await saved()).includes('| XHeader 1 | Header 2 |'), true);
    await loadQuick('Intro', 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(5, 5); insertMarkdownTable(2, 1); });
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const tblSrcU = await undoSnap();
    same('Source Insert Table Undo restores doc and caret 5',
        (await saved()) === 'Intro' && tblSrcU.start === 5 && tblSrcU.end === 5, true);

    await loadQuick('Intro', 'md', 'wysiwyg');
    await focusAt(0, 5);
    await page.evaluate(() => { state.targetTableBlock = document.querySelector('#editor .block[data-model-index="0"]'); insertMarkdownTable(2, 1); });
    await settleQuick();
    const tblPvC = await undoSnap();
    // At the start of the first header cell: offset 0 of the block itself is outside the
    // grid, and the first key typed there left the table (fixed in 0.21.12).
    const inHeader = await page.evaluate(() => {
        const s = getSelection(); const n = s && s.anchorNode;
        const el = n && (n.nodeType === 1 ? n : n.parentElement);
        const th = el && el.closest && el.closest('th');
        return !!(s && s.isCollapsed && th && th === document.querySelector('#editor .block[data-model-index="1"] thead th') && s.anchorOffset === 0);
    });
    same('Preview Insert Table leaves a collapsed caret at the start of the first header cell',
        tblPvC.blkIdx === '1' && inHeader, true);
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const tblPvU = await undoSnap();
    same('Preview Insert Table Undo restores doc and block 0 offset 5',
        (await saved()) === 'Intro' && tblPvU.collapsed && tblPvU.blkIdx === '0' && tblPvU.off[0] === 5, true);
    await loadQuick('plain', 'md', 'wysiwyg');

    console.log('\n=== keys pressed for real: Source word formats, Insert Table then type ===');
    for (const [key, shift, want] of [['KeyB', false, 'Hello **world** tail'], ['KeyI', false, 'Hello *world* tail'], ['KeyX', true, 'Hello ~~world~~ tail']]) {
        await loadQuick('Hello world tail', 'md', 'source');
        await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(6, 6); });
        await page.keyboard.down('Shift'); for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
        await page.keyboard.down('Control'); if (shift) await page.keyboard.down('Shift');
        await page.keyboard.press(key);
        if (shift) await page.keyboard.up('Shift'); await page.keyboard.up('Control');
        await settled(page);
        const sel = await page.evaluate(() => sourceEditor.value.slice(sourceEditor.selectionStart, sourceEditor.selectionEnd));
        same('Source ' + key + ' on a selected word: only the word stays selected (' + JSON.stringify(sel) + ')',
            (await saved()) === want && sel.replace(/[*~]/g, '') === 'world', true);
    }
    for (const mode of ['source', 'wysiwyg']) {
        await loadQuick('Intro', 'md', mode);
        if (mode === 'source') await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(5, 5); });
        else { b = await lineBox(0); await page.mouse.click(b.x + 200, b.y + b.height / 2); await page.keyboard.press('End'); }
        await page.evaluate(() => { freezeFormatSelection(); applyFormatting('table'); });   // the host's fmt:table
        await settled(page);
        const cell = await page.evaluate(() => {
            const cs = [...document.querySelectorAll('#tableSizePicker .tz-table-picker-cell')];
            const r = cs[11].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.move(cell.x, cell.y); await page.mouse.click(cell.x, cell.y);
        await settled(page);
        await page.keyboard.type('X');
        await settled(page);
        same(mode + ': typing after Insert Table goes into the first header cell',
            (await saved()).indexOf('Intro\n| XHeader 1 | Header 2 |') === 0, true);
    }

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

    console.log('\n=== menu Copy and Cut extract and mutate even after focus left to the menu ===');
    await loadQuick('Three ways to see single word here', 'md', 'wysiwyg');
    await selectPart(0, 18, 24);
    await page.evaluate(() => { window.getSelection().removeAllRanges(); });
    const pvCopy = await page.evaluate(() => tzMenuCopyOrCut(false));
    same('Preview blurred Copy extracts exact text ("single")', pvCopy.text, 'single');
    same('Preview blurred Copy carries typozen HTML marker', /data-source="typozen"/.test(pvCopy.html), true);
    same('Preview Copy leaves document intact', await saved(), 'Three ways to see single word here');

    await selectPart(0, 18, 24);
    await page.evaluate(() => { window.getSelection().removeAllRanges(); });
    const pvCut = await page.evaluate(() => tzMenuCopyOrCut(true));
    await settleQuick();
    same('Preview blurred Cut extracts exact text ("single")', pvCut.text, 'single');
    same('Preview blurred Cut deletes selection from document', await saved(), 'Three ways to see  word here');

    await loadQuick('Alpha line\nBeta line\nGamma line', 'md', 'wysiwyg');
    await selectBlocks(0, 1);
    await page.evaluate(() => { window.getSelection().removeAllRanges(); });
    const mbCopy = await page.evaluate(() => tzMenuCopyOrCut(false));
    same('Preview blurred multi-block Copy gets both lines', mbCopy.text, 'Alpha line\nBeta line');
    const mbCut = await page.evaluate(() => tzMenuCopyOrCut(true));
    await settleQuick();
    same('Preview blurred multi-block Cut extracts both lines and leaves third', mbCut.text === 'Alpha line\nBeta line' && (await saved()) === '\nGamma line', true);

    await loadQuick('Alpha line\nBeta line', 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(11, 15); sourceEditor.blur && sourceEditor.blur(); });
    const srcCopy = await page.evaluate(() => tzMenuCopyOrCut(false));
    same('Source Copy gets "Beta" with empty html', srcCopy.text === 'Beta' && srcCopy.html === '', true);
    const srcCut = await page.evaluate(() => tzMenuCopyOrCut(true));
    await settleQuick();
    same('Source Cut removes "Beta"', srcCut.text === 'Beta' && (await saved()) === 'Alpha line\n line', true);

    console.log('\n=== paste over selection keeps trailing space and replaces the word; collapsed/Reader/Find Copy ===');
    await loadQuick('Three ways to see single word here', 'md', 'wysiwyg');
    await selectPart(0, 18, 24);
    await page.evaluate(() => pasteLikeCtrlV('', 'REPLACED', false));
    await settleQuick();
    same('Plain paste over selected word keeps trailing space', await saved(), 'Three ways to see REPLACED word here');

    await loadQuick('Three ways to see single word here', 'md', 'wysiwyg');
    await selectPart(0, 18, 24);
    await page.evaluate(() => pasteLikeCtrlV('<b>boldword</b>', 'boldword', false));
    await settleQuick();
    same('Rich HTML paste over selected word replaces it cleanly', await saved(), 'Three ways to see **boldword** word here');

    await loadQuick('Three ways to see single word here', 'md', 'wysiwyg');
    await selectPart(0, 18, 24);
    await page.evaluate(() => pasteLikeCtrlV('', '**boldword**', true));
    await settleQuick();
    same('Markdown paste-as-plain over selected word replaces it cleanly', await saved(), 'Three ways to see **boldword** word here');

    await loadQuick('Three ways to see single word here', 'md', 'wysiwyg');
    await selectPart(0, 18, 24);
    await page.evaluate(() => {
        rememberEditorCaret();
        const b = document.querySelector('#editor .block[data-model-index="0"]');
        const t = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t, 18); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        document.getElementById('editor').blur();
    });
    const colBlurCopy = await page.evaluate(() => tzMenuCopyOrCut(false));
    same('Preview collapsed-on-blur Copy recovers "single"', colBlurCopy.text, 'single');

    await loadQuick('Three ways to see single word here', 'md', 'reader');
    await page.evaluate(() => {
        const b = document.querySelector('#editor .block[data-model-index="0"]');
        const t = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t, 18); r.setEnd(t, 24);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        rememberEditorCaret();
        s.removeAllRanges();
    });
    const rdrCopy = await page.evaluate(() => tzMenuCopyOrCut(false));
    same('Reader blurred Copy recovers "single"', rdrCopy.text, 'single');

    await loadQuick('Alpha beta', 'md', 'wysiwyg');
    await page.evaluate(() => {
        openFindBar();
        const i = document.getElementById('findInput');
        i.focus(); i.value = 'needle'; i.setSelectionRange(0, 6);
        i.blur();
    });
    const findCopy = await page.evaluate(() => tzMenuCopyOrCut(false));
    same('Find bar blurred Copy recovers "needle"', findCopy.text, 'needle');
    const findCut = await page.evaluate(() => tzMenuCopyOrCut(true));
    const findValAfter = await page.evaluate(() => document.getElementById('findInput').value);
    same('Find bar blurred Cut removes "needle"', findCut.text === 'needle' && findValAfter === '', true);
    await page.evaluate(() => {
        const i = document.getElementById('findInput');
        i.focus(); i.value = 'abc'; i.setSelectionRange(1, 2); i.blur();
    });
    await page.evaluate(() => pasteLikeCtrlV('<b>XYZ</b>', 'XYZ', false));
    const findPaste = await page.evaluate(() => ({ val: document.getElementById('findInput').value, doc: getMarkdownContent(false) }));
    same('Find bar blurred rich Paste puts plain text into Find input only',
        findPaste.val === 'aXYZc' && findPaste.doc === 'Alpha beta', true);
    await page.evaluate(() => {
        const i = document.getElementById('findInput');
        i.focus(); i.value = 'hello'; i.setSelectionRange(2, 2); i.blur();
        handleCommand('select_all');
    });
    const findSelAll = await page.evaluate(() => {
        const i = document.getElementById('findInput');
        return [i.selectionStart, i.selectionEnd];
    });
    same('Find bar blurred Select All selects #findInput', findSelAll[0] === 0 && findSelAll[1] === 5, true);
    await page.evaluate(() => { if (typeof closeFindBar === 'function') closeFindBar(); });

    console.log('\n=== Link empty-sel caret, code-file paste, and cross-mode selection Undo/Redo ===');
    for (const mode of ['wysiwyg', 'source']) {
        await loadQuick('Hello world', 'md', mode);
        if (mode === 'source') await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(6, 6); });
        else await focusAt(0, 6);
        await page.evaluate(() => { freezeFormatSelection(); applyFormatting('link'); });
        await page.waitForSelector('#linkModal:not([hidden])', { timeout: 3000 });
        await page.focus('#linkModalText'); await page.keyboard.type('docs');
        await page.focus('#linkModalHref'); await page.keyboard.type('https://a.test');
        await page.keyboard.press('Enter');
        await settleQuick();
        await page.keyboard.type('!');
        await settleQuick();
        same(mode + ' Link with nothing selected leaves caret after link text', await saved(), 'Hello [docs](https://a.test)!world');
    }

    await loadQuick('int x = 1;', 'cs', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(10, 10); });
    await page.evaluate(() => pasteLikeCtrlV('<span style="font-weight:bold">int</span> <b>y</b> = 2;', 'int y = 2;', false));
    same('Code file (.cs) rich HTML paste stays plain text', await saved(), 'int x = 1;int y = 2;');

    await loadQuick('First line\nSecond line here\nThird line', 'md', 'wysiwyg');
    await selectPart(1, 0, 6);
    await page.evaluate(() => { freezeFormatSelection(); applyFormatting('h2'); });
    await settleQuick();
    await page.evaluate(() => handleCommand('view_set:mode:source'));
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const xmU = await page.evaluate(() => sourceEditor.value.slice(sourceEditor.selectionStart, sourceEditor.selectionEnd));
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const xmR = await page.evaluate(() => sourceEditor.value.slice(sourceEditor.selectionStart, sourceEditor.selectionEnd));
    same('Preview partial sel h2 -> Source Undo & Redo keeps "Second" selected', xmU === 'Second' && xmR === 'Second', true);

    await loadQuick('First line\nSecond line here\nThird line', 'md', 'source');
    await page.evaluate(() => { sourceEditor.focus(); sourceEditor.setSelectionRange(11, 17); applyFormatting('h2'); });
    await settleQuick();
    await page.evaluate(() => handleCommand('view_set:mode:wysiwyg'));
    await settleQuick();
    await page.evaluate(() => HistoryManager.undo());
    await settleQuick();
    const xm2U = await page.evaluate(() => ({ col: getSelection().isCollapsed, txt: getSelection().toString() }));
    await page.evaluate(() => HistoryManager.redo());
    await settleQuick();
    const xm2R = await page.evaluate(() => ({ col: getSelection().isCollapsed, txt: getSelection().toString() }));
    same('Source partial sel h2 -> Preview Undo & Redo keeps "Second" selected',
        !xm2U.col && xm2U.txt === 'Second' && !xm2R.col && xm2R.txt === 'Second', true);
} finally {
    await browser.close();
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
