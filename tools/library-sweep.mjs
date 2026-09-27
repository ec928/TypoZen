/**
 * Open every epub in a folder and check that nothing in it leaves the page.
 *
 * Not a suite: it takes about a minute per three books, so it is run by hand after a
 * change to how books are rendered -- the book CSS allowlist, the block split, pagination.
 * It exists because the reader's failures with unusual books were found one book at a
 * time, by the reader, when one was opened (Zones of Thought's margins, 2026-09-26).
 *
 * Per book, in 2-column Pages on the hidden desktop:
 *   - the page sits inside the wrapper's margins, the same on both sides;
 *   - at 20 places through the book, no block's content is wider than its column (text,
 *     tables, pictures, preformatted runs), and no picture is taller than the page.
 * One JSON line per book goes to the output file as it finishes, so a stopped run keeps
 * what it measured.
 *
 *   node tools/library-sweep.mjs <folder> <out.jsonl> [samplesPerBook]
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { launchApp } from '../tests/app-harness.mjs';
import { settledApp, sleep } from '../tests/settle.mjs';

function isAppRunning() {
    try { return /TypoZen\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq TypoZen.exe" /NH', { encoding: 'utf8' })); }
    catch (e) { return false; }
}

const folder = process.argv[2];
const outFile = process.argv[3];
const SAMPLES = parseInt(process.argv[4] || '20', 10);
if (!folder || !outFile) { console.error('usage: node tools/library-sweep.mjs <folder> <out.jsonl> [samples]'); process.exit(2); }

function epubsUnder(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...epubsUnder(p));
        else if (/\.epub$/i.test(e.name)) out.push(p);
    }
    return out.sort();
}

const books = epubsUnder(folder);
const done = new Set();
try { for (const l of fs.readFileSync(outFile, 'utf8').split(/\r?\n/)) { if (l.trim()) done.add(JSON.parse(l).book); } } catch (e) { }
console.log(books.length + ' books, ' + done.size + ' already measured');

for (const book of books) {
    const name = path.basename(book);
    if (done.has(name)) continue;
    // Never take a window away: a TypoZen that is not ours ends the run between books.
    if (isAppRunning()) { console.log('TypoZen is running -- stopping before ' + name); break; }
    const row = { book: name };
    const t0 = Date.now();
    let app = null;
    // A book that hangs is recorded and the run ends, closing the app it started; rerun
    // with the same output file and it carries on from the next book.
    const deadline = setTimeout(async () => {
        row.error = 'book deadline (120s)';
        row.seconds = Math.round((Date.now() - t0) / 1000);
        try { fs.appendFileSync(outFile, JSON.stringify(row) + '\n'); } catch (e) { }
        try { if (app) await app.close(); } catch (e) { }
        console.log('DEADLINE ' + name);
        setTimeout(() => process.exit(3), 2000);
    }, 120000);
    try {
        app = await launchApp({ file: book, settleMs: 8000, view: { scroll: 'pagination', columns: 2 } });
        await settledApp(app, 6000);
        const n = await app.eval(() => (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub') ? DocumentModel.blocks.length : 0);
        row.blocks = n;
        if (!n) throw new Error('the book did not open');
        // SWEEP_CONTROL=1: break the page on purpose -- the fault Zones of Thought had, and
        // a paragraph wider than its column -- to show the checks below can fail.
        if (process.env.SWEEP_CONTROL === '1') {
            await app.eval(() => {
                const s = document.createElement('style');
                s.textContent = '#editor-wrapper > #editor { margin-left: 16px !important }' +
                    ' #editor .block p { min-width: 2000px !important }';
                document.head.appendChild(s);
            });
            await sleep(600);
        }

        row.margins = await app.eval(() => {
            const wrap = document.getElementById('editor-wrapper'), ed = document.getElementById('editor');
            const wr = wrap.getBoundingClientRect(), er = ed.getBoundingClientRect(), cs = getComputedStyle(wrap);
            const left = er.left - wr.left, right = wr.right - er.right;
            return { left: Math.round(left), right: Math.round(right), want: Math.round(parseFloat(cs.paddingLeft)),
                     ok: Math.abs(left - parseFloat(cs.paddingLeft)) < 1 && Math.abs(right - parseFloat(cs.paddingRight)) < 1 };
        });

        row.overflows = [];
        for (let k = 0; k < SAMPLES && !row.error; k++) {
            const bi = Math.min(n - 1, Math.floor(((k + 0.5) / SAMPLES) * n));
            await app.eval((b) => goToReadingBlock(b), bi);
            await sleep(500);
            const found = await app.eval(() => {
                const ed = document.getElementById('editor');
                const er = ed.getBoundingClientRect();
                const pageH = er.height;
                const out = [];
                for (const b of ed.querySelectorAll('.block')) {
                    const rs = b.getClientRects();
                    let seen = false;
                    for (const r of rs) if (r.right > er.left && r.left < er.right && r.bottom > er.top && r.top < er.bottom) seen = true;
                    if (!seen) continue;
                    const mi = b.getAttribute('data-model-index');
                    if (b.scrollWidth > b.clientWidth + 1) {
                        // Name the widest thing inside, so the report says what it was.
                        let widest = null, w = 0;
                        for (const c of b.querySelectorAll('*')) {
                            const cw = Math.max(c.scrollWidth || 0, c.getBoundingClientRect().width);
                            if (cw > w && c.getClientRects().length === 1) { w = cw; widest = c; }
                        }
                        out.push({ block: mi, kind: 'wider than column', column: b.clientWidth, content: b.scrollWidth,
                                   what: widest ? widest.tagName.toLowerCase() + (widest.className ? '.' + String(widest.className).split(' ')[0] : '') : '?',
                                   text: (b.textContent || '').trim().slice(0, 60) });
                    }
                    for (const img of b.querySelectorAll('img, svg')) {
                        const ir = img.getBoundingClientRect();
                        if (ir.height > pageH + 1) out.push({ block: mi, kind: 'picture taller than page', page: Math.round(pageH), height: Math.round(ir.height) });
                    }
                }
                return out;
            });
            for (const f of found) if (!row.overflows.some(o => o.block === f.block && o.kind === f.kind)) row.overflows.push(f);
        }
    } catch (e) {
        row.error = row.error || String(e && e.message || e).split('\n')[0];
    } finally {
        clearTimeout(deadline);
        row.seconds = Math.round((Date.now() - t0) / 1000);
        if (app) { try { await app.close(); } catch (e) { } }
        await sleep(800);
    }
    fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
    const bad = (row.margins && !row.margins.ok ? 1 : 0) + (row.overflows ? row.overflows.length : 0);
    console.log((row.error ? 'ERROR ' : bad ? 'ISSUES ' : 'ok ') + name + ' (' + row.seconds + 's)' + (row.error ? ': ' + row.error : bad ? ': ' + bad : ''));
}
console.log('SWEEP DONE');
