/**
 * The seam between the WPF shell and the page.
 *
 * Every other application suite reaches into the page over the DevTools protocol and never
 * touches the chrome. The chrome is where the defects have actually been: a theme menu that
 * ticked the wrong entry because its item list was never cleared, a save prompt for a file
 * nobody had edited, a tab switch that stalled for six seconds and then abandoned itself.
 * None of those were reachable by any test.
 *
 * So each check here does something to the shell through UI Automation -- a real menu, a
 * real click on a real tab -- and asserts the effect *in the page*. Either half alone proves
 * nothing: a menu that opens and changes nothing is the bug, and a page that can be driven
 * directly says nothing about whether the menu reaches it.
 *
 *   RUN_APP_E2E=1 node tests/shell-seam-app.mjs
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp } from './app-harness.mjs';
import { settledApp, sleep } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

/** One shell command, JSON back. */
function ui(cmd, arg) {
    const a = arg === undefined ? '' : ' -Arg "' + String(arg).replace(/"/g, '`"') + '"';
    try {
        const out = execSync(
            'powershell -NoProfile -ExecutionPolicy Bypass -File tests/shell-ui.ps1 -Command ' + cmd + a,
            { encoding: 'utf8', timeout: 45000, cwd: path.join(__dirname, '..') });
        return JSON.parse(out.trim());
    } catch (e) {
        return { error: 'driver failed: ' + (e.message || e) };
    }
}

// The fixture, byte for byte, before and after. An earlier version of this driver clicked
// its way onto File > Save and wrote to it; the change was one trailing space and it reached
// a commit before anyone noticed. A suite that drives real menus has to prove it did not
// touch the document it opened.
const FIXTURE = path.join(__dirname, 'large-scroll-mixed.md');
const fixtureWas = fs.readFileSync(FIXTURE);

// The same promise, for the reader's settings.
//
// This suite changes the theme on purpose and puts it back afterwards, and the theme it
// picks is persisted the moment it is applied -- to the real profile, not a sandbox. So a
// restore that does not land leaves someone's editor in a theme they never chose. It has
// happened: the driver clicks at screen coordinates, a menu that was open in another
// window took the click, the restore silently did nothing, and the run ended with
// Catppuccin Mocha written into settings.json over the reader's Gruvbox Serif.
// Asserting the restore is not enough on its own -- a failed assertion still leaves the
// damage behind -- so the file is put back as well.
const SETTINGS = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'TypoZen_Cache', 'settings.json') : null;
const settingsWas = (SETTINGS && fs.existsSync(SETTINGS)) ? fs.readFileSync(SETTINGS) : null;

