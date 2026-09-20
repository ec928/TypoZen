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
 * Needs Developer Mode. Register, launch with a book, then run this:
 *
 *   .	ools\Build-Msix.ps1 -Register
 *   $f = (Get-AppxPackage *TypoZen*).PackageFamilyName
 *   <activate "$f!TypoZen" with --debug "<path to an .epub>">
 *   node tests/packaged-smoke-app.mjs
 *
 * Remove it again with: Get-AppxPackage *TypoZen* | Remove-AppxPackage
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
check(midText.length > 200 && midText !== text, 'it moves through the book -- different text at block ' + target,
      midText.length + ' chars');

const ext = await page.evaluate(() => (typeof _kokoroExt === 'undefined' ? 'undefined' : JSON.stringify(_kokoroExt)));
check(ext !== 'undefined', 'the extension hook is present in the packaged build', ext);
check(ext === 'null', 'the package starts with its own empty extensions folder', ext);
const ready = await page.evaluate(() => _isKokoroReady === true);
check(!ready, 'no speech engine loaded at launch');

check(remote.length === 0, 'nothing left the machine', remote.slice(0, 3).join(' '));

browser.disconnect();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
