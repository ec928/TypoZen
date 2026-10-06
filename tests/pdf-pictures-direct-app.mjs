/**
 * Save All Images in PDF, read straight from the file (PdfPictures.cs) rather than decoded by
 * the viewer -- the "Original files" and "All as PNG" methods.
 *
 * Same fixture and same checks as pdf-export-app (which covers the viewer's method), plus what
 * is particular to reading the file: the photo is the exact JPEG in the PDF, everything the
 * host saves is at its stored size, and the one picture it cannot hand over as it is -- the
 * transparent one, whose transparency is a separate mask image -- is saved by the viewer
 * instead, numbered after the host's own and with its transparency kept.
 *
 *   RUN_APP_E2E=1 node tests/pdf-pictures-direct-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('PDF PICTURES DIRECT SKIPPED (set RUN_APP_E2E=1)'); process.exit(0); }
const here = path.dirname(fileURLToPath(import.meta.url));
const PICS = path.join(here, 'pdf-pictures.pdf');
const OUT = path.join(os.tmpdir(), 'tz-pdf-direct-' + process.pid);
let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 90000);
const waitFor = async (app, fn, ms) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await app.eval(fn); } catch (e) { v = null; } if (v || Date.now() > end) return v; await sleep(150); }
};
const files = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
function png(buf) {
    if (buf.readUInt32BE(0) !== 0x89504E47) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colour: buf[25] };
}

/** Start an export and wait for the host's summed result (sent to the page under --debug). */
async function exportRun(app, job, ms) {
    await app.eval((j) => { window.__tzExportResult = null; window.postMsg('pdf_export_test:' + JSON.stringify(j)); }, job);
    return waitFor(app, () => window.__tzExportResult, ms);
}
const base = { kind: 'images', pages: [1, 2], format: 'png', dpi: 0, quality: 90 };

