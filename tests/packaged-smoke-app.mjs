/**
 * The packaged build -- the one the Store ships -- driven directly.
 *
 * "A registered MSIX cannot be driven by any suite" was true of launchApp, which spawns
 * an .exe by path. A packaged app is launched by AUMID instead, and once it is up its
 * debug port answers like any other build. So this is checkable after all, and it is the
 * check whose absence let 0.2.41 reach the Store unable to open a book.
 *
 * It also covers what only the packaged build can get wrong: Windows redirects its writes
 * into %LocalAppData%\Packages\<family>\LocalCache\Local, so the profile -- and the
 * extensions folder inside it -- is a different place from the loose build's.
 *
 * Needs Developer Mode. Register the built package, launch it with a book, then run this:
 *
 *   .\tools\Test-Packaged.ps1          (unpacks dist-msix\TypoZen.msix, registers, launches)
 *   node tests/packaged-smoke-app.mjs
 *   .\tools\Test-Packaged.ps1 -Remove  (after closing the app)
 *
 * Build-Msix.ps1 -Register also works, but it registers a fresh stage of bin\, which can
 * carry later work than the package being submitted.
 *
 * Run it against a freshly registered package. The package keeps its own profile across
 * launches and re-registration, so a second run reopens the book where the first one left
 * it -- at the block this seeks to -- and "it moves through the book" fails on a correct
 * build. Removing the package deletes that profile.
 */
import puppeteer from 'puppeteer-core';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, what, detail) => {
    if (ok) { pass++; console.log('  PASS  ' + what); }
    else { fail++; console.log('  FAIL  ' + what + (detail ? '   ' + detail : '')); }
};

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localapp')) || pages[0];

const remote = [];
page.on('request', r => {
    const u = r.url();
    if (/^https?:\/\//i.test(u) && !/^https:\/\/(localapp|localextensions|localbook|localload|localdoc)/i.test(u)) remote.push(u);
});

await sleep(1500);

const text = await page.evaluate(() => {
    const el = document.getElementById('editor') || document.body;
    return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
});
check(text.length > 500, 'the book is painted with real text', text.length + ' chars');
console.log('        "' + text.slice(0, 90) + '..."');

const model = await page.evaluate(() => (typeof DocumentModel !== 'undefined' && DocumentModel.blocks) ? DocumentModel.blocks.length : -1);
check(model > 0, 'the book parsed into a document model', model + ' blocks');

// The text actually on screen. Comparing the head of #editor's text cannot see a seek in
// a book whose whole text is one mounted chunk (Alice: 800 blocks, one chunk) -- the view
// moved and the head stayed the same, so the check failed on a correct build.
const onScreen = () => page.evaluate(() => {
    const ed = document.getElementById('editor'), mc = document.getElementById('main-container');
    if (!ed || !mc) return '';
    const r = mc.getBoundingClientRect();
    return [...ed.querySelectorAll('.block')].filter(b => {
        const q = b.getBoundingClientRect();
        return q.bottom > r.top && q.top < r.bottom && q.right > r.left && q.left < r.right;
    }).map(b => b.innerText).join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
});
const viewBefore = await onScreen();

// Same move the core smoke makes: seek to the middle and prove different text arrives.
const target = await page.evaluate(() => {
    const i = Math.floor(DocumentModel.blocks.length * 0.5);
    setTimeout(() => { try { goToModelBlock(i); } catch (e) {} }, 0);
    return i;
});
await sleep(4000);
const midText = await page.evaluate(() => {
    const el = document.getElementById('editor') || document.body;
    return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
});
const viewAfter = await onScreen();
check(midText.length > 200 && viewAfter.length > 50 && viewAfter !== viewBefore,
      'it moves through the book -- different text on screen at block ' + target,
      viewBefore.length + ' -> ' + viewAfter.length + ' chars on screen');

const ext = await page.evaluate(() => (typeof _kokoroExt === 'undefined' ? 'undefined' : JSON.stringify(_kokoroExt)));
check(ext !== 'undefined', 'the extension hook is present in the packaged build', ext);
check(ext === 'null', 'the package starts with its own empty extensions folder', ext);
const ready = await page.evaluate(() => _isKokoroReady === true);
check(!ready, 'no speech engine loaded at launch');

// Source's editor is a separate bundle (js/vendor/codemirror) with no fallback: a package
// that left it out would open books fine and fail the moment anyone switched to Source.
const cm = await page.evaluate(() => ({
    bundle: typeof window.TzCM === 'object' && !!window.TzCM.EditorView,
    mounted: !!document.querySelector('#source-cm .cm-editor')
}));
check(cm.bundle && cm.mounted, 'Source\'s editor (CodeMirror) is in the package and mounted', JSON.stringify(cm));

check(remote.length === 0, 'nothing left the machine', remote.slice(0, 3).join(' '));

browser.disconnect();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
