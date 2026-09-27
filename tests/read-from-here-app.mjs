/**
 * Read from here starts at the word it was asked from, not at the top of the paragraph.
 *
 * Found by hand on 2026-09-27: it read from the start of the paragraph. On a PDF both
 * voices did (the paragraph was chosen and read whole); in books and Markdown the Windows
 * and Kokoro voices were right and the narrator read the whole paragraph. For a book, a
 * Markdown document and a PDF, a word mid-paragraph is selected and Read from here pressed;
 * the first text handed to the voice, and to a stubbed narrator driven as the host drives
 * it (cmd:narrate), must both begin at that word.
 *
 *   RUN_APP_E2E=1 node tests/read-from-here-app.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('READ FROM HERE SKIPPED (set RUN_APP_E2E=1)'); process.exit(0); }
const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function ok(cond, msg, detail) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + (detail ? '  ' + detail : '')); }
}

const cases = [
    { name: 'a book', file: path.join(here, '7-Dune - Frank Herbert.epub'), view: { scroll: 'pagination', columns: 2 }, seek: 600 },
    { name: 'a Markdown document', file: path.join(here, 'large-scroll-mixed.md') },
    { name: 'a PDF', file: path.join(here, 'pdf-sample.pdf'), pdf: true }
];
for (const c of cases) {
    const deadline = setTimeout(() => { console.error('  FAIL ' + c.name + ': deadline'); process.exit(3); }, 60000);
    const app = await launchApp({ file: c.file, settleMs: 8000, view: c.view });
    try {
        await settledApp(app, 5000);
        if (c.pdf) await app.eval(async () => { for (let i = 0; i < 40 && !(window.tzPdfState && window.tzPdfState() && window.tzPdfState().textPages); i++) await new Promise(r => setTimeout(r, 150)); });
        // Into the body of the book, past the cover and title pages.
        if (c.seek) { await app.eval((b) => goToReadingBlock(b), c.seek); await sleep(1200); }
        const r = await app.eval(async (isPdf) => {
            window.__spoken = [];
            window.sendTTSPlay = (t) => { window.__spoken.push(t); };
            // A paragraph on screen with enough words; its fifth word.
            const root = isPdf ? document.querySelector('#pdfView .textLayer') : document.getElementById('editor');
            const host = root.getBoundingClientRect();
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let n, target = null;
            while ((n = walker.nextNode())) {
                const words = [...n.data.matchAll(/[A-Za-z]{3,}/g)];
                if (words.length < 6) continue;
                const rg = document.createRange(); rg.selectNodeContents(n);
                const rc = rg.getBoundingClientRect();
                if (rc.width && rc.right > host.left && rc.left < host.right && rc.bottom > host.top && rc.top < host.bottom) { target = { n, w: words[4] }; break; }
            }
            if (!target) return { error: 'no paragraph on screen' };

            // The popup's Read from here, with the word selected.
            const sel = getSelection(); sel.removeAllRanges();
            const rg = document.createRange(); rg.setStart(target.n, target.w.index); rg.setEnd(target.n, target.w.index + target.w[0].length);
            sel.addRange(rg);
            try { showSelPop(); } catch (e) { }
            document.getElementById('selPopReadFromHere').click();
            for (let i = 0; i < 30 && !window.__spoken.length; i++) await new Promise(res => setTimeout(res, 100));
            try { if (isPlaying) stopReading(); } catch (e) { }

            // The narrator from the same cursor, its service stubbed.
            const sel2 = getSelection(); sel2.removeAllRanges();
            const c2 = document.createRange(); c2.setStart(target.n, target.w.index); c2.collapse(true); sel2.addRange(c2);
            window.__sent = [];
            const realFetch = window.fetch;
            window.fetch = async (url, init) => {
                if (!String(url).startsWith('http://narrator.stub/')) return realFetch(url, init);
                if (/\/render$/.test(url)) { const body = JSON.parse(init.body); body.blocks.forEach(b => window.__sent.push(b.text)); return new Response(JSON.stringify({ items: [] })); }
                return new Response('{}');
            };
            try { startQwenNarration('http://narrator.stub'); } catch (e) { }
            for (let i = 0; i < 30 && !window.__sent.length; i++) await new Promise(res => setTimeout(res, 100));
            try { if (isPlaying) stopReading(); } catch (e) { }
            window.fetch = realFetch;
            return { word: target.w[0], spoken: (window.__spoken[0] || '').slice(0, 70), narrator: (window.__sent[0] || '').slice(0, 70) };
        }, !!c.pdf);
        if (r.error) { ok(false, c.name + ': ' + r.error); continue; }
        ok(r.spoken.trim().startsWith(r.word), c.name + ': the voice starts at "' + r.word + '"', JSON.stringify(r.spoken));
        ok(r.narrator.trim().startsWith(r.word), c.name + ': so does the narrator', JSON.stringify(r.narrator));
    } finally { clearTimeout(deadline); await app.close(); await sleep(1000); }
}
console.log('');
console.log('passed=' + passed + ' failed=' + failed);
if (failed) { console.log('READ FROM HERE FAILED'); process.exit(1); }
console.log('READ FROM HERE PASSED');
