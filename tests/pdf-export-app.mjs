/**
 * Saving a PDF's pages and pictures as images (docs/archive/pdf-and-audit-plan.md, Phase 2b).
 *
 * Runs the export the File menu starts, minus the dialog and the folder picker (they need a
 * person): pdf_export_test, honoured only under --debug and only into the temp folder, goes
 * straight to the job. Checked on disk: the right files, the right pixel size and DPI for
 * pages, a JPEG picture saved as the very bytes stored in the PDF, the icon skipped, a
 * repeated logo saved once, transparency kept, and a subfolder per page when asked.
 *
 *   RUN_APP_E2E=1 node tests/pdf-export-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp, sleep, profileDir } from './app-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PICS = path.join(here, 'pdf-pictures.pdf');
const SAMPLE = path.join(here, 'pdf-sample.pdf');
const EXE = process.env.TYPOZEN_EXE || path.join(here, '..', 'TypoZen.exe');
const OUT = path.join(os.tmpdir(), 'tz-pdf-export-' + process.pid);
let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 90000);
const waitFor = async (app, fn, ms) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await app.eval(fn); } catch (e) { v = null; } if (v || Date.now() > end) return v; await sleep(150); }
};
const files = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
/** Width, height, colour type and pixels-per-metre of a PNG; null if it is not one. */
function png(buf) {
    if (buf.readUInt32BE(0) !== 0x89504E47) return null;
    const r = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colour: buf[25], ppm: 0 };
    for (let at = 8; at + 8 <= buf.length;) {
        const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
        if (type === 'pHYs') r.ppm = buf.readUInt32BE(at + 8);
        if (type === 'IDAT') break;
        at += 12 + len;
    }
    return r;
}
/** Width, height and JFIF density of a JPEG. */
function jpeg(buf) {
    const r = { w: 0, h: 0, units: buf[13], dpi: buf.readUInt16BE(14) };
    for (let at = 2; at < buf.length;) {
        const m = buf[at + 1];
        if (m >= 0xC0 && m <= 0xC3) { r.h = buf.readUInt16BE(at + 5); r.w = buf.readUInt16BE(at + 7); break; }
        at += 2 + buf.readUInt16BE(at + 2);
    }
    return r;
}

/** Start an export in the app and wait for the page's report of the end. */
async function exportRun(app, job, ms) {
    await app.eval((j) => {
        window.__done = null;
        if (!window.__tzWrapped) {
            window.__tzWrapped = true;
            const real = window.postMsg;
            window.postMsg = (m) => { if (String(m).startsWith('pdf_export_done:')) window.__done = JSON.parse(String(m).slice(16)); return real(m); };
        }
        window.postMsg('pdf_export_test:' + JSON.stringify(j));
    }, job);
    return waitFor(app, () => window.__done, ms);
}

