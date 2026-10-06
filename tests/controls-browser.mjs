/**
 * Every control, pressed once.
 *
 * The gate grew one suite per bug that had already happened, and so covered nothing that
 * had not broken yet: the table toolbar threw a ReferenceError on every click into a cell
 * from 0.13.15 to 0.14.12 behind 80 green suites, because none of them clicked into a
 * table. This is the broad, cheap check underneath them: every toolbar button and menu
 * item (as the message the host sends the page), and every button the page itself shows,
 * in each state that shows it. Each press must not throw, and must visibly do something
 * -- change the document or the page -- unless it is listed below as one that changes
 * nothing the page can see.
 *
 *   node tests/controls-browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { settled } from './settle.mjs';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const failures = [];
function check(ok, msg) {
    if (ok) passed++;
    else { failed++; failures.push(msg); console.error('  FAIL ' + msg); }
}

// The host's own messages (TypoZen_App.cs: toolbar buttons, menus, shortcuts).
const FMT = ['bold', 'italic', 'strike', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'list', 'ol', 'checklist', 'quote', 'link', 'table'];
const CMDS = ['cut', 'select_all', 'mark_toggle', 'show_marks', 'show_outline', 'show_search', 'toggle_focus', 'toggle_reveal',
    'toggle_search_sidebar', 'toggle_sidebar', 'toggle_typewriter', 'find', 'find_replace', 'wordwrap_on', 'sidebar_edge:0',
    'sidebar_edge:1', 'view_set:mode:source', 'view_set:mode:reader', 'view_set:columns:2'];
// Commands whose whole effect is outside the page (the clipboard, a message to the host),
// so "nothing changed on the page" is right for them. Kept short and named on purpose.
const NO_PAGE_EFFECT = new Set(['cmd:copy', 'cmd:view_sync', 'cmd:return_jump']);

const DOC = '# Title\n\nFirst paragraph with some words.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nLast paragraph here.';

// A click that does not return in 15 s is a hang, not a wait.
const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 15000 });
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    let pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    // A control may open a native prompt (Go to page): answer it, and count it as an effect.
    let dialogs = 0;
    page.on('dialog', d => { dialogs++; d.dismiss().catch(() => {}); });
    await page.evaluateOnNewDocument(() => {
        window.__sent = [];
        window.__hostListeners = [];
        window.chrome = { webview: {
            postMessage: (m) => window.__sent.push(String(m)),
            addEventListener: (t, fn) => { if (t === 'message') window.__hostListeners.push(fn); },
            removeEventListener() {}
        } };
        // Deliver a message as the host does.
        window.__host = (m) => { for (const fn of window.__hostListeners) fn({ data: m }); };
        // Count what changes: any mutation of the page counts as an effect.
        window.__mut = 0;
        new MutationObserver((l) => { window.__mut += l.length; })
            .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const url = 'file:///' + path.join(appDir, 'TypoZen_Template.html').replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__hostListeners.length > 0, { timeout: 15000 });

    async function fresh() {
        await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate((d) => {
            try { closeFindBar(); } catch (e) {}
            try { closeTableSizePicker(false); } catch (e) {}
            try { document.getElementById('tableModal').style.display = 'none'; } catch (e) {}
            try { tzSetOverwrite(false); } catch (e) {}
            handleCommand('view_set:mode:preview');
            handleCommand('view_set:columns:1');
            loadMarkdownContent(d);
        }, DOC);
        await settled(page);
        // Caret into the first paragraph's words, as a writer would leave it. (Not "the
        // second block": that is the blank line after the heading, where bold rightly does
        // nothing -- the first version of this suite clicked there and blamed bold.)
        const pt = await page.evaluate(() => {
            const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
            let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('some words') < 0) {}
            const at = t.nodeValue.indexOf('some words');
            const r = document.createRange(); r.setStart(t, at + 2); r.setEnd(t, at + 2);
            const b = r.getBoundingClientRect();
            return { x: b.left, y: b.top + b.height / 2 };
        });
        await page.mouse.click(pt.x, pt.y);
        await settled(page);
        const inPara = await page.evaluate(() => { const s = getSelection(); return !!(s.anchorNode && /some words/.test(s.anchorNode.textContent || '')); });
        if (!inPara) throw new Error('setup: the caret did not land in the paragraph');
    }
    const snap = () => page.evaluate((dl) => ({ mut: window.__mut, dialogs: dl,
        doc: (() => { try { return getMarkdownContent(false); } catch (e) { return ''; } })(),
        sent: window.__sent.length }), dialogs);
    function judge(label, before, after, allowNoEffect) {
        const errs = pageErrors; pageErrors = [];
        check(errs.length === 0, label + ' threw: ' + errs.join(' | '));
        if (errs.length) return;
        const did = after.mut > before.mut || after.doc !== before.doc || after.sent > before.sent || after.dialogs > before.dialogs;
        check(did || allowNoEffect, label + ' did nothing');
    }

    console.log('=== every toolbar button and menu item (host messages) ===');
    for (const m of FMT.map(f => 'fmt:' + f).concat(CMDS.map(c => 'cmd:' + c), [...NO_PAGE_EFFECT])) {
        await fresh();
        pageErrors = [];
        const before = await snap();
        await page.evaluate((x) => window.__host(x), m);
        await settled(page);
        judge(m, before, await snap(), NO_PAGE_EFFECT.has(m));
    }
    console.log('  ' + (FMT.length + CMDS.length + NO_PAGE_EFFECT.size) + ' messages delivered');

    // The messages above include toggles (reveal on focus, focus, typewriter, columns) that
    // fresh() does not undo. Reveal on focus in particular shows a clicked block as raw
    // Markdown, so a table has no cell to land in and its toolbar rightly never appears --
    // which read as a broken toolbar. Start the buttons from a clean page, and with the
    // saved preferences cleared: they carry the toggles across a reload.
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof handleCommand === 'function' && window.__hostListeners.length > 0, { timeout: 15000 });

    console.log('\n=== every button the page shows, in each state that shows it ===');
    const states = {
        'document': async () => {},
        'find bar': async () => { await page.evaluate(() => openFindBar('words', true)); },
        'word selected': async () => {
            await page.evaluate(() => {
                // The words "some words" wherever they are drawn.
                const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
                let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('some words') < 0) {}
                if (!t) throw new Error('no "some words" on the page');
                const at = t.nodeValue.indexOf('some words');
                const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + 10);
                const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                showSelPop();
            });
        },
        'cursor in a table': async () => { await page.click('#editor td'); },
        'table picker': async () => { await page.evaluate(() => applyFormatting('table')); },
        'table dialog': async () => { await page.evaluate(() => openTableCustomModal()); },
        'search pane': async () => { await page.click('.sidebar-tab[data-tab="search"]'); },
        'marks pane': async () => { await page.click('.sidebar-tab[data-tab="marks"]'); }
    };
    // What can be pressed: buttons, the sidebar tabs, and anything marked as a button.
    const visibleControls = () => page.evaluate(() => {
        const sel = 'button, .sidebar-tab, [role="button"], .tz-table-picker-cell';
        const out = [];
        document.querySelectorAll(sel).forEach((el, i) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none' || el.disabled) return;
            // On screen and on top: what a pointer at its centre would actually hit.
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;
            const hit = document.elementFromPoint(cx, cy);
            if (!hit || (hit !== el && !el.contains(hit))) return;
            if (el.closest('#editor')) return;                      // the document's own content
            const key = el.id ? '#' + el.id : (el.dataset.tab ? '.sidebar-tab[data-tab="' + el.dataset.tab + '"]'
                : (el.classList.contains('tz-table-picker-cell') ? '.tz-table-picker-cell[data-c="' + el.dataset.c + '"][data-r="' + el.dataset.r + '"]' : null));
            if (key) out.push({ key, label: (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().slice(0, 30) });
        });
        return out;
    });
    // What each state must put on screen. Without this a state that silently failed to
    // appear -- the table toolbar, which threw on every click into a cell -- showed no
    // buttons, so there was nothing to press and nothing to fail.
    const shows = {
        'document': null,
        'find bar': '#findBar.open',
        'word selected': '#selPop',
        'cursor in a table': '#tablePop',
        'table picker': '#tableSizePicker.open',
        'table dialog': '#tableModal',
        'search pane': '#tab-search.active',
        'marks pane': '#tab-marks.active'
    };
    // Polled: some surfaces arrive a beat after the gesture (the table toolbar waits 50 ms
    // for the selection to settle). Up to 1.5 s, then it is not coming.
    const onScreen = async (sel) => { for (let t = Date.now(); Date.now() - t < 1500; await new Promise(r => setTimeout(r, 50))) if (await onScreenNow(sel)) return true; return false; };
    const onScreenNow = (sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return false;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.hidden;
    }, sel);
    const seen = new Set();
    let pressed = 0;
    for (const [state, enter] of Object.entries(states)) {
        await fresh();
        pageErrors = [];
        await enter();
        await settled(page);
        // Getting into the state is itself a press of something; it must not throw.
        check(pageErrors.length === 0, state + ': getting there threw: ' + pageErrors.join(' | '));
        pageErrors = [];
        if (shows[state] && !(await onScreen(shows[state]))) {
            const why = await page.evaluate((sel) => {
                const el = document.querySelector(sel.split('.')[0]); const r = el && el.getBoundingClientRect();
                const s = getSelection(); const a = s.anchorNode; const ae = document.activeElement;
                return { inline: el && el.style.display, rect: r && [r.width | 0, r.height | 0],
                    anchor: a && (a.nodeType === 3 ? a.parentElement : a).tagName, active: ae && (ae.id || ae.tagName),
                    reveal: state.revealOnFocus, mode: state.mode, tds: document.querySelectorAll('#editor td').length,
                    stored: (() => { try { return Object.keys(localStorage).join(','); } catch (e) { return 'n/a'; } })() };
            }, shows[state]);
            check(false, state + ': ' + shows[state] + ' is not on screen ' + JSON.stringify(why));
        } else if (shows[state]) passed++;
        let controls = await visibleControls();
        // Ten of the picker's eighty cells are enough to show the grid answers.
        controls = controls.filter(c => !/picker-cell/.test(c.key) || /data-c="[1-2]"\]\[data-r="[1-5]"/.test(c.key));
        for (const c of controls) {
            const id = state + ' / ' + c.key;
            if (seen.has(c.key) && !/picker-cell/.test(c.key)) continue;  // once is enough
            seen.add(c.key);
            await fresh();
            await enter();
            await settled(page);
            pageErrors = [];
            const before = await snap();
            const el = await page.$(c.key);
            if (!el) { check(false, id + ' vanished before it could be pressed'); continue; }
            // A real click at its centre -- what a pointer does.
            const pt = await el.evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
            try { await page.mouse.click(pt.x, pt.y); } catch (e) { check(false, id + ' could not be clicked: ' + e.message); continue; }
            await settled(page);
            judge(id + ' (' + c.label + ')', before, await snap(), false);
            pressed++;
        }
    }
    console.log('  ' + pressed + ' controls pressed across ' + Object.keys(states).length + ' states');
} finally {
    await browser.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('\nCONTROLS BROWSER FAILED'); process.exit(1); }
console.log('\nCONTROLS BROWSER PASSED');
process.exit(0);
