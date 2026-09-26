/**
 * How long until a word is heard, on paragraphs the size a book actually has.
 *
 * Every earlier measurement used one-line paragraphs, which made the opening chunk cheap
 * and the number meaningless: it said 4s where Ed measured two minutes. This uses ~900
 * character paragraphs -- about a minute of speech each -- and reports the wall clock from
 * pressing Narrate to the first audio element playing, then again from the same place,
 * which must come from the cache.
 *
 * Runs in the harness's throwaway profile and on its hidden desktop, with a narrator of its
 * own (narrator-sidecar.mjs) whose cache starts empty -- so the first number is a cold
 * render, as it was meant to be, and nothing of Ed's is touched. Refuses if a narrator is
 * already running.
 *
 *   RUN_APP_E2E=1 node tests/narration-firstsound-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { launchApp, profileDir, sleep } from './app-harness.mjs';
import { startNarrator, NARRATOR } from './narrator-sidecar.mjs';

let pass = 0, fail = 0;
const check = (ok, what, detail) => {
    if (ok) { pass++; console.log('  PASS  ' + what); }
    else { fail++; console.log('  FAIL  ' + what + (detail ? '   ' + detail : '')); }
};

const LONG = "The woman looked through the binoculars again, using both hands this time, and "
    + "said nothing at all for a long moment while the dust rose along the line of the road. "
    + "In the distance, trembling through the heat haze, the straight edge of the highway ran "
    + "on towards mountains that were pale with distance and shimmered in the baking air. Some "
    + "scrawny trees marked its course, few of them taller than one man standing on another's "
    + "shoulders, and beyond them the scrub gave way to sand. She had been watching the same "
    + "stretch of ground since the morning, and the light had not changed, and nothing had "
    + "moved on it but the army, which was closer now than it had been at noon, and slower "
    + "than she had expected an army of that size to be.";

const doc = path.join(profileDir, 'narrate-long.md');
const paras = [];
for (let i = 0; i < 10; i++) paras.push('Section ' + (i + 1) + '. ' + LONG);
fs.writeFileSync(doc, '# Long paragraphs\n\n' + paras.join('\n\n') + '\n');
console.log('  paragraphs of ' + LONG.length + ' characters (about a minute of speech each)');

let narrator = null, app = null;
const cleanup = async () => {
    try { if (app) await app.close(); } catch (e) { }
    try { if (narrator) await narrator.stop(); } catch (e) { }
};
const killer = setTimeout(async () => { console.log('BUDGET HIT (7 min)'); await cleanup(); process.exit(3); }, 7 * 60000);

/** Seconds from Narrate to audio playing, or -1 after two minutes. */
async function timeToSound(page) {
    const t0 = Date.now();
    await page.evaluate((u) => { window.__lastChunkUrl = ''; window.startQwenNarration(u); }, NARRATOR);
    for (let i = 0; i < 240; i++) {
        if (await page.evaluate(() => !!window.__lastChunkUrl && isPlaying === true)) return (Date.now() - t0) / 1000;
        await sleep(500);
    }
    return -1;
}

try {
    narrator = await startNarrator(profileDir);
    console.log('  cold start (process to model ready): ' + narrator.seconds.toFixed(0) + 's');
    app = await launchApp({ file: doc, settleMs: 8000 });
    const page = app.page;

    const heard = await timeToSound(page);
    console.log(heard < 0 ? '  NEVER PLAYED within 120s' : '  first sound after ' + heard.toFixed(1) + 's');
    // The opening batch is cut into sentences for exactly this (graduatedBatches): about 20s.
    check(heard > 0 && heard < 90, 'first sound on book-length paragraphs within 90s', heard.toFixed(1) + 's');

    if (heard > 0) {
        await page.evaluate(() => stopReading());
        await sleep(1500);
        const again = await timeToSound(page);
        console.log(again < 0 ? '  second attempt never played' : '  second time from the same spot: ' + again.toFixed(1) + 's');
        check(again > 0 && again < Math.max(5, heard / 2), 'from the same spot again, it comes from the cache', again.toFixed(1) + 's');
        await page.evaluate(() => stopReading());
    }
} catch (err) {
    check(false, 'no exception', String(err && err.message || err));
} finally {
    await cleanup();
    clearTimeout(killer);
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
