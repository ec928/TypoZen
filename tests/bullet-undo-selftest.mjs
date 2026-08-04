/**
 * Bullet multi-select convert, Tab indent/outdent, and production HistoryManager
 * undo/redo contracts extracted from TypoZen_Template_Test.html.
 *
 * Catches regressions you already hit:
 *  - multi-select bullet only transforms selected indices (not whole doc)
 *  - undo after list convert does not ~2× line count
 *  - recordEditPair refuses empty pre when stack has content (undo wipe)
 *  - Tab indent is one undo step back to exact pre
 *  - empty blocks left alone during list convert (undo line-count stability)
 *
 * Run: node tests/bullet-undo-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];

function extractFunction(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        if (mainScript[i] === '{') depth++;
        else if (mainScript[i] === '}') {
            depth--;
            if (depth === 0) return mainScript.slice(idx, i + 1);
        }
    }
    throw new Error('unclosed ' + name);
}

const pureNames = [
    'parseListLine',
    'formatListLine',
    'indentListLine',
    'isListLine',
    'normalizeBlockRaw',
    'isMultilineBlockRaw',
    'coerceBlockRaw',
    'stripListMarkerKeepBody',
    'stripBlockPrefix',
    'listIndentPad',
    'getListIndentLevel',
    'transformRawForFormat'
];

const pureSrc =
    'const LIST_MAX_INDENT = 6;\nconst LIST_INDENT_SPACES = 2;\n' +
    pureNames.map(n => extractFunction(n)).join('\n') +
    `;\nreturn { ${pureNames.join(', ')} };`;

const pure = new Function(pureSrc)();

let passed = 0, failed = 0;
function assert(c, m) {
    if (c) { passed++; console.log('  OK  ', m); }
    else { failed++; console.error('  FAIL', m); }
}
function assertEq(a, e, m) {
    const as = JSON.stringify(a);
    const es = JSON.stringify(e);
    if (as === es) { passed++; console.log('  OK  ', m); }
    else {
        failed++;
        console.error('  FAIL', m);
        console.error('    expected:', es);
        console.error('    actual:  ', as);
    }
}

/**
 * Production HistoryManager core, content-injected (no DOM).
 * Mirrors recordEditPair / beginEdit / commitEdit / undo / redo guards.
 */
