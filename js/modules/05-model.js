// TypoZen module: 05-model.js
// Lines 8241-11012 of the former monolith. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.

        // --- WYSIWYG AST / BLOCK ENGINE ---

        // --- Document size thresholds (Stage D: no dual-use of one constant) ---
        // Stats / preferences throttling only — NOT open-mode or paint thresholds.
        // Size no longer chooses Source vs Preview (document type does); this name is the
        // only survivor of that era and only gates stats/prefs work.
        const LARGE_DOC_CHARS = 16000;
        // Design bands:
        //   S  full WYSIWYG (immediate paint)
        //   M  progressive paint (full DOM, deferred HTML) — block count only
        //   L/XL virt (viewport DOM) — never progressive
        // Virtualization: only when full Preview DOM is genuinely heavy.
        const VIRT_MIN_CHARS = 120000;   // ~120 KB of markdown
        const VIRT_MIN_BLOCKS = 2000;    // or many short lines
        // Progressive paint: full mount + batch renderBlockPreview. Not for L/XL (virt wins first).
        const PROGRESSIVE_PAINT_BLOCKS = 800;
        // Within M band: create .block nodes in rAF batches when count is still high but < virt.
        // Live window is ~1500..1999 blocks (virt takes over at 2000).
        const PROGRESSIVE_CREATE_BATCH_BLOCKS = 1500;

        /**
         * Host → page load commit.
         * Plain types (.txt/.log/.csv): Source textarea only — same cost class as Notepad.
         * Markdown of any size: WYSIWYG build via loadMarkdownContent(), which chooses
         * immediate paint, progressive paint, or virtualization by document size.
         */
        function finishLoadContent(content, markDirty, forcePlain) {
            content = content == null ? '' : String(content);
            // Source-vs-Preview is the HOST's decision, made by document type
            // (.txt/.log/.csv). This used to add "or >= LARGE_DOC_CHARS", a second copy
            // of a size rule the host also had — so every markdown file over 16 KB was
            // forced into Source and had virtualization switched off below, making the
            // virtualized Preview unreachable on open. loadMarkdownContent() picks the
            // right strategy for the size itself: virt for L/XL, progressive paint for M.
            const large = !!forcePlain;
            // Cancel any in-flight progressive paint from a previous document.
            window.__tzPaintGen = (window.__tzPaintGen || 0) + 1;

            if (large) {
                // Instant path: source is the live buffer; defer WYSIWYG build entirely.
                window.__tzDeferredWysiwyg = content;
                _contentCache = content;
                const wasBookPlain = (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub');
                // Keep model in lockstep with the textarea so a stale previous document
                // (e.g. welcome Markdown) cannot be searched while Source shows the file.
                try { DocumentModel.fromMarkdown(content); } catch (eM) {}
                if (wasBookPlain) {
                    try { leaveBookViewForMarkdown(); } catch (eL) { try { clearBookSession(); } catch (eC) {} }
                } else {
                    try { clearBookSession(); } catch (eC2) {}
                }
                try { DocumentModel.virtEnabled = false; unbindVirtScroll(); } catch (eV) {}
                try { releaseDocumentStateForHost(); } catch (e0) {}
                if (editor) {
                    try { editor.innerHTML = ''; } catch (eE) {}
                }
                if (sourceEditor) {
                    sourceEditor.value = content;
                    try {
                        sourceEditor.setSelectionRange(0, 0);
                        sourceEditor.scrollTop = 0;
                    } catch (eSel) {}
                }
                // Force Source mode so the user sees the full text immediately.
                // Also apply view_set so host Mode chrome and state.mode stay aligned —
                // otherwise Ctrl+F still searched the old model while Source showed the file.
                try {
                    state.mode = 'source';
                    try { if (typeof syncModeSurface === 'function') syncModeSurface(); } catch (eSurf) {}
                    postMsg('mode_changed:source');
                    try { postViewState(currentViewState()); } catch (ePv) {}
                    try { if (typeof handleCommand === 'function') handleCommand('view_set:mode:source'); } catch (eVs) {}
                } catch (e2) {}
                try {
                    if (mainContainer) mainContainer.scrollTop = 0;
                } catch (eScr) {}
                state.lastSavedContent = markDirty ? '\0__session_unsaved__' : content;
                // Seed undo baseline immediately so typing before a deferred timer cannot
                // leave the stack without a "loaded file" frame.
                if (typeof HistoryManager !== 'undefined' && !HistoryManager.isRestoring) {
                    try {
                        HistoryManager.undoStack = [];
                        HistoryManager.redoStack = [];
                        HistoryManager._push(HistoryManager._stateFromContent(content), true);
                    } catch (e3) {}
                }
                _lastGoodDocRaws = [];
                _lastCaretLine = 1;
                currentActiveBlock = null;
                try {
                    if (typeof invalidateSearchForDocumentChange === 'function')
                        invalidateSearchForDocumentChange();
                } catch (eInv) {}
                // Different document: bookmark fingerprints cached for the old one are not
                // this one, and block count alone cannot always tell them apart.
                try {
                    if (typeof invalidateMarkCaches === 'function') invalidateMarkCaches();
                } catch (eMk) {}
                setTimeout(function () { try { updateStatsNow(); } catch (eS) {} }, 0);
                return;
            }

            window.__tzDeferredWysiwyg = null;
            // replaceBook: allow leaving an epub for real markdown/text content.
            loadMarkdownContent(content, { replaceBook: true });
            tzRequestPendingImages(editor);
            tzScheduleImageRescan();
            // Baseline from the model after mount (matches later dirty checks) without
            // a full DOM walk via getMarkdownContent. Raw host string alone caused false
            // Unsaved when markdown round-trip differed only by trailing newlines.
            if (markDirty) {
                state.lastSavedContent = '\0__session_unsaved__';
            } else {
                try {
                    state.lastSavedContent = (typeof DocumentModel !== 'undefined')
                        ? DocumentModel.toMarkdown() : content;
                } catch (e) {
                    state.lastSavedContent = content;
                }
            }
            if (state.mode === 'source' && sourceEditor) {
                sourceEditor.value = content;
            }
            try { if (typeof syncModeSurface === 'function') syncModeSurface(); } catch (eSurf2) {}
            try { postViewState(currentViewState()); } catch (ePv2) {}
            try {
                if (typeof invalidateSearchForDocumentChange === 'function')
                    invalidateSearchForDocumentChange();
            } catch (eInv2) {}
            // Fingerprints must be rebuilt against the document that just mounted, before
            // resolveMarksAfterDocumentLoad reads them.
            try {
                if (typeof invalidateMarkCaches === 'function') invalidateMarkCaches();
            } catch (eMk2) {}
            updateStatsNow();
        }

        // Invalidate in-flight progressive paints when a new document loads.
        window.__tzPaintGen = 0;

        /**
         * M-band only: paint markdown HTML onto already-mounted blocks in rAF batches.
         * L/XL never reach here (loadMarkdownContent returns early into virt).
         * Skips blocks marked data-tz-dirty (user edited during paint — data-raw wins).
         */
        function paintBlockPreviewsProgressive(paintGen, onDone) {
            const blocks = editor ? editor.querySelectorAll('.block') : [];
            let i = 0;
            const BATCH = 100;
            function step() {
                if (paintGen !== window.__tzPaintGen) return;
                const end = Math.min(i + BATCH, blocks.length);
                for (; i < end; i++) {
                    const b = blocks[i];
                    if (b.getAttribute('data-tz-dirty') === '1') continue;
                    const raw = b.getAttribute('data-raw') || '';
                    try {
                        renderBlockPreview(b, raw);
                        b.removeAttribute('data-tz-paint');
                    } catch (e) {}
                }
                if (i < blocks.length) {
                    requestAnimationFrame(step);
                } else if (typeof onDone === 'function') {
                    try { onDone(); } catch (e2) {}
                }
            }
            requestAnimationFrame(step);
        }

        /**
         * Split markdown into block raw strings (code fences + tables grouped).
         * Pure string work — no DOM. Used so progressive create can batch-append.
         */
        function splitMarkdownToBlockRaws(text) {
            const lines = String(text == null ? '' : text).split(/\r?\n/);
            const out = [];
            let currentCodeBlock = null;
            let currentTableBlock = null;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.startsWith('```')) {
                    if (currentCodeBlock !== null) {
                        currentCodeBlock.push(line);
                        out.push(currentCodeBlock.join('\n'));
                        currentCodeBlock = null;
                    } else {
                        currentCodeBlock = [line];
                    }
                    continue;
                }
                if (currentCodeBlock !== null) {
                    currentCodeBlock.push(line);
                    continue;
                }
                if (line.trim().startsWith('|')) {
                    if (currentTableBlock !== null) currentTableBlock.push(line);
                    else currentTableBlock = [line];
                    continue;
                } else if (currentTableBlock !== null) {
                    out.push(currentTableBlock.join('\n'));
                    currentTableBlock = null;
                }
                out.push(line);
            }
            if (currentCodeBlock !== null) out.push(currentCodeBlock.join('\n'));
            if (currentTableBlock !== null) out.push(currentTableBlock.join('\n'));
            if (out.length === 0) out.push('');
            return out;
        }

        /**
         * End-game Stage A/B/C: canonical document text as an array of block raws.
         * Save / host sync use toMarkdown(). Preview DOM is a projection (full or virtual).
         */
        const DocumentModel = {
            blocks: [],
            _nextId: 1,
            virtEnabled: false,
            virtStart: 0,
            virtEnd: 0,
            /** Fallback when a block has not been measured yet. */
            rowHeight: 28,
            /** Blocks above/below viewport to keep mounted (smaller now that heights vary). */
            overscan: 40,
            /** Per-block pixel heights for virt scroll mapping (null = rebuild). */
            blockHeights: null,

            /**
             * What a block's `raw` holds: 'markdown' or 'epub'.
             *
             * The model has always been "one canonical raw string per block, rendered to a
             * preview" -- nothing in that requires the raw to be Markdown. A book carries
             * its own HTML instead, rendered under its own stylesheet, so there is no
             * conversion step and therefore nothing for a conversion to lose. Measured on
             * Blindsight, converting to Markdown dropped every image, every link, every list
             * item and every footnote reference, and broke 16 of 17 headings.
             *
             * Everything downstream still works on blocks and does not care which this is:
             * search, the outline, pagination, page windowing, themes, tabs.
             */
            kind: 'markdown',

            isBook: function () { return this.kind === 'epub'; },

            /**
             * The visible text of a block, whatever its raw holds.
             *
             * Search, the outline and the status counts want what a reader can see, never
             * markup: searching a book must not match `class` or `href`. For Markdown the
             * raw is close enough to the text to use directly -- that is what every existing
             * caller already assumes. For a book the text is parsed out once and kept, since
             * a search haystack over a novel would otherwise reparse thousands of fragments
             * on every keystroke.
             */
            blockText: function (i) {
                const b = this.blocks[i];
                if (!b) return '';
                if (this.kind !== 'epub') return b.raw == null ? '' : String(b.raw);
                if (b.text == null) b.text = htmlFragmentToText(b.raw);
                return b.text;
            },

            /** The whole document as readable text. The search surface for a book. */
            toPlainText: function () {
                const out = [];
                for (let i = 0; i < this.blocks.length; i++) out.push(this.blockText(i));
                return out.join('\n');
            },

            /**
             * Load a book: one block per top-level element of each spine document, in
             * reading order, already split by the host.
             */
            /**
             * A book's own table of contents: [{ title, level, blockIndex }].
             *
             * Required, not a refinement. Dune contains zero <h1>..<h6> elements -- its
             * chapter titles are styled paragraphs, which is what Calibre produces and
             * therefore what a large share of real books look like. Detecting headings gives
             * that book an empty outline no matter how good the detection is, because there
             * is nothing there to detect. The publisher already wrote the chapter list; use
             * it.
             */
            toc: [],

            fromBookBlocks: function (htmlBlocks, toc) {
                this.blocks = [];
                this._nextId = 1;
                this.kind = 'epub';
                this.toc = Array.isArray(toc) ? toc : [];
                for (let i = 0; i < htmlBlocks.length; i++) {
                    this.blocks.push({
                        id: this._nextId++,
                        raw: htmlBlocks[i] == null ? '' : String(htmlBlocks[i]),
                        text: null
                    });
                }
                this.invalidateHeights();
                return this.blocks.length;
            },

            fromMarkdown: function (text) {
                const raws = splitMarkdownToBlockRaws(text);
                this.blocks = [];
                this._nextId = 1;
                // Opening a Markdown document after a book must go back to rendering
                // Markdown; the kind belongs to the document, not to the session.
                this.kind = 'markdown';
                this.toc = [];
                for (let i = 0; i < raws.length; i++) {
                    this.blocks.push({
                        id: this._nextId++,
                        raw: raws[i] == null ? '' : String(raws[i])
                    });
                }
                if (!this.blocks.length) {
                    this.blocks.push({ id: this._nextId++, raw: '' });
                }
                this.blockHeights = null;
                return this;
            },

            toMarkdown: function () {
                // A book's raw is publisher HTML. Joining it as "markdown" and feeding it to
                // loadMarkdownContent was how column/pagination remounts turned Matter into a
                // wall of <div class="calibre…"> tags and marked the tab unsaved.
                if (this.kind === 'epub') return this.toPlainText();
                const lines = [];
                for (let i = 0; i < this.blocks.length; i++) {
                    lines.push(this.blocks[i].raw == null ? '' : String(this.blocks[i].raw));
                }
                while (lines.length > 1 && !String(lines[lines.length - 1]).trim()) {
                    lines.pop();
                }
                return lines.join('\n');
            },

            setBlockRaw: function (index, raw) {
                if (index < 0 || index >= this.blocks.length) return;
                const next =
                    typeof coerceBlockRaw === 'function' ? coerceBlockRaw(raw) : String(raw == null ? '' : raw);
                const prev = this.blocks[index].raw;
                this.blocks[index].raw = next;
                // Only discard a measured height when the text actually CHANGED.
                // mountVirtWindow() calls syncMountedToModel() on every scroll frame,
                // which lands here for every mounted block with identical text. Always
                // re-estimating threw away the height that had just been measured from
                // the DOM, so the next frame chose its mount window and spacer sizes
                // from estimates instead of real heights — the scroll never settled.
                if (next !== prev && this.blockHeights && index < this.blockHeights.length) {
                    this.blockHeights[index] = this.estimateBlockHeight(next);
                }
            },

            modelIndexOfEl: function (el) {
                if (!el || !el.getAttribute) return -1;
                const a = el.getAttribute('data-model-index');
                if (a == null || a === '') return -1;
                const n = parseInt(a, 10);
                if (isNaN(n) || n < 0) return -1;
                // Stale tags after shrink/remount must not point past the model
                // (setBlockRaw would silently no-op → lost edits under virt serialize).
                if (n >= this.blocks.length) return -1;
                return n;
            },

            syncElToModel: function (el) {
                const i = this.modelIndexOfEl(el);
                if (i < 0) return;
                const raw = el.getAttribute('data-raw');
                this.setBlockRaw(i, raw == null ? '' : raw);
            },

            syncMountedToModel: function () {
                if (!editor) return;
                const nodes = editor.querySelectorAll('.block');
                for (let i = 0; i < nodes.length; i++) this.syncElToModel(nodes[i]);
            },

            /** Full DOM is mounted: rebuild model from data-raw attributes. */
            rebuildFromFullDom: function () {
                if (!editor) return;
                const nodes = editor.querySelectorAll('.block');
                this.blocks = [];
                this._nextId = 1;
                for (let i = 0; i < nodes.length; i++) {
                    this.blocks.push({
                        id: this._nextId++,
                        raw: nodes[i].getAttribute('data-raw') || ''
                    });
                    nodes[i].setAttribute('data-model-index', String(i));
                }
                if (!this.blocks.length) {
                    this.blocks.push({ id: this._nextId++, raw: '' });
                }
                this.blockHeights = null;
            },

            shouldVirtualize: function () {
                if (isPaginatedLayout()) return false;
                const nBlocks = this.blocks.length;
                // Sum raw lengths only — avoid joining a full toMarkdown() string just
                // to decide virt (open + column remounts used to pay O(n) join cost).
                let nChars = 0;
                for (let i = 0; i < nBlocks; i++) {
                    const r = this.blocks[i] && this.blocks[i].raw;
                    nChars += (r == null ? 0 : String(r).length);
                    if (i) nChars += 1; // join('\n') separator
                }
                const minB = typeof VIRT_MIN_BLOCKS === 'number' ? VIRT_MIN_BLOCKS : 2000;
                const minC = typeof VIRT_MIN_CHARS === 'number' ? VIRT_MIN_CHARS : 120000;
                return nBlocks >= minB || nChars >= minC;
            },

            /** Estimate height for one block raw before it is measured in the DOM. */
            estimateBlockHeight: function (raw) {
                const def = this.rowHeight || 28;
                raw = String(raw == null ? '' : raw);
                if (!raw.trim()) return def;
                if (raw.indexOf('```') === 0) {
                    const lines = raw.split('\n').length;
                    return Math.max(def, Math.min(900, lines * 18 + 20));
                }
                if (/^\|.*\|/m.test(raw) && /\|[\s\-:]+\|/.test(raw)) {
                    const lines = raw.split('\n').length;
                    return Math.max(def, Math.min(700, lines * 30 + 12));
                }
                // Markdown images are often much taller than one text row — avoid 28px
                // until measured (first scroll into an image region used to jump hard).
                if (/!\[[^\]]*\]\([^)]+\)/.test(raw)) {
                    // Multiple images in one block stack roughly
                    const n = (raw.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
                    return Math.max(def, Math.min(900, 220 * Math.max(1, n)));
                }
                if (/^#{1,6}\s/.test(raw)) return def + 14;
                if (/^>\s/.test(raw)) return def + 6;
                // Long lines wrap in Preview
                if (raw.length > 100) return def + Math.min(200, Math.floor(raw.length / 90) * 16);
                return def;
            },

            ensureHeights: function () {
                const n = this.blocks.length;
                if (this.blockHeights && this.blockHeights.length === n) return;
                const arr = new Array(n);
                for (let i = 0; i < n; i++) {
                    arr[i] = this.estimateBlockHeight(this.blocks[i] ? this.blocks[i].raw : '');
                }
                this.blockHeights = arr;
            },

            invalidateHeights: function () {
                this.blockHeights = null;
            },

            /**
             * Keep the height map aligned with a model splice instead of discarding it.
             *
             * invalidateHeights() throws away every measurement taken so far, so the very
             * next prefixHeight() for a row a thousand blocks down is rebuilt from
             * estimates. mountVirtWindow pins the viewport with that number, so a single
             * inserted block moved the view by whatever the estimate error had accumulated
             * to -- 1562px on the test document, and once per pasted block. Splicing keeps
             * every other row's measured height, so the pin does not move.
             */
            spliceHeights: function (start, removeCount, insertRaws) {
                if (!this.blockHeights) return;   // nothing measured yet; ensureHeights builds it
                const add = [];
                for (let i = 0; i < (insertRaws ? insertRaws.length : 0); i++) {
                    add.push(this.estimateBlockHeight(insertRaws[i]));
                }
                this.blockHeights.splice.apply(this.blockHeights, [start, removeCount].concat(add));
            },

            setMeasuredHeight: function (index, px) {
                this.ensureHeights();
                if (index < 0 || index >= this.blockHeights.length) return;
                const h = Math.max(14, Math.min(1200, px | 0));
                if (Math.abs((this.blockHeights[index] || 0) - h) >= 2) {
                    this.blockHeights[index] = h;
                }
            },

            /** Sum of heights for blocks [0, endExclusive). */
            prefixHeight: function (endExclusive) {
                this.ensureHeights();
                let y = 0;
                const n = Math.min(endExclusive | 0, this.blockHeights.length);
                for (let i = 0; i < n; i++) y += this.blockHeights[i] || this.rowHeight || 28;
                return y;
            },

            totalHeight: function () {
                return this.prefixHeight(this.blocks.length);
            },

            /** First block index whose bottom edge is past scrollTop. */
            indexAtScrollTop: function (scrollTop) {
                this.ensureHeights();
                const n = this.blockHeights.length;
                if (n === 0) return 0;
                let y = 0;
                const st = Math.max(0, scrollTop || 0);
                for (let i = 0; i < n; i++) {
                    const h = this.blockHeights[i] || this.rowHeight || 28;
                    if (y + h > st) return i;
                    y += h;
                }
                return n - 1;
            },

            /**
             * Insert after model index `index`. Returns the **actual** new block index
             * (not index+1 when the call was out-of-range and we appended).
             * Callers stamp data-model-index with this return value.
             */
            /**
             * Splicing the model renumbers every row after the splice point, so the
             * data-model-index attributes on already-mounted elements must move with it.
             *
             * They are not decoration: syncMountedToModel() writes each mounted element's
             * data-raw back into the model slot its attribute names. Leave them stale and
             * the next remount copies the DOM's content into the *wrong* rows -- silently
             * overwriting real text. Pasting mid-document destroyed the line after the
             * caret exactly this way, and the two cross-block delete paths shared it.
             *
             * Elements not yet stamped (a freshly created block, stamped by the caller
             * after the model call) have no attribute and are skipped, which is correct.
             */
            shiftMountedModelIndices: function (fromIndex, delta) {
                if (!delta) return;
                try {
                    const nodes = editor.querySelectorAll('.block[data-model-index]');
                    for (let i = 0; i < nodes.length; i++) {
                        const v = parseInt(nodes[i].getAttribute('data-model-index'), 10);
                        if (isNaN(v) || v < fromIndex) continue;
                        nodes[i].setAttribute('data-model-index', String(v + delta));
                    }
                } catch (e) {}
                // The mounted window names the same rows, so it moves too -- and it moves
                // whether or not the walk above succeeded, or mountVirtWindow would decide
                // it is already showing the right range and skip the repaint.
                if (this.virtStart >= fromIndex) this.virtStart += delta;
                if (this.virtEnd >= fromIndex) this.virtEnd += delta;
            },

            insertBlockAfterIndex: function (index, raw) {
                const item = {
                    id: this._nextId++,
                    raw: typeof coerceBlockRaw === 'function' ? coerceBlockRaw(raw) : String(raw || '')
                };
                let newIdx;
                if (index < 0 || index >= this.blocks.length) {
                    this.blocks.push(item);
                    newIdx = this.blocks.length - 1;
                } else {
                    this.blocks.splice(index + 1, 0, item);
                    newIdx = index + 1;
                    this.shiftMountedModelIndices(newIdx, 1);
                }
                this.spliceHeights(newIdx, 0, [item.raw]);
                return newIdx;
            },

            removeBlockAt: function (index) {
                if (index < 0 || index >= this.blocks.length) return;
                if (this.blocks.length <= 1) {
                    this.blocks[0].raw = '';
                    this.invalidateHeights();
                    return;
                }
                this.blocks.splice(index, 1);
                this.shiftMountedModelIndices(index + 1, -1);
                this.spliceHeights(index, 1, null);
            },

            /** Remove a range of block indices [from, to] inclusive. */
            removeBlockRange: function (from, to) {
                if (from > to) { const t = from; from = to; to = t; }
                if (from < 0) from = 0;
                if (to >= this.blocks.length) to = this.blocks.length - 1;
                if (from > to) return;
                if (from === 0 && to === this.blocks.length - 1) {
                    this.blocks = [{ id: this._nextId++, raw: '' }];
                    return;
                }
                this.blocks.splice(from, to - from + 1);
                this.shiftMountedModelIndices(to + 1, -(to - from + 1));
                this.spliceHeights(from, to - from + 1, null);
                if (!this.blocks.length) {
                    this.blocks.push({ id: this._nextId++, raw: '' });
                    this.invalidateHeights();
                }
            }
        };

        function reindexMountedBlocks() {
            if (!editor || DocumentModel.virtEnabled) return;
            const all = editor.querySelectorAll('.block');
            for (let i = 0; i < all.length; i++) {
                all[i].setAttribute('data-model-index', String(i));
            }
        }

        /**
         * Remove a .block from the DOM and DocumentModel. Prefer this over bare .remove().
         */
        function removeBlockEl(el) {
            if (!el) return;
            const mi = DocumentModel.modelIndexOfEl(el);
            try { el.remove(); } catch (e) {}
            if (mi >= 0) {
                DocumentModel.removeBlockAt(mi);
            } else if (!DocumentModel.virtEnabled) {
                try { DocumentModel.rebuildFromFullDom(); } catch (e2) {}
                return;
            }
            if (DocumentModel.virtEnabled) {
                try { mountVirtWindow(true); } catch (e3) {}
            } else {
                reindexMountedBlocks();
            }
            _contentCache = null;
        }

        let _virtScrollBound = false;
        let _virtScrollRaf = null;

        function bindVirtScroll() {
            if (_virtScrollBound || !mainContainer) return;
            mainContainer.addEventListener('scroll', onVirtScroll, { passive: true });
            _virtScrollBound = true;
        }

        function unbindVirtScroll() {
            if (!_virtScrollBound || !mainContainer) return;
            try { mainContainer.removeEventListener('scroll', onVirtScroll); } catch (e) {}
            _virtScrollBound = false;
        }

        function onVirtScroll() {
            if (!DocumentModel.virtEnabled) return;
            if (_virtScrollRaf) return;
            _virtScrollRaf = requestAnimationFrame(function () {
                _virtScrollRaf = null;
                try { mountVirtWindow(false); } catch (e) {}
                // Status Ln follows viewport center while scrolling (not first mounted block)
                try { updateCaretLineStatus(); } catch (e2) {}
            });
        }

        /**
         * Stage C/D: mount only viewport±overscan blocks; spacers use per-block heights
         * (estimated from raw, refined from measured DOM) so fences/tables do not drift.
         *
         * Scroll stability: never rewrite the entire height map on each remount (that made
         * the same scrollTop map to an earlier line → reverse jumps). After measure, re-pin
         * scrollTop to the pre-remount content anchor (model index + offset within block).
         */
        /**
         * @param {boolean} [force]
         * @param {{anchorIndex?:number, anchorOffset?:number}} [opts]
         *   When anchorIndex is set (sticky restore), pin to that model block after measure
         *   instead of whatever indexAtScrollTop thinks — estimate error must not re-home
         *   the viewport to a different row (2000→700 class of bug).
         */
        function mountVirtWindow(force, opts) {
            if (!DocumentModel.virtEnabled || !editor || !mainContainer) return;
            // Prevent re-entrant remount loops while correcting scroll
            if (DocumentModel._virtMounting) return;
            DocumentModel._virtMounting = true;
            try {
                opts = opts || {};
                try { DocumentModel.syncMountedToModel(); } catch (e0) {}

                const n = DocumentModel.blocks.length;
                DocumentModel.ensureHeights();
                const viewH = mainContainer.clientHeight || 600;
                const over = DocumentModel.overscan || 40;
                let scrollTop = mainContainer.scrollTop || 0;

                // --- Content anchor (what the user is looking at) before any height change ---
                let anchorIdx;
                let anchorOffset;
                if (opts.anchorIndex != null && opts.anchorIndex >= 0) {
                    // Sticky restore: force anchor to the target model block.
                    // anchorOffset may be negative (e.g. -pad) so the block sits below the top edge.
                    anchorIdx = opts.anchorIndex | 0;
                    if (anchorIdx >= n) anchorIdx = Math.max(0, n - 1);
                    anchorOffset = (opts.anchorOffset != null) ? (opts.anchorOffset | 0) : 0;
                    scrollTop = Math.max(0, DocumentModel.prefixHeight(anchorIdx) + anchorOffset);
                    mainContainer.scrollTop = scrollTop;
                } else {
                    anchorIdx = DocumentModel.indexAtScrollTop(scrollTop);
                    if (anchorIdx < 0) anchorIdx = 0;
                    if (anchorIdx >= n) anchorIdx = Math.max(0, n - 1);
                    anchorOffset = scrollTop - DocumentModel.prefixHeight(anchorIdx);
                    if (anchorOffset < 0) anchorOffset = 0;
                }

                function computeWindow(st) {
                    let start = DocumentModel.indexAtScrollTop(st) - over;
                    if (start < 0) start = 0;
                    let end = start;
                    let y = DocumentModel.prefixHeight(start);
                    const viewBottom = st + viewH;
                    while (end < n && y < viewBottom) {
                        y += DocumentModel.blockHeights[end] || DocumentModel.rowHeight || 28;
                        end++;
                    }
                    end = Math.min(n, end + over);
                    if (end < start) end = start;
                    return { start: start, end: end };
                }

                function pinScrollToAnchor() {
                    // anchorOffset was measured against the anchor block's OLD height. If
                    // that block then measured shorter (a wrapping paragraph estimated at
                    // 92px is often ~38px), the raw offset lands past the block's bottom
                    // and the pin resolves one row late — a slow drift while scrolling.
                    // Clamp it into the block as it is now.
                    let off = anchorOffset;
                    try {
                        const h = (DocumentModel.blockHeights && DocumentModel.blockHeights[anchorIdx])
                            || DocumentModel.rowHeight || 28;
                        if (off > h - 1) off = Math.max(0, h - 1);
                    } catch (eC) {}
                    const target = Math.max(0, DocumentModel.prefixHeight(anchorIdx) + off);
                    if (Math.abs((mainContainer.scrollTop || 0) - target) > 0.5) {
                        mainContainer.scrollTop = target;
                    }
                    return mainContainer.scrollTop || 0;
                }

                function updateSpacersInPlace(start, end) {
                    try {
                        const topSp = editor.querySelector('[data-virt-spacer="top"]');
                        const botSp = editor.querySelector('[data-virt-spacer="bottom"]');
                        const topH = DocumentModel.prefixHeight(start);
                        const botH = Math.max(0, DocumentModel.totalHeight() - DocumentModel.prefixHeight(end));
                        if (topSp) topSp.style.height = topH + 'px';
                        if (botSp) botSp.style.height = botH + 'px';
                    } catch (eSp) {}
                }

                /** Measure mounted blocks only — never rewrite unmeasured heights globally. */
                function measureMountedHeights() {
                    let sum = 0;
                    let count = 0;
                    let heightChanged = false;
                    try {
                        const nodes = editor.querySelectorAll('.block');
                        for (let i = 0; i < nodes.length; i++) {
                            const mi = DocumentModel.modelIndexOfEl(nodes[i]);
                            const oh = nodes[i].offsetHeight;
                            if (mi < 0 || oh <= 12) continue;
                            const prev = DocumentModel.blockHeights
                                ? (DocumentModel.blockHeights[mi] || 0) : 0;
                            DocumentModel.setMeasuredHeight(mi, oh);
                            const next = DocumentModel.blockHeights
                                ? (DocumentModel.blockHeights[mi] || 0) : 0;
                            if (Math.abs(prev - next) >= 2) heightChanged = true;
                            sum += next;
                            count++;
                        }
                        if (count > 0) {
                            // rowHeight only affects *future* estimateBlockHeight defaults,
                            // not a mass rewrite of the height map (that caused reverse jumps).
                            DocumentModel.rowHeight = Math.max(18, Math.min(120, Math.round(sum / count)));
                        }
                    } catch (eM) {}
                    return heightChanged;
                }

                let win = computeWindow(scrollTop);
                let start = win.start;
                let end = win.end;

                const sameWindow = !force && start === DocumentModel.virtStart && end === DocumentModel.virtEnd
                    && editor.querySelectorAll('.block').length === (end - start);

                if (sameWindow) {
                    const changed = measureMountedHeights();
                    if (changed) {
                        scrollTop = pinScrollToAnchor();
                        win = computeWindow(scrollTop);
                        if (win.start === start && win.end === end) {
                            updateSpacersInPlace(start, end);
                            try { clampMainScroll(); } catch (eCl0) {}
                            return;
                        }
                        // Window must shift — fall through to full remount
                        start = win.start;
                        end = win.end;
                    } else {
                        return;
                    }
                }

                function paintWindow(s, e) {
                    DocumentModel.virtStart = s;
                    DocumentModel.virtEnd = e;
                    const topH = DocumentModel.prefixHeight(s);
                    const botH = Math.max(0, DocumentModel.totalHeight() - DocumentModel.prefixHeight(e));

                    const frag = document.createDocumentFragment();
                    const top = document.createElement('div');
                    top.className = 'virt-spacer';
                    top.setAttribute('contenteditable', 'false');
                    top.setAttribute('data-virt-spacer', 'top');
                    top.style.cssText = 'height:' + topH + 'px;margin:0;padding:0;border:0;outline:none;';
                    frag.appendChild(top);

                    for (let i = s; i < e; i++) {
                        const raw = DocumentModel.blocks[i] ? DocumentModel.blocks[i].raw : '';
                        const el = createPreviewBlockEl(raw, false, i);
                        el.setAttribute('data-model-index', String(i));
                        if (_bookDocStarts[i]) el.setAttribute('data-chapter-start', '1');
                        frag.appendChild(el);
                    }

                    const bot = document.createElement('div');
                    bot.className = 'virt-spacer';
                    bot.setAttribute('contenteditable', 'false');
                    bot.setAttribute('data-virt-spacer', 'bottom');
                    bot.style.cssText = 'height:' + botH + 'px;margin:0;padding:0;border:0;outline:none;';
                    frag.appendChild(bot);

                    editor.innerHTML = '';
                    editor.appendChild(frag);
                    if (!currentActiveBlock || !editor.contains(currentActiveBlock)) {
                        currentActiveBlock = editor.querySelector('.block');
                    }
                }

                let activeCaret = null;
                try {
                    const sel = window.getSelection();
                    if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
                        const range = sel.getRangeAt(0);
                        const block = getAncestorBlock(range.startContainer);
                        if (block) {
                            const mi = DocumentModel.modelIndexOfEl(block);
                            if (mi >= 0) {
                                const pre = document.createRange();
                                pre.selectNodeContents(block);
                                pre.setEnd(range.startContainer, range.startOffset);
                                activeCaret = { mi: mi, offset: pre.toString().length };
                            }
                        }
                    }
                } catch (e) {}

                paintWindow(start, end);
                measureMountedHeights();
                // Re-pin: measured heights change prefix(anchor) — keep the same content on screen
                scrollTop = pinScrollToAnchor();
                // One corrective remount if the window range shifted after measure+pin
                win = computeWindow(scrollTop);
                if (win.start !== start || win.end !== end) {
                    paintWindow(win.start, win.end);
                    measureMountedHeights();
                    pinScrollToAnchor();
                }

                if (activeCaret) {
                    try {
                        const newBlock = elementForModelIndex(activeCaret.mi);
                        if (newBlock) setCaretAtOffset(newBlock, activeCaret.offset);
                    } catch (e) {}
                }

                try { repaintFindHighlights(); } catch (eF) {}
                try { clampMainScroll(); } catch (eCl) {}
            } finally {
                DocumentModel._virtMounting = false;
            }
        }

        /** Block indices that begin a spine document, i.e. a chapter. */
        let _bookDocStarts = {};

        function createPreviewBlockEl(raw, progressive, modelIndex) {
            const block = document.createElement('div');
            block.className = 'block';
            const initialRaw = raw == null ? '' : String(raw);
            block.setAttribute('data-raw', initialRaw);
            // Before the render, not after: a book's markup resolves its images against the
            // document it came from, and it can only find that from its own model index.
            if (modelIndex !== undefined && modelIndex !== null) {
                block.setAttribute('data-model-index', String(modelIndex));
            }
            if (progressive) {
                block.setAttribute('data-tz-paint', '1');
                block.textContent = initialRaw;
            } else {
                try { renderBlockPreview(block, coerceBlockRaw(initialRaw)); }
                catch (e) { block.textContent = initialRaw; }
            }
            return block;
        }

        /**
         * @param {string} markdown
         * @param {{deferPaint?:boolean, stickyLine?:number}} [opts]
         * Stage A: always fill DocumentModel.
         * L/XL: virtualized mount (viewport only) — no progressive full DOM.
         * S: full DOM, immediate paint.
         * M: full DOM, progressive paint (block-count gate only; never LARGE_DOC_CHARS).
         */
        function loadMarkdownContent(markdown, opts) {
            opts = opts || {};
            _contentCache = null;
            try { if (typeof clearWarmPageChunk === 'function') clearWarmPageChunk(); } catch (eW) {}
            try { releaseDocumentStateForHost(); } catch (e0) {}
            const text = markdown == null ? '' : String(markdown);

            // Column/pagination remounts used to call loadMarkdownContent(toMarkdown()) while
            // still on a book. That rewrote publisher HTML as Markdown source. Remounts
            // without replaceBook stay on the book path.
            if (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub'
                && !opts.replaceBook) {
                try {
                    if (typeof remountBookSurface === 'function') {
                        const bi = (opts.anchorBlock != null) ? opts.anchorBlock
                            : ((typeof _readingAnchor === 'number') ? _readingAnchor : 0);
                        remountBookSurface({ anchorBlock: bi });
                        return;
                    }
                } catch (eBook) {}
            }

            // Leaving a book without teardown left publisher CSS + Pages mode on the next
            // markdown tab (black text on dark theme, scrubber 1/35 of a short note).
            const wasBook = (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub');
            DocumentModel.fromMarkdown(text);
            if (wasBook) {
                try { leaveBookViewForMarkdown(); } catch (eLeave) {
                    try { clearBookSession(); } catch (eClear) {}
                }
            } else {
                // Even if kind was already markdown, strip any leftover book stylesheet
                // (e.g. failed load / partial state).
                try { clearBookSession(); } catch (eClear2) {}
            }
            // Markdown is editable in Preview. Defend against a stuck reader-mode /
            // contenteditable=false from a previous book tab (leaveBook used to set
            // editable before flipping mode, so ApplyTabView could skip the fix).
            try {
                if (typeof setEditorEditable === 'function' && state.mode === 'wysiwyg')
                    setEditorEditable(true);
            } catch (eEdMd) {}
            // Drop any correction left by a book: this document is Markdown and the theme's
            // size is already its size.
            try { normaliseBookTextSize(); } catch (eF) {}
            window.__tzPaintGen = (window.__tzPaintGen || 0) + 1;
            const paintGen = window.__tzPaintGen;

            if (typeof sourceEditor !== 'undefined' && sourceEditor) {
                sourceEditor.value = text;
            }

            const stickyWanted = (opts && opts.stickyLine >= 1) ? (opts.stickyLine | 0) : 0;

            // Whether this load seeds a fresh history is decided now, when the load is
            // requested -- not later, when its deferred tail happens to finish.
            //
            // The progressive path builds blocks across requestAnimationFrame batches and
            // seeds at the end. undo() calls in here with isRestoring set and clears it as
            // soon as it returns, so by the time those batches finished the flag read false
            // and the seed wiped the stack undo was halfway through using: type, press
            // Enter, Ctrl+Z, and the typing could no longer be undone at all. Only in a
            // paginated layout, because a scrolling one virtualises and seeds synchronously.
            const restoringAtStart =
                (typeof HistoryManager !== 'undefined') && HistoryManager.isRestoring;

            function seedHistoryAndCache() {
                // Do NOT reset sticky/caret when loading for a mode switch — that wiped
                // line 16 → 1 before restore could run. On a fresh document load, DO reset:
                // otherwise sticky still says ~500 while the view is at the cover until
                // resume lands (and forever if resume is skipped).
                if (!stickyWanted) {
                    _lastCaretLine = 1;
                    try { rememberStickyLine(1); } catch (eStk) { _stickyLineCache = 1; }
                }
                if (typeof HistoryManager !== 'undefined' && !restoringAtStart
                    && !HistoryManager.isRestoring) {
                    try {
                        HistoryManager.undoStack = [];
                        HistoryManager.redoStack = [];
                        HistoryManager._push(HistoryManager._stateFromContent(text), true);
                    } catch (eH) {}
                }
                _contentCache = text;
                try {
                    _lastGoodDocRaws = DocumentModel.blocks.map(function (b) { return b.raw; });
                } catch (eL) { _lastGoodDocRaws = []; }
            }

            // L/XL: virtualized Preview — owns heavy docs; progressive never runs for these.
            if (DocumentModel.shouldVirtualize()) {
                DocumentModel.virtEnabled = true;
                editor.innerHTML = '';
                try {
                    // Only jump to top when this is a fresh open, not a mode-switch restore
                    if (!stickyWanted && mainContainer) mainContainer.scrollTop = 0;
                } catch (eScr0) {}
                bindVirtScroll();
                if (stickyWanted && typeof modelBlockStartLineToIndex === 'function') {
                    const bi = modelBlockStartLineToIndex(stickyWanted);
                    mountVirtWindow(true, { anchorIndex: bi, anchorOffset: -48 });
                } else {
                    mountVirtWindow(true);
                }
                // Seed the shaded block on a FRESH open only, for exactly the reason the
                // scrollTop reset above is conditional: a mode-switch or restore is a
                // rendering event, not a navigation. This used to run unconditionally and
                // add the class directly, which did two wrong things at once -- it lit
                // whatever happened to be at the top of the mounted window (not even block
                // 0, once the mount is anchored elsewhere), and it left any block another
                // path had already shaded still shaded. A search result on line 13 with
                // "Section 1 of 140" glowing at the top of the document was this.
                // setFocusedBlock is the only thing that keeps "at most one block is
                // shaded" true, so it is the only thing that may add the class.
                if (!stickyWanted) setFocusedBlock(editor.querySelector('.block'));
                seedHistoryAndCache();
                window.__tzPreviewPainting = false;
                try { updateOutline(); } catch (eO) {}
            // Marks may have arrived before this document did; rescue any that had
            // nothing to resolve against at the time.
            try { resolveMarksAfterDocumentLoad(); } catch (eRm) {}
                try { tzRequestPendingImages(editor); tzScheduleImageRescan(); } catch (eI) {}
                
                if (stickyWanted) {
                    if (typeof restoreStickyDocumentLine === 'function') {
                        restoreStickyDocumentLine(stickyWanted);
                    }
                } else {
                    try { updateStatsNow(); } catch (eSt) {}
                }
                return;
            }
            // (virt path returns above; the full-mount path continues below)

            DocumentModel.virtEnabled = false;
            unbindVirtScroll();
            editor.innerHTML = '';

            const blockRaws = DocumentModel.blocks.map(function (b) { return b.raw; });
            // M-band progressive: block count only (or explicit deferPaint).
            // Do NOT key off LARGE_DOC_CHARS — that is stats throttling only,
            // and dual-use re-coupled progressive to "any file ≥16KB".
            const paintFloor = (typeof PROGRESSIVE_PAINT_BLOCKS === 'number')
                ? PROGRESSIVE_PAINT_BLOCKS : 800;
            const createFloor = (typeof PROGRESSIVE_CREATE_BATCH_BLOCKS === 'number')
                ? PROGRESSIVE_CREATE_BATCH_BLOCKS : 1500;
            const progressive = (opts && opts.deferPaint === true)
                || blockRaws.length >= paintFloor;
            // Batch-create only in the high M band (still < virt floor).
            const windowedCreate = progressive && blockRaws.length >= createFloor;
            window.__tzPreviewPainting = progressive;

            function finishLoadUi() {
                // Stamp model indices on full mount
                try {
                    const blocks = editor.querySelectorAll('.block');
                    for (let i = 0; i < blocks.length; i++) {
                        blocks[i].setAttribute('data-model-index', String(i));
                    }
                    setFocusedBlock(blocks[0] || null);   // see above: one adder only
                } catch (e) {
                    currentActiveBlock = editor.firstElementChild;
                }
                seedHistoryAndCache();
            }

            function afterPaint() {
                window.__tzPreviewPainting = false;
                try { updateOutline(); } catch (eO) {}
                try { tzRequestPendingImages(editor); tzScheduleImageRescan(); } catch (eI) {}
                // A document opened straight into Pages -- a restored session, which is the
                // usual way a reader arrives -- has just been mounted whole. Narrow it to a
                // range now that the paint has finished; doing it earlier is what the
                // deferred batches buried.
                try { ensurePageWindow(); } catch (eW) {}
            }

            function startPaint() {
                if (stickyWanted && typeof restoreStickyDocumentLine === 'function') {
                    // Delay slightly to let browser layout update parent scroll bounds before scrolling
                    setTimeout(function() {
                        restoreStickyDocumentLine(stickyWanted);
                    }, 20);
                }
                if (progressive) {
                    if (outlineList) {
                        try {
                            outlineList.innerHTML = '<div class="outline-item" style="opacity:0.5;">Rendering preview…</div>';
                        } catch (eO2) {}
                    }
                    paintBlockPreviewsProgressive(paintGen, afterPaint);
                } else {
                    afterPaint();
                }
            }

            if (!windowedCreate) {
                const frag = document.createDocumentFragment();
                for (let i = 0; i < blockRaws.length; i++) {
                    const el = createPreviewBlockEl(blockRaws[i], progressive, i);
                    el.setAttribute('data-model-index', String(i));
                    if (_bookDocStarts[i]) el.setAttribute('data-chapter-start', '1');
                    frag.appendChild(el);
                }
                editor.appendChild(frag);
                finishLoadUi();
                startPaint();
                return;
            }

            const CREATE_BATCH = 250;
            let createIdx = 0;
            if (outlineList) {
                try {
                    outlineList.innerHTML = '<div class="outline-item" style="opacity:0.5;">Building preview…</div>';
                } catch (eB) {}
            }
            function createStep() {
                if (paintGen !== window.__tzPaintGen) return;
                const frag = document.createDocumentFragment();
                const end = Math.min(createIdx + CREATE_BATCH, blockRaws.length);
                for (; createIdx < end; createIdx++) {
                    const el = createPreviewBlockEl(blockRaws[createIdx], true, createIdx);
                    el.setAttribute('data-model-index', String(createIdx));
                    frag.appendChild(el);
                }
                editor.appendChild(frag);
                if (createIdx < blockRaws.length) {
                    requestAnimationFrame(createStep);
                } else {
                    finishLoadUi();
                    startPaint();
                }
            }
            requestAnimationFrame(createStep);
        }


        /**
         * Convert HTML to markdown for rich-paste from browsers.
         * Handles headings, bold, italic, code, tables, lists, links, blockquotes.
         */
        function htmlToMarkdown(html) {
            /**
             * Families that mean "this is code". Only what a source actually writes into a
             * clipboard font-family, which is a short list in practice.
             */
            const MONO_FAMILY = /(^|[\s,'"])(monospace|consolas|menlo|monaco|courier|cascadia|sf ?mono|roboto mono|source code pro|fira ?code|fira mono|jetbrains mono|ubuntu mono|dejavu sans mono|liberation mono|andale mono|lucida console)([\s,'"]|$)/i;

            /** The nearest declared font-family wins: an inner span can opt back out of code. */
            function isMonospaceStyled(el) {
                for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
                    const f = a.style && a.style.fontFamily;
                    if (f) return MONO_FAMILY.test(f);
                }
                return false;
            }

            /**
             * Turn runs of monospaced block elements into a <pre>, before anything is converted.
             *
             * Almost nothing puts code on a clipboard as <pre><code>. An editor or a chat page
             * emits one styled <div> per line with a coloured <span> per token, and some of
             * those spans are bold -- so a pasted function arrived as prose with its
             * indentation collapsed and its keywords turned into **def** and **return**. The
             * fence was never lost; it was never there, because nothing said "code" except the
             * font.
             *
             * Only leaf blocks, so a wrapper does not swallow the lines inside it, and only
             * consecutive ones, so two separate snippets stay two fences.
             */
            function groupMonospaceBlocks(root) {
                const BLOCKISH = /^(div|p|li|section|article|figure)$/;
                const parents = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
                for (const parent of parents) {
                    if (!parent.children || !parent.children.length) continue;
                    if (parent.tagName && parent.tagName.toLowerCase() === 'pre') continue;

                    let run = [];
                    const flush = () => {
                        if (run.length) {
                            const pre = (parent.ownerDocument || document).createElement('pre');
                            // Trailing whitespace only: leading whitespace is the indentation,
                            // which is the part of a code block people notice losing.
                            pre.textContent = run.map(el => el.textContent.replace(/\s+$/, '')).join('\n');
                            parent.insertBefore(pre, run[0]);
                            for (const el of run) el.remove();
                        }
                        run = [];
                    };
                    for (const child of Array.prototype.slice.call(parent.children)) {
                        const tag = child.tagName.toLowerCase();
                        const isLeafBlock = BLOCKISH.test(tag) &&
                            !child.querySelector('div, p, li, section, article, pre, table');
                        if (isLeafBlock && isMonospaceStyled(child)) run.push(child);
                        else flush();
                    }
                    flush();
                }
            }

            try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                try { groupMonospaceBlocks(doc.body); } catch (eG) {}
                const md = walkNode(doc.body).trim();
                // Collapse runs of 3+ newlines to 2
                return md.replace(/\n{3,}/g, '\n\n');
            } catch (e) { return ''; }

            function walkNode(node) {
                if (node.nodeType === 3) return node.textContent;
                if (node.nodeType !== 1) return '';
                const tag = node.tagName.toLowerCase();
                // Skip style/script
                if (tag === 'style' || tag === 'script') return '';
                let kids = Array.from(node.childNodes).map(walkNode).join('');

                // Emphasis carried by CSS rather than by <em>/<strong>.
                //
                // Most rich sources emit styled elements, not semantic ones: a chat
                // transcript italicises with a class on a <div>, Word and Google Docs use
                // <span style="font-weight:700">. Recognising only <em> and <b> threw all
                // of that away silently -- a whole italic paragraph pasted in as plain text
                // with nothing to show it had ever been emphasised.
                //
                // Applied here, before the tag switch, so it composes with whatever the tag
                // itself contributes. Skipped for tags that already carry the meaning, or
                // that would put marks around a heading's own text.
                if (kids.trim() && !/^(em|i|strong|b|code|pre|h[1-6]|a|del|s)$/.test(tag)) {
                    // ...and not INSIDE one either. A heading is already bold, a <strong>
                    // is already strong: marking a styled span within them yields
                    // "## **Quarterly** Results" from a heading whose own weight is simply
                    // being restated by the source's CSS.
                    let inherited = '';
                    for (let a = node.parentElement; a; a = a.parentElement) {
                        inherited += a.tagName.toLowerCase() + ' ';
                    }
                    // Nor inside code. A highlighter's bold keyword is syntax colouring,
                    // not emphasis, and `**def**` inside a fence is just wrong.
                    const inHeading = /\b(h[1-6]|th)\b/.test(inherited) ||
                        /\b(pre|code)\b/.test(inherited) || isMonospaceStyled(node);
                    const st = inHeading ? null : node.style;
                    if (st) {
                        const w = String(st.fontWeight || '').toLowerCase();
                        let bold = w === 'bold' || w === 'bolder' || (parseInt(w, 10) >= 600);
                        let italic = /italic|oblique/.test(String(st.fontStyle || ''));
                        if (/\b(strong|b)\b/.test(inherited)) bold = false;
                        if (/\b(em|i)\b/.test(inherited)) italic = false;
                        // Wrap the text, not the surrounding whitespace: "** bold **" is
                        // not emphasis in Markdown, it is literal asterisks.
                        const wrap = (mark) => kids.replace(/^(\s*)([\s\S]*?)(\s*)$/,
                            (m, a, core, z) => core ? a + mark + core + mark + z : m);
                        if (bold) kids = wrap('**');
                        if (italic) kids = wrap('*');
                    }
                }

                // A monospaced run inside a sentence is inline code, whether the source
                // said so with <code> or only with a font. Not inside a fence, where the
                // backticks would be literal, and not across lines, where it is a block and
                // groupMonospaceBlocks has already dealt with it.
                if (/^(span|font|tt|kbd|samp|var)$/.test(tag) && kids.trim() &&
                    kids.indexOf('\n') < 0 && kids.indexOf('`') < 0) {
                    let inCode = false;
                    for (let a = node.parentElement; a; a = a.parentElement) {
                        const t = a.tagName.toLowerCase();
                        if (t === 'pre' || t === 'code') { inCode = true; break; }
                    }
                    if (!inCode && (/^(tt|kbd|samp|var)$/.test(tag) || isMonospaceStyled(node))) {
                        kids = kids.replace(/^(\s*)([\s\S]*?)(\s*)$/,
                            (m, a, core, z) => core ? a + '`' + core + '`' + z : m);
                    }
                }

                switch (tag) {
                    case 'h1': return '\n# ' + kids.trim() + '\n\n';
                    case 'h2': return '\n## ' + kids.trim() + '\n\n';
                    case 'h3': return '\n### ' + kids.trim() + '\n\n';
                    case 'h4': return '\n#### ' + kids.trim() + '\n\n';
                    case 'h5': return '\n##### ' + kids.trim() + '\n\n';
                    case 'h6': return '\n###### ' + kids.trim() + '\n\n';
                    case 'p': return kids.trim() + '\n\n';
                    case 'br': return '\n';
                    case 'strong': case 'b': return '**' + kids + '**';
                    case 'em': case 'i': return '*' + kids + '*';
                    case 'code':
                        // If inside <pre>, don't wrap in backticks (walkNode for <pre> handles it)
                        if (node.parentElement && node.parentElement.tagName === 'PRE') return kids;
                        return '`' + kids + '`';
                    case 'pre': {
                        let codeEl = node.querySelector('code');
                        let content = codeEl ? codeEl.textContent : node.textContent;
                        return '\n```\n' + content + '\n```\n\n';
                    }
                    case 'a': {
                        let href = node.getAttribute('href') || '';
                        if (!href || href === '#') return kids;
                        return '[' + kids + '](' + href + ')';
                    }
                    case 'blockquote':
                        return kids.trim().split('\n').map(function(l) { return '> ' + l; }).join('\n') + '\n\n';
                    case 'ul': return '\n' + walkList(node, false) + '\n\n';
                    case 'ol': return '\n' + walkList(node, true) + '\n\n';
                    case 'li': return kids.trim();
                    case 'table': return '\n' + walkTable(node) + '\n\n';
                    case 'thead': case 'tbody': case 'tfoot': case 'colgroup': case 'col': return kids;
                    case 'tr': case 'th': case 'td': return ''; // handled by walkTable
                    case 'img': {
                        let alt = node.getAttribute('alt') || '';
                        let src = node.getAttribute('src') || '';
                        return '![' + alt + '](' + src + ')';
                    }
                    case 'hr': return '\n---\n\n';
                    case 'del': case 's': return '~~' + kids + '~~';
                    case 'sup': return '<sup>' + kids + '</sup>';
                    case 'sub': return '<sub>' + kids + '</sub>';
                    // Block containers. Without these a <div> returned its children with no
                    // separator at all, so two adjacent blocks ran together mid-sentence --
                    // "…the same underlying habit.Four distinct defects…" -- and a code
                    // block built from one div per line collapsed onto a single line.
                    // Over-separating is harmless: the caller collapses 3+ newlines to 2.
                    case 'div': case 'section': case 'article': case 'main':
                    case 'header': case 'footer': case 'aside': case 'nav':
                    case 'figure': case 'figcaption': case 'dl': case 'dd': case 'dt':
                    case 'address': case 'form': case 'fieldset':
                        return kids.trim() ? kids.trim() + '\n\n' : '\n';
                    default: return kids;
                }
            }

            function walkList(ul, ordered) {
                let items = [];
                for (let c = ul.firstElementChild; c; c = c.nextElementSibling) {
                    if (c.tagName === 'LI') items.push(c);
                }
                return items.map(function(li, i) {
                    let prefix = ordered ? (i + 1) + '. ' : '- ';
                    let content = walkNode(li).trim().replace(/\n/g, '\n  ');
                    return prefix + content;
                }).join('\n');
            }

            function walkTable(table) {
                let rows = table.querySelectorAll('tr');
                if (!rows.length) return '';
                let matrix = [];
                let aligns = [];
                for (let ri = 0; ri < rows.length; ri++) {
                    let cells = rows[ri].querySelectorAll('th, td');
                    let row = [];
                    for (let ci = 0; ci < cells.length; ci++) {
                        // Walk the cell's children, not the cell. walkNode() returns '' for
                        // th/td (it defers to this function), so passing the cell itself made
                        // every cell empty -- a table pasted from any source arrived as a
                        // correctly shaped grid of blanks.
                        let cellMd = Array.from(cells[ci].childNodes).map(walkNode).join('');
                        row.push(cellMd.trim().replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' '));
                        if (ri === 0) {
                            let a = '';
                            try {
                                const st = (cells[ci].style && cells[ci].style.textAlign) || '';
                                const at = (cells[ci].getAttribute('align') || '').toLowerCase();
                                const v = (st || at || '').toLowerCase();
                                if (v === 'center' || v === 'right' || v === 'left') a = v;
                            } catch (eA) {}
                            aligns[ci] = a;
                        }
                    }
                    matrix.push(row);
                }
                // Prefer alignment from stored markdown (DOM often has no align attrs).
                try {
                    const blk = table.closest ? table.closest('.block') : null;
                    const stored = blk && typeof parseTableMarkdown === 'function'
                        ? parseTableMarkdown(blk.getAttribute('data-raw') || '')
                        : null;
                    if (stored && stored.align && stored.align.length) {
                        aligns = stored.align.slice();
                    }
                } catch (eS) {}
                let colCount = 0;
                for (let r = 0; r < matrix.length; r++) {
                    if (matrix[r].length > colCount) colCount = matrix[r].length;
                }
                for (let r = 0; r < matrix.length; r++) {
                    while (matrix[r].length < colCount) matrix[r].push('');
                }
                while (aligns.length < colCount) aligns.push('');
                let lines = [];
                lines.push('| ' + matrix[0].join(' | ') + ' |');
                lines.push('| ' + aligns.slice(0, colCount).map(function (a) {
                    if (typeof tableAlignToSep === 'function') return tableAlignToSep(a);
                    if (a === 'center') return ':---:';
                    if (a === 'right') return '---:';
                    if (a === 'left') return ':---';
                    return '---';
                }).join(' | ') + ' |');
                for (let r = 1; r < matrix.length; r++) {
                    lines.push('| ' + matrix[r].join(' | ') + ' |');
                }
                return lines.join('\n');
            }
        }        /**
         * Insert plain text like Ctrl+V. Used by the paste event and host menu (paste_text:).
         * One undo step. Source mode inserts at caret; WYSIWYG uses the block paste path.
         */
        function insertPastedPlainText(text) {
            if (text == null || text === '') return;

            if (state.mode === 'source') {
                if (!sourceEditor) return;
                HistoryManager.beginEdit();
                try {
                    const s = sourceEditor.selectionStart;
                    const e = sourceEditor.selectionEnd;
                    sourceEditor.setRangeText(String(text), s, e, 'end');
                    resizeSourceEditor();
                    updateStats();
                    scheduleSavePreferences();
                } finally {
                    HistoryManager.commitEdit();
                }
                return;
            }

            // One undo step per paste (not debounced with typing). Capture pre-paste first.
            HistoryManager.beginEdit();

            const sel = window.getSelection();
            let active = null;
            if (sel && !sel.isCollapsed && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
                try {
                    active = getAncestorBlock(sel.anchorNode);
                    sel.deleteFromDocument();
                    if (active && !editor.contains(active)) active = null;
                } catch(err) {}
            }
            if (!active && sel && sel.anchorNode && editor.contains(sel.anchorNode)) {
                active = getAncestorBlock(sel.anchorNode);
            }
            if (!active || !active.classList || !active.classList.contains('block')) {
                active = document.activeElement;
            }
            if (!active || !active.classList || !active.classList.contains('block')) {
                const blocks = editor.querySelectorAll('.block');
                if (blocks.length > 0) active = blocks[blocks.length - 1];
            }

            const rawLines = String(text).split(/\r?\n/);
            const blockTexts = [];
            let currentCode = null;
            let currentTable = null;
            for (let i = 0; i < rawLines.length; i++) {
                const l = rawLines[i];
                if (l.startsWith('```')) {
                    if (currentCode !== null) {
                        currentCode.push(l);
                        blockTexts.push(currentCode.join('\n'));
                        currentCode = null;
                    } else {
                        currentCode = [l];
                    }
                    continue;
                }
                if (currentCode !== null) {
                    currentCode.push(l);
                    continue;
                }
                if (l.trim().startsWith('|')) {
                    if (currentTable !== null) currentTable.push(l);
                    else currentTable = [l];
                    continue;
                } else if (currentTable !== null) {
                    blockTexts.push(currentTable.join('\n'));
                    currentTable = null;
                }
                blockTexts.push(l);
            }
            if (currentCode !== null) blockTexts.push(currentCode.join('\n'));
            if (currentTable !== null) blockTexts.push(currentTable.join('\n'));

            if (blockTexts.length === 0) {
                HistoryManager.commitEdit();
                return;
            }

            if (blockTexts.length === 1 && !blockTexts[0].includes('\n')) {
                document.execCommand('insertText', false, blockTexts[0]);
                if (active && active.classList && active.classList.contains('block')) {
                    const raw0 = state.revealOnFocus ? active.innerText : blockHtmlToMarkdown(active);
                    active.setAttribute('data-raw', raw0);
                }
                updateStats();
                updateOutline();
                HistoryManager.commitEdit();
                return;
            }

            if (active && active.classList && active.classList.contains('block')) {
                const currentRaw = active.getAttribute('data-raw') || active.innerText || '';
                if (!currentRaw.trim()) {
                    active.setAttribute('data-raw', blockTexts[0]);
                    renderBlockPreview(active, blockTexts[0]);
                } else {
                    const sel2 = window.getSelection();
                    if (sel2 && sel2.rangeCount > 0 && sel2.anchorNode && active.contains(sel2.anchorNode)) {
                        document.execCommand('insertText', false, blockTexts[0]);
                        const raw0 = state.revealOnFocus ? active.innerText : blockHtmlToMarkdown(active);
                        active.setAttribute('data-raw', raw0);
                        renderBlockPreview(active, raw0);
                    } else {
                        active.innerText = (active.innerText || '') + blockTexts[0];
                        const raw0 = state.revealOnFocus ? active.innerText : blockHtmlToMarkdown(active);
                        active.setAttribute('data-raw', raw0);
                        renderBlockPreview(active, raw0);
                    }
                }

                // Under virtualisation createBlock remounts the window, which replaces
                // every mounted element -- including the one it just handed back. Chaining
                // off that detached node left the caret nowhere, so _captureCaret fell back
                // to "first block in the mounted window" and undo stored *that* as the edit
                // site, jumping hundreds of rows away. The model index survives a remount;
                // the element does not, so re-find it each time.
                let currentBlock = active;
                let lastIdx = -1;
                for (let i = 1; i < blockTexts.length; i++) {
                    const newBlock = createBlock(blockTexts[i], currentBlock);
                    lastIdx = DocumentModel.modelIndexOfEl(newBlock);
                    currentBlock = editor.contains(newBlock)
                        ? newBlock
                        : (elementForModelIndex(lastIdx) || newBlock);
                }
                if (lastIdx >= 0 && (!currentBlock || !editor.contains(currentBlock))) {
                    currentBlock = ensureModelBlockVisible(lastIdx, { topPad: 48 })
                        || elementForModelIndex(lastIdx);
                }
                if (currentBlock && editor.contains(currentBlock)) focusBlock(currentBlock, 0);
            } else {
                for (let i = 0; i < blockTexts.length; i++) {
                    createBlock(blockTexts[i]);
                }
            }
            updateStats();
            updateOutline();
            scheduleSavePreferences();
            HistoryManager.commitEdit();
        }

        // Images whose bytes the host has handed back, keyed by the authored relative path.
        const _tzImageData = {};

        /**
         * An image failed to load from the mapped document folder. Ask the host for the
         * file's bytes and swap them in as a data: URI. This is the reliable path: no
         * virtual host, no cross-origin rules, no dependence on where the file lives.
         */
        function tzImageFallback(img) {
            try {
                if (!img || img.getAttribute('data-fallback') === 'done') return;
                img.setAttribute('data-fallback', 'done');
                const rel = img.getAttribute('data-src');
                if (!rel) return;
                if (_tzImageData[rel]) { img.src = _tzImageData[rel]; return; }
                postMsg('image_data_req:' + rel);
            } catch (e) {}
        }

        /** Apply bytes the host returned to every image referencing that path. */
        function tzApplyImageData(rel, dataUri) {
            if (!rel || !dataUri) return;
            _tzImageData[rel] = dataUri;
            try {
                const all = document.querySelectorAll('#editor img');
                for (let i = 0; i < all.length; i++) {
                    if (all[i].getAttribute('data-src') === rel) {
                        all[i].src = dataUri;
                        all[i].removeAttribute('data-pending');
                        delete _tzImageAsked[rel];
                    }
                }
            } catch (e) {}
        }

        // Requests currently in flight. Entries are cleared when the bytes arrive (or the
        // request times out), so a path is never permanently marked "asked" — that left an
        // image stuck as a placeholder forever if a reply was ever missed.
        const _tzImageAsked = {};

        /** Re-scan shortly after a load, in case a reply was missed or arrived early. */
        function tzScheduleImageRescan() {
            setTimeout(function () {
                try {
                    const stuck = editor ? editor.querySelectorAll('img[data-pending]') : [];
                    for (let i = 0; i < stuck.length; i++) {
                        const rel = stuck[i].getAttribute('data-src');
                        if (rel) delete _tzImageAsked[rel];   // allow a retry
                    }
                    if (stuck.length) tzRequestPendingImages(editor);
                } catch (e) {}
            }, 400);
        }

        /**
         * Ask the host for any relative image we have not fetched yet. Called right after
         * a render rather than waiting for an onerror: the docfolder request hangs instead
         * of failing, so error-driven loading cost ~5 seconds per image.
         */
        function tzRequestPendingImages(root) {
            try {
                const scope = root && root.querySelectorAll ? root : editor;
                if (!scope) return;
                const pending = scope.querySelectorAll('img[data-pending]');
                for (let i = 0; i < pending.length; i++) {
                    const rel = pending[i].getAttribute('data-src');
                    if (!rel) continue;
                    if (_tzImageData[rel]) {
                        pending[i].src = _tzImageData[rel];
                        pending[i].removeAttribute('data-pending');
                        continue;
                    }
                    if (_tzImageAsked[rel]) continue;
                    _tzImageAsked[rel] = true;
                    postMsg('image_data_req:' + rel);
                }
            } catch (e) {}
        }

        /** Hand a pasted/dropped image to the host, which stores it beside the document. */
        function sendImageToHost(file) {
            if (!file) return false;
            try {
                const reader = new FileReader();
                reader.onload = function () {
                    const res = String(reader.result || '');
                    const comma = res.indexOf(',');
                    if (comma < 0) return;
                    const b64 = res.slice(comma + 1);
                    let ext = (file.type || 'image/png').split('/')[1] || 'png';
                    ext = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
                    if (ext === 'jpeg') ext = 'jpg';
                    postMsg('image_paste:' + ext + ':' + b64);
                };
                reader.readAsDataURL(file);
                return true;
            } catch (e) { return false; }
        }

        /** First image on the clipboard/drop payload, or null. */
        function firstImageFile(dataTransfer) {
            if (!dataTransfer) return null;
            const items = dataTransfer.items;
            if (items) {
                for (let i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file' && /^image\//.test(items[i].type || '')) {
                        const f = items[i].getAsFile();
                        if (f) return f;
                    }
                }
            }
            const files = dataTransfer.files;
            if (files) {
                for (let i = 0; i < files.length; i++) {
                    if (/^image\//.test(files[i].type || '')) return files[i];
                }
            }
            return null;
        }

        editor.addEventListener('paste', (e) => {
            if (state.mode === 'source') return;
            const dt = e.clipboardData || window.clipboardData;

            // Image on the clipboard wins over any text flavour (screenshots carry both)
            const img = firstImageFile(dt);
            if (img) {
                e.preventDefault();
                sendImageToHost(img);
                return;
            }

            e.preventDefault();

            // Try HTML first for external rich content (browser pages, Word, etc.)
            // Skip if it's TypoZen's own copy (marked with data-source="typozen")
            let text = '';
            const html = dt ? dt.getData('text/html') : '';
            if (html && html.indexOf('data-source="typozen"') === -1) {
                text = htmlToMarkdown(html);
            }
            if (!text) {
                text = dt ? dt.getData('text/plain') : '';
            }
            if (!text) return;

            // Pasting over a selection that spans lines: collapse it ourselves first, or
            // the insert lands in a leftover block and the lines never rejoin.
            const over = removeCrossBlockSelection();
            if (over) {
                try { setCaretAtOffset(over.block, over.offset); }
                catch (err) {
                    try {
                        const r = document.createRange();
                        r.selectNodeContents(over.block);
                        r.collapse(false);
                        const s = window.getSelection();
                        s.removeAllRanges();
                        s.addRange(r);
                    } catch (err2) {}
                }
            }
            insertPastedPlainText(text);
        });

        // Drag & drop an image file straight into the document
        editor.addEventListener('dragover', (e) => {
            if (state.mode === 'source') return;
            if (firstImageFile(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
        });
        editor.addEventListener('drop', (e) => {
            if (state.mode === 'source') return;
            const img = firstImageFile(e.dataTransfer);
            if (!img) return;
            e.preventDefault();
            sendImageToHost(img);
        });
        sourceEditor.addEventListener('dragover', (e) => {
            if (state.mode !== 'source') return;
            if (firstImageFile(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
        });
        sourceEditor.addEventListener('drop', (e) => {
            if (state.mode !== 'source') return;
            const img = firstImageFile(e.dataTransfer);
            if (!img) return;
            e.preventDefault();
            sendImageToHost(img);
        });

        // Alt reveals hidden chrome. The page is the ONLY component that sees this key
        // while the editor has focus: the WebView's HWND belongs to the browser process,
        // so it never reaches the host's message loop or WPF's KeyDown.
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Alt' || e.keyCode === 18) { postMsg('reveal_chrome'); return; }
            // Alt+F / Alt+E / ... must open the matching menu. WPF drew the underlines
            // but never sees the key while the editor has focus, so forward it. AltGr
            // sets ctrlKey too and is excluded, or accented input would trigger menus.
            if (e.altKey && !e.ctrlKey && !e.metaKey && e.key && e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
                // Alt+S is the search sidebar, handled here. It must be claimed before the
                // menu_access forward below, or the host would hunt for a top-level menu
                // with S as its access key. No menu uses S (they are F/E/V/T/H).
                if (e.key.toLowerCase() === 's') {
                    handleCommand('toggle_search_sidebar');
                    e.preventDefault();
                    return;
                }
                postMsg('menu_access:' + e.key.toLowerCase());
                e.preventDefault();
            }
            // Alt+\ toggles the sidebar (show/hide without changing tab or clearing search).
            // Backslash is not [a-zA-Z] so it needs its own check.
            if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === '\\' || e.key === '|')) {
                handleCommand('toggle_sidebar');
                e.preventDefault();
                return;
            }
        }, true);

        window.addEventListener('keydown', (e) => {
            if (window.isComposing || e.isComposing || e.keyCode === 229) return;
            // Do not handle editor shortcuts while typing in Find
            if (isFindBarOpen()) {
                const t = e.target;
                if (t && (t.id === 'findInput' || (t.closest && t.closest('#findBar')))) return;
            }
            // Nested list Tab — safe reload path only (never multi writeBlockRaw)
            if (e.key === 'Tab' && state.mode !== 'source' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                if (editor && (document.activeElement === editor || editor.contains(document.activeElement) || editor.contains(e.target))) {
                    const delta = e.shiftKey ? -1 : 1;
                    if (applyListIndentToSelection(delta)) {
                        e.preventDefault();
                        e.stopPropagation();
                        return;
                    }
                    // Non-list inside editor: keep focus in editor
                    if (document.activeElement === editor || editor.contains(document.activeElement)) {
                        e.preventDefault();
                        return;
                    }
                }
            }
            if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.toLowerCase() === 'a') {
                if (state.mode !== 'source' && (document.activeElement === editor || editor.contains(document.activeElement))) {
                    e.preventDefault();
                    const range = document.createRange();
                    range.selectNodeContents(editor);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }
            }
            // Ctrl+Z / Ctrl+Y: run HistoryManager here. Host may also send cmd:undo when
            // focus is outside WebView; HistoryManager._navCoalesceMs collapses doubles.
            // (Host-only was completely broken when preprocess did not see the key.)
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                e.stopPropagation();
                if (typeof HistoryManager !== 'undefined') {
                    if (e.shiftKey) HistoryManager.redo();
                    else HistoryManager.undo();
                }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                e.stopPropagation();
                if (typeof HistoryManager !== 'undefined') HistoryManager.redo();
                return;
            }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
                e.preventDefault();
                applyFormatting('bold');
            }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
                e.preventDefault();
                applyFormatting('italic');
            }
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                applyFormatting('link');
            }
            else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
                e.preventDefault();
                applyFormatting('strike');
            }
            // Zoom: host owns WebView2.ZoomFactor — page only requests (reliable when editor focused)
            else if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) {
                e.preventDefault();
                e.stopPropagation();
                postMsg('zoom:in');
            }
            else if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) {
                e.preventDefault();
                e.stopPropagation();
                postMsg('zoom:out');
            }
            else if ((e.ctrlKey || e.metaKey) && (e.key === '0' || e.code === 'Numpad0')) {
                e.preventDefault();
                e.stopPropagation();
                postMsg('zoom:reset');
            }
            // Tabs: host owns DocTab list
            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
                e.preventDefault();
                e.stopPropagation();
                postMsg('tab:close');
            }
            else if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                postMsg(e.shiftKey ? 'tab:prev' : 'tab:next');
            }
        });

        // Ctrl+wheel: ask host to step ZoomFactor (preventDefault stops any leftover browser zoom)
        let lastPageScrollTime = 0;
        let currentTwoColPage = 0;
        window.addEventListener('wheel', function (e) {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                if (e.deltaY < 0) postMsg('zoom:in');
                else if (e.deltaY > 0) postMsg('zoom:out');
                return;
            }
            if (state.pageAdvance) {
                if (e.target && e.target.closest && e.target.closest('#sidebar')) return;
                
                e.preventDefault();
                let now = Date.now();
                if (now - lastPageScrollTime < 150) return; // debounce quick spins
                lastPageScrollTime = now;
                
                // One page per gesture, to an absolute offset from the page map. The old
                // path scrolled by a fraction of the window height, so pages never lined up
                // and the error compounded with every turn.
                PageMap.step((e.deltaY < 0 || e.deltaX < 0) ? -1 : 1);
            }
        }, { passive: false, capture: true });

        /**
         * Page / scroll keyboard navigation. Product rules (docs/for-agents.md, README):
         *
         *   Preview (caret real): arrows edit; PageUp/PageDown (and wheel) turn pages.
         *   Search mode (live matches): Up/Down = hits (bindReaderFindKeys); Left/Right
         *     and PageUp/PageDown turn pages when paginated.
         *   Reader / book (no caret): Left/Up/PageUp and Right/Down/PageDown turn pages;
         *     Space / Shift+Space too.
         *
         * Never skip PageUp/PageDown just because #editor is contenteditable — that made
         * paging dead in Preview. Only INPUT/TEXTAREA and chrome fields bail out above.
         */
        document.addEventListener('keydown', function (e) {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            if (t && t.closest && t.closest('#sidebar, #findBar, #tableModal, #helpModal, #aboutModal, #aboutModal')) return;

            const hasSearchHits = !!(typeof findState !== 'undefined'
                && findState.matches && findState.matches.length);
            // Reader sets contenteditable=false; Preview keeps a real caret.
            const readerLike = !(t && t.isContentEditable);

            // --- Paginated: PageMap owns page turns ---
            if (state.pageAdvance && typeof isPaginatedLayout === 'function' && isPaginatedLayout()
                && typeof PageMap !== 'undefined' && PageMap.step) {
                // Up/Down with live hits → search step (other capture handler).
                if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && hasSearchHits) {
                    return;
                }

                let dir = 0;
                if (e.key === 'PageDown') dir = 1;
                else if (e.key === 'PageUp') dir = -1;
                else if (hasSearchHits) {
                    // Search mode: Left/Right page; Up/Down already returned above.
                    if (e.key === 'ArrowRight') dir = 1;
                    else if (e.key === 'ArrowLeft') dir = -1;
                    else return;
                } else if (readerLike) {
                    // Reader / book: all arrows + Space page.
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') dir = 1;
                    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') dir = -1;
                    else if (e.key === ' ') dir = e.shiftKey ? -1 : 1;
                    else return;
                } else {
                    // Preview editing: only PageUp/PageDown (and wheel elsewhere).
                    return;
                }

                e.preventDefault();
                e.stopPropagation();
                const now = Date.now();
                if (now - lastPageScrollTime < 90) return;
                lastPageScrollTime = now;
                PageMap.step(dir);
                try {
                    if (typeof rememberStickyFromPreviewScroll === 'function')
                        rememberStickyFromPreviewScroll();
                } catch (eSt) {}
                return;
            }

            // --- Scroll Preview: PageUp/Down scroll #main-container (not caret-only) ---
            if (!state.pageAdvance && state.mode !== 'source') {
                const main = document.getElementById('main-container');
                if (!main) return;
                const inDoc = !t || t === editor || (editor && editor.contains(t))
                    || t === main || t === document.body || t === document.documentElement;
                if (!inDoc) return;

                // Search mode: Up/Down still step hits (other handler); don't scroll.
                if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && hasSearchHits) return;

                let delta = 0;
                if (e.key === 'PageDown') delta = 1;
                else if (e.key === 'PageUp') delta = -1;
                else if (e.key === ' ' && !e.shiftKey && readerLike) delta = 1;
                else if (e.key === ' ' && e.shiftKey && readerLike) delta = -1;
                else return;

                e.preventDefault();
                e.stopPropagation();
                const amount = Math.max(120, (main.clientHeight || 400) - 48);
                main.scrollBy(0, delta * amount);
                try {
                    if (typeof rememberStickyFromPreviewScroll === 'function')
                        rememberStickyFromPreviewScroll();
                } catch (eSt2) {}
            }
        }, { capture: true });

        function setCaretAtOffset(el, targetOffset) {
            const sel = window.getSelection();
            const range = document.createRange();
            let currentOffset = 0;
            let found = false;

            function walk(node) {
                if (found) return;
                if (node.nodeType === Node.TEXT_NODE) {
                    const len = node.nodeValue.length;
                    if (currentOffset + len >= targetOffset) {
                        range.setStart(node, targetOffset - currentOffset);
                        range.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(range);
                        found = true;
                    } else {
                        currentOffset += len;
                    }
                } else if (node.nodeName === 'BR') {
                    if (currentOffset >= targetOffset) {
                        range.setStartBefore(node);
                        range.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(range);
                        found = true;
                    } else {
                        currentOffset += 1;
                    }
                } else {
                    for (let i = 0; i < node.childNodes.length; i++) {
                        walk(node.childNodes[i]);
                        if (found) return;
                    }
                }
            }
            walk(el);
            // An empty block has no child nodes and no text to walk, so the guard that used
            // to stand here -- childNodes.length > 0 -- excluded the one case the fallback
            // exists for: the caret was left wherever it already was, and typing into a
            // blank line went into whatever block the selection happened to be in, or
            // nowhere. selectNodeContents on an empty element is a valid collapsed range.
            if (!found) {
                range.selectNodeContents(el);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }

        // Capture phase on the contenteditable root: browser list Backspace merges
        // <li> into the previous block BEFORE bubble handlers on .block run.
        // Also: one physical Backspace can fire BOTH keydown and beforeinput — after we
        // strip the marker, the second event must be swallowed or it merges (111hello).
        if (typeof editor !== 'undefined' && editor) {
            function onEditorListBackspaceCapture(e) {
                if (window.isComposing || e.isComposing || e.keyCode === 229) return;
                if (state.mode === 'source') return;
                const isBackspaceKey = e.type === 'keydown' && e.key === 'Backspace';
                const isBackspaceInput = e.type === 'beforeinput' && e.inputType === 'deleteContentBackward';
                if (!isBackspaceKey && !isBackspaceInput) return;

                // Paired event after we already stripped/outdented — block browser merge
                if (isListBackspaceLocked()) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                    return;
                }

                const sel = window.getSelection();
                if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
                if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;

                const block = getAncestorBlock(sel.anchorNode);
                if (!block) return;
                if (!handleListBackspaceAtStart(block)) return;

                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            }
            editor.addEventListener('keydown', onEditorListBackspaceCapture, true);
            editor.addEventListener('beforeinput', onEditorListBackspaceCapture, true);

            // Large multi-block Delete/Backspace — handle ourselves (see handleMultiBlockSelectionDelete).
            editor.addEventListener('keydown', function onEditorMultiBlockDeleteKey(e) {
                if (e.key !== 'Backspace' && e.key !== 'Delete') return;
                if (e.defaultPrevented) return;
                try {
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal, #helpModal, #aboutModal')) return;
                } catch (err) {}
                handleMultiBlockSelectionDelete(e);
            }, true);
            editor.addEventListener('beforeinput', function onEditorMultiBlockDeleteInput(e) {
                if (!e || !e.inputType) return;
                if (e.inputType !== 'deleteContentBackward' && e.inputType !== 'deleteContentForward'
                    && e.inputType !== 'deleteByCut' && e.inputType !== 'deleteByDrag') return;
                if (e.defaultPrevented) return;
                handleMultiBlockSelectionDelete(e);
            }, true);

            // Copy: write our own text/plain so external apps get one line per line.
            // The browser's default double-spaced everything (div > p per block).
            editor.addEventListener('copy', function onEditorCopy(e) {
                if (state.mode === 'source') return;   // the textarea copies correctly already
                try {
                    if (!e.clipboardData) return;
                    const text = selectionToPlainText();
                    if (!text) return;
                    const sel = window.getSelection();
                    const holder = document.createElement('div');
                    // Mark it as ours, and keep the marker on the element that is serialised.
                    //
                    // The paste handler has always looked for this so it would take the
                    // plain text for TypoZen's own copies, and nothing ever wrote it: the
                    // HTML went out as holder.innerHTML, which discards the holder. Harmless
                    // while htmlToMarkdown ignored block containers, and not harmless once
                    // they contributed a separator -- every .block became a paragraph, so
                    // copying four consecutive lines and pasting them gave four lines with a
                    // blank between each.
                    holder.setAttribute('data-source', 'typozen');
                    holder.appendChild(sel.getRangeAt(0).cloneContents());
                    e.clipboardData.setData('text/plain', text);
                    // The HTML flavour is cloneContents() of the live range, so it can only
                    // ever carry what is mounted. On a select-all over a virtualised or
                    // windowed document the plain text is now the WHOLE document (see
                    // selectionIsWholeVirtualDocument) while this would still be the window
                    // -- so offering it would hand a rich target 1% and call it formatting.
                    // Omit it and let every target fall back to the complete text; the
                    // content is Markdown, which loses nothing by travelling as text.
                    const partialHtml = (typeof selectionIsWholeVirtualDocument === 'function')
                        && selectionIsWholeVirtualDocument(sel.getRangeAt(0));
                    if (!partialHtml) {
                        e.clipboardData.setData('text/html', holder.outerHTML); // rich paste
                    }
                    e.preventDefault();
                } catch (err) {}
            });

            // FUNDAMENTAL: Enter always creates a new .block (capture on editor so it
            // cannot be missed). Browser default inserts <div>/<br> inside one .block —
            // that looks like rows in Preview but is ONE source line (the wipe root cause).
            editor.addEventListener('keydown', function onEditorEnterCapture(e) {
                if (window.isComposing || e.isComposing || e.keyCode === 229) return;
                if (state.mode === 'source') return;
                if (e.key !== 'Enter') return;
                if (e.defaultPrevented) return;
                // Find bar / modals own Enter
                try {
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal, #helpModal, #aboutModal')) return;
                } catch (err) {}

                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

                const sel = window.getSelection();
                let block = null;
                if (sel && sel.anchorNode && editor.contains(sel.anchorNode)) {
                    block = getAncestorBlock(sel.anchorNode);
                }
                if (!block) {
                    // Caret not in a .block — ensure one exists
                    const blocks = editor.querySelectorAll('.block');
                    block = blocks.length ? blocks[blocks.length - 1] : createBlock('');
                }
                handleEnterAtBlock(block, !!e.shiftKey);
            }, true);

            // Tab / Shift+Tab moves between table cells (and grows the table at the end).
            // Outside a table Tab keeps its existing meaning, so list indenting is intact.
            editor.addEventListener('keydown', function onEditorTableTab(e) {
                if (window.isComposing || e.isComposing || e.keyCode === 229) return;
                if (state.mode === 'source') return;
                if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
                if (e.defaultPrevented) return;
                try {
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal, #helpModal, #aboutModal')) return;
                } catch (err) {}
                if (!getTableContext()) return;      // not in a table: leave Tab alone
                if (tableTabNavigate(!!e.shiftKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                }
            }, true);

            // THE BROWSER ALSO EDITS. Spellcheck, cut, drag, autocorrect mutate the DOM.
            // onEditorInputSync + flushActiveBlockToRaw keep data-raw current (Phase 1).
            // getBlockRaw: focused → live DOM; unfocused → data-raw (no length heuristic).
            // IME composition. While a candidate window is open the DOM holds half-formed
        // text, so every handler that would rewrite data-raw stands down until it commits.
        // These listeners used to be attached per block, where they never fired at all —
        // leaving window.isComposing permanently false and every one of those guards inert.
        editor.addEventListener('compositionstart', function onEditorCompositionStart() {
            window.isComposing = true;
        });
        editor.addEventListener('compositionend', function onEditorCompositionEnd() {
            window.isComposing = false;
            try {
                let blk = null;
                try {
                    const sel = window.getSelection();
                    if (sel && sel.anchorNode) blk = getAncestorBlock(sel.anchorNode);
                } catch (eB) {}
                if (blk && typeof markBlockEdited === 'function') markBlockEdited(blk);
                flushActiveBlockToRaw();
                if (typeof HistoryManager !== 'undefined') HistoryManager.snapshot();
                updateStats();
            } catch (err) {}
        });

        editor.addEventListener('input', function onEditorInputSync(e) {
                if (window.isComposing || (e && e.isComposing)) return;
                if (state.mode === 'source') return;
                // Real edit: mark the block, then commit DOM → data-raw. Caret clicks
                // never set the flag, so they never rewrite storage (see markBlockEdited).
                try {
                    let blk = null;
                    try {
                        const sel = window.getSelection();
                        if (sel && sel.anchorNode) blk = getAncestorBlock(sel.anchorNode);
                    } catch (eB) {}
                    if (blk && typeof markBlockEdited === 'function') markBlockEdited(blk);
                    flushActiveBlockToRaw();
                    updateStats();
                } catch (err) {}
            });

        // Leaving a block: commit only if it was actually edited.
        editor.addEventListener('focusout', function onEditorFocusOutFlush(e) {
            if (state.mode === 'source') return;
            if (window.isComposing) return;
            try {
                const blk = e && e.target ? getAncestorBlock(e.target) : null;
                if (!blk || !editor.contains(blk)) return;
                if (typeof blockWasEdited === 'function' && !blockWasEdited(blk)) {
                    if (typeof clearBlockEdited === 'function') clearBlockEdited(blk);
                    return;
                }
                const raw = serializeBlockDomToRaw(blk);
                blk.setAttribute('data-raw', raw);
                setBlockListIndentAttr(blk, raw);
                try { touchLastGoodDocRawAtBlock(blk, raw); } catch (e2) {}
                try { blk.setAttribute('data-tz-dirty', '1'); } catch (e3) {}
                try { DocumentModel.syncElToModel(blk); } catch (e4) {}
                if (typeof clearBlockEdited === 'function') clearBlockEdited(blk);
                _contentCache = null;
            } catch (err) {}
        }, true);

            // Click an image to select it (contenteditable often won't let you "land" on it).
            editor.addEventListener('click', function onEditorImageClick(e) {
                if (state.mode === 'source') return;
                const img = e.target && e.target.closest ? e.target.closest('#editor img') : null;
                if (!img || !editor.contains(img)) return;
                try {
                    const range = document.createRange();
                    range.selectNode(img);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    const blk = getAncestorBlock(img);
                    if (blk) currentActiveBlock = blk;
                    e.preventDefault();
                } catch (err) {}
            }, true);

            /** True if this range touches the given image node. */
            function rangeTouchesImage(range, img) {
                try {
                    if (range.intersectsNode && range.intersectsNode(img)) return true;
                } catch (e) {}
                try {
                    if (range.startContainer === img || range.endContainer === img) return true;
                    if (img.contains && (img.contains(range.startContainer) || img.contains(range.endContainer))) return true;
                } catch (e2) {}
                return false;
            }

            /** Image immediately before/after a collapsed caret (for Backspace/Delete). */
            function imageBesideCaret(range, wantBefore) {
                try {
                    let node = range.startContainer;
                    let offset = range.startOffset;
                    if (node.nodeType === 3) {
                        // In a text node: before = previous sibling at offset 0; after = next at end
                        if (wantBefore && offset === 0) {
                            let p = node.previousSibling;
                            while (p && p.nodeType === 3 && !String(p.textContent || '').replace(/[\u200B\uFEFF]/g, '')) p = p.previousSibling;
                            if (p && p.tagName && p.tagName.toLowerCase() === 'img') return p;
                        }
                        if (!wantBefore && offset >= String(node.textContent || '').length) {
                            let n = node.nextSibling;
                            while (n && n.nodeType === 3 && !String(n.textContent || '').replace(/[\u200B\uFEFF]/g, '')) n = n.nextSibling;
                            if (n && n.tagName && n.tagName.toLowerCase() === 'img') return n;
                        }
                        return null;
                    }
                    if (node.nodeType === 1) {
                        const kids = node.childNodes;
                        if (wantBefore && offset > 0) {
                            let p = kids[offset - 1];
                            while (p && p.nodeType === 3 && !String(p.textContent || '').replace(/[\u200B\uFEFF]/g, '')) p = p.previousSibling;
                            if (p && p.tagName && p.tagName.toLowerCase() === 'img') return p;
                        }
                        if (!wantBefore && offset < kids.length) {
                            let n = kids[offset];
                            while (n && n.nodeType === 3 && !String(n.textContent || '').replace(/[\u200B\uFEFF]/g, '')) n = n.nextSibling;
                            if (n && n.tagName && n.tagName.toLowerCase() === 'img') return n;
                        }
                    }
                } catch (e) {}
                return null;
            }

            /**
             * Delete/Backspace when an image is selected or the caret is next to one.
             * Updates data-raw so the picture cannot reappear from stale markdown.
             */
            function handleImageDeleteKey(e) {
                if (window.isComposing || (e && e.isComposing) || (e && e.keyCode === 229)) return false;
                if (state.mode === 'source') return false;
                const isBs = e && (e.key === 'Backspace' || (e.inputType && e.inputType === 'deleteContentBackward'));
                const isDel = e && (e.key === 'Delete' || (e.inputType && (e.inputType === 'deleteContentForward' || e.inputType === 'deleteByCut')));
                if (!isBs && !isDel) return false;

                const sel = window.getSelection();
                if (!sel || !sel.rangeCount) return false;
                const range = sel.getRangeAt(0);
                const block = getAncestorBlock(range.startContainer) || getAncestorBlock(range.endContainer);
                if (!block || !editor.contains(block)) return false;

                let img = null;
                if (!sel.isCollapsed) {
                    const imgs = block.querySelectorAll('img');
                    for (let i = 0; i < imgs.length; i++) {
                        if (rangeTouchesImage(range, imgs[i])) { img = imgs[i]; break; }
                    }
                } else {
                    img = isBs ? imageBesideCaret(range, true) : imageBesideCaret(range, false);
                    // Image-only line: caret in empty block that still has an img
                    if (!img) {
                        const imgs = block.querySelectorAll('img');
                        if (imgs.length === 1) {
                            const plain = String(block.innerText || '').replace(/[\u200B\uFEFF\s]/g, '');
                            if (!plain) img = imgs[0];
                        }
                    }
                }
                if (!img) return false;

                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

                const pre = getMarkdownContent(false);
                try { img.remove(); } catch (err) {}
                let raw = '';
                try { raw = coerceBlockRaw(blockHtmlToMarkdown(block)); } catch (err2) { raw = ''; }
                // Guarantee markdown image tokens match remaining DOM images
                const still = block.querySelectorAll('img').length;
                if (countMdImages(raw) > still) {
                    // Remove one image token (the one we deleted) — drop last if ambiguous
                    raw = raw.replace(/!\[[^\]]*\]\([^)]*\)/, '').replace(/[ \t]{2,}/g, ' ').trim();
                }
                writeBlockRaw(block, raw);
                try {
                    window.isProgrammaticFocus = true;
                    focusBlock(block, (raw || '').length);
                } catch (err3) {}
                const post = getMarkdownContent(false);
                if (typeof HistoryManager !== 'undefined') HistoryManager.recordEditPair(pre, post);
                updateStats();
                try { updateOutline(); } catch (err4) {}
                return true;
            }

            editor.addEventListener('keydown', function (e) {
                if (e.key === 'Backspace' || e.key === 'Delete') handleImageDeleteKey(e);
            }, true);
            editor.addEventListener('beforeinput', function (e) {
                if (!e || !e.inputType) return;
                if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward'
                    || e.inputType === 'deleteByCut') handleImageDeleteKey(e);
            }, true);

            // Cut across lines: do the removal ourselves. Ctrl+X is excluded from the
            // cross-boundary keydown guard (it tests for a bare character), so the browser
            // was left to restructure the blocks.
            editor.addEventListener('cut', function onEditorCut(e) {
                if (state.mode === 'source') return;
                try {
                    if (typeof snapshotMultiBlockSelectionFromLive === 'function')
                        snapshotMultiBlockSelectionFromLive();
                } catch (eSnap) {}
                const sel = window.getSelection();
                let multi = false;
                if (sel && !sel.isCollapsed && sel.rangeCount
                    && sel.anchorNode && editor.contains(sel.anchorNode)) {
                    const range = sel.getRangeAt(0);
                    const startBlock = getAncestorBlock(range.startContainer);
                    const endBlock = getAncestorBlock(range.endContainer);
                    if (startBlock && endBlock && startBlock !== endBlock) multi = true;
                }
                if (!multi && typeof _mbSelFreeze !== 'undefined' && _mbSelFreeze
                    && _mbSelFreeze.toIdx > _mbSelFreeze.fromIdx) multi = true;
                if (!multi) return;  // one block: browser is fine

                try {
                    if (e.clipboardData) e.clipboardData.setData('text/plain', selectionToPlainText());
                } catch (err) {}
                e.preventDefault();

                // History is recorded inside applyModelMultiBlockDelete (via removeCrossBlockSelection).
                const cutAt = removeCrossBlockSelection();
                if (cutAt) {
                    window.isProgrammaticFocus = true;
                    if (cutAt.block) {
                        focusBlock(cutAt.block);
                        setTimeout(function () {
                            try { setCaretAtOffset(cutAt.block, cutAt.offset); } catch (err2) {}
                            try { ensureCaretVisible(cutAt.block); } catch (err3) {}
                        }, 0);
                    }
                }
                updateStats();
                updateOutline();
            });

            // Dragging text WITHIN the document moves DOM nodes between blocks with no
            // handler to reconcile them. Blocking the drag is a fair trade: it is a rare
            // gesture and the alternative is corrupted structure. Dropping files in still
            // works — that is the 'drop' handler, not 'dragstart'.
            editor.addEventListener('dragstart', function onEditorDragStart(e) {
                if (state.mode === 'source') return;
                e.preventDefault();
            });

            // Backspace at the START of a line must merge it into the previous line —
            // and we must do it ourselves.
            //
            // Left to the browser, contenteditable merges the two <p>s into ONE .block.
            // blockHtmlToMarkdown then keeps "the first meaningful child only" (one block =
            // one line), so the second paragraph was silently dropped: Backspace joined the
            // lines and destroyed the text of the one you were on.
            //
            // Registered after the list-Backspace capture handler, which stops propagation
            // when it handles a list line, so 2-stage list behaviour still wins.
            editor.addEventListener('keydown', function onEditorBackspaceMerge(e) {
                if (window.isComposing || e.isComposing || e.keyCode === 229) return;
                if (state.mode === 'source') return;
                if (e.key !== 'Backspace') return;
                if (e.defaultPrevented) return;
                try {
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal, #helpModal, #aboutModal')) return;
                } catch (err) {}

                const sel = window.getSelection();
                if (!sel || !sel.rangeCount || !sel.isCollapsed) return;   // selections handled elsewhere
                if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;

                const block = getAncestorBlock(sel.anchorNode);
                if (!block) return;
                if (!isCaretAtStartOfBlock(block)) return;                 // mid-line: browser deletes a character

                const curRaw = normalizeBlockRaw(readBlockRawSafe(block));

                // 2-stage: at column 0 of a heading or quote, first press strips the marker
                if (/^(#{1,6}|>)\s+/.test(curRaw)) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                    HistoryManager.beginEdit();
                    writeBlockRaw(block, curRaw.replace(/^(#{1,6}|>)\s+/, ''));
                    window.isProgrammaticFocus = true;
                    focusBlock(block);
                    setTimeout(function () {
                        try { setCaretAtOffset(block, 0); } catch (err2) {}
                    }, 0);
                    updateStats();
                    updateOutline();
                    HistoryManager.commitEdit();
                    return;
                }

                const prev = block.previousElementSibling;
                if (!prev || !prev.classList.contains('block')) return;    // first line: nothing to merge into

                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

                HistoryManager.beginEdit();
                const prevRaw = normalizeBlockRaw(readBlockRawSafe(prev));
                const joinAt = prevRaw.length;
                writeBlockRaw(prev, prevRaw + curRaw);
                removeBlockEl(block);
                window.isProgrammaticFocus = true;
                focusBlock(prev);
                setTimeout(function () {
                    try { setCaretAtOffset(prev, joinAt); } catch (err3) {}
                    ensureCaretVisible(prev);
                }, 0);
                updateStats();
                updateOutline();
                HistoryManager.commitEdit();
            }, true);

            // FUNDAMENTAL, same reason as Enter above: only #editor is contenteditable, so
            // a real keydown targets #editor and NEVER reaches a listener on a child .block
            // (children are descendants of the target, not ancestors — nothing propagates
            // down to them). Forward Delete at end of line has to merge the next block in,
            // because the browser cannot merge sibling .block <div>s by itself.
            editor.addEventListener('keydown', function onEditorForwardDeleteCapture(e) {
                if (window.isComposing || e.isComposing || e.keyCode === 229) return;
                if (state.mode === 'source') return;
                if (e.key !== 'Delete') return;
                // Delivery counter: lets the E2E tell 'the key never arrived' (a SendKeys
                // problem) apart from 'the handler ran and did nothing' (a real bug).
                window.__tzDeleteSeen = (window.__tzDeleteSeen || 0) + 1;
                if (e.defaultPrevented) return;
                try {
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal, #helpModal, #aboutModal')) return;
                } catch (err) {}

                const sel = window.getSelection();
                if (!sel || !sel.rangeCount || !sel.isCollapsed) return;      // selection delete: handled elsewhere
                if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;

                const block = getAncestorBlock(sel.anchorNode);
                if (!block) return;
                if (!isCaretAtEndOfBlock(block)) return;                      // mid-line: browser deletes a character

                const next = block.nextElementSibling;
                if (!next || !next.classList.contains('block')) return;       // last line: nothing to pull up

                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

                HistoryManager.beginEdit();
                // readBlockRawSafe, NOT a bare data-raw read. data-raw is transiently blank
                // in this editor while the DOM still shows the text; trusting it meant the
                // pulled-up line's content was read as "" and then destroyed when the block
                // was removed. Intermittent, and it ate whole lines when it hit.
                const curRaw = normalizeBlockRaw(readBlockRawSafe(block));
                let tailRaw = normalizeBlockRaw(readBlockRawSafe(next));
                // Joining onto real text drops the pulled-up line's own marker so we do not
                // get "- one- two". Pulling onto an EMPTY line keeps it, so deleting a blank
                // line above a list leaves the list item intact.
                if (curRaw !== '') {
                    tailRaw = isListLine(tailRaw) ? stripListMarkerKeepBody(tailRaw) : stripBlockPrefix(tailRaw);
                }

                const joinAt = curRaw.length;
                writeBlockRaw(block, curRaw + tailRaw);
                removeBlockEl(next);
                window.isProgrammaticFocus = true;
                focusBlock(block);
                setTimeout(function () {
                    try { setCaretAtOffset(block, joinAt); } catch (err) {}
                    ensureCaretVisible(block);
                }, 0);
                updateStats();
                updateOutline();
                HistoryManager.commitEdit();
            }, true);
        }

        /**
         * Split one visual line → one .block.
         * Browser contenteditable often injects <div>line2</div> or <br> inside a single
         * .block. That shows as multiple Preview rows but data-raw / Source is one line
         * (often with lines concatenated). Expand to real sibling .blocks.
         */
        /**
         * Drop trailing empty "lines" that are really browser filler.
         *
         * Chrome puts a bogus <br> inside a block whose text you just deleted, so it stays
         * focusable. That <br> is not content, but the split logic counted it as another
         * visual line — so emptying a line spawned phantom blank blocks below it (delete
         * the last two characters of a line and you got the line back plus two blank ones).
         * A real blank line in this editor is always its own .block, because Enter is
         * intercepted and never leaves a soft break inside a block, so a trailing empty
         * piece is always filler.
         */
        function dropTrailingFillerLines(pieces) {
            if (!pieces) return pieces;
            while (pieces.length > 1 && String(pieces[pieces.length - 1] || '').trim() === '') {
                pieces.pop();
            }
            return pieces;
        }

        function collectVisualLineTexts(block) {
            if (!block) return [''];
            // Fence / table: leave alone
            const attr = block.getAttribute('data-raw');
            if (attr != null && isMultilineBlockRaw(attr)) {
                return [normalizeBlockRaw(attr)];
            }

            const children = Array.prototype.slice.call(block.children || []);
            // Multiple block-level children (Chrome Enter default): each is a line
            if (children.length > 1) {
                const pieces = [];
                for (let i = 0; i < children.length; i++) {
                    const ch = children[i];
                    const tag = (ch.tagName || '').toLowerCase();
                    if (tag === 'br') {
                        pieces.push('');
                        continue;
                    }
                    // Skip nested .block (should not happen)
                    if (ch.classList && ch.classList.contains('block')) continue;
                    const t = String(ch.innerText || ch.textContent || '')
                        .replace(/\u00a0/g, ' ')
                        .replace(/\r\n/g, '\n')
                        .replace(/\n+/g, ' ')
                        .replace(/[ \t]+/g, ' ')
                        .trim();
                    pieces.push(t);
                }
                dropTrailingFillerLines(pieces);
                if (pieces.length > 1) return pieces;
            }

            // <br> soft breaks inside a single child
            const html = block.innerHTML || '';
            if (/<br\s*\/?>/i.test(html)) {
                const t = String(block.innerText || '').replace(/\u00a0/g, ' ');
                const parts = t.split(/\n/).map(function (l) {
                    return String(l).replace(/[ \t]+/g, ' ').trim();
                });
                dropTrailingFillerLines(parts);
                if (parts.length > 1) return parts;
            }

            // Single line: prefer data-raw
            if (attr != null && attr !== '') return [normalizeBlockRaw(attr)];
            const one = String(block.innerText || block.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\n+/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .trim();
            return [one];
        }

        function expandFragmentedBlock(block) {
            if (!block || !editor || !editor.contains(block)) return null;
            if (state.mode === 'source') return null;
            const attr = block.getAttribute('data-raw');
            if (attr != null && isMultilineBlockRaw(attr)) return null;

            const pieces = collectVisualLineTexts(block);
            if (!pieces || pieces.length <= 1) return null;

            // First piece stays in this block
            writeBlockRaw(block, pieces[0]);
            let prev = block;
            const created = [block];
            for (let i = 1; i < pieces.length; i++) {
                prev = createBlock(pieces[i], prev);
                created.push(prev);
            }
            try { refreshLastGoodDocRaws(); } catch (e) {}
            return created;
        }

        function expandAllFragmentedBlocks() {
            if (!editor || state.mode === 'source') return;
            const blocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
            for (let i = 0; i < blocks.length; i++) {
                // Query again — previous expand inserts siblings
                expandFragmentedBlock(blocks[i]);
            }
        }

        /** Enter: always a new sibling .block (never browser soft-break inside current). */
        /**
         * Keep the caret's line inside the scroll viewport.
         *
         * Nothing did this outside typewriter mode, so pressing Enter at the bottom of the
         * window pushed the new line below the fold: the caret was off screen and you could
         * carry on typing with no visible change. Every editor scrolls to follow the caret.
         */
        function ensureCaretVisible(block) {
            try {
                if (!block || state.mode === 'source') return;
                if (state.typewriterMode) { applyTypewriterScroll(true); return; }
                const container = mainContainer;
                if (!container) return;

                const cRect = container.getBoundingClientRect();
                const bRect = block.getBoundingClientRect();
                const margin = 28;   // a little breathing room, not flush against the edge

                if (bRect.bottom > cRect.bottom - margin) {
                    container.scrollTop += bRect.bottom - (cRect.bottom - margin);
                } else if (bRect.top < cRect.top + margin) {
                    container.scrollTop -= (cRect.top + margin) - bRect.top;
                }
            } catch (e) {}
        }

        function handleEnterAtBlock(block, shiftKey) {
            if (!block) return;
            HistoryManager.beginEdit();
            let afterText = '';
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
                try {
                    const range = sel.getRangeAt(0);
                    if (block.contains(range.endContainer)) {
                        const tailRange = range.cloneRange();
                        tailRange.selectNodeContents(block);
                        tailRange.setStart(range.endContainer, range.endOffset);
                        afterText = tailRange.toString();
                        tailRange.deleteContents();
                    }
                } catch (err) {}
            }

            // Sync current block raw from DOM after split
            let raw = block.getAttribute('data-raw');
            if (raw == null || raw === '') {
                raw = state.revealOnFocus ? (block.innerText || '') : blockHtmlToMarkdown(block);
            } else if (state.revealOnFocus) {
                // Prefer remaining text after deleteContents
                const left = String(block.innerText || '').replace(/\u00a0/g, ' ');
                if (left.trim().length <= String(raw).trim().length) raw = left;
            } else {
                // Re-read DOM for left part
                try {
                    const leftMd = blockHtmlToMarkdown(block);
                    if (leftMd != null) raw = leftMd;
                } catch (e) {}
            }
            raw = coerceBlockRaw(raw);
            writeBlockRaw(block, raw);

            let nextRaw = afterText;
            if (!shiftKey && !String(afterText || '').trim()) {
                const lp = parseListLine(raw);
                if (lp) {
                    if (lp.kind === 'ol') {
                        nextRaw = formatListLine({
                            indent: lp.indent,
                            kind: 'ol',
                            num: (lp.num || 1) + 1,
                            body: ''
                        });
                    } else if (lp.kind === 'task') {
                        nextRaw = formatListLine({
                            indent: lp.indent,
                            kind: 'task',
                            checked: false,
                            body: ''
                        });
                    } else {
                        nextRaw = formatListLine({
                            indent: lp.indent,
                            kind: 'ul',
                            bullet: lp.bullet || '-',
                            body: ''
                        });
                    }
                } else {
                    nextRaw = '';
                }
            } else {
                nextRaw = coerceBlockRaw(afterText);
            }

            const newBlock = createBlock(nextRaw, block);
            // Caret goes to the START of text carried down by the split — that is where the
            // split point now is. It used to always land at the END, so pressing Enter at
            // the beginning of a line pushed the line down and dumped the caret after it;
            // a second Enter then split at the end and produced a blank line below as well.
            // A synthesised list marker ("- ", "2. ") is the exception: there you want the
            // caret after the marker, ready to type.
            const carriedText = String(afterText || '').length > 0;
            window.isProgrammaticFocus = true;
            focusBlock(newBlock);

            // Place the caret with a Range, not setCaretAtOffset: a brand-new empty block
            // has no text node, so offset-based placement silently did nothing and the
            // caret stayed on the original line — Enter appeared to "just move the cursor".
            // collapse(true) = start of text carried down; collapse(false) = after a
            // synthesised list marker.
            try {
                const caretRange = document.createRange();
                caretRange.selectNodeContents(newBlock);
                caretRange.collapse(carriedText);
                const caretSel = window.getSelection();
                caretSel.removeAllRanges();
                caretSel.addRange(caretRange);
            } catch (e3) {
                focusBlock(newBlock, carriedText ? 0 : (nextRaw || '').length);
            }
            ensureCaretVisible(newBlock);
            try { refreshLastGoodDocRaws(); } catch (e2) {}
            HistoryManager.commitEdit();
            updateStats();
            updateOutline();
        }

        function createBlock(rawText, insertAfter = null) {
            const block = document.createElement('div');
            block.className = 'block';
            const initialRaw = coerceBlockRaw(rawText == null ? '' : rawText);
            block.setAttribute('data-raw', initialRaw);

            renderBlockPreview(block, initialRaw);

            if (insertAfter && insertAfter.nextSibling) {
                editor.insertBefore(block, insertAfter.nextSibling);
            } else if (insertAfter) {
                editor.appendChild(block);
            } else {
                editor.appendChild(block);
            }

            // Keep DocumentModel in sync with structural insert (Enter, expand, …).
            try {
                let afterIdx = DocumentModel.modelIndexOfEl(insertAfter);
                if (afterIdx < 0 && insertAfter && editor) {
                    const all = editor.querySelectorAll('.block');
                    afterIdx = Array.prototype.indexOf.call(all, insertAfter);
                }
                if (afterIdx >= 0) {
                    const newIdx = DocumentModel.insertBlockAfterIndex(afterIdx, initialRaw);
                    block.setAttribute('data-model-index', String(newIdx));
                    if (DocumentModel.virtEnabled) mountVirtWindow(true);
                    else reindexMountedBlocks();
                } else if (!DocumentModel.virtEnabled) {
                    DocumentModel.rebuildFromFullDom();
                } else {
                    // Virt without index: append to model end
                    DocumentModel.blocks.push({ id: DocumentModel._nextId++, raw: initialRaw });
                    block.setAttribute('data-model-index', String(DocumentModel.blocks.length - 1));
                    mountVirtWindow(true);
                }
            } catch (eM) {}

            return block;
        }

        function blockHtmlToMarkdown(block) {
            // Nest level is not in the DOM list structure — keep it from the block attribute / prior data-raw
            let indentLevel = 0;
            const attr = block && block.getAttribute('data-list-indent');
            if (attr != null && attr !== '') {
                indentLevel = parseInt(attr, 10) || 0;
            } else if (block) {
                const prevRaw = block.getAttribute('data-raw');
                const prevP = parseListLine(prevRaw);
                if (prevP) indentLevel = prevP.indent;
            }
            const pad = listIndentPad(indentLevel);

            let clone = block.cloneNode(true);
            // Tree walk preserves nested marks. The old order (em → strong → del) used
            // innerText on outer tags, so <strong><del>x</del></strong> became **x** and
            // strikethrough vanished when Preview → Source / flush. Walk children first.
            function inlineNodeToMarkdown(node) {
                if (!node) return '';
                if (node.nodeType === 3) {
                    return String(node.nodeValue || '').replace(/\u00a0/g, ' ');
                }
                if (node.nodeType !== 1) return '';
                const tag = (node.tagName || '').toLowerCase();
                if (tag === 'br') return ' ';
                let inner = '';
                const kids = node.childNodes;
                for (let k = 0; k < kids.length; k++) {
                    inner += inlineNodeToMarkdown(kids[k]);
                }
                if (tag === 'del' || tag === 's' || tag === 'strike') {
                    return '~~' + inner + '~~';
                }
                if (tag === 'strong' || tag === 'b') {
                    const mark = node.getAttribute('data-mark') === 'u' ? '__' : '**';
                    return mark + inner + mark;
                }
                if (tag === 'em' || tag === 'i') {
                    const mark = node.getAttribute('data-mark') === 'u' ? '_' : '*';
                    return mark + inner + mark;
                }
                if (tag === 'code') {
                    if (node.parentElement && (node.parentElement.tagName || '').toLowerCase() === 'pre') {
                        return inner;
                    }
                    return '`' + inner + '`';
                }
                if (tag === 'a') {
                    return '[' + inner + '](' + (node.getAttribute('href') || '') + ')';
                }
                if (tag === 'img') {
                    return '![' + (node.getAttribute('alt') || '') + ']('
                        + (node.getAttribute('data-src') || node.getAttribute('src') || '') + ')';
                }
                if (tag === 'input' && (node.getAttribute('type') || '').toLowerCase() === 'checkbox') {
                    return node.checked ? '[x] ' : '[ ] ';
                }
                return inner;
            }
            // Serialize an element's content with nested marks intact (not innerText).
            function childInlineMd(el) {
                if (!el) return '';
                let out = '';
                const kids = el.childNodes;
                for (let k = 0; k < kids.length; k++) {
                    out += inlineNodeToMarkdown(kids[k]);
                }
                return out
                    .replace(/\u00a0/g, ' ')
                    .replace(/\r\n/g, '\n')
                    .replace(/\n+/g, ' ')
                    .replace(/[ \t]+/g, ' ')
                    .trim();
            }
            // data-src holds the path the author wrote; src may have been rewritten onto
            // the https://docfolder/ virtual host purely for display.

            if (clone.querySelector('table')) {
                const table = clone.querySelector('table');
                let md = [];
                const headerCells = Array.from(table.querySelectorAll('thead th'));
                const headers = headerCells.map(th => childInlineMd(th) || (th.innerText || '').trim());
                if (headers.length > 0) {
                    md.push('| ' + headers.join(' | ') + ' |');
                    // Read alignment back off the cells. This used to emit '---' for every
                    // column, so serializing an aligned table silently reset it — one
                    // keystroke in the table and your :---: was gone.
                    md.push('| ' + headerCells.map(th => {
                        const a = (th.style && th.style.textAlign) || '';
                        return tableAlignToSep(a);
                    }).join(' | ') + ' |');
                }
                table.querySelectorAll('tbody tr').forEach(tr => {
                    const cells = Array.from(tr.querySelectorAll('td')).map(td =>
                        childInlineMd(td) || (td.innerText || '').trim());
                    md.push('| ' + cells.join(' | ') + ' |');
                });
                return md.join('\n');
            }

            // Fenced code: allow multi-line
            if (clone.querySelector('pre')) {
                const codeEl = clone.querySelector('pre code') || clone.querySelector('pre');
                const langClass = codeEl.className || '';
                const match = langClass.match(/lang-(\w+)/);
                const lang = match ? match[1] : '';
                return '```' + lang + '\n' + codeEl.innerText + '\n```';
            }

            /**
             * ONE .block → ONE markdown line (except table/pre above).
             * contenteditable injects extra <br>/<div>; never join those with \n
             * (that reintroduced blank Source lines / doubled Preview rows).
             * Use the first meaningful child only; body newlines → spaces.
             */
            function childText(el) {
                return (el.innerText || el.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .replace(/\r\n/g, '\n')
                    .replace(/\n+/g, ' ')
                    .replace(/[ \t]+/g, ' ')
                    .trim();
            }

            function firstMeaningfulChild(root) {
                const kids = root.children;
                for (let i = 0; i < kids.length; i++) {
                    const child = kids[i];
                    const tag = child.tagName.toLowerCase();
                    if (tag === 'br') continue;
                    // Image-only lines: <p><img></p> has empty innerText — still meaningful.
                    if (tag === 'img' || child.querySelector && child.querySelector('img')) return child;
                    const t = childText(child);
                    if (!t && tag !== 'hr' && tag !== 'ul' && tag !== 'ol') continue;
                    return child;
                }
                return null;
            }

            const first = firstMeaningfulChild(clone);
            // Prefer mark-preserving serialize for bodies (headings, paragraphs, list items).
            const inlineBody = first ? childInlineMd(first) : childInlineMd(clone);
            const plain = inlineBody || childText(clone);

            if (first) {
                const tag = first.tagName.toLowerCase();
                if (tag === 'h1') return coerceBlockRaw('# ' + plain);
                if (tag === 'h2') return coerceBlockRaw('## ' + plain);
                if (tag === 'h3') return coerceBlockRaw('### ' + plain);
                if (tag === 'h4') return coerceBlockRaw('#### ' + plain);
                if (tag === 'h5') return coerceBlockRaw('##### ' + plain);
                if (tag === 'h6') return coerceBlockRaw('###### ' + plain);
                if (tag === 'blockquote') return coerceBlockRaw('> ' + plain);
                if (tag === 'ul' && clone.querySelector('.task-list-item')) {
                    const cb = clone.querySelector('input[type="checkbox"]');
                    const mark = cb && cb.checked ? 'x' : ' ';
                    const bodyEl = clone.querySelector('.task-text');
                    let body = bodyEl
                        ? (childInlineMd(bodyEl) || childText(bodyEl))
                        : plain.replace(/^\[[ xX]?\]\s*/, '');
                    return coerceBlockRaw(pad + '- [' + mark + '] ' + body);
                }
                if (tag === 'ul') {
                    const li = first.querySelector('li') || first;
                    return coerceBlockRaw(pad + '- ' + (childInlineMd(li) || childText(li)));
                }
                if (tag === 'ol') {
                    const start = first.getAttribute('start') || '1';
                    const li = first.querySelector('li') || first;
                    return coerceBlockRaw(pad + start + '. ' + (childInlineMd(li) || childText(li)));
                }
                if (tag === 'hr') return '---';
            }

            // Prefer preserving list/heading markers from data-raw when DOM is ambiguous
            const prev = block.getAttribute('data-raw');
            const prevList = parseListLine(prev);
            if (prevList) {
                prevList.body = plain.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s*/, '').replace(/^\[[ xX]?\]\s*/, '');
                return formatListLine(prevList);
            }
            if (prev && /^(#{1,6})\s+/.test(prev)) {
                const hashes = prev.match(/^(#{1,6})\s+/);
                return coerceBlockRaw(hashes[1] + ' ' + plain.replace(/^#{1,6}\s+/, ''));
            }
            if (prev && /^>\s+/.test(prev)) {
                return coerceBlockRaw('> ' + plain.replace(/^>\s+/, ''));
            }

            return coerceBlockRaw(plain);
        }

