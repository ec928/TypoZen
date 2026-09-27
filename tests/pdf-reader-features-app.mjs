/**
 * A PDF joins the reader's features (docs/pdf-and-audit-plan.md, Phase 2): Read Aloud reads
 * its paragraphs and highlights each on the page, the selection popup offers Look up and
 * Read, a bookmark or highlight made on it is kept, and a password-protected PDF asks for
 * its password.
 *
 * Speech is stubbed at sendTTSPlay, so nothing is heard: the checks are on what would be
 * spoken and what is highlighted, which is where the PDF-specific code is.
 *
 *   RUN_APP_E2E=1 node tests/pdf-reader-features-app.mjs
 */
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp, sleep, profileDir } from './app-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.join(here, 'pdf-sample.pdf');
const LOCKED = path.join(here, 'pdf-locked.pdf');
const EXE = process.env.TYPOZEN_EXE || path.join(here, '..', 'TypoZen.exe');
let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 90000);
const waitFor = async (app, fn, ms) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await app.eval(fn); } catch (e) { v = null; } if (v || Date.now() > end) return v; await sleep(150); }
};
const openInApp = (file) => spawn(EXE, [file], { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profileDir }) }).unref();
/** Select the words `text` on the PDF's text layer, as a drag would. */
const selectOnPdf = (app, text) => app.eval((t) => {
    const layer = Array.from(document.querySelectorAll('#pdfView .textLayer')).find(l => l.textContent.includes(t));
    if (!layer) return false;
    const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let n; while ((n = tw.nextNode())) {
        const i = n.nodeValue.indexOf(t);
        if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + t.length);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
    }
    return false;
}, text);

