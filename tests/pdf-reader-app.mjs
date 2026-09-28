/**
 * A PDF is read in the editor page by PDF.js (0.6.0; docs/archive/pdf-and-audit-plan.md Phase 1).
 *
 * Opens tests/pdf-sample.pdf (three pages, known text) and checks what a reader relies on:
 * real text on screen, pages drawn in the theme's colours, Go to Page, the page remembered
 * when the PDF is opened again, a theme change redrawing it, and a document opened after
 * it getting the editor back.
 *
 *   RUN_APP_E2E=1 node tests/pdf-reader-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp, sleep, profileDir } from './app-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(here, 'pdf-sample.pdf');
const EXE = process.env.TYPOZEN_EXE || path.join(here, '..', 'TypoZen.exe');
let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 90000);

const waitFor = async (app, fn, ms) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await app.eval(fn); } catch (e) { v = null; } if (v || Date.now() > end) return v; await sleep(200); }
};
/** Colour of a pixel near the top-left of page 1's canvas. */
const cornerPixel = (app) => app.eval(() => {
    const c = document.querySelector('#pdfView .page canvas');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(4, 4, 1, 1).data;
    return [d[0], d[1], d[2]];
});
const near = (a, hex) => { const b = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return a && a.every((v, i) => Math.abs(v - b[i]) <= 6); };

