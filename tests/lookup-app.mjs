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
import { launchApp } from './app-harness.mjs';

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
            resolve({
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

    const mice = await app.eval(ask, 'mice');
    assert(/rodent|mouse/i.test(mice.def), 'mice: finds mouse');

    const walking = await app.eval(ask, 'walking');
    assert(walking.def.length > 0, 'walking: suffix stripping still answers');

    const none = await app.eval(ask, 'zzxqqv');
    assert(/Not in the installed dictionary/.test(none.hint), 'a non-word says so');
} finally {
    await app.close();
}

console.log(`\npassed=${passed} failed=${failed}`);
console.log(failed ? 'LOOKUP FAILED' : 'LOOKUP PASSED');
process.exit(failed ? 1 : 0);
