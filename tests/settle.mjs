/**
 * Wait for the page to stop moving, instead of guessing with a fixed sleep.
 *
 * Agents: import settled / settledApp / untilPage from here. Do not add
 * `await sleep(400)` after a layout or find command. settleMs on launchApp is a
 * timeout cap, not a mandatory pause.
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

// Sample often, but decide on a DURATION of quiet, not a count of samples.
//
// Sampling was 120ms x 3 -- 360ms of stillness before calling it settled. Speeding the
// sampling up to 50ms while still counting three left a 150ms window, and 150ms is
// inside the pause a multi-column relayout takes between its own passes: the geometry
// reads identical three times in the middle of the work, settled() says yes, and the
// suite measures a half-laid-out page. That turned pagination-browser and
// twocol-anchoring-browser red on the default gate -- "switching back returns to the
// same content (block 738 vs -1)", "0 of 36 blocks in common" -- which reads exactly
// like a product regression in column switching and is not one. Bisected: reverting
// this file alone put both back to 28/0 and 7/0.
//
// Fast sampling is still worth having; it is how quickly we NOTICE the last change.
// How long we then wait to trust it is a separate number, and it has to stay at least
// as long as the 360ms that was proven to work under full-run contention.
const SAMPLE_MS = 50;
// How long the geometry must hold still before we trust it. Adaptive, because a fixed
// number is either too slow everywhere or too fast where it matters.
//
// 400ms flat is correct and wasteful: most settles follow a command that moves nothing
// (a mode flag, a class toggle) and pay the full window anyway. 150ms flat is fast and
// wrong -- it is inside the pause a multi-column relayout takes between its own passes,
// so the geometry reads identical mid-work and the suite measures a half-laid-out page.
//
// So scale the wait to the churn actually observed: something that thrashed for 300ms
// gets 300ms of quiet before we believe it, something that never moved gets the floor.
// A relayout that pauses mid-work has by definition already churned for longer than the
// pause, so the window it earns is longer than the gap it could hide in.
const QUIET_MIN_MS = 260;
const QUIET_MAX_MS = 400;
const quietNeeded = (churnMs) =>
    Math.min(QUIET_MAX_MS, Math.max(QUIET_MIN_MS, churnMs));

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
    let lastChangeAt = Date.now(), firstChangeAt = 0;
    while (Date.now() - started < timeoutMs) {
        const now = await page.evaluate(geometrySample);
        if (now !== last) {
            last = now;
            lastChangeAt = Date.now();
            if (!firstChangeAt) firstChangeAt = lastChangeAt;
        } else if (Date.now() - lastChangeAt
                   >= quietNeeded(firstChangeAt ? lastChangeAt - firstChangeAt : 0)) {
            return true;
        }
        await sleep(SAMPLE_MS);
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
    let lastChangeAt = Date.now(), firstChangeAt = 0;
    while (Date.now() - started < timeoutMs) {
        const now = await app.eval(geometrySample);
        if (now !== last) {
            last = now;
            lastChangeAt = Date.now();
            if (!firstChangeAt) firstChangeAt = lastChangeAt;
        } else if (Date.now() - lastChangeAt
                   >= quietNeeded(firstChangeAt ? lastChangeAt - firstChangeAt : 0)) {
            return true;
        }
        await sleep(SAMPLE_MS);
    }
    return false;
}

/**
 * Poll a page predicate. Use this instead of `await sleep(600)` after a command.
 * Returns the last truthy value, or false on timeout.
 */
export async function untilPage(page, fn, timeoutMs = 8000, arg) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        // arg is forwarded into the page, so a predicate can compare against something
        // measured on this side (the text that was on screen before a click, say) without
        // stashing it on window.
        const v = arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn, arg);
        if (v) return v;
        await sleep(SAMPLE_MS);
    }
    return false;
}

export { sleep };
