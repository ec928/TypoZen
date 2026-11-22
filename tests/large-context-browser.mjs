/**
 * The day's editing fixes, held in the middle of a LARGE document, in every layout (2026-11-22).
 *
 * Each case below was first tested on a ten-line document. A long document is the default for
 * editing (TypoZen/CLAUDE.md): Preview holds only a window of it and rebuilds that window as
 * lines come and go. So every case runs again with 1,500 lines of real-looking text above and
 * below it, the caret in the middle of the file, in scrolling 1-column, 2-column and two-page
 * Preview (and Source where the case is Source's): the file must come out as the case says,
 * the caret must still be in a line in the page, and the next letter typed must land once.
 *
 *   node tests/large-context-browser.mjs          (TZ_ROOT=<folder> to test another copy)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const appDir = process.env.TZ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = setTimeout(() => { console.error('  FAIL over budget (200 s)'); console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }, 200000);
let passed = 0, failed = 0;
function ok(c, msg) { if (c) { passed++; } else { failed++; console.error('  FAIL ' + msg); } }
const filler = (tag, n) => Array.from({ length: n }, (_, i) => (i % 4 === 3 ? '' : tag + ' line ' + i + ' of ordinary prose, long enough to wrap now and then when the page is narrow.')).join('\n');
const ABOVE = filler('Above', 1500), BELOW = filler('Below', 1500);
const B = '```';
const PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// name, fragment, which fragment line to click (0-based), keys, expected fragment after, Source?
const CASES = [
    ['type after trailing spaces', 'Start\nfix.  \nEnd', 1, ['End', 'type:Q'], 'Start\nfix.  Q\nEnd'],
    ['Delete on an empty line before text', 'Start\n\nNext line\nEnd', 1, ['Delete'], 'Start\nNext line\nEnd'],
    ['Delete on an empty line before a table', 'Start\n\n| a | b |\n|---|---|\n| 1 | 2 |\nEnd', 1, ['Delete', 'type:Z'], 'Start\n| Za | b |\n|---|---|\n| 1 | 2 |\nEnd'],
    ['Delete on an empty line before a rule', 'Start\n\n---\nEnd', 1, ['Delete', 'type:Z'], 'Start\n---\nZEnd'],
    ['Delete on an empty line before a picture', 'Start\n\n![p](' + PIC + ')\nEnd', 1, ['Delete', 'type:Z'], 'Start\nZ![p](' + PIC + ')\nEnd'],
    ['Backspace on an empty line', 'Start\n\nNext line\nEnd', 1, ['Backspace'], 'Start\nNext line\nEnd'],
    ['Backspace at the start of a line joins it up', 'Start\nOne\nTwo\nEnd', 2, ['Home', 'Backspace'], 'Start\nOneTwo\nEnd'],
    ['Delete at the end of a line joins the next', 'Start\nOne\nTwo\nEnd', 1, ['End', 'Delete'], 'Start\nOneTwo\nEnd'],
    ['Down onto a rule steps over it', 'Start\n---\nEnd', 0, ['End', 'ArrowDown', 'type:Z'], 'Start\n---\nZEnd'],
    ['Up onto a rule steps over it', 'Start\n---\nEnd', 2, ['Home', 'ArrowUp', 'type:Z'], 'StartZ\n---\nEnd'],
    // The agreed rule (ol-renumber-browser): the ones below close the gap.
    ['numbered list renumbers when an item stops', 'Start\n1. one\n2. two\n3. three\nEnd', 2, ['Home', 'Backspace'], 'Start\n1. one\ntwo\n2. three\nEnd'],
    ['typing in an indented code block', 'Start\n- step\n  ' + B + 'js\n  let a = 1;\n  ' + B + '\nEnd', 3, ['End', 'type:Z'], 'Start\n- step\n  ' + B + 'js\n  let a = 1;Z\n  ' + B + '\nEnd'],
    ['Source: Backspace removes an empty list marker', 'Start\n- \nEnd', 1, ['src:End', 'Backspace'], 'Start\n\nEnd', true],
    ['Source: Enter on a task starts an unchecked task', 'Start\n- [x] done\nEnd', 1, ['src:End', 'Enter', 'type:Z'], 'Start\n- [x] done\n- [ ] Z\nEnd', true],
];
const LAYOUTS = { '1-column': ['view_set:columns:1', 'view_set:scroll:scroll'], '2-column': ['view_set:columns:2', 'view_set:scroll:scroll'], 'two pages': ['view_set:columns:2', 'view_set:scroll:pagination'] };

const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    page.on('pageerror', e => { failed++; console.error('  FAIL page threw: ' + e.message.slice(0, 160)); });
    await page.evaluateOnNewDocument(() => { window.__L = []; window.chrome = { webview: { postMessage: () => { }, addEventListener: (t, fn) => { if (t === 'message') window.__L.push(fn); }, removeEventListener() { } } }; });
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__L.length > 0, { timeout: 15000 });
    const quiet = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));
    const firstLine = ABOVE.split('\n').length;     // the fragment's first line number in the file
    for (const [name, frag, clickLine, keys, want, source] of CASES) {
        for (const layout of (source ? ['Source'] : Object.keys(LAYOUTS))) {
            const tag = name + ' (' + layout + ')';
            const docText = ABOVE + '\n' + frag + '\n' + BELOW;
            const target = firstLine + clickLine;
            if (source) {
                await page.evaluate((t) => { setSourceDocExt('md'); handleCommand('view_set:mode:source'); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, docText);
                await quiet(); await quiet();
                // Once Source has the text: the caret on that line.
                await page.evaluate((line) => {
                    const off = sourceEditor.value.split('\n').slice(0, line).reduce((s, l) => s + l.length + 1, 0);
                    sourceEditor.focus(); sourceEditor.setSelectionRange(off, off);
                }, target);
                await quiet();
            } else {
                await page.evaluate((t, c) => { setSourceDocExt('md'); handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent(); }, docText, LAYOUTS[layout]);
                await quiet(); await quiet();
                const at = await page.evaluate(async (line) => {
                    // The block holding that line of the file.
                    let bi = -1, n = 0;
                    for (let i = 0; i < DocumentModel.blocks.length; i++) { const c = String(DocumentModel.blocks[i].raw).split('\n').length; if (line < n + c) { bi = i; break; } n += c; }
                    goToModelBlock(bi); await new Promise(r => setTimeout(r, 200));
                    const ed = document.getElementById('editor'); const v = ed.getBoundingClientRect();
                    const b = ed.querySelector('.block[data-model-index="' + bi + '"]'); if (!b) return null;
                    // Inside a code block: the line within it.
                    const code = b.querySelector('pre code');
                    if (code) {
                        const within = line - n - 1;
                        const t = code.firstChild; const ls = t.nodeValue.split('\n');
                        let off = 0; for (let k = 0; k < within; k++) off += ls[k].length + 1;
                        const rg = document.createRange(); rg.setStart(t, off); rg.collapse(true);
                        const s = getSelection(); s.removeAllRanges(); s.addRange(rg); editor.focus();
                        return { code: true };
                    }
                    const r = Array.from(b.getClientRects()).find(r => r.height > 0 && r.bottom > v.top && r.top < v.bottom);
                    return r ? { x: r.left + 4, y: r.top + Math.min(r.height / 2, 10) } : null;
                }, target);
                if (!at) { ok(false, tag + ': the line was not on screen'); continue; }
                if (!at.code) { await page.mouse.click(at.x, at.y); await quiet(); }
            }
            for (const k of keys) {
                if (k.startsWith('type:')) await page.keyboard.type(k.slice(5));
                else if (k.startsWith('src:')) await page.keyboard.press(k.slice(4));
                else await page.keyboard.press(k);
                await quiet();
            }
            const got = await page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
            const wantDoc = ABOVE + '\n' + want + '\n' + BELOW;
            if (got.replace(/\n+$/, '') !== wantDoc.replace(/\n+$/, '')) {
                const G = got.split('\n'), W = wantDoc.split('\n'); let p = 0; while (p < G.length && G[p] === W[p]) p++;
                ok(false, tag + ': the file is wrong at line ' + p + ' -- got ' + JSON.stringify(G.slice(p, p + 2)) + ', want ' + JSON.stringify(W.slice(p, p + 2)));
                continue;
            }
            const lost = await page.evaluate(() => {
                if (state.mode === 'source') return '';
                const s = getSelection();
                if (!s || !s.rangeCount || !s.anchorNode) return 'no selection';
                if (!document.getElementById('editor').contains(s.anchorNode)) return 'caret not in the page';
                return '';
            });
            ok(!lost, tag + ': after the keys, ' + lost);
            if (lost) continue;
            await page.keyboard.type('Qy'); await quiet();
            const typed = await page.evaluate(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
            const where = typed.split('\n').findIndex(l => l.indexOf('Qy') >= 0);
            ok((typed.split('Qy').length - 1) === 1 && where >= firstLine - 1 && where <= firstLine + want.split('\n').length + 1,
                tag + ': the next letters typed land once, by the edit (line ' + where + ', fragment at ' + firstLine + ')');
        }
    }
    // Replace All over the whole long file, every layout: a word to a token and back gives the
    // file back, as does Undo of the first replace; nothing outside the matches changes.
    const big = ABOVE + '\nStart\nThe word ordinary, and ordinary again.\nEnd\n' + BELOW;
    for (const layout of Object.keys(LAYOUTS)) {
        const r = await page.evaluate(async (t, c) => {
            const wait = (ms) => new Promise(res => setTimeout(res, ms));
            setSourceDocExt('md'); handleCommand('view_set:mode:preview'); c.forEach(x => handleCommand(x)); loadMarkdownContent(t); HistoryManager.resetToCurrent();
            await wait(200);
            const orig = getMarkdownContent(false);
            openFindBar('', true);
            const mc = document.getElementById('findMatchCase'); if (mc) mc.checked = true;
            const fi = document.getElementById('findInput'), ri = document.getElementById('replaceInput');
            fi.value = 'ordinary'; ri.value = 'QzTok'; replaceAllMatches(); await wait(60);
            const mid = getMarkdownContent(false);
            const wantMid = orig.split('ordinary').join('QzTok');
            fi.value = 'QzTok'; ri.value = 'ordinary'; replaceAllMatches(); await wait(60);
            const back = getMarkdownContent(false);
            handleCommand('undo'); await wait(60); handleCommand('undo'); await wait(60);
            const undone = getMarkdownContent(false);
            if (typeof closeFindBar === 'function') closeFindBar();
            return { mid: mid === wantMid, back: back === orig, undo: undone === orig, n: orig.split('ordinary').length - 1 };
        }, big, LAYOUTS[layout]);
        ok(r.mid && r.back && r.undo, 'Replace All over the long file (' + layout + ', ' + r.n + ' matches): replaced exactly ' + r.mid + ', back ' + r.back + ', undo ' + r.undo);
    }
} finally {
    clearTimeout(deadline);
    await browser.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
