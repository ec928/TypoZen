/**
 * An image pasted into an untitled document is kept, and lands beside the document at its
 * first save.
 *
 * Until 0.5.8 the paste was refused ("Save the document first"). Now it waits in a pending
 * folder under a link that carries its own key (typozen-pending/<key>/image-...), and the
 * first save copies it into the document's image folder, rewrites the link in the saved
 * text and in the editor, and deletes the pending copy. Touches the save path, hence a
 * test.
 *
 *   RUN_APP_E2E=1 node tests/pending-images-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, profileDir } from './app-harness.mjs';

let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 60000);

// A 1x1 red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const dir = path.join(os.tmpdir(), 'tz-pending-images-' + process.pid);
fs.mkdirSync(dir, { recursive: true });
const saveTo = path.join(dir, 'Pasted.md');
let app = null;
try {
    app = await launchApp({ settleMs: 8000, env: { TYPOZEN_SAVE_AS_PATH: saveTo } });
    const md = () => app.eval(() => getMarkdownContent(false));
    await app.eval(() => { if (typeof handleCommand === 'function') handleCommand('new_tab'); });
    await app.eval(() => {
        const ed = document.getElementById('editor'); ed.focus();
        const p = ed.querySelector('.block') || ed; const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await app.eval((b64) => postMsg('image_paste:png:' + b64), PNG);
    let text = ''; for (let i = 0; i < 20 && !/typozen-pending\//.test(text); i++) { await sleep(200); text = await md(); }
    const link = (text.match(/typozen-pending\/[0-9a-f]{32}\/image-[^)\s]+/) || [])[0];
    ok(!!link, 'the paste is accepted into an untitled document', link || text.slice(0, 80));
    const pendingFile = link ? path.join(profileDir, 'pending_images', ...link.split('/').slice(1)) : '';
    ok(link && fs.existsSync(pendingFile), 'and waits in the pending folder');

    await app.eval(() => postMsg('debug_save'));
    let saved = ''; for (let i = 0; i < 25 && !saved; i++) { await sleep(200); try { saved = fs.readFileSync(saveTo, 'utf8'); } catch (e) { } }
    ok(!!saved, 'the first save writes the document', saveTo);
    const rel = (saved.match(/\]\(([^)]+)\)/) || [])[1] || '';
    ok(rel && !/typozen-pending/.test(saved), 'the saved link points beside the document', rel);
    ok(rel && fs.existsSync(path.join(dir, ...rel.split('/'))), 'and the image is there');
    ok(link && !fs.existsSync(pendingFile), 'the pending copy is gone');
    await sleep(500);
    const after = await md();
    ok(!/typozen-pending/.test(after) && after.includes(rel), 'the editor holds the rewritten link too');
    ok(!(await app.eval(() => getMarkdownContent(false) !== state.lastSavedContent)), 'and the document is not left dirty');
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
    clearTimeout(killer);
    console.log(failed ? 'PENDING-IMAGES FAILED' : 'PENDING-IMAGES PASSED');
    process.exitCode = failed ? 1 : 0;
}
