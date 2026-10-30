/**
 * File > Open Recent's favourites, in the real app: the native WPF menu, opened and pressed by
 * tests/favourites-ui.ps1. A WPF menu cannot open on a hidden desktop (it needs mouse capture), so
 * this shows a window and takes focus for about 40 seconds: run it only when no one is using the
 * machine, like the other UI Automation suites. The real mouse is not moved: clicks are posted
 * to the window.
 *
 *   RUN_APP_E2E=1 node tests/favourites-app.mjs
 *   FAV_SHOTS=folder   also saves pictures of the menu there
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { launchApp, profileFile } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

if (process.env.RUN_APP_E2E !== '1') { console.log('SKIP (set RUN_APP_E2E=1)'); process.exit(0); }
const here = path.dirname(fileURLToPath(import.meta.url));
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const deadline = setTimeout(() => { console.error('  FAIL over budget (240 s)'); process.exit(1); }, 240000);

let passed = 0, failed = 0;
const check = (ok, msg, got) => {
    if (ok) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg + (got !== undefined ? '\n         got ' + JSON.stringify(got) : '')); }
};

const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
let app, step = 0;
async function ui(command, arg) {
    if (/^open/.test(command)) { try { await app.page.bringToFront(); } catch (e) {} await sleep(300); }
    const out = profileFile('ui-' + (step++) + '.json');
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'favourites-ui.ps1'),
        '-AppPid', String(app.pid), '-Command', command, '-Arg', arg || 'none', '-Out', out], { windowsHide: true }, (err, so, se) => { if (se && String(se).trim()) console.error('  driver stderr: ' + String(se).slice(0, 400)); });
    for (let i = 0; i < 600 && !fs.existsSync(out); i++) await sleep(50);
    if (!fs.existsSync(out)) throw new Error('the UI driver wrote nothing for ' + command);
    const r = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, ''));
    if (!r.ok) throw new Error(command + ' ' + (arg || '') + ': ' + r.error);
    if (r.menu) {
        // Automation lists each row twice (the popup, and the same items under File): the popup's.
        const rows = list(r.menu.rows);
        const end = rows.findIndex(x => /Keep recent/.test(x));
        r.menu.rows = end >= 0 ? rows.slice(0, end + 1) : rows;
        const seen = new Set();
        r.menu.stars = list(r.menu.stars).filter(x => !seen.has(x.name) && seen.add(x.name));
    }
    if (r.notIdle) throw new Error('someone is at the machine: the mouse was not moved. Run it again later.');
    return r.menu;
}
const starsOf = (m) => list(m.stars);
const favFile = () => { try { return JSON.parse(fs.readFileSync(profileFile('favourite_files.json'), 'utf8')); } catch (e) { return []; } };
const recFile = () => { try { return JSON.parse(fs.readFileSync(profileFile('recent_files.json'), 'utf8')); } catch (e) { return []; } };
const shot = async (name) => { if (process.env.FAV_SHOTS) await ui('shot', path.join(process.env.FAV_SHOTS, name + '.png')); };

// Five files, one with underscores, one missing.
const doc = (n) => profileFile(n);
for (const n of ['alpha.md', 'beta.md', 'gamma.md', 'with_under_score.md']) fs.writeFileSync(doc(n), '# ' + n + '\n\ntext\n');
const GONE = doc('deleted-later.md');
fs.writeFileSync(GONE, 'x');
const seed = [doc('alpha.md'), doc('beta.md'), doc('gamma.md'), doc('with_under_score.md'), GONE];
fs.writeFileSync(profileFile('recent_files.json'), JSON.stringify(seed));
fs.rmSync(profileFile('favourite_files.json'), { force: true });
fs.unlinkSync(GONE);

try {
    console.log('=== a menu with no favourites looks as it did ===');
    app = await launchApp({ file: doc('alpha.md'), visible: true });
    await settledApp(app);
    let m = await ui('open');
    await sleep(300);
    m = await ui('rows');
    await shot('1-no-favourites');
    check(!m.rows.some(r => /^Favourites/.test(r)), 'no Favourites heading until there is a favourite', m.rows);
    check(m.rows.some(r => /Clear recent list/.test(r)) && m.rows.some(r => /Keep recent/.test(r)), 'Clear and Keep are there', m.rows);
    check(m.rows.some(r => r.includes('with_under_score.md')), 'an underscore in a name is shown as written', m.rows);
    check(starsOf(m).length === 5, 'every recent row has a star', starsOf(m));

    console.log('\n=== star one, by pressing the button ===');
    m = await ui('invoke-star', 'Add to favourites:*beta.md');
    await shot('2-one-favourite');
    check(favFile().some(p => p.endsWith('beta.md')), 'it is saved', favFile());
    check(m.rows.some(r => /^Favourites/.test(r)) && m.rows.some(r => /^Recent$/.test(r)), 'Favourites and Recent headings appear', m.rows);
    check(m.rows.findIndex(r => /^Favourites/.test(r)) < m.rows.findIndex(r => r.includes('beta.md')) && m.rows.findIndex(r => r.includes('beta.md')) < m.rows.findIndex(r => /^Recent$/.test(r)), 'it moved to the top', m.rows);
    check(m.rows.filter(r => r.includes('beta.md')).length === 1, 'it is not listed twice', m.rows);
    check(m.rows.some(r => /Keep recent/.test(r)), 'the menu stayed open', m.rows);
    check(starsOf(m).some(s => s.name.startsWith('Remove') && s.name.endsWith('beta.md')), 'its star now removes it', starsOf(m));

    // WPF reads the real mouse state, so a posted click does not press a button. This moves the
    // real pointer and puts it back: FAV_REAL_MOUSE=1 only, when no one is using the machine.
    if (process.env.FAV_REAL_MOUSE === '1') {
        console.log('\n=== with the real mouse ===');
        const before = await app.eval(() => getMarkdownContent(false));
        await sleep(21000);     // its own clicks count as input to the idle check
        m = await ui('real-click-star', 'Add to favourites:*gamma');
        check(favFile().some(p => p.endsWith('gamma.md')), 'a real click on the star adds it', favFile());
        check(m.rows.some(r => /Keep recent/.test(r)), 'the menu stayed open after the click', m.rows);
        check((await app.eval(() => getMarkdownContent(false))) === before, 'and the click did not open the file');
    } else {
        await ui('invoke-star', 'Add to favourites:*gamma');
    }

    console.log('\n=== unstar puts it back ===');
    m = await ui('invoke-star', 'Remove from favourites:*gamma');
    check(!favFile().some(p => p.endsWith('gamma.md')), 'it is gone from favourites', favFile());
    check(m.rows.findIndex(r => r.includes('gamma.md')) > m.rows.findIndex(r => /^Recent$/.test(r)), 'and back in Recent', m.rows);

    console.log('\n=== the outline star shows on the highlighted row, and F does the same as the star ===');
    m = await ui('focus-row', 'alpha.md');
    await shot('2b-highlighted');
    m = await ui('key', 'F');
    await sleep(300);
    check(favFile().some(p => p.endsWith('alpha.md')), 'F on the highlighted row stars it', favFile());
    check(m.rows.some(r => /Keep recent/.test(r)), 'the menu stayed open', m.rows);
    m = await ui('focus-row', 'alpha.md');
    m = await ui('key', 'F');
    await sleep(300);
    check(!favFile().some(p => p.endsWith('alpha.md')), 'and F again removes it', favFile());

    console.log('\n=== choosing a favourite opens it ===');
    m = await ui('focus-row', 'beta.md');
    await shot('2c-favourite-highlighted');
    m = await ui('key', 'ENTER');
    await sleep(800);
    check(/beta\.md/.test(await app.eval(() => getMarkdownContent(false))), 'Enter on it opens its text', await app.eval(() => getMarkdownContent(false)));
    m = await ui('open');
    check(m.rows.filter(r => r.includes('beta.md')).length === 1, 'opening it did not add it to Recent as well', m.rows);

    console.log('\n=== Clear recent list keeps favourites ===');
    if (!favFile().some(p => p.endsWith('alpha.md'))) await ui('invoke-star', 'Add to favourites:*alpha.md');
    m = await ui('invoke-menu-row', 'Clear recent list');
    check(favFile().some(p => p.endsWith('beta.md')) && favFile().some(p => p.endsWith('alpha.md')), 'favourites survive', favFile());
    check(!recFile().some(p => p.endsWith('gamma.md')), 'the recent files are gone', recFile());
    await app.close(); app = null;

    console.log('\n=== after a restart ===');
    app = await launchApp({ file: doc('gamma.md'), visible: true });
    await settledApp(app);
    m = await ui('open');
    await shot('3-after-restart');
    check(m.rows.some(r => /^Favourites/.test(r)) && m.rows.some(r => r.includes('beta.md')), 'favourites came back', m.rows);
    check(m.rows.some(r => r.includes('gamma.md')), 'and the file just opened is in Recent', m.rows);

    console.log('\n=== the limit ===');
    const many = Array.from({ length: 10 }, (_, i) => doc('fav' + i + '.md'));
    many.forEach(p => fs.writeFileSync(p, 'x'));
    await app.close(); app = null;
    fs.writeFileSync(profileFile('favourite_files.json'), JSON.stringify(many));
    fs.writeFileSync(profileFile('recent_files.json'), JSON.stringify(many.concat([doc('alpha.md')])));
    app = await launchApp({ file: doc('alpha.md'), visible: true });
    await settledApp(app);
    m = await ui('open');
    await shot('4-full');
    check(m.rows.some(r => /Favourites \(10 of 10\)/.test(r)), 'the heading says it is full', m.rows);
    const add = starsOf(m).find(s => s.name.startsWith('Add'));
    check(add && add.enabled === false, 'the star on a recent file is disabled', starsOf(m));
    check(favFile().length === 10, 'still ten', favFile());

    console.log('\n=== a missing favourite stays and can be removed ===');
    fs.unlinkSync(many[0]);
    m = await ui('invoke-star', 'Remove from favourites:*fav0');
    check(!favFile().includes(many[0]), 'its star removes it', favFile());

    console.log('\n=== Privacy Mode adds no favourite, and can remove one ===');
    await app.close(); app = null;
    await sleep(500);
    const STATE = profileFile('window_state.json');
    const setPrivacy = (on) => {
        let j = '{}';
        try { j = fs.readFileSync(STATE, 'utf8'); } catch (e) {}
        const re = /"privacyMode"\s*:\s*(true|false)/;
        j = re.test(j) ? j.replace(re, '"privacyMode":' + on) : j.replace(/^\{/, '{"privacyMode":' + on + ',');
        fs.writeFileSync(STATE, j);
    };
    fs.writeFileSync(profileFile('favourite_files.json'), JSON.stringify([doc('beta.md')]));
    fs.writeFileSync(profileFile('recent_files.json'), JSON.stringify([doc('beta.md'), doc('gamma.md')]));
    setPrivacy(true);
    app = await launchApp({ file: doc('beta.md'), visible: true });
    await settledApp(app);
    m = await ui('open');
    await shot('5-privacy');
    const addP = starsOf(m).find(x => x.name.startsWith('Add'));
    check(addP && addP.enabled === false, 'in Privacy Mode the star on a recent file is disabled', starsOf(m));
    const removeP = starsOf(m).find(x => x.name.startsWith('Remove'));
    check(removeP && removeP.enabled === true, 'and a favourite can still be removed', starsOf(m));
    await app.close(); app = null;
    await sleep(500);

    console.log('\n=== Clear Stored Data removes favourites ===');
    setPrivacy(false);
    fs.writeFileSync(profileFile('favourite_files.json'), JSON.stringify([doc('beta.md')]));
    app = await launchApp({ file: doc('beta.md'), visible: true });
    await settledApp(app);
    await ui('open-privacy');
    await ui('invoke-row', 'Clear Stored Data');
    await ui('dialog-click', 'Clear');
    await sleep(800);
    check(!fs.existsSync(profileFile('favourite_files.json')), 'the favourites file is gone');
} catch (e) {
    failed++;
    console.error('  FAIL ' + e.message);
} finally {
    if (app) await app.close();
    clearTimeout(deadline);
}
console.log(`\npassed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
