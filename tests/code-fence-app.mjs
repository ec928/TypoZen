/**
 * Fenced code is painted, and painting it changes nothing.
 *
 * The second half is the point. A previous attempt highlighted code by wrapping
 * tokens in <span>s inside a .block; Markdown's own DOM repair then split those
 * spans into separate lines and one keystroke turned a 9-line file into 17. See
 * docs/developer-editor-analysis.md.
 *
 * Highlight ranges are not DOM, so that cannot happen here -- and this suite is what
 * says so out loud rather than trusting the argument. It compares the serialised
 * document before and after painting, and again after typing next to a fence.
 *
 *   RUN_APP_E2E=1 node tests/code-fence-app.mjs
 */
import { launchApp, sleep } from './app-harness.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}
function info(msg) { console.log('  ..   ' + msg); }

const DOC = [
    '# Fences',
    '',
    'Some prose before the code.',
    '',
    '```json',
    '{ "name": "typozen", "version": 2, "ok": true }',
    '```',
    '',
    'Prose between.',
    '',
    '```cs',
    'public class Demo {',
    '    // a comment',
    '    var s = "hello";',
    '}',
    '```',
    '',
    '```',
    'no language here',
    '```',
    ''
].join('\n');

const app = await launchApp({ file: 'tests/large-scroll-mixed.md', settleMs: 7000, view: true });
try {
    await app.eval((text) => loadMarkdownContent(text, { replaceBook: true }), DOC);
    await sleep(2000);

    const painted = await app.eval(() => {
        const before = DocumentModel.toMarkdown();
        const n = paintCodeFences();
        const names = ['keyword', 'string', 'comment', 'number', 'type', 'fn', 'tag', 'attr'];
        const sizes = {};
        for (const c of names) {
            const h = CSS.highlights.get('tzcode-' + c);
            if (h && h.size) sizes[c] = h.size;
        }
        return {
            fences: n,
            sizes,
            docUnchanged: DocumentModel.toMarkdown() === before,
            injected: document.querySelectorAll('#editor .block span[class^="tzc"]').length,
            fenceEls: document.querySelectorAll('#editor .block pre > code').length,
        };
    });

    console.log('=== it paints ===');
    info('fences painted: ' + painted.fences + ' of ' + painted.fenceEls + ' rendered');
    info('ranges by class: ' + JSON.stringify(painted.sizes));
    assert(painted.fenceEls >= 3, 'control: the document rendered its fences');
    assert(painted.fences === 2,
        'the two fences with a known language are painted, the bare one is not');
    assert(Object.keys(painted.sizes).length >= 3,
        'several token classes have ranges (' + Object.keys(painted.sizes).join(', ') + ')');
    assert((painted.sizes.string || 0) > 0 && (painted.sizes.comment || 0) > 0,
        'strings and comments among them');

    console.log('\n=== and painting is not editing ===');
    assert(painted.injected === 0, 'no elements were injected into any block');
    assert(painted.docUnchanged, 'the document is byte-identical after painting');

    console.log('\n=== typing beside a fence leaves it a fence ===');
    const typed = await app.eval(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const before = DocumentModel.toMarkdown();
        const blocks = [...document.querySelectorAll('#editor .block[data-model-index]')];
        const prose = blocks.find(b => /Prose between/.test(b.textContent || ''));
        const r = document.createRange();
        r.setStart(prose.firstChild.firstChild || prose.firstChild, 5);
        r.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        prose.focus();
        await sleep(300);
        return { before, blocks: DocumentModel.blocks.length };
    });
    await app.page.bringToFront().catch(() => {});
    await app.page.keyboard.type('XY', { delay: 50 });
    await sleep(1200);

    const after = await app.eval((before) => {
        paintCodeFences();
        const now = DocumentModel.toMarkdown();
        return {
            blocks: DocumentModel.blocks.length,
            delta: now.length - before.length,
            fencesIntact: (now.match(/```/g) || []).length,
            restores: now.replace('XY', '') === before,
            injected: document.querySelectorAll('#editor .block span[class^="tzc"]').length,
        };
    }, typed.before);
    info('blocks ' + typed.blocks + ' -> ' + after.blocks + ', delta ' + after.delta +
         ', ``` markers ' + after.fencesIntact);
    assert(after.blocks === typed.blocks, 'the block count is unchanged');
    assert(after.delta === 2, 'the document grew by exactly what was typed');
    assert(after.fencesIntact === 6, 'all three fences still have both markers');
    assert(after.restores, 'removing the typed characters gives the document back');
    assert(after.injected === 0, 'and still nothing was injected');
} finally {
    await app.close();
}

console.log('\npassed=' + passed + ' failed=' + failed);
console.log(failed ? 'CODE FENCE FAILED' : 'CODE FENCE PASSED');
process.exit(failed ? 1 : 0);
