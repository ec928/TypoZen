/**
 * Editing a long file, in every layout, at every kind of position: the file that would be
 * saved must be exactly what the edit should make, undo must give back the original, and
 * redo the edit.
 *
 * A long file is not all on screen: scrolling Preview mounts a window of it, and two-page
 * Preview one range. An edit there that numbers lines by what is mounted rather than by the
 * file writes the wrong rows -- 0.17.0 pasted a page over the start of the file this way.
 * Each case here presses real keys (page.keyboard) and checks every line of the document.
 *
 * A line not on screen (the far edges of a mounted range) is one a person cannot put the
 * caret on, so there the check is that nothing outside the edited line and its neighbours
 * moved, and that undo restores the file. On screen, the file must be exactly the edit.
 *
 * About five minutes for all three layouts, so not part of the default gate. Run it after
 * any change to how Preview mounts, numbers, splits or joins lines:
 *
 *   node tests/long-edit-sweep.mjs                    all layouts, 900 lines
 *   node tests/long-edit-sweep.mjs pages              one layout (scroll1, scroll2, pages)
 *   SWEEP_LINES=3000 node tests/long-edit-sweep.mjs   past scrolling Preview's own window
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2] || '';
// 900 lines: two-page windows it; 3000 is past scrolling Preview's own window (2,000 lines).
const N = Number(process.env.SWEEP_LINES || 900);
const TARGET = Math.round(N * 2 / 3);
const ORIGINAL = [];
for (let i = 0; i < N; i++) ORIGINAL.push('KEEP-' + String(i).padStart(4, '0'));

let passed = 0, failed = 0;
const failures = [];
function check(ok, msg, detail) {
    if (ok) { passed++; }
    else { failed++; failures.push(msg); console.error('  FAIL ' + msg + (detail ? '\n         ' + detail : '')); }
}
function diff(got, want) {
    if (got.length !== want.length) {
        let i = 0; while (i < got.length && i < want.length && got[i] === want[i]) i++;
        return `length ${got.length} vs ${want.length}; first difference at ${i}: got ${JSON.stringify(got.slice(i, i + 3))} want ${JSON.stringify(want.slice(i, i + 3))}`;
    }
    const bad = [];
    for (let i = 0; i < got.length && bad.length < 3; i++) if (got[i] !== want[i]) bad.push(`${i}: got ${JSON.stringify(got[i])} want ${JSON.stringify(want[i])}`);
    return bad.join('; ');
}

const LAYOUTS = {
    scroll1: ['view_set:columns:1', 'view_set:scroll:scroll'],
    scroll2: ['view_set:columns:2', 'view_set:scroll:scroll'],
    pages: ['view_set:columns:2', 'view_set:scroll:pagination']
};

// What each edit should make of lines[i] (and its neighbours). null: the edit is not
// well defined there (the line it needs does not exist).
const EDITS = {
    'Enter at end, type NEW': (L, i) => { const r = L.slice(); r.splice(i + 1, 0, 'NEW'); return r; },
    'Enter mid-line': (L, i) => { const r = L.slice(); r.splice(i, 1, L[i].slice(0, 4), L[i].slice(4)); return r; },
    'Backspace at start': (L, i) => { if (i === 0) return L.slice(); const r = L.slice(); r.splice(i - 1, 2, L[i - 1] + L[i]); return r; },
    'Delete at end': (L, i) => { if (i === L.length - 1) return L.slice(); const r = L.slice(); r.splice(i, 2, L[i] + L[i + 1]); return r; },
    'select across two lines, Delete': (L, i) => { if (i === L.length - 1) return null; const r = L.slice(); r.splice(i, 2, L[i].slice(0, 4) + L[i + 1].slice(4)); return r; },
    'select across two lines, Ctrl+X': (L, i) => { if (i === L.length - 1) return null; const r = L.slice(); r.splice(i, 2, L[i].slice(0, 4) + L[i + 1].slice(4)); return r; },
    'paste two lines mid-line': (L, i) => { const r = L.slice(); r.splice(i, 1, L[i].slice(0, 4) + 'P1', 'P2' + L[i].slice(4)); return r; },
    'type mid-line': (L, i) => { const r = L.slice(); r[i] = L[i].slice(0, 4) + 'xyz' + L[i].slice(4); return r; }
};

const browser = await puppeteer.launch({ headless: 'new' });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', e => { failed++; failures.push('page threw: ' + e.message); console.error('  FAIL page threw: ' + e.message); });
    try { await browser.defaultBrowserContext().overridePermissions('file://', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']); } catch (e) {}
    await page.goto('file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function', { timeout: 15000 });
    const kb = page.keyboard;
    const chord = async (mods, key) => { for (const m of mods) await kb.down(m); await kb.press(key); for (const m of mods.slice().reverse()) await kb.up(m); };
    const lines = () => page.evaluate(() => DocumentModel.blocks.map(b => b.raw));
    const saved = () => page.evaluate(() => getMarkdownContent(false));

    async function setup(layout, target) {
        await page.evaluate(() => { try { handleCommand('view_set:mode:preview'); } catch (e) {} });
        await page.evaluate(md => loadMarkdownContent(md), ORIGINAL.join('\n'));
        await settled(page);
        for (const c of LAYOUTS[layout]) { await page.evaluate(x => handleCommand(x), c); await settled(page); }
        await page.evaluate(i => goToModelBlock(i), target);
        await settled(page);
    }
    // The model indices mounted now: the window or range on screen.
    const mountedRange = () => page.evaluate(() => {
        const ix = [...editor.querySelectorAll('.block[data-model-index]')].map(b => +b.getAttribute('data-model-index'));
        return { lo: Math.min(...ix), hi: Math.max(...ix), windowed: typeof pageWindowingActive === 'function' && pageWindowingActive() };
    });
    // Whether the line was on screen before the caret was put there: a person can only click
    // a line they can see. Focusing can scroll an off-screen one into view, so judged first.
    async function place(i, offset) {
        return page.evaluate((idx, off) => {
            const el = editor.querySelector('.block[data-model-index="' + idx + '"]');
            if (!el) return { ok: false };
            const r = el.getBoundingClientRect();
            const onScreen = r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
            focusBlock(el, off < 0 ? (el.innerText || '').length : off);
            try { setCaretAtOffset(el, off < 0 ? (el.innerText || '').length : off); } catch (e) {}
            return { ok: true, onScreen };
        }, i, offset);
    }
    // Every line outside i-1..i+1 is the original, in order: what an edit at i may not touch.
    function untouchedOutside(got, i) {
        const head = ORIGINAL.slice(0, Math.max(0, i - 1));
        const tail = ORIGINAL.slice(i + 2);
        return JSON.stringify(got.slice(0, head.length)) === JSON.stringify(head) &&
            JSON.stringify(got.slice(got.length - tail.length)) === JSON.stringify(tail) &&
            got.length >= head.length + tail.length;
    }
    async function perform(edit) {
        switch (edit) {
            case 'Enter at end, type NEW': await kb.press('Enter'); await kb.type('NEW'); break;
            case 'Enter mid-line': await kb.press('Enter'); break;
            case 'Backspace at start': await kb.press('Backspace'); break;
            case 'Delete at end': await kb.press('Delete'); break;
            case 'select across two lines, Delete':
            case 'select across two lines, Ctrl+X':
                await chord(['Shift'], 'End'); await chord(['Shift'], 'ArrowRight');
                for (let k = 0; k < 4; k++) await chord(['Shift'], 'ArrowRight');
                if (edit.endsWith('Delete')) await kb.press('Delete'); else await chord(['Control'], 'x');
                break;
            case 'paste two lines mid-line':
                await page.evaluate(() => navigator.clipboard.writeText('P1\nP2'));
                await chord(['Control'], 'v'); break;
            case 'type mid-line': await kb.type('xyz'); break;
        }
        await settled(page);
    }
    const offsetFor = edit => edit === 'Enter at end, type NEW' || edit === 'Delete at end' ? -1 : edit === 'Backspace at start' ? 0 : 4;

    for (const layout of Object.keys(LAYOUTS)) {
        if (only && layout !== only) continue;
        console.log('--- ' + layout);
        // Positions: the file's first and last lines, and the edges and middle of a range
        // in the later part of the file.
        await setup(layout, TARGET);
        const r = await mountedRange();
        console.log(`  range on screen ${r.lo}..${r.hi}${r.windowed ? ' (two-page window)' : ''}`);
        const positions = { 'first line': [0, 0], 'range top': [TARGET, r.lo], 'range middle': [TARGET, Math.round((r.lo + r.hi) / 2)], 'range bottom': [TARGET, r.hi], 'last line': [N - 1, N - 1] };
        for (const [where, [target, i]] of Object.entries(positions)) {
            for (const edit of Object.keys(EDITS)) {
                const want = EDITS[edit](ORIGINAL, i);
                if (!want) continue;
                await setup(layout, target);
                const name = `${layout} | ${where} (line ${i}) | ${edit}`;
                const at = await place(i, offsetFor(edit));
                if (!at.ok) { check(false, name, 'line ' + i + ' is not mounted'); continue; }
                await page.bringToFront();
                await perform(edit);
                const got = await lines();
                let ok = JSON.stringify(got) === JSON.stringify(want);
                if (at.onScreen) {
                    check(ok, name + ': the file is what the edit should make', ok ? '' : diff(got, want));
                } else {
                    const safe = ok || untouchedOutside(got, i);
                    check(safe, name + ' (off screen): nothing outside the edited line moved', safe ? '' : diff(got, want));
                }
                const s = await saved();
                check(s === got.join('\n'), name + ': what would be saved matches the document', s === got.join('\n') ? '' : diff(s.split('\n'), got));
                // Undo back to the original (one or two steps), then redo.
                let undone = got;
                for (let k = 0; k < 3 && JSON.stringify(undone) !== JSON.stringify(ORIGINAL); k++) {
                    await chord(['Control'], 'z'); await settled(page); undone = await lines();
                }
                const back = JSON.stringify(undone) === JSON.stringify(ORIGINAL);
                check(back, name + ': undo gives back the original', back ? '' : diff(undone, ORIGINAL));
                if (ok && back) {
                    await chord(['Control'], 'y'); await settled(page);
                    let redone = await lines();
                    if (JSON.stringify(redone) !== JSON.stringify(want)) { await chord(['Control', 'Shift'], 'z'); await settled(page); redone = await lines(); }
                    if (JSON.stringify(redone) !== JSON.stringify(want)) { await chord(['Control'], 'y'); await settled(page); redone = await lines(); }
                    const re = JSON.stringify(redone) === JSON.stringify(want);
                    check(re, name + ': redo brings the edit back', re ? '' : diff(redone, want));
                }
            }
        }
    }
} finally {
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.error('\nFAILED (' + failures.length + '):\n  ' + [...new Set(failures)].join('\n  ')); console.error('\nLONG EDIT SWEEP FAILED'); process.exitCode = 1; }
else console.log('\nLONG EDIT SWEEP PASSED');
