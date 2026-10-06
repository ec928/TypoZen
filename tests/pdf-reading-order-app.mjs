/**
 * A PDF's paragraphs in reading order: page furniture stored first in the file is read
 * last. Read aloud follows this list, and spoke "2 Alice's Adventures in Wonderland"
 * before the page's poem (Ed, 2026-10-06).
 *
 *   RUN_APP_E2E=1 node tests/pdf-reading-order-app.mjs     (~10 s, hidden desktop)
 */
import { launchApp } from './app-harness.mjs';
import { sleep } from './settle.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

let app;
try {
    app = await launchApp({ file: 'tests/alices-adventures-in-wonderland.pdf', settleMs: 8000 });
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !(await app.eval(() => window.tzPdfTextReady && window.tzPdfTextReady()))) await sleep(250);
    const pages = await app.eval(() => {
        const list = window.tzPdfBlocks();
        const on = (p) => list.filter(b => +b.dataset.pdfPage === p).map(b => b.textContent);
        return { p2: on(1), p3: on(2), p4: on(3), total: list.length };
    });
    console.log('=== footers last, body in its own order ===');
    assert(/^All in the Golden Afternoon/.test(pages.p2[0]), 'page 2 starts with its title (' + pages.p2[0] + ')');
    assert(/Wonderland\s*2$/.test(pages.p2[pages.p2.length - 1]), 'page 2 ends with its footer (' + pages.p2[pages.p2.length - 1] + ')');
    assert(/^Anon, to sudden silence/.test(pages.p3[0]), 'page 3 starts with the poem');
    assert(/Planet eBook\.com$/.test(pages.p3[pages.p3.length - 1]), 'page 3 ends with its footer');
    assert(/^Chapter I\./.test(pages.p4[0]) && /Wonderland\s*4$/.test(pages.p4[pages.p4.length - 1]),
        'page 4: chapter heading first, footer last');
    const p2body = pages.p2.slice(1, -1);
    assert(p2body.indexOf('Full leisurely we glide;') < p2body.indexOf('Not more than once a minute.'),
        'the poem keeps its order');

    console.log('\n=== Read aloud skips footers ===');
    // Start reading at the top of page 2 the way Read aloud does, and keep what it is handed
    // instead of speaking it.
    const heard = await app.eval(async () => {
        const list = window.tzPdfBlocks();
        const title = list.findIndex(b => +b.dataset.pdfPage === 1);
        window.tzPdfGotoBlock(title);
        await new Promise(r => setTimeout(r, 1200));
        window.getSelection().removeAllRanges();
        let chunks = null;
        const real = startReadingChunks;
        startReadingChunks = function (c) { chunks = c.map(x => x.text); };
        try { speakSelection(); } finally { startReadingChunks = real; }
        const narr = narrationBatches(list, title, 3, true).flat().map(p => p.text);
        return { chunks: chunks ? chunks.slice(0, 60) : null, narr: narr.slice(0, 60),
            footers: list.filter(b => b.dataset.pdfFooter === '1').map(b => b.textContent), pages: new Set(list.map(b => b.dataset.pdfPage)).size };
    });
    const footerLike = (t) => /Wonderland\s*\d+$|Planet eBook\.com$/.test(t);
    assert(heard.footers.length >= heard.pages - 5, 'nearly every page has its footer marked (' + heard.footers.length + ' of ' + heard.pages + ' pages)');
    assert(heard.footers.every(footerLike), 'and nothing else is (' + JSON.stringify(heard.footers.filter(t => !footerLike(t)).slice(0, 5)) + ')');
    assert(heard.chunks && /^All in the Golden Afternoon/.test(heard.chunks[0]),
        'reading starts at the top of page 2 (' + (heard.chunks && heard.chunks[0]) + ')');
    assert(heard.chunks && heard.chunks.length > 30 && !heard.chunks.some(footerLike),
        'Windows/Kokoro reading passes over every footer (' + JSON.stringify((heard.chunks || []).filter(footerLike)) + ')');
    assert(heard.chunks && heard.chunks.some(t => /^Anon, to sudden silence/.test(t)), 'and carries on to page 3');
    assert(heard.narr.length > 20 && !heard.narr.some(footerLike),
        'the narrator\'s batches leave footers out too (' + JSON.stringify(heard.narr.filter(footerLike)) + ')');
    assert(await app.eval(() => window.tzPdfBlocks().filter(b => b.dataset.pdfHeader === '1').length) === 0,
        'Alice has no running header, and nothing is taken for one (its titles are read)');
    await app.close(); app = null;
    await sleep(1500);

    console.log('\n=== running headers are skipped, chapter headings are not ===');
    // tests/pdf-running-head.pdf (make-pdf-running-head.mjs): "The Lantern Keeper" atop
    // every page, a page number below, "CHAPTER n" opening every fourth page.
    app = await launchApp({ file: 'tests/pdf-running-head.pdf', settleMs: 8000 });
    const t1 = Date.now();
    while (Date.now() - t1 < 30000 && !(await app.eval(() => window.tzPdfTextReady && window.tzPdfTextReady()))) await sleep(250);
    const rh = await app.eval(() => {
        const list = window.tzPdfBlocks();
        const pages = new Set(list.map(b => b.dataset.pdfPage)).size;
        const heads = list.filter(b => b.dataset.pdfHeader === '1').map(b => b.textContent);
        const feet = list.filter(b => b.dataset.pdfFooter === '1').map(b => b.textContent);
        const chapters = list.filter(b => /^CHAPTER \d/.test(b.textContent));
        window.tzPdfGotoBlock(0);
        const narr = narrationBatches(list, 0, 40, true).flat().map(p => p.text);
        return { pages, heads, feet, chaptersTagged: chapters.filter(b => b.dataset.pdfHeader || b.dataset.pdfFooter).length,
            chapters: chapters.length, narr };
    });
    assert(rh.heads.length === rh.pages && rh.heads.every(t => t === 'The Lantern Keeper'),
        'every page\'s running header is marked, and nothing else (' + rh.heads.length + ' of ' + rh.pages + ')');
    assert(rh.feet.length === rh.pages && rh.feet.every(t => /^\d+$/.test(t)), 'every page number is marked a footer');
    assert(rh.chapters === 4 && rh.chaptersTagged === 0, 'the four chapter headings are not');
    assert(!rh.narr.some(t => /Lantern Keeper/.test(t)) && !rh.narr.some(t => /^\d+$/.test(t)),
        'reading aloud never says the header or a page number');
    assert(rh.narr.filter(t => /^CHAPTER/.test(t)).length === 4, 'and does say every chapter heading');
} catch (e) {
    failed++; console.error('  FAIL ' + e.message.split('\n')[0]);
} finally {
    if (app) await app.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('\nPDF READING ORDER APP FAILED'); process.exit(1); }
console.log('\nPDF READING ORDER APP PASSED');
process.exit(0);
