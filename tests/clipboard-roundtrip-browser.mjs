/**
 * Copy something in TypoZen, paste it back, get the same thing.
 *
 * The most basic operation in an editor, and it had no test that went through the actual
 * clipboard handlers. The existing coverage called insertPastedPlainText() directly, which
 * skips the copy handler, skips the DataTransfer, and skips the branch that decides whether
 * the clipboard came from TypoZen or from somewhere else -- which is precisely where the
 * bug was. It reported green while copying four lines and pasting them produced four lines
 * with a blank between each.
 *
 * So this dispatches real copy and paste events carrying a real DataTransfer, and asserts
 * on the document afterwards. Nothing is called directly.
 *
 *   node tests/clipboard-roundtrip-browser.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** Copy a range of blocks and paste it after another, through the real event handlers. */
function roundTrip(fromIdx, toIdx, afterIdx) {
    const q = (i) => document.querySelector('.block[data-model-index="' + i + '"]');
    const a = q(fromIdx), z = q(toIdx), target = q(afterIdx);
    if (!a || !z || !target) return { ok: false, why: 'blocks not mounted' };

    const source = DocumentModel.blocks.slice(fromIdx, toIdx + 1).map(b => b.raw);

    const rg = document.createRange();
    rg.setStart(a, 0);
    rg.setEnd(z, z.childNodes.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rg);

    // A real copy event, with a real DataTransfer for the handler to write into.
    const dt = new DataTransfer();
    const copyEv = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copyEv, 'clipboardData', { value: dt });
    document.getElementById('editor').dispatchEvent(copyEv);

    const clipPlain = dt.getData('text/plain');
    const clipHtml = dt.getData('text/html');

    // Put the caret at the end of the target block and paste the same DataTransfer back.
    focusBlock(target, (target.innerText || '').length);
    const before = DocumentModel.blocks.length;
    const pasteEv = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEv, 'clipboardData', { value: dt });
    document.getElementById('editor').dispatchEvent(pasteEv);

    return {
        ok: true,
        source: source,
        clipPlain: clipPlain,
        clipHtmlHead: String(clipHtml).slice(0, 120),
        markedAsOurs: String(clipHtml).indexOf('data-source="typozen"') !== -1,
        added: DocumentModel.blocks.length - before,
        after: DocumentModel.blocks.slice(afterIdx, afterIdx + (toIdx - fromIdx) + 2).map(b => b.raw)
    };
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message); });

        const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').split(path.sep).join('/');
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

        // A small document, so every block is mounted and this is about the clipboard only.
        const doc = [
            'alpha one',
            'beta two',
            'gamma **three**',
            'delta `four`',
            '',
            'epsilon five',
            'zeta six'
        ].join('\n');
        await page.evaluate(m => loadMarkdownContent(m), doc);
        await settled(page);

        const before = await page.evaluate(() => DocumentModel.blocks.map(b => b.raw));
        info('document: ' + JSON.stringify(before));

        console.log('\n=== copy four consecutive lines, paste them back ===');
        const r = await page.evaluate(roundTrip, 0, 3, 5);
        assert(r.ok, 'the blocks under test are mounted' + (r.ok ? '' : ' -- ' + r.why));
        if (!r.ok) { console.log('\npassed=' + passed + ' failed=' + failed); process.exitCode = 1; return; }

        info('clipboard text/plain: ' + JSON.stringify(r.clipPlain));
        info('clipboard text/html : ' + JSON.stringify(r.clipHtmlHead));
        info('pasted region       : ' + JSON.stringify(r.after));

        assert(r.clipPlain === r.source.join('\n'),
            'the clipboard carries exactly the markdown of the copied blocks');
        assert(r.markedAsOurs,
            'the clipboard HTML is marked as TypoZen’s own, so paste uses the plain text');

        // The heart of it: four lines in, four lines out.
        assert(r.added === r.source.length - 1,
            'pasting ' + r.source.length + ' lines adds ' + (r.source.length - 1) +
            ' blocks, not more (' + r.added + ')');

        const pastedRegion = r.after.slice(0, r.source.length);
        const blanks = pastedRegion.filter(x => !String(x).trim()).length;
        assert(blanks === 0,
            'no blank line is invented between the pasted lines (' + blanks +
            ' in ' + JSON.stringify(pastedRegion) + ')');

        assert(pastedRegion.some(x => /\*\*three\*\*/.test(x)),
            'inline markdown survives the round trip rather than arriving as plain words');

        console.log('\n=== the document is otherwise untouched ===');
        const after = await page.evaluate(() => DocumentModel.blocks.map(b => b.raw));
        // The caret block keeps its text and gains the first pasted line, which is what a
        // paste at the end of a line means -- so look for the original text as a prefix,
        // not as a whole block.
        const joined = after.join('\n');
        const removed = before.filter(x => x.trim() && joined.indexOf(x) === -1);
        assert(removed.length === 0,
            'nothing that was in the document before has gone (' +
            JSON.stringify(removed.slice(0, 3)) + ')');

        // --- Select all, on a document the DOM only partly holds.
        //
        // Ctrl+A selects the editor's CONTENTS, and under virtualisation those contents are
        // a window onto the document, not the document. Walking the mounted blocks put 2,797
        // characters of a 205,842-character file on the clipboard -- 1% -- with nothing to
        // say so. Copy is no more allowed to be a projection of the document than saving is.
        // The failure Ed hit in amazon.md: select several paragraphs, copy, click a
        // caret somewhere else, paste. The old range was still remembered, so the paste
        // deleted it and wrote the clipboard back over the same lines. Nothing appeared
        // at the caret, and the cursor jumped to the end of the old selection.
        console.log('\n=== paste at a moved caret inserts there ===');
        await page.evaluate(() => loadMarkdownContent([
            '### Scenario',
            '',
            '**The Focus:** Scaling governance.',
            '',
            '- **Situation:** Sit one.',
            '- **Task:** Task two.',
            '- **Action:** Action three.',
            '- **Result:** Result four.',
            '',
            'After.'
        ].join('\n')));
        await settled(page);
        const moved = await page.evaluate(async () => {
            const blocks = () => Array.from(document.querySelectorAll('#editor .block'));
            const sit = blocks().find(b => (b.getAttribute('data-raw') || '').includes('Sit one'));
            const res = blocks().find(b => (b.getAttribute('data-raw') || '').includes('Result four'));
            const focus = blocks().find(b => (b.getAttribute('data-raw') || '').startsWith('**The Focus:**'));
            const rg = document.createRange();
            rg.setStart(sit, 0);
            rg.setEnd(res, res.childNodes.length);
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(rg);
            await new Promise(r => setTimeout(r, 60));
            const dt = new DataTransfer();
            const copyEv = new Event('copy', { bubbles: true, cancelable: true });
            Object.defineProperty(copyEv, 'clipboardData', { value: dt });
            document.getElementById('editor').dispatchEvent(copyEv);
            focusBlock(focus, (focus.innerText || '').length);
            await new Promise(r => setTimeout(r, 60));
            const pasteEv = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(pasteEv, 'clipboardData', { value: dt });
            document.getElementById('editor').dispatchEvent(pasteEv);
            const raws = DocumentModel.blocks.map(b => b.raw);
            const s = getSelection();
            let caret = { where: 'none' };
            if (s && s.rangeCount && s.anchorNode) {
                const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
                const b = el && el.closest ? el.closest('#editor .block') : null;
                if (b) {
                    const pre = document.createRange();
                    pre.selectNodeContents(b);
                    pre.setEnd(s.anchorNode, s.anchorOffset);
                    const off = pre.toString().length;
                    const vis = b.innerText || '';
                    caret = {
                        raw: b.getAttribute('data-raw'),
                        off: off,
                        atEnd: off === vis.length,
                        before: vis.slice(Math.max(0, off - 24), off)
                    };
                }
            }
            return { raws: raws, caret: caret };
        });
        info('after moved paste: ' + JSON.stringify(moved.raws));
        info('caret: ' + JSON.stringify(moved.caret));
        const sitCount = moved.raws.filter(x => String(x).includes('Sit one')).length;
        assert(sitCount === 2,
            'the copied paragraphs stay, and a second copy is inserted (' + sitCount + ')');
        assert(String(moved.raws[2] || '').indexOf('**The Focus:**') === 0
            && String(moved.raws[2]).includes('Sit one'),
            'the paste starts at the caret, on the Focus line (' + JSON.stringify(moved.raws[2]) + ')');
        const resultBlocks = moved.raws.filter(x => String(x).includes('Result four'));
        assert(resultBlocks.length === 2, 'both Result lines are present');
        assert(moved.caret && moved.caret.atEnd && String(moved.caret.raw).includes('Result four')
            && String(moved.caret.before).indexOf('Result four') >= 0,
            'the caret is after the pasted block, as in Notepad (' + JSON.stringify(moved.caret) + ')');
        // The original four lines are still below the insert, not replaced by it.
        assert(moved.raws.filter(x => String(x) === '- **Task:** Task two.').length === 2,
            'the original Task line was not overwritten');

        console.log('\n=== paste at the start of a line keeps order and caret ===');
        const atStart = await page.evaluate(() => {
            loadMarkdownContent('**The Focus:** Scaling governance.\n\nKeep me.\n');
            const block = Array.from(document.querySelectorAll('#editor .block'))
                .find(b => (b.innerText || '').includes('Keep me'));
            const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = tw.nextNode())) {
                const i = n.data.indexOf('Keep');
                if (i < 0) continue;
                const r = document.createRange();
                r.setStart(n, i);
                r.collapse(true);
                const s = getSelection();
                s.removeAllRanges();
                s.addRange(r);
                break;
            }
            const dt = new DataTransfer();
            dt.setData('text/plain', 'AAA\nBBB\n');
            const ev = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'clipboardData', { value: dt });
            document.getElementById('editor').dispatchEvent(ev);
            const raws = DocumentModel.blocks.map(b => b.raw);
            const s = getSelection();
            let caret = null;
            if (s && s.rangeCount && s.anchorNode) {
                const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
                const b = el && el.closest ? el.closest('#editor .block') : null;
                if (b) {
                    const pre = document.createRange();
                    pre.selectNodeContents(b);
                    pre.setEnd(s.anchorNode, s.anchorOffset);
                    caret = { raw: b.getAttribute('data-raw'), off: pre.toString().length };
                }
            }
            return { raws: raws, caret: caret };
        });
        info('start-of-line paste: ' + JSON.stringify(atStart));
        const keepAt = atStart.raws.findIndex(x => String(x).includes('Keep me'));
        const aaaAt = atStart.raws.findIndex(x => String(x) === 'AAA');
        const bbbAt = atStart.raws.findIndex(x => String(x) === 'BBB');
        assert(aaaAt >= 0 && bbbAt === aaaAt + 1 && keepAt === bbbAt + 1,
            'AAA, BBB, then Keep me, in that order (' + JSON.stringify(atStart.raws) + ')');
        assert(atStart.caret && String(atStart.caret.raw).includes('Keep me') && atStart.caret.off === 0,
            'the caret is after the pasted lines, before the text that was there (' +
            JSON.stringify(atStart.caret) + ')');

        console.log('\n=== delete after moving the caret does not remove the old selection ===');
        const del = await page.evaluate(async () => {
            loadMarkdownContent([
                'Alpha line.',
                '- **Situation:** Sit one.',
                '- **Task:** Task two.',
                'Omega line.'
            ].join('\n'));
            const blocks = () => Array.from(document.querySelectorAll('#editor .block'));
            const sit = blocks().find(b => (b.getAttribute('data-raw') || '').includes('Sit one'));
            const task = blocks().find(b => (b.getAttribute('data-raw') || '').includes('Task two'));
            const omega = blocks().find(b => (b.getAttribute('data-raw') || '').startsWith('Omega'));
            const rg = document.createRange();
            rg.setStart(sit, 0);
            rg.setEnd(task, task.childNodes.length);
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(rg);
            await new Promise(r => setTimeout(r, 60));
            focusBlock(omega, 0);
            await new Promise(r => setTimeout(r, 60));
            const ev = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
            document.getElementById('editor').dispatchEvent(ev);
            return DocumentModel.blocks.map(b => b.raw);
        });
        info('after delete at caret: ' + JSON.stringify(del));
        assert(del.some(x => String(x).includes('Sit one')) && del.some(x => String(x).includes('Task two')),
            'the paragraphs that were selected earlier are still there (' + JSON.stringify(del) + ')');

        console.log('\n=== cut with only a caret deletes nothing ===');
        const caretCut = await page.evaluate(() => {
            loadMarkdownContent('Alpha line.\nBeta line.\n');
            const b = document.querySelector('#editor .block');
            focusBlock(b, (b.innerText || '').length);
            const dt = new DataTransfer();
            const ev = new Event('cut', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'clipboardData', { value: dt });
            document.getElementById('editor').dispatchEvent(ev);
            return { raws: DocumentModel.blocks.map(x => x.raw), plain: dt.getData('text/plain') };
        });
        assert(caretCut.raws[0] === 'Alpha line.' && caretCut.raws[1] === 'Beta line.' && caretCut.plain === '',
            'a cut with no selection leaves the line and the clipboard (' + JSON.stringify(caretCut) + ')');

        console.log('\n=== paste at the start of a marked line keeps the marker ===');
        const marked = await page.evaluate(() => {
            loadMarkdownContent('## Heading line\n> Quote line\n- List one\n- [ ] Task one\n');
            function atStart(needle) {
                const block = Array.from(document.querySelectorAll('#editor .block'))
                    .find(b => (b.getAttribute('data-raw') || '').indexOf(needle) >= 0);
                focusBlock(block, 0);
                const dt = new DataTransfer();
                dt.setData('text/plain', 'AAA\nBBB\n');
                const ev = new Event('paste', { bubbles: true, cancelable: true });
                Object.defineProperty(ev, 'clipboardData', { value: dt });
                document.getElementById('editor').dispatchEvent(ev);
                return DocumentModel.blocks.map(x => x.raw);
            }
            const heading = atStart('Heading line');
            loadMarkdownContent('## Heading line\n> Quote line\n- List one\n- [ ] Task one\n');
            const quote = atStart('Quote line');
            loadMarkdownContent('## Heading line\n> Quote line\n- List one\n- [ ] Task one\n');
            const list = atStart('List one');
            loadMarkdownContent('## Heading line\n> Quote line\n- List one\n- [ ] Task one\n');
            const task = atStart('Task one');
            return { heading: heading, quote: quote, list: list, task: task };
        });
        info('marked pastes: ' + JSON.stringify(marked));
        function markerKept(raws, original) {
            const aaa = raws.indexOf('AAA');
            const bbb = raws.indexOf('BBB');
            const line = raws.indexOf(original);
            return aaa >= 0 && bbb === aaa + 1 && line === bbb + 1;
        }
        assert(markerKept(marked.heading, '## Heading line'),
            'a heading keeps its marker (' + JSON.stringify(marked.heading) + ')');
        assert(markerKept(marked.quote, '> Quote line'),
            'a quote keeps its marker (' + JSON.stringify(marked.quote) + ')');
        assert(markerKept(marked.list, '- List one'),
            'a list item keeps its marker (' + JSON.stringify(marked.list) + ')');
        assert(markerKept(marked.task, '- [ ] Task one'),
            'a task keeps its marker (' + JSON.stringify(marked.task) + ')');

        console.log('\n=== select all copies the document, not the window ===');
        // A BIG document, loaded here on purpose.
        //
        // The document above is seven lines, so every block is mounted and this assertion
        // would hold however broken the copy path was -- a test that cannot fail is worse
        // than no test, because it reads as cover. The fault needs a DOM that is a window:
        // virtualisation engages around 2000 blocks.
        await page.evaluate(() => {
            const big = [];
            for (let i = 0; i < 3000; i++) {
                big.push('Paragraph ' + i + ' with enough words in it to occupy a line or so.');
            }
            loadMarkdownContent(big.join('\n\n'));
        });
        await settled(page);

        const all = await page.evaluate(() => {
            const ed = document.getElementById('editor');
            const range = document.createRange();
            range.selectNodeContents(ed);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return {
                virt: !!DocumentModel.virtEnabled,
                mounted: ed.querySelectorAll('.block').length,
                modelBlocks: DocumentModel.blocks.length,
                copied: selectionToPlainText().length,
                whole: DocumentModel.toMarkdown().length
            };
        });
        info(all.mounted + ' of ' + all.modelBlocks + ' blocks mounted (virt ' + all.virt +
             '); select-all copied ' + all.copied + ' of ' + all.whole + ' chars');
        // The premise first: if the DOM holds everything, the assertion below proves nothing.
        assert(all.virt && all.mounted < all.modelBlocks,
            'the document is virtualised, so the DOM really is a window (' +
            all.mounted + ' of ' + all.modelBlocks + ')');
        assert(all.copied === all.whole,
            'select all copies every character of the document (' +
            all.copied + ' of ' + all.whole + ')');

        // And the same question of the save path, which is the one with a file at stake.
        const saved = await page.evaluate(() => getMarkdownContent(false).length);
        assert(saved === all.whole,
            'and what would be saved is the whole document too (' + saved + ')');

        console.log('\n=== select all cut takes the document, not the window ===');
        const cut = await page.evaluate(() => {
            const ed = document.getElementById('editor');
            const range = document.createRange();
            range.selectNodeContents(ed);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            const before = DocumentModel.toMarkdown();
            const virtBefore = !!DocumentModel.virtEnabled;
            const mountedBefore = ed.querySelectorAll('.block').length;
            const modelBefore = DocumentModel.blocks.length;
            const dt = new DataTransfer();
            const ev = new Event('cut', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'clipboardData', { value: dt });
            ed.dispatchEvent(ev);
            return {
                virtBefore: virtBefore,
                mountedBefore: mountedBefore,
                modelBefore: modelBefore,
                clip: dt.getData('text/plain').length,
                wholeBefore: before.length,
                after: DocumentModel.toMarkdown().length,
                modelBlocks: DocumentModel.blocks.length
            };
        });
        info('cut clipboard ' + cut.clip + ' of ' + cut.wholeBefore +
            '; model now ' + cut.after + ' chars, ' + cut.modelBlocks + ' blocks');
        assert(cut.virtBefore && cut.mountedBefore < cut.modelBefore,
            'cut ran on a windowed document (' + cut.mountedBefore + ' of ' + cut.modelBefore + ')');
        assert(cut.clip === cut.wholeBefore,
            'select all cut copies every character (' + cut.clip + ' of ' + cut.wholeBefore + ')');
        assert(cut.after === 0 || cut.modelBlocks <= 1,
            'and the model is emptied rather than left holding the rest of the file');

        console.log('\n=== export HTML is the document, not the window ===');
        // Reload a virtualised document — the cut above emptied it.
        await page.evaluate(() => {
            const big = [];
            for (let i = 0; i < 3000; i++) {
                big.push('Paragraph ' + i + ' with enough words in it to occupy a line or so.');
            }
            loadMarkdownContent(big.join('\n\n'));
        });
        await settled(page);
        const exp = await page.evaluate(() => {
            const html = generateExportHtml();
            const n = (html.match(/class="block"/g) || []).length;
            return {
                virt: !!DocumentModel.virtEnabled,
                mounted: document.getElementById('editor').querySelectorAll('.block').length,
                modelBlocks: DocumentModel.blocks.length,
                exportedBlocks: n
            };
        });
        info('export ' + exp.exportedBlocks + ' blocks; mounted ' + exp.mounted +
            ' of ' + exp.modelBlocks);
        assert(exp.virt && exp.mounted < exp.modelBlocks,
            'export runs against a windowed DOM (' + exp.mounted + ' of ' + exp.modelBlocks + ')');
        assert(exp.exportedBlocks === exp.modelBlocks,
            'export HTML contains every model block (' + exp.exportedBlocks +
            ' of ' + exp.modelBlocks + ')');

        console.log('\n=== Reveal (F7) paste keeps Markdown ===');
        const revealPaste = await page.evaluate(() => {
            state.revealOnFocus = true;
            try {
                loadMarkdownContent('## Heading two here');
                const b = document.querySelector('#editor .block');
                const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = tw.nextNode())) {
                    const idx = n.data.indexOf(' here');
                    if (idx >= 0) {
                        const r = document.createRange();
                        r.setStart(n, idx);
                        r.collapse(true);
                        const s = getSelection();
                        s.removeAllRanges();
                        s.addRange(r);
                        break;
                    }
                }
                pasteLikeCtrlV('', 'X', false);
                const afterFirst = getMarkdownContent(false);
                pasteLikeCtrlV('', 'Y', false);
                const afterSecond = getMarkdownContent(false);

                loadMarkdownContent('See [a link](https://x.test) now');
                const lb = document.querySelector('#editor .block');
                const tw2 = document.createTreeWalker(lb, NodeFilter.SHOW_TEXT);
                let ln;
                while ((ln = tw2.nextNode())) {
                    const li = ln.data.indexOf('a link');
                    if (li >= 0) {
                        const r2 = document.createRange();
                        r2.setStart(ln, li);
                        r2.setEnd(ln, li + 1);
                        const s2 = getSelection();
                        s2.removeAllRanges();
                        s2.addRange(r2);
                        break;
                    }
                }
                pasteLikeCtrlV('', 'THE', false);
                const afterLink = getMarkdownContent(false);
                return { afterFirst, afterSecond, afterLink };
            } finally {
                state.revealOnFocus = false;
            }
        });
        assert(revealPaste.afterFirst === '## Heading twoX here',
            'Reveal paste once keeps ## heading (' + JSON.stringify(revealPaste.afterFirst) + ')');
        assert(revealPaste.afterSecond === '## Heading twoXY here',
            'Reveal paste twice keeps ## heading (' + JSON.stringify(revealPaste.afterSecond) + ')');
        assert(revealPaste.afterLink === 'See [THE link](https://x.test) now',
            'Reveal paste inside link keeps link markdown (' + JSON.stringify(revealPaste.afterLink) + ')');

        console.log('\n=== Find-bar checkbox focus does not throw on Edit > Paste / Select All ===');
        const findChk = await page.evaluate(() => {
            openFindBar();
            const inp = document.getElementById('findInput');
            const chk = document.querySelector('#findBar input[type="checkbox"]');
            inp.value = 'abc';
            let threw = false;
            try {
                chk.focus();
                pasteLikeCtrlV('', 'XYZ', false);
                handleCommand('cmd:select_all');
            } catch (e) {
                threw = e && e.message ? e.message : String(e);
            }
            const val = inp.value;
            if (typeof closeFindBar === 'function') closeFindBar();
            return { threw, val };
        });
        assert(!findChk.threw && findChk.val === 'abc',
            'Find checkbox focus neither throws nor edits #findInput (' + JSON.stringify(findChk) + ')');

        console.log('\n=== Source focus clears Find box memory without a click ===');
        const srcClr = await page.evaluate(() => {
            setSourceDocExt('md');
            loadMarkdownContent('one two');
            handleCommand('view_set:mode:source');
            openFindBar();
            const inp = document.getElementById('findInput');
            inp.focus();
            inp.value = 'one';
            inp.setSelectionRange(0, 1);
            sourceEditor.focus();
            sourceEditor.setSelectionRange(7, 7);
            if (typeof rememberEditorCaret === 'function') rememberEditorCaret();
            pasteLikeCtrlV('', ' MENU', false);
            const docVal = sourceEditor.value;
            const findVal = inp.value;
            if (typeof closeFindBar === 'function') closeFindBar();
            handleCommand('view_set:mode:wysiwyg');
            return { docVal, findVal };
        });
        assert(srcClr.docVal === 'one two MENU' && srcClr.findVal === 'one',
            'Source focus routes paste to Source rather than stale Find input (' + JSON.stringify(srcClr) + ')');

        console.log('\n=== Rich-HTML single-line paste keeps leading/trailing spaces ===');
        const richEdge = await page.evaluate(() => {
            setSourceDocExt('md');
            loadMarkdownContent('## Heading two');
            let b = document.querySelector('#editor .block');
            focusBlock(b, 'Heading two'.length);
            pasteLikeCtrlV(' and <b>bold</b>', ' and bold', false);
            const pWithPlain = getMarkdownContent(false);

            loadMarkdownContent('## Heading two');
            b = document.querySelector('#editor .block');
            focusBlock(b, 'Heading two'.length);
            pasteLikeCtrlV(' and <i>ital</i>', '', false);
            const pHtmlOnly = getMarkdownContent(false);

            loadMarkdownContent('## Heading two');
            handleCommand('view_set:mode:source');
            sourceEditor.focus();
            sourceEditor.setSelectionRange('## Heading two'.length, '## Heading two'.length);
            pasteLikeCtrlV(' and <b>bold</b>', ' and bold', false);
            const sWithPlain = sourceEditor.value;

            loadMarkdownContent('One');
            handleCommand('view_set:mode:wysiwyg');
            b = document.querySelector('#editor .block');
            focusBlock(b, 3);
            pasteLikeCtrlV('&nbsp;and <b>bold</b>', '\u00a0and bold', false);
            const pNbspPlain = getMarkdownContent(false);

            loadMarkdownContent('One');
            b = document.querySelector('#editor .block');
            focusBlock(b, 3);
            pasteLikeCtrlV('&nbsp;and <b>bold</b>', '', false);
            const pNbspHtmlOnly = getMarkdownContent(false);

            loadMarkdownContent('## Heading two');
            handleCommand('view_set:mode:source');
            sourceEditor.focus();
            sourceEditor.setSelectionRange('## Heading two'.length, '## Heading two'.length);
            const dtSrc1 = new DataTransfer();
            dtSrc1.setData('text/html', ' and <b>bold</b>');
            dtSrc1.setData('text/plain', ' and bold');
            const evSrc1 = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(evSrc1, 'clipboardData', { value: dtSrc1 });
            sourceEditor.dispatchEvent(evSrc1);
            const sCtrlVLead = sourceEditor.value;

            loadMarkdownContent('Hello world');
            sourceEditor.focus();
            sourceEditor.setSelectionRange(6, 6);
            const dtSrc2 = new DataTransfer();
            dtSrc2.setData('text/html', '<b>big</b>  ');
            dtSrc2.setData('text/plain', 'big  ');
            const evSrc2 = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(evSrc2, 'clipboardData', { value: dtSrc2 });
            sourceEditor.dispatchEvent(evSrc2);
            const sCtrlVTrail = sourceEditor.value;

            handleCommand('view_set:mode:wysiwyg');
            return { pWithPlain, pHtmlOnly, sWithPlain, pNbspPlain, pNbspHtmlOnly, sCtrlVLead, sCtrlVTrail };
        });
        assert(richEdge.pWithPlain === '## Heading two and **bold**',
            'Preview rich-HTML paste keeps leading space (' + JSON.stringify(richEdge.pWithPlain) + ')');
        assert(richEdge.pHtmlOnly === '## Heading two and *ital*',
            'Preview HTML-only paste keeps leading space (' + JSON.stringify(richEdge.pHtmlOnly) + ')');
        assert(richEdge.sWithPlain === '## Heading two and **bold**',
            'Source rich-HTML paste keeps leading space (' + JSON.stringify(richEdge.sWithPlain) + ')');
        assert(richEdge.pNbspPlain === 'One and **bold**',
            'Preview NBSP+plain paste keeps leading space (' + JSON.stringify(richEdge.pNbspPlain) + ')');
        assert(richEdge.pNbspHtmlOnly === 'One and **bold**',
            'Preview NBSP HTML-only paste keeps leading space (' + JSON.stringify(richEdge.pNbspHtmlOnly) + ')');
        assert(richEdge.sCtrlVLead === '## Heading two and **bold**',
            'Source Ctrl+V paste keeps leading space (' + JSON.stringify(richEdge.sCtrlVLead) + ')');
        assert(richEdge.sCtrlVTrail === 'Hello **big**  world',
            'Source Ctrl+V paste keeps trailing double space (' + JSON.stringify(richEdge.sCtrlVTrail) + ')');

        console.log('\npassed=' + passed + ' failed=' + failed);
        if (failed) { console.error('\nCLIPBOARD ROUND TRIP FAILED'); process.exitCode = 1; return; }
        console.log('\nCLIPBOARD ROUND TRIP PASSED');
    } finally {
        await browser.close();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
