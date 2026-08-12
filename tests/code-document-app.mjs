/**
 * A code file opened in the real application.
 *
 * The selftest covers the lexers over strings. This covers the thing that actually
 * worries me: that a code file lands in Preview's block editor and comes back out
 * unchanged, with none of Markdown's housekeeping having quietly rewritten it.
 *
 * The assertion that matters is the round-trip, and it is asserted against the bytes
 * on disk rather than against what the app thinks it loaded. Two behaviours would
 * have broken it and neither is hypothetical:
 *
 *   - coerceBlockRaw() collapses a multi-line raw and TRIMS each part, which is the
 *     leading indentation the file is made of
 *   - toMarkdown() pops trailing blank lines, which rewrites the final newline
 *
 * Also here: a Markdown file must still open as Markdown. A routing change that turns
 * every document into code would pass every assertion above.
 *
 *   RUN_APP_E2E=1 node tests/code-document-app.mjs
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { launchApp, sleep, appDir } from './app-harness.mjs';

/** Drive the WPF tab strip, because the page cannot. */
function shell(command, arg) {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(appDir, 'tests', 'shell-ui.ps1'), '-Command', command];
    if (arg) args.push('-Arg', arg);
    return JSON.parse(execFileSync('powershell', args, { encoding: 'utf8' }).trim());
}

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const FIXTURE = 'tests/fixtures-code.xaml';
const onDisk = fs.readFileSync(path.join(appDir, FIXTURE), 'utf8').replace(/\r\n/g, '\n');

const app = await launchApp({ file: FIXTURE, settleMs: 8000 });
try {
    // The host opens the file as a tab -- asserted -- but with the restored session
    // present its CONTENT does not reach the page: the tab carries the .xaml path, so
    // the routing correctly says "code", while the blocks hold the welcome document.
    // That is a host tab-lifecycle gap, recorded in the commit and not yet fixed.
    //
    // So the routing decision and the code kind are driven here exactly as the two host
    // messages drive them -- doc_path then content -- which tests this work without
    // depending on plumbing it does not own.
    const tabs = shell('tabs').tabs;
    const mine = tabs.findIndex(t => /fixtures-code\.xaml/.test(t.name || ''));
    assert(mine >= 0, 'control: the host opened the code file as a tab');

    await app.eval((p, text) => {
        window.__tzDocPath = p;          // what the doc_path: message sets
        finishLoadContent(text, false);  // what the load_content: message calls
    }, 'C:\anywhere\fixtures-code.xaml', onDisk);
    await sleep(2500);
    const s = await app.eval(() => {
        const ed = document.getElementById('editor');
        const blocks = [...ed.querySelectorAll('.block[data-model-index]')];
        return {
            kind: DocumentModel.kind,
            language: DocumentModel.language,
            codeMode: ed.classList.contains('code-mode'),
            blockCount: DocumentModel.blocks.length,
            roundTrip: DocumentModel.toMarkdown(),
            mountedBlocks: blocks.length,
            tokenSpans: ed.querySelectorAll('[class^="tzc-"]').length,
            tokenKinds: [...new Set([...ed.querySelectorAll('[class^="tzc-"]')]
                .map(e => e.className))].sort(),
            // The line whose indentation is most at risk.
            indented: DocumentModel.blocks.map(b => b.raw).find(r => /^\s+<TextBlock/.test(r)) || null,
        };
    });

    console.log('=== it opened as code ===');
    info('kind=' + s.kind + ' language=' + s.language + ' blocks=' + s.blockCount +
         ' mounted=' + s.mountedBlocks);
    assert(s.kind === 'code', 'the document kind is code');
    assert(s.language === 'xml', 'and .xaml picked the xml lexer');
    assert(s.codeMode === true, 'the editor carries code-mode');
    assert(s.blockCount === onDisk.split('\n').length,
        'one block per line (' + s.blockCount + ' vs ' + onDisk.split('\n').length + ')');

    console.log('\n=== it is painted ===');
    info('token kinds: ' + JSON.stringify(s.tokenKinds));
    assert(s.tokenSpans > 5, 'tokens are painted as real elements (' + s.tokenSpans + ')');
    assert(s.tokenKinds.indexOf('tzc-tag') >= 0, 'tags are marked');
    assert(s.tokenKinds.indexOf('tzc-attr') >= 0, 'attributes are marked');
    assert(s.tokenKinds.indexOf('tzc-comment') >= 0, 'the comment is marked');
    assert(s.tokenKinds.indexOf('tzc-string') >= 0, 'attribute values are marked');

    console.log('\n=== and it comes back out unchanged ===');
    info('indented line: ' + JSON.stringify(s.indented));
    assert(s.indented && /^ {8}</.test(s.indented),
        'leading indentation survives the load, untrimmed');
    const same = s.roundTrip === onDisk;
    if (!same) {
        const a = onDisk.split('\n'), b = s.roundTrip.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (a[i] !== b[i]) { info('first difference at line ' + (i + 1) +
                ': ' + JSON.stringify(a[i]) + ' -> ' + JSON.stringify(b[i])); break; }
        }
    }
    assert(same, 'the document serialises back to exactly the bytes on disk');

    console.log('\n=== an edit does not reformat the line ===');
    const edited = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const idx = DocumentModel.blocks.findIndex(b => /^\s+<TextBlock/.test(b.raw));
        const before = DocumentModel.blocks[idx].raw;
        // Through setBlockRaw, which is the path a keystroke takes -- and the path
        // coerceBlockRaw sits on.
        DocumentModel.setBlockRaw(idx, before.replace('FontSize="14"', 'FontSize="18"'));
        await sleep(400);
        return { idx, before, after: DocumentModel.blocks[idx].raw };
    });
    info(JSON.stringify(edited.before));
    info(JSON.stringify(edited.after));
    assert(edited.after.indexOf('FontSize="18"') >= 0, 'the edit landed');
    assert(/^ {8}</.test(edited.after),
        'and the leading indentation is still there afterwards');
    assert(edited.after.length === edited.before.length,
        'nothing else about the line changed');
} finally {
    await app.close();
}

// --- A Markdown file must still be Markdown. A routing bug that swept everything into
//     the code kind would satisfy every assertion above.
console.log('\n=== markdown is untouched ===');
const md = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 7000 });
try {
    const m = await md.eval(() => ({
        kind: DocumentModel.kind,
        codeMode: document.getElementById('editor').classList.contains('code-mode'),
        tokenSpans: document.querySelectorAll('[class^="tzc-"]').length,
        renders: !!document.querySelector('#editor .block h2, #editor .block strong'),
    }));
    info(JSON.stringify(m));
    assert(m.kind === 'markdown', 'a .md file is still the markdown kind');
    assert(m.codeMode === false, 'and the editor does not carry code-mode');
    assert(m.tokenSpans === 0, 'no code tokens are painted into it');
    assert(m.renders === true, 'and it still renders as Markdown');
} finally {
    await md.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'CODE DOCUMENT FAILED' : 'CODE DOCUMENT PASSED');
process.exit(failed ? 1 : 0);