let app = null;
try {
    fs.rmSync(OUT, { recursive: true, force: true });
    app = await launchApp({ file: PICS, settleMs: 8000 });
    ok(!!await waitFor(app, () => window.tzPdfState && window.tzPdfState() && window.tzPdfState().pages === 2, 15000), 'the pictures PDF opens');
    const pdfBytes = fs.readFileSync(PICS);

    // Original files, with the dialog's defaults.
    const d1 = path.join(OUT, 'original');
    const t0 = Date.now();
    const r1 = await exportRun(app, Object.assign({ folder: d1, method: 'original', skipSmall: true, dedupe: true, perPage: false }, base), 20000);
    const got = files(d1);
    ok(r1 && !r1.error && got.length === 3, 'three pictures saved: the photo, the logo once, the transparent one', JSON.stringify({ got, r1 }));
    ok(r1 && r1.small === 1 && r1.repeats === 1, 'the icon is skipped and the second logo counted as a repeat', JSON.stringify(r1));
    const jpgs = got.filter(f => f.endsWith('.jpg'));
    ok(jpgs.length === 1 && pdfBytes.indexOf(fs.readFileSync(path.join(d1, jpgs[0]))) > 0 && r1.originals === 1,
        'the photo is the exact JPEG stored in the PDF', JSON.stringify(jpgs));
    const pngs = got.filter(f => f.endsWith('.png')).map(f => ({ f, info: png(fs.readFileSync(path.join(d1, f))) }));
    ok(r1 && r1.viewer === 1 && pngs.some(p => p.info && p.info.w === 200 && p.info.h === 120 && p.info.colour === 6),
        'the transparent picture is saved by the viewer, transparency kept', JSON.stringify({ viewer: r1 && r1.viewer, pngs }));
    ok(pngs.some(p => p.info && p.info.w === 96 && p.info.h === 48), 'the logo is a PNG at its stored size', JSON.stringify(pngs));
    ok(got.every(f => /^pdf-pictures - p00[12] - img0\d\.(png|jpg)$/.test(f)) && new Set(got).size === got.length,
        'named by page and picture, the viewer\'s numbered after the host\'s', JSON.stringify(got));
    console.log('  ..    original files took ' + (Date.now() - t0) + ' ms');

    // All as PNG: the photo decoded once, at its stored size.
    const d2 = path.join(OUT, 'png');
    const r2 = await exportRun(app, Object.assign({ folder: d2, method: 'png', skipSmall: true, dedupe: true, perPage: false }, base), 20000);
    const g2 = files(d2);
    const photoJpeg = fs.readFileSync(path.join(d1, jpgs[0]));
    let jw = 0, jh = 0;
    for (let at = 2; at < photoJpeg.length;) { const m = photoJpeg[at + 1]; if (m >= 0xC0 && m <= 0xC3) { jh = photoJpeg.readUInt16BE(at + 5); jw = photoJpeg.readUInt16BE(at + 7); break; } at += 2 + photoJpeg.readUInt16BE(at + 2); }
    const i2 = g2.map(f => png(fs.readFileSync(path.join(d2, f))));
    ok(r2 && !r2.error && g2.length === 3 && g2.every(f => f.endsWith('.png')) && i2.every(Boolean),
        'All as PNG: three pictures, every one a PNG', JSON.stringify({ g2, r2 }));
    ok(i2.some(p => p.w === jw && p.h === jh) && r2.originals === 0, 'the photo becomes a PNG of its own size (' + jw + ' x ' + jh + ')', JSON.stringify(i2));

    // A subfolder per page, nothing skipped: the same files the viewer's method gives.
    const d3 = path.join(OUT, 'per-page');
    const r3 = await exportRun(app, Object.assign({ folder: d3, method: 'original', skipSmall: false, dedupe: false, perPage: true }, base), 20000);
    ok(r3 && !r3.error && files(d3).join() === 'p001,p002' && files(path.join(d3, 'p001')).length === 3 && files(path.join(d3, 'p002')).length === 2,
        'with a subfolder per page and no skipping, every picture lands under its page', JSON.stringify({ p1: files(path.join(d3, 'p001')), p2: files(path.join(d3, 'p002')), r3 }));

    // Saving again beside the first never writes over it.
    const r4 = await exportRun(app, Object.assign({ folder: d1, method: 'original', skipSmall: true, dedupe: true, perPage: false }, base), 20000);
    const again = files(d1);
    ok(r4 && again.length === 6 && again.filter(f => / \(2\)\./.test(f)).length === 3, 'a second save beside the first is numbered, not written over', JSON.stringify(again));

    // A picture the two readers size differently (tests/pdf-smask-size.pdf, from
    // make-pdf-smask-size.mjs): 2x2 to PdfPig, 40x40 -- its mask's size -- to PDF.js. The host
    // hands it to the viewer as 2x2, which matches nothing the viewer decoded; it used to be
    // reported as handed over and never written.
    const SM = path.join(here, 'pdf-smask-size.pdf');
    await app.eval((p) => postMsg('open_file_path:' + p), SM);
    ok(!!await waitFor(app, () => { const s = window.tzPdfState && window.tzPdfState(); return s && /pdf-smask-size/.test(decodeURIComponent(s.url || '')) && s.pages === 1; }, 15000), 'the mask-size PDF opens');
    const d5 = path.join(OUT, 'smask-size');
    const r5 = await exportRun(app, Object.assign({ folder: d5, method: 'original', skipSmall: false, dedupe: true, perPage: false },
        Object.assign({}, base, { pages: [1] })), 20000);
    const g5 = files(d5);
    const i5 = g5.filter(f => f.endsWith('.png')).map(f => png(fs.readFileSync(path.join(d5, f))));
    ok(r5 && r5.viewer === 1 && g5.length === 1 && i5[0] && i5[0].w === 40 && i5[0].h === 40,
        'a picture sized differently by the two readers is still saved, once', JSON.stringify({ g5, i5, r5 }));
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { }
    clearTimeout(killer);
    console.log(failed ? 'PDF PICTURES DIRECT FAILED' : 'PDF PICTURES DIRECT PASSED');
    process.exitCode = failed ? 1 : 0;
}
