/**
 * Text in scanned PDF pages (docs/archive/pdf-and-audit-plan.md, Phase 3).
 *
 * tests/pdf-scanned.pdf (from tests/make-pdf-scanned.mjs) is two pages that are pictures of
 * text. Opened, Windows' text recognition reads them: the words become the pages' text --
 * found by Find, selectable with the popup, read aloud -- and are kept for next time. With
 * View > Read Text in Scanned PDF Pages off, nothing is read.
 *
 * Needs Windows' own OCR language (any Windows with its display language's features).
 * Speech is stubbed, so nothing is heard.
 *
 *   RUN_APP_E2E=1 node tests/pdf-ocr-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp, sleep, profileDir } from './app-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCANNED = path.join(here, 'pdf-scanned.pdf');
const SAMPLE = path.join(here, 'pdf-sample.pdf');
const EXE = process.env.TYPOZEN_EXE || path.join(here, '..', 'TypoZen.exe');
let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 90000);
const waitFor = async (app, fn, ms) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await app.eval(fn); } catch (e) { v = null; } if (v || Date.now() > end) return v; await sleep(150); }
};
const openInApp = (file) => spawn(EXE, [file], { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profileDir }) }).unref();
const ocrDone = (app, ms) => waitFor(app, () => { const s = window.tzPdfOcrState && window.tzPdfOcrState(); return s && (s.finished || s.error) ? s : null; }, ms);

let app = null;
try {
    app = await launchApp({ file: SCANNED, settleMs: 8000 });
    const s1 = await ocrDone(app, 20000);
    ok(s1 && !s1.error && s1.pages.join() === '1,2' && s1.failed === 0, 'both scanned pages are read', JSON.stringify(s1));
    const text = await app.eval(() => window.tzPdfFindSurface().haystack);
    ok(/quick brown fox jumps over/.test(text) && /Lanterns glowed along the quiet/.test(text), 'their words become the PDF\'s text', JSON.stringify(text.slice(0, 80)));
    const paras = await app.eval(() => window.tzPdfBlocks().map(b => b.textContent));
    ok(paras.includes('The quick brown fox jumps over the lazy dog near the harbour wall.') && paras.includes('Chapter Two'),
        'lines join into paragraphs; headings stand alone', JSON.stringify(paras));
    const words = await app.eval(() => { const s = window.tzPdfStats(); return s && s.words; });
    ok(words >= 30, 'the status bar counts the recognised words', String(words));

    // Find lands on the word, on the page.
    await app.eval(() => { openFindBar('harbour'); findStep(0); });
    const hit = await waitFor(app, () => {
        const h = CSS.highlights.get('typozen-find-current');
        return h && h.size ? Array.from(h)[0].toString() : null;
    }, 4000);
    ok(/^harbour/i.test(hit || ''), 'Find highlights the recognised word', JSON.stringify(hit));
    const placed = await app.eval(() => {
        const r = Array.from(CSS.highlights.get('typozen-find-current'))[0].getBoundingClientRect();
        const page = document.querySelector('#pdfView .page[data-page-number="1"] canvas').getBoundingClientRect();
        return r.width > 10 && r.height > 5 && r.left >= page.left && r.right <= page.right && r.top >= page.top && r.bottom <= page.bottom;
    });
    ok(placed, 'and the highlight sits on the page');
    await app.eval(() => closeFindBar());

    // Select a recognised word: the popup offers Look up.
    const selected = await app.eval(() => {
        const layer = document.querySelector('#pdfView .page[data-page-number="2"] .tzOcrLayer, #pdfView .page[data-page-number="1"] .tzOcrLayer');
        const span = Array.from(document.querySelectorAll('#pdfView .tzOcrLayer span')).find(s => /^harbour/.test(s.textContent));
        if (!span) return null;
        const r = document.createRange(); r.setStart(span.firstChild, 0); r.setEnd(span.firstChild, 7);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        showSelPop();
        const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && !e.closest('[hidden]'); };
        return { text: s.toString(), pop: vis('selPop'), lookup: vis('selPopLookup') };
    });
    ok(selected && selected.text === 'harbour' && selected.pop && selected.lookup, 'a recognised word can be selected, with Look up offered', JSON.stringify(selected));
    await app.eval(() => { hideSelPop(); getSelection().removeAllRanges(); });

    // Read Aloud starts from the recognised text.
    await app.eval(() => {
        window.__spoken = [];
        window.sendTTSPlay = (t) => { window.__spoken.push(t); setTimeout(() => { if (isPlaying) stopReading(); }, 300); };
        document.getElementById('pdfView').scrollTop = 0;
    });
    await sleep(500);
    await app.eval(() => handleCommand('read_aloud_doc'));
    ok(await waitFor(app, () => window.__spoken[0] === 'Chapter One', 3000), 'Read Aloud reads the recognised text', JSON.stringify(await app.eval(() => window.__spoken)));

    // Kept for next time, in the profile (not beside the file).
    const cacheDir = path.join(profileDir, 'ocr');
    const kept = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).flatMap(d => fs.readdirSync(path.join(cacheDir, d))) : [];
    ok(kept.sort().join() === 'p1.json,p2.json', 'the words are kept in the profile\'s cache', JSON.stringify(kept));
    await app.closeGracefully(); app = null;

    app = await launchApp({ file: SCANNED, settleMs: 8000 });
    const s2 = await ocrDone(app, 15000);
    ok(s2 && s2.fromCache === 2 && /quick brown fox/.test(await app.eval(() => window.tzPdfFindSurface().haystack)),
        'reopened, the pages come from the cache', JSON.stringify(s2));

    // Turned off: a scanned page is left as a picture.
    await app.eval(() => handleCommand && window.tzPdfSetOcr(false));
    openInApp(SAMPLE);
    await waitFor(app, () => window.tzPdfState && window.tzPdfState() && window.tzPdfState().pages === 3, 12000);
    openInApp(SCANNED);
    await waitFor(app, () => window.tzPdfState && window.tzPdfState() && window.tzPdfState().pages === 2 && window.tzPdfTextReady(), 12000);
    await sleep(1500);
    const off = await app.eval(() => ({ state: window.tzPdfOcrState(), text: window.tzPdfFindSurface().haystack.replace(/\s/g, '') }));
    ok(off.state.pages.length === 0 && off.text === '', 'with the option off, scanned pages are not read', JSON.stringify(off));
    await app.eval(() => window.tzPdfSetOcr(true));
    ok(!!await ocrDone(app, 10000) && /quick brown fox/.test(await app.eval(() => window.tzPdfFindSurface().haystack)), 'turned back on, they are read');
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    clearTimeout(killer);
    console.log(failed ? 'PDF-OCR FAILED' : 'PDF-OCR PASSED');
    process.exitCode = failed ? 1 : 0;
}
