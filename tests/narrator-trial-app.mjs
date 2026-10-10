/**
 * Narrator Manager' Try it prepares text as narration does (narrationTrial, 09-speech.js):
 * numbers as words, one piece per line, the reader's instruction and cue wording sent as they
 * are, and a speech tag's words only when Emotion cues are ticked -- added to the instruction,
 * not sent as a direction (cueInstruction; docs/narrator-cues.md, "Speech words"). The narrator and the audio are stubbed, so
 * nothing is heard; what is checked is what the narrator would be sent, and that the reading
 * plays to its end.
 *
 *   RUN_APP_E2E=1 node tests/narrator-trial-app.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { launchApp, sleep } from './app-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const ok = (c, m, d) => { if (!c) failed++; console.log((c ? '  OK    ' : '  FAIL  ') + m + (d ? '   ' + d : '')); };
const killer = setTimeout(() => { console.log('BUDGET HIT'); process.exit(3); }, 60000);
const waitFor = async (app, fn, ms) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await app.eval(fn); } catch (e) { v = null; } if (v || Date.now() > end) return v; await sleep(100); }
};
const SAMPLE = 'Mara pushed the door open and stood there, dripping.\n'
    + '“You said you’d be back by Tuesday,” Tom said quietly.\n'
    + '“I know,” she snapped. “The ferry cost me £86.”';

let app = null;
try {
    app = await launchApp({ file: path.join(here, 'large-scroll-mixed.md'), settleMs: 8000 });
    await app.eval(() => {
        window.__bodies = []; window.__played = 0;
        const realFetch = window.fetch;
        window.fetch = async (url, init) => {
            if (!String(url).startsWith('http://narrator.stub/')) return realFetch(url, init);
            const body = JSON.parse(init.body);
            window.__bodies.push(body);
            return new Response(JSON.stringify({ items: body.blocks.map((b, i) => ({
                id: b.id, file: 'stub' + i + '.wav', seconds: 1, instruction: body.instruction + (b.direction ? ' +' + b.direction : '') })) }));
        };
        // Audio that ends at once, counting what would have played.
        window.Audio = function () { const a = { playbackRate: 1, pause() {}, play() { window.__played++; setTimeout(() => a.onended && a.onended(), 10); return Promise.resolve(); } }; return a; };
    });
    const run = (direct) => app.eval((o) => { window.__played = 0; window.narrationTrial(JSON.stringify(o)); },
        { base: 'http://narrator.stub', text: SAMPLE, voice: 'v1', instruction: 'Read it plainly.', cue: 'Say it as {cue}.', direct });

    await run(false);
    const off = await waitFor(app, () => window.__bodies.length && window.__played >= 3 ? window.__bodies[0] : null, 5000);
    ok(off && off.blocks.length === 3, 'one piece per line', JSON.stringify(off && off.blocks.map(b => b.text)));
    ok(off && off.instruction === 'Read it plainly.' && off.cue === 'Say it as {cue}.' && off.voice === 'v1',
        'the instruction, cue wording and voice go as given', JSON.stringify(off && { i: off.instruction, c: off.cue, v: off.voice }));
    ok(off && off.blocks.every(b => b.direction === '' && b.instruction === ''), 'cues off: no piece carries a cue',
        JSON.stringify(off && off.blocks.map(b => ({ d: b.direction, i: b.instruction }))));
    ok(off && /eighty-six pounds/.test(off.blocks[2].text), 'numbers are spoken as words, as narration has them', off && off.blocks[2].text);

    await app.eval(() => { window.__bodies = []; });
    await run(true);
    const on = await waitFor(app, () => window.__bodies.length && window.__played >= 3 ? window.__bodies[0] : null, 5000);
    // The tag's own words ("said" left out), after the reader's instruction; the untagged line gets nothing.
    const told = on && on.blocks.map(b => ({ d: b.direction, i: b.instruction }));
    const tagged = (t, words) => t.d === '' && t.i.startsWith('Read it plainly') && t.i.endsWith(', ' + words);
    ok(told && told[0].d === '' && told[0].i === '' && tagged(told[1], 'quietly') && tagged(told[2], 'snapped'),
        'cues on: the tagged lines add their speech tag to the instruction', JSON.stringify(told));

    // Narration itself sends the saved instruction and cue wording, and a cue only when ticked.
    const sent = await app.eval(async () => {
        window.__bodies = [];
        const piece = [{ id: 1, text: '“Go,” she whispered.', direction: 'whispered, hushed' }];
        window.setNarratorSettings({ voice: 'v1', instruction: 'Saved words.', cue: 'Cue {cue}.', direct: false });
        await renderNarration('http://narrator.stub', piece, 1);
        window.setNarratorSettings({ voice: 'v1', instruction: 'Saved words.', cue: 'Cue {cue}.', direct: true });
        await renderNarration('http://narrator.stub', piece, 2);
        return window.__bodies.map(b => ({ i: b.instruction, c: b.cue, d: b.blocks[0].direction, bi: b.blocks[0].instruction }));
    });
    ok(sent && sent[0].i === 'Saved words.' && sent[0].c === 'Cue {cue}.' && sent[0].d === '' && sent[0].bi === ''
        && sent[1].d === '' && sent[1].bi.startsWith('Saved words') && sent[1].bi.endsWith(', whispered, hushed'),
        'narration sends the saved instruction, and the cue only when ticked', JSON.stringify(sent));
} catch (e) { ok(false, 'stopped', e && e.message); }
finally {
    if (app) { try { await app.closeGracefully(); } catch (e) { try { await app.close(); } catch (e2) { } } }
    clearTimeout(killer);
    console.log(failed ? 'NARRATOR-TRIAL FAILED' : 'NARRATOR-TRIAL PASSED');
    process.exitCode = failed ? 1 : 0;
}
