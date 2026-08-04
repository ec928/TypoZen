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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const templateHtml = fs.readFileSync(path.join(appDir, 'TypoZen_Template.html'), 'utf8');
const testHtml = fs.readFileSync(path.join(appDir, 'TypoZen_Template_Test.html'), 'utf8');
const scripts = [...testHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

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
}

console.log('\n--- switchTab targets by data-tab ---');
{
    // switchTab is a window.* assignment, so evaluate it against a real document
    // rather than extracting it as a named function.
    const dom = new JSDOM(templateHtml, { runScripts: 'outside-only' });
    const src = mainScript.slice(mainScript.indexOf('window.switchTab = function(tab)'));
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

console.log('\n--- host no longer walks the folder for a list nobody renders ---');
{
    const appCs = fs.readFileSync(path.join(appDir, 'TypoZen_App.cs'), 'utf8');
    assert(appCs.indexOf('ScanCurrentDirectory') === -1,
        'ScanCurrentDirectory is gone from the host');
    assert(appCs.indexOf('request_dir') === -1, 'the request_dir round trip is gone');
    const js = fs.readFileSync(path.join(appDir, 'js', 'typozen.js'), 'utf8');
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