const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
try {
    await sleep(4500);
    await settledApp(app, 20000);

    console.log('\n=== the menus are built ===');
    const top = ui('menus');
    info('top level: ' + JSON.stringify(top.menus || top));
    assert(Array.isArray(top.menus) && top.menus.length >= 4,
        'the menu bar exists and has its menus');

    for (const name of ['File', 'Edit', 'View', 'Themes', 'Help']) {
        const m = ui('menu', name);
        const items = m.items || [];
        const dupes = items.filter((x, i) => items.indexOf(x) !== i);
        info(name + ': ' + items.length + ' items' +
             (dupes.length ? ' | REPEATED: ' + JSON.stringify(dupes.slice(0, 3)) : ''));
        assert(items.length > 0, name + ' builds its items');
        // The theme menu once accumulated its entries because the list was never cleared,
        // so the tick landed on the wrong one. A repeated entry is that bug's fingerprint.
        assert(dupes.length === 0, name + ' builds each item once');
    }

    console.log('\n=== a theme chosen from the menu reaches the page ===');
    // The Themes menu is built from the same list state.themeIndex points into, so the
    // entry at that index is the one in use -- and restoring by name rather than by
    // position survives the list being filtered or reordered.
    const themeItems = ui('menu', 'Themes').items || [];
    const themeFromStatus = () => {
        const line = (ui('status').status || []).find(x => /^Theme:/i.test(String(x)));
        return line ? String(line).replace(/^Theme:\s*/i, '').trim() : null;
    };
    const themeWasName = themeFromStatus();
    const paint = () => app.eval(() => ({
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    }));
    const before = await paint();
    info('in use: ' + JSON.stringify(themeWasName) + ', bg ' + before.bg);
    assert(!!themeWasName, 'the status bar names the theme in use');

    // Something other than the current one, so "it changed" cannot be satisfied by a no-op.
    const other = themeItems.find(t => t && t !== themeWasName);
    const chose = ui('invoke', 'Themes>' + other);
    await sleep(1600);
    const after = await paint();
    info('chose ' + JSON.stringify(other) + ': bg ' + before.bg + ' -> ' + after.bg +
         ', accent ' + before.accent + ' -> ' + after.accent);
    assert(!chose.error, 'a theme can be chosen from the menu (' + (chose.error || 'ok') + ')');
    assert(after.bg !== before.bg || after.accent !== before.accent,
        'and the page repaints in it');

    // Put it back. A suite that leaves someone reading in a theme they did not choose has
    // done damage, however green it reports.
    if (themeWasName) {
        ui('invoke', 'Themes>' + themeWasName);
        await sleep(1600);
    }
    const restored = await paint();
    info('restored: ' + JSON.stringify(themeFromStatus()) + ', bg ' + restored.bg);
    assert(restored.bg === before.bg && restored.accent === before.accent,
        'and the theme in use when this started is the one left behind');

    console.log('\n=== the tab strip lists the open documents ===');
    // The strip is asserted, not clicked. Driving a click onto a title-bar tab through UI
    // Automation proved unreliable -- the Text elements it exposes are not consistently the
    // thing that receives the click -- and tab *switching* is already covered through the
    // shell's own messages by tab-position-app and no-false-dirty-app. What is not covered
    // anywhere else is that the strip reflects the tabs the application believes it has.
    const tabs = ui('tabs');
    const names = Array.from(new Set((tabs.tabs || []).map(t => t.name)));
    info(names.length + ' distinct titles: ' + JSON.stringify(names.slice(0, 5)));
    assert(names.length >= 2, 'the strip shows more than one document');

    const openDoc = await app.eval(() => {
        const p = (typeof state !== 'undefined' && state.filePath) ? String(state.filePath) : '';
        return p ? p.split(/[\\/]/).pop() : '';
    });
    if (openDoc) {
        info('the page has ' + JSON.stringify(openDoc) + ' open');
        assert(names.some(n => n === openDoc),
            'and the document the page holds is one of them (' + openDoc + ')');
    }

    console.log('\n=== nothing was left hanging ===');
    const wins = ui('dialogs');
    const extra = (wins.windows || []).filter(w => w.name && w.name !== '' &&
        !/TypoZen - WYSIWYG/.test(w.name));
    info((wins.count || 0) + ' top-level windows: ' +
         JSON.stringify((wins.windows || []).map(w => w.name).slice(0, 4)));
    assert(extra.length === 0,
        'no dialog is left open by any of the above (' +
        JSON.stringify(extra.map(w => w.name)) + ')');

    // And the page is still answering, which a modal on the UI thread would prevent.
    const alive = await app.eval(() => ({ ok: typeof handleCommand === 'function' }));
    assert(alive.ok, 'and the page is still responsive');
} finally {
    await app.close();
}

const fixtureNow = fs.readFileSync(FIXTURE);
assert(Buffer.compare(fixtureWas, fixtureNow) === 0,
    'the document this opened is untouched on disk (' +
    fixtureWas.length + ' -> ' + fixtureNow.length + ' bytes)');

// The app has exited by now, so writing the file back cannot be raced by a save on close.
if (settingsWas) {
    // The theme fields only. lastFilePath and lastContent change every time anything is
    // opened, which is the suite working correctly -- comparing the whole file would cry
    // wolf on every run, and a check that always fails is a check nobody reads.
    const themeOf = (buf) => {
        const s = String(buf);
        return ((s.match(/"themeName"\s*:\s*"([^"]*)"/) || [])[1] || '?') + ' #' +
               ((s.match(/"themeIndex"\s*:\s*(\d+)/) || [])[1] || '?');
    };
    const settingsNow = fs.readFileSync(SETTINGS);
    const was = themeOf(settingsWas), now = themeOf(settingsNow);
    if (was !== now) {
        // Put the theme back without disturbing anything else the app legitimately wrote.
        const fixed = String(settingsNow)
            .replace(/"themeName"\s*:\s*"[^"]*"/, '"themeName":"' + was.split(' #')[0] + '"')
            .replace(/"themeIndex"\s*:\s*\d+/, '"themeIndex":' + was.split(' #')[1]);
        fs.writeFileSync(SETTINGS, fixed);
        console.error('  ..   the saved theme was changed and has been put back (' +
            was + ' <- ' + now + ')');
    }
    assert(was === now,
        'the reader\'s saved theme is as this found it (' + was + ')');
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'SHELL SEAM FAILED' : 'SHELL SEAM PASSED');
process.exit(failed ? 1 : 0);
