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
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.join(__dirname, '..');
const PORT = 9333;                 // must match Program.RemoteDebugPort
const EXE = path.join(appDir, 'TypoZen.exe');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** TypoZen is single-instance; a stale copy would swallow our launch. */
function killExisting() {
    try { execSync('taskkill /IM TypoZen.exe /F', { stdio: 'ignore' }); } catch (e) { }
    try { execSync('taskkill /IM msedgewebview2.exe /F', { stdio: 'ignore' }); } catch (e) { }
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

/**
 * Launch TypoZen.exe --debug and attach.
 * @param {{file?:string, width?:number, height?:number, settleMs?:number}} options
 */
export async function launchApp(options) {
    options = options || {};
    if (!fs.existsSync(EXE)) throw new Error('TypoZen.exe not found - run Build_TypoZen.ps1 first');

    killExisting();
    await sleep(400);

    const args = ['--debug'];
    if (options.file) args.push(path.join(appDir, options.file));

    const child = spawn(EXE, args, { cwd: appDir, detached: false, stdio: 'ignore' });
    await waitForDevTools(45000);

    const browser = await puppeteer.connect({
        browserURL: 'http://127.0.0.1:' + PORT,
        defaultViewport: null           // the WPF window decides the viewport, not us
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

    await sleep(options.settleMs == null ? 2500 : options.settleMs);

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
            killExisting();
        }
    };
}

export { sleep };
