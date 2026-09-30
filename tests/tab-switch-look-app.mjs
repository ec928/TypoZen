// A tab switch changes the whole look in one step, and the tab switched to shows its own text.
//
// Until 2026-09-30 switching from a Markdown tab to a book showed the book first in the
// Markdown tab's theme and font, then changed font, margins, spacing, background and text size
// one command at a time: 4.6 s and six visible states, the book paginated about five times.
// The look now travels with the document (view_profile, 03-shell.js) and is in force before it
// is laid out. Two defects found on the way are held here too:
//   - opening a book from a Markdown tab and switching back showed an empty page, while the
//     page's model still held the book and reported its HTML as the Markdown file's text;
//   - Ctrl+Tab from the editor (tab:next) waited out a 400 ms script timeout on every switch.
//
//   RUN_APP_E2E=1 node tests/tab-switch-look-app.mjs
import fs from 'fs';
import path from 'path';
import { launchApp, profileFile, sleep, appDir } from './app-harness.mjs';

let passed = 0, failed = 0;
function check(ok, msg, got) {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg + (got !== undefined ? '  (got ' + JSON.stringify(got) + ')' : '')); }
}
setTimeout(() => { console.log('DEADLINE'); process.exit(2); }, 90000);

const md = profileFile('notes.md');
fs.writeFileSync(md, '# Notes\n\nSome ordinary notes in a Markdown file.\n\nA second paragraph.\n');
const book = path.join(appDir, 'tests', 'jane-austen_pride-and-prejudice.epub');

// Records, from the moment it is armed, every host message and every change in what is painted.
function arm() {
    const t0 = performance.now(), log = window.__look = { msgs: [], frames: [] };
    const ms = () => Math.round(performance.now() - t0);
    const onMsg = (e) => log.msgs.push({ t: ms(), m: String(e.data).slice(0, 60) });
    window.chrome.webview.addEventListener('message', onMsg);
    const ed = document.getElementById('editor');
    let last = '';
    const tick = () => {
        const cs = getComputedStyle(ed), b = getComputedStyle(document.body);
        const fb = ed.style.display === 'none' ? null : ed.querySelector('.block');
        const f = { t: ms(), bg: b.backgroundColor, font: cs.fontSize + ' ' + cs.fontFamily.split(',')[0], lh: cs.lineHeight,
            two: ed.classList.contains('two-col-layout'), text: fb ? (fb.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20) : '' };
        const s = JSON.stringify([f.bg, f.font, f.lh, f.two, f.text]);
        if (s !== last) { log.frames.push(f); last = s; }
        if (ms() < 5000) requestAnimationFrame(tick);
        else window.chrome.webview.removeEventListener('message', onMsg);
    };
    requestAnimationFrame(tick);
}

let app;
try {
    app = await launchApp({ file: md, settleMs: 5000, view: true });
    await app.eval((p) => postMsg('open_file_path:' + p), book);
    await sleep(6000);

    console.log('=== back to the Markdown tab the book was opened from ===');
    await app.eval(arm);
    await app.eval(() => postMsg('tab:prev'));
    await sleep(5200);
    const onMd = await app.eval(() => ({
        blocks: DocumentModel.blocks.length, kind: DocumentModel.kind,
        shown: document.getElementById('editor').innerText.slice(0, 40), md: getMarkdownContent(false).slice(0, 20),
        log: window.__look }));
    check(/Notes/.test(onMd.shown), 'the Markdown tab shows its own text', onMd.shown);
    check(onMd.md.startsWith('# Notes') && onMd.kind !== 'epub' && onMd.blocks < 50,
        'and its model is the Markdown file, not the book', { md: onMd.md, kind: onMd.kind, blocks: onMd.blocks });
    for (const f of onMd.log.frames) console.log('    ' + f.t + 'ms  ' + [f.bg, f.font, f.lh, f.two ? '2-col' : '1-col', '"' + f.text + '"'].join(' | '));
    for (const m of onMd.log.msgs.filter(m => !/wordwrap|stats_refresh|host_zoom/.test(m.m))) console.log('    ' + m.t + 'ms  MSG ' + m.m);
    const mdFrames = onMd.log.frames.filter(f => /Notes|Some ordinary/.test(f.text));
    const mdFinal = onMd.log.frames[onMd.log.frames.length - 1];
    check(mdFrames.length > 0 && mdFrames[0].bg === mdFinal.bg && mdFrames[0].font === mdFinal.font,
        'its first painted frame already has its own look', mdFrames[0]);
    // Between the book leaving and the notes arriving the page may be empty for a frame; it
    // must already be in the notes' colours, not the book's.
    const between = onMd.log.frames.filter(f => !f.text && f.t > 0);
    check(between.every(f => f.bg === mdFinal.bg), 'no frame in between shows the book\'s colours', between);

    console.log('=== Markdown tab -> book ===');
    await app.eval(arm);
    await app.eval(() => postMsg('tab:next'));
    await sleep(5200);
    const log = await app.eval(() => window.__look);
    const bookFrames = log.frames.filter(f => /Pride|Prejudice|Austen/.test(f.text));
    const fin = log.frames[log.frames.length - 1];
    for (const f of log.frames) console.log('    ' + f.t + 'ms  ' + [f.bg, f.font, f.lh, f.two ? '2-col' : '1-col', '"' + f.text + '"'].join(' | '));
    check(bookFrames.length > 0, 'the book is painted');
    const looks = new Set(bookFrames.map(f => [f.bg, f.font, f.lh, f.two].join('|')));
    check(looks.size === 1, 'once the book is on screen its look never changes (one state, not a sequence)', [...looks]);
    check(bookFrames.length > 0 && bookFrames[0].bg === fin.bg && bookFrames[0].font === fin.font && bookFrames[0].lh === fin.lh,
        'its first painted frame is already its final look', bookFrames[0]);
    const lookCmds = log.msgs.filter(m => /set_theme:|set_margin_|set_justify:|set_line_spacing:|set_para_spacing:|set_font_size:|set_word_wrap:/.test(m.m));
    check(lookCmds.length === 0, 'no piecemeal look commands', lookCmds.map(m => m.m));
    const load = log.msgs.find(m => /^fetch_and_load_book:/.test(m.m));
    const profiles = log.msgs.filter(m => /view_profile:/.test(m.m) && load && m.t <= load.t);
    check(profiles.length === 1, 'one view profile, sent with the book', profiles.length);
    check(!!load && load.t < 200, 'the host starts the book within 200 ms of Ctrl+Tab (no script timeout)', load && load.t);
    const settled = bookFrames.length ? bookFrames[0].t : -1;
    console.log('  ..   book on screen in its final look at ' + settled + ' ms');
} catch (e) {
    failed++;
    console.log('  FAIL threw: ' + e.message);
} finally {
    if (app) await app.close();
}
console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'TAB SWITCH LOOK FAILED' : 'TAB SWITCH LOOK PASSED');
process.exit(failed ? 1 : 0);
