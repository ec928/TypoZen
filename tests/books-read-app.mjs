/**
 * Every ePub in tests/, in the real app: open it, jump through it in each layout, turn pages.
 * It stays alive, real text is in view, nothing threw, and the file is not touched. Reading a
 * book without crashing is a must-have, and until 2026-10-30 only the smallest was checked in
 * every layout. Hidden desktop; about 30 s a book, the 5 MB omnibus longer.
 *
 *   RUN_APP_E2E=1 node tests/books-read-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, evalPatiently } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('SKIP (set RUN_APP_E2E=1)'); process.exit(0); }
const here = path.dirname(fileURLToPath(import.meta.url));
const started = Date.now();
const deadline = setTimeout(() => { console.error('  FAIL over budget (8 min)'); process.exit(1); }, 480000);
const books = fs.readdirSync(here).filter(f => f.toLowerCase().endsWith('.epub') && (!process.env.BOOK || f.includes(process.env.BOOK))).sort((a, b) => fs.statSync(path.join(here, a)).size - fs.statSync(path.join(here, b)).size);
const LAYOUTS = {
    'one column, scrolling': ['view_set:columns:1', 'view_set:scroll:scroll'],
    'two columns, scrolling': ['view_set:columns:2', 'view_set:scroll:scroll'],
    'two pages': ['view_set:columns:2', 'view_set:scroll:pagination'],
};
let passed = 0, failed = 0;
const check = (ok, msg, got) => {
    if (ok) { passed++; return; }
    failed++;
    console.error('  FAIL ' + msg + (got !== undefined ? '   got ' + JSON.stringify(got).slice(0, 200) : ''));
};
const inView = (app) => evalPatiently(app, () => {
    const ed = document.querySelector('#editor');
    if (!ed) return '';
    const v = ed.getBoundingClientRect();
    const out = [];
    for (const b of ed.querySelectorAll('.block')) {
        if (Array.from(b.getClientRects()).some(r => r.width > 0 && r.height > 0 && r.right > v.left && r.left < v.right && r.bottom > v.top && r.top < v.bottom)) out.push(b.innerText || '');
    }
    return out.join('\n').trim();
});
for (const book of books) {
    const file = path.join(here, book);
    const before = fs.statSync(file);
    const t0 = Date.now();
    let app, errors = [];
    try {
        app = await launchApp({ file });
        app.page.on('pageerror', e => errors.push(e.message));
        // A big book parses for a while before there is anything to measure.
        let blocks = -1;
        const opened = Date.now();
        for (; Date.now() - opened < 60000; await sleep(200)) {
            blocks = await evalPatiently(app, () => (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub' && DocumentModel.blocks) ? DocumentModel.blocks.length : -1);
            if (blocks > 0) break;
        }
        console.log('  ..   ' + book.slice(0, 44) + ': ' + blocks + ' blocks after ' + ((Date.now() - opened) / 1000).toFixed(1) + ' s');
        await settledApp(app, 15000);
        check(blocks > 0, book + ': it parsed into blocks', blocks);
        const samples = [];
        for (const [name, cmds] of Object.entries(LAYOUTS)) {
            await app.eval((cmds) => cmds.forEach(c => handleCommand(c)), cmds);
            await settledApp(app, 8000);
            for (const f of [0.05, 0.25, 0.5, 0.75, 0.999]) {
                const at = Math.floor(blocks * f);
                await app.eval((i) => goToModelBlock(i), at);
                await settledApp(app, 6000);
                const t = await inView(app);
                samples.push(t.length);
                if (t.length < 20) console.log(`  ..   ${book.slice(0, 24)} / ${name}: ${Math.round(f * 100)}% shows ${t.length} characters`);
            }
            // Page turns, the real key.
            const a = await inView(app);
            await app.page.keyboard.press('PageUp');
            await settledApp(app, 3000);
            await app.page.keyboard.press('PageUp');
            await settledApp(app, 3000);
            const b = await inView(app);
            check(b.length > 0, `${book}: ${name}: text in view after turning pages`);
            check(a !== b, `${book}: ${name}: PageUp moved the view`);
        }
        const blank = samples.filter(n => n < 20).length;
        check(blank <= 3, book + ': real text in view at nearly every position', samples);
        check(await evalPatiently(app, () => 1) === 1, book + ': the app is still answering');
        check((await evalPatiently(app, () => getMarkdownContent(false) !== state.lastSavedContent)) !== true, book + ': reading it did not mark it edited');
        check(errors.length === 0, book + ': nothing threw', errors.slice(0, 3));
    } catch (e) {
        check(false, book + ': ' + e.message);
    } finally {
        if (app) await app.close();
    }
    const after = fs.statSync(file);
    check(after.size === before.size && after.mtimeMs === before.mtimeMs, book + ': the file was not touched');
    console.log(`  ..   ${book.slice(0, 44)}: ${Math.round((Date.now() - t0) / 1000)} s`);
    await sleep(800);
}
clearTimeout(deadline);
console.log(`\nbooks=${books.length} passed=${passed} failed=${failed} seconds=${Math.round((Date.now() - started) / 1000)}`);
process.exit(failed ? 1 : 0);