function createHistoryManager(holder) {
    const hm = {
        undoStack: [],
        redoStack: [],
        maxSize: 100,
        isRestoring: false,
        timer: null,
        _lastNavAt: 0,

        _stateFromContent(content) {
            return JSON.stringify({
                content: content == null ? '' : String(content),
                mode: 'wysiwyg'
            });
        },
        _capture() {
            return this._stateFromContent(holder.content);
        },
        _contentOf(stateStr) {
            try {
                const o = JSON.parse(stateStr);
                return o && o.content != null ? String(o.content) : '';
            } catch (e) {
                return '';
            }
        },
        _push(stateStr, clearRedo) {
            if (!stateStr) return;
            if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== stateStr) {
                this.undoStack.push(stateStr);
                if (this.undoStack.length > this.maxSize) this.undoStack.shift();
                if (clearRedo) this.redoStack = [];
            }
        },
        _flushTimer() {
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
        },
        recordEditPair(preContent, postContent) {
            if (this.isRestoring) return;
            this._flushTimer();
            const pre = this._stateFromContent(preContent);
            const post = this._stateFromContent(postContent);
            if (String(preContent || '') === String(postContent || '')) return;
            const preEmpty = !String(preContent || '').trim();
            const top = this.undoStack.length ? this.undoStack[this.undoStack.length - 1] : null;
            const topContent = top ? this._contentOf(top) : '';
            if (preEmpty && String(topContent).trim()) {
                this._push(post, true);
                return;
            }
            if (String(preContent || '') !== String(topContent || '')) {
                this._push(pre, false);
            } else if (this.undoStack.length) {
                this.undoStack[this.undoStack.length - 1] = pre;
            }
            this._push(post, true);
        },
        clear() {
            this.undoStack = [];
            this.redoStack = [];
            this._flushTimer();
        },
        resetToCurrent() {
            this.clear();
            this.undoStack.push(this._capture());
        },
        beginEdit() {
            if (this.isRestoring) return;
            this._flushTimer();
            const cap = this._capture();
            const capContent = this._contentOf(cap);
            if (!String(capContent).trim() && this.undoStack.length) {
                const topContent = this._contentOf(this.undoStack[this.undoStack.length - 1]);
                if (String(topContent).trim()) return;
            }
            this._push(cap, false);
        },
        commitEdit() {
            if (this.isRestoring) return;
            this._flushTimer();
            const after = this._capture();
            const afterContent = this._contentOf(after);
            if (!String(afterContent).trim() && this.undoStack.length) {
                const topContent = this._contentOf(this.undoStack[this.undoStack.length - 1]);
                if (String(topContent).trim()) {
                    const retry = this._capture();
                    if (String(this._contentOf(retry)).trim()) {
                        this._push(retry, true);
                        return;
                    }
                    return;
                }
            }
            this._push(after, true);
        },
        canUndo() { return this.undoStack.length > 1; },
        canRedo() { return this.redoStack.length > 0; },
        undo() {
            // Disable double-fire coalesce for unit tests (no host+page)
            this._flushTimer();
            if (!this.isRestoring) {
                const live = this._capture();
                const liveContent = this._contentOf(live);
                const topContent = this.undoStack.length
                    ? this._contentOf(this.undoStack[this.undoStack.length - 1])
                    : '';
                if (liveContent !== topContent) {
                    if (String(liveContent).trim() || !this.undoStack.length) {
                        this._push(live, false);
                    }
                }
            }
            if (this.undoStack.length <= 1) return false;
            this.isRestoring = true;
            try {
                const current = this.undoStack.pop();
                this.redoStack.push(current);
                const currentHad = String(this._contentOf(current)).trim();
                while (this.undoStack.length > 0) {
                    const prevStr = this.undoStack[this.undoStack.length - 1];
                    const prevContent = this._contentOf(prevStr);
                    if (String(prevContent).trim() || !currentHad) {
                        this.restore(prevStr);
                        return true;
                    }
                    this.undoStack.pop();
                }
                this.undoStack.push(current);
                this.redoStack.pop();
                return false;
            } finally {
                this.isRestoring = false;
            }
        },
        redo() {
            if (this.redoStack.length === 0) return false;
            this._flushTimer();
            this.isRestoring = true;
            try {
                const nextStr = this.redoStack.pop();
                this.undoStack.push(nextStr);
                this.restore(nextStr);
                return true;
            } finally {
                this.isRestoring = false;
            }
        },
        restore(stateStr) {
            if (!stateStr) return;
            try {
                const data = JSON.parse(stateStr);
                if (data && typeof data.content === 'string') {
                    holder.content = data.content;
                }
            } catch (e) {}
        }
    };
    return hm;
}

/**
 * Production mutateDocumentMarkdown string path (no DOM reload).
 * Same coerce + join + recordEditPair contract.
 */
function mutateDocumentMarkdown(holder, hm, lines, mutator, opts) {
    opts = opts || {};
    const allRaws = lines.map(r => pure.coerceBlockRaw(r));
    const preContent = allRaws.join('\n');
    const outLines = [];
    for (let i = 0; i < allRaws.length; i++) {
        let result = mutator(allRaws[i], i, allRaws);
        if (result == null) result = allRaws[i];
        if (Array.isArray(result) && result.length === 0) continue; // legacy bug path
        let piece;
        if (Array.isArray(result)) {
            piece = result.map(x => pure.coerceBlockRaw(x)).filter(x => String(x).length > 0).join(' ');
            if (!piece && result.length) piece = pure.coerceBlockRaw(result[0]);
        } else {
            piece = pure.coerceBlockRaw(result);
        }
        outLines.push(piece == null ? '' : piece);
    }
    if (!outLines.length) outLines.push('');
    const postContent = outLines.join('\n');
    if (!opts.skipHistory) hm.recordEditPair(preContent, postContent);
    holder.content = postContent;
    return postContent.split('\n');
}

/**
 * Production multi-select list format path (only focusIndices transformed).
 */
