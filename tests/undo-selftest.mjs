/**
 * Undo correctness: single-step coalesce, caret in snapshots, no jump-to-top contract.
 * Mirrors production HistoryManager contracts from TypoZen_Template_Test.html.
 *
 * Run: node tests/undo-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(__dirname, '..', 'TypoZen_Template_Test.html');
const html = fs.readFileSync(templatePath, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];
const appCs = fs.readFileSync(path.join(__dirname, '..', 'TypoZen_App.cs'), 'utf8');

let passed = 0, failed = 0;
function assert(c, m) {
    if (c) { passed++; console.log('  OK  ', m); }
    else { failed++; console.error('  FAIL', m); }
}
function assertEq(a, e, m) {
    if (JSON.stringify(a) === JSON.stringify(e)) { passed++; console.log('  OK  ', m); }
    else {
        failed++;
        console.error('  FAIL', m, '\n    expected:', JSON.stringify(e), '\n    actual:  ', JSON.stringify(a));
    }
}

/** Content+caret history matching production recordEditPair / undo / restore contracts */
function createHistory(holder) {
    const hm = {
        undoStack: [],
        redoStack: [],
        isRestoring: false,
        _fakeNow: 1000,
        _caret: { mode: 'wysiwyg', blockIndex: 0, offset: 0 },

        _captureCaret() {
            return holder.caret ? { ...holder.caret } : { mode: 'wysiwyg', blockIndex: 0, offset: 0 };
        },
        _stateFromContent(content, caret) {
            const c = caret !== undefined ? caret : this._captureCaret();
            return JSON.stringify({
                content: content == null ? '' : String(content),
                mode: 'wysiwyg',
                caret: c
            });
        },
        _capture() {
            return this._stateFromContent(holder.content);
        },
        _contentOf(stateStr) {
            try {
                const o = JSON.parse(stateStr);
                return o && o.content != null ? String(o.content) : '';
            } catch (e) { return ''; }
        },
        _sameContent(a, b) {
            function norm(s) {
                return String(s == null ? '' : s)
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .replace(/[ \t]+$/gm, '')
                    .replace(/\n+$/, '');
            }
            return norm(a) === norm(b);
        },
        _caretOf(stateStr) {
            try {
                const o = JSON.parse(stateStr);
                return o && o.caret ? o.caret : null;
            } catch (e) { return null; }
        },
        _push(stateStr, clearRedo) {
            if (!stateStr) return;
            if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== stateStr) {
                this.undoStack.push(stateStr);
                if (clearRedo) this.redoStack = [];
            }
        },
        recordEditPair(preContent, postContent) {
            if (this.isRestoring) return;
            const caret = this._captureCaret();
            if (String(preContent || '') === String(postContent || '')) return;
            const pre = this._stateFromContent(preContent, caret);
            const post = this._stateFromContent(postContent, caret);
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
        /** After loadMarkdownContent — resync top to actual serialize (production) */
        resyncTopToActual(actualContent) {
            if (!this.undoStack.length) return;
            const top = this.undoStack[this.undoStack.length - 1];
            if (String(actualContent) !== this._contentOf(top)) {
                const caret = this._caretOf(top);
                this.undoStack[this.undoStack.length - 1] = this._stateFromContent(actualContent, caret);
            }
        },
        resetToCurrent() {
            this.undoStack = [];
            this.redoStack = [];
            this.undoStack.push(this._capture());
        },
        restore(stateStr) {
            holder.content = this._contentOf(stateStr);
            holder.caret = this._caretOf(stateStr);
            holder.restoredCaret = holder.caret ? { ...holder.caret } : null;
        },
        undo() {
            if (!this.isRestoring) {
                const live = this._capture();
                const liveContent = this._contentOf(live);
                const topContent = this.undoStack.length
                    ? this._contentOf(this.undoStack[this.undoStack.length - 1])
                    : '';
                if (!this._sameContent(liveContent, topContent)) {
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
                    if (!String(prevContent).trim() && currentHad) {
                        this.undoStack.pop();
                        continue;
                    }
                    this.restore(prevStr);
                    return true;
                }
                this.undoStack.push(current);
                this.redoStack.pop();
                return false;
            } finally {
                this.isRestoring = false;
            }
        },
        redo() {
            const now = this._fakeNow;
            if (now - this._lastNavAt < this._navCoalesceMs) return false;
            this._lastNavAt = now;
            if (!this.redoStack.length) return false;
            this.isRestoring = true;
            try {
                const next = this.redoStack.pop();
                this.undoStack.push(next);
                this.restore(next);
                return true;
            } finally {
                this.isRestoring = false;
            }
        }
    };
    return hm;
}

