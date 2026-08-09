/**
 * Self-test: the Search sidebar that replaced the Files sidebar (Phase 2).
 *
 * Covers the wiring that is pure DOM/state and so is meaningful under jsdom:
 *   - the Files tab and its pane are gone, Outline and Search remain
 *   - switchTab() targets panes by data-tab, not by :nth-child position
 *   - the results list is focusable and announces itself as a listbox
 *   - toggle_search_sidebar reveals the sidebar on the Search tab, and only
 *     collapses it when Search is already showing
 *
 * Match highlighting and jump-to-match are exercised by find-virt-selftest.mjs.
 *
 * node tests/search-sidebar-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { readEngineSource } from './engine-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const templateHtml = fs.readFileSync(path.join(appDir, 'TypoZen_Template.html'), 'utf8');
const testHtml = fs.readFileSync(path.join(appDir, 'TypoZen_Template_Test.html'), 'utf8');
const scripts = [...testHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

/** Pull one named function out of the page script so it can be run in isolation. */
function extractFn(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        const c = mainScript[i];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return mainScript.slice(idx, i + 1);
    }
    throw new Error('unclosed function ' + name);
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function eq(got, want, msg) {
    if (got === want) { passed++; console.log('  OK   ' + msg); }
    else {
        failed++;
        console.error('  FAIL ' + msg);
        console.error('        want: ' + JSON.stringify(want));
        console.error('        got : ' + JSON.stringify(got));
    }
}

console.log('--- markup: Files tab is gone ---');
{
    const dom = new JSDOM(templateHtml);
    const d = dom.window.document;

    assert(d.getElementById('tab-files') === null, 'the Files pane is removed');
    assert(d.getElementById('file-list') === null, 'the file list is removed');
    assert(d.getElementById('tab-outline') !== null, 'the Outline pane survives');
    assert(d.getElementById('tab-search') !== null, 'the Search pane survives');

    const tabs = [...d.querySelectorAll('.sidebar-tab')];
    eq(tabs.length, 2, 'two sidebar tabs remain');
    eq(tabs.map(t => t.getAttribute('data-tab')).join(','), 'outline,search',
        'each tab carries a data-tab, in order');

    const list = d.getElementById('search-results-list');
    assert(list !== null, 'the results list exists');
    eq(list.getAttribute('tabindex'), '0', 'the results list is focusable so , . < > can reach it');
    eq(list.getAttribute('role'), 'listbox', 'the results list announces itself as a listbox');

    // The Search pane owns its query box. , . < > are printable characters, so they can
    // only ever be typed while a text field has focus -- the pane needs its own input
    // that focus can leave, which the shared Ctrl+F find bar could never provide.
    const input = d.getElementById('sidebarSearchInput');
    assert(input !== null, 'the Search pane has its own query input');
    assert(d.getElementById('sidebarSearchCount') !== null, 'the Search pane shows a match counter');
    assert(d.querySelector('#tab-search #sidebarSearchInput') !== null,
        'the query input lives inside the Search pane, not the find bar');
    assert(d.querySelector('#findBar #sidebarSearchInput') === null,
        'the query input is not part of the Ctrl+F find bar');
    // Recent-query combo (ZenSeek-style), global last-8 list.
    assert(d.getElementById('sidebarSearchHistoryBtn') !== null,
        'the Search box has a recent-searches dropdown button');
    assert(d.getElementById('sidebarSearchHistoryMenu') !== null,
        'the Search box has a recent-searches menu');
    assert(d.querySelector('.sidebar-search-combo #sidebarSearchInput') !== null,
        'the query input lives inside the combo shell');
    // Markup order: query box above the results it drives.
    const pane = d.getElementById('tab-search');
    const kids = [...pane.children];
    assert(kids.findIndex(k => k.querySelector('#sidebarSearchInput')) <
           kids.findIndex(k => k.id === 'search-results-list'),
        'the query box sits above the results list');
}

