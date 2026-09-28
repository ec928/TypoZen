/**
 * Annotating a PDF, filling in its form, and saving (docs/archive/pdf-and-audit-plan.md, Phase 4).
 *
 * Works on copies in a temp folder. A highlight made from selected text can be undone and
 * redone, survives switching to another tab and back (the unsaved PDF is kept aside), and
 * saving writes a new file with it in -- the original untouched, byte for byte. A form field
 * filled in is saved into the new file.
 *
 * pdf_save_test, honoured only under --debug and only into the temp folder, saves without
 * the Save dialog.
 *
 *   RUN_APP_E2E=1 node tests/pdf-annotate-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { launchApp, sleep, profileDir } from './app-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.env.TYPOZEN_EXE || path.join(here, '..', 'TypoZen.exe');
const T = path.join(os.tmpdir(), 'tz-annotate-' + process.pid);
let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 120000);
const waitFor = async (app, fn, ms, arg) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await app.eval(fn, arg); } catch (e) { v = null; } if (v || Date.now() > end) return v; await sleep(150); }
};
const waitFile = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fs.existsSync(f) && fs.statSync(f).size > 0) return true; await sleep(150); } return false; };
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const openInApp = (file) => spawn(EXE, [file], { detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profileDir }) }).unref();
/** Annotations of a page of the PDF now on screen, read afresh from its file. */
const annotationsOf = (app, page) => app.eval(async (p) => {
    const d = await globalThis.pdfjsLib.getDocument({ url: window.tzPdfState().url, isEvalSupported: false }).promise;
    const a = await (await d.getPage(p)).getAnnotations();
    const fields = await d.getFieldObjects();
    d.destroy && d.destroy();
    // Field values as the page's widgets carry them (getFieldObjects is only filled for
    // documents PDF.js treats as having a form; the widgets always say).
    const fromWidgets = {};
    for (const x of a) if (x.fieldName) (fromWidgets[x.fieldName] = fromWidgets[x.fieldName] || []).push(x.fieldValue);
    return { subtypes: a.map(x => x.subtype), fields: fromWidgets, fieldObjects: !!fields };
}, page);

