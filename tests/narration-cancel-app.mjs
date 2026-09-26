/**
 * Stop has to stop the GPU, not just the sound.
 *
 * The first narration build kept the card at 99% after Stop: the page went on requesting
 * groups and the sidecar went on rendering audio nobody would hear. This drives a real
 * reading, presses Stop, and watches what the card does next.
 *
 * Runs in the harness's throwaway profile and on its hidden desktop, with a narrator of its
 * own (narrator-sidecar.mjs): nothing of Ed's is touched. The card is read with nvidia-smi,
 * so anything else using it at the same time -- a game, a video -- can fail the idle checks;
 * run it on a quiet card. Refuses if a narrator is already running.
 *
 *   RUN_APP_E2E=1 node tests/narration-cancel-app.mjs
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { launchApp, profileDir, sleep } from './app-harness.mjs';
import { startNarrator, NARRATOR } from './narrator-sidecar.mjs';

let pass = 0, fail = 0;
const check = (ok, what, detail) => {
    if (ok) { pass++; console.log('  PASS  ' + what); }
    else { fail++; console.log('  FAIL  ' + what + (detail ? '   ' + detail : '')); }
};
const gpu = () => {
    try {
        return parseInt(execSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits',
            { encoding: 'utf8' }).trim().split('\n')[0], 10);
    } catch (e) { return -1; }
};
/** The highest reading over a few seconds: utilisation is spiky, one sample says little. */
async function peak(seconds) {
    let top = 0;
    for (let i = 0; i < seconds * 2; i++) { top = Math.max(top, gpu()); await sleep(500); }
    return top;
}

const doc = path.join(profileDir, 'narrate-cancel.md');
// Long enough that rendering it all would take minutes, so "did it stop" is unambiguous.
const paras = [];
for (let i = 0; i < 30; i++) {
    paras.push('Paragraph ' + (i + 1) + '. The woman looked through the binoculars again, using '
        + 'both hands this time, and said nothing at all for a long moment while the dust rose.');
}
fs.writeFileSync(doc, '# Cancel test\n\n' + paras.join('\n\n') + '\n');

let narrator = null, app = null;
const cleanup = async () => {
    try { if (app) await app.close(); } catch (e) { }
    try { if (narrator) await narrator.stop(); } catch (e) { }
};
const killer = setTimeout(async () => { console.log('BUDGET HIT (7 min)'); await cleanup(); process.exit(3); }, 7 * 60000);

try {
    narrator = await startNarrator(profileDir);
    console.log('        model ready in ' + narrator.seconds.toFixed(0) + 's');
    app = await launchApp({ file: doc, settleMs: 8000 });
    const page = app.page;
    console.log('  idle GPU before: ' + (await peak(3)) + '%');

    // Kick it off without waiting for it: the call returns once the first block is ready.
    await page.evaluate((u) => { window.startQwenNarration(u); }, NARRATOR);

    let playing = false;
    for (let i = 0; i < 120 && !playing; i++) {
        playing = await page.evaluate(() => isPlaying === true);
        if (!playing) await sleep(1000);
    }
    check(playing, 'narration started');

    const busy = await peak(8);
    console.log('  GPU while narrating: ' + busy + '%');
    check(busy > 20, 'the card is working while it renders ahead', busy + '%');

    const queued = await page.evaluate(() => (typeof queuedSeconds === 'function') ? Math.round(queuedSeconds()) : -1);
    console.log('  audio queued ahead: ' + queued + 's');
    check(queued >= 0 && queued < 200, 'it renders a lead, not the whole document', queued + 's');

    await page.evaluate(() => stopReading());
    // A group already inside generate() runs to its end -- a CUDA call cannot be interrupted
    // safely -- so the promise is "it stops soon", not "it stops instantly". Measured: the
    // in-flight group took 19s. What must not happen is the next group starting.
    console.log('  stopped; waiting for the in-flight group, then checking it stays idle');
    // Judged from the narrator's own log, not the card: anything else using the GPU -- a
    // video, a game -- read as "still rendering" (33% on 2026-09-26, with another program
    // at 14-34% the whole time). The card's numbers stay, as information.
    const logFile = path.join(profileDir, 'extensions', 'QwenTTS', 'narration.log');
    const renders = () => {
        try { return (fs.readFileSync(logFile, 'utf8').match(/sidecar rendered \d+ pieces/g) || []).length; } catch (e) { return -1; }
    };
    // The in-flight group finishes (or is cancelled): the count stops moving for 20s --
    // longer than any one group takes (6-15s measured), so a pause between two groups of a
    // reading still going on cannot pass for the end of it.
    let settledAt = -1, last = renders(), still = 0;
    for (let i = 0; i < 120; i++) {
        await sleep(1000);
        const n = renders();
        still = n === last ? still + 1 : 0;
        last = n;
        if (still >= 20) { settledAt = i + 1; break; }
    }
    check(settledAt >= 0, 'rendering stops after Stop', settledAt + 's after stopping, ' + last + ' groups in all');
    if (settledAt >= 0) {
        const after = await peak(15);
        const more = renders() - last;
        console.log('  GPU over the next 15s: ' + after + '% (information only)');
        check(more === 0, 'and no further groups are started', more + ' more');
    }

    const stillPlaying = await page.evaluate(() => isPlaying === true);
    check(!stillPlaying, 'nothing is still reading');
} catch (err) {
    check(false, 'no exception', String(err && err.message || err));
} finally {
    await cleanup();
    clearTimeout(killer);
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