let app = null;
try {
    app = await launchApp({ file: PDF, settleMs: 8000 });
    ok(!!await waitFor(app, () => window.tzPdfTextReady && window.tzPdfTextReady(), 15000), 'the PDF opens and its text is read');

    // Paragraphs: headings apart from the sentence under them.
    const paras = await app.eval(() => window.tzPdfBlocks().map(b => b.textContent));
    ok(paras.includes('Chapter Three') && paras.some(t => /^TypoZen PDF fixture, page three: the harbour was quiet at dawn\.$/.test(t)),
        'the text is split into paragraphs, headings on their own', JSON.stringify(paras));

    // Read Aloud from page 3: the first paragraph on screen is read first and highlighted.
    await app.eval(() => {
        window.__spoken = [];
        window.sendTTSPlay = (t) => { window.__spoken.push(t); setTimeout(() => { if (isPlaying) nativeTTSFinished(); }, 400); };
        window.prompt = () => '3'; openGoToPageDialog();
    });
    await waitFor(app, () => window.tzPdfState().page === 3, 3000);
    await sleep(600);
    await app.eval(() => { getSelection().removeAllRanges(); handleCommand('read_aloud_doc'); });
    // The paragraph being read is a band on the page (10-pdf.js paintBand), not a
    // highlight on the text; tzPdfBandText gives the words under it.
    const first = await waitFor(app, () => {
        const lit = window.tzPdfBandText('read');
        return window.__spoken.length && lit ? { spoken: window.__spoken[0], lit } : null;
    }, 3000);
    ok(first && first.spoken === 'Chapter Three' && /Chapter Three/.test(first.lit), 'Read Aloud starts at the top of the page on screen and highlights it', JSON.stringify(first));
    const second = await waitFor(app, () => window.__spoken.length >= 2
        ? { spoken: window.__spoken[1], lit: window.tzPdfBandText('read') } : null, 3000);
    ok(second && /harbour/.test(second.spoken) && /harbour/.test(second.lit || ''), 'and moves on, the highlight following', JSON.stringify(second));
    await waitFor(app, () => !isPlaying, 3000);
    ok(await app.eval(() => !document.querySelector('#pdfView .tzPdfBand.read')), 'the highlight goes when reading ends');

    // Narration (the Qwen narrator) from the same place: the narrator's answer and the audio
    // are stubbed; what is checked is what the PDF hands it and the highlight following.
    await app.eval(() => {
        window.__sent = []; window.__played = [];
        const realFetch = window.fetch;
        window.fetch = async (url, init) => {
            if (!String(url).startsWith('http://narrator.stub/')) return realFetch(url, init);
            if (/\/render$/.test(url)) {
                const body = JSON.parse(init.body);
                body.blocks.forEach(b => window.__sent.push(b.text));
                return new Response(JSON.stringify({ items: body.blocks.map((b, i) => ({ file: 'stub' + i + '.wav', seconds: 1 })) }));
            }
            return new Response('{}');
        };
        window.playRenderedChunk = (url) => {
            window.__played.push(window.tzPdfBandText('read'));
            setTimeout(() => { if (isPlaying) playNextChunk(); }, 300);
        };
        getSelection().removeAllRanges();
        startQwenNarration('http://narrator.stub');
    });
    const narr = await waitFor(app, () => window.__played.length >= 2 ? { sent: window.__sent.slice(0, 3), lit: window.__played.slice(0, 2) } : null, 5000);
    ok(narr && /^Chapter Three/.test(narr.sent[0]) && /Chapter Three/.test(narr.lit[0]) && /harbour/.test(narr.lit[1]),
        'narration sends the PDF\'s paragraphs from the page on screen, highlight following', JSON.stringify(narr));
    await app.eval(() => { if (isPlaying) stopReading(); });

    // The selection popup on a PDF: Look up for a word, no editing buttons.
    await selectOnPdf(app, 'harbour');
    await app.eval(() => showSelPop());
    const pop = await app.eval(() => {
        const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && !e.closest('[hidden]'); };
        return { pop: vis('selPop'), lookup: vis('selPopLookup'), read: vis('selPopRead'), bold: vis('selPopBold'), mark: vis('selPopMark') };
    });
    ok(pop.pop && pop.lookup && pop.read && !pop.bold, 'selecting a word on a PDF raises the popup with Look up and Read, no formatting', JSON.stringify(pop));

    // Selection paints the text in the theme's colour, and never the text layer's line
    // breaks: those sit at the left edge, and painting them drew a dashed column there.
    const selPaint = await app.eval(() => {
        const layer = document.querySelector('#pdfView .textLayer');
        const span = layer && layer.querySelector('span'), br = layer && layer.querySelector('br');
        return {
            span: span ? getComputedStyle(span, '::selection').backgroundColor : null,
            br: br ? getComputedStyle(br, '::selection').backgroundColor : 'no br',
            // PDF.js's own painter: on, it draws a second selection over the page image.
            pdfjsPainter: !!(layer && layer.classList.contains('selectionRendering'))
        };
    });
    ok(!selPaint.pdfjsPainter, 'one selection painter: PDF.js\'s own is off');
    ok(selPaint.span && !/rgba\(0, 0, 0, 0\)|transparent/.test(selPaint.span)
        && (selPaint.br === 'no br' || /rgba\(0, 0, 0, 0\)|transparent/.test(selPaint.br)),
        'a PDF selection paints its words, not its line breaks', JSON.stringify(selPaint));
    await app.eval(() => { window.__spoken = []; document.getElementById('selPopRead').click(); });
    ok(await waitFor(app, () => window.__spoken[0] === 'harbour', 2000), 'Read in the popup reads the selection');
    await app.eval(() => { if (isPlaying) stopReading(); hideSelPop(); });

    // A highlight and a bookmark, kept with the PDF.
    await selectOnPdf(app, 'quiet at dawn');
    await app.eval(() => handleCommand('mark_toggle'));
    const lit = await waitFor(app, () => { const h = CSS.highlights.get('typozen-pdf-mark'); return h && h.size ? Array.from(h)[0].toString() : null; }, 2000);
    ok(lit === 'quiet at dawn', 'Highlight on a selection paints it on the page', JSON.stringify(lit));
    await app.eval(() => { getSelection().removeAllRanges(); window.prompt = () => '1'; openGoToPageDialog(); });
    await waitFor(app, () => window.tzPdfState().page === 1, 3000);
    await sleep(500);
    await app.eval(() => handleCommand('mark_toggle'));
    const rows = await waitFor(app, () => {
        const r = Array.from(document.querySelectorAll('#marks-list .mark-item')).map(x => x.innerText.replace(/\s+/g, ' ').trim());
        return r.length >= 2 ? r : null;
    }, 2000);
    ok(rows && rows.some(r => /Chapter One/.test(r) && /p 1/.test(r)) && rows.some(r => /quiet at dawn/.test(r) && /p 3/.test(r)),
        'Bookmark This Page marks the top of page 1; the Marks pane lists both with their pages', JSON.stringify(rows));
    // Opened as a reader opens it (the tab wires the list's clicks).
    await app.eval(() => { handleCommand('show_marks'); Array.from(document.querySelectorAll('#marks-list .mark-item')).find(x => /quiet at dawn/.test(x.innerText)).click(); });
    ok(await waitFor(app, () => window.tzPdfState().page === 3, 3000), 'clicking a mark turns to its page');
    await sleep(1200);
    await app.closeGracefully(); app = null;

    app = await launchApp({ file: PDF, settleMs: 8000 });
    await waitFor(app, () => window.tzPdfTextReady && window.tzPdfTextReady(), 15000);
    const kept = await waitFor(app, () => {
        const r = Array.from(document.querySelectorAll('#marks-list .mark-item:not(.lost)')).map(x => x.innerText.replace(/\s+/g, ' ').trim());
        return r.length >= 2 ? r : null;
    }, 5000);
    ok(!!kept, 'reopened, both marks are still there and found', JSON.stringify(kept));

    // A password-protected PDF asks for its password; cancelling says so in the view.
    await app.eval(() => { window.__asked = 0; window.prompt = () => { window.__asked++; return null; }; });
    openInApp(LOCKED);
    const problem = await waitFor(app, () => { const p = document.querySelector('#pdfView .pdf-problem'); return p ? p.innerText : null; }, 10000);
    ok(problem && /password/i.test(problem) && (await app.eval(() => window.__asked)) === 1, 'cancelling the password prompt explains in the view', JSON.stringify(problem));
    await app.eval(() => { window.__asked = 0; window.prompt = () => (++window.__asked === 1 ? 'wrong' : 'test'); document.querySelector('#pdfView .pdf-problem button').click(); });
    const opened = await waitFor(app, () => { const t = document.querySelector('#pdfView .textLayer'); return t && /password opened it/.test(t.textContent) ? t.textContent : null; }, 10000);
    ok(!!opened && (await app.eval(() => window.__asked)) === 2, 'a wrong password asks again; the right one opens it', JSON.stringify({ opened, asked: await app.eval(() => window.__asked) }));
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    clearTimeout(killer);
    console.log(failed ? 'PDF-FEATURES FAILED' : 'PDF-FEATURES PASSED');
    process.exitCode = failed ? 1 : 0;
}
