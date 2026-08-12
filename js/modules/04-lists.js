// TypoZen module: 04-lists.js
// Classic script; shares page globals. Load order: js/modules/load-order.json.

// TypoZen module: 04-lists-format.js
// Lines 4155-8240 of the former monolith. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.

        // --- List engine (pure) — nested lists via leading spaces (2 per level), max 6 ---
        const LIST_MAX_INDENT = 6;
        const LIST_INDENT_SPACES = 2;

        /**
         * Parse one markdown list line (optional leading spaces/tabs).
         * @returns {{ indent:number, kind:'ul'|'ol'|'task', bullet?:string, num?:number, checked?:boolean, body:string, raw:string }|null}
         */
        function parseListLine(raw) {
            raw = String(raw == null ? '' : raw);
            // One block = one list line. Reject multi-line blobs (would break render/format).
            if (raw.indexOf('\n') >= 0 || raw.indexOf('\r') >= 0) {
                const first = raw.split(/\r?\n/, 1)[0];
                // Only auto-parse first line if the rest is empty; else not a single list line
                const restLines = raw.split(/\r?\n/).slice(1);
                if (restLines.some(function (l) { return String(l).length > 0; })) return null;
                raw = first;
            }
            const mLead = raw.match(/^([ \t]*)/);
            let lead = mLead ? mLead[1] : '';
            lead = lead.replace(/\t/g, '  ');
            const indent = Math.min(LIST_MAX_INDENT, Math.floor(lead.length / LIST_INDENT_SPACES));
            const rest = raw.slice(mLead ? mLead[0].length : 0);

            let m = rest.match(/^[-*+]\s+\[([ xX])\]\s?(.*)$/);
            if (m) {
                return {
                    indent: indent,
                    kind: 'task',
                    bullet: '-',
                    checked: m[1] !== ' ',
                    body: m[2] == null ? '' : m[2],
                    raw: raw
                };
            }
            m = rest.match(/^([-*+])\s+(.*)$/);
            if (m) {
                return {
                    indent: indent,
                    kind: 'ul',
                    bullet: m[1],
                    body: m[2] == null ? '' : m[2],
                    raw: raw
                };
            }
            // Optional space after period: "1. hello" or "1.hello"
            m = rest.match(/^(\d+)\.\s*(.*)$/);
            if (m) {
                return {
                    indent: indent,
                    kind: 'ol',
                    num: parseInt(m[1], 10) || 1,
                    body: m[2] == null ? '' : m[2],
                    raw: raw
                };
            }
            return null;
        }

        /** Markdown raw for a block, reconstructing list markers from <ol>/<ul> when data-raw is stale. */
        function resolveListAwareRaw(block) {
            if (!block) return '';
            let raw = '';
            if (block.hasAttribute('data-raw')) raw = block.getAttribute('data-raw') || '';
            raw = normalizeBlockRaw(raw);
            if (parseListLine(raw)) return raw;

            const fromGet = normalizeBlockRaw(getBlockRaw(block) || '');
            if (parseListLine(fromGet)) return fromGet;

            function visibleText(el) {
                if (!el) return '';
                return String(el.innerText || el.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .replace(/\n+/g, ' ')
                    .trim();
            }
            const ol = block.querySelector && block.querySelector('ol');
            if (ol) {
                const num = ol.getAttribute('start') || '1';
                const li = ol.querySelector('li');
                return normalizeBlockRaw(num + '. ' + visibleText(li));
            }
            const ul = block.querySelector && block.querySelector('ul');
            if (ul && ul.querySelector('.task-list-item')) {
                const cb = ul.querySelector('input[type="checkbox"]');
                const bodyEl = ul.querySelector('.task-text');
                return normalizeBlockRaw('- [' + (cb && cb.checked ? 'x' : ' ') + '] ' + visibleText(bodyEl));
            }
            if (ul) {
                const li = ul.querySelector('li');
                return normalizeBlockRaw('- ' + visibleText(li));
            }
            return fromGet || raw;
        }

        /** True if caret is at the start of visible text inside a .block (list numbers from CSS don't count). */
        function isCaretAtStartOfBlock(block) {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
            const r = sel.getRangeAt(0);
            if (!block.contains(r.startContainer) && r.startContainer !== block) return false;
            try {
                const pre = document.createRange();
                pre.selectNodeContents(block);
                pre.setEnd(r.startContainer, r.startOffset);
                // Ignore ZWSP / BOM that contenteditable sometimes inserts
                return pre.toString().replace(/[\u200B\uFEFF]/g, '') === '';
            } catch (e) {
                return false;
            }
        }

        /**
         * The selection as one line per .block.
         *
         * Every block is a <div> wrapping a <p>, and the browser's own text/plain
         * serialization gives paragraph-level elements blank-line separation — so copying
         * four lines into Notepad pasted them double-spaced. Walk the selected blocks and
         * join with single newlines instead.
         */
        function selectionToPlainText() {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
            const range = sel.getRangeAt(0);
            const blocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
            const lines = [];
            for (let i = 0; i < blocks.length; i++) {
                const b = blocks[i];
                let hit = false;
                try { hit = range.intersectsNode(b); } catch (e) { hit = false; }
                if (!hit) continue;

                const blockRange = document.createRange();
                blockRange.selectNodeContents(b);
                const inter = range.cloneRange();
                try {
                    if (inter.compareBoundaryPoints(Range.START_TO_START, blockRange) < 0) {
                        inter.setStart(blockRange.startContainer, blockRange.startOffset);
                    }
                    if (inter.compareBoundaryPoints(Range.END_TO_END, blockRange) > 0) {
                        inter.setEnd(blockRange.endContainer, blockRange.endOffset);
                    }
                } catch (e) { continue; }

                // A whole block copies as its markdown, not as its rendered text, so
                // **bold** and `code` survive the round trip instead of arriving as plain
                // words. A partial selection has no markdown to give -- the marks are not in
                // the rendered text it covers -- so it copies what is visibly selected.
                const raw = b.getAttribute('data-raw');
                if (raw != null && inter.toString() === blockRange.toString()) {
                    lines.push(raw);
                } else {
                    // Any newline inside one block is browser filler, never a real line
                    lines.push(String(inter.toString()).replace(/[\r\n]+/g, ' '));
                }
            }
            if (!lines.length) return String(sel.toString());
            return lines.join('\n');
        }

        /**
         * Frozen multi-block selection for Delete after Shift+scroll+click.
         * Under virtualization the live selection often loses the start block once it
         * scrolls off; we keep model indices + head/tail text while the gesture is live.
         */
        let _mbSelFreeze = null; // { fromIdx, toIdx, prefix, suffix }

        function clearMultiBlockSelFreeze() { _mbSelFreeze = null; }

        function snapshotMultiBlockSelectionFromLive() {
            if (state.mode === 'source' || !editor) return;
            try {
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed || !sel.rangeCount) {
                    // Keep last freeze briefly so Delete after focus-steal still works
                    return;
                }
                if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;
                const range = sel.getRangeAt(0);
                const startBlock = getAncestorBlock(range.startContainer);
                const endBlock = getAncestorBlock(range.endContainer);
                if (!startBlock || !endBlock) return;
                let fromIdx = formatBlockIndex(startBlock);
                let toIdx = formatBlockIndex(endBlock);
                if (fromIdx < 0 || toIdx < 0) return;
                if (fromIdx === toIdx) {
                    // Same block: not multi-block (browser handles single-block)
                    _mbSelFreeze = null;
                    return;
                }
                if (fromIdx > toIdx) {
                    const t = fromIdx; fromIdx = toIdx; toIdx = t;
                }
                // Tree-order range for prefix/suffix (works for backwards select too).
                const head = document.createRange();
                head.selectNodeContents(startBlock);
                try {
                    if (startBlock.contains(range.startContainer)
                        || range.startContainer === startBlock) {
                        head.setEnd(range.startContainer, range.startOffset);
                    } else if (endBlock.contains(range.startContainer)) {
                        // Backwards: start is in end block — empty prefix of true first
                        head.setEnd(head.startContainer, head.startOffset);
                    }
                } catch (eH) {}
                let prefix = '';
                try { prefix = head.toString(); } catch (eP) { prefix = ''; }

                const tail = document.createRange();
                tail.selectNodeContents(endBlock);
                try {
                    if (endBlock.contains(range.endContainer)
                        || range.endContainer === endBlock) {
                        tail.setStart(range.endContainer, range.endOffset);
                    }
                } catch (eT) {}
                let suffix = '';
                try { suffix = tail.toString(); } catch (eS) { suffix = ''; }

                // If selection was backwards, tree-order range still has start<=end; recompute
                // prefix/suffix from the true first/last blocks by model order.
                if (formatBlockIndex(startBlock) > formatBlockIndex(endBlock)) {
                    try {
                        const h2 = document.createRange();
                        h2.selectNodeContents(endBlock);
                        h2.setEnd(range.endContainer, range.endOffset);
                        prefix = h2.toString();
                        const t2 = document.createRange();
                        t2.selectNodeContents(startBlock);
                        t2.setStart(range.startContainer, range.startOffset);
                        suffix = t2.toString();
                    } catch (eSwap) {}
                }

                _mbSelFreeze = {
                    fromIdx: fromIdx,
                    toIdx: toIdx,
                    prefix: prefix,
                    suffix: suffix
                };
            } catch (e) {}
        }

        /**
         * Delete model blocks [fromIdx..toIdx], joining prefix+suffix into one block.
         * Reloads from full model markdown so virtualization cannot leave a half-deleted doc.
         * Returns { focusIndex, offset } or null.
         */
        function applyModelMultiBlockDelete(spec) {
            if (!spec || typeof DocumentModel === 'undefined' || !DocumentModel.blocks) return null;
            let fromIdx = spec.fromIdx | 0;
            let toIdx = spec.toIdx | 0;
            if (fromIdx > toIdx) {
                const t = fromIdx; fromIdx = toIdx; toIdx = t;
            }
            if (fromIdx < 0 || toIdx < 0 || toIdx >= DocumentModel.blocks.length) return null;
            if (fromIdx === toIdx) return null;

            // Snapshot full document (mounted DOM preferred for ends, model for middle).
            const model = DocumentModel.blocks;
            const mountedRaw = {};
            try {
                const mountedEls = editor.querySelectorAll('.block[data-model-index]');
                for (let m = 0; m < mountedEls.length; m++) {
                    const mi = parseInt(mountedEls[m].getAttribute('data-model-index'), 10);
                    if (mi >= 0) mountedRaw[mi] = readBlockRawSafe(mountedEls[m]);
                }
            } catch (eM) {}
            const allRaws = model.map(function (blk, bi) {
                if (Object.prototype.hasOwnProperty.call(mountedRaw, bi)
                    && String(mountedRaw[bi] || '').length) {
                    return coerceBlockRaw(mountedRaw[bi]);
                }
                return coerceBlockRaw(blk ? blk.raw : '');
            });
            const preContent = allRaws.join('\n');
            const preNonEmpty = allRaws.filter(function (r) { return String(r || '').trim(); }).length;

            const joined = coerceBlockRaw(String(spec.prefix || '') + String(spec.suffix || ''));
            const out = allRaws.slice(0, fromIdx).concat([joined]).concat(allRaws.slice(toIdx + 1));
            if (!out.length) out.push('');
            const postContent = out.join('\n');
            const postNonEmpty = out.filter(function (r) { return String(r || '').trim(); }).length;
            // Refuse accidental full wipe
            if (preNonEmpty > 0 && postNonEmpty === 0 && preNonEmpty > 1) return null;

            if (typeof HistoryManager !== 'undefined') {
                HistoryManager.recordEditPair(preContent, postContent);
            }
            const hm = typeof HistoryManager !== 'undefined' ? HistoryManager : null;
            const wasRestoring = hm ? hm.isRestoring : false;
            if (hm) hm.isRestoring = true;
            try {
                const focusLine = (typeof modelBlockStartLine === 'function')
                    ? modelBlockStartLine(fromIdx) : 1;
                loadMarkdownContent(postContent, { stickyLine: focusLine });
            } finally {
                if (hm) hm.isRestoring = wasRestoring;
            }
            clearMultiBlockSelFreeze();
            return {
                focusIndex: fromIdx,
                offset: String(spec.prefix || '').length
            };
        }

        /**
         * Delete a selection that spans several blocks, joining the surviving head and tail
         * into one line, and return where the caret belongs. Shared by cut and paste-over.
         * Uses the full DocumentModel (not only mounted DOM siblings) so Shift+scroll+click
         * selections that cross the virtual window still delete every middle block.
         * Returns { block, offset } or null when the selection sits inside one block.
         */
        function removeCrossBlockSelection() {
            const sel = window.getSelection();
            let fromIdx = -1, toIdx = -1, prefix = '', suffix = '';
            let liveOk = false;

            if (sel && !sel.isCollapsed && sel.rangeCount
                && sel.anchorNode && editor.contains(sel.anchorNode)) {
                const range = sel.getRangeAt(0);
                const startBlock = getAncestorBlock(range.startContainer);
                const endBlock = getAncestorBlock(range.endContainer);
                if (startBlock && endBlock && startBlock !== endBlock) {
                    fromIdx = formatBlockIndex(startBlock);
                    toIdx = formatBlockIndex(endBlock);
                    if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
                        snapshotMultiBlockSelectionFromLive();
                        if (_mbSelFreeze) {
                            fromIdx = _mbSelFreeze.fromIdx;
                            toIdx = _mbSelFreeze.toIdx;
                            prefix = _mbSelFreeze.prefix;
                            suffix = _mbSelFreeze.suffix;
                            liveOk = true;
                        }
                    }
                }
            }
            // Live selection dead (scrolled off / focus steal): use freeze from the gesture
            if (!liveOk && _mbSelFreeze && (_mbSelFreeze.toIdx > _mbSelFreeze.fromIdx)) {
                fromIdx = _mbSelFreeze.fromIdx;
                toIdx = _mbSelFreeze.toIdx;
                prefix = _mbSelFreeze.prefix;
                suffix = _mbSelFreeze.suffix;
                liveOk = true;
            }
            if (!liveOk || fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return null;

            const result = applyModelMultiBlockDelete({
                fromIdx: fromIdx,
                toIdx: toIdx,
                prefix: prefix,
                suffix: suffix
            });
            if (!result) return null;

            // After reload, resolve the focus block
            let block = null;
            try {
                block = (typeof elementForModelIndex === 'function')
                    ? elementForModelIndex(result.focusIndex)
                    : null;
                if (!block && editor) {
                    block = editor.querySelector(
                        '.block[data-model-index="' + result.focusIndex + '"]');
                }
            } catch (eB) {}
            return { block: block, offset: result.offset | 0, focusIndex: result.focusIndex };
        }

        /**
         * Backspace/Delete over a multi-block selection. Must not fall through to the
         * browser: contenteditable then rewrites thousands of nodes and we freeze.
         */
        function handleMultiBlockSelectionDelete(e) {
            if (window.isComposing || (e && e.isComposing) || (e && e.keyCode === 229)) return false;
            if (state.mode === 'source') return false;

            // Refresh freeze from live selection if still multi-block
            try { snapshotMultiBlockSelectionFromLive(); } catch (eSnap) {}

            const sel = window.getSelection();
            let willHandle = false;
            if (_mbSelFreeze && _mbSelFreeze.toIdx > _mbSelFreeze.fromIdx) willHandle = true;
            if (sel && !sel.isCollapsed && sel.rangeCount
                && sel.anchorNode && editor.contains(sel.anchorNode)) {
                const range = sel.getRangeAt(0);
                const startBlock = getAncestorBlock(range.startContainer);
                const endBlock = getAncestorBlock(range.endContainer);
                if (startBlock && endBlock && startBlock !== endBlock) willHandle = true;
            }
            if (!willHandle) return false;

            if (e) {
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            }

            const cutAt = removeCrossBlockSelection();
            if (!cutAt) return true;

            try {
                window.isProgrammaticFocus = true;
                if (cutAt.block) {
                    focusBlock(cutAt.block);
                    setCaretAtOffset(cutAt.block, cutAt.offset | 0);
                } else if (typeof goToModelBlock === 'function' && cutAt.focusIndex >= 0) {
                    goToModelBlock(cutAt.focusIndex);
                }
            } catch (err) {}

            // History already recorded inside applyModelMultiBlockDelete
            try {
                if (typeof updateStats === 'function') updateStats();
                if (typeof updateOutline === 'function') {
                    setTimeout(function () { try { updateOutline(); } catch (e2) {} }, 0);
                }
            } catch (e3) {}
            return true;
        }

        /** Mirror of isCaretAtStartOfBlock — nothing but markers/ZWSP after the caret. */
        function isCaretAtEndOfBlock(block) {
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
            const r = sel.getRangeAt(0);
            if (!block.contains(r.endContainer) && r.endContainer !== block) return false;
            try {
                const post = document.createRange();
                post.selectNodeContents(block);
                post.setStart(r.endContainer, r.endOffset);
                return post.toString().replace(/[\u200B\uFEFF]/g, '') === '';
            } catch (e) {
                return false;
            }
        }

        // WebView often fires keydown AND beforeinput for one Backspace.
        // After we strip "1. " → "hello", the second event must NOT run browser merge.
        let _listBackspaceLockUntil = 0;

        /**
         * 2-stage list Backspace at visual start of a line:
         *   indent>0 → outdent; else strip marker; NEVER merge on the same keystroke.
         * Returns true if handled (caller must preventDefault on this event AND any
         * paired beforeinput/keydown within the lock window).
         */
        function handleListBackspaceAtStart(block) {
            if (!block || !block.classList || !block.classList.contains('block')) return false;
            if (!isCaretAtStartOfBlock(block)) return false;

            const currentRaw = resolveListAwareRaw(block);
            const listP = parseListLine(currentRaw);
            if (!listP) return false;

            HistoryManager.beginEdit();
            if (listP.indent > 0) {
                writeBlockRaw(block, indentListLine(currentRaw, -1));
            } else {
                // Strip "1. " / "- " / task marker only — leave body as its own block
                writeBlockRaw(block, listP.body || '');
            }
            // Suppress the paired beforeinput/keydown so browser cannot merge after strip
            _listBackspaceLockUntil = Date.now() + 100;
            setTimeout(function () {
                try { setCaretAtOffset(block, 0); } catch (err) {}
            }, 0);
            updateStats();
            updateOutline();
            HistoryManager.commitEdit();
            return true;
        }

        /** True if we already handled list Backspace for this physical keypress. */
        function isListBackspaceLocked() {
            return Date.now() < _listBackspaceLockUntil;
        }

        function isListLine(raw) {
            return parseListLine(raw) != null;
        }

        function getListIndentLevel(raw) {
            const p = parseListLine(raw);
            return p ? p.indent : 0;
        }

        /** Rebuild one list line from parsed fields. */
        function formatListLine(p) {
            if (!p || !p.kind) return String(p && p.raw != null ? p.raw : '');
            let indent = p.indent | 0;
            if (indent < 0) indent = 0;
            if (indent > LIST_MAX_INDENT) indent = LIST_MAX_INDENT;
            let pad = '';
            for (let i = 0; i < indent * LIST_INDENT_SPACES; i++) pad += ' ';
            const body = p.body == null ? '' : String(p.body);
            if (p.kind === 'task') {
                return pad + '- [' + (p.checked ? 'x' : ' ') + '] ' + body;
            }
            if (p.kind === 'ol') {
                const n = p.num != null ? p.num : 1;
                return pad + n + '. ' + body;
            }
            const bullet = p.bullet || '-';
            return pad + bullet + ' ' + body;
        }

        /** Change list indent by delta (±1). No-op if not a list line. Clamps 0..LIST_MAX_INDENT. */
        function indentListLine(raw, delta) {
            const p = parseListLine(raw);
            if (!p) return String(raw == null ? '' : raw);
            p.indent = (p.indent | 0) + (delta | 0);
            if (p.indent < 0) p.indent = 0;
            if (p.indent > LIST_MAX_INDENT) p.indent = LIST_MAX_INDENT;
            return formatListLine(p);
        }

        /** Strip marker only (keep indent spaces removed with marker → body only for format toggles). */
        function stripListMarkerKeepBody(raw) {
            const p = parseListLine(raw);
            if (p) return p.body;
            return null;
        }

        /** Strip heading / quote / list prefixes so format toggles can re-apply cleanly. */
        function stripBlockPrefix(text) {
            const listBody = stripListMarkerKeepBody(text);
            if (listBody != null) return listBody;
            return String(text || '')
                .replace(/^#{1,6}\s+/, '')
                .replace(/^>\s+/, '')
                .trim();
        }

        /** Pad string for list indent level (for blockHtmlToMarkdown). */
        function listIndentPad(level) {
            let n = level | 0;
            if (n < 0) n = 0;
            if (n > LIST_MAX_INDENT) n = LIST_MAX_INDENT;
            let pad = '';
            for (let i = 0; i < n * LIST_INDENT_SPACES; i++) pad += ' ';
            return pad;
        }

        function setBlockListIndentAttr(block, raw) {
            if (!block) return;
            const p = parseListLine(raw);
            if (p) block.setAttribute('data-list-indent', String(p.indent));
            else block.removeAttribute('data-list-indent');
        }

        /** Drop blank lines that sit between two list lines (causes huge gaps in preview). */
        function compactBlankLinesBetweenLists(lines) {
            const result = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i] == null ? '' : String(lines[i]);
                if (!line.trim()) {
                    let nextNonEmpty = null;
                    for (let j = i + 1; j < lines.length; j++) {
                        if (String(lines[j] || '').trim()) {
                            nextNonEmpty = String(lines[j]);
                            break;
                        }
                    }
                    const prev = result.length ? result[result.length - 1] : null;
                    if (prev && isListLine(prev) && nextNonEmpty && isListLine(nextNonEmpty)) {
                        continue;
                    }
                }
                result.push(line);
            }
            return result;
        }

        /**
         * SAFE document mutation for list-related changes.
         * Never write <ul>/<ol> into multiple contenteditable siblings in a loop.
         * Snapshot markdown → mutate strings → one loadMarkdownContent.
         *
         * History: owns pre/post from the SAME string snapshot (not a second DOM re-read).
         * Callers must NOT also beginEdit/commitEdit around this (double frames / empty undo).
         *
         * @param {(raw:string, index:number, allRaws:string[]) => string|string[]} mutator
         * @param {{ focusIndex?: number, focusIndices?: object, compactListGaps?: boolean, skipHistory?: boolean }} [opts]
         * @returns {boolean} true if document was reloaded
         */
        function mutateDocumentMarkdown(mutator, opts) {
            opts = opts || {};
            if (!editor || typeof mutator !== 'function') return false;

            // The document, not the part of it on screen.
            //
            // This used to snapshot editor.querySelectorAll('.block') and then reload the
            // document from what it produced. Under virtualization that is the mounted
            // window and nothing else: a list edit two thirds through a 3,767-block
            // document would have rebuilt it as the ~99 blocks on screen. Nothing reached
            // it only because applyListIndentToSelection bounded its index by the mounted
            // count, which prevented the call rather than fixing it -- so Tab silently did
            // nothing there instead of destroying the file.
            //
            // Indices below are model indices throughout: that is what the mutator sees,
            // what opts.focusIndex/focusIndices mean, and what _selectedFormatRaws is
            // already keyed by. Before this they were mounted-DOM positions, and the three
            // agreed only while the window started at block 0.
            const model = (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
                ? DocumentModel.blocks : null;
            if (!model || !model.length) return false;

            // A mounted block's data-raw is written in the same transaction as its DOM, so
            // it is at least as fresh as the model; rows off screen can only come from the
            // model. Built once rather than a querySelector per row.
            const mountedRaw = {};
            const mountedEls = editor.querySelectorAll('.block[data-model-index]');
            for (let m = 0; m < mountedEls.length; m++) {
                const mi = parseInt(mountedEls[m].getAttribute('data-model-index'), 10);
                if (mi >= 0) mountedRaw[mi] = readBlockRawSafe(mountedEls[m]);
            }

            // Snapshot FIRST — single source for mutation AND undo pre-state.
            // Prefer frozen format raws (mouseup); else the mounted DOM; else the model.
            const allRaws = model.map(function (blk, bi) {
                if (typeof _formatSelectionFrozen !== 'undefined' && _formatSelectionFrozen
                    && typeof _selectedFormatRaws !== 'undefined'
                    && Object.prototype.hasOwnProperty.call(_selectedFormatRaws, bi)
                    && _selectedFormatRaws[bi] != null
                    && String(_selectedFormatRaws[bi]).trim()) {
                    return coerceBlockRaw(_selectedFormatRaws[bi]);
                }
                if (Object.prototype.hasOwnProperty.call(mountedRaw, bi)
                    && String(mountedRaw[bi] || '').trim()) {
                    return mountedRaw[bi];
                }
                return coerceBlockRaw(blk ? blk.raw : '');
            });
            const preContent = allRaws.join('\n');
            const preNonEmpty = allRaws.filter(function (r) { return String(r || '').trim(); }).length;
            let outLines = [];
            let focusStart = -1;
            let focusEnd = -1;

            for (let i = 0; i < allRaws.length; i++) {
                let result = mutator(allRaws[i], i, allRaws);
                if (result == null) result = allRaws[i];
                // NEVER drop a line via return [] (wipe / undo line-count bug)
                if (Array.isArray(result) && result.length === 0) {
                    result = allRaws[i];
                }
                let piece;
                if (Array.isArray(result)) {
                    // Join multi-part results with space for single-line blocks, not \n
                    piece = result.map(function (x) { return coerceBlockRaw(x); }).filter(function (x) {
                        return String(x).length > 0;
                    }).join(' ');
                    if (!piece && result.length) piece = coerceBlockRaw(result[0]);
                } else {
                    piece = coerceBlockRaw(result);
                }
                // Refuse wipe: non-empty pre must not become empty post
                if (String(allRaws[i] || '').trim() && !String(piece || '').trim()) {
                    piece = allRaws[i];
                }
                if (opts.focusIndex === i || (opts.focusIndices && opts.focusIndices[i])) {
                    if (focusStart < 0) focusStart = outLines.length;
                    focusEnd = outLines.length;
                }
                outLines.push(piece == null ? '' : piece);
            }
            if (!outLines.length) outLines.push('');

            if (opts.compactListGaps) {
                outLines = compactBlankLinesBetweenLists(outLines);
                if (focusStart >= 0) {
                    focusEnd = Math.min(focusEnd, outLines.length - 1);
                    focusStart = Math.min(focusStart, Math.max(0, focusEnd));
                }
            }

            const postContent = outLines.join('\n');
            const postNonEmpty = outLines.filter(function (r) { return String(r || '').trim(); }).length;
            // Hard abort: never reload a wiped document (H1/list multi-select regression)
            if (preNonEmpty > 0 && postNonEmpty === 0) {
                try { console.warn('TypoZen: mutateDocumentMarkdown aborted — would wipe all content'); } catch (e) {}
                return false;
            }
            if (preNonEmpty >= 2 && postNonEmpty < Math.max(1, Math.floor(preNonEmpty / 2))) {
                // Lost more than half of non-empty lines — refuse (partial wipe)
                try { console.warn('TypoZen: mutateDocumentMarkdown aborted — lost most lines', preNonEmpty, '->', postNonEmpty); } catch (e) {}
                return false;
            }

            // Explicit history from strings — never re-capture empty data-raw mid-flight
            if (!opts.skipHistory && typeof HistoryManager !== 'undefined') {
                HistoryManager.recordEditPair(preContent, postContent);
            }

            const hm = typeof HistoryManager !== 'undefined' ? HistoryManager : null;
            const wasRestoring = hm ? hm.isRestoring : false;
            if (hm) hm.isRestoring = true;
            try {
                loadMarkdownContent(postContent);
            } finally {
                if (hm) hm.isRestoring = wasRestoring;
            }
            // After reload, serialize may differ slightly from postContent (trailing blanks,
            // coerce). Resync stack TOP to actual getMarkdownContent so first Ctrl+Z is not
            // a no-op that only "undoes" a phantom live frame back to the same list state.
            if (hm && !opts.skipHistory && hm.undoStack.length) {
                try {
                    const actual = getMarkdownContent();
                    const top = hm.undoStack[hm.undoStack.length - 1];
                    const topContent = hm._contentOf(top);
                    if (String(actual) !== String(topContent)) {
                        const caret = hm._caretOf(top);
                        hm.undoStack[hm.undoStack.length - 1] = hm._stateFromContent(actual, caret);
                    }
                } catch (e) {}
            }

            const newBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
            if (focusStart >= 0 && newBlocks.length) {
                const fi = Math.min(focusStart, newBlocks.length - 1);
                const li = focusEnd >= 0 ? Math.min(focusEnd, newBlocks.length - 1) : fi;
                _selectedFormatBlocks = newBlocks.slice(Math.max(0, fi), li + 1);
                currentActiveBlock = newBlocks[li] || newBlocks[fi];
                try {
                    if (currentActiveBlock) {
                        currentActiveBlock.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                        const sel = window.getSelection();
                        if (sel && _selectedFormatBlocks.length > 0) {
                            const r = document.createRange();
                            r.setStartBefore(_selectedFormatBlocks[0]);
                            r.setEndAfter(_selectedFormatBlocks[_selectedFormatBlocks.length - 1]);
                            sel.removeAllRanges();
                            sel.addRange(r);
                        }
                        focusEditorNoScroll();
                    }
                } catch (e) {
                    try { focusBlock(currentActiveBlock, null); } catch (e2) {}
                }
            }
            updateStats();
            updateOutline();
            return true;
        }

        /** Indent/outdent list lines for the current selection (safe reload path). */
        function applyListIndentToSelection(delta) {
            const selectedIdx = getSelectedBlockIndices();
            if (!selectedIdx || !selectedIdx.length) return false;

            // Model indices, checked against the model.
            //
            // getSelectedBlockIndices returns indices into the document; this used to bound
            // them by the number of *mounted* blocks and read the raw out of the mounted DOM
            // at that position. At the top of a document the two agree; anywhere else they
            // do not, so Tab on a list item two thirds through a long document silently did
            // nothing. That bound was also the only thing keeping the call away from
            // mutateDocumentMarkdown, which used to rebuild the document from the mounted
            // window -- it is safe to remove now, and not before.
            const total = (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
                ? DocumentModel.blocks.length : 0;
            const rawAt = function (idx) {
                const el = editor
                    ? editor.querySelector('.block[data-model-index="' + idx + '"]')
                    : null;
                if (el) return getBlockRaw(el);
                const b = DocumentModel.blocks[idx];
                return b ? coerceBlockRaw(b.raw) : '';
            };

            const focusIndices = {};
            let any = false;
            for (let i = 0; i < selectedIdx.length; i++) {
                const idx = selectedIdx[i];
                if (idx >= 0 && idx < total && isListLine(rawAt(idx))) {
                    focusIndices[idx] = true;
                    any = true;
                }
            }
            if (!any) return false;

            // History owned inside mutateDocumentMarkdown — do not beginEdit/commitEdit here
            return mutateDocumentMarkdown(function (raw, index) {
                if (focusIndices[index] && isListLine(raw)) {
                    return indentListLine(coerceBlockRaw(raw), delta);
                }
                return raw;
            }, { focusIndices: focusIndices, compactListGaps: false });
        }

        // Format selection cache. WPF toolbar steals focus and DESTROYS the live selection
        // before fmt:list runs — often replacing it with a full-doc or collapsed range.
        // Snapshot indices + raw markdown on mouseup/keyup *inside* the editor, freeze on
        // focusout WITHOUT re-reading the destroyed selection, and applyFormatting uses
        // ONLY that freeze (never post-toolbar live selection / empty data-raw).
        let _selectedFormatBlocks = [];
        let _selectedFormatIndices = [];
        let _selectedFormatRaws = {}; // index -> markdown at snapshot time (survives DOM wipe)
        let _formatSelectionFrozen = false;
        // Full-document last-known-good lines. Multi-select often blanks data-raw in the
        // DOM before the toolbar click; we restore unselected rows from this, not from DOM.
        let _lastGoodDocRaws = [];

        function normalizeBlockRaw(raw) {
            let s = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            while (s.length && s.charAt(s.length - 1) === '\n') s = s.slice(0, -1);
            return s;
        }

        /** True if this block is allowed to contain internal newlines (fence / table). */
        function isMultilineBlockRaw(raw) {
            raw = String(raw == null ? '' : raw);
            if (/^\s*```/.test(raw)) return true;
            // GFM table: header row with pipes (and usually a separator line)
            const lines = raw.split('\n');
            if (lines.length > 1 && lines.some(function (l) { return /^\s*\|/.test(l); })) return true;
            if (/^\s*\|/.test(raw) && raw.indexOf('\n') >= 0) return true;
            return false;
        }

        /**
         * Enforce storage rules for data-raw:
         * - fence/table: keep internal newlines
         * - everything else: EXACTLY one line (no blank-line injection)
         * Soft breaks inside a block become spaces so Source/reload cannot double rows.
         */
        function coerceBlockRaw(raw) {
            raw = normalizeBlockRaw(raw);
            // A code document's raw is a line of code, byte for byte.
            //
            // Everything below is Markdown housekeeping, and the collapse in particular
            // trims each part -- which is exactly the leading indentation a code file is
            // made of. Nothing here is a refinement for code; it is all damage.
            if (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'code') return raw;
            if (isMultilineBlockRaw(raw)) return raw;
            if (raw.indexOf('\n') < 0) return raw;
            // Collapse accidental multi-line in a single-line block to one line
            return raw.split('\n').map(function (p) { return p.trim(); }).filter(Boolean).join(' ');
        }

        function countMdImages(raw) {
            const m = String(raw == null ? '' : raw).match(/!\[[^\]]*\]\([^)]*\)/g);
            return m ? m.length : 0;
        }

        /**
         * True if the caret / focus is in this block (live edit surface).
         */
        function isBlockFocused(block) {
            if (!block) return false;
            try {
                const active = document.activeElement;
                if (active === block || (block.contains && block.contains(active))) return true;
                if (editor && editor.contains && editor.contains(active)) {
                    const sel = window.getSelection();
                    if (sel && sel.anchorNode && block.contains(sel.anchorNode)) return true;
                }
            } catch (e) {}
            return false;
        }

        /**
         * Serialize one block's live DOM to markdown storage form (no write).
         * Shared by input sync, flush, and focused getBlockRaw.
         */
        function serializeBlockDomToRaw(block) {
            if (!block) return '';
            try {
                if (state.revealOnFocus) {
                    return coerceBlockRaw(block.innerText || '');
                }
                // Always tree-walk (blockHtmlToMarkdown). Joining child innerText used to
                // strip nested ** / * / ~~ after toolbar or contenteditable splits.
                return coerceBlockRaw(blockHtmlToMarkdown(block));
            } catch (e) {
                return coerceBlockRaw(block.getAttribute('data-raw') || block.innerText || '');
            }
        }

        /**
         * Phase 1 invariant: write live DOM → data-raw for the active/focused block.
         * Call before host serialize, mode switch to Source, or any leave-Preview path.
         */
        function flushActiveBlockToRaw() {
            if (state.mode === 'source') return;
            if (!editor) return;
            try {
                let blk = null;
                const sel = window.getSelection();
                if (sel && sel.anchorNode) blk = getAncestorBlock(sel.anchorNode);
                if (!blk) blk = currentActiveBlock;
                if (!blk || !editor.contains(blk)) return;
                const raw = serializeBlockDomToRaw(blk);
                blk.setAttribute('data-raw', raw);
                setBlockListIndentAttr(blk, raw);
                try { touchLastGoodDocRawAtBlock(blk, raw); } catch (e2) {}
                try { blk.setAttribute('data-tz-dirty', '1'); } catch (e3) {}
                try { DocumentModel.syncElToModel(blk); } catch (e4) {}
                _contentCache = null;
            } catch (e) {}
        }

        /**
         * Read markdown for a block.
         * Canonical rule (Phase 1): unfocused → data-raw; focused → live DOM serialize.
         * No "longer wins" length heuristic (that undid deletions on save).
         */
        function getBlockRaw(block) {
            if (!block) return '';
            const focusedHere = isBlockFocused(block);
            if (state.revealOnFocus && focusedHere) {
                return normalizeBlockRaw(block.innerText || block.getAttribute('data-raw') || '');
            }
            const raw = block.getAttribute('data-raw');
            // Images never appear in innerText. Fewer <img>s than data-raw ⇒ deleted image.
            if (raw != null && raw !== '' && countMdImages(raw) > block.querySelectorAll('img').length) {
                try { return normalizeBlockRaw(blockHtmlToMarkdown(block)); } catch (e) {}
            }
            // Focused: DOM is the live surface — always trust serialize (typing AND deletes).
            if (focusedHere) {
                return normalizeBlockRaw(serializeBlockDomToRaw(block));
            }
            // Unfocused: data-raw is canonical.
            if (raw != null && raw !== '') return normalizeBlockRaw(raw);
            const fromDom = String(block.innerText || '').replace(/\u00a0/g, ' ');
            if (fromDom.trim()) return normalizeBlockRaw(fromDom);
            if (raw != null) return normalizeBlockRaw(raw);
            return normalizeBlockRaw(fromDom);
        }

        /**
         * Canonical block index for format/selection: model index when stamped
         * (virt + full mount), else DOM ordinal among .block siblings.
         * Under virt, DOM ordinal is wrong (0 = first *mounted* block).
         */
        function formatBlockIndex(block) {
            if (!block) return -1;
            try {
                if (typeof DocumentModel !== 'undefined') {
                    let mi = DocumentModel.modelIndexOfEl(block);
                    if (mi >= 0) return mi;
                }
            } catch (e) {}
            if (!editor) return -1;
            const all = editor.querySelectorAll('.block');
            return Array.prototype.indexOf.call(all, block);
        }

        /** Document block count for clamping format indices. */
        function formatDocBlockCount() {
            try {
                if (typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                    && DocumentModel.blocks.length) {
                    return DocumentModel.blocks.length;
                }
            } catch (e) {}
            return editor ? editor.querySelectorAll('.block').length : 0;
        }

        /** Mounted .block for a model/format index, or null if off-window under virt. */
        function mountedBlockAtFormatIndex(index) {
            if (!editor || index < 0) return null;
            const byAttr = editor.querySelector('.block[data-model-index="' + index + '"]');
            if (byAttr) return byAttr;
            // Non-virt full mount without attrs yet
            if (typeof DocumentModel === 'undefined' || !DocumentModel.virtEnabled) {
                const all = editor.querySelectorAll('.block');
                return all[index] || null;
            }
            return null;
        }

        function writeBlockRaw(block, raw) {
            raw = coerceBlockRaw(raw);
            block.setAttribute('data-raw', raw);
            try { block.removeAttribute('data-tz-dirty'); } catch (e0) {}
            setBlockListIndentAttr(block, raw);
            if (state.revealOnFocus) block.innerText = raw;
            else renderBlockPreview(block, raw);
            // Stage A dual-write: model tracks the same raw as the attribute.
            try {
                let mi = DocumentModel.modelIndexOfEl(block);
                if (mi < 0 && editor && block.parentNode === editor) {
                    const all = editor.querySelectorAll('.block');
                    mi = Array.prototype.indexOf.call(all, block);
                    if (mi >= 0) block.setAttribute('data-model-index', String(mi));
                }
                if (mi >= 0) DocumentModel.setBlockRaw(mi, raw);
            } catch (eM) {}
            try {
                const bi = formatBlockIndex(block);
                if (bi >= 0) {
                    if (!_lastGoodDocRaws.length) refreshLastGoodDocRaws();
                    while (_lastGoodDocRaws.length <= bi) _lastGoodDocRaws.push('');
                    _lastGoodDocRaws[bi] = raw;
                }
            } catch (e) {}
        }

        /** Contiguous block indices from selection anchor → focus (row range). */
        function indicesFromSelectionAnchorFocus() {
            const allBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
            if (!allBlocks.length) return [];
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return null;
            if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return null;

            const aBlock = getAncestorBlock(sel.anchorNode);
            const fBlock = getAncestorBlock(sel.focusNode) || aBlock;
            // Prefer model indices so virt multi-select hits the real document rows
            let i0 = formatBlockIndex(aBlock);
            let i1 = formatBlockIndex(fBlock);
            if (i0 < 0 && aBlock) i0 = allBlocks.indexOf(aBlock);
            if (i1 < 0 && fBlock) i1 = allBlocks.indexOf(fBlock);
            if (i0 < 0 && i1 < 0) return null;
            if (i0 < 0) i0 = i1;
            if (i1 < 0) i1 = i0;
            if (i0 > i1) {
                const tmp = i0;
                i0 = i1;
                i1 = tmp;
            }
            const indices = [];
            for (let i = i0; i <= i1; i++) indices.push(i);
            return indices;
        }

        /**
         * Best-effort markdown for a block. Never prefer empty over DOM text — multi-select
         * and toolbar focus-steal often blank data-raw while <p>/<h1> still show text.
         */
        function readBlockRawSafe(block) {
            if (!block) return '';
            let attr = block.getAttribute('data-raw');
            if (attr != null && String(attr).trim()) return coerceBlockRaw(attr);
            try {
                const fromGet = getBlockRaw(block);
                if (fromGet != null && String(fromGet).trim()) return coerceBlockRaw(fromGet);
            } catch (e) {}
            try {
                const fromMd = typeof blockHtmlToMarkdown === 'function' ? blockHtmlToMarkdown(block) : '';
                if (fromMd != null && String(fromMd).trim()) return coerceBlockRaw(fromMd);
            } catch (e2) {}
            try {
                const fromText = (block.innerText || block.textContent || '').replace(/\u00a0/g, ' ');
                if (String(fromText).trim()) return coerceBlockRaw(fromText);
            } catch (e3) {}
            return coerceBlockRaw(attr != null ? attr : '');
        }

        /** Snapshot every block's markdown when still reliable (mousedown / typing / load). */
        function refreshLastGoodDocRaws() {
            if (!editor) return;
            try {
                // Virt: full document lives in DocumentModel; only a window is mounted.
                // Seed from the model, then overlay any non-empty mounted DOM raws.
                if (typeof DocumentModel !== 'undefined' && DocumentModel.virtEnabled
                    && DocumentModel.blocks && DocumentModel.blocks.length) {
                    try { DocumentModel.syncMountedToModel(); } catch (eS) {}
                    const next = DocumentModel.blocks.map(function (b) {
                        return coerceBlockRaw(b && b.raw != null ? b.raw : '');
                    });
                    const nodes = editor.querySelectorAll('.block');
                    for (let i = 0; i < nodes.length; i++) {
                        const mi = formatBlockIndex(nodes[i]);
                        if (mi < 0 || mi >= next.length) continue;
                        let r = nodes[i].getAttribute('data-raw');
                        if (r == null || !String(r).trim()) r = readBlockRawSafe(nodes[i]);
                        r = coerceBlockRaw(r == null ? '' : r);
                        if (String(r).trim()) next[mi] = r;
                    }
                    const newNonEmpty = next.filter(function (x) { return String(x || '').trim(); }).length;
                    const oldNonEmpty = _lastGoodDocRaws.filter(function (x) {
                        return String(x || '').trim();
                    }).length;
                    if (newNonEmpty === 0 && oldNonEmpty > 0) return;
                    _lastGoodDocRaws = next;
                    return;
                }

                const allBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
                if (!allBlocks.length) return;
                const next = [];
                let newNonEmpty = 0;
                for (let i = 0; i < allBlocks.length; i++) {
                    // Prefer attribute data-raw first (faster, matches typed content)
                    let r = allBlocks[i].getAttribute('data-raw');
                    if (r == null || !String(r).trim()) r = readBlockRawSafe(allBlocks[i]);
                    r = coerceBlockRaw(r == null ? '' : r);
                    next.push(r);
                    if (String(r).trim()) newNonEmpty++;
                }
                const oldNonEmpty = _lastGoodDocRaws.filter(function (x) {
                    return String(x || '').trim();
                }).length;
                // Never replace a good snapshot with multi-select-corrupted empties
                if (newNonEmpty === 0 && oldNonEmpty > 0) return;
                if (newNonEmpty >= oldNonEmpty || !_lastGoodDocRaws.length) {
                    _lastGoodDocRaws = next;
                    return;
                }
                // Partial corruption: merge — keep non-empty old where new is empty
                const merged = next.slice();
                for (let i = 0; i < merged.length; i++) {
                    if (!String(merged[i] || '').trim()
                        && i < _lastGoodDocRaws.length
                        && String(_lastGoodDocRaws[i] || '').trim()) {
                        merged[i] = _lastGoodDocRaws[i];
                    }
                }
                _lastGoodDocRaws = merged;
            } catch (e) {}
        }

        /** Update one index in last-good after typing (input does not call writeBlockRaw). */
        function touchLastGoodDocRawAtBlock(block, raw) {
            if (!editor || !block) return;
            try {
                const bi = formatBlockIndex(block);
                if (bi < 0) return;
                const n = Math.max(formatDocBlockCount(), bi + 1);
                if (!_lastGoodDocRaws.length) {
                    _lastGoodDocRaws = [];
                    for (let i = 0; i < n; i++) _lastGoodDocRaws.push('');
                }
                while (_lastGoodDocRaws.length <= bi) _lastGoodDocRaws.push('');
                if (String(raw || '').trim()) {
                    _lastGoodDocRaws[bi] = coerceBlockRaw(raw);
                }
            } catch (e) {}
        }

        /** Capture data-raw for indices so toolbar focus-steal cannot empty lines. */
        function captureFormatRawsForIndices(indices, allBlocks) {
            _selectedFormatRaws = {};
            if (!indices) return;
            // allBlocks may be DOM-ordered (mounted only under virt). Prefer model index lookup.
            for (let i = 0; i < indices.length; i++) {
                const bi = indices[i];
                if (bi < 0) continue;
                let r = '';
                const el = mountedBlockAtFormatIndex(bi)
                    || (allBlocks && allBlocks[bi])
                    || null;
                if (el) r = readBlockRawSafe(el);
                // Model is authoritative under virt when DOM missing/empty
                if (!String(r || '').trim()
                    && typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                    && DocumentModel.blocks[bi]) {
                    r = DocumentModel.blocks[bi].raw || '';
                }
                // Prefer last-good if live read is empty (multi-select already corrupted DOM)
                if (!String(r || '').trim() && _lastGoodDocRaws[bi] != null
                    && String(_lastGoodDocRaws[bi]).trim()) {
                    r = _lastGoodDocRaws[bi];
                }
                _selectedFormatRaws[bi] = r;
            }
        }

        /**
         * Multi-select list/heading format from LAST-GOOD markdown lines only.
         *
         * Why not DOM / in-place write:
         * Multi-select in one contenteditable often DESTROYS .block structure and blanks
         * data-raw before the toolbar click. Writing into a corrupted DOM still looks wiped.
         *
         * Strategy: keep _lastGoodDocRaws from mousedown/typing (before corruption).
         * Transform pure strings → loadMarkdownContent(KNOWN GOOD post). Reload is safe
         * when content is correct; the wipe was reloading EMPTY content.
         */
        function applyFormatInPlaceToSelection(type, forceOff, forceOn) {
            if (!editor) return false;

            // --- Build pre lines ONLY from trusted sources (never corrupted live DOM alone) ---
            let preLines = [];
            // Virt / model-first: full document, not only the mounted window
            if (typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                && DocumentModel.blocks.length
                && (DocumentModel.virtEnabled
                    || DocumentModel.blocks.length >= (editor.querySelectorAll('.block').length))) {
                try { DocumentModel.syncMountedToModel(); } catch (eSync) {}
                preLines = DocumentModel.blocks.map(function (b) {
                    return coerceBlockRaw(b && b.raw != null ? b.raw : '');
                });
            }
            if ((!preLines.length || !preLines.some(function (x) { return String(x || '').trim(); }))
                && _lastGoodDocRaws && _lastGoodDocRaws.length
                && _lastGoodDocRaws.some(function (x) { return String(x || '').trim(); })) {
                preLines = _lastGoodDocRaws.map(function (x) { return coerceBlockRaw(x == null ? '' : x); });
            }
            // Overlay any non-empty frozen selection raws
            if (_selectedFormatRaws && typeof _selectedFormatRaws === 'object') {
                Object.keys(_selectedFormatRaws).forEach(function (k) {
                    const i = parseInt(k, 10);
                    const v = _selectedFormatRaws[k];
                    if (!isNaN(i) && i >= 0 && String(v || '').trim()) {
                        while (preLines.length <= i) preLines.push('');
                        preLines[i] = coerceBlockRaw(v);
                    }
                });
            }
            // History stack top
            if ((!preLines.length || !preLines.some(function (x) { return String(x || '').trim(); }))
                && typeof HistoryManager !== 'undefined' && HistoryManager.undoStack.length) {
                try {
                    const topC = HistoryManager._contentOf(
                        HistoryManager.undoStack[HistoryManager.undoStack.length - 1]
                    );
                    if (String(topC || '').trim()) {
                        preLines = String(topC).replace(/\r\n/g, '\n').split('\n').map(function (x) {
                            return coerceBlockRaw(x);
                        });
                    }
                } catch (e) {}
            }
            // Live DOM only if still has real text (may already be destroyed)
            if (!preLines.length || !preLines.some(function (x) { return String(x || '').trim(); })) {
                try {
                    const live = getMarkdownContent();
                    if (String(live || '').trim()) {
                        preLines = String(live).replace(/\r\n/g, '\n').split('\n').map(function (x) {
                            return coerceBlockRaw(x);
                        });
                    }
                } catch (e2) {}
            }
            if (!preLines.length || !preLines.some(function (x) { return String(x || '').trim(); })) {
                try { console.warn('TypoZen: format aborted — no last-good content'); } catch (e3) {}
                return false;
            }

            const selectedIdx = getSelectedBlockIndices();
            const focusIndices = {};
            if (selectedIdx.length) {
                for (let si = 0; si < selectedIdx.length; si++) {
                    const idx = selectedIdx[si];
                    if (idx >= 0 && idx < preLines.length) focusIndices[idx] = true;
                }
            }
            // If freeze lost indices, format nothing rather than inventing blank doc
            if (!Object.keys(focusIndices).length) {
                // Single-line fallback: last frozen single index or 0
                if (_selectedFormatIndices && _selectedFormatIndices.length === 1
                    && _selectedFormatIndices[0] >= 0
                    && _selectedFormatIndices[0] < preLines.length) {
                    focusIndices[_selectedFormatIndices[0]] = true;
                } else {
                    // Prefer current line among last-good if possible
                    focusIndices[0] = true;
                }
            }

            let olNum = 1;
            const postLines = [];
            for (let i = 0; i < preLines.length; i++) {
                let raw = preLines[i];
                if (focusIndices[i] && String(raw || '').trim()) {
                    const n = olNum;
                    if ((type === 'ol' || type === 'ordered') && forceOn) olNum++;
                    raw = transformRawForFormat(raw, type, {
                        forceOff: forceOff,
                        forceOn: forceOn,
                        olNum: n
                    });
                }
                if (String(preLines[i] || '').trim() && !String(raw || '').trim()) {
                    raw = preLines[i];
                }
                postLines.push(raw == null ? '' : coerceBlockRaw(raw));
            }

            const preNonEmpty = preLines.filter(function (x) { return String(x || '').trim(); }).length;
            const postNonEmpty = postLines.filter(function (x) { return String(x || '').trim(); }).length;
            if (preNonEmpty > 0 && postNonEmpty === 0) return false;

            const preContent = preLines.join('\n');
            const postContent = postLines.join('\n');
            if (preContent === postContent) return false;
            // Refuse blank reload
            if (!String(postContent || '').trim()) return false;

            if (typeof HistoryManager !== 'undefined') {
                HistoryManager.recordEditPair(preContent, postContent);
            }

            // Reload from KNOWN-GOOD post only (safe). Empty post was the wipe.
            // Prefer sticky line near first selected block so virt remount lands on target.
            const stickyFocus = (function () {
                const keys = Object.keys(focusIndices).map(Number).sort(function (a, b) { return a - b; });
                if (!keys.length) return 0;
                // Approximate document line from block index (1 line/block common case)
                let line = 1;
                for (let i = 0; i < keys[0] && i < preLines.length; i++) {
                    line += linesInBlockRaw(preLines[i]);
                }
                return line;
            })();
            const hm = typeof HistoryManager !== 'undefined' ? HistoryManager : null;
            const wasRestoring = hm ? hm.isRestoring : false;
            if (hm) hm.isRestoring = true;
            try {
                loadMarkdownContent(postContent, stickyFocus >= 1 ? { stickyLine: stickyFocus } : undefined);
            } finally {
                if (hm) hm.isRestoring = wasRestoring;
            }
            try {
                if (stickyFocus >= 1 && typeof restoreStickyDocumentLine === 'function') {
                    restoreStickyDocumentLine(stickyFocus);
                }
            } catch (eSt) {}

            _lastGoodDocRaws = postLines.slice();
            try {
                const idxs = Object.keys(focusIndices).map(Number).filter(function (n) {
                    return n >= 0 && n < postLines.length;
                }).sort(function (a, b) { return a - b; });
                _selectedFormatIndices = idxs.slice();
                _selectedFormatBlocks = idxs.map(function (i) {
                    return mountedBlockAtFormatIndex(i);
                }).filter(Boolean);
                if (_selectedFormatBlocks.length) {
                    currentActiveBlock = _selectedFormatBlocks[_selectedFormatBlocks.length - 1];
                } else if (idxs.length) {
                    // Ensure last selected model row is mounted under virt
                    try {
                        if (typeof ensureModelBlockVisible === 'function') {
                            ensureModelBlockVisible(idxs[idxs.length - 1], { topPad: 48 });
                        }
                        currentActiveBlock = mountedBlockAtFormatIndex(idxs[idxs.length - 1]);
                    } catch (eVis) {}
                }
                focusEditorNoScroll();
            } catch (e5) {}
            updateStats();
            updateOutline();
            return true;
        }

        /** Write format cache from current selection (call only while editor has a real gesture). */
        function snapshotFormatSelectionFromEditor() {
            if (state.mode === 'source') return;
            if (!editor) return;
            // Do not overwrite a good freeze with a destroyed post-toolbar selection
            if (_formatSelectionFrozen) return;
            const allBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
            if (!allBlocks.length) return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;

            // Refresh full-doc good snapshot when selection is collapsed (DOM still trustworthy)
            if (sel.isCollapsed) {
                refreshLastGoodDocRaws();
            }

            let indices;
            if (sel.isCollapsed) {
                const b = getAncestorBlock(sel.anchorNode);
                const bi = formatBlockIndex(b);
                if (bi < 0) return;
                indices = [bi];
            } else {
                indices = indicesFromSelectionAnchorFocus();
                if (!indices || !indices.length) return;
            }
            _selectedFormatIndices = indices.slice();
            _selectedFormatBlocks = indices.map(function (i) {
                return mountedBlockAtFormatIndex(i);
            }).filter(Boolean);
            captureFormatRawsForIndices(_selectedFormatIndices, allBlocks);
            // If multi-select raws are all empty but last-good has text, use last-good for those indices
            for (let i = 0; i < indices.length; i++) {
                const bi = indices[i];
                if (!String(_selectedFormatRaws[bi] || '').trim()
                    && _lastGoodDocRaws[bi] != null
                    && String(_lastGoodDocRaws[bi]).trim()) {
                    _selectedFormatRaws[bi] = _lastGoodDocRaws[bi];
                }
                if (!String(_selectedFormatRaws[bi] || '').trim()
                    && typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                    && DocumentModel.blocks[bi]
                    && String(DocumentModel.blocks[bi].raw || '').trim()) {
                    _selectedFormatRaws[bi] = DocumentModel.blocks[bi].raw;
                }
            }
            _formatSelectionFrozen = false;
        }

        function freezeFormatSelection() {
            // Capture raws once more if we have indices but no raws yet (still in editor)
            if (_selectedFormatIndices.length && editor) {
                try {
                    const allBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
                    if (!Object.keys(_selectedFormatRaws).length) {
                        captureFormatRawsForIndices(_selectedFormatIndices, allBlocks);
                    }
                    // Fill empties from last-good / model
                    for (let i = 0; i < _selectedFormatIndices.length; i++) {
                        const bi = _selectedFormatIndices[i];
                        if (!String(_selectedFormatRaws[bi] || '').trim()
                            && _lastGoodDocRaws[bi] != null
                            && String(_lastGoodDocRaws[bi]).trim()) {
                            _selectedFormatRaws[bi] = _lastGoodDocRaws[bi];
                        }
                        if (!String(_selectedFormatRaws[bi] || '').trim()
                            && typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                            && DocumentModel.blocks[bi]
                            && String(DocumentModel.blocks[bi].raw || '').trim()) {
                            _selectedFormatRaws[bi] = DocumentModel.blocks[bi].raw;
                        }
                    }
                } catch (e) {}
            }
            _formatSelectionFrozen = true;
        }

        function getSelectedBlocks() {
            return getSelectedBlockIndices().map(function (i) {
                return mountedBlockAtFormatIndex(i);
            }).filter(Boolean);
        }

        /**
         * Indices for toolbar/format. After WPF steals focus, live selection is garbage —
         * always prefer frozen snapshot from last mouseup/keyup in the editor.
         * Indices are model indices when data-model-index is present (virt-safe).
         */
        function getSelectedBlockIndices() {
            const docN = formatDocBlockCount();
            if (!docN && !(editor && editor.querySelectorAll('.block').length)) return [];
            const clampN = Math.max(docN, editor ? editor.querySelectorAll('.block').length : 0);

            // Toolbar path: frozen cache only
            if (_formatSelectionFrozen && _selectedFormatIndices.length) {
                return _selectedFormatIndices.filter(function (n) {
                    return n >= 0 && n < clampN;
                });
            }

            // Still focused in editor: allow live snapshot
            const live = indicesFromSelectionAnchorFocus();
            const sel = window.getSelection();
            if (live && live.length && sel && sel.anchorNode && editor.contains(sel.anchorNode)) {
                // Do not trust a live range that covers the entire document unless
                // the user actually selected everything (cache matches) or it's a single block.
                if (!_formatSelectionFrozen) {
                    _selectedFormatIndices = live.slice();
                }
                return live.filter(function (n) { return n >= 0 && n < clampN; });
            }

            if (_selectedFormatIndices.length) {
                return _selectedFormatIndices.filter(function (n) {
                    return n >= 0 && n < clampN;
                });
            }

            if (currentActiveBlock && editor.contains(currentActiveBlock)) {
                const bi = formatBlockIndex(currentActiveBlock);
                if (bi >= 0) return [bi];
            }
            return clampN ? [0] : [];
        }

        function getFormatTargetBlock() {
            const blocks = getSelectedBlocks();
            return blocks.length ? blocks[0] : null;
        }

        function cacheSelectedBlocks() {
            // selectionchange is noisy and fires with a destroyed range on toolbar click.
            // Only refresh when not frozen and selection is still inside the editor.
            if (_formatSelectionFrozen) return;
            if (state.mode === 'source') return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount) return;
            if (!sel.anchorNode || !editor.contains(sel.anchorNode)) {
                freezeFormatSelection();
                return;
            }
            snapshotFormatSelectionFromEditor();
        }

        /**
         * Transform one line/block of markdown for a format type.
         * opts: { forceOff, forceOn, olNum }
         */
        /**
         * Split a line into its block marker (with indentation) and the text after it.
         * Inline formatting must only ever touch the second part — wrapping the marker
         * turns "  6. g" into a paragraph and loses the list entirely.
         */
        function splitInlineFormatPrefix(raw) {
            const s = String(raw == null ? '' : raw);
            const marker = s.match(/^(\s*(?:#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]?\]\s*)?|\d+[.)]\s+))/);
            if (marker) return { prefix: marker[1], body: s.slice(marker[1].length) };
            const lead = s.match(/^\s*/)[0];   // plain line: keep its indentation too
            return { prefix: lead, body: s.slice(lead.length) };
        }

        function transformRawForFormat(raw, type, opts) {
            opts = opts || {};
            const forceOff = !!opts.forceOff;
            const forceOn = !!opts.forceOn;
            const olNum = opts.olNum != null ? opts.olNum : 1;
            raw = String(raw == null ? '' : raw);

            // Inline formats wrap the BODY ONLY, never the block's own marker.
            // "  6. g" used to become "**6. g**": the indent was trimmed away and the list
            // marker ended up inside the bold, so the line stopped being a list item at
            // all — nesting lost, numbering restarted, and the text was destroyed by the
            // next re-parse. Split the prefix off, wrap what follows, put it back.
            if (type === 'bold' || type === 'italic' || type === 'code' || type === 'strike') {
                const split = splitInlineFormatPrefix(raw);
                const prefix = split.prefix;
                const t = split.body.trim();
                let out;

                if (type === 'bold') {
                    out = /^\*\*[\s\S]*\*\*$/.test(t)
                        ? t.replace(/^\*\*([\s\S]*)\*\*$/, '$1')
                        : `**${t || 'bold text'}**`;
                }
                else if (type === 'italic') {
                    if (/^\*\*[\s\S]*\*\*$/.test(t)) out = `*${t}*`;   // don't mangle bold
                    else out = (/^\*[^*][\s\S]*\*$/.test(t) || (/^\*[\s\S]*\*$/.test(t) && !/^\*\*/.test(t)))
                        ? t.replace(/^\*([\s\S]*)\*$/, '$1')
                        : `*${t || 'italic text'}*`;
                }
                else if (type === 'strike') {
                    out = /^~~[\s\S]*~~$/.test(t)
                        ? t.replace(/^~~([\s\S]*)~~$/, '$1')
                        : `~~${t || 'struck text'}~~`;
                }
                else {
                    out = /^`[\s\S]*`$/.test(t) ? t.slice(1, -1) : `\`${t || 'code'}\``;
                }
                return prefix + out;
            }
            if (type === 'h1') {
                const isH1 = /^#\s+/.test(raw) && !/^##/.test(raw);
                // forceOff / toggle-off when already H1; forceOn always applies
                if (forceOff || (!forceOn && isH1)) return raw.replace(/^#\s+/, '');
                const body = (stripBlockPrefix(raw) || String(raw || '').replace(/^#{1,6}\s+/, '').trim() || 'Heading 1');
                return `# ${body}`;
            }
            if (type === 'h2') {
                const isH2 = /^##\s+/.test(raw) && !/^###/.test(raw);
                if (forceOff || (!forceOn && isH2)) return raw.replace(/^##\s+/, '');
                const body = (stripBlockPrefix(raw) || String(raw || '').replace(/^#{1,6}\s+/, '').trim() || 'Heading 2');
                return `## ${body}`;
            }
            if (type === 'h3') {
                const isH3 = /^###\s+/.test(raw) && !/^####/.test(raw);
                if (forceOff || (!forceOn && isH3)) return raw.replace(/^###\s+/, '');
                const body = (stripBlockPrefix(raw) || String(raw || '').replace(/^#{1,6}\s+/, '').trim() || 'Heading 3');
                return `### ${body}`;
            }
            if (type === 'h4') {
                const isH4 = /^####\s+/.test(raw) && !/^#####/.test(raw);
                if (forceOff || (!forceOn && isH4)) return raw.replace(/^####\s+/, '');
                const body = (stripBlockPrefix(raw) || String(raw || '').replace(/^#{1,6}\s+/, '').trim() || 'Heading 4');
                return `#### ${body}`;
            }
            if (type === 'h5') {
                const isH5 = /^#####\s+/.test(raw) && !/^######/.test(raw);
                if (forceOff || (!forceOn && isH5)) return raw.replace(/^#####\s+/, '');
                const body = (stripBlockPrefix(raw) || String(raw || '').replace(/^#{1,6}\s+/, '').trim() || 'Heading 5');
                return `##### ${body}`;
            }
            if (type === 'h6') {
                const isH6 = /^######\s+/.test(raw);
                if (forceOff || (!forceOn && isH6)) return raw.replace(/^######\s+/, '');
                const body = (stripBlockPrefix(raw) || String(raw || '').replace(/^#{1,6}\s+/, '').trim() || 'Heading 6');
                return `###### ${body}`;
            }
            if (type === 'quote') {
                const isQ = /^>\s+/.test(raw);
                if (forceOff || (!forceOn && isQ)) return raw.replace(/^>\s+/, '');
                const body = (stripBlockPrefix(raw) || String(raw || '').replace(/^>\s+/, '').trim() || 'Quote');
                return `> ${body}`;
            }
            if (type === 'list' || type === 'ol' || type === 'ordered' || type === 'checklist') {
                // Never stuff multi-line blobs into one list marker (breaks parse + can wipe DOM)
                if (String(raw).indexOf('\n') >= 0) {
                    let n = olNum;
                    return String(raw).split('\n').map((line) => {
                        const next = transformRawForFormat(line, type, {
                            forceOff: forceOff,
                            forceOn: forceOn,
                            olNum: n
                        });
                        if ((type === 'ol' || type === 'ordered') && forceOn && String(line).trim()) n++;
                        return next;
                    }).join('\n');
                }
            }
            if (type === 'list') {
                const cur = parseListLine(raw);
                if (forceOff || (!forceOn && cur && cur.kind === 'ul')) {
                    return cur ? (cur.body || '') : raw.replace(/^[-*+]\s+/, '');
                }
                let text;
                if (cur) {
                    text = String(cur.body || '');
                    if (!text.trim()) text = 'List item';
                } else {
                    text = stripBlockPrefix(raw) || String(raw || '').trim() || 'List item';
                }
                return formatListLine({ indent: cur ? cur.indent : 0, kind: 'ul', bullet: '-', body: text });
            }
            if (type === 'ol' || type === 'ordered') {
                const cur = parseListLine(raw);
                if (forceOff || (!forceOn && cur && cur.kind === 'ol')) {
                    return cur ? (cur.body || '') : raw.replace(/^\d+\.\s+/, '');
                }
                let text;
                if (cur) {
                    text = String(cur.body || '');
                    if (!text.trim()) text = 'List item';
                } else {
                    text = stripBlockPrefix(raw) || String(raw || '').trim() || 'List item';
                }
                return formatListLine({ indent: cur ? cur.indent : 0, kind: 'ol', num: olNum, body: text });
            }
            if (type === 'checklist') {
                const cur = parseListLine(raw);
                if (forceOff || (!forceOn && cur && cur.kind === 'task')) {
                    return cur ? (cur.body || '') : raw.replace(/^[-*+]\s+\[[ xX]?\]\s*/, '');
                }
                const wasChecked = cur && cur.kind === 'task' && cur.checked;
                let text;
                if (cur) {
                    text = String(cur.body || '');
                    if (!text.trim()) text = 'Task item';
                } else {
                    text = stripBlockPrefix(raw) || String(raw || '').trim() || 'Task item';
                }
                return formatListLine({
                    indent: cur ? cur.indent : 0,
                    kind: 'task',
                    checked: wasChecked && !forceOn,
                    body: text
                });
            }
            if (type === 'link') {
                const t = stripBlockPrefix(raw) || 'Link Text';
                return `[${t}](https://)`;
            }
            return raw;
        }

        function applyFormatting(type) {
            if (type === 'table') {
                openTableSizePicker();
                return;
            }
            if (type === 'table_custom') {
                openTableCustomModal();
                return;
            }

            // Inline marks (bold / italic / code / link) — selection-accurate, not whole-block
            if (type === 'bold' || type === 'italic' || type === 'code' || type === 'link' || type === 'strike') {
                if (tryApplyInlineFormat(type)) return;
                // Fall through to whole-block wrap only if no usable selection
            }

            // --- Source mode: block formats (and multi-line) ---
            if (state.mode === 'source') {
                if (!sourceEditor) return;
                sourceEditor.focus();
                const start = sourceEditor.selectionStart || 0;
                const end = sourceEditor.selectionEnd || 0;
                const full = sourceEditor.value;
                const sel = full.substring(start, end);

                // Expand to full lines when selection spans multiple lines or is a block format
                const blockTypes = { h1:1, h2:1, h3:1, h4:1, h5:1, h6:1, quote:1, list:1, ol:1, ordered:1, checklist:1 };
                let s = start, e = end;
                if (blockTypes[type] || sel.indexOf('\n') >= 0) {
                    while (s > 0 && full.charAt(s - 1) !== '\n') s--;
                    while (e < full.length && full.charAt(e) !== '\n') e++;
                }
                const chunk = full.substring(s, e);
                const lines = chunk.split('\n');
                const nonEmpty = lines.filter(l => l.trim().length > 0);
                const sample = nonEmpty.length ? nonEmpty : lines;

                let forceOff = false, forceOn = false;
                if (type === 'list') {
                    forceOff = sample.every(l => {
                        if (!l.trim()) return true;
                        const p = parseListLine(l);
                        return p && p.kind === 'ul';
                    });
                    forceOn = !forceOff;
                } else if (type === 'ol' || type === 'ordered') {
                    forceOff = sample.every(l => {
                        if (!l.trim()) return true;
                        const p = parseListLine(l);
                        return p && p.kind === 'ol';
                    });
                    forceOn = !forceOff;
                } else if (type === 'checklist') {
                    forceOff = sample.every(l => {
                        if (!l.trim()) return true;
                        const p = parseListLine(l);
                        return p && p.kind === 'task';
                    });
                    forceOn = !forceOff;
                }

                let olNum = 1;
                const out = lines.map(line => {
                    if (!line.trim() && lines.length > 1) return line; // keep blank separators
                    const next = transformRawForFormat(line, type, { forceOff, forceOn, olNum });
                    if ((type === 'ol' || type === 'ordered') && forceOn && line.trim()) olNum++;
                    return next;
                }).join('\n');

                HistoryManager.beginEdit();
                sourceEditor.setRangeText(out, s, e, 'select');
                resizeSourceEditor();
                updateStats();
                HistoryManager.commitEdit();
                return;
            }

            // --- Live Preview: block-level formats ---
            let targets = getSelectedBlocks();
            const selectedModelIdx = getSelectedBlockIndices();
            // Virt: selection may include off-window model rows with no mounted .block
            if (!targets.length && (!selectedModelIdx || !selectedModelIdx.length)) {
                // Never invent a blank block when selection was lost (wipe / empty format).
                return;
            }

            // Prefer safe reads (frozen raw / model) — getBlockRaw alone can be empty after multi-select
            const raws = selectedModelIdx.length
                ? selectedModelIdx.map(function (bi) {
                    const el = mountedBlockAtFormatIndex(bi);
                    if (el) return readBlockRawSafe(el);
                    if (_selectedFormatRaws && _selectedFormatRaws[bi] != null
                        && String(_selectedFormatRaws[bi]).trim()) {
                        return coerceBlockRaw(_selectedFormatRaws[bi]);
                    }
                    if (_lastGoodDocRaws && _lastGoodDocRaws[bi] != null
                        && String(_lastGoodDocRaws[bi]).trim()) {
                        return coerceBlockRaw(_lastGoodDocRaws[bi]);
                    }
                    if (typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                        && DocumentModel.blocks[bi]) {
                        return coerceBlockRaw(DocumentModel.blocks[bi].raw || '');
                    }
                    return '';
                })
                : targets.map(function (b) { return readBlockRawSafe(b); });
            let forceOff = false, forceOn = false;
            if (type === 'list') {
                forceOff = raws.every(r => {
                    if (!String(r).trim()) return true;
                    const p = parseListLine(r);
                    return p && p.kind === 'ul';
                });
                if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
                else forceOn = !forceOff;
            } else if (type === 'ol' || type === 'ordered') {
                forceOff = raws.every(r => {
                    if (!String(r).trim()) return true;
                    const p = parseListLine(r);
                    return p && p.kind === 'ol';
                });
                if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
                else forceOn = !forceOff;
            } else if (type === 'checklist') {
                forceOff = raws.every(r => {
                    if (!String(r).trim()) return true;
                    const p = parseListLine(r);
                    return p && p.kind === 'task';
                });
                if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
                else forceOn = !forceOff;
            } else if (/^h[1-6]$/.test(type)) {
                // force ON unless every non-empty line is already exactly that heading level
                const level = parseInt(type.slice(1), 10) || 1;
                forceOff = raws.every(r => {
                    if (!String(r).trim()) return true;
                    const m = String(r).match(/^(#{1,6})\s+/);
                    return m && m[1].length === level;
                });
                if (raws.every(r => !String(r).trim())) {
                    // Nothing to format — do not invent "###### Heading 6" placeholder lines
                    return;
                }
                forceOn = !forceOff;
            } else if (type === 'quote') {
                forceOff = raws.every(r => {
                    if (!String(r).trim()) return true;
                    return /^>\s+/.test(String(r));
                });
                if (raws.every(r => !String(r).trim())) { forceOff = false; forceOn = true; }
                else forceOn = !forceOff;
            }

            const fmtOpts = { forceOff, forceOn, olNum: 1 };
            const isHeading = /^h[1-6]$/.test(type);
            const isListType = (type === 'list' || type === 'ol' || type === 'ordered' || type === 'checklist');
            const virtMulti = (typeof DocumentModel !== 'undefined' && DocumentModel.virtEnabled
                && selectedModelIdx && selectedModelIdx.length > 1);
            const modelOnly = !targets.length && selectedModelIdx && selectedModelIdx.length > 0;

            /*
             * List / multi-block formats: IN-PLACE write only.
             * mutateDocumentMarkdown + loadMarkdownContent was the wipe path when
             * multi-select had already emptied data-raw — empty snapshot reloaded a blank doc.
             * Virt multi-select uses model indices (not mounted DOM ordinals).
             */
            if (isListType || targets.length > 1 || virtMulti || modelOnly
                || (selectedModelIdx && selectedModelIdx.length > 1)) {
                applyFormatInPlaceToSelection(type, forceOff, forceOn);
                return;
            }

            // Single-block path: refuse if we have no real text (avoids "###### Heading 6" inserts)
            if (raws.every(function (r) { return !String(r || '').trim(); })) {
                return;
            }

            HistoryManager.beginEdit();

            // Selection-aware path: heading/quote on part of one block → split, format only that part
            if ((isHeading || type === 'quote') && targets.length === 1) {
                const splitBlocks = trySplitAndFormatBlock(targets[0], type, fmtOpts);
                if (splitBlocks && splitBlocks.length) {
                    targets = splitBlocks;
                    _selectedFormatBlocks = targets.slice();
                    currentActiveBlock = targets[targets.length - 1];
                    try {
                        currentActiveBlock.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                        const sel = window.getSelection();
                        if (sel && targets.length > 0) {
                            const r = document.createRange();
                            const focusEl = currentActiveBlock;
                            r.selectNodeContents(focusEl);
                            sel.removeAllRanges();
                            sel.addRange(r);
                        }
                        focusEditorNoScroll();
                    } catch (e) {
                        try { focusBlock(currentActiveBlock, null); } catch (e2) {}
                    }
                    updateStats();
                    updateOutline();
                    HistoryManager.commitEdit();
                    return;
                }
            }

            let olNum = 1;
            for (let i = 0; i < targets.length; i++) {
                const block = targets[i];
                // Use safe raw — getBlockRaw alone is often empty after toolbar focus steal
                const raw = readBlockRawSafe(block);
                if (!String(raw).trim()) continue;
                // Multi-line blob in one block (Shift+Enter etc.): format line(s) at caret/selection only
                if (String(raw).indexOf('\n') >= 0 && targets.length === 1
                    && (isHeading || type === 'quote')) {
                    const lineBlocks = formatLinesInBlock(block, type, { forceOff, forceOn, olNum });
                    if (lineBlocks) {
                        targets = lineBlocks;
                        break;
                    }
                }
                const next = transformRawForFormat(raw, type, { forceOff, forceOn, olNum });
                // Never write empty over non-empty, or invent placeholder-only lines
                if (!String(next || '').trim()) continue;
                if (/^#{1,6}\s+Heading\s+[1-6]\s*$/.test(String(next))
                    && String(raw).trim()
                    && !/^#{1,6}\s+Heading\s+[1-6]\s*$/.test(String(raw))) {
                    // Placeholder invented despite having real raw — re-apply with raw body
                    const body = stripBlockPrefix(raw) || String(raw).replace(/^#{1,6}\s+/, '').trim();
                    if (body) {
                        const fixed = transformRawForFormat(body, type, { forceOff: false, forceOn: true, olNum });
                        writeBlockRaw(block, fixed);
                        if ((type === 'ol' || type === 'ordered') && forceOn) olNum++;
                        continue;
                    }
                }
                if ((type === 'ol' || type === 'ordered') && forceOn) olNum++;
                writeBlockRaw(block, next);
            }

            _selectedFormatBlocks = targets.slice();
            currentActiveBlock = targets[targets.length - 1];
            try {
                currentActiveBlock.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                // Restore a selection spanning all formatted blocks so user sees multi-select result
                const sel = window.getSelection();
                if (sel && targets.length > 0) {
                    const r = document.createRange();
                    r.setStartBefore(targets[0]);
                    r.setEndAfter(targets[targets.length - 1]);
                    sel.removeAllRanges();
                    sel.addRange(r);
                }
                // Re-focus editor without collapsing multi-select via focusBlock
                focusEditorNoScroll();
            } catch (e) {
                try { focusBlock(currentActiveBlock, null); } catch (e2) {}
            }
            updateStats();
            updateOutline();
            HistoryManager.commitEdit();
        }

        /** Plain offsets for the current (or cached) selection inside a block. */
        function resolveBlockPlainOffsets(block) {
            if (!block) return null;
            let off = getPlainOffsetsInBlock(block);
            if (off && off.start !== off.end) return off;
            if (_inlineSelCache && _inlineSelCache.block === block
                && _inlineSelCache.start !== _inlineSelCache.end) {
                return {
                    start: _inlineSelCache.start,
                    end: _inlineSelCache.end,
                    text: _inlineSelCache.text
                };
            }
            // Collapsed caret → still useful for multi-line "current line"
            if (off) return off;
            const sel = window.getSelection();
            if (sel && sel.rangeCount && sel.isCollapsed
                && block.contains(sel.anchorNode)) {
                try {
                    const range = sel.getRangeAt(0);
                    const pre = document.createRange();
                    pre.selectNodeContents(block);
                    pre.setEnd(range.startContainer, range.startOffset);
                    const pos = pre.toString().length;
                    return { start: pos, end: pos, text: '' };
                } catch (e) {}
            }
            return null;
        }

        /**
         * If the user selected only part of a paragraph, split into before/mid/after
         * and apply block format (heading/quote) to mid only. Returns new block list
         * or null to fall back to whole-block format.
         */
        function trySplitAndFormatBlock(block, type, opts) {
            const raw = typeof readBlockRawSafe === 'function' ? readBlockRawSafe(block) : getBlockRaw(block);
            if (raw == null || !String(raw).trim()) return null;

            // Multi-line content handled by formatLinesInBlock
            if (String(raw).indexOf('\n') >= 0) {
                return formatLinesInBlock(block, type, opts);
            }

            const off = resolveBlockPlainOffsets(block);
            if (!off || off.start === off.end) return null;

            // Full-block selection → normal whole-block path
            const plainLen = (function () {
                try {
                    const r = document.createRange();
                    r.selectNodeContents(block);
                    return r.toString().length;
                } catch (e) {
                    return String(raw).length;
                }
            })();
            if (off.start <= 0 && off.end >= plainLen) return null;

            const { r0, r1 } = plainRangeToRawOffsets(raw, off.start, off.end);
            let before = raw.slice(0, r0);
            let mid = raw.slice(r0, r1);
            let after = raw.slice(r1);
            if (!String(mid).trim()) return null;

            // Keep adjacent spaces on the outer pieces so mid is clean for heading text
            const lead = mid.match(/^\s*/);
            const trail = mid.match(/\s*$/);
            if (lead && lead[0]) {
                before += lead[0];
                mid = mid.slice(lead[0].length);
            }
            if (trail && trail[0]) {
                after = trail[0] + after;
                mid = mid.slice(0, mid.length - trail[0].length);
            }
            if (!mid) return null;

            const formatted = transformRawForFormat(mid, type, opts || {});
            const pieces = [];
            if (before.length) pieces.push(before);
            pieces.push(formatted);
            if (after.length) pieces.push(after);

            const blocks = replaceBlockWithPieces(block, pieces);
            // Point current at the formatted piece
            const fmtIdx = before.length ? 1 : 0;
            if (blocks[fmtIdx]) currentActiveBlock = blocks[fmtIdx];
            return blocks;
        }

        /**
         * Block contains hard newlines (Shift+Enter, etc.): apply format only to
         * the line(s) intersecting the selection/caret, then split into real blocks.
         */
        function formatLinesInBlock(block, type, opts) {
            const raw = String(
                (typeof readBlockRawSafe === 'function' ? readBlockRawSafe(block) : getBlockRaw(block)) || ''
            );
            if (raw.indexOf('\n') < 0) return null;

            const lines = raw.split('\n');
            const off = resolveBlockPlainOffsets(block);

            // Map plain offsets → line index range (block text uses \n as one plain char)
            let lineStart = 0;
            let lineEnd = lines.length - 1;
            if (off) {
                const p0 = Math.min(off.start, off.end);
                const p1 = Math.max(off.start, off.end);
                let pos = 0;
                let foundS = false;
                lineStart = 0;
                lineEnd = lines.length - 1;
                for (let i = 0; i < lines.length; i++) {
                    const a = pos;
                    const b = pos + lines[i].length;
                    if (!foundS && p0 <= b) {
                        lineStart = i;
                        foundS = true;
                    }
                    if (foundS) {
                        // caret: only this line; range: last line that starts before p1
                        if (off.start === off.end) {
                            lineEnd = i;
                            break;
                        }
                        if (p1 > a) lineEnd = i;
                        if (p1 <= b) break;
                    }
                    pos = b + 1; // + newline
                }
                if (!foundS) {
                    lineStart = 0;
                    lineEnd = lines.length - 1;
                }
            }

            opts = opts || {};
            let olNum = opts.olNum != null ? opts.olNum : 1;
            const out = lines.map((line, i) => {
                if (i < lineStart || i > lineEnd) return line;
                if (!line.trim() && lineStart !== lineEnd) return line;
                const next = transformRawForFormat(line, type, {
                    forceOff: opts.forceOff,
                    forceOn: opts.forceOn,
                    olNum: olNum
                });
                if ((type === 'ol' || type === 'ordered') && opts.forceOn && line.trim()) olNum++;
                return next;
            });

            const blocks = replaceBlockWithPieces(block, out);
            // Focus first formatted non-empty line
            for (let i = lineStart; i <= lineEnd && i < blocks.length; i++) {
                if (String(out[i] || '').trim()) {
                    currentActiveBlock = blocks[i];
                    break;
                }
            }
            return blocks;
        }

        /**
         * Replace one .block with sequential blocks for each piece string.
         * If any piece is a list line, rebuild via markdown (safe). Otherwise
         * in-place createBlock is OK for headings/paragraphs.
         */
        function replaceBlockWithPieces(block, pieces) {
            if (!pieces || !pieces.length) pieces = [''];
            const anyList = pieces.some(function (p) { return isListLine(p); });
            if (anyList && editor) {
                // A model index, because that is what the mutator is indexed by now. This
                // was allBlocks.indexOf(block) -- the position among mounted blocks -- which
                // is the same number only while the window starts at block 0.
                const idx = (typeof DocumentModel !== 'undefined')
                    ? DocumentModel.modelIndexOfEl(block) : -1;
                if (idx >= 0) {
                    const focusIndices = {};
                    focusIndices[idx] = true;
                    mutateDocumentMarkdown(function (raw, index) {
                        if (index === idx) return pieces.slice();
                        return raw;
                    }, { focusIndices: focusIndices });
                    // One block expanded to pieces.length lines at the same model index.
                    // Resolved back through the DOM, since the reload remounts and the
                    // mounted window need not start where it did.
                    const out = [];
                    for (let k = 0; k < pieces.length; k++) {
                        const el = editor.querySelector('.block[data-model-index="' + (idx + k) + '"]');
                        if (el) out.push(el);
                    }
                    if (out.length) return out;
                    const newBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
                    return newBlocks.slice(0, pieces.length);
                }
            }
            writeBlockRaw(block, pieces[0]);
            const result = [block];
            let prev = block;
            for (let i = 1; i < pieces.length; i++) {
                const nb = createBlock(pieces[i], prev);
                result.push(nb);
                prev = nb;
            }
            return result;
        }

        const HistoryManager = {
            undoStack: [],
            redoStack: [],
            // Soft caps: small docs keep deep undo; large docs get fewer steps and a hard
            // byte budget so multi‑MB files cannot pin hundreds of MB of full snapshots.
            maxSize: 100,
            maxBytes: 24 * 1024 * 1024,      // ~24 MB undo+redo combined (UTF-16 code units ≈ chars)
            largeDocChars: 500 * 1024,      // ≥500 KB content → fewer steps
            hugeDocChars: 2 * 1024 * 1024,  // ≥2 MB → shallow history
            isRestoring: false,
            timer: null,
            // No time-based coalesce: JS is single-threaded so host+page double-fire is
            // sequential after stack already changed — coalescing by time blocked the next
            // intentional Ctrl+Z ("worked once then stopped"). Host skips inject when
            // WebView focused; menu uses short SendHistoryCmd debounce only.
            _lastNavAt: 0,

            /** Approximate document character count from a stacked state string. */
            _docCharsFromState(stateStr) {
                try {
                    const c = this._contentOf(stateStr);
                    return c ? c.length : 0;
                } catch (e) {
                    return stateStr ? stateStr.length : 0;
                }
            },

            /**
             * Step cap by document size. Small notes keep ~100; large files keep less
             * so each full-document snapshot does not multiply into huge RAM use.
             */
            _effectiveMaxSize(docChars) {
                if (docChars >= this.hugeDocChars) return 12;
                if (docChars >= this.largeDocChars) return 24;
                if (docChars >= 16000) return 48; // plain/Source open threshold class
                return this.maxSize;
            },

            _stackBytes() {
                let n = 0;
                for (let i = 0; i < this.undoStack.length; i++) {
                    if (this.undoStack[i]) n += this.undoStack[i].length;
                }
                for (let i = 0; i < this.redoStack.length; i++) {
                    if (this.redoStack[i]) n += this.redoStack[i].length;
                }
                return n;
            },

            /**
             * Enforce step count + total byte budget. Always keep at least one undo frame
             * when possible so the first Ctrl+Z after load still has a baseline.
             */
            _trimStacks() {
                let docChars = 0;
                if (this.undoStack.length) {
                    docChars = this._docCharsFromState(
                        this.undoStack[this.undoStack.length - 1]
                    );
                } else if (this.redoStack.length) {
                    docChars = this._docCharsFromState(this.redoStack[this.redoStack.length - 1]);
                }
                const maxN = this._effectiveMaxSize(docChars);
                while (this.undoStack.length > maxN) this.undoStack.shift();
                while (this.redoStack.length > maxN) this.redoStack.shift();

                // Drop oldest undo first (keep recent history), then redo.
                while (this._stackBytes() > this.maxBytes && this.undoStack.length > 1) {
                    this.undoStack.shift();
                }
                while (this._stackBytes() > this.maxBytes && this.redoStack.length > 0) {
                    this.redoStack.shift();
                }
            },

            /**
             * Block index + plain offset (or source selection) so undo does not jump to top.
             * blockIndex is a **model** index when data-model-index is stamped (virt-safe).
             * Mounted-DOM ordinals break under virt (window starts mid-document).
             */
            _captureCaret() {
                try {
                    if (state.mode === 'source' && sourceEditor) {
                        return {
                            mode: 'source',
                            start: sourceEditor.selectionStart | 0,
                            end: sourceEditor.selectionEnd | 0
                        };
                    }
                    if (!editor) return null;
                    const blocks = editor.querySelectorAll('.block');
                    if (!blocks.length) return { mode: 'wysiwyg', blockIndex: 0, offset: 0 };
                    let block = null;
                    const sel = window.getSelection();
                    if (sel && sel.anchorNode && editor.contains(sel.anchorNode)) {
                        block = getAncestorBlock(sel.anchorNode);
                    }
                    if (!block && currentActiveBlock && editor.contains(currentActiveBlock)) {
                        block = currentActiveBlock;
                    }
                    if (!block) block = blocks[0];
                    let idx = -1;
                    try {
                        if (typeof formatBlockIndex === 'function') {
                            idx = formatBlockIndex(block);
                        } else if (typeof DocumentModel !== 'undefined') {
                            idx = DocumentModel.modelIndexOfEl(block);
                        }
                    } catch (eMi) { idx = -1; }
                    if (idx < 0) idx = Array.prototype.indexOf.call(blocks, block);
                    if (idx < 0) idx = 0;
                    let offset = 0;
                    try {
                        if (typeof getPlainOffsetsInBlock === 'function') {
                            const off = getPlainOffsetsInBlock(block);
                            if (off && off.start != null) offset = off.start | 0;
                        }
                    } catch (e) {}
                    return { mode: 'wysiwyg', blockIndex: idx, offset: offset };
                } catch (e) {
                    return null;
                }
            },

            _restoreCaret(caret) {
                try {
                    if (!caret) return;
                    if (caret.mode === 'source' && sourceEditor) {
                        const n = sourceEditor.value.length;
                        let s = caret.start | 0;
                        let e = caret.end != null ? (caret.end | 0) : s;
                        if (s < 0) s = 0;
                        if (e < 0) e = 0;
                        if (s > n) s = n;
                        if (e > n) e = n;
                        sourceEditor.focus();
                        sourceEditor.setSelectionRange(s, e);
                        if (typeof resizeSourceEditor === 'function') {
                            try { resizeSourceEditor(); } catch (e2) {}
                        }
                        return;
                    }
                    if (!editor) return;
                    let idx = caret.blockIndex | 0;
                    if (idx < 0) idx = 0;
                    const off = caret.offset != null ? (caret.offset | 0) : 0;

                    // Model-aware path: mount target under virt, then focus.
                    let block = null;
                    const modelN = (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
                        ? DocumentModel.blocks.length : 0;
                    if (modelN > 0) {
                        if (idx >= modelN) idx = modelN - 1;
                        try {
                            if (typeof ensureModelBlockVisible === 'function') {
                                block = ensureModelBlockVisible(idx, { topPad: 48 });
                            }
                        } catch (eVis) {}
                        if (!block && typeof mountedBlockAtFormatIndex === 'function') {
                            try { block = mountedBlockAtFormatIndex(idx); } catch (eM) {}
                        }
                        if (!block) {
                            block = editor.querySelector('.block[data-model-index="' + idx + '"]');
                        }
                    }
                    // Fallback: full mount / legacy snapshots without model indices
                    if (!block) {
                        const blocks = editor.querySelectorAll('.block');
                        if (!blocks.length) return;
                        if (idx >= blocks.length) idx = blocks.length - 1;
                        block = blocks[idx];
                    }
                    if (!block) return;
                    currentActiveBlock = block;
                    try { focusBlock(block, off); } catch (e3) {
                        focusEditorNoScroll();
                    }
                    try {
                        // Prefer main-container geometry under virt; scrollIntoView as backup
                        if (!(typeof DocumentModel !== 'undefined' && DocumentModel.virtEnabled)) {
                            block.scrollIntoView({ block: 'nearest', behavior: 'auto' });
                        }
                    } catch (e5) {}
                } catch (e) {}
            },

            _stateFromContent(content, caret) {
                const c = caret !== undefined ? caret : this._captureCaret();
                return JSON.stringify({
                    content: content == null ? '' : String(content),
                    mode: state.mode || 'wysiwyg',
                    caret: c
                });
            },

            _capture() {
                // Pure read — expandAllFragmentedBlocks on a multi‑thousand-line doc
                // freezes the UI (and was the bulk-delete "crash").
                return this._stateFromContent(getMarkdownContent(false));
            },

            _contentOf(stateStr) {
                try {
                    const o = JSON.parse(stateStr);
                    return o && o.content != null ? String(o.content) : '';
                } catch (e) {
                    return '';
                }
            },

            /** Compare history contents ignoring trailing whitespace / \r (serialize noise). */
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
                } catch (e) {
                    return null;
                }
            },

            _push(stateStr, clearRedo) {
                if (!stateStr) return;
                if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== stateStr) {
                    this.undoStack.push(stateStr);
                    if (clearRedo) this.redoStack = [];
                    this._trimStacks();
                }
            },

            _flushTimer() {
                if (this.timer) {
                    clearTimeout(this.timer);
                    this.timer = null;
                }
            },

            /**
             * List/reload edits: push pre then post from known strings (not DOM re-read).
             * One undo step returns to preContent exactly.
             */
            recordEditPair(preContent, postContent) {
                if (this.isRestoring) return;
                this._flushTimer();
                // DOM still has pre content here — capture caret before reload
                const caret = this._captureCaret();
                const pre = this._stateFromContent(preContent, caret);
                const post = this._stateFromContent(postContent, caret);
                // Do not record a no-op (compare content only; caret may differ)
                if (String(preContent || '') === String(postContent || '')) return;
                // Never put an empty pre on the stack if we still have a non-empty top
                // (empty pre was the "undo wiped the doc" failure mode).
                const preEmpty = !String(preContent || '').trim();
                const top = this.undoStack.length ? this.undoStack[this.undoStack.length - 1] : null;
                const topContent = top ? this._contentOf(top) : '';
                if (preEmpty && String(topContent).trim()) {
                    // Keep existing top as pre; only push post
                    this._push(post, true);
                    return;
                }
                // If top already is pre content, do not push a duplicate pre frame
                // (caret-only differences used to burn an extra Ctrl+Z). Refresh caret.
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

            /** Seed baseline so first Ctrl+Z has a previous state after load. */
            resetToCurrent() {
                this.clear();
                this.undoStack.push(this._capture());
                this._trimStacks();
            },

            /**
             * Call BEFORE mutating content (bold, paste, etc.).
             * Do NOT pair with mutateDocumentMarkdown (that uses recordEditPair).
             */
            beginEdit() {
                if (this.isRestoring) return;
                this._flushTimer();
                const cap = this._capture();
                const capContent = this._contentOf(cap);
                // Refuse empty snapshot when stack already has real content
                if (!String(capContent).trim() && this.undoStack.length) {
                    const topContent = this._contentOf(this.undoStack[this.undoStack.length - 1]);
                    if (String(topContent).trim()) return;
                }
                this._push(cap, false);
            },

            /**
             * Call AFTER mutating content. Pushes the new document state and
             * clears redo (a new edit branch).
             */
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
                        // Do not push empty over real content
                        return;
                    }
                }
                this._push(after, true);
            },

            /**
             * Typing / continuous edits: debounced commit of current state.
             * immediate=true is an alias for commitEdit() (post-mutation).
             */
            snapshot(immediate = false) {
                if (this.isRestoring) return;
                if (immediate) {
                    this.commitEdit();
                    return;
                }
                this._flushTimer();
                this.timer = setTimeout(() => {
                    this.timer = null;
                    if (this.isRestoring) return;
                    const cap = this._capture();
                    const capContent = this._contentOf(cap);
                    if (!String(capContent).trim() && this.undoStack.length) {
                        const topContent = this._contentOf(this.undoStack[this.undoStack.length - 1]);
                        if (String(topContent).trim()) return;
                    }
                    // Only real content changes — caret-only frames made later Ctrl+Z no-ops
                    // and clearRedo wiped the redo stack after a successful undo.
                    const topContent = this.undoStack.length
                        ? this._contentOf(this.undoStack[this.undoStack.length - 1])
                        : '';
                    if (this._sameContent(capContent, topContent)) return;
                    this._push(cap, true);
                }, 350);
            },

            canUndo() { return this.undoStack.length > 1; },
            canRedo() { return this.redoStack.length > 0; },

            undo() {
                this._flushTimer();
                // Save unsaved typing only if content truly differs from stack top.
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

                if (this.undoStack.length <= 1) return;
                this.isRestoring = true;
                try {
                    const current = this.undoStack.pop();
                    this.redoStack.push(current);
                    const currentHad = String(this._contentOf(current)).trim();
                    while (this.undoStack.length > 0) {
                        const prevStr = this.undoStack[this.undoStack.length - 1];
                        const prevContent = this._contentOf(prevStr);
                        // Drop empty frames only (not content-identical non-empty — that
                        // collapsed history so a second Ctrl+Z had nothing left).
                        if (!String(prevContent).trim() && currentHad) {
                            this.undoStack.pop();
                            continue;
                        }
                        // Put the cursor where the change was, not where it happened to be
                        // when the older state was captured. The restored state's own caret
                        // is, for the base state, wherever the file opened -- so undoing an
                        // edit on line 128 sent the cursor, and the view with it, to line 11.
                        // The caret stored with the state being undone is the edit site,
                        // which is the natural anchor for an undo.
                        let _editCaret = null;
                        try { _editCaret = this._caretOf(current); } catch (eC) {}
                        this.restore(prevStr, _editCaret);

                        // Resync top to live serialize so the next Ctrl+Z is not a no-op
                        try {
                            const actual = getMarkdownContent();
                            const top = this.undoStack[this.undoStack.length - 1];
                            if (top && !this._sameContent(actual, this._contentOf(top))) {
                                const caret = this._caretOf(top);
                                this.undoStack[this.undoStack.length - 1] =
                                    this._stateFromContent(actual, caret);
                            }
                        } catch (e) {}
                        this._trimStacks();
                        return;
                    }
                    // Nothing non-empty left — restore current back
                    this.undoStack.push(current);
                    this.redoStack.pop();
                } finally {
                    this.isRestoring = false;
                }
            },

            redo() {
                if (this.redoStack.length === 0) return;
                this._flushTimer();
                this.isRestoring = true;
                try {
                    const nextStr = this.redoStack.pop();
                    this.undoStack.push(nextStr);
                    this._trimStacks();
                    this.restore(nextStr);
                    try {
                        const actual = getMarkdownContent();
                        const top = this.undoStack[this.undoStack.length - 1];
                        if (top && !this._sameContent(actual, this._contentOf(top))) {
                            const caret = this._caretOf(top);
                            this.undoStack[this.undoStack.length - 1] =
                                this._stateFromContent(actual, caret);
                        }
                    } catch (e) {}
                } finally {
                    this.isRestoring = false;
                }
            },

            restore(stateStr, caretOverride) {
                if (!stateStr) return;
                try {
                    let data;
                    try {
                        data = JSON.parse(stateStr);
                    } catch (e) {
                        data = null;
                    }
                    // caretOverride lets undo place the cursor at the edit site instead of
                    // wherever the restored state's own caret happened to be. It has to go
                    // through here: restore() schedules its caret work in a rAF, so a
                    // correction applied afterwards was overwritten a frame later.
                    const caret = caretOverride
                        || (data && data.caret ? data.caret : this._caretOf(stateStr));
                    // Legacy: bare array of block strings
                    if (Array.isArray(data)) {
                        editor.innerHTML = '';
                        for (let i = 0; i < data.length; i++) createBlock(data[i]);
                        if (sourceEditor) sourceEditor.value = data.join('\n');
                    } else if (data && typeof data.content === 'string') {
                        const wantSource = data.mode === 'source';
                        // isRestoring already true from undo/redo — load must not resetToCurrent
                        loadMarkdownContent(data.content);
                        if (wantSource && state.mode !== 'source') {
                            sourceEditor.value = data.content;
                            editor.style.display = 'none';
                            sourceEditor.style.display = 'block';
                            state.mode = 'source';
                            postMsg('mode_changed:source');
                            requestAnimationFrame(resizeSourceEditor);
                        } else if (!wantSource && state.mode === 'source') {
                            sourceEditor.style.display = 'none';
                            editor.style.display = 'block';
                            state.mode = 'wysiwyg';
                            postMsg('mode_changed:wysiwyg');
                        } else if (state.mode === 'source') {
                            sourceEditor.value = data.content;
                            requestAnimationFrame(resizeSourceEditor);
                        }
                        // The branches above swap which element is visible and set
                        // state.mode, but that is only half a mode switch: the container's
                        // overflow, padding and pagination class all belong to the mode too.
                        // Undoing an edit made in Source, back to a state captured in
                        // Preview, therefore showed the preview inside a container still
                        // carrying Source's overflow-y: hidden -- the document was editable
                        // and completely unscrollable until the mode was toggled by hand.
                        try { syncPaginationClass(); } catch (eP) {}
                        try { applyEditorChromeForMode(); } catch (eC) {}
                    }
                    updateStatsNow();
                    updateOutline();
                    scheduleSavePreferences();
                    // Keep the page numbers honest: a restore can leave them showing a
                    // stale count in a view that is no longer paginated.
                    try { updatePageIndicator(); } catch (ePI) {}
                    // Restore caret/block — never force first block (that was the jump-to-top bug)
                    if (caret) {
                        const self = this;
                        // After loadMarkdownContent DOM is ready; rAF helps focus stick
                        requestAnimationFrame(function () {
                            self._restoreCaret(caret);
                        });
                        this._restoreCaret(caret);
                    } else if (state.mode !== 'source' && editor && editor.firstElementChild) {
                        currentActiveBlock = editor.firstElementChild;
                    }
                } catch (e) {}
            }
        };

