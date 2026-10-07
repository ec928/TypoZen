/**
 * Tabs, used the ordinary way: open three documents, move between them with Ctrl+Tab and
 * Ctrl+Shift+Tab, edit one and come back to the edit, open one that is already open, close
 * one with Ctrl+W.
 *
 * What the host holds is read from its own record of the open tabs (tabs_session.txt in
 * the test profile: count, active, one path per tab); what is on screen is the page's
 * text. Files are opened the way File > Open and a double-click hand them over
 * (open_file_path:); the keys are pressed. Closing a tab with unsaved changes asks in a
 * Windows dialog and is not covered here.
 *
 *   RUN_APP_E2E=1 node tests/tabs-app.mjs     (~20 s, hidden desktop)
 */
import fs from 'fs';
import { launchApp, profileFile, sleep } from './app-harness.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('skipped (set RUN_APP_E2E=1)'); process.exit(0); }
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 120000);

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const docs = { A: 'Alpha document text.', B: 'Bravo document text.', C: 'Charlie document text.' };
const file = {};
for (const k of Object.keys(docs)) { file[k] = profileFile('tab-' + k + '.md'); fs.writeFileSync(file[k], '# ' + k + '\n\n' + docs[k] + '\n', 'utf8'); }
const SESSION = profileFile('tabs_session.txt');

/** The host's record of its tabs. */
function session() {
    let s = '';
    try { s = fs.readFileSync(SESSION, 'utf8'); } catch (e) { return null; }
    const get = (k) => { const m = s.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : null; };
    const paths = [...s.matchAll(/^path=(.*)$/gm)].map(m => m[1].trim().toLowerCase());
    const dirty = [...s.matchAll(/^dirty=(.*)$/gm)].map(m => m[1].trim());
    return { count: +get('count'), active: +get('active'), paths, dirty };
}
const wait = async (fn, ms) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };
let app;
const shown = () => app.eval(() => document.getElementById('editor').innerText);
const showing = (k) => wait(async () => (await shown()).includes(docs[k]), 8000);
const idx = (s, k) => s ? s.paths.indexOf(file[k].toLowerCase()) : -1;
async function chord(keys) {
    await app.eval(() => { const ed = document.getElementById('editor'); ed.focus({ preventScroll: true }); });
    for (const k of keys.slice(0, -1)) await app.page.keyboard.down(k);
    await app.page.keyboard.press(keys[keys.length - 1]);
    for (const k of keys.slice(0, -1).reverse()) await app.page.keyboard.up(k);
}

try {
    app = await launchApp({ file: file.A, settleMs: 6000 });
    console.log('=== open three documents ===');
    for (const k of ['B', 'C']) {
        await app.eval((p) => postMsg('open_file_path:' + p), file[k]);
        assert(await showing(k), 'opening ' + k + ' shows it');
    }
    let s = await wait(() => { const v = session(); return v && v.count === 3 ? v : null; }, 6000);
    assert(s && s.count === 3 && idx(s, 'A') >= 0 && idx(s, 'B') >= 0 && idx(s, 'C') >= 0, 'the host has three tabs, one per document', s);
    assert(s && s.active === idx(s, 'C'), 'and the last one opened is active');

    console.log('\n=== move between them with the keyboard ===');
    await chord(['Control', 'Shift', 'Tab']);
    assert(await showing('B'), 'Ctrl+Shift+Tab goes back to B');
    await chord(['Control', 'Tab']);
    assert(await showing('C'), 'Ctrl+Tab goes forward to C');

    console.log('\n=== an unsaved edit survives switching away ===');
    await chord(['Control', 'Shift', 'Tab']);
    await showing('B');
    const pt = await app.eval(() => {
        const tw = document.createTreeWalker(document.getElementById('editor'), NodeFilter.SHOW_TEXT);
        let t; while ((t = tw.nextNode()) && t.nodeValue.indexOf('Bravo document text.') < 0) {}
        const r = document.createRange(); r.setStart(t, t.nodeValue.length); r.setEnd(t, t.nodeValue.length);
        const b = r.getBoundingClientRect(); return { x: b.left - 1, y: b.top + b.height / 2 };
    });
    await app.page.mouse.click(pt.x, pt.y);
    await app.page.keyboard.type(' Edited here.');
    await sleep(800);
    await chord(['Control', 'Tab']);
    assert(await showing('C'), 'switching away shows C');
    await chord(['Control', 'Shift', 'Tab']);
    assert(await wait(async () => (await shown()).includes('Bravo document text. Edited here.'), 8000), 'and coming back to B, the edit is still there');
    assert(fs.readFileSync(file.B, 'utf8').indexOf('Edited here.') < 0, 'without having been saved to the file');
    s = await wait(() => { const v = session(); return v && v.dirty[idx(v, 'B')] === '1' ? v : null; }, 6000);
    assert(s && s.dirty[idx(s, 'B')] === '1', 'the host marks B as having unsaved changes');

    console.log('\n=== opening a document that is already open ===');
    await app.eval((p) => postMsg('open_file_path:' + p), file.A);
    assert(await showing('A'), 'shows A');
    s = await wait(() => { const v = session(); return v && v.active === idx(v, 'A') ? v : null; }, 6000);
    assert(s && s.count === 3 && s.active === idx(s, 'A'), 'by switching to its tab, not opening a second one', s);

    console.log('\n=== close a tab with Ctrl+W ===');
    await app.eval((p) => postMsg('open_file_path:' + p), file.C);
    await showing('C');
    await chord(['Control', 'w']);
    s = await wait(() => { const v = session(); return v && v.count === 2 ? v : null; }, 6000);
    assert(s && s.count === 2 && idx(s, 'C') < 0 && idx(s, 'A') >= 0 && idx(s, 'B') >= 0, 'C is closed; A and B stay', s);
    assert(!(await shown()).includes(docs.C), 'and C is no longer on screen');
} catch (e) {
    failed++; console.error('  FAIL ' + e.message.split('\n')[0]);
} finally {
    if (app) await app.close();
    clearTimeout(killer);
}
console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) { console.log('\nTABS APP FAILED'); process.exit(1); }
console.log('\nTABS APP PASSED');
process.exit(0);
