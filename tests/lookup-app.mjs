/**
 * Look up, answered by the shipped dictionary in the real app.
 *
 * annotations-app proves the popover answers, and accepts the "no dictionary" hint as an
 * answer -- so it passed through every release in which "run" meant a score in baseball.
 * This asks about the words themselves: the common sense comes first, an irregular form
 * finds its base word, three senses show and the rest wait behind "more".
 *
 *   RUN_APP_E2E=1 node tests/lookup-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { launchApp, profileDir, profileFile } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const ask = (word) => new Promise((resolve) => {
    const body = document.getElementById('selPopBody');
    document.getElementById('selPop').hidden = false;
    body.innerHTML = '';
    const t0 = performance.now();
    (function poll() {
        const def = body.querySelector('.selpop-def:not(.selpop-syn)');
        const hint = body.querySelector('.selpop-hint');
        if (def || hint || performance.now() - t0 > 3000) {
            const syn = body.querySelector('.selpop-syn');
            const via = body.querySelector('.selpop-via');
            const say = body.querySelector('.selpop-say');
            resolve({
                say: say ? say.textContent : '',
                via: via ? via.textContent.replace(/^\s*→\s*/, '') : '',
                def: def ? def.textContent : '',
                hint: hint ? hint.textContent : '',
                syn: syn ? syn.textContent : '',
                more: [...body.querySelectorAll('.selpop-more')].map(b => b.textContent),
            });
        } else setTimeout(poll, 25);
    })();
    postMsg('define:' + word);
});

let app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    const run = await app.eval(ask, 'run');
    console.log('  ..   run: ' + run.def.slice(0, 90));
    assert(/^move fast by using one's feet/.test(run.def), 'run: the everyday sense comes first');
    assert(!/baseball/.test(run.def), 'and a score in baseball is not among the three shown');
    assert(run.more.some(m => /more meanings/.test(m)), 'the rest are offered behind "more"');

    const bank = await app.eval(ask, 'Bank');
    assert(/sloping land|financial institution/.test(bank.def.split(';')[0]), 'Bank: not a flight manoeuvre, whatever the case');

    const opened = await app.eval(() => new Promise((resolve) => {
        const body = document.getElementById('selPopBody');
        const before = body.querySelector('.selpop-def').textContent.length;
        body.querySelector('.selpop-more').click();
        resolve({ before, after: body.querySelector('.selpop-def').textContent.length,
                  linkGone: !body.querySelector('.selpop-def:not(.selpop-syn) + .selpop-more') });
    }));
    assert(opened.after > opened.before && opened.linkGone, '"more" shows every sense and then goes');

    const ran = await app.eval(ask, 'ran');
    console.log('  ..   ran: ' + ran.def.slice(0, 60) + ' / ' + ran.syn.slice(0, 40));
    assert(/^move fast/.test(ran.def), 'ran: an irregular form answers with its base word');
    assert(ran.syn.length > 0, 'and with its synonyms');
    assert(!/^@/.test(ran.def), 'the redirect marker never reaches the reader');
    assert(ran.via === 'run', 'and the title says the answer is for "run"');
    assert(run.via === '', 'a word answered as itself says nothing extra');
    assert(run.say === '', 'the built-in dictionary has no pronunciations, and none is shown');
    const comp = await app.eval(ask, 'compositing');
    assert(comp.via === 'composite', 'compositing: answered as "composite", and says so');

    const mice = await app.eval(ask, 'mice');
    assert(/rodent|mouse/i.test(mice.def), 'mice: finds mouse');

    const walking = await app.eval(ask, 'walking');
    assert(walking.def.length > 0, 'walking: suffix stripping still answers');

    const none = await app.eval(ask, 'zzxqqv');
    assert(/Not in the installed dictionary/.test(none.hint), 'a non-word says so');
} finally {
    await app.close();
}

// A second dictionary: a folder under the profile's dictionaries\, chosen in settings the
// way File > Dictionary saves it. The menu itself is WPF and is checked by hand; this
// checks that the saved choice is what answers, all of it, and that a choice whose folder
// has gone falls back to the built-in one instead of answering nothing.
console.log('\n=== a chosen dictionary answers, synonyms and all ===');
const testDict = path.join(profileDir, 'dictionaries', 'Test');
fs.mkdirSync(testDict, { recursive: true });
fs.writeFileSync(path.join(testDict, 'dictionary.tsv'),
    'bank\tTEST BANK\nrun\tTEST SENSE ONE | TEST SENSE TWO\tUK /rVn/ · US /rVn/\n');
fs.writeFileSync(profileFile('window_state.json'), '{"dictionary":"Test"}');
app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    const run = await app.eval(ask, 'run');
    assert(/^TEST SENSE ONE/.test(run.def) && /TEST SENSE TWO/.test(run.def), 'run: answered by the chosen dictionary');
    assert(run.say === 'UK /rVn/ · US /rVn/', 'with its pronunciation, from the third column');
    assert(!/rVn/.test(run.def), 'which is not mixed into the senses');
    assert(run.syn === '', 'and it has no thesaurus, so no synonyms -- none borrowed from the built-in one');
    const walking = await app.eval(ask, 'walking');
    assert(/Not in the installed dictionary/.test(walking.hint), 'a word it lacks is not looked up elsewhere');
} finally {
    await app.close();
}

// Synonyms belong to the word that was defined. Wiktionary defines "compositing" and has
// no synonyms for it; stripping -ing reached "composite", whose synonym is the daisy
// family, and the popover showed both as one answer.
fs.writeFileSync(path.join(testDict, 'dictionary.tsv'),
    'composite\tTEST COMPOSITE\ncompositing\tTEST IMAGE COMPOSITING\n');
fs.writeFileSync(path.join(testDict, 'thesaurus.tsv'), 'composite\tasteracean\n');
fs.writeFileSync(profileFile('window_state.json'), '{"dictionary":"Test"}');
app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    const c = await app.eval(ask, 'compositing');
    assert(/TEST IMAGE COMPOSITING/.test(c.def), 'compositing: its own definition');
    assert(!/asteracean/.test(c.syn), 'and not the synonyms of composite');
} finally {
    await app.close();
}
fs.writeFileSync(path.join(testDict, 'dictionary.tsv'),
    'bank\tTEST BANK\nrun\tTEST SENSE ONE | TEST SENSE TWO\n');
fs.rmSync(path.join(testDict, 'thesaurus.tsv'));
const saved = fs.readFileSync(profileFile('window_state.json'), 'utf8');
assert(/"dictionary"\s*:\s*"Test"/.test(saved), 'the choice survives the app writing its settings on exit');

console.log('\n=== a chosen dictionary that has gone falls back ===');
fs.writeFileSync(profileFile('window_state.json'), '{"dictionary":"Gone"}');
app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 6000 });
try {
    const run = await app.eval(ask, 'run');
    assert(/^move fast by using one's feet/.test(run.def), 'the built-in dictionary answers');
} finally {
    await app.close();
}

console.log(`\npassed=${passed} failed=${failed}`);
console.log(failed ? 'LOOKUP FAILED' : 'LOOKUP PASSED');
process.exit(failed ? 1 : 0);