let app = null;
try {
    fs.mkdirSync(T, { recursive: true });
    const A = path.join(T, 'sample.pdf'), F = path.join(T, 'form.pdf'), NOTE = path.join(T, 'note.md');
    fs.copyFileSync(path.join(here, 'pdf-sample.pdf'), A);
    fs.copyFileSync(path.join(here, 'pdf-form.pdf'), F);
    fs.writeFileSync(NOTE, '# A note\n\nAnother tab for a moment.\n');
    const originalHash = hash(A);

    app = await launchApp({ file: A, settleMs: 8000 });
    await waitFor(app, () => window.tzPdfTextReady && window.tzPdfTextReady(), 15000);
    await app.eval(() => { window.prompt = () => '3'; openGoToPageDialog(); });
    await waitFor(app, () => window.tzPdfState().page === 3 && document.querySelector('#pdfView .page[data-page-number="3"] .textLayer span'), 5000);

    // Highlight the selected words (the highlight tool's "highlight selection").
    await app.eval(() => {
        const layer = document.querySelector('#pdfView .page[data-page-number="3"] .textLayer');
        const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        let n; while ((n = tw.nextNode())) { const i = n.nodeValue.indexOf('harbour'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 7); const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
        window.tzPdfEditAction('highlightSelection');
    });
    const made = await waitFor(app, () => document.querySelectorAll('#pdfView .highlightEditor').length && window.tzPdfState().modified ? true : null, 5000);
    ok(!!made, 'selected words are highlighted, and the PDF has unsaved changes', made ? '' : JSON.stringify(await app.eval(() => ({ editors: document.querySelectorAll('#pdfView .highlightEditor').length, state: window.tzPdfState(), sel: String(getSelection()) }))));
    // Undo and Redo as the Edit menu sends them.
    await app.eval(() => handleCommand('undo'));
    ok(!!await waitFor(app, () => document.querySelectorAll('#pdfView .highlightEditor').length === 0, 3000), 'Undo takes the highlight away');
    await app.eval(() => handleCommand('redo'));
    ok(!!await waitFor(app, () => document.querySelectorAll('#pdfView .highlightEditor').length === 1, 3000), 'Redo puts it back');
    await app.eval(() => window.tzPdfEditMode('none'));
    await sleep(500);

    // Another tab and back: the unsaved highlight is kept aside and comes back.
    openInApp(NOTE);
    ok(!!await waitFor(app, () => !window.tzPdfActive && /Another tab/.test(getMarkdownContent(false)), 15000), 'another document opens over the annotated PDF');
    await app.eval(() => postMsg('tab:prev'));
    await waitFor(app, () => window.tzPdfActive && window.tzPdfState() && window.tzPdfState().pages === 3, 15000);
    const back = await annotationsOf(app, 3);
    ok(back.subtypes.includes('Highlight'), 'back on the PDF, the unsaved highlight is still there', JSON.stringify(back.subtypes));

    // Save: a new file with the highlight; the original untouched.
    const OUT = path.join(T, 'sample-annotated.pdf');
    await app.eval((p) => postMsg('pdf_save_test:' + p), OUT);
    ok(await waitFile(OUT, 15000), 'Save writes a new file', OUT);
    await waitFor(app, () => /sample-annotated\.pdf$/.test(window.tzPdfState().url) ? true : null, 5000);
    const saved = await annotationsOf(app, 3);
    ok(saved.subtypes.includes('Highlight'), 'the saved PDF holds the highlight, and the tab is now that file', JSON.stringify({ saved: saved.subtypes, url: (await app.eval(() => window.tzPdfState().url)).slice(-30) }));
    ok(hash(A) === originalHash, 'the original PDF is untouched, byte for byte');

    // A form: fill in the field, save, and the value is in the new file.
    openInApp(F);
    await waitFor(app, () => window.tzPdfActive && window.tzPdfState() && window.tzPdfState().pages === 1 && document.querySelector('#pdfView .annotationLayer input'), 15000);
    await app.eval(() => {
        const input = document.querySelector('#pdfView .annotationLayer input');
        input.focus();
        input.value = 'Ada Lovelace';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
    });
    ok(!!await waitFor(app, () => window.tzPdfState().modified, 3000), 'typing in a form field is an unsaved change');
    const FOUT = path.join(T, 'form-filled.pdf');
    await app.eval((p) => postMsg('pdf_save_test:' + p), FOUT);
    ok(await waitFile(FOUT, 15000), 'the filled-in form is saved to a new file');
    await waitFor(app, () => /form-filled\.pdf$/.test(window.tzPdfState().url) ? true : null, 5000);
    const form = await annotationsOf(app, 1);
    ok(form.fields && form.fields.name && form.fields.name[0] === 'Ada Lovelace', 'the saved form holds the value', JSON.stringify(form.fields));
    ok(!(await app.eval(() => window.tzPdfState().modified)), 'after saving, nothing is unsaved');

    // A drawing is only committed when the tool is put down. Switching tabs with the Draw
    // tool still in hand must keep it, not lose it.
    const C = path.join(T, 'draw.pdf'), NOTE2 = path.join(T, 'note2.md');
    fs.copyFileSync(path.join(here, 'pdf-sample.pdf'), C);
    fs.writeFileSync(NOTE2, '# Second note\n\nJust passing through.\n');
    openInApp(C);
    await waitFor(app, () => window.tzPdfActive && window.tzPdfState() && /draw\.pdf$/.test(window.tzPdfState().url) && window.tzPdfState().pages === 3
        && document.querySelector('#pdfView .page[data-page-number="1"] .annotationEditorLayer'), 15000);
    await app.eval(() => window.tzPdfEditMode('draw'));
    await sleep(600);
    const box = await app.eval(() => {
        const r = document.querySelector('#pdfView .page[data-page-number="1"] .annotationEditorLayer').getBoundingClientRect();
        const top = Math.max(r.y, 0) + 60, bottom = Math.min(r.bottom, window.innerHeight) - 20;
        return { x: r.x, y: top, w: r.width, h: bottom - top };
    });
    const m = app.page.mouse;
    await m.move(box.x + box.w * 0.3, box.y + box.h * 0.5);
    await m.down();
    for (let i = 1; i <= 10; i++) await m.move(box.x + box.w * (0.3 + i * 0.03), box.y + box.h * (0.5 + (i % 2) * 0.05));
    await m.up();
    await sleep(400);
    openInApp(NOTE2);
    ok(!!await waitFor(app, () => !window.tzPdfActive && /passing through/.test(getMarkdownContent(false)), 15000), 'another document opens while the Draw tool is still in hand');
    await app.eval(() => postMsg('tab:prev'));
    await waitFor(app, () => window.tzPdfActive && window.tzPdfState() && window.tzPdfState().pages === 3, 15000);
    const drawn = await annotationsOf(app, 1);
    ok(drawn.subtypes.includes('Ink'), 'back on the PDF, the drawing is there', JSON.stringify(drawn.subtypes));
    const DOUT = path.join(T, 'draw-annotated.pdf');
    await app.eval((p) => postMsg('pdf_save_test:' + p), DOUT);
    ok(await waitFile(DOUT, 15000), 'and it saves');
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { }
    clearTimeout(killer);
    console.log(failed ? 'PDF-ANNOTATE FAILED' : 'PDF-ANNOTATE PASSED');
    process.exitCode = failed ? 1 : 0;
}
