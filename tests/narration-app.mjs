/**
 * Narration, end to end, against the real binary: a narrator up, rendered audio playing,
 * and the reading highlight moving on by itself.
 *
 * Runs in the harness's throwaway profile and on its hidden desktop, with a narrator of its
 * own (narrator-sidecar.mjs) whose cache is in that profile: nothing of Ed's -- tabs,
 * settings, narration cache -- is touched, and no window takes his screen. The narration
 * is heard. Needs the Qwen extension installed; refuses if a narrator is already running.
 *
 * Two things this suite learned the hard way, both worth keeping:
 *   - virtual-host URLs never appear as page network events, because WebView2 serves them
 *     internally. Ask the page what it is playing instead of watching the network.
 *   - playNextChunk dispatches in two places, paginated and not. Patching one of them left
 *     narration silently falling back to a Windows voice in Pages, which is the layout most
 *     reading actually happens in, and every other check still passed.
 *
 *   RUN_APP_E2E=1 node tests/narration-app.mjs
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

const doc = path.join(profileDir, 'narrate-sample.md');
fs.writeFileSync(doc,
    '# A sample\n\nThe woman looked through the binoculars again, using both hands this time.\n\n'
  + '"I can see their dust," she announced. "And another couple of scouts, I think."\n\n'
  + '"Astounding," the drone said. It made a small noise, somewhere between a cough and a sigh.\n\n'
  + 'She placed the field glasses down and pulled the brim of her hat over her eyes.\n');

let narrator = null, app = null;
const cleanup = async () => {
    try { if (app) await app.close(); } catch (e) { }
    try { if (narrator) await narrator.stop(); } catch (e) { }
};
const killer = setTimeout(async () => { console.log('BUDGET HIT (6 min)'); await cleanup(); process.exit(3); }, 6 * 60000);

try {
    narrator = await startNarrator(profileDir);
    console.log('        model ready in ' + narrator.seconds.toFixed(0) + 's');
    app = await launchApp({ file: doc, settleMs: 8000 });
    const page = app.page;

    check(await page.evaluate(() => typeof window.startQwenNarration === 'function'),
        'the page knows how to narrate');
    const reach = await page.evaluate(async (u) => {
        try { return (await (await fetch(u + '/health')).json()).ready === true; } catch (e) { return false; }
    }, NARRATOR);
    check(reach, 'the page reaches the narrator');

    // Driven the way the menu item does, without needing the WPF menu.
    const started = Date.now();
    await page.evaluate((u) => window.startQwenNarration(u), NARRATOR);
    let playing = false;
    for (let i = 0; i < 150 && !playing; i++) {
        playing = await page.evaluate(() => isPlaying === true && !!document.querySelector('.tts-active'));
        if (!playing) await sleep(1000);
    }
    check(playing, 'narration started and a block is highlighted',
        Math.round((Date.now() - started) / 1000) + 's');

    if (playing) {
        const first = await page.evaluate(() => document.querySelector('.tts-active')?.innerText?.slice(0, 40));
        console.log('        highlighted: ' + JSON.stringify(first));
        const url = await page.evaluate(() => window.__lastChunkUrl || '');
        check(url.indexOf('localnarration') >= 0,
            'the block being read is playing rendered narration audio', JSON.stringify(url));

        // The highlight should move on by itself as the audio ends.
        let moved = false;
        for (let i = 0; i < 60 && !moved; i++) {
            const now = await page.evaluate(() => document.querySelector('.tts-active')?.innerText?.slice(0, 40));
            moved = !!now && now !== first;
            if (!moved) await sleep(1000);
        }
        check(moved, 'the highlight follows on to the next block');
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
