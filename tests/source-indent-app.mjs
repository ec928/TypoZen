/**
 * Enter in Source keeps the indentation of the line it left.
 *
 * The "help with aligning" half of the developer-editor request, delivered in the
 * surface that already exists rather than by building a new one. A textarea puts the
 * caret at column zero on Enter, so every indented structure -- a fence, a YAML
 * block, a nested list -- had to be re-indented by hand, line after line.
 *
 * Driven with real key events through the browser, not by calling the handler: the
 * whole point is what happens when a person presses Enter, and a dispatched event
 * would not prove the textarea's own default was prevented.
 *
 *   RUN_APP_E2E=1 node tests/source-indent-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 7000, view: true });
try {
    await app.eval(() => handleCommand('view_set:mode:source'));
    await sleep(2200);

    /** Put `text` in the textarea, caret at the end of line `lineNo`, press Enter for real. */
    const pressEnterAfter = async (text, lineNo) => {
        await app.eval((t, n) => {
            const ta = document.getElementById('source-editor');
            ta.value = t;
            const lines = t.split('\n');
            let at = 0;
            for (let i = 0; i <= n; i++) at += lines[i].length + (i < n ? 1 : 0);
            ta.focus();
            ta.setSelectionRange(at, at);
        }, text, lineNo);
        await sleep(250);
        await app.page.bringToFront().catch(() => {});
        await app.page.keyboard.press('Enter');
        await sleep(500);
        return app.eval(() => {
            const ta = document.getElementById('source-editor');
            const before = ta.value.slice(0, ta.selectionStart);
            const lineStart = before.lastIndexOf('\n') + 1;
            return {
                caretLine: before.slice(lineStart),
                value: ta.value,
            };
        });
    };

    console.log('=== indentation carries ===');
    const spaces = await pressEnterAfter('root\n    indented four\nlast', 1);
    info('new line begins ' + JSON.stringify(spaces.caretLine));
    assert(spaces.caretLine === '    ', 'four spaces are carried onto the new line');

    const tabs = await pressEnterAfter('root\n\t\ttabbed twice\nlast', 1);
    info('new line begins ' + JSON.stringify(tabs.caretLine));
    assert(tabs.caretLine === '\t\t', 'tabs are carried as tabs, not converted');

    const none = await pressEnterAfter('no indent here\nlast', 0);
    info('new line begins ' + JSON.stringify(none.caretLine));
    assert(none.caretLine === '', 'an unindented line still starts the next at column zero');

    console.log('\n=== a list continues ===');
    const bullet = await pressEnterAfter('  - first item\nlast', 0);
    info('new line begins ' + JSON.stringify(bullet.caretLine));
    assert(bullet.caretLine === '  - ', 'a bullet carries its indent and its marker');

    const numbered = await pressEnterAfter('3. third\nlast', 0);
    info('new line begins ' + JSON.stringify(numbered.caretLine));
    assert(numbered.caretLine === '4. ', 'a numbered item counts on');

    console.log('\n=== and an empty item ends it ===');
    const empty = await pressEnterAfter('- real item\n- \nlast', 1);
    info('value now ' + JSON.stringify(empty.value));
    assert(empty.caretLine === '', 'Enter on an empty bullet drops to column zero');
    assert(empty.value.indexOf('- \n') < 0,
        'and takes the empty marker away rather than leaving a stray bullet');
    assert(empty.value.indexOf('- real item') === 0, 'the real item above is untouched');

    console.log('\n=== the document is only what was typed ===');
    const clean = await pressEnterAfter('alpha\n    beta\ngamma', 1);
    assert(clean.value === 'alpha\n    beta\n    \ngamma',
        'exactly one newline and the carried indent were inserted (' +
        JSON.stringify(clean.value) + ')');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'SOURCE INDENT FAILED' : 'SOURCE INDENT PASSED');
process.exit(failed ? 1 : 0);