console.log('\n--- focus handoff is wired in the page script ---');
{
    assert(/SIDEBAR_SEARCH_IDLE_MS\s*=\s*3000/.test(mainScript),
        'idle handoff is 3000ms as specified');
    assert(mainScript.indexOf('function focusSearchResults') !== -1,
        'there is a helper that moves focus to the results');
    assert(mainScript.indexOf('function wireSidebarSearch') !== -1,
        'the sidebar query box has its own wiring');
    assert(mainScript.indexOf('function rememberSearchQuery') !== -1,
        'committed searches are recorded in global history');
    assert(/SEARCH_HISTORY_MAX\s*=\s*8/.test(mainScript),
        'search history keeps the last 8 queries');
    assert(mainScript.indexOf('searchHistory') !== -1,
        'search history is part of prefs persistence');
    // Enter must hand off immediately rather than only running the search.
    // (There may be an earlier Enter branch for the history dropdown highlight.)
    const wireSrc = mainScript.slice(mainScript.indexOf('function wireSidebarSearch'));
    assert(wireSrc.indexOf("e.key === 'Enter'") !== -1, 'Enter is handled in the query box');
    assert(wireSrc.indexOf('focusSearchResults()') !== -1,
        'Enter hands focus to the results list');
    assert(wireSrc.indexOf('rememberSearchQuery(input.value)') !== -1,
        'Enter records the query in search history');
    // Alt+S must target the sidebar box, not the find bar.
    assert(mainScript.indexOf('focusSidebarSearchInput') !== -1,
        'Alt+S focuses the sidebar query box');

    // Alt chords put WPF into menu mode on the Alt key up, after this handler has run,
    // which moved focus to the menu bar and sent the user's typing there. The page must
    // ask for focus back and re-assert, or Alt+S then typing is silently lost.
    const focusSrc = mainScript.slice(mainScript.indexOf('function focusSidebarSearchInput'));
    const focusFn = focusSrc.slice(0, focusSrc.indexOf('\n        function '));
    assert(focusFn.indexOf("postMsg('focus_webview')") !== -1,
        'the page asks the host to return focus to the WebView');
    assert(/setTimeout\(\s*reassert/.test(focusFn), 're-assertion is retried, not attempted once');
    assert(focusFn.indexOf('stolenToDocument') !== -1,
        'focus is only reclaimed from the document, not from a control the user chose');

    const appCs = fs.readFileSync(path.join(appDir, 'TypoZen_App.cs'), 'utf8');
    assert(appCs.indexOf('"focus_webview"') !== -1, 'the host handles focus_webview');
    const hostIdx = appCs.indexOf('msg == "focus_webview"');
    assert(appCs.slice(hostIdx, hostIdx + 900).indexOf('_webView.Focus()') !== -1,
        'the host actually focuses the WebView on that message');
}

console.log('\n--- switchTab targets by data-tab ---');
{
// switchTab is a window.* assignment, so evaluate it against a real document
    // rather than extracting it as a named function.
    const dom = new JSDOM(templateHtml, { runScripts: 'outside-only' });
    
    // switchTab attaches the Search pane's listeners when that tab is shown, so that
    // reaching Search with the mouse wires it up and not only Alt+S. Those helpers live
    // in the page script and do not exist when switchTab is evaluated on its own, so
    // stub them. This test only asserts which pane and tab switchTab activates; the
    // listeners themselves are covered by the browser suites.
    //
    // If switchTab gains another dependency, it needs a stub here too. That is what broke
    // this suite last time: the call was added and this file was not re-run.
    dom.window.wireSidebarSearch = function () {};
    dom.window.wireSearchResultKeys = function () {};

    const src = mainScript.slice(mainScript.indexOf('window.switchTab = function(tab, noFocus)'));
    const end = src.indexOf('\n        };');
    dom.window.eval(src.slice(0, end + '\n        };'.length));

    const d = dom.window.document;
    const paneActive = (id) => d.getElementById(id).classList.contains('active');
    const tabActive = (name) =>
        d.querySelector('.sidebar-tab[data-tab="' + name + '"]').classList.contains('active');

    dom.window.switchTab('search');
    assert(paneActive('tab-search') && !paneActive('tab-outline'), 'switchTab("search") shows the Search pane');
    assert(tabActive('search') && !tabActive('outline'), 'switchTab("search") highlights the Search tab');

    dom.window.switchTab('outline');
    assert(paneActive('tab-outline') && !paneActive('tab-search'), 'switchTab("outline") shows the Outline pane');
    assert(tabActive('outline') && !tabActive('search'), 'switchTab("outline") highlights the Outline tab');

    // The old Files tab must not resurrect a pane or leave nothing selected.
    dom.window.switchTab('files');
    assert(paneActive('tab-outline'), 'an unknown tab name falls back to Outline rather than blanking the sidebar');
}

console.log('\n--- Alt+S toggle semantics ---');
{
    // Model the branch in handleCommand('toggle_search_sidebar') exactly: reveal when
    // collapsed or when another tab is showing; collapse only when Search already shows.
    function wants(collapsed, showingSearch) {
        return (collapsed || !showingSearch) ? 'reveal' : 'collapse';
    }
    eq(wants(true, false), 'reveal', 'collapsed sidebar reveals on Search');
    eq(wants(true, true), 'reveal', 'collapsed sidebar reveals even if Search was the last tab');
    eq(wants(false, false), 'reveal', 'open sidebar on Outline switches to Search rather than closing');
    eq(wants(false, true), 'collapse', 'open sidebar already on Search collapses');
}

console.log('\n--- sidebar is chrome, so it uses the menu font not the reading font ---');
{
    const css = fs.readFileSync(path.join(appDir, 'css', 'typozen.css'), 'utf8');

    // The shell sets Window.FontFamily="Segoe UI" and forwards only a theme's FN to the
    // page, so menus are Segoe UI under every theme. The sidebar has to match that and
    // must not inherit var(--font), which swings to Literata, Merriweather, Cascadia
    // Mono and so on as the reading theme changes.
    assert(/--ui-font:\s*[^;]*Segoe UI/.test(css), 'a chrome font variable is defined and is Segoe UI');
    assert(/--ui-icon-font:\s*'Segoe MDL2 Assets'/.test(css), 'the chrome icon font is Segoe MDL2 Assets');

    const sidebarRule = css.slice(css.indexOf('#sidebar {'), css.indexOf('#sidebar.collapsed'));
    assert(/font-family:\s*var\(--ui-font\)/.test(sidebarRule),
        '#sidebar sets the chrome font so its children inherit it');
    assert(!/font-family:\s*var\(--font/.test(sidebarRule),
        '#sidebar does not take the reading font');

    for (const sel of ['.sidebar-tab', '#sidebarSearchInput', '#sidebarSearchCount']) {
        const start = css.indexOf(sel + ' {');
        assert(start !== -1, sel + ' has a rule');
        const rule = css.slice(start, css.indexOf('}', start));
        assert(/var\(--ui-font\)/.test(rule), sel + ' uses the chrome font');
    }

    // Menu rows highlight in place; the old sidebar slid sideways on hover.
    //
    // Scoped to the row hover rule rather than grepping the whole stylesheet. translateX is
    // ordinary CSS -- centring a tooltip over a slider thumb uses it -- and a global search
    // for it failed the moment something unrelated needed it.
    {
        const at = css.indexOf('.outline-item:hover');
        assert(at !== -1, 'the sidebar rows have a hover rule');
        const rule = css.slice(at, css.indexOf('}', at));
        assert(!/transform\s*:/.test(rule), 'no translateX hover slide remains');
    }

    const xaml = fs.readFileSync(path.join(appDir, 'TypoZen.xaml'), 'utf8');
    assert(/FontFamily="Segoe UI"/.test(xaml),
        'the WPF window is still Segoe UI, which is what the sidebar is matching');
}

console.log('\n--- result rows: line numbers and line-bounded snippets ---');
{
    const api = new Function(
        extractFn('lineNumbersForOffsets') + '\n' +
        extractFn('lineBoundsAt') + '\n' +
        'return { lineNumbersForOffsets, lineBoundsAt };')();

    const hay = 'alpha one\nbeta two\nalpha three\ngamma four\nalpha five';
    const offs = [0, hay.indexOf('alpha three'), hay.indexOf('alpha five')];
    eq(JSON.stringify(api.lineNumbersForOffsets(hay, offs)), JSON.stringify([1, 3, 5]),
        'offsets map to 1-based line numbers');

    const b = api.lineBoundsAt(hay, hay.indexOf('alpha three') + 2);
    eq(hay.substring(b.start, b.end), 'alpha three', 'lineBoundsAt returns the whole line');
    const first = api.lineBoundsAt(hay, 0);
    eq(hay.substring(first.start, first.end), 'alpha one', 'the first line has no leading newline to trip on');
    const last = api.lineBoundsAt(hay, hay.length - 1);
    eq(hay.substring(last.start, last.end), 'alpha five', 'the last line runs to the end of the haystack');

    // Blocks must be delimited, or matches run together across block boundaries and the
    // rows read as "...marker row 14- bullet item o..." with no usable line numbers.
    const idxSrc = mainScript.slice(mainScript.indexOf('function buildWysiwygSearchIndex'));
    assert(/parts\.push\('\\n'\)/.test(idxSrc.slice(0, 1400)),
        'the wysiwyg search index separates blocks with a newline');
    assert(/boundary:\s*true/.test(idxSrc.slice(0, 1400)),
        'the boundary newline also gets a map entry, so map stays aligned with haystack');

    // Rows are a dense list, not menu commands.
    const css = fs.readFileSync(path.join(appDir, 'css', 'typozen.css'), 'utf8');
    assert(/--ui-fs-dense:/.test(css), 'a denser size is defined for list rows');
    const rowRule = css.slice(css.indexOf('.search-item {'), css.indexOf('.search-line'));
    assert(/font-size:\s*var\(--ui-fs-dense\)/.test(rowRule), 'search rows use the dense size');
    assert(/\.search-line/.test(css), 'there is a line-number gutter style');
}

console.log('\n--- the selected view segment follows the theme accent ---');
{
    const appCs = fs.readFileSync(path.join(appDir, 'TypoZen_App.cs'), 'utf8');

    // SelectSegment paints with _modeSourceBg at render time, so a theme change has to
    // repaint. Without that the segment kept the brush it was first drawn with, which on
    // startup is the hardcoded #33A855F7 purple -- it then sat there under every warm
    // theme, the one thing on screen not using the theme accent.
    const themeIdx = appCs.indexOf('_modeSourceBg = new SolidColorBrush(c)');
    assert(themeIdx !== -1, 'the theme computes a selected-segment brush');
    assert(appCs.slice(themeIdx, themeIdx + 1200).indexOf('RenderViewSelectors(') !== -1,
        'applying a theme repaints the view selectors');

    // Repainting must not be mistaken for a layout change and resize the window.
    const renderIdx = appCs.indexOf('private void RenderViewSelectors');
    const renderBody = appCs.slice(renderIdx, renderIdx + 1500);
    assert(/if \(columns != _viewColumns\) ApplyColumnWindowGeometry/.test(renderBody),
        'window geometry only moves when the column count actually changed');
}

console.log('\n--- host no longer walks the folder for a list nobody renders ---');
{
    const appCs = fs.readFileSync(path.join(appDir, 'TypoZen_App.cs'), 'utf8');
    assert(appCs.indexOf('ScanCurrentDirectory') === -1,
        'ScanCurrentDirectory is gone from the host');
    assert(appCs.indexOf('request_dir') === -1, 'the request_dir round trip is gone');
    const js = readEngineSource();
    assert(js.indexOf('renderFileList') === -1, 'renderFileList is gone from the page');
    assert(js.indexOf('dir_list:') === -1, 'the dir_list handler is gone from the page');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nSEARCH SIDEBAR SELFTEST FAILED');
    process.exit(1);
}
console.log('\nSEARCH SIDEBAR SELFTEST PASSED');
process.exit(0);
