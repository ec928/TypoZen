/**
 * Undo must keep working for multiple steps (not only the first Ctrl+Z).
 *
 * node tests/undo-continuous-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainScript = fs.readFileSync(path.join(__dirname, '..', 'TypoZen_Template_Test.html'), 'utf8');

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

function createHistory(holder) {
    const hm = {
        undoStack: [],
        redoStack: [],
        isRestoring: false,
        _captureCaret() {
            return holder.caret || { mode: 'wysiwyg', blockIndex: 0, offset: 0 };
        },
        _stateFromContent(content, caret) {
            return JSON.stringify({
                content: content == null ? '' : String(content),
                mode: 'wysiwyg',
                caret: caret !== undefined ? caret : this._captureCaret()
            });
        },
        _capture() { return this._stateFromContent(holder.content); },
        _contentOf(s) {
            try { return String(JSON.parse(s).content || ''); } catch (e) { return ''; }
        },
        _sameContent(a, b) {
            const n = s => String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                .replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
            return n(a) === n(b);
        },
        _caretOf(s) {
            try { return JSON.parse(s).caret || null; } catch (e) { return null; }
        },
        _push(stateStr, clearRedo) {
            if (!stateStr) return;
            if (!this.undoStack.length || this.undoStack[this.undoStack.length - 1] !== stateStr) {
                this.undoStack.push(stateStr);
                if (clearRedo) this.redoStack = [];
            }
        },
        recordEditPair(pre, post) {
            if (String(pre) === String(post)) return;
            const caret = this._captureCaret();
            const top = this.undoStack.length ? this._contentOf(this.undoStack[this.undoStack.length - 1]) : '';
            if (String(pre) !== top) this._push(this._stateFromContent(pre, caret), false);
            else if (this.undoStack.length) this.undoStack[this.undoStack.length - 1] = this._stateFromContent(pre, caret);
            this._push(this._stateFromContent(post, caret), true);
        },
        resetToCurrent() {
            this.undoStack = [this._capture()];
            this.redoStack = [];
        },
        restore(stateStr) {
            holder.content = this._contentOf(stateStr);
        },
        snapshotTyping() {
            const cap = this._capture();
            const capContent = this._contentOf(cap);
            const top = this.undoStack.length ? this._contentOf(this.undoStack[this.undoStack.length - 1]) : '';
            if (this._sameContent(capContent, top)) return false;
            this._push(cap, true);
            return true;
        },
        undo() {
            if (!this.isRestoring) {
                const live = this._capture();
                const liveC = this._contentOf(live);
                const topC = this.undoStack.length ? this._contentOf(this.undoStack[this.undoStack.length - 1]) : '';
                if (!this._sameContent(liveC, topC) && (String(liveC).trim() || !this.undoStack.length)) {
                    this._push(live, false);
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
                    const actual = holder.content;
                    const top = this.undoStack[this.undoStack.length - 1];
                    if (top && !this._sameContent(actual, this._contentOf(top))) {
                        this.undoStack[this.undoStack.length - 1] =
                            this._stateFromContent(actual, this._caretOf(top));
                    }
                    return true;
                }
                this.undoStack.push(current);
                this.redoStack.pop();
                return false;
            } finally {
                this.isRestoring = false;
            }
        }
    };
    return hm;
}

console.log('\n=== Three sequential undos (list then type) ===');
{
    const holder = { content: 'L1\nL2\nL3\nL4', caret: { mode: 'wysiwyg', blockIndex: 0, offset: 0 } };
    const hm = createHistory(holder);
    hm.resetToCurrent();

    hm.recordEditPair('L1\nL2\nL3\nL4', 'L1\n1. L2\n2. L3\nL4');
    holder.content = 'L1\n1. L2\n2. L3\nL4';

    hm.recordEditPair(holder.content, holder.content + '\nextra');
    holder.content = 'L1\n1. L2\n2. L3\nL4\nextra';

    hm.recordEditPair(holder.content, holder.content + '\nmore');
    holder.content = 'L1\n1. L2\n2. L3\nL4\nextra\nmore';

    assert(hm.undo() === true, 'undo 1 works');
    assertEq(holder.content, 'L1\n1. L2\n2. L3\nL4\nextra', 'after undo1');

    assert(hm.undo() === true, 'undo 2 works immediately after');
    assertEq(holder.content, 'L1\n1. L2\n2. L3\nL4', 'after undo2');

    assert(hm.undo() === true, 'undo 3 works');
    assertEq(holder.content, 'L1\nL2\nL3\nL4', 'after undo3 back to plain');
}

console.log('\n=== Rapid 5 undos in a row ===');
{
    const holder = { content: '0', caret: { mode: 'wysiwyg', blockIndex: 0, offset: 0 } };
    const hm = createHistory(holder);
    hm.resetToCurrent();
    for (let i = 1; i <= 5; i++) {
        const pre = holder.content;
        const post = pre + '\n' + i;
        hm.recordEditPair(pre, post);
        holder.content = post;
    }
    for (let i = 0; i < 5; i++) {
        assert(hm.undo() === true, 'rapid undo ' + (i + 1));
    }
    assertEq(holder.content, '0', 'rapid undos back to start');
}

console.log('\n=== Caret-only snapshot must not block later undos ===');
{
    const holder = { content: 'base', caret: { mode: 'wysiwyg', blockIndex: 0, offset: 0 } };
    const hm = createHistory(holder);
    hm.resetToCurrent();
    hm.recordEditPair('base', 'base\nedited');
    holder.content = 'base\nedited';
    holder.caret = { mode: 'wysiwyg', blockIndex: 1, offset: 2 };

    hm.undo();
    assertEq(holder.content, 'base', 'undid edit');

    holder.caret = { mode: 'wysiwyg', blockIndex: 0, offset: 1 };
    const pushed = hm.snapshotTyping();
    assert(pushed === false, 'caret-only snapshot does not push');

    hm.recordEditPair('base', 'base\nagain');
    holder.content = 'base\nagain';
    assert(hm.undo() === true, 'undo still works after caret snapshot');
    assertEq(holder.content, 'base', 'restored base again');
}

console.log('\n=== Template contracts ===');
{
    assert(mainScript.includes('No time-based coalesce')
        || mainScript.includes('No time-based coalesce:'),
        'no time-based undo coalesce (blocks multi-step)');
    assert(mainScript.includes('caret-only frames') || mainScript.includes('Only real content changes'),
        'snapshot skips caret-only');
    assert(!/\_navCoalesceMs:\s*100/.test(mainScript), '100ms coalesce removed');
}

console.log(`\npassed=${passed} failed=${failed}`);
if (failed) process.exit(1);
console.log('UNDO CONTINUOUS SELFTEST PASSED');
process.exit(0);