let app = null;
try {
    fs.rmSync(OUT, { recursive: true, force: true });
    app = await launchApp({ file: PICS, settleMs: 8000 });
    ok(!!await waitFor(app, () => window.tzPdfState && window.tzPdfState() && window.tzPdfState().pages === 2, 15000), 'the pictures PDF opens');

    // Pictures, with the dialog's defaults: skip small, repeats once, one folder.
    const d1 = path.join(OUT, 'pictures');
    const r1 = await exportRun(app, { kind: 'images', folder: d1, pages: [1, 2], format: 'png', dpi: 0, quality: 90, skipSmall: true, dedupe: true, perPage: false }, 20000);
    const got = files(d1);
    const trace = await app.eval(() => window.__tzExportTrace || []);
    if (trace.length) console.log('  ..    unreadable: ' + JSON.stringify(trace));
    ok(r1 && !r1.error && got.length === 3, 'three pictures saved: the photo, the logo once, the transparent one', JSON.stringify({ got, r1 }));
    ok(r1 && r1.small === 1 && r1.repeats === 1, 'the 16x16 icon is skipped and the second logo counted as a repeat', JSON.stringify(r1));
    const pdfBytes = fs.readFileSync(PICS);
    const jpgs = got.filter(f => f.endsWith('.jpg'));
    ok(jpgs.length === 1 && pdfBytes.indexOf(fs.readFileSync(path.join(d1, jpgs[0]))) > 0 && r1.originals === 1,
        'the photo is saved as the exact JPEG bytes stored in the PDF', JSON.stringify(jpgs));
    const pngs = got.filter(f => f.endsWith('.png')).map(f => ({ f, info: png(fs.readFileSync(path.join(d1, f))) }));
    ok(pngs.some(p => p.info && p.info.w === 200 && p.info.h === 120 && p.info.colour === 6)
        && pngs.some(p => p.info && p.info.w === 96 && p.info.h === 48),
        'other pictures are PNGs at their stored size, transparency kept', JSON.stringify(pngs));
    ok(got.every(f => /^pdf-pictures - p00[12] - img0\d\.(png|jpg)$/.test(f)), 'files are named by page and picture', JSON.stringify(got));

    // One subfolder per page, and nothing skipped.
    const d2 = path.join(OUT, 'per-page');
    const r2 = await exportRun(app, { kind: 'images', folder: d2, pages: [1, 2], format: 'png', dpi: 0, quality: 90, skipSmall: false, dedupe: false, perPage: true }, 20000);
    ok(r2 && !r2.error && files(d2).join() === 'p001,p002' && files(path.join(d2, 'p001')).length === 3 && files(path.join(d2, 'p002')).length === 2,
        'with a subfolder per page and no skipping, every picture lands under its page', JSON.stringify({ top: files(d2), p1: files(path.join(d2, 'p001')), p2: files(path.join(d2, 'p002')) }));

    // Pages, from the sample: PNG at 150 DPI and JPEG at 300 DPI, sized and marked.
    spawn(EXE, [SAMPLE], { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profileDir }) }).unref();
    await waitFor(app, () => window.tzPdfState && window.tzPdfState() && window.tzPdfState().pages === 3, 12000);
    const d3 = path.join(OUT, 'pages');
    const r3 = await exportRun(app, { kind: 'pages', folder: d3, pages: [1, 3], format: 'png', dpi: 150, quality: 90, skipSmall: true, dedupe: true, perPage: false }, 20000);
    const p3 = files(d3);
    const first = p3.length ? png(fs.readFileSync(path.join(d3, p3[0]))) : null;
    ok(r3 && !r3.error && p3.join() === 'pdf-sample - p001.png,pdf-sample - p003.png', 'pages 1 and 3 saved as PNG, named by page', JSON.stringify(p3));
    ok(first && first.w === 875 && first.h === 1241 && first.ppm === Math.round(150 / 0.0254),
        'a 420 x 595.92 pt page at 150 DPI is 875 x 1241 pixels and says 150 DPI', JSON.stringify(first));
    const d4 = path.join(OUT, 'pages-jpeg');
    const r4 = await exportRun(app, { kind: 'pages', folder: d4, pages: [2], format: 'jpeg', dpi: 300, quality: 85, skipSmall: true, dedupe: true, perPage: false }, 20000);
    const p4 = files(d4);
    const j4 = p4.length ? jpeg(fs.readFileSync(path.join(d4, p4[0]))) : null;
    ok(r4 && !r4.error && p4.join() === 'pdf-sample - p002.jpg' && j4 && j4.w === 1750 && j4.h === 2482 && j4.units === 1 && j4.dpi === 300,
        'JPEG at 300 DPI: 1750 x 2482, density 300', JSON.stringify({ p4, j4 }));

    // Saving again into the same folder never overwrites.
    const r5 = await exportRun(app, { kind: 'pages', folder: d4, pages: [2], format: 'jpeg', dpi: 72, quality: 85, skipSmall: true, dedupe: true, perPage: false }, 20000);
    ok(r5 && files(d4).join() === 'pdf-sample - p002 (2).jpg,pdf-sample - p002.jpg', 'a second save beside the first is numbered, not written over', JSON.stringify(files(d4)));

    // The host writes only for a job it started, and only inside its folder.
    const refused = await app.eval(async () => {
        const a = await fetch('https://localpdf/export/not-a-job/x.png', { method: 'POST', body: new Uint8Array([1, 2, 3]).buffer });
        return a.status;
    });
    ok(refused === 403, 'a file for a job the host did not start is refused', String(refused));
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { }
    clearTimeout(killer);
    console.log(failed ? 'PDF-EXPORT FAILED' : 'PDF-EXPORT PASSED');
    process.exitCode = failed ? 1 : 0;
}
