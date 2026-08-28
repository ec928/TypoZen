/**
 * Drive the real TypoZen.exe, not a copy of its page in a browser.
 *
 * Why this exists
 * ---------------
 * Column switching was "fixed" five or six times. Every one of those fixes was verified
 * by loading TypoZen_Template.html into headless Chrome, where the fault does not
 * happen -- so the suite went green and the application stayed broken. That process
 * cannot converge: it tests a different program from the one being shipped.
 *
 * The differences that matter are all outside the page:
 *   - the WPF shell owns the window, so the real viewport is not the browser viewport
 *   - the host sets zoom, restores window geometry, and pushes commands over IPC
 *   - focus moves between WPF chrome and the WebView, which moves the caret
 *   - the window is whatever size the user left it, and page counts follow from that
 *
 * TypoZen.exe --debug opens the DevTools protocol on a fixed port; this attaches to it
 * with puppeteer. Everything a test does here runs against the shipped binary.
 *
 * Usage:
 *   import { launchApp } from './app-harness.mjs';
 *   const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
 *   await app.eval(() => handleCommand('view_set:columns:2'));
 *   await app.close();
 *
 * options.env is merged into the child environment (TYPOZEN_PROFILE_DIR still wins).
 * Used by disk-conflict-app.mjs for TYPOZEN_DISK_PROMPT=Yes|No|Cancel.
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { settled } from './settle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.join(__dirname, '..');
const PORT = 9333;                 // must match Program.RemoteDebugPort
const EXE = path.join(appDir, 'TypoZen.exe');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * A throwaway profile for THIS suite, via TYPOZEN_PROFILE_DIR.
 *
 * Every suite used to read and write the reader's own %LOCALAPPDATA%\TypoZen_Cache, which
 * is wrong twice over. It made suites depend on each other -- bookmark-store asserts the
 * store holds exactly one line, so it passed or failed on whether bookmark-pane or
 * book-position had run first, and both directions were observed on the same commit. And
 * it meant running the tests left fixture bookmarks and fixture reading positions in the
 * reader's real profile, which is not something a test run is allowed to do.
 *
 * One directory per node process, so a suite that relaunches the app (session restore,
 * "it comes back on the next launch") still sees its own previous session -- that is the
 * thing those suites measure -- while the next suite starts from nothing.
 *
 * Not TYPOZEN_TAB_E2E: that also disables session restore and the single-instance server,
 * which several of these suites are specifically about.
 */
export const profileDir = path.join(os.tmpdir(), 'typozen-e2e-' + process.pid);

/** A file inside this suite's throwaway profile (bookmarks.txt, book_positions.txt, …). */
export function profileFile(name) {
    return path.join(profileDir, name);
}

let _profileReady = false;
function ensureProfile() {
    if (_profileReady) return;
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { }
    fs.mkdirSync(profileDir, { recursive: true });
    _profileReady = true;
    const sweep = () => { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { } };
    process.on('exit', sweep);
}

// At import, not at first launch: several suites seed the profile before starting the app
// (privacy-app writes window_state.json to prove the flags are honoured), and they cannot
// write into a directory that does not exist yet.
ensureProfile();

/**
 * Is a TypoZen already running that we did not start?
 *
 * This matters because TypoZen is single-instance: a second launch hands its file to the
 * first process and exits, so the harness cannot attach to anything. The original
 * response was to taskkill TypoZen.exe before every launch -- which force-killed a real
 * session, mid-edit, with no warning, whenever a test ran. That is not the harness's
 * call to make.
 */
function isAppRunning() {
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq TypoZen.exe" /NH', { encoding: 'utf8' });
        return /TypoZen\.exe/i.test(out);
    } catch (e) { return false; }
}

