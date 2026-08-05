/**
 * Wait for the page to stop moving, instead of guessing with a fixed sleep.
 *
 * Three browser suites failed intermittently in full runs and passed every time
 * standalone: twocol-anchoring, pagination and smoke. Same cause in each -- a sleep long
 * enough on an idle machine and not long enough when the build runs every browser suite
 * back to back. Between them they blocked or falsely blocked several builds without once
 * indicating a real defect, which is the worst way for a gate to behave: it would hide a
 * genuine failure exactly as readily.
 *
 * The layout settles asynchronously by design -- goToPageHoldingBlock retries until
 * editor.scrollWidth stops changing, virt remounts and re-pins across frames, and a column
 * switch waits on the host resizing the window. The only honest wait is for the same
 * condition, so this samples the geometry everything else is derived from and proceeds
 * after it has held still.
 */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** One sample of everything layout decisions are made from. */
function geometrySample() {
    const ed = document.getElementById('editor');
    const main = document.getElementById('main-container');
    if (!ed || !main) return 'no-editor';
    return [
        Math.round(ed.scrollWidth), Math.round(ed.scrollLeft),
        Math.round(ed.clientWidth), Math.round(ed.clientHeight),
        Math.round(main.scrollTop), Math.round(main.scrollHeight),
        ed.querySelectorAll('.block').length,
        (typeof PageMap !== 'undefined' && PageMap.count) ? PageMap.count() : -1
    ].join(',');
}

/**
 * Resolve once the geometry has been identical three samples running.
 *
 * Returns true if it settled, false if it ran out of time -- callers may assert on that
 * rather than silently proceeding against a moving layout.
 */
export async function settled(page, timeoutMs = 8000) {
    const started = Date.now();
    let last = null;
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
        const now = await page.evaluate(geometrySample);
        if (now === last) {
            if (++stable >= 3) return true;
        } else {
            stable = 0;
            last = now;
        }
        await sleep(120);
    }
    return false;
}

/**
 * The same wait for the application harness, which exposes eval() rather than a page.
 *
 * The app suites need it more than the browser ones, not less: a column switch there also
 * asks the WPF host to resize the window to that column mode's saved geometry, so the page
 * relayouts twice -- once for the new column count and again when the window arrives. A
 * fixed sleep lands between them and reads a page number that is about to be recomputed.
 * That is the whole of the "off-by-one" in the windowed column round trip: the telemetry
 * shows goToPage running twice, "block 73 is on page 4 of 230" and then "page 3 of 210",
 * with the assertion taken in between.
 */
export async function settledApp(app, timeoutMs = 10000) {
    const started = Date.now();
    let last = null;
    let stable = 0;
    while (Date.now() - started < timeoutMs) {
        const now = await app.eval(geometrySample);
        if (now === last) {
            if (++stable >= 3) return true;
        } else {
            stable = 0;
            last = now;
        }
        await sleep(150);
    }
    return false;
}

export { sleep };
