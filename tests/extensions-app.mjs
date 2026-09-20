/**
 * Extensions, against the real TypoZen.exe.
 *
 * What this is here to catch: the speech engine reaching the network. The prototype
 * imported it from a CDN and fetched its model from Hugging Face, so "it works" was
 * indistinguishable from "it works while online". These checks fail if any request
 * leaves the machine, and they run against a profile with both extensions installed --
 * the engine must come from https://localextensions/ and nowhere else.
 *
 * Run with an install already in place:
 *   node tests/extensions-app.mjs <profile-dir-with-extensions>
 * Without one it checks the uninstalled half only: no menu, no engine, no requests.
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..');
const EXE = process.env.TYPOZEN_EXE || path.join(appDir, 'TypoZen.exe');
const PORT = 9333;

let pass = 0, fail = 0;
function check(ok, what, detail) {
    if (ok) { pass++; console.log('  PASS  ' + what); }
    else { fail++; console.log('  FAIL  ' + what + (detail ? '   ' + detail : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function running() {
    try { return execSync('tasklist /FI "IMAGENAME eq TypoZen.exe" /NH', { encoding: 'utf8' }).includes('TypoZen.exe'); }
    catch (e) { return false; }
}

async function main() {
    const installed = process.argv[2] || '';
    const profile = installed || path.join(os.tmpdir(), 'typozen-ext-' + process.pid);
    if (!installed) fs.mkdirSync(profile, { recursive: true });

    if (running()) {
        console.log('TypoZen is already open - close it first; these tests drive the app directly.');
        process.exit(2);
    }
    if (!fs.existsSync(EXE)) { console.log('No TypoZen.exe - build first.'); process.exit(2); }

    console.log('profile: ' + profile);
    const child = spawn(EXE, ['--debug'], {
        cwd: appDir, stdio: 'ignore',
        env: Object.assign({}, process.env, { TYPOZEN_PROFILE_DIR: profile })
    });

    let browser = null;
    for (let i = 0; i < 90 && !browser; i++) {
        try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + PORT, defaultViewport: null }); }
        catch (e) { await sleep(500); }
    }
    if (!browser) { console.log('Could not attach to the app.'); try { child.kill(); } catch (e) {} process.exit(2); }

    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('localapp')) || pages[0];

    // Every request the page makes, so "it never goes out" is measured, not assumed.
    const remote = [];
    page.on('request', r => {
        const u = r.url();
        if (/^https?:\/\//i.test(u) && !/^https:\/\/(localapp|localextensions|localbook|localload|localdoc)/i.test(u)) remote.push(u);
    });

    try {
        await sleep(2500);
        const ext = await page.evaluate(() => (typeof _kokoroExt === 'undefined' ? 'undefined' : JSON.stringify(_kokoroExt)));
        const hasKokoro = fs.existsSync(path.join(profile, 'extensions', 'Kokoro', 'engine.js'));
        const hasWikt = fs.existsSync(path.join(profile, 'dictionaries', 'Wiktionary', 'dictionary.tsv'));
        console.log('  installed: Kokoro=' + hasKokoro + ' Wiktionary=' + hasWikt);

        check(ext !== 'undefined', 'the page has the extension hook');
        if (hasKokoro) {
            check(ext !== 'null' && ext.includes('localextensions'),
                'the host points the page at the local engine', ext);
        } else {
            check(ext === 'null', 'with nothing installed the page has no engine', ext);
        }

        // Nothing should have loaded an engine merely because the app started.
        const readyAtBoot = await page.evaluate(() => _isKokoroReady === true);
        check(!readyAtBoot, 'no speech engine is loaded at launch');

        if (hasKokoro) {
            console.log('  loading the engine...');
            await page.evaluate(() => setupKokoro(true));
            let ready = false;
            for (let i = 0; i < 60 && !ready; i++) {
                ready = await page.evaluate(() => _isKokoroReady === true);
                if (!ready) await sleep(1000);
            }
            check(ready, 'the engine loads from the installed extension');

            if (ready) {
                // Twice: the first generation carries the GPU warm-up, and it is the
                // second that says whether reading aloud can keep up with itself.
                const runs = await page.evaluate(async () => {
                    const text = 'It is a truth universally acknowledged, that a single man in possession '
                               + 'of a good fortune, must be in want of a wife.';
                    const out = [];
                    for (let i = 0; i < 2; i++) {
                        const t = performance.now();
                        const a = await _kokoroEngine.generate(text, { voice: 'af_bella' });
                        out.push({ ms: Math.round(performance.now() - t), samples: a.audio.length, rate: a.sampling_rate });
                    }
                    return out;
                });
                check(runs[0].samples > 1000, 'it generates speech', JSON.stringify(runs[0]));
                for (let i = 0; i < runs.length; i++) {
                    const secs = runs[i].samples / runs[i].rate;
                    console.log('        ' + (i ? 'warm' : 'first') + ': ' + secs.toFixed(2) + 's of audio in '
                        + runs[i].ms + 'ms  (' + (runs[i].ms / 1000 / secs).toFixed(2) + ' x realtime)');
                }
                const warm = runs[1].ms / 1000 / (runs[1].samples / runs[1].rate);
                check(warm < 0.6, 'it generates faster than it speaks', warm.toFixed(2) + ' x realtime');
            }
        }

        if (hasWikt) {
            // A word the built-in WordNet dictionary does not carry, so an answer can only
            // have come from the installed one.
            const answer = await page.evaluate(async () => {
                return await new Promise(resolve => {
                    const seen = [];
                    const handler = (e) => {
                        const m = String(e.data || '');
                        if (m.startsWith('definition:')) { seen.push(m); resolve(m.split('\t')); }
                    };
                    window.chrome.webview.addEventListener('message', handler);
                    window.chrome.webview.postMessage('define:biopunk');
                    setTimeout(() => resolve(null), 4000);
                });
            });
            check(answer !== null, 'the host answers a lookup');
        }

        check(remote.length === 0, 'nothing left the machine', remote.slice(0, 3).join(' '));
    } catch (err) {
        check(false, 'no exception', String(err && err.message || err));
    }

    try { await page.evaluate(() => window.close && 0); } catch (e) {}
    try { browser.disconnect(); } catch (e) {}
    try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
    if (!installed) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
}

main();
