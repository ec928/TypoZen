// TypoZen module: 07-stats-host.js
// Lines 12339-12720 of the former monolith. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.

        // --- STATS & OUTLINE UPDATE ---
        //
        // Serializing the whole document is O(number of blocks) and was happening on
        // EVERY keystroke — twice, because getCaretLineNumber re-serialized to count
        // lines. On a 3000-line document that measured ~19 ms per keypress, past the
        // frame budget, and it grows linearly with the file.
        //
        // updateStats() is now a debouncer; updateStatsNow() does the work. Counters and
        // the dirty marker lag typing by up to STATS_DEBOUNCE_MS, which is invisible, and
        // during continuous typing STATS_MAX_STALE_MS still forces a refresh so the word
        // count never freezes. Anything that needs an immediate, accurate reading calls
        // updateStatsNow() directly; the host's close path does not rely on this at all
        // (see getDocumentStateTagged).
        const STATS_DEBOUNCE_MS = 150;
        const STATS_MAX_STALE_MS = 700;
        let _statsTimer = null;
        let _statsLastRun = 0;
        let _contentCache = null; // last serialize, invalidated by the next edit

        /** Plain text of the current selection (source or preview). Empty if collapsed. */
        function getSelectionPlainForStats() {
            try {
                if (state.mode === 'source' && sourceEditor) {
                    const a = sourceEditor.selectionStart | 0;
                    const b = sourceEditor.selectionEnd | 0;
                    if (a === b) return '';
                    return sourceEditor.value.slice(Math.min(a, b), Math.max(a, b));
                }
                return selectionToPlainText() || '';
            } catch (e) {
                return '';
            }
        }

        function countWordsForStats(text) {
            const textOnly = String(text == null ? '' : text)
                .replace(/[`*_~#>[\]()|-]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            return textOnly ? textOnly.split(' ').filter(Boolean).length : 0;
        }

        /**
         * @param {boolean} [invalidateContent=true] When false (selection-only), reuse
         *   the last serialize so selection word counts stay cheap.
         */
        let _lastTypingPing = 0;
        function updateStats(invalidateContent) {
            if (invalidateContent !== false) _contentCache = null;
            const now = Date.now();
            // Let the host know writing is happening, so "hide while typing" can react.
            // Edge-triggered at most once a second — it only needs to know that you began.
            // Only when the document was actually edited.
            //
            // The host treats this ping as "the user is editing" and marks whichever tab it
            // thinks is active as unsaved. updateStats() runs on programmatic changes too --
            // loading a book is one -- so opening a book from a Markdown tab left that tab
            // dirty, and closing offered to save the book's text over a file nobody had
            // touched. An `input` event on the editor is the only thing that means editing;
            // replacing the document's HTML does not raise one.
            // On window, not a module-scoped let: the listener that sets it lives in an
            // earlier module than this one, and a script-scoped binding across two classic
            // scripts is an ordering question nobody should have to think about.
            const edited = (now - (window.__tzLastUserEditAt || 0)) < 1500;
            if (edited && now - _lastTypingPing > 1000) {
                _lastTypingPing = now;
                postMsg('typing');
            }
            if (now - _statsLastRun >= STATS_MAX_STALE_MS) {
                if (_statsTimer) { clearTimeout(_statsTimer); _statsTimer = null; }
                updateStatsNow();
                return;
            }
            if (_statsTimer) clearTimeout(_statsTimer);
            _statsTimer = setTimeout(function () {
                _statsTimer = null;
                updateStatsNow();
            }, STATS_DEBOUNCE_MS);
        }

        /**
         * @param {{forceCaretLine?:number}} [opts] forceCaretLine: after mode-switch restore,
         *   post this Ln even if the DOM selection has not settled yet.
         */
        function updateStatsNow(opts) {
            if (_statsTimer) { clearTimeout(_statsTimer); _statsTimer = null; }
            _statsLastRun = Date.now();

            // Pure read: this runs on a timer and must never disturb the caret.
            // Source mode: always prefer the live textarea — a stale _contentCache from
            // Preview/open can be far shorter and clamp Ln 16 → Ln 11 (poisoning sticky).
            let content = _contentCache;
            if (state.mode === 'source' && sourceEditor) {
                content = sourceEditor.value || '';
                _contentCache = content;
            } else if (content == null) {
                content = getMarkdownContent(false);
                _contentCache = content;
            }
            const chars = content.length;
            // Large docs: skip expensive full-document word tokenization on every stats pass.
            // Approx words ≈ non-space runs via a lighter path; exact enough for the status bar.
            let words;
            let lines;
            if (chars >= LARGE_DOC_CHARS) {
                let wc = 0;
                let inWord = false;
                let lc = 1;
                for (let i = 0; i < chars; i++) {
                    const ch = content.charCodeAt(i);
                    if (ch === 10) { lc++; inWord = false; continue; }
                    if (ch === 13) continue;
                    const space = ch === 32 || ch === 9;
                    if (space) inWord = false;
                    else if (!inWord) { inWord = true; wc++; }
                }
                words = wc;
                lines = chars === 0 ? 1 : lc;
            } else {
                words = countWordsForStats(content);
                lines = content.length === 0 ? 1 : content.split(/\r?\n/).length;
            }
            let caretLine = 1;
            const forced = (opts && opts.forceCaretLine >= 1) ? (opts.forceCaretLine | 0) : 0;
            if (forced >= 1) {
                // Mode-switch restore: never clamp sticky down against a stale short total.
                caretLine = forced;
                if (lines < caretLine) lines = caretLine;
            } else {
                try { caretLine = getCaretLineNumber(content); } catch (eC) { caretLine = 1; }
                if (caretLine < 1) caretLine = 1;
                if (caretLine > lines) caretLine = lines;
            }
            _lastCaretLine = caretLine;
            // Only refresh sticky cache while the user is still focused in the editor.
            // After WPF steals focus, getCaretLineNumber may return 1 — must not overwrite cache.
            // Also skip when forceCaretLine is set (restore already set cache).
            try {
                if (forced >= 1) {
                    rememberStickyLine(caretLine);
                } else if (state.mode === 'source' && document.activeElement === sourceEditor) {
                    const pos = sourceEditor ? (sourceEditor.selectionStart | 0) : 0;
                    if (!isPoisonedSourceLineOne(caretLine, pos)) {
                        rememberStickyLine(caretLine);
                    }
                } else if (state.mode !== 'source' && editor
                    && (document.activeElement === editor || editor.contains(document.activeElement))) {
                    if (!((caretLine | 0) <= 1 && (_stickyLineCache | 0) > 1)) {
                        rememberStickyLine(caretLine);
                    }
                }
            } catch (eSt) {}
            const readTime = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));
            // A book is read-only, so it is never dirty. Without this every book opened
            // showing "Unsaved *", inviting a save of something that cannot be edited.
            const isDirty = (DocumentModel.kind === 'epub')
                ? false
                : (content !== state.lastSavedContent);

            // Selection counts (status bar shows "N / total" when non-empty)
            const selText = getSelectionPlainForStats();
            const selWords = selText ? countWordsForStats(selText) : 0;
            const selChars = selText ? selText.length : 0;

            // words, chars, readTime, isDirty, totalLines, caretLine [, selWords, selChars]
            postMsg(`stats:${words},${chars},${readTime},${isDirty},${lines},${caretLine},${selWords},${selChars}`);
            // Debounced — do not write full prefs on every keystroke
            // Skip prefs write storm right after loading a large file.
            if (chars < LARGE_DOC_CHARS) scheduleSavePreferences();
            // Keep outline fresh after edits (cheap enough for typical docs)
            if (!isRestoring && state.mode === 'wysiwyg') {
                if (!updateStats._outlineTimer) {
                    updateStats._outlineTimer = setTimeout(() => {
                        updateStats._outlineTimer = null;
                        updateOutline();
                    }, 250);
                }
            }
            // Chapter label for continuous scroll (paginated path updates via page indicator).
            try {
                if (typeof isPaginatedLayout !== 'function' || !isPaginatedLayout()) postChapterLabel();
            } catch (eCh) {}
        }

        /**
         * Authoritative document state for the host: "1" or "0" for dirty, then the
         * markdown. The host's save-on-close path reads this instead of trusting the
         * debounced stats message, so a keystroke made in the last few milliseconds
         * before closing can never be mistaken for a clean buffer.
         *
         * Pure read only — expandAllFragmentedBlocks on multi‑thousand-line docs freezes
         * the UI and makes the host's blocking pull time out ("Could not reach editor").
         */
        function getDocumentStateTagged() {
            // Always flush active before host pull (Save / close / tab leave).
            const content = getMarkdownContent(false, { flushActive: true });
            _contentCache = content;
            // Books are read-only: never report dirty. Comparing to lastSavedContent used
            // to flip dirty on every tab leave and the close dialog offered to "save" an .epub.
            if (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub') {
                return '0' + content;
            }
            return (content !== state.lastSavedContent ? '1' : '0') + content;
        }

        // --- Host sync for large documents ---
        // Returning multi‑MB strings through one ExecuteScriptAsync often times out or
        // fails (JSON-encode + COM). Serialize once into a JS cache; the host pulls
        // fixed-size chunks, then releases the cache.
        let _hostDocCache = null;
        let _hostDocDirty = '0';

        /** @returns {"0"|"1"}:length  dirty flag + character length of the cached body */
        function prepareDocumentStateForHost() {
            const content = getMarkdownContent(false, { flushActive: true });
            _contentCache = content;
            _hostDocCache = content;
            if (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub') {
                _hostDocDirty = '0';
            } else {
                _hostDocDirty = (content !== state.lastSavedContent) ? '1' : '0';
            }
            return _hostDocDirty + ':' + String(content.length);
        }

        function getDocumentStateChunk(offset, length) {
            if (_hostDocCache == null) return '';
            offset = offset | 0;
            length = length | 0;
            if (offset < 0) offset = 0;
            if (length < 0) length = 0;
            return _hostDocCache.substring(offset, offset + length);
        }

        function releaseDocumentStateForHost() {
            _hostDocCache = null;
        }

        /**
         * Turn editing on or off, and refuse to turn it on for a book.
         *
         * A book's blocks are the publisher's HTML. There is no Markdown behind them to
         * edit, and a contenteditable would let the browser rewrite that markup on any
         * keystroke -- so read-only is not a policy here, it is what the document is. Every
         * route into editing goes through this rather than setting the attribute directly,
         * because the three that existed were each reached by a different path and guarding
         * them one at a time is how one gets missed.
         */
        function setEditorEditable(on) {
            if (!editor) return;
            const allowed = on && !(typeof DocumentModel !== 'undefined'
                && DocumentModel.kind === 'epub');
            editor.setAttribute('contenteditable', allowed ? 'true' : 'false');
            editor.classList.toggle('reader-mode', !allowed);
            // A book, specifically -- which is not the same as "not editable". Preview on a
            // Markdown file is also read-only, and a source setting like Word Wrap still
            // means something there because the file has real line breaks behind it. A book
            // has none, so an unwrapped one is one endless line and nothing else.
            // Toggled here because this is the single funnel every editability change goes
            // through, so it cannot be left set when a Markdown file replaces a book in the
            // same tab.
            editor.classList.toggle('book-mode',
                typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub');
        }

        // Outline/TOC entries for the status-bar chapter label, rebuilt with the outline.
        // Sorted by block index; the "current chapter" is the last entry at or before the
        // reading position. Empty when the document has no headings/TOC.
        let _chapterEntries = [];
        let _lastChapterPosted = null;
        let _lastChapterBiPosted = null;
        /** Block index of the chapter currently shown in the status bar (for click-to-jump). */
        let _currentChapterBi = -1;

        function updateOutline() {
            if (!outlineList) return;
            outlineList.innerHTML = '';
            let found = 0;
            _chapterEntries = [];

            // Prefer DocumentModel so outline works when Preview is virtualized
            // (most blocks are not in the DOM).
            const useModel = DocumentModel && DocumentModel.blocks && DocumentModel.blocks.length;
            const count = useModel ? DocumentModel.blocks.length : 0;

            /**
             * Is this block a heading, and if so at what level and with what title?
             *
             * Markdown says so with leading hashes; a book says so with an <h1>..<h6>.
             * Detecting only the first is why converting a book to Markdown broke its
             * outline: 16 of 17 headings in Blindsight came out as a hash on a line of its
             * own, matching nothing.
             */
            function headingOf(raw) {
                const r = raw == null ? '' : String(raw);
                if (DocumentModel && DocumentModel.kind === 'epub') {
                    const m = r.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
                    if (!m) return null;
                    const title = htmlFragmentToText(m[2]);
                    if (!title) return null;
                    return { level: parseInt(m[1], 10), title: title };
                }
                if (!/^#{1,6}\s/.test(r)) return null;
                return {
                    level: r.match(/^#+/)[0].length,
                    title: r.replace(/^#+\s*/, '').replace(/[*`_]/g, '')
                };
            }

            function addHeading(idx, raw) {
                const h = headingOf(raw);
                if (!h) return;
                addOutlineEntry(idx, h.level, h.title);
            }

            function addOutlineEntry(idx, level, title) {
                found++;
                _chapterEntries.push({ bi: idx | 0, title: String(title || '') });
                const item = document.createElement('div');
                item.className = 'outline-item outline-h' + level;
                item.innerText = title;
                item.onclick = function () {
                    // Use whatever the current layout already uses to show a block, rather
                    // than a third bespoke path.
                    //
                    // This used to seed mainContainer.scrollTop and then call
                    // mountVirtWindow. Under virtualization the remount rebuilds the
                    // spacers, the document height briefly collapses, and the browser
                    // clamps the scroll back to 0 -- so clicking an outline entry moved the
                    // caret and the status line but left the view exactly where it was.
                    // The whole handler was wrapped in a bare catch, so nothing said so.
                    try {
                        const line = modelBlockStartLine(idx);
                        try { if (typeof captureReturnJump === 'function') captureReturnJump(); } catch (eRj) {}
                        if (DocumentModel && DocumentModel.kind === 'epub') {
                            goToModelBlock(idx);
                            return;
                        }
                        if (isPaginatedLayout()) {
                            goToPageHoldingBlock(idx);
                        } else {
                            // Handles the virtualized remount, and re-restores across frames.
                            restoreStickyDocumentLine(line);
                        }
                        try { updateStatsNow({ forceCaretLine: line }); } catch (eU) {}
                        try { postChapterLabel(); } catch (eCh) {}

                        // Flash the target once it is on screen, whichever path got it there.
                        setTimeout(function () {
                            const el = elementForModelIndex(idx);
                            if (!el) return;
                            currentActiveBlock = el;
                            el.classList.add('focused');
                            setTimeout(function () {
                                try { el.classList.remove('focused'); } catch (e) {}
                            }, 1200);
                        }, 120);
                    } catch (e2) {
                        window.showDebugTelemetry('outline click failed: ' + e2.message);
                    }
                };
                outlineList.appendChild(item);
            }

            // A book's own table of contents wins over anything inferred from its markup.
            // Dune has no <h1>..<h6> at all, so inference gives it an empty outline however
            // clever the inference is.
            const bookToc = (DocumentModel && DocumentModel.kind === 'epub'
                && DocumentModel.toc && DocumentModel.toc.length) ? DocumentModel.toc : null;
            if (bookToc) {
                for (let i = 0; i < bookToc.length; i++) {
                    const e = bookToc[i];
                    if (!e || !e.title) continue;
                    addOutlineEntry(e.blockIndex | 0, Math.max(1, Math.min(6, e.level || 1)), e.title);
                }
            } else if (useModel) {
                for (let idx = 0; idx < count; idx++) {
                    addHeading(idx, DocumentModel.blocks[idx].raw || '');
                }
            } else if (editor) {
                const blocks = editor.querySelectorAll('.block');
                for (let idx = 0; idx < blocks.length; idx++) {
                    addHeading(idx, blocks[idx].getAttribute('data-raw') || '');
                }
            }

            if (found === 0) {
                outlineList.innerHTML = '<div class="outline-item" style="opacity:0.5;">No headings found...</div>';
            }
            try { postChapterLabel(); } catch (eCh2) {}
        }

        /**
         * Status-bar chapter title for the block currently being read.
         * Posts only when the title changes so page turns do not spam the host.
         */
        function postChapterLabel() {
            let bi = -1;
            try {
                if (typeof _readingAnchor === 'number' && _readingAnchor >= 0) bi = _readingAnchor;
                else if (typeof topLeftModelIndexTwoCol === 'function') bi = topLeftModelIndexTwoCol();
            } catch (eBi) { bi = -1; }
            if (!(bi >= 0)) bi = 0;

            let title = '';
            let chapterBi = -1;
            const list = _chapterEntries;
            if (list && list.length) {
                for (let i = 0; i < list.length; i++) {
                    if ((list[i].bi | 0) <= bi) {
                        title = list[i].title || '';
                        chapterBi = list[i].bi | 0;
                    } else break;
                }
            }
            _currentChapterBi = chapterBi;
            if (title === _lastChapterPosted && chapterBi === _lastChapterBiPosted) return;
            _lastChapterPosted = title;
            _lastChapterBiPosted = chapterBi;
            // Host: "chapter:<blockIndex>\t<title>" so the status label is clickable.
            try { postMsg('chapter:' + (chapterBi >= 0 ? chapterBi : -1) + '\t' + title); } catch (eP) {}
        }

        /**
         * Show one sidebar pane. Matches on data-tab rather than :nth-child so that
         * adding or removing a tab cannot silently mis-target the header (removing the
         * Files tab shifted every nth-child index by one).
         */
        /**
         * Tell the host whether the sidebar is showing, so its toolbar button can be shaded
         * like every other active control. Selection state had only ever been painted
         * inside the Mode pillbox.
         *
         * Only call this for a *user* pin (toggle / Alt+S / restore). Edge-hover open
         * must not post, or the host would treat the temporary reveal as permanent.
         */
        function postSidebarState() {
            if (!sidebar) return;
            // A deliberate post clears the edge-only flag: the host now owns pin state.
            _sidebarEdgeOnly = false;
            postMsg('sidebar_state:' + (sidebar.classList.contains('collapsed') ? '0' : '1'));
        }

        window.switchTab = function(tab) {
            if (tab !== 'outline' && tab !== 'search') tab = 'outline';
            // Reaching Search with the mouse must wire it up too. This used to happen only
            // from the Alt+S handler and from updateSearchSidebar, so clicking the tab gave
            // a query box with no listeners on it: typing did nothing, Enter did nothing,
            // and the pane sat on "No results..." while looking perfectly focused.
            if (tab === 'search') {
                wireSidebarSearch();
                wireSearchResultKeys();
            }
            document.querySelectorAll('.sidebar-tab').forEach(t => {
                t.classList.toggle('active', t.getAttribute('data-tab') === tab);
            });
            document.querySelectorAll('.tab-pane').forEach(p => {
                p.classList.toggle('active', p.id === 'tab-' + tab);
            });
            // Remember Outline vs Search across restarts (global pref, not per tab).
            try { if (typeof scheduleSavePreferences === 'function') scheduleSavePreferences(); } catch (eSp) {}
        };

        function generateExportHtml() {
            const content = editor.innerHTML;
            const theme = document.getElementById('theme-styles').innerHTML;
            return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Exported Document</title><style>${theme} body{padding:40px;max-width:800px;margin:0 auto;background:var(--bg);color:var(--tx);font-family:var(--font);} pre,code{background:var(--code-bg);padding:4px;border-radius:4px;} blockquote{border-left:4px solid var(--accent);padding-left:16px;}</style></head><body>${content}</body></html>`;
        }

        tzMark('(page) top-level script evaluated');
    