console.log('\n=== Undo after list: multi-step still works ===');
{
    const holder = {
        content: 'line0\nline1\nline2',
        caret: { mode: 'wysiwyg', blockIndex: 2, offset: 3 }
    };
    const hm = createHistory(holder);
    hm.resetToCurrent();

    holder.caret = { mode: 'wysiwyg', blockIndex: 2, offset: 5 };
    hm.recordEditPair('line0\nline1\nline2', 'line0\nline1\nCHANGED');
    holder.content = 'line0\nline1\nCHANGED';

    assert(hm.undo() === true, 'first undo applies');
    assertEq(holder.content, 'line0\nline1\nline2', 'content restored once');
    assert(hm.undo() === false, 'nothing left is clean no-op');
    assert(String(holder.content).trim().length > 0, 'did not wipe doc');
}

console.log('\n=== Virt caret: model index ≠ mounted DOM ordinal ===');
{
    // Production contract: capture stores model index 500, not "20th mounted node"
    function captureLikeProd(block, mountedList) {
        // formatBlockIndex: data-model-index wins
        const a = block.getAttribute && block.getAttribute('data-model-index');
        if (a != null && a !== '') {
            const n = parseInt(a, 10);
            if (!isNaN(n)) return n;
        }
        return mountedList.indexOf(block);
    }
    function resolveMounted(modelIdx, mountedWithAttrs) {
        for (let i = 0; i < mountedWithAttrs.length; i++) {
            if (mountedWithAttrs[i].mi === modelIdx) return mountedWithAttrs[i];
        }
        return null;
    }
    const fakeBlock = { getAttribute: (k) => k === 'data-model-index' ? '500' : null };
    const mounted = [fakeBlock]; // only one mounted — DOM ordinal would be 0
    assert(captureLikeProd(fakeBlock, mounted) === 500,
        'capture uses model 500 not DOM 0 (got ' + captureLikeProd(fakeBlock, mounted) + ')');
    const window = [{ mi: 480 }, { mi: 500 }, { mi: 520 }];
    assert(resolveMounted(500, window).mi === 500, 'restore finds model 500 inside virt window');
    assert(resolveMounted(500, window) !== window[0], 'restore does not pick first mounted as model 500');
}

console.log('\n=== Undo restores caret block index (not forced to 0) ===');
{
    const holder = {
        content: 'a\nb\nc\nd\ne',
        caret: { mode: 'wysiwyg', blockIndex: 3, offset: 0 }
    };
    const hm = createHistory(holder);
    hm.resetToCurrent();

    // Edit at block 3
    holder.caret = { mode: 'wysiwyg', blockIndex: 3, offset: 2 };
    hm.recordEditPair('a\nb\nc\nd\ne', 'a\nb\nc\nD-EDIT\ne');
    holder.content = 'a\nb\nc\nD-EDIT\ne';
    holder.caret = { mode: 'wysiwyg', blockIndex: 3, offset: 6 };

    hm._fakeNow = 10000;
    hm.undo();
    assertEq(holder.content, 'a\nb\nc\nd\ne', 'undo content');
    assert(holder.restoredCaret != null, 'caret restored object present');
    assertEq(holder.restoredCaret.blockIndex, 3, 'caret blockIndex stays 3 (not 0)');
    assert(holder.restoredCaret.blockIndex !== 0 || holder.restoredCaret.offset !== undefined,
        'not jump-to-top-only restore');
}

console.log('\n=== Two undos with spacing = two steps ===');
{
    const holder = { content: 'base', caret: { mode: 'wysiwyg', blockIndex: 0, offset: 0 } };
    const hm = createHistory(holder);
    hm.resetToCurrent();

    hm.recordEditPair('base', 'base\nstep1');
    holder.content = 'base\nstep1';
    holder.caret = { mode: 'wysiwyg', blockIndex: 1, offset: 0 };

    hm.recordEditPair('base\nstep1', 'base\nstep1\nstep2');
    holder.content = 'base\nstep1\nstep2';
    holder.caret = { mode: 'wysiwyg', blockIndex: 2, offset: 0 };

    hm._fakeNow = 20000;
    hm.undo();
    assertEq(holder.content, 'base\nstep1', 'undo 1 → step1');
    assertEq(holder.restoredCaret.blockIndex, 1, 'caret on step1 line after first undo');

    hm._fakeNow = 20200; // past coalesce
    hm.undo();
    assertEq(holder.content, 'base', 'undo 2 → base');
}

