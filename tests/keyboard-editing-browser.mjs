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
 *   node tests/keyboard-editing-browser.mjs            all cases
 *   node tests/keyboard-editing-browser.mjs preview    one view
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
        if (!SRC) {
            await run(mode, 'Ctrl+B bolds the selection', DOC, at('quick', 4, 2),
                async () => { for (let i = 0; i < 5; i++) await chord(['Shift'], 'ArrowRight'); await chord(['Control'], 'b'); await sleep(300); },
                DOC.replace('quick', '**quick**'));
            await run(mode, 'Ctrl+I italicises the selection', DOC, at('quick', 4, 2),
                async () => { for (let i = 0; i < 5; i++) await chord(['Shift'], 'ArrowRight'); await chord(['Control'], 'i'); await sleep(300); },
                DOC.replace('quick', '*quick*'));
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
    // ---- where TypoZen is not a plain text box -----------------------------------------
    // A large document is virtualised (only the part on screen is in the page) and 2-Col
    // lays text out in columns; typing has to behave the same in both.
    const fs = await import('fs');
    const big = fs.readFileSync(path.join(appDir, 'tests', 'large-scroll-mixed.md'), 'utf8');
    for (const [name, cols] of [['large document, 1-Col', 1], ['large document, 2-Col', 2]]) {
        if (only && only !== 'preview') break;
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
