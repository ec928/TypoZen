/**
 * Putting a picture into a saved document: paste it, or drop it.
 *
 * The page hands the bytes to the host (image_paste:), the host writes them beside the
 * document and answers with the relative path (insert_image:), and the page inserts
 * ![](path). This checks the whole round trip in the real app: the reference is in the
 * document, the file beside it holds exactly the pasted bytes, the picture is shown, a save
 * writes the reference, and a second picture gets its own file rather than overwriting.
 * (An untitled document parks pictures until its first save: pending-images-app.)
 *
 * The paste is the event a Ctrl+V delivers, carrying the image as a file -- not the system
 * clipboard, which on a developer's machine is theirs.
 *
 *   RUN_APP_E2E=1 node tests/image-insert-app.mjs     (~10 s, hidden desktop)
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { launchApp, profileFile, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 90000);

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

/** A small real PNG: w x h, one solid colour. */
function png(w, h, rgb) {
    const crc = (buf) => { let c, t = [], r = 0xFFFFFFFF; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } for (const b of buf) r = t[(r ^ b) & 255] ^ (r >>> 8); return (r ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const doc = profileFile('image-insert.md');
const docDir = path.dirname(doc);
fs.writeFileSync(doc, '# Pictures\n\nBefore the picture.\n\nAfter.\n', 'utf8');
const red = png(8, 6, [220, 30, 30]), blue = png(5, 4, [30, 30, 220]);

const md = (app) => app.eval(() => getMarkdownContent(false));
const refs = (s) => [...s.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => decodeURIComponent(m[1]));

let app;
try {
    app = await launchApp({ file: doc, settleMs: 6000 });
    // The caret at the end of "Before the picture." -- a real click.
    const pt = await app.eval(() => {
        const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
        let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('Before the picture.') < 0) {}
        const r = document.createRange(); r.setStart(t, t.nodeValue.length); r.setEnd(t, t.nodeValue.length);
        const b = r.getBoundingClientRect(); return { x: b.left - 1, y: b.top + b.height / 2 };
    });
    await app.page.mouse.click(pt.x, pt.y);
    await sleep(300);

    console.log('=== paste a picture ===');
    await app.eval((b64) => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, red.toString('base64'));
    let t0 = Date.now(), r1 = [];
    while (Date.now() - t0 < 8000 && !(r1 = refs(await md(app))).length) await sleep(150);
    assert(r1.length === 1, 'the document gains one picture reference (' + JSON.stringify(r1) + ')');
    const f1 = r1.length ? path.join(docDir, r1[0]) : '';
    assert(f1 && fs.existsSync(f1) && fs.readFileSync(f1).equals(red), 'the file beside the document holds exactly the pasted bytes (' + f1 + ')');
    const shown = async (rel) => {
        const end = Date.now() + 6000;
        while (Date.now() < end) {
            const w = await app.eval((r) => { const i = [...document.querySelectorAll('#editor img')].find(x => decodeURIComponent(x.getAttribute('data-src') || x.getAttribute('src') || '').endsWith(r)); return i && i.complete ? i.naturalWidth : 0; }, rel);
            if (w) return w;
            await sleep(150);
        }
        return 0;
    };
    assert(r1.length && (await shown(r1[0])) === 8, 'and the picture is shown at its own size (8 px wide)');
    const at = (await md(app)).indexOf('Before the picture.');
    assert(at >= 0 && (await md(app)).indexOf('![') > at && (await md(app)).indexOf('![') < (await md(app)).indexOf('After.'),
        'where the caret was: after "Before", before "After"');

    console.log('\n=== drop a second picture ===');
    await app.eval((b64) => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
        const ed = document.getElementById('editor');
        const r = ed.querySelector('.block').getBoundingClientRect();
        const o = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 };
        ed.dispatchEvent(new DragEvent('dragover', o));
        ed.dispatchEvent(new DragEvent('drop', o));
    }, blue.toString('base64'));
    let r2 = [];
    t0 = Date.now();
    while (Date.now() - t0 < 8000 && (r2 = refs(await md(app))).length < 2) await sleep(150);
    const f2 = r2.length === 2 ? path.join(docDir, r2.find(x => x !== r1[0]) || '') : '';
    assert(r2.length === 2 && f2 && f2 !== f1, 'it gets a reference and a file of its own (' + JSON.stringify(r2) + ')');
    assert(f2 && fs.existsSync(f2) && fs.readFileSync(f2).equals(blue) && fs.readFileSync(f1).equals(red),
        'its bytes are its own, and the first file is untouched');

    console.log('\n=== save ===');
    await app.eval(() => { try { postMsg('debug_save'); } catch (e) {} });
    t0 = Date.now();
    let disk = '';
    while (Date.now() - t0 < 8000 && refs(disk = fs.readFileSync(doc, 'utf8')).length < 2) await sleep(200);
    assert(refs(disk).length === 2 && disk.includes('Before the picture.') && disk.includes('After.'), 'the saved file carries both references and the text');
} catch (e) {
    failed++; console.error('  FAIL ' + e.message.split('\n')[0]);
} finally {
    if (app) await app.close();
    clearTimeout(killer);
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('\nIMAGE INSERT APP FAILED'); process.exit(1); }
console.log('\nIMAGE INSERT APP PASSED');
process.exit(0);
