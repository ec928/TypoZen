/**
 * The keys a writer presses, pressed for real, in Preview and in Source.
 *
 * TypoZen is a text/Markdown editor, and until 2026-09-30 no test typed into it the way a
 * person does: Tab had never worked in ordinary text, in either view, and every test that
 * pressed it did so in a list item (Ed: "if you missed the TAB key, what other key have
 * you missed?"). Every case here puts the caret somewhere by clicking, presses real keys
 * (page.keyboard -- never the handler), and checks what would be SAVED. Navigation keys
 * are checked by typing a marker after them: where the marker lands is where the caret
 * went.
 *
 *   node tests/keyboard-editing-cases.mjs              all cases
 *   node tests/keyboard-editing-cases.mjs preview      Preview only (also: source, large)
 *
 * The gate runs it as three suites -- keyboard-editing-{preview,source,large}-browser.mjs --
 * so the three parts run in parallel; together they were 109 s, a quarter of the gate.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { sleep } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] || '';

let passed = 0, failed = 0;
const failures = [];
function check(ok, msg, got, want) {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        failures.push(msg);
        console.error('  FAIL ' + msg + '\n         got  ' + JSON.stringify(got) + (want !== undefined ? '\n         want ' + JSON.stringify(want) : ''));
    }
}

const DOC = 'First paragraph here.\n\nThe quick brown fox jumps.\n\nLast line';
const LIST = 'Intro\n\n- one\n- two\n\nOutro';

const browser = await puppeteer.launch({ headless: 'new' });
const ctx = browser.defaultBrowserContext();
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    page.on('pageerror', e => { failed++; failures.push('page threw: ' + e.message); console.error('  FAIL page threw: ' + e.message); });
    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    try { await ctx.overridePermissions('file://', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']); } catch (e) {}
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });

    const kb = page.keyboard;
    const chord = async (mods, key) => {
        for (const m of mods) await kb.down(m);
        await kb.press(key);
        for (const m of mods.slice().reverse()) await kb.up(m);
    };
    const saved = () => page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));

    // ---- placing the caret by clicking -------------------------------------------------
    // Preview: the block holding `lineText`, at character `off` of its visible text.
    async function clickPreview(lineText, off) {
        const pt = await page.evaluate((t, o) => {
            const blocks = editor.querySelectorAll('.block');
            let el = null;
            for (const b of blocks) if ((b.textContent || '').indexOf(t) >= 0) { el = b; break; }
            if (!el) return null;
            const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let n, left = o;
            while ((n = tw.nextNode())) {
                if (left <= n.nodeValue.length) {
                    const r = document.createRange();
                    r.setStart(n, left); r.setEnd(n, left);
                    const b = r.getBoundingClientRect();
                    return { x: b.left + 1, y: b.top + b.height / 2 };
                }
                left -= n.nodeValue.length;
            }
            const b = el.getBoundingClientRect();
            return { x: b.right - 2, y: b.top + b.height / 2 };
        }, lineText, off);
        if (!pt) throw new Error('no block with ' + lineText);
        await page.mouse.click(pt.x, pt.y);
        await sleep(120);
    }
    // Source: the line `n` (0-based), at column `col`.
    async function clickSource(n, col) {
        const pt = await page.evaluate((i, c) => {
            const lines = document.querySelectorAll('.cm-line');
            const l = lines[i];
            const tw = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
            let t, left = c;
            while ((t = tw.nextNode())) {
                if (left <= t.nodeValue.length) {
                    const r = document.createRange(); r.setStart(t, left); r.setEnd(t, left);
                    const b = r.getBoundingClientRect();
                    return { x: b.left + 1, y: b.top + b.height / 2 };
                }
                left -= t.nodeValue.length;
            }
            const b = l.getBoundingClientRect();
            return { x: b.left + 2, y: b.top + b.height / 2 };
        }, n, col);
        await page.mouse.click(pt.x, pt.y);
        await sleep(120);
    }

    async function load(md, mode) {
        await page.evaluate(() => { try { tzSetOverwrite(false); handleCommand('view_set:mode:preview'); } catch (e) {} });
        await page.evaluate((m) => loadMarkdownContent(m), md);
        await sleep(350);
        if (mode === 'source') {
            await page.evaluate(() => handleCommand('view_set:mode:source'));
            await sleep(500);
        }
    }

    // One case: fresh document, click, keys, compare what is saved.
    async function run(mode, name, md, where, keys, want) {
        try {
            await load(md, mode);
            if (mode === 'source') await clickSource(where[0], where[1]);
            else await clickPreview(where[0], where[1]);
            await keys();
            await sleep(250);
            const got = await saved();
            const ok = (typeof want === 'function') ? want(got) : got === want;
            check(ok, mode + ': ' + name, got, typeof want === 'function' ? undefined : want);
        } catch (e) {
            check(false, mode + ': ' + name + ' (threw ' + e.message + ')');
        }
    }

    for (const mode of ['preview', 'source']) {
        if (only && only !== mode) continue;
        console.log('\n=== ' + mode + ' ===');
        const SRC = mode === 'source';
        // where: Preview = [text in the block, char offset]; Source = [line, column]
        const at = (text, off, line) => SRC ? [line, off] : [text, off];
        // Both views keep spaces exactly as typed. (Preview used to collapse a run of
        // spaces and drop a line's leading one; this was the expectation until 2026-09-30.)
        const ws = (g) => g;

        await run(mode, 'letters, digits, punctuation, space', DOC, at('quick', 3, 2),
            () => kb.type(' Hello, world! 123 ?:;\'"()'),
            DOC.replace('The quick', 'The Hello, world! 123 ?:;\'"() quick'));
        await run(mode, 'accented and typographic characters', DOC, at('quick', 3, 2),
            () => kb.type(' café – “quoted” €'),
            DOC.replace('The quick', 'The café – “quoted” € quick'));
        await run(mode, 'Markdown characters typed literally', DOC, at('Last', 4, 4),
            () => kb.type(' # _x_ `y` [z]'),
            DOC.replace('Last line', 'Last # _x_ `y` [z] line'));
        // "The quick": offset 8 is before the k, 9 after it.
        await run(mode, 'Backspace deletes the character before the caret', DOC, at('quick', 9, 2),
            () => kb.press('Backspace'), DOC.replace('quick', 'quic'));
        await run(mode, 'Delete deletes the character after the caret', DOC, at('quick', 8, 2),
            () => kb.press('Delete'), DOC.replace('quick', 'quic'));
        // One line per paragraph in both views: Enter is one newline, as in Notepad.
        await run(mode, 'Enter splits the line and typing continues on the new one', DOC, at('quick', 9, 2),
            async () => { await kb.press('Enter'); await kb.type('X'); },
            // The new line keeps its leading space in both views, as in Notepad. Preview
            // dropped it until 2026-09-30 (Ed: "should NOT drop the damn space").
            DOC.replace('quick brown', 'quick\nX brown'));
        await run(mode, 'Enter at the end of the last line, then type', DOC, at('Last', 9, 4),
            async () => { await kb.press('End'); await kb.press('Enter'); await kb.type('New'); },
            DOC + '\nNew');
        await run(mode, 'Backspace at the start of a line joins it to the one before', DOC, at('Last', 0, 4),
            async () => { await kb.press('Home'); await kb.press('Backspace'); await kb.press('Backspace'); },
            DOC.replace('jumps.\n\nLast', 'jumps.Last'));
        await run(mode, 'Delete at the end of a line joins the next one', DOC, at('quick', 26, 2),
            async () => { await kb.press('End'); await kb.press('Delete'); await kb.press('Delete'); },
            DOC.replace('jumps.\n\nLast', 'jumps.Last'));
        await run(mode, 'Shift+Enter keeps the text', DOC, at('quick', 10, 2),
            async () => { await chord(['Shift'], 'Enter'); await kb.type('X'); },
            (g) => g.indexOf('quick') >= 0 && g.indexOf('X') > g.indexOf('quick') && g.indexOf('brown') > g.indexOf('X'));
        await run(mode, 'Left and Right arrows', DOC, at('quick', 4, 2),
            async () => { await kb.press('ArrowRight'); await kb.press('ArrowRight'); await kb.press('ArrowLeft'); await kb.type('X'); },
            DOC.replace('quick', 'qXuick'));
        await run(mode, 'Down arrow moves to the next paragraph', DOC, at('First', 0, 0),
            async () => { await kb.press('ArrowDown'); await kb.press('ArrowDown'); await kb.press('Home'); await kb.type('X'); },
            DOC.replace('The quick', 'XThe quick'));
        await run(mode, 'Up arrow moves to the paragraph before', DOC, at('Last', 0, 4),
            async () => { await kb.press('ArrowUp'); await kb.press('ArrowUp'); await kb.press('Home'); await kb.type('X'); },
            DOC.replace('The quick', 'XThe quick'));
        await run(mode, 'Home and End', DOC, at('quick', 8, 2),
            async () => { await kb.press('Home'); await kb.type('A'); await kb.press('End'); await kb.type('Z'); },
            DOC.replace('The quick brown fox jumps.', 'AThe quick brown fox jumps.Z'));
        await run(mode, 'Ctrl+Home and Ctrl+End', DOC, at('quick', 8, 2),
            async () => { await chord(['Control'], 'Home'); await kb.type('A'); await chord(['Control'], 'End'); await kb.type('Z'); },
            'A' + DOC + 'Z');
        await run(mode, 'Ctrl+Right and Ctrl+Left jump by word', DOC, at('quick', 4, 2),
            async () => { await chord(['Control'], 'ArrowRight'); await chord(['Control'], 'ArrowRight'); await chord(['Control'], 'ArrowLeft'); await kb.type('X'); },
            (g) => g.indexOf('The quick Xbrown') >= 0 || g.indexOf('The quickX brown') >= 0);
        await run(mode, 'Ctrl+Backspace deletes the word before', DOC, at('quick', 15, 2),
            () => chord(['Control'], 'Backspace'),
            ws(DOC.replace('quick brown', 'quick ')));
        await run(mode, 'Ctrl+Delete deletes the word after', DOC, at('quick', 10, 2),
            () => chord(['Control'], 'Delete'),
            (g) => g.indexOf('The quick fox jumps.') >= 0 || g.indexOf('The quick  fox jumps.') >= 0);
        await run(mode, 'Shift+arrows select, typing replaces the selection', DOC, at('quick', 4, 2),
            async () => { for (let i = 0; i < 5; i++) await chord(['Shift'], 'ArrowRight'); await kb.type('slow'); },
            DOC.replace('quick', 'slow'));
        await run(mode, 'Shift+End then Backspace deletes to the end of the line', DOC, at('quick', 15, 2),
            async () => { await chord(['Shift'], 'End'); await kb.press('Backspace'); },
            DOC.replace('The quick brown fox jumps.', 'The quick brown'));
        await run(mode, 'Ctrl+A then typing replaces everything', DOC, at('quick', 4, 2),
            async () => { await chord(['Control'], 'a'); await kb.type('Fresh'); },
            'Fresh');
        await run(mode, 'Ctrl+Z undoes typing, Ctrl+Y redoes it', DOC, at('quick', 3, 2),
            async () => { await kb.type(' very'); await sleep(700); await chord(['Control'], 'z'); await sleep(300); await chord(['Control'], 'y'); await sleep(300); },
            DOC.replace('The quick', 'The very quick'));
        // The caret comes back where the change was, as in Notepad: typing after a Ctrl+Z
        // carries on there, not at the start of the line (2026-09-30).
        await run(mode, 'after Ctrl+Z, typing carries on where the undone typing was', DOC, at('quick', 3, 2),
            async () => { await kb.type(' very'); await sleep(700); await chord(['Control'], 'z'); await sleep(400); await kb.type('Q'); },
            DOC.replace('The quick', 'TheQ quick'));
        await run(mode, 'after Ctrl+Z of a Backspace, the caret is after the restored letter', DOC, at('quick', 9, 2),
            async () => { await kb.press('Backspace'); await sleep(700); await chord(['Control'], 'z'); await sleep(400); await kb.type('Q'); },
            DOC.replace('The quick', 'The quickQ'));
        await run(mode, 'after Ctrl+Z of a Tab, typing carries on where the tab was', DOC, at('quick', 3, 2),
            async () => { await kb.press('Tab'); await sleep(700); await chord(['Control'], 'z'); await sleep(400); await kb.type('Q'); },
            DOC.replace('The quick', 'TheQ quick'));
        // Whitespace alone is an edit. History used to ignore spaces and tabs at the end of a
        // line, so a Tab on an empty line left the document Unsaved with nothing to undo (Ed,
        // 2026-09-30). The Down arrow lands on the blank line under "First".
        await run(mode, 'Ctrl+Z undoes a Tab on an empty line', DOC, at('First', 0, 0),
            async () => { await kb.press('ArrowDown'); await kb.press('Tab'); await sleep(700); await chord(['Control'], 'z'); await sleep(300); },
            DOC);
        await run(mode, 'Ctrl+Z undoes a Space on an empty line', DOC, at('First', 0, 0),
            async () => { await kb.press('ArrowDown'); await kb.press(' '); await sleep(700); await chord(['Control'], 'z'); await sleep(300); },
            DOC);
        await run(mode, 'Ctrl+Z undoes a Tab at the end of a line', DOC, at('quick', 3, 2),
            async () => { await kb.press('End'); await kb.press('Tab'); await sleep(700); await chord(['Control'], 'z'); await sleep(300); },
            DOC);
        await run(mode, 'Ctrl+Z undoes a Space at the end of a line', DOC, at('quick', 3, 2),
            async () => { await kb.press('End'); await kb.press(' '); await sleep(700); await chord(['Control'], 'z'); await sleep(300); },
            DOC);
        await run(mode, 'Ctrl+Z on its own undoes typing', DOC, at('quick', 3, 2),
            async () => { await kb.type(' very'); await sleep(700); await chord(['Control'], 'z'); await sleep(300); },
            DOC);
        await run(mode, 'Ctrl+X cuts, Ctrl+V pastes', DOC, at('quick', 4, 2),
            async () => {
                for (let i = 0; i < 6; i++) await chord(['Shift'], 'ArrowRight');
                await chord(['Control'], 'x'); await sleep(200);
                await kb.press('End'); await kb.type(' '); await chord(['Control'], 'v'); await sleep(300);
            },
            ws(DOC.replace('The quick brown fox jumps.', 'The brown fox jumps. quick ')));
        await run(mode, 'Ctrl+C copies, Ctrl+V pastes', DOC, at('quick', 4, 2),
            async () => {
                for (let i = 0; i < 5; i++) await chord(['Shift'], 'ArrowRight');
                await chord(['Control'], 'c'); await sleep(200);
                await kb.press('End'); await kb.type(' '); await chord(['Control'], 'v'); await sleep(300);
            },
            DOC.replace('The quick brown fox jumps.', 'The quick brown fox jumps. quick'));
        // Several lines pasted inside a line split it, and the caret ends where the paste did.
        // Until 0.16.32 Preview left the rest of the line on the first line ("The onequick
        // brown fox jumps." then "two"), and dropped a break the clipboard text started with.
        await run(mode, 'Ctrl+V of two lines mid-line splits the line', DOC, at('quick', 4, 2),
            async () => {
                await page.evaluate(() => navigator.clipboard.writeText('one\ntwo'));
                await chord(['Control'], 'v'); await sleep(300); await kb.type('Z');
            },
            (g) => /The one\n+twoZquick brown fox jumps\./.test(g));
        await run(mode, 'Ctrl+V of text starting with a line break starts a new line', DOC, at('quick', 3, 2),
            async () => {
                await page.evaluate(() => navigator.clipboard.writeText('\nuno'));
                await kb.press('End'); await chord(['Control'], 'v'); await sleep(300); await kb.type('Z');
            },
            (g) => /The quick brown fox jumps\.\n+unoZ\n/.test(g));
        if (!SRC) {
            await run(mode, 'Ctrl+B bolds the selection', DOC, at('quick', 4, 2),
                async () => { for (let i = 0; i < 5; i++) await chord(['Shift'], 'ArrowRight'); await chord(['Control'], 'b'); await sleep(300); },
                DOC.replace('quick', '**quick**'));
            await run(mode, 'Ctrl+I italicises the selection', DOC, at('quick', 4, 2),
                async () => { for (let i = 0; i < 5; i++) await chord(['Shift'], 'ArrowRight'); await chord(['Control'], 'i'); await sleep(300); },
                DOC.replace('quick', '*quick*'));
            // 0.20.3: each of these was wrong in 0.19.0 through 0.20.2.
            // A multi-line paste at the start of a line that opens with bold left an empty
            // <strong> behind: "****", and a heading or list lost its marker to the paste.
            await run(mode, 'Ctrl+V of two lines at the start of a **bold** list item', 'Intro\n\n- **Task:** two\n\nEnd', ['Task', 0],
                async () => { await page.evaluate(() => navigator.clipboard.writeText('A\nB\n')); await chord(['Control'], 'v'); await sleep(300); },
                'Intro\n\nA\nB\n- **Task:** two\n\nEnd');
            // Several lines pasted into a list item or quote are items of the same kind, as in
            // Word (Ed, 2026-11-14). The marker used to move down as words: "A" / "B- item".
            // Whole lines (the case above, ending in a line break) still go above as they are.
            const pasteAB = (clip) => async () => { await page.evaluate((c) => navigator.clipboard.writeText(c), clip); await chord(['Control'], 'v'); await sleep(300); await kb.type('Z'); };
            await run(mode, 'Ctrl+V of two lines before the words of a list item: both are items', 'Intro\n\n- item\n\nEnd', ['item', 0], pasteAB('A\nB'), 'Intro\n\n- A\n- BZitem\n\nEnd');
            await run(mode, 'Ctrl+V of two lines before the words of a ticked task: the tick stays with its words', 'Intro\n\n- [x] item\n\nEnd', ['item', 0], pasteAB('A\nB'), 'Intro\n\n- [ ] A\n- [x] BZitem\n\nEnd');
            await run(mode, 'Ctrl+V of three lines in a numbered item counts on', 'Intro\n\n1. item\n2. next\n\nEnd', ['item', 0], pasteAB('A\nB\nC'), 'Intro\n\n1. A\n2. B\n3. CZitem\n4. next\n\nEnd');
            await run(mode, 'Ctrl+V of two lines mid list item: the second half is an item', 'Intro\n\n- onetwo\n\nEnd', ['onetwo', 3], pasteAB('A\nB'), 'Intro\n\n- oneA\n- BZtwo\n\nEnd');
            await run(mode, 'Ctrl+V of two lines before the words of a heading: the heading keeps its marker', 'Intro\n\n## Head\n\nEnd', ['Head', 0], pasteAB('A\nB'), 'Intro\n\nA\n## BZHead\n\nEnd');
            // Splitting a fence into blocks closed it at the caret and left "``` line ```".
            await run(mode, 'Ctrl+V of two lines inside a code block stays code', 'Intro\n\n```\ncode line\n```\n\nEnd', ['code line', 4],
                async () => { await page.evaluate(() => navigator.clipboard.writeText('X\nY')); await chord(['Control'], 'v'); await sleep(300); await kb.type('Z'); },
                'Intro\n\n```\ncodeX\nYZ line\n```\n\nEnd');
            // The reload after a cut across lines put the caret at the start of the line 20 ms on.
            await run(mode, 'Ctrl+X across lines, wait, type: the letter goes at the cut', 'Alpha one\nBeta two\nGamma\n\nEnd', ['Alpha', 6],
                async () => { await chord(['Shift'], 'ArrowDown'); await chord(['Control'], 'x'); await sleep(250); await kb.type('Q'); },
                'Alpha Qwo\nGamma\n\nEnd');
            await run(mode, 'Backspace over lines, wait, type: the letter goes at the cut', 'Alpha one\nBeta two\nGamma\n\nEnd', ['Alpha', 6],
                async () => { await chord(['Shift'], 'ArrowDown'); await kb.press('Backspace'); await sleep(250); await kb.type('Q'); },
                'Alpha Qwo\nGamma\n\nEnd');
            // The blank line under a paragraph is a gap, not the next paragraph. Shift+Down
            // from the end of the line used to select only that gap, and the next letter
            // stuck to the line above while the gap was deleted (the words of the next
            // paragraph stayed). It selects that paragraph; typing replaces it.
            await run(mode, 'Shift+Down at the end of a paragraph selects the next one',
                'Alpha one two three.\n\nBeta four five six.\n\nGamma seven eight nine.\n', ['three', 0],
                async () => {
                    await kb.press('End');
                    await chord(['Shift'], 'ArrowDown');
                    await sleep(80);
                    const sel = await page.evaluate(() => getSelection().toString());
                    if (sel.indexOf('Beta') < 0) throw new Error('selection ' + JSON.stringify(sel));
                    await kb.type('Q');
                    await sleep(150);
                },
                (g) => g.indexOf('Alpha one two three.Q') >= 0 && g.indexOf('Gamma seven eight nine.') >= 0 && g.indexOf('Beta') < 0);
            // A Delete across lines joined the two partial lines as plain text: the bold before
            // the cut and the link after it (address and all) were lost (0.20.6).
            await run(mode, 'Delete across lines keeps the bold before the cut and the link after it',
                'Intro\n\nStart **bold words** one\nMiddle line\nEnd and [a link](https://e.com/x) two\n\nTail', ['Start', 8],
                async () => {
                    const pt = await page.evaluate(() => {
                        const b = Array.from(editor.querySelectorAll('.block')).find(x => (x.textContent || '').indexOf('End and') === 0);
                        // In "and", just before the link (Shift+click ON a link is the browser's).
                        const t = b.querySelector('p').firstChild;
                        const r = document.createRange(); r.setStart(t, 5); r.collapse(true);
                        const q = r.getBoundingClientRect(); return { x: q.left + 1, y: q.top + q.height / 2 };
                    });
                    await kb.down('Shift'); await page.mouse.click(pt.x, pt.y); await kb.up('Shift'); await sleep(150);
                    await kb.press('Delete');
                },
                'Intro\n\nStart **bo**nd [a link](https://e.com/x) two\n\nTail');
            // Delete from inside bold into a table: the kept "bo" stays bold (0.20.8; it was
            // saved plain) and the table stays a table -- its rows before the end point go,
            // its header stays, emptied (0.20.9; its words were joined into the line).
            await run(mode, 'Delete from inside bold into a table keeps the bold and the table',
                'Intro\n\nStart **bold words** one\n\n| col | **b** |\n|---|---|\n| c | `d` |\n\nEnd', ['Start', 8],
                async () => {
                    const pt = await page.evaluate(() => {
                        const td = editor.querySelector('.block table td');
                        const t = document.createTreeWalker(td, NodeFilter.SHOW_TEXT).nextNode();
                        const r = document.createRange(); r.setStart(t, 0); r.collapse(true);
                        const q = r.getBoundingClientRect(); return { x: q.left + 1, y: q.top + q.height / 2 };
                    });
                    await kb.down('Shift'); await page.mouse.click(pt.x, pt.y); await kb.up('Shift'); await sleep(150);
                    await kb.press('Delete');
                },
                'Intro\n\nStart **bo**\n\n|  |  |\n|---|---|\n| c | `d` |\n\nEnd');
            // From inside a table out into text: the rows before the start point stay; the
            // text after the end point keeps its marks (0.20.9).
            const TBL = 'Intro\n\n| H1 | H2 |\n|---|---|\n| a1 | **b1** |\n| a2 | b2 |\n\nEnd *line* here';
            const fromCell = async (cellText, off, toStarts, toOff) => {
                const pts = await page.evaluate((ct, o, ts, to) => {
                    const at = (el, k) => { const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t, left = k; while ((t = tw.nextNode())) { if (left <= t.nodeValue.length) { const r = document.createRange(); r.setStart(t, left); r.collapse(true); const q = r.getBoundingClientRect(); return { x: q.left + 1, y: q.top + q.height / 2 }; } left -= t.nodeValue.length; } return null; };
                    const cell = Array.from(editor.querySelectorAll('.block th, .block td')).find(c => c.textContent === ct);
                    const blk = Array.from(editor.querySelectorAll('.block')).find(b => (b.textContent || '').indexOf(ts) === 0);
                    return { a: at(cell, o), f: at(blk, to) };
                }, cellText, off, toStarts, toOff);
                await page.mouse.click(pts.a.x, pts.a.y); await sleep(150);
                await kb.down('Shift'); await page.mouse.click(pts.f.x, pts.f.y); await kb.up('Shift'); await sleep(150);
            };
            await run(mode, 'Delete from inside a table out into text keeps the table and the marks after', TBL, ['Intro', 0],
                async () => { await fromCell('b1', 1, 'End', 5); await kb.press('Delete'); },
                'Intro\n\n| H1 | H2 |\n|---|---|\n| a1 | **b** |\n\n*ine* here');
            await run(mode, 'Typing over lines into a table is Delete, then the letter', TBL, ['Intro', 0],
                async () => { await fromCell('b1', 1, 'End', 5); await kb.type('Z'); },
                'Intro\n\n| H1 | H2 |\n|---|---|\n| a1 | **bZ** |\n\n*ine* here');
            // ...and one Ctrl+Z gives back what was typed over (0.20.10; it took two).
            await run(mode, 'Typing over lines, then one Ctrl+Z restores them', TBL, ['Intro', 0],
                async () => { await fromCell('b1', 1, 'End', 5); await kb.type('Z'); await sleep(700); await chord(['Control'], 'z'); await sleep(400); },
                TBL);
            // Part of a line copies as Markdown, and pastes back as it was (0.20.7). It copied
            // the words shown, so a cut from inside bold came back plain -- or all bold.
            await run(mode, 'Ctrl+X inside a line, Ctrl+V back: the line is unchanged',
                'Intro\n\nSee **bold words** and [a link](https://e.com/x) here\n\nTail', ['See', 6],
                async () => {
                    await kb.down('Shift'); for (let i = 0; i < 22; i++) await kb.press('ArrowRight'); await kb.up('Shift');
                    await chord(['Control'], 'x'); await sleep(300);
                    const c = await page.evaluate(() => navigator.clipboard.readText());
                    check(c === '**ld words** and [a link](https://e.com/x) he', mode + ': Ctrl+X inside a line puts its Markdown on the clipboard', c);
                    await chord(['Control'], 'v'); await sleep(300);
                },
                'Intro\n\nSee **bold words** and [a link](https://e.com/x) here\n\nTail');
            // Shift+PageDown selects (0.20.7); it only scrolled.
            await run(mode, 'Shift+PageDown selects to the end of a short document',
                'Intro\n\nStart **bold** one\nMiddle line\n\nTail', ['Start', 2],
                async () => { await chord(['Shift'], 'PageDown'); await sleep(500); await kb.type('Z'); },
                'Intro\n\nStZ');
            // A cell holds one line: several pasted lines cut the table at the caret.
            await run(mode, 'Ctrl+V of two lines into a table cell keeps the table', 'Intro\n\n| Name | Value |\n|---|---|\n| apple | red |\n\nEnd', ['Name', 2],
                // clickPreview counts from the start of the table's text, so offset 2 lands in "N|ame".
                async () => { await page.evaluate(() => navigator.clipboard.writeText('X\nY')); await chord(['Control'], 'v'); await sleep(300); await kb.type('Z'); },
                'Intro\n\n| NX YZame | Value |\n|---|---|\n| apple | red |\n\nEnd');
            await run(mode, 'Enter in the middle of a list item makes the next item', 'Intro\n\n1. onetwo\n2. three\n\nEnd', ['onetwo', 3],
                () => kb.press('Enter'), 'Intro\n\n1. one\n2. two\n3. three\n\nEnd');
            await run(mode, 'Enter on an empty list item ends the list', 'Intro\n\n- one\n\nEnd', ['one', 3],
                async () => { await kb.press('End'); await kb.press('Enter'); await kb.press('Enter'); await kb.type('P'); },
                'Intro\n\n- one\n\nP\n\nEnd');
        }
        await run(mode, 'Enter on a list item starts the next item', LIST, SRC ? [3, 5] : ['two', 3],
            async () => { await kb.press('End'); await kb.press('Enter'); await kb.type('three'); },
            (g) => /- two\n- three/.test(g));
        await run(mode, 'Escape does not change the text', DOC, at('quick', 4, 2),
            async () => { await kb.press('Escape'); await kb.type('X'); },
            (g) => g.indexOf('X') >= 0 && g.replace('X', '') === DOC);
        await run(mode, 'Insert: typing overwrites; Insert again: typing inserts', DOC, at('quick', 4, 2),
            async () => { await kb.press('Insert'); await kb.type('slow'); await kb.press('Insert'); await kb.type('X'); },
            DOC.replace('quick', 'slowXk'));
        await run(mode, 'Overwrite stops at the end of the line', DOC, at('Last', 6, 4),
            async () => { await kb.press('Insert'); await kb.type('ONGER'); },
            DOC.replace('Last line', 'Last lONGER'));
        await run(mode, 'Space at the end of a line, then more words', DOC, at('Last', 9, 4),
            async () => { await kb.press('End'); await kb.type(' and more'); },
            DOC.replace('Last line', 'Last line and more'));
    }
    // Shift+click after scrolling the caret's line out of the mounted window (0.20.5).
    // Before, the browser had moved the selection out of the text, so the Shift+click
    // selected only the mounted lines: Delete took "Line " from the clicked line, cut removed
    // nothing, and in 2-Col it deleted from the first mounted line instead of line 10.
    if (!only || only === 'large') {
        console.log('\n=== Shift+click after scrolling away ===');
        const N = 3000, O = Array.from({ length: N }, (_, i) => 'Line ' + i + ' text here.'), LONG = O.join('\n');
        const ptLine = (line) => page.evaluate((tg) => {
            const b = Array.from(editor.querySelectorAll('.block')).find(x => x.textContent.indexOf('Line ' + tg + ' ') === 0);
            if (!b) return null; const r0 = b.getBoundingClientRect();
            if (r0.top < 60 || r0.bottom > innerHeight - 60 || r0.left < 0 || r0.right > innerWidth) return null;
            const n = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
            const r = document.createRange(); r.setStart(n, 5); r.collapse(true);
            const q = r.getBoundingClientRect(); return { x: q.left + 1, y: q.top + q.height / 2 };
        }, line);
        for (const [label, cols, to] of [['1-Col, to line 2000', 1, 2000], ['2-Col, PageDown to line 1000', 2, 1000]]) {
            try {
                await page.evaluate((c) => { handleCommand('view_set:mode:preview'); handleCommand('view_set:scroll:scroll'); handleCommand('view_set:columns:' + c); }, cols);
                await sleep(2000);   // a column switch settles over the host's resize, as above
                await page.evaluate((m) => loadMarkdownContent(m), LONG);
                await sleep(900);
                let p = await ptLine(10);
                await page.mouse.click(p.x, p.y); await sleep(150);
                await page.mouse.move(500, 400);
                // Paged when the layout is (2-Col always is); the earlier 2-Col section can
                // leave 1-Col paged too, so ask the page rather than assume.
                const pagedNow = await page.evaluate(() => editor.classList.contains('page-mode'));
                for (let i = 0; i < 300 && !(p = await ptLine(to)); i++) {
                    if (pagedNow) { await kb.press('PageDown'); await sleep(120); }
                    else { await page.mouse.wheel({ deltaY: 400 }); await sleep(30); }
                }
                if (!p) throw new Error('never reached line ' + to + ' ' + JSON.stringify(await page.evaluate(() => {
                    const idx = Array.from(editor.querySelectorAll('.block[data-model-index]')).map(b => +b.getAttribute('data-model-index'));
                    const mc = document.getElementById('main-container');
                    return { cls: editor.className, mounted: idx.length ? [Math.min(...idx), Math.max(...idx)] : null, mcTop: mc.scrollTop, mcH: mc.scrollHeight, blocks: DocumentModel.blocks.length };
                })));
                await kb.down('Shift'); await page.mouse.click(p.x, p.y); await kb.up('Shift'); await sleep(200);
                await chord(['Control'], 'c'); await sleep(200);
                const clip = await page.evaluate(() => navigator.clipboard.readText());
                check(clip === ['10 text here.'].concat(O.slice(11, to)).concat(['Line ']).join('\n'),
                    label + ': Ctrl+C copies line 10 to the click', clip.slice(0, 80) + ' ... (' + clip.split('\n').length + ' lines)');
                await kb.press('Delete'); await sleep(500); await kb.type('Q'); await sleep(250);
                const got = await saved();
                const want = O.slice(0, 10).concat(['Line Q' + O[to].slice(5)]).concat(O.slice(to + 1)).join('\n');
                check(got === want, label + ': Delete removes line 10 to the click, the caret stays at the cut',
                    got.split('\n').length + ' lines; line 10 = ' + JSON.stringify(got.split('\n')[10]));
            } catch (e) {
                check(false, label + ' (threw ' + e.message + ')');
            }
        }
        // After PageDown away from the caret, typing went nowhere (0.20.6). (Holding Shift+Down
        // past the window lost the selection too; no case here reproduced that in 0.20.5, so
        // there is none -- the evidence for that fix is a probe, not this suite.)
        // Every kind of block, as a real file has: on paragraphs alone the selection survived
        // in 0.20.5 and this check could not see the bug.
        const PL = [];
        for (let i = 0; PL.length < 2600; i++) {
            const k = i % 12;
            if (k === 0) PL.push('## Heading ' + i + ' with **bold**');
            else if (k === 3) PL.push('- item ' + i + ' with *ital* and `code`');
            else if (k === 4) PL.push('- [ ] task ' + i + ' **todo**');
            else if (k === 5) PL.push('> quote ' + i + ' with a [link](https://example.com/q' + i + ')');
            else if (k === 7) PL.push('![picture ' + i + '](img/pic' + i + '.png)');
            else if (k === 9) PL.push('| col ' + i + ' | **b** |\n|---|---|\n| c' + i + ' | `d` |');
            else if (k === 10) PL.push('```js\nconst x' + i + ' = ' + i + ';\n```');
            else PL.push('P' + String(i).padStart(4, '0') + ' ' + 'word '.repeat(70) + '**end ' + i + '**');
            PL.push('');
        }
        const PDOC = PL.join('\n');
        const clickLine = async (idx, off) => {
            const p = await page.evaluate((i, o) => {
                const el = elementForModelIndex(i); if (!el) return null;
                el.scrollIntoView({ block: 'center' });
                const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
                const r = document.createRange(); r.setStart(t, o); r.collapse(true);
                const q = r.getBoundingClientRect();
                return (q.left < 0 || q.right > innerWidth) ? null : { x: q.left + 1, y: q.top + q.height / 2 };
            }, idx, off);
            if (!p) throw new Error('line ' + idx + ' not on screen');
            await page.mouse.click(p.x, p.y); await sleep(150);
        };
        const modelRaws = () => page.evaluate(() => { try { DocumentModel.syncMountedToModel(); } catch (e) {} return DocumentModel.blocks.map(b => b.raw); });
        // Shift+PageDown in a long file selects from the caret, a page at a time (0.20.7).
        try {
            await page.evaluate(() => { handleCommand('view_set:mode:preview'); handleCommand('view_set:scroll:scroll'); handleCommand('view_set:columns:1'); });
            await sleep(2000);
            await page.evaluate((m) => loadMarkdownContent(m), PDOC);
            await sleep(900);
            await clickLine(26, 3);
            for (let i = 0; i < 20; i++) { await chord(['Shift'], 'PageDown'); await sleep(250); }
            await sleep(300);
            await chord(['Control'], 'c'); await sleep(200);
            const clip = await page.evaluate(() => navigator.clipboard.readText());
            const cl = clip.split('\n');
            check(cl[0] === PL[26].slice(3) && cl.length > 60,
                '1-Col, Shift+PageDown x20: the selection starts at the caret on line 26 and runs pages down',
                cl.length + ' lines from ' + JSON.stringify(cl[0].slice(0, 30)));
        } catch (e) { check(false, '1-Col Shift+PageDown (threw ' + e.message + ')'); }
        for (const [label, cols] of [['1-Col', 1], ['2-Col', 2]]) {
            try {
                await page.evaluate((c) => { handleCommand('view_set:mode:preview'); handleCommand('view_set:scroll:scroll'); handleCommand('view_set:columns:' + c); }, cols);
                await sleep(2000);
                await page.evaluate((m) => loadMarkdownContent(m), PDOC);
                await sleep(900);
                await clickLine(2, 3);
                for (let i = 0; i < 40; i++) { await kb.press('PageDown'); await sleep(110); }
                await sleep(300);
                await kb.type('Q'); await sleep(400);
                const after = await modelRaws();
                const changed = after.map((r, i) => r === PL[i] ? -1 : i).filter(i => i >= 0);
                check(changed.length === 1 && changed[0] === 2 && after[2] === PL[2].slice(0, 3) + 'Q' + PL[2].slice(3),
                    label + ': PageDown x40 away, then a letter goes in at the caret', 'changed lines ' + JSON.stringify(changed.slice(0, 3)) + (changed.length ? ' first ' + JSON.stringify(String(after[changed[0]]).slice(0, 30)) : ''));
            } catch (e) { check(false, label + ' PageDown away (threw ' + e.message + ')'); }
        }
    }
    // ---- where TypoZen is not a plain text box -----------------------------------------
    // A large document is virtualised (only the part on screen is in the page) and 2-Col
    // lays text out in columns; typing has to behave the same in both.
    const fs = await import('fs');
    const big = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
    for (const [name, cols] of [['large document, 1-Col', 1], ['large document, 2-Col', 2]]) {
        if (only && only !== 'large') break;
        console.log('\n=== ' + name + ' ===');
        await page.evaluate(() => handleCommand('view_set:mode:preview'));
        await page.evaluate((m) => loadMarkdownContent(m), big);
        await sleep(900);
        if (cols === 2) { await page.evaluate(() => handleCommand('view_set:columns:2')); await sleep(2000); }
        const bi = await page.evaluate(() => {
            for (let i = 0; i < DocumentModel.blocks.length; i++)
                if (/scroll marker row 92\b/.test(DocumentModel.blocks[i].raw)) return i;
            return -1;
        });
        await page.evaluate((b, c) => { if (c === 2) goToPageHoldingBlock(b); else ensureModelBlockVisible(b, { topPad: 300 }); }, bi, cols);
        await sleep(800);
        const rawAt = (i) => page.evaluate((x) => DocumentModel.blocks[x].raw, i);
        const before = await rawAt(bi);
        const words = before.indexOf(' of ');
        const pt = await page.evaluate((b, o) => {
            const el = editor.querySelector('.block[data-model-index="' + b + '"]');
            const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let n, left = o;
            while ((n = tw.nextNode())) {
                if (left <= n.nodeValue.length) { const r = document.createRange(); r.setStart(n, left); r.setEnd(n, left); const q = r.getBoundingClientRect(); return { x: q.left + 1, y: q.top + q.height / 2 }; }
                left -= n.nodeValue.length;
            }
            return null;
        }, bi, words);
        await page.mouse.click(pt.x, pt.y);
        await sleep(150);
        await kb.type(' typed');
        await sleep(250);
        check((await rawAt(bi)) === before.replace(' of ', ' typed of '), name + ': typing mid-line', await rawAt(bi));
        await kb.press('Backspace'); await kb.press('Backspace');
        await sleep(200);
        check((await rawAt(bi)) === before.replace(' of ', ' typ of '), name + ': Backspace', await rawAt(bi));
        await kb.press('Enter');
        await kb.type('Z');
        await sleep(300);
        const a = await rawAt(bi), b2 = await rawAt(bi + 1);
        check(a === before.slice(0, words) + ' typ' && /^Z ?of /.test(b2), name + ': Enter splits, typing continues below', [a, b2]);
        await kb.press('Tab');
        await sleep(200);
        check((await rawAt(bi + 1)).startsWith('Z\t'), name + ': Tab types a tab', await rawAt(bi + 1));
        const n0 = await page.evaluate(() => DocumentModel.blocks.length);
        await kb.press('Home'); await kb.press('Backspace');
        await sleep(300);
        const joined = await rawAt(bi);
        check(joined.startsWith(before.slice(0, words) + ' typZ') && (await page.evaluate(() => DocumentModel.blocks.length)) === n0 - 1,
            name + ': Backspace at line start joins the lines', joined);
    }
} finally {
    await browser.close();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failures.length) console.log('FAILED:\n  ' + failures.join('\n  '));
process.exit(failed ? 1 : 0);