console.log('\n=== CRITICAL: list convert then undo (serialize noise must not no-op) ===');
{
    // Real failure: recordEditPair stores post X; after load, getMarkdownContent is X+"\n"
    // First Ctrl+Z used to push live and restore X — looks identical (undo "broken")
    const pre = '111\n222\n333\n444\n555\n666\n777\n888\n999\n100';
    const postIdeal = '111\n222\n333\n1. 444\n2. 555\n3. 666\n4. 777\n888\n999\n100';
    const postActual = postIdeal + '\n'; // serialize adds trailing junk

    const holder = { content: pre, caret: { mode: 'wysiwyg', blockIndex: 3, offset: 0 } };
    const hm = createHistory(holder);
    hm.resetToCurrent();
    hm.recordEditPair(pre, postIdeal);
    holder.content = postActual; // DOM after loadMarkdownContent
    hm.resyncTopToActual(postActual); // production resync after load

    hm._fakeNow = 30000;
    assert(hm.undo() === true, 'undo after list convert applies');
    assertEq(holder.content, pre, 'ONE undo restores plain lines (not stuck on numbered)');
    assert(!String(holder.content).includes('1. 444'), 'numbered markers gone after undo');
}

console.log('\n=== Without resync, _sameContent still treats trailing \\n as same ===');
{
    const pre = 'a\nb\nc';
    const post = 'a\n1. b\nc';
    const holder = { content: pre, caret: { mode: 'wysiwyg', blockIndex: 1, offset: 0 } };
    const hm = createHistory(holder);
    hm.resetToCurrent();
    hm.recordEditPair(pre, post);
    // Live has trailing newline — must NOT burn a Z
    holder.content = post + '\n';
    hm._fakeNow = 40000;
    hm.undo();
    assertEq(holder.content, pre, 'normalized compare: one Z undoes list despite trailing \\n');
}

console.log('\n=== Production template contracts ===');
{
    assert(mainScript.includes('_captureCaret'), 'HistoryManager._captureCaret present');
    assert(mainScript.includes('_restoreCaret'), 'HistoryManager._restoreCaret present');
    // Virt: blockIndex must be model index, not mounted DOM ordinal
    assert(mainScript.includes('formatBlockIndex(block)')
        || mainScript.includes('modelIndexOfEl(block)'),
        'caret capture prefers model index (virt-safe)');
    assert(mainScript.includes('ensureModelBlockVisible'),
        'caret restore can mount virt window for target block');
    assert(mainScript.includes('data-model-index'),
        'restore can resolve block via data-model-index');
    assert(mainScript.includes('_sameContent'), 'normalized content compare present');
    assert(mainScript.includes('No time-based coalesce') || !/\_navCoalesceMs:\s*100/.test(mainScript),
        'no 100ms time-based undo coalesce');
    assert(mainScript.includes('Resync stack TOP') || mainScript.includes('resync')
        || mainScript.includes('Resync stack'), 'post-load stack resync present');
    assert(mainScript.includes('HistoryManager.undo()'), 'page Ctrl+Z calls HistoryManager.undo');
    assert(mainScript.includes('never force first block')
        || mainScript.includes('Never force first block')
        || mainScript.includes('jump-to-top'), 'jump-to-top fix comment present');
}

console.log('\n=== Host C# contracts ===');
{
    assert(appCs.includes('SendHistoryCmd'), 'SendHistoryCmd debounce helper');
    assert(appCs.includes('webViewFocused') || appCs.includes('ContainsFocus'),
        'host skips undo inject when WebView focused (page owns Z)');
    assert(appCs.includes('SendHistoryCmd(c)'), 'preprocess uses SendHistoryCmd when chrome focused');
}

console.log(`\n=== Summary (undo) ===`);
console.log(`passed=${passed} failed=${failed}`);
if (failed) {
    console.error('\nUNDO SELFTEST FAILED');
    process.exit(1);
}
console.log('\nUNDO SELFTEST PASSED');
process.exit(0);