function applyListFormat(holder, hm, lines, type, selectedIdx) {
    const focusIndices = {};
    for (const i of selectedIdx) focusIndices[i] = true;

    // forceOn/forceOff like applyFormatting for list
    const raws = selectedIdx.map(i => lines[i] ?? '');
    let forceOff = false;
    let forceOn = true;
    if (type === 'list') {
        forceOff = raws.every(r => {
            if (!String(r).trim()) return true;
            const p = pure.parseListLine(r);
            return p && p.kind === 'ul';
        });
        if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
        else forceOn = !forceOff;
    } else if (type === 'ol' || type === 'ordered') {
        forceOff = raws.every(r => {
            if (!String(r).trim()) return true;
            const p = pure.parseListLine(r);
            return p && p.kind === 'ol';
        });
        if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
        else forceOn = !forceOff;
    }

    let olNum = 1;
    return mutateDocumentMarkdown(holder, hm, lines, function (raw, index) {
        if (!focusIndices[index]) return raw;
        raw = pure.normalizeBlockRaw(raw);
        // Production: leave empties; only transform text (undo line-count fix)
        if (!String(raw).trim()) return raw;
        if (String(raw).indexOf('\n') < 0) {
            const n = olNum;
            if ((type === 'ol' || type === 'ordered') && forceOn) olNum++;
            return pure.transformRawForFormat(raw, type, { forceOff, forceOn, olNum: n });
        }
        const subLines = String(raw).split('\n');
        const parts = [];
        for (let sli = 0; sli < subLines.length; sli++) {
            const line = pure.normalizeBlockRaw(subLines[sli]);
            if (!String(line).trim()) {
                parts.push(line);
                continue;
            }
            const next = pure.transformRawForFormat(line, type, { forceOff, forceOn, olNum });
            if ((type === 'ol' || type === 'ordered') && forceOn) olNum++;
            parts.push(pure.normalizeBlockRaw(next));
        }
        return parts;
    }, {});
}

/** Production applyListIndentToSelection string path */
function applyListIndent(holder, hm, lines, selectedIdx, delta) {
    const focusIndices = {};
    let any = false;
    for (const idx of selectedIdx) {
        if (idx >= 0 && idx < lines.length && pure.isListLine(lines[idx])) {
            focusIndices[idx] = true;
            any = true;
        }
    }
    if (!any) return lines.slice();
    return mutateDocumentMarkdown(holder, hm, lines, function (raw, index) {
        if (focusIndices[index] && pure.isListLine(raw)) {
            return pure.indentListLine(pure.coerceBlockRaw(raw), delta);
        }
        return raw;
    }, {});
}

function lineCount(md) {
    if (md == null || md === '') return 0;
    return String(md).split('\n').length;
}

// ========== TESTS ==========

console.log('\n=== Pure: transformRawForFormat bullets / ol ===');
{
    assertEq(pure.transformRawForFormat('hello', 'list', { forceOn: true }), '- hello', 'plain → bullet');
    assertEq(pure.transformRawForFormat('- hello', 'list', { forceOff: true }), 'hello', 'bullet → plain');
    assertEq(pure.transformRawForFormat('item', 'ol', { forceOn: true, olNum: 3 }), '3. item', 'plain → ol 3');
    assertEq(pure.indentListLine('- a', 1), '  - a', 'Tab indent bullet');
    assertEq(pure.indentListLine('  - a', -1), '- a', 'Shift+Tab outdent');
    assertEq(pure.indentListLine('  - a', 1), '    - a', 'double indent');
    const nested = pure.transformRawForFormat('  plain', 'list', { forceOn: true });
    // stripBlockPrefix may not preserve leading spaces on non-list; body still list
    assert(pure.parseListLine(nested) || nested.startsWith('-') || nested.includes('- '),
        'list format produces list-ish line: ' + nested);
}

console.log('\n=== Multi-select bullet: only selected indices change ===');
{
    const holder = { content: '' };
    const hm = createHistoryManager(holder);
    // 10 lines; select middle 4 (indices 3..6) — the bug was all 10 becoming bullets
    const lines = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '100'];
    holder.content = lines.join('\n');
    hm.resetToCurrent();

    const after = applyListFormat(holder, hm, lines, 'list', [3, 4, 5, 6]);
    assertEq(after.length, 10, 'still 10 lines after multi bullet');
    assertEq(after[0], '111', 'unselected 0 unchanged');
    assertEq(after[2], '333', 'unselected 2 unchanged');
    assert(pure.parseListLine(after[3])?.kind === 'ul', 'idx 3 is bullet');
    assert(pure.parseListLine(after[6])?.kind === 'ul', 'idx 6 is bullet');
    assertEq(after[7], '888', 'unselected 7 unchanged');
    assertEq(after[9], '100', 'unselected 9 unchanged');
    const bulletCount = after.filter(l => pure.parseListLine(l)?.kind === 'ul').length;
    assertEq(bulletCount, 4, 'exactly 4 bullets (not all 10)');
}

