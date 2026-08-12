/**
 * Type into a code file and check the file, not the model.
 *
 * This suite exists because the one before it did not do that, and shipped a feature
 * that destroyed documents while reporting 19/19.
 *
 * code-document-app drives setBlockRaw, with a comment claiming that is "the path a
 * keystroke takes". It is not. A keystroke goes through serializeBlockDomToRaw ->
 * blockHtmlToMarkdown, which ran the MARKDOWN serialiser over the token spans and
 * returned every token as its own line. A real .xaml opened in the editor came apart
 * into one fragment per token, and the tab was marked unsaved -- so the next Ctrl+S
 * would have written that over the file.
 *
 * The claim in 08-code.js -- "a code block's raw is only ever rewritten from
 * textContent" -- was asserted from the design and never checked against the code. This
 * suite checks it against the running application:
 *
 *   - real key events into a real mounted block, not a model call
 *   - the document compared against the BYTES ON DISK afterwards, not against itself
 *   - the block count checked, because the failure mode was blocks multiplying
 *
 * If any future change routes a code block's DOM back through Markdown, this fails.
 *
 *   RUN_APP_E2E=1 node tests/code-typing-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { launchApp, sleep, appDir } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const FIXTURE = 'tests/fixtures-code.xaml';
const onDisk = fs.readFileSync(path.join(appDir, FIXTURE), 'utf8').replace(/\r\n/g, '\n');
const originalLines = onDisk.split('\n').length;

const app = await launchApp({ file: FIXTURE, settleMs: 8000, view: true });
try {
    // Load it the way the host does. (The host's own command-line open does not deliver
    // content when a session is restored -- a separate known gap.)
    await app.eval((p, text) => {
        window.__tzDocPath = p;
        finishLoadContent(text, false);
    }, 'C:\\code\\fixtures-code.xaml', onDisk);
    await sleep(2500);

    const start = await app.eval(() => ({
        kind: DocumentModel.kind,
        blocks: DocumentModel.blocks.length,
        serialised: DocumentModel.toMarkdown(),
    }));
    assert(start.kind === 'code', 'control: the document loaded as code');
    assert(start.blocks === originalLines,
        'control: one block per line before typing (' + start.blocks + ')');
    assert(start.serialised === onDisk, 'control: it matches the file before typing');

    console.log('\n=== typing into a token ===');
    // Put the caret inside a block that HAS token spans -- that is the whole hazard.
    // Clicking a span rather than the block, because that is where a person aims.
    const placed = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const blocks = [...document.querySelectorAll('#editor .block[data-model-index]')];
        const bi = blocks.findIndex(b => /FontSize/.test(b.textContent || ''));
        const block = blocks[bi];
        const span = block.querySelector('.tzc-attr, .tzc-tag, .tzc-string');
        const node = span ? span.firstChild : block.firstChild;
        const r = document.createRange();
        r.setStart(node, Math.min(2, (node.textContent || '').length));
        r.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        block.focus();
        await sleep(300);
        return {
            bi, spans: block.querySelectorAll('[class^="tzc-"]').length,
            inSpan: !!span, raw: block.getAttribute('data-raw'),
        };
    });
    info('block ' + placed.bi + ' has ' + placed.spans + ' token spans; caret inside a span: ' +
         placed.inSpan);
    assert(placed.spans > 2, 'control: the target block is painted with tokens');
    assert(placed.inSpan, 'control: the caret was placed INSIDE a token span');

    // Real keys through the browser, not dispatched events: this must go through every
    // input handler the application has.
    await app.page.bringToFront().catch(() => {});
    await app.page.keyboard.type('ZZ', { delay: 60 });
    await sleep(1500);

    const after = await app.eval(() => ({
        blocks: DocumentModel.blocks.length,
        serialised: DocumentModel.toMarkdown(),
        firstLines: DocumentModel.blocks.slice(0, 4).map(b => b.raw),
    }));

    console.log('\n=== the file is still a file ===');
    info('blocks ' + start.blocks + ' -> ' + after.blocks);
    assert(after.blocks === start.blocks,
        'typing does not change the number of lines (' + after.blocks + ')');

    // The exact failure: the document must differ from the original by the typed
    // characters and by nothing else.
    const expected = onDisk.replace(/\n/g, '\n');   // identity; kept explicit
    const diffChars = after.serialised.length - expected.length;
    info('length delta ' + diffChars + ' (typed 2 characters)');
    assert(diffChars === 2, 'the document grew by exactly what was typed');

    const strippedBack = after.serialised.replace('ZZ', '');
    if (strippedBack !== onDisk) {
        const a = onDisk.split('\n'), b = strippedBack.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (a[i] !== b[i]) {
                info('first difference at line ' + (i + 1));
                info('  disk : ' + JSON.stringify(a[i]));
                info('  after: ' + JSON.stringify(b[i]));
                break;
            }
        }
    }
    assert(strippedBack === onDisk,
        'removing the typed characters gives back the file byte for byte');

    console.log('\n=== indentation survived ===');
    const indent = await app.eval(() =>
        DocumentModel.blocks.map(b => b.raw).filter(r => /^\s+</.test(r)).length);
    const diskIndent = onDisk.split('\n').filter(r => /^\s+</.test(r)).length;
    info('indented lines: ' + indent + ' (disk has ' + diskIndent + ')');
    assert(indent === diskIndent, 'every indented line is still indented');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'CODE TYPING FAILED' : 'CODE TYPING PASSED');
process.exit(failed ? 1 : 0);