/** Kill only what this harness started. */
function killOwn(child) {
    if (child && child.pid) {
        try { execSync('taskkill /PID ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { }
    }
}

async function waitForDevTools(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
        try {
            const res = await fetch('http://127.0.0.1:' + PORT + '/json/version');
            if (res.ok) return await res.json();
        } catch (e) { lastErr = e; }
        await sleep(250);
    }
    throw new Error('TypoZen did not open the DevTools port ' + PORT + ' within ' +
        timeoutMs + 'ms. Was it built with the --debug remote-debugging change? ' +
        (lastErr ? lastErr.message : ''));
}

function isProtocolTimeout(e) {
    const m = (e && e.message) || '';
    return /timed out|ProtocolError/i.test(m) || (e && e.name === 'ProtocolError');
}

/**
 * Ask the page something. Retry if the call itself threw.
 *
 * One evaluate is one CDP call with one protocolTimeout. A suite that parks inside
 * the page -- seek, await sleep, measure, all in one call -- deadlocks against itself:
 * the page cannot finish the work the call started until the call returns, and the call
 * cannot return until the work finishes. Do not raise protocolTimeout (tried at 600s;
 * it does not work).
 *
 * Never abandon an in-flight evaluate and send another. Puppeteer cannot cancel
 * Runtime.callFunctionOn; the abandoned call keeps running and the retry queues
 * behind it. That is the Xeelee density stall: stacked remounts, then ProtocolError
 * at 180s. If this attempt is still running when `perTry` elapses, wait it out.
 * A ProtocolError is the session, not a busy page -- rethrow it.
 */
export async function evalPatiently(app, fn, arg, opts) {
    const perTry = (opts && opts.perTry) || 3000;
    const timeout = (opts && opts.timeout) || 25000;
    const every = (opts && opts.every) || 250;
    const deadline = Date.now() + timeout;
    let tries = 0, lastErr = null;
    while (Date.now() < deadline) {
        tries++;
        const attempt = (arg === undefined ? app.eval(fn) : app.eval(fn, arg));
        const raced = await Promise.race([
            attempt.then(v => ({ ok: true, v }), e => ({ ok: false, err: e })),
            new Promise(r => setTimeout(() => r({ tick: true }), perTry))
        ]);
        if (raced.tick) {
            try { return await attempt; }
            catch (e) {
                if (isProtocolTimeout(e)) throw e;
                lastErr = e;
                await sleep(every);
                continue;
            }
        }
        if (raced.ok) return raced.v;
        if (isProtocolTimeout(raced.err)) throw raced.err;
        lastErr = raced.err;
        await sleep(every);
    }
    throw new Error('page never answered after ' + tries + ' attempts over '
        + Math.round(timeout / 1000) + 's'
        + (lastErr ? ' (last error: ' + lastErr.message + ')' : ' (main thread busy)'));
}

/**
 * Launch TypoZen.exe --debug and attach.
 * @param {{file?:string, width?:number, height?:number, settleMs?:number,
 *          view?:true|{mode?:string,scroll?:string,columns?:number},
 *          env?:Record<string,string>, args?:string[]}} options
 */
export async function launchApp(options) {
    options = options || {};
    if (!fs.existsSync(EXE)) throw new Error('TypoZen.exe not found - run Build_TypoZen.ps1 first');

    // Never kill a session we did not start. Single-instance means we genuinely cannot
    // attach while one is open, so say so and stop rather than take the window away.
    if (isAppRunning()) {
        if (process.env.TYPOZEN_E2E_KILL === '1') {
            try { execSync('taskkill /IM TypoZen.exe /F', { stdio: 'ignore' }); } catch (e) { }
            await sleep(600);
        } else {
            throw new Error(
                'TypoZen.exe is already running.\n' +
                '  These tests drive the application directly and TypoZen is single-instance,\n' +
                '  so they cannot attach while a window is open. Close it and run again.\n' +
                '  If that instance is disposable, set TYPOZEN_E2E_KILL=1 to end it first.');
        }
    }

    const args = ['--debug'];
    if (options.file) {
        args.push(path.isAbsolute(options.file) ? options.file : path.join(appDir, options.file));
    }
    // Extra command-line arguments, for the shapes ZenSeek launches with (--search, --line).
    if (options.args) for (const a of options.args) args.push(a);

    ensureProfile();
    const child = spawn(EXE, args, {
        cwd: appDir,
        detached: false,
        stdio: 'ignore',
        env: Object.assign({}, process.env, options.env || {}, { TYPOZEN_PROFILE_DIR: profileDir })
    });
    await waitForDevTools(45000);

    const browser = await puppeteer.connect({
        browserURL: 'http://127.0.0.1:' + PORT,
        defaultViewport: null,          // the WPF window decides the viewport, not us
        // Left at puppeteer's 180s default on purpose. It was raised to 600s to get
        // epub-open-app past a ProtocolError, on the assumption that the omnibus was
        // merely slow. It is not merely slow: goToModelBlock() into the middle of the
        // 45,390-block Xeelee omnibus does not finish, and all a longer timeout bought
        // was a ten-minute wait for the same failure. A timeout that fires is a timeout
        // doing its job -- see docs/known-issues.md.
        protocolTimeout: 180000
    });

    // The app's document is the only page; DevTools may also list workers.
    let page = null;
    const deadline = Date.now() + 20000;
    while (!page && Date.now() < deadline) {
        for (const t of await browser.pages()) {
            try {
                const ok = await t.evaluate(() => typeof handleCommand === 'function');
                if (ok) { page = t; break; }
            } catch (e) { }
        }
        if (!page) await sleep(300);
    }
    if (!page) throw new Error('Attached, but no page exposing handleCommand was found');

    // settleMs is a timeout cap, not a mandatory sleep. A 6s launch wait that was
    // guessed for a slow machine is how every app suite idled 6s on a fast one.
    const settleCap = options.settleMs == null ? 8000 : options.settleMs;
    if (settleCap > 0) await settled(page, settleCap);

    // Pin the view, for suites that assume one.
    //
    // TypoZen restores whatever layout the last session was left in, so a suite that
    // assumes scrolling 1-column passes or fails depending on what ran before it. That is
    // not hypothetical: book-to-markdown and annotations both went from green to red
    // between two runs on the same commit, because probe runs in between had left the app
    // in 2-column Pages. A suite reading its predecessor's leftovers is a suite reporting
    // on the wrong program.
    //
    // Opt in, not automatic: several suites test Pages deliberately and set the layout
    // themselves, and book-position-app is ABOUT what survives a restart, so normalising
    // for everyone would break the thing it measures.
    if (options.view) {
        const v = options.view === true
            ? { mode: 'preview', scroll: 'scroll', columns: 1 }
            : options.view;
        if (v.mode) {
            await page.evaluate((m) => handleCommand('view_set:mode:' + m), v.mode);
            await settled(page, settleCap > 0 ? settleCap : 8000);
        }
        if (v.scroll) {
            await page.evaluate((x) => handleCommand('view_set:scroll:' + x), v.scroll);
            await settled(page, settleCap > 0 ? settleCap : 8000);
        }
        if (v.columns) {
            await page.evaluate((c) => handleCommand('view_set:columns:' + c), v.columns);
            await settled(page, settleCap > 0 ? settleCap : 8000);
        }
    }

    return {
        page: page,
        browser: browser,
        /** Run a function inside the real app. */
        eval: (fn, ...a) => page.evaluate(fn, ...a),
        press: async (key) => { await page.bringToFront().catch(() => { }); await page.keyboard.press(key); },
        /** Size of the actual document viewport, which is not the window size. */
        viewport: () => page.evaluate(() => ({
            editorW: document.getElementById('editor').clientWidth,
            editorH: document.getElementById('editor').clientHeight,
            mainH: document.getElementById('main-container').clientHeight,
            innerH: window.innerHeight
        })),
        close: async () => {
            try { await browser.disconnect(); } catch (e) { }
            try { child.kill(); } catch (e) { }
            // Only our own process tree, so a session opened alongside is left alone.
            killOwn(child);
        }
    };
}

export { sleep };