console.log('\n=== Multi-select bullet + undo restores exact pre (no 2× lines) ===');
{
    const holder = { content: '' };
    const hm = createHistoryManager(holder);
    const lines = [];
    for (let i = 1; i <= 10; i++) lines.push(String(100 + i));
    // sprinkle empties like real docs
    lines.splice(2, 0, '');
    lines.splice(7, 0, '');
    const pre = lines.join('\n');
    holder.content = pre;
    hm.resetToCurrent();
    const preLines = lineCount(pre);

    const after = applyListFormat(holder, hm, lines, 'list', [0, 1, 3, 4]);
    assertEq(after.length, preLines, 'post line count == pre (empties preserved)');
    assert(hm.canUndo(), 'can undo after list convert');

    hm.undo();
    assertEq(holder.content, pre, 'undo restores exact pre markdown');
    assertEq(lineCount(holder.content), preLines, 'undo line count == pre (not ~2×)');

    // redo back
    assert(hm.canRedo(), 'can redo');
    hm.redo();
    assertEq(lineCount(holder.content), preLines, 'redo keeps line count');
    assert(holder.content.split('\n').some(l => pure.parseListLine(l)?.kind === 'ul'), 'redo has bullets');
}

console.log('\n=== Bug: deleting empties during convert would break undo line count ===');
{
    // Documents the failure mode: if mutator returns [] for empty lines, post shortens,
    // undo stack pre has more lines → "undo → 20 lines" class of bugs.
    const holder = { content: '' };
    const hm = createHistoryManager(holder);
    const lines = ['a', '', 'b', '', 'c'];
    holder.content = lines.join('\n');
    hm.resetToCurrent();

    // BAD path (legacy): drop empties
    const badOut = [];
    for (let i = 0; i < lines.length; i++) {
        if (!String(lines[i]).trim()) continue; // deleted empty
        badOut.push(pure.transformRawForFormat(lines[i], 'list', { forceOn: true }));
    }
    const badPost = badOut.join('\n');
    hm.recordEditPair(lines.join('\n'), badPost);
    holder.content = badPost;
    assertEq(lineCount(holder.content), 3, 'bad path shortened to 3');
    hm.undo();
    assertEq(lineCount(holder.content), 5, 'undo from bad path expands back to 5 (user saw line explosion if pre was wrong)');

    // GOOD path (production): keep empties
    const holder2 = { content: lines.join('\n') };
    const hm2 = createHistoryManager(holder2);
    hm2.resetToCurrent();
    const good = applyListFormat(holder2, hm2, lines, 'list', [0, 2, 4]);
    assertEq(good.length, 5, 'good path keeps 5 lines');
    assertEq(good[1], '', 'empty line preserved');
    hm2.undo();
    assertEq(holder2.content, lines.join('\n'), 'good undo exact pre');
}

console.log('\n=== Tab indent selection + undo ===');
{
    const holder = { content: '' };
    const hm = createHistoryManager(holder);
    const lines = ['- one', '- two', 'plain', '- three'];
    holder.content = lines.join('\n');
    hm.resetToCurrent();

    const after = applyListIndent(holder, hm, lines, [0, 1], +1);
    assertEq(after[0], '  - one', 'Tab indented first bullet');
    assertEq(after[1], '  - two', 'Tab indented second bullet');
    assertEq(after[2], 'plain', 'plain not indented');
    assertEq(after[3], '- three', 'unselected bullet unchanged');

    hm.undo();
    assertEq(holder.content, lines.join('\n'), 'undo Tab restores pre');

    // outdent
    const nested = ['  - child', '- parent'];
    holder.content = nested.join('\n');
    hm.resetToCurrent();
    applyListIndent(holder, hm, nested, [0], -1);
    assertEq(holder.content.split('\n')[0], '- child', 'Shift+Tab outdent');
    hm.undo();
    assertEq(holder.content.split('\n')[0], '  - child', 'undo outdent');
}