let app = null;
try {
    app = await launchApp({ file: PDF, settleMs: 8000 });
    const st = await waitFor(app, () => window.tzPdfState && window.tzPdfState() && window.tzPdfState().pages ? window.tzPdfState() : null, 15000);
    ok(st && st.pages === 3, 'the PDF opens in the page', JSON.stringify(st));
    ok(await app.eval(() => getComputedStyle(document.getElementById('editor')).display === 'none'), 'the editor is out of the way');
    const text = await waitFor(app, () => { const t = document.querySelector('#pdfView .page[data-page-number="1"] .textLayer'); return t && /page one/.test(t.textContent) ? t.textContent : null; }, 8000);
    ok(!!text, 'page 1 has real, selectable text', text ? JSON.stringify(text.slice(0, 50)) : 'no text layer');

    // The invisible text layer must lie exactly over the drawn page, or Find's highlight and
    // a selection land beside the words (the app's "* { box-sizing: border-box }" once made
    // it 18px wider than the canvas).
    const geo = await app.eval(() => {
        const p = document.querySelector('#pdfView .page[data-page-number="1"]');
        const a = p.querySelector('canvas').getBoundingClientRect(), b = p.querySelector('.textLayer').getBoundingClientRect();
        return [a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].map(Math.round);
    });
    ok(Math.abs(geo[0] - geo[4]) <= 1 && Math.abs(geo[1] - geo[5]) <= 1 && Math.abs(geo[2] - geo[6]) <= 1 && Math.abs(geo[3] - geo[7]) <= 1,
        'the text layer lies exactly over the drawn page', 'canvas ' + geo.slice(0, 4) + ' / layer ' + geo.slice(4));

    // A fitted page refits when its space changes (window restored, sidebar opened).
    const fitW = await app.eval(() => document.querySelector('#pdfView .page').getBoundingClientRect().width);
    await app.eval((w) => { window.__tzFitW = w; document.getElementById('pdfView').style.right = '300px'; }, fitW);
    ok(await waitFor(app, () => document.querySelector('#pdfView .page').getBoundingClientRect().width < window.__tzFitW * 0.8, 2000), 'a narrower view refits the page');
    await app.eval(() => { document.getElementById('pdfView').style.right = ''; });
    ok(await waitFor(app, () => Math.abs(document.querySelector('#pdfView .page').getBoundingClientRect().width - window.__tzFitW) < 3, 2000), 'and widening it fits it back');

    // Once loaded, the file is not held open: a program that wants it to itself can have it
    // (Microsoft Print to PDF saving over a PDF opened earlier failed, 2026-09-26).
    const exclusive = (() => {
        try {
            return execFileSync('powershell', ['-NoProfile', '-Command',
                "try { $s = [IO.File]::Open('" + PDF + "', 'Open', 'Read', 'None'); $s.Close(); 'ok' } catch { 'held' }"],
                { encoding: 'utf8', timeout: 15000 }).trim();
        } catch (e) { return 'error'; }
    })();
    ok(exclusive === 'ok', 'once loaded, the PDF is not held open', exclusive);

    // The sidebar: the PDF's own outline, and Find / Search over its text.
    const outline = await waitFor(app, () => { const rows = Array.from(document.querySelectorAll('.outline-item')).map(r => r.innerText.trim()); return rows.includes('Chapter Three') ? rows : null; }, 8000);
    ok(!!outline, 'the sidebar shows the PDF\'s outline', JSON.stringify(outline));
    await app.eval(() => Array.from(document.querySelectorAll('.outline-item')).find(r => r.innerText.trim() === 'Chapter Three').click());
    ok(await waitFor(app, () => window.tzPdfState().page === 3, 3000), 'clicking an outline entry turns to its page');
    await app.eval(() => { window.tzPdfState(); });
    await waitFor(app, () => window.tzPdfState().textPages === 3, 8000);
    await app.eval(() => { document.getElementById('pdfView').scrollTop = 0; });
    await sleep(600);
    await app.eval(() => openFindBar('harbour'));
    await app.eval(() => findStep(0));
    const found = await waitFor(app, () => {
        const c = document.getElementById('findCount'); const h = CSS.highlights.get('typozen-find-current');
        const txt = h ? Array.from(h)[0].toString() : '';
        return c && /1\/1/.test(c.textContent) && /harbour/i.test(txt) ? { count: c.textContent, hit: txt, page: window.tzPdfState().page } : null;
    }, 6000);
    ok(found && found.page === 3, 'Find reaches the match on page 3 and highlights it', JSON.stringify(found));
    ok(await app.eval(() => { const r = document.getElementById('replaceInput'); return !r || r.hidden || r.disabled; }), 'Replace is not offered on a PDF');
    await app.eval(() => closeFindBar());
    const side = await waitFor(app, () => {
        const inp = document.getElementById('sidebarSearchInput'); if (!inp) return null;
        if (inp.value !== 'fixture') { inp.value = 'fixture'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
        const rows = Array.from(document.querySelectorAll('#search-results-list .search-item .search-line')).map(s => s.textContent.trim());
        return rows.length >= 2 ? rows : null;
    }, 6000);
    ok(side && side.includes('p. 1') && side.includes('p. 3'), 'the Search sidebar lists hits by page', JSON.stringify(side));
    await app.eval(() => { const inp = document.getElementById('sidebarSearchInput'); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); window.tzPdfState(); });
    await app.eval(() => { window.prompt = () => '1'; openGoToPageDialog(); });
    await sleep(800);

    await sleep(500);
    const pxOwn = await cornerPixel(app);
    ok(near(pxOwn, '#FFFFFF'), 'by default a page keeps its own colours', 'pixel ' + JSON.stringify(pxOwn));

    // View > PDF Pages in Theme Colours (the host sends this message when it is ticked).
    const bg = await app.eval(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    await app.eval(() => window.tzPdfSetThemed(true));
    await waitFor(app, () => !!document.querySelector('#pdfView .page[data-page-number="1"] canvas'), 8000);
    await sleep(1200);
    const px = await cornerPixel(app);
    ok(near(px, bg.length === 7 ? bg : '#18181B'), 'with the option on, pages take the theme\'s colours', 'pixel ' + JSON.stringify(px) + ' vs --bg ' + bg);

    await app.eval(() => { window.prompt = () => '3'; openGoToPageDialog(); });
    const onThree = await waitFor(app, () => window.tzPdfState().page === 3, 3000);
    ok(onThree, 'Go to Page reaches page 3');
    // The status bar counts the PDF's own text and shows the page, not the emptied editor.
    const stats = await app.eval(() => {
        const sent = []; const orig = window.postMsg;
        window.postMsg = (m) => { sent.push(m); return orig(m); };
        try { updateStatsNow(); } finally { window.postMsg = orig; }
        return sent.find(m => m.startsWith('stats:')) || null;
    });
    const sp = stats ? stats.slice(6).split(',') : [];
    ok(sp.length >= 9 && +sp[0] > 10 && sp[4] === '3' && sp[5] === '3' && sp[8] === 'pdf', 'the status bar gets the PDF\'s word count and page 3 of 3', stats);

    // The toolbar's 2 Columns and Pages buttons drive the PDF viewer's spread and page modes.
    await app.eval(() => { handleCommand('view_set:columns:2'); handleCommand('view_set:scroll:pagination'); });
    const modes = await waitFor(app, () => { const v = document.querySelectorAll('#pdfView .spread').length; const p = window.tzPdfState().page; return v ? { spreads: v, page: p } : null; }, 3000);
    ok(modes && modes.page === 3, 'two columns shows spreads and keeps the page', JSON.stringify(modes));
    await app.eval(() => { handleCommand('view_set:columns:1'); });
    await sleep(300);
    await app.eval(() => { window.tzPdfState(); document.getElementById('pdfView').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })); });
    ok(await waitFor(app, () => window.tzPdfState().page === 2, 2000), 'in Pages mode the wheel turns back a page');
    await app.eval(() => { window.prompt = () => '3'; openGoToPageDialog(); });
    await waitFor(app, () => window.tzPdfState().page === 3, 2000);

    // Zoom scales the PDF itself: Ctrl+wheel in the page, and the menu / Ctrl+plus via the host.
    const scale0 = await app.eval(() => document.querySelector('#pdfView .page').getBoundingClientRect().width);
    await app.eval(() => document.getElementById('pdfView').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })));
    const scale1 = await waitFor(app, () => { const w = document.querySelector('#pdfView .page').getBoundingClientRect().width; return w > 0 ? w : null; }, 1500);
    ok(scale1 > scale0 * 1.05, 'Ctrl+wheel enlarges the page', scale0 + ' -> ' + scale1);
    // (waitFor runs in the page, so the widths to compare against are kept there.)
    const dpr0 = await app.eval((a) => { window.__tzW0 = a[0]; window.__tzW1 = a[1]; postMsg('zoom:in'); return devicePixelRatio; }, [scale0, scale1]);
    const scale2 = await waitFor(app, () => { const w = document.querySelector('#pdfView .page').getBoundingClientRect().width; return w > window.__tzW1 * 1.05 ? w : null; }, 3000);
    const dpr1 = await app.eval(() => devicePixelRatio);
    ok(!!scale2 && dpr1 === dpr0, 'Zoom In from the host enlarges the PDF, not the window', scale1 + ' -> ' + scale2 + ', devicePixelRatio ' + dpr0 + ' -> ' + dpr1);
    await app.eval(() => postMsg('zoom:reset'));
    ok(await waitFor(app, () => Math.abs(document.querySelector('#pdfView .page').getBoundingClientRect().width - window.__tzW0) < 3, 3000), 'Reset returns to the fit');

    await app.eval(() => { handleCommand('view_set:scroll:scroll'); });
    ok(await waitFor(app, () => !document.querySelector('#pdfView .spread') && window.tzPdfState().page === 3, 3000), 'back to one column, still on page 3');
    await sleep(1500);                                   // past the position report's debounce

    await app.eval(() => applyTheme({ Name: 'Probe Light', Bg: '#FFFFFF', Tx: '#111111', Hi: '#2255CC' }));
    await sleep(2500);
    const pxLight = await cornerPixel(app);
    ok(near(pxLight, '#FFFFFF'), 'a theme change redraws the pages', 'pixel ' + JSON.stringify(pxLight));
    ok((await app.eval(() => window.tzPdfState().page)) === 3, 'and stays on the same page');
    await app.closeGracefully(); app = null;

    app = await launchApp({ file: PDF, settleMs: 8000 });
    const back = await waitFor(app, () => window.tzPdfState && window.tzPdfState() && window.tzPdfState().page === 3, 12000);
    ok(back, 'reopened, the PDF is back on page 3', JSON.stringify(await app.eval(() => window.tzPdfState && window.tzPdfState())));

    const doc = path.join(os.tmpdir(), 'tz-after-pdf.md');
    fs.writeFileSync(doc, '# After the PDF\n\nA document opened after a PDF.\n');
    spawn(EXE, [doc], { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profileDir }) }).unref();
    const handed = await waitFor(app, () => /opened after a PDF/.test(getMarkdownContent(false)) && !window.tzPdfActive
        && getComputedStyle(document.getElementById('editor')).display !== 'none', 12000);
    ok(handed, 'opening a document gives the editor back');

    // And back to the PDF: the document must not linger behind it, where the status bar,
    // Read Aloud and bookmarks would act on text that is not on screen.
    spawn(EXE, [PDF], { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profileDir }) }).unref();
    const clean = await waitFor(app, () => window.tzPdfActive && window.tzPdfState() && window.tzPdfState().pages === 3
        && !/opened after a PDF/.test(getMarkdownContent(false)), 12000);
    ok(clean, 'returning to the PDF leaves no document behind it');
    try { fs.unlinkSync(doc); } catch (e) { }
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    clearTimeout(killer);
    console.log(failed ? 'PDF-READER FAILED' : 'PDF-READER PASSED');
    process.exitCode = failed ? 1 : 0;
}