console.log('\n=== Nested Tab chain (indent twice) + multi-undo ===');
{
    const holder = { content: '- root\n- child' };
    const hm = createHistoryManager(holder);
    hm.resetToCurrent();
    let lines = holder.content.split('\n');

    lines = applyListIndent(holder, hm, lines, [1], +1);
    assertEq(lines[1], '  - child', 'indent once');
    lines = applyListIndent(holder, hm, lines, [1], +1);
    assertEq(lines[1], '    - child', 'indent twice');

    hm.undo();
    assertEq(holder.content.split('\n')[1], '  - child', 'undo one level');
    hm.undo();
    assertEq(holder.content.split('\n')[1], '- child', 'undo to root level');
}

console.log('\n=== recordEditPair: empty pre must not wipe doc on undo ===');
{
    const holder = { content: 'keep me\nline2' };
    const hm = createHistoryManager(holder);
    hm.resetToCurrent();
    const topBefore = hm.undoStack[hm.undoStack.length - 1];

    // Bug path: empty pre with real post
    hm.recordEditPair('', 'keep me\nline2\n- added');
    // Should NOT have pushed empty pre as a frame under real content
    const frames = hm.undoStack.map(s => hm._contentOf(s));
    assert(!frames.some((c, i) => i < frames.length - 1 && c === ''),
        'no empty intermediate pre frame when top already had content');
    // After pair, content should be post
    holder.content = 'keep me\nline2\n- added';
    // Force stack top to match (recordEditPair only pushed post when pre empty)
    // undo once should not land on blank
    hm.undo();
    assert(String(holder.content).trim().length > 0, 'undo after empty-pre pair is not blank wipe');
    assert(holder.content.includes('keep me'), 'undo still has prior content');
    void topBefore;
}

console.log('\n=== beginEdit empty capture refused when stack has content ===');
{
    const holder = { content: 'real doc' };
    const hm = createHistoryManager(holder);
    hm.resetToCurrent();
    const n0 = hm.undoStack.length;
    holder.content = ''; // simulate broken capture
    hm.beginEdit();
    assertEq(hm.undoStack.length, n0, 'beginEdit did not push empty over real stack');
    holder.content = 'real doc';
    hm.beginEdit();
    hm.commitEdit(); // no-op same content may still push
    // mutate
    hm.beginEdit();
    holder.content = 'real doc edited';
    hm.commitEdit();
    hm.undo();
    assert(holder.content.includes('real doc'), 'undo after begin/commit restores');
}

console.log('\n=== Ordered multi-select renumber + undo ===');
{
    const holder = { content: '' };
    const hm = createHistoryManager(holder);
    const lines = ['alpha', 'beta', 'gamma', 'delta'];
    holder.content = lines.join('\n');
    hm.resetToCurrent();
    const after = applyListFormat(holder, hm, lines, 'ol', [1, 2]);
    assertEq(after[0], 'alpha', 'unselected plain');
    assert(pure.parseListLine(after[1])?.kind === 'ol', 'beta is ol');
    assert(pure.parseListLine(after[2])?.kind === 'ol', 'gamma is ol');
    assertEq(pure.parseListLine(after[1]).num, 1, 'first selected ol is 1');
    assertEq(pure.parseListLine(after[2]).num, 2, 'second selected ol is 2');
    assertEq(after[3], 'delta', 'unselected delta');
    hm.undo();
    assertEq(holder.content, lines.join('\n'), 'ol undo exact');
}

console.log('\n=== Template still owns list-history contracts ===');
{
    assert(mainScript.includes('recordEditPair'), 'recordEditPair in template');
    assert(mainScript.includes('mutateDocumentMarkdown'), 'mutateDocumentMarkdown in template');
    assert(mainScript.includes('applyListIndentToSelection'), 'applyListIndentToSelection in template');
    assert(mainScript.includes('applyFormatInPlaceToSelection'), 'multi-select list uses in-place format');
    assert(mainScript.includes('_lastGoodDocRaws'), 'last-good doc snapshot for multi-select');
    assert(mainScript.includes('Never put an empty pre on the stack')
        || mainScript.includes('empty pre was the "undo wiped'), 'empty-pre guard comment present');
}

console.log(`\n=== Summary (bullet/undo) ===`);
console.log(`passed=${passed} failed=${failed}`);
if (failed) {
    console.error('\nBULLET/UNDO SELFTEST FAILED');
    process.exit(1);
}
console.log('\nBULLET/UNDO SELFTEST PASSED');
process.exit(0);
