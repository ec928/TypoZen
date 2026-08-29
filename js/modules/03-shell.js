// TypoZen module: 03-shell.js
// Lines 3028-4154 of the former monolith. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.

        // --- DEBUG OVERLAY ---
        const debugLog = [];
        window.addDebugLog = function(msg) {
            const d = new Date();
            const time = String(d.getMinutes()).padStart(2, '0') + ':' + 
                         String(d.getSeconds()).padStart(2, '0') + '.' + 
                         String(d.getMilliseconds()).padStart(3, '0');
            debugLog.push(`[${time}] ${msg}`);
            if (debugLog.length > 50) debugLog.shift();
        };

        let _debugHudTimer = null;
        let _debugHudEl = null;

        window.toggleDebugHUD = function() {
            if (_debugHudTimer) {
                clearInterval(_debugHudTimer);
                _debugHudTimer = null;
                if (_debugHudEl && _debugHudEl.parentNode) {
                    _debugHudEl.parentNode.removeChild(_debugHudEl);
                }
                _debugHudEl = null;
                return;
            }

            _debugHudEl = document.createElement('div');
            _debugHudEl.style.position = 'fixed';
            _debugHudEl.style.top = '10px';
            _debugHudEl.style.right = '10px';
            _debugHudEl.style.backgroundColor = 'rgba(0,0,0,0.85)';
            _debugHudEl.style.color = 'lime';
            _debugHudEl.style.padding = '10px';
            _debugHudEl.style.zIndex = '999999';
            _debugHudEl.style.fontFamily = 'monospace';
            _debugHudEl.style.fontSize = '12px';
            _debugHudEl.style.pointerEvents = 'none';
            _debugHudEl.style.whiteSpace = 'pre';
            _debugHudEl.style.maxWidth = '400px';
            document.body.appendChild(_debugHudEl);

            _debugHudTimer = setInterval(() => {
                if (!document.body.contains(_debugHudEl)) document.body.appendChild(_debugHudEl);
                const active = document.activeElement;
                const activeStr = active ? (active.id || active.tagName) : 'null';
                
                let layoutStr = `Paginated: ${typeof isPaginatedLayout === 'function' ? isPaginatedLayout() : '?'}`;
                let scrollStr = `ScrollLeft: ${typeof editor !== 'undefined' && editor ? editor.scrollLeft : '?'}`;
                let pageWStr = `PageW: ${typeof twoColPageWidth === 'function' ? twoColPageWidth() : '?'}`;
                let anchorStr = `ReadingAnchor: ${typeof _readingAnchor !== 'undefined' ? _readingAnchor : '?'}`;
                
                let searchStr = `ExtSearchActive: ${typeof window.__tzExternalSearchActive !== 'undefined' ? window.__tzExternalSearchActive : '?'}`;
                let matchStr = `FindIndex: ${typeof findState !== 'undefined' ? findState.index : '?'} / ${typeof findState !== 'undefined' && findState.matches ? findState.matches.length : '?'}`;
                let lineStr = `StickyLine: ${typeof _stickyLineCache !== 'undefined' ? _stickyLineCache : '?'} | CaretLine: ${typeof _lastCaretLine !== 'undefined' ? _lastCaretLine : '?'}`;

                _debugHudEl.textContent = `hasFocus: ${document.hasFocus()}\nactive: ${activeStr}\n\n[Layout]\n${layoutStr}\n${scrollStr}\n${pageWStr}\n${anchorStr}\n${lineStr}\n\n[Search]\n${searchStr}\n${matchStr}\n\n-- Log --\n${debugLog.join('\n')}`;
            }, 100);
        };

        if (window.chrome && window.chrome.webview && !navigator.userAgent.includes('jsdom')) {
            window.addEventListener('focus', () => window.addDebugLog('window focus'));
            window.addEventListener('blur', () => window.addDebugLog('window blur'));
            document.addEventListener('focusin', (e) => {
                const t = e.target;
                window.addDebugLog(`focusin: ${t ? (t.id || t.tagName) : 'null'}`);
            });
        }
        // Uncaught errors into the HUD ring (Ctrl+Shift+D) and, with --debug, debug.log.
        window.addEventListener('error', function (e) {
            const msg = 'onerror: ' + (e && e.message ? e.message : '') +
                (e && e.filename ? ' @ ' + e.filename + ':' + (e.lineno || '') : '');
            try { window.addDebugLog(msg); } catch (x) {}
            try { if (typeof window.showDebugTelemetry === 'function') window.showDebugTelemetry(msg); } catch (x2) {}
        });
        window.addEventListener('unhandledrejection', function (e) {
            const r = e && e.reason;
            const msg = 'unhandledrejection: ' + (r && r.message ? r.message : String(r || ''));
            try { window.addDebugLog(msg); } catch (x) {}
            try { if (typeof window.showDebugTelemetry === 'function') window.showDebugTelemetry(msg); } catch (x2) {}
        });
        // ---------------------

        /**
         * Jump to a remembered block after a load has painted. Shared by books, large
         * fetch_and_load, and inline load_content + resume_at.
         *
         * Suppressed while an external/ZenSeek search is pending: resume (last read
         * position) and search jump used to race — page 13 (match) vs page 141 (resume)
         * forever once goToPage chains stacked.
         */
        let _resumeAtTimer = null;
        let _externalFindGen = 0;
        let _externalFindTimers = [];
        let _externalFindActiveUntil = 0;

        function scheduleResumeAtBlock(resumeAt) {
            if (!(resumeAt > 0)) return;
            if (_resumeAtTimer) {
                try { clearTimeout(_resumeAtTimer); } catch (eC) {}
                _resumeAtTimer = null;
            }
            _bookPosLast = resumeAt;
            // Wait for the document rather than betting on a delay. The host sends this
            // straight after the content, and a large document arrives as a staged fetch
            // that is still being parsed 400ms later -- at which point resumeAt is past the
            // end of a half-built model and the jump was silently dropped.
            let tries = 0;
            const attempt = function () {
                _resumeAtTimer = null;
                try {
                    // Search handoff wins over last-read restore.
                    if (Date.now() < _externalFindActiveUntil) return;
                    if (typeof DocumentModel === 'undefined') return;
                    if (resumeAt >= DocumentModel.blocks.length) {
                        if (++tries < 12) { _resumeAtTimer = setTimeout(attempt, 400); }
                        return;
                    }
                    if (typeof goToModelBlock === 'function') {
                        goToModelBlock(resumeAt);
                        // Once more when the layout has settled. The first jump happens
                        // while most block heights are still estimates, and on a 3,767-block
                        // document that landed 42 blocks -- most of a screen -- above the
                        // block asked for. The second lands on measured heights.
                        _resumeAtTimer = setTimeout(function () {
                            _resumeAtTimer = null;
                            try {
                                if (Date.now() < _externalFindActiveUntil) return;
                                if (resumeAt < DocumentModel.blocks.length) goToModelBlock(resumeAt);
                            } catch (e2) {}
                        }, 700);
                    }
                } catch (e1) {}
            };
            _resumeAtTimer = setTimeout(attempt, 400);
        }



        /**
         * Phase 6 — open from ZenSeek: run find, jump to match N, highlight.
         * Payload: url-encoded query, optional "|match=N" (0-based among matches).
         */
        function applyExternalFind(payload) {
            let raw = String(payload == null ? '' : payload);
            let matchIndex = 0;
            const bar = raw.indexOf('|match=');
            if (bar >= 0) {
                matchIndex = parseInt(raw.substring(bar + 7), 10);
                raw = raw.substring(0, bar);
                if (!isFinite(matchIndex) || matchIndex < 0) matchIndex = 0;
            }
            let query = raw;
            try { query = decodeURIComponent(raw); } catch (e) { query = raw; }
            if (!query) return;

            // Cancel stacked retries from a previous external_find / double load_done.
            _externalFindGen++;
            const gen = _externalFindGen;
            for (let t = 0; t < _externalFindTimers.length; t++) {
                try { clearTimeout(_externalFindTimers[t]); } catch (eT) {}
            }
            _externalFindTimers = [];
            // Block resume-at for long enough that late book-position restore cannot fight us.
            _externalFindActiveUntil = Date.now() + 4000;
            setTimeout(function() { window.__tzExternalSearchActive = false; }, 9000);
            if (_resumeAtTimer) {
                try { clearTimeout(_resumeAtTimer); } catch (eR) {}
                _resumeAtTimer = null;
            }

            const run = function () {
                if (gen !== _externalFindGen) return;
                if (window._isFetching) return;
                try {
                    // ZenSeek / Phase 6: Run find, jump to match N.
                    // DO NOT open the sidebar or switch tabs. Let the user read.
                    window.__tzExternalSearchActive = true;
                    if (typeof window.switchTab === 'function') window.switchTab('none');
                    try {
                        const sb = document.getElementById('sidebar');
                        if (sb) sb.classList.add('collapsed');
                        if (typeof postMsg === 'function') postMsg('sidebar_state:0');
                    } catch(eSb) {}
                    
                    const side = document.getElementById('sidebarSearchInput');
                    if (side) side.value = query;
                    try {
                        const fi = document.getElementById('findInput');
                        if (fi) fi.value = query;
                    } catch (eFi) {}
                    if (typeof window.rememberSearchQuery === 'function') window.rememberSearchQuery(query);
                    if (typeof hideFindBarChrome === 'function') hideFindBarChrome();
                    else {
                        try {
                            const barEl = document.getElementById('findBar');
                            if (barEl) barEl.classList.remove('open');
                        } catch (eBar) {}
                    }

                    if (typeof runFind === 'function') {
                        runFind(query, false, { navigate: false });
                    }
                    if (typeof hideFindBarChrome === 'function') hideFindBarChrome();
                    if (typeof findState !== 'undefined' && findState.matches && findState.matches.length) {
                        _externalFindGen++; // cancel remaining retries once matches are found
                        const idx = Math.min(matchIndex, findState.matches.length - 1);
                        if (typeof window.findJumpTo === 'function') window.findJumpTo(idx);
                        else if (typeof runFind === 'function') {
                            findState.index = idx;
                            runFind(query, true, { navigate: true });
                        }
                        if (typeof hideFindBarChrome === 'function') hideFindBarChrome();
                        window.__tzExternalSearchActive = false;
                    }
                    try {
                        if (typeof updateSearchSidebar === 'function') updateSearchSidebar();
                        if (typeof updateSidebarSearchCount === 'function') updateSidebarSearchCount();
                        if (typeof wireSidebarSearch === 'function') wireSidebarSearch();
                        if (typeof wireSearchResultKeys === 'function') wireSearchResultKeys();
                        
                        // Hand focus to the editor so bindReaderFindKeys catches ArrowUp/ArrowDown
                        if (typeof focusEditorNoScroll === 'function') focusEditorNoScroll();
                    } catch (eS) {}
                } catch (e) {
                    try { window.showDebugTelemetry('external_find: ' + e.message); } catch (e2) {}
                }
            };
            // One early attempt + one after layout settle. Three uncancelled retries used
            // to re-fire goToPage against resume-at and thrash the page.
            _externalFindTimers.push(setTimeout(run, 200));
            _externalFindTimers.push(setTimeout(run, 900));
            _externalFindTimers.push(setTimeout(run, 2000));
            _externalFindTimers.push(setTimeout(run, 4000));
            _externalFindTimers.push(setTimeout(run, 8000));
        }

        /** Phase 6 — jump to a 1-based document line when there is no search string. */
        function applyExternalGotoLine(line1Based) {
            const line = Math.max(1, line1Based | 0);
            const go = function () {
                try {
                    if (typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                        && DocumentModel.blocks.length > 0) {
                        // Prefer block index when lines ≈ blocks (plain text / simple md).
                        const bi = Math.min(line - 1, DocumentModel.blocks.length - 1);
                        if (typeof goToModelBlock === 'function') goToModelBlock(bi);
                        else if (typeof restoreStickyDocumentLine === 'function')
                            restoreStickyDocumentLine(line);
                    } else if (typeof restoreStickyDocumentLine === 'function') {
                        restoreStickyDocumentLine(line);
                    }
                } catch (e) {}
            };
            setTimeout(go, 80);
            setTimeout(go, 500);
        }

        // --- INITIALIZATION ---
        window.onload = () => {
            tzMark('(page) window.onload begins');
            isRestoring = true;
            let savedPrefs = {};
            try {
                const p = localStorage.getItem('typozen_prefs');
                if (p) savedPrefs = JSON.parse(p);
            } catch(e) {}

            state.themeIndex = savedPrefs.themeIndex || 0;

            const hosted = window.chrome && window.chrome.webview
                && !(navigator.userAgent || '').includes('jsdom');
            const initialContent = savedPrefs.lastContent || "# Welcome to TypoZen\n\nA modern, distraction-free **WYSIWYG** markdown and text editor.\n\n### Key Features\n- **True Live Preview**: Markdown formatting conceals when you step away, and reveals when focused.\n- **Bulletproof Engine**: Custom snapshot Undo/Redo stack, IME composition protection, and smart clipboard sanitization.\n- **Precision Editing**: 2-stage Backspace formatting clearing and cross-boundary selection merging.\n- **Multiple Themes**: Try switching themes from the menu or toolbar!\n- **Document Outline**: Click any heading in the sidebar to jump directly to it.\n- **Distraction-Free**: Toggle Focus Mode (F8) or Typewriter Scrolling (F9).";

            tzMark('(page) prefs read from localStorage');
            // In the app the host owns the document (session / file / new_document).
            // Painting Welcome here first is how a restored tab can show Welcome in
            // the editor while the chip already names the real file.
            if (!hosted) {
                loadMarkdownContent(initialContent, { replaceBook: true });
                tzMark('(page) initial content rendered');
                try {
                    state.lastSavedContent = (typeof DocumentModel !== 'undefined')
                        ? DocumentModel.toMarkdown() : initialContent;
                } catch (eLs) { state.lastSavedContent = initialContent; }
            }
            tzMark('(page) baseline set');

            applySavedPrefs(savedPrefs);
            tzMark('(page) prefs applied (theme/fonts)');

            isRestoring = false;

            sourceEditor.addEventListener('input', () => {
                // Same edit stamp the Preview editor sets. Source typing is editing too:
                // without this the stats path's "was there a real edit" gate never fires
                // here, so the crash-recovery copy of the document went stale the moment
                // you switched to Source.
                window.__tzLastUserEditAt = Date.now();
                rememberStickyFromSourceIfFocused();
                resizeSourceEditor();
                try { DocumentModel.fromMarkdown(sourceEditor.value); } catch (eM) {
                    try { window.tzLogException('fromMarkdown source input', eM); } catch (eL) {}
                }
                if (typeof HistoryManager !== 'undefined') HistoryManager.snapshot();
                updateStatsNow();
                if (isFindBarOpen()) {
                    runFind(document.getElementById('findInput').value, true, { navigate: false });
                } else {
                    // Sidebar Search leaves the find bar shut, so nothing above re-runs
                    // the search -- but the mirror still holds the pre-edit text.
                    invalidateSourceHighlights();
                }
            });
            sourceEditor.addEventListener('keyup', function () {
                rememberStickyFromSourceIfFocused();
                rememberSourceFormatSelection();
            });
            sourceEditor.addEventListener('click', function () {
                rememberStickyFromSourceIfFocused();
                rememberSourceFormatSelection();
            });
            sourceEditor.addEventListener('mouseup', function () {
                rememberStickyFromSourceIfFocused();
                rememberSourceFormatSelection();
            });
            sourceEditor.addEventListener('select', rememberSourceFormatSelection);
            // Scroll without caret move: freeze sticky to viewport so Source→Preview
            // does not land on a stale caret line hundreds of rows away.
            sourceEditor.addEventListener('scroll', function () {
                // Before the mode gate: the marks must track the text on every scroll,
                // and this fires for Source whatever state.mode believes.
                syncSourceHighlightScroll();
                if (state.mode !== 'source') return;
                try {
                    const viewLine = hardLineFromSourceScrollTop();
                    if (viewLine >= 1) rememberStickyLine(viewLine);
                } catch (eScr) {}
            }, { passive: true });
            // Each paste is its own undo step (input debounce would merge rapid pastes)
            // Nested lists in Source: Tab / Shift+Tab on selected lines
            sourceEditor.addEventListener('keydown', (e) => {
                if (e.key !== 'Tab') return;
                const start = sourceEditor.selectionStart || 0;
                const end = sourceEditor.selectionEnd || 0;
                const full = sourceEditor.value;
                let s = start;
                let en = end;
                while (s > 0 && full.charAt(s - 1) !== '\n') s--;
                while (en < full.length && full.charAt(en) !== '\n') en++;
                const chunk = full.substring(s, en);
                const lines = chunk.split('\n');
                const anyList = lines.some(l => isListLine(l));
                if (!anyList) return; // allow normal Tab if no list lines
                e.preventDefault();
                const delta = e.shiftKey ? -1 : 1;
                HistoryManager.beginEdit();
                const out = lines.map(l => (isListLine(l) ? indentListLine(l, delta) : l)).join('\n');
                sourceEditor.setRangeText(out, s, en, 'select');
                resizeSourceEditor();
                updateStats();
                HistoryManager.commitEdit();
            });

            /**
             * Enter keeps the indentation of the line it left.
             *
             * Source is a plain textarea, so Enter puts the caret at column zero and every
             * indented structure -- a code fence, a YAML block, a nested list, anything
             * pasted from a file -- has to be re-indented by hand on every line. This is
             * the "help with aligning" half of the developer-editor request, and it needs
             * no new surface: it is a keystroke in the surface that already exists.
             *
             * A list line continues its MARKER as well as its indent, which is what
             * Preview already does. An empty list item ends the list instead, because a
             * reader pressing Enter twice means "I am finished", not "another bullet".
             *
             * Deliberately not touched: brackets and quotes. Auto-closing them is a matter
             * of taste that turns hostile the moment it guesses wrong, and prose is full of
             * apostrophes.
             */
            sourceEditor.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
                if (window.isComposing || e.isComposing) return;
                const start = sourceEditor.selectionStart;
                const end = sourceEditor.selectionEnd;
                if (start == null || start !== end) return;   // a selection: let Enter replace it
                const full = sourceEditor.value;
                let ls = start;
                while (ls > 0 && full.charAt(ls - 1) !== '\n') ls--;
                const line = full.substring(ls, start);
                const indent = (/^[ \t]*/.exec(line) || [''])[0];

                // A list item carries its marker too, so a list continues rather than
                // collapsing to a bare indented line.
                const m = /^([ \t]*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(line);
                let insert = '\n' + indent;
                if (m) {
                    if (!m[4].trim()) {
                        // "- " with nothing after it: end the list, and take the empty
                        // marker away rather than leaving a stray bullet behind.
                        e.preventDefault();
                        HistoryManager.beginEdit();
                        sourceEditor.setRangeText('\n', ls, start, 'end');
                        resizeSourceEditor();
                        updateStats();
                        HistoryManager.commitEdit();
                        return;
                    }
                    const marker = /^\d/.test(m[2])
                        ? (parseInt(m[2], 10) + 1) + m[2].slice(-1)   // 3. -> 4.
                        : m[2];
                    insert = '\n' + m[1] + marker + m[3];
                }
                if (insert === '\n') return;                  // nothing to carry: leave Enter alone

                e.preventDefault();
                HistoryManager.beginEdit();
                sourceEditor.setRangeText(insert, start, end, 'end');
                resizeSourceEditor();
                updateStats();
                HistoryManager.commitEdit();
            });

            sourceEditor.addEventListener('paste', (e) => {
                const dt = e.clipboardData || window.clipboardData;
                const img = firstImageFile(dt);
                if (img) {
                    e.preventDefault();
                    sendImageToHost(img);
                    return;
                }
                HistoryManager.beginEdit();
                setTimeout(() => {
                    resizeSourceEditor();
                    updateStats();
                    HistoryManager.commitEdit();
                }, 0);
            });
            window.addEventListener('resize', () => {
                if (state.mode === 'source') resizeSourceEditor();
                // Page breaks depend on the viewport, so a resize retires the map.
                PageMap.invalidate();
            });

            // Anything that changes the editor's width changes the page width, and every
            // stored page offset with it. Opening or closing the sidebar does exactly that
            // without firing a window resize -- it is a margin change on a flex sibling --
            // so the view kept the old page's scrollLeft and landed between two pages:
            // closing the sidebar on page 5 showed half of page 3 and half of page 4.
            // A ResizeObserver catches every cause, including the window and zoom.
            if (typeof ResizeObserver !== 'undefined' && editor) {
                let _lastPageW = 0;
                let _roPending = false;
                // Out of the callback, into the next frame.
                //
                // relayout() writes height, column-width and column-gap, and hides the
                // container's overflow. Doing that inside the observer's own callback is
                // what "ResizeObserver loop completed with undelivered notifications" is
                // reporting: the browser delivers an observation, the callback resizes the
                // observed element, and the notifications it schedules cannot be delivered
                // in the same frame. Idempotent writes do not help -- the first pass after
                // any real change still mutates, and that is enough. A frame later the
                // layout is settled and the same work is quiet.
                const applyGeometry = function () {
                    _roPending = false;
                    if (!isPaginatedLayout()) { _lastPageW = 0; return; }
                    try { PageGeometry.relayout(); } catch (eR) {}
                    const w = Math.round(PageGeometry.stride());
                    if (w === _lastPageW) return;
                    const first = !_lastPageW;
                    _lastPageW = w;
                    if (first) return;
                    // Pane width changed (sidebar, zoom, host resize): re-lock geometry and
                    // re-anchor so we do not keep an old scrollLeft against a new stride.
                    const anchor = (_readingAnchor >= 0) ? _readingAnchor : topLeftModelIndexTwoCol();
                    if (anchor >= 0) goToPageHoldingBlock(anchor);
                    else {
                        try { PageGeometry.snap(); updatePageIndicator(); } catch (eS) {}
                    }
                };
                const ro = new ResizeObserver(function () {
                    if (!isPaginatedLayout()) { _lastPageW = 0; return; }
                    if (_roPending) return;
                    _roPending = true;
                    requestAnimationFrame(applyGeometry);
                });
                ro.observe(editor);
            }

            // Any movement or edit by the reader invalidates the remembered column
            // positions, so switching back anchors afresh instead of restoring a spot they
            // have since left. Scrolls we perform ourselves are excluded by the
            // markProgrammaticScroll window.
            if (mainContainer) mainContainer.addEventListener('scroll', noteUserMovement, { passive: true });
            if (mainContainer) mainContainer.addEventListener('scroll', reportBookPosition, { passive: true });
            try { mainContainer.addEventListener('scroll', refreshMarkState, { passive: true }); } catch (eMs) {}
            // Selecting text changes what the Mark button will do, so it changes what the
            // button must say. Without this the label followed the reader's position but
            // not their selection: it read "Mark this page" over highlighted words and
            // then highlighted them -- the same lie as before, wearing a different hat.
            try { document.addEventListener('selectionchange', refreshMarkState); } catch (eSel) {}
            try { wireSelPop(); } catch (eSp) {}
            // The popover follows the selection, but only once the reader has finished
            // making it: raising it on every selectionchange makes it flicker across the
            // text as the mouse drags.
            try {
                document.addEventListener('mouseup', function (e) {
                    // Not for a release inside the popover itself. Letting go over Define
                    // fired this, and showSelPop clears the result body before repositioning
                    // -- so the definition painted and was wiped 10ms later. That is the
                    // "flashes for a split second" report, and the popover was erasing its
                    // own answer.
                    if (e.target && e.target.closest && e.target.closest('#selPop')) return;
                    // The pointer is the anchor in Source, where the selection has no
                    // rectangle of its own. Preview ignores it and uses the range's box.
                    const at = { left: e.clientX, top: e.clientY, width: 0, height: 0,
                                 bottom: e.clientY };
                    setTimeout(function () { try { showSelPop(at); } catch (e2) {} }, 10);
                });
                document.addEventListener('selectionchange', function () {
                    // In Source the DOM selection is ALWAYS collapsed -- the selection
                    // lives on the textarea -- so this would hide the popover the instant
                    // it appeared. Ask the surface that actually holds the selection.
                    if (state.mode === 'source') {
                        if (typeof currentSelectionText === 'function'
                            && currentSelectionText().trim()) return;
                    } else {
                        const s = window.getSelection();
                        if (s && !s.isCollapsed) return;
                    }
                    // A shown result outlives the selection that asked for it. Clicking the
                    // button can collapse the selection, and hiding on that would be the
                    // same self-erasure by another route. Escape, a click outside, or a new
                    // selection still dismiss it.
                    if (typeof selPopHoldsResult === 'function' && selPopHoldsResult()) return;
                    try { hideSelPop(); } catch (e3) {}
                });
            } catch (eSp2) {}
            // Preview scroll must update sticky from the viewport, or Preview→Source
            // restores an old caret far from what was on screen.
            if (mainContainer) {
                mainContainer.addEventListener('scroll', function () {
                    try {
                        if (window.getProgScrollUntil && Date.now() <= window.getProgScrollUntil()) return;
                        if (typeof rememberStickyFromPreviewScroll === 'function')
                            rememberStickyFromPreviewScroll();
                    } catch (eSt) {}
                }, { passive: true });
            }
            if (editor) {
                editor.addEventListener('scroll', noteUserMovement, { passive: true });
                editor.addEventListener('scroll', reportBookPosition, { passive: true });
                try { editor.addEventListener('scroll', refreshMarkState, { passive: true }); } catch (eMs) {}
                editor.addEventListener('scroll', function () {
                    try {
                        if (window.getProgScrollUntil && Date.now() <= window.getProgScrollUntil()) return;
                        if (typeof rememberStickyFromPreviewScroll === 'function')
                            rememberStickyFromPreviewScroll();
                    } catch (eSt2) {}
                }, { passive: true });

                // Selecting text near a page edge must not turn the page.
                //
                // Chromium auto-scrolls a scroll container when a selection drag reaches
                // its edge -- ordinary browser behaviour, and #editor.page-mode is a
                // horizontal scroll container. On its own that is a few pixels of nudge.
                // The snap below then rounds it to the nearest page and COMMITS, so
                // reaching for the first word on a page turned to the page before it and
                // took the half-made selection with it. The browser starts it; we were
                // finishing it.
                //
                // Suppressed for the duration of the drag, then put back where the drag
                // began: the selection anchor is on that page, so that is the page the
                // reader is working on. A plain click restores the page it was already on,
                // which is a no-op.
                let _selDragging = false;
                let _selDragPage = -1;
                let _selEdgeTimer = null;
                let _selEdgeY = 0;
                // How close to the top/bottom counts as "asking for the next page", and how
                // long the reader has to stay there. The dwell is the whole safety margin:
                // an accidental overshoot on the way to a word is gone within a frame or two,
                // while somebody who wants to keep selecting simply stays put.
                const SEL_EDGE_PX = 26;
                const SEL_EDGE_MS = 420;

                /**
                 * Turn the page while a selection drag is held against an edge.
                 *
                 * Pages sets the editor overflow-x: hidden precisely so Chromium CANNOT
                 * auto-scroll it mid-drag -- that is what stopped reaching for the first word
                 * throwing the reader to the previous page. The cost was that a drag could
                 * not leave the page at all, so selecting across a page break was impossible
                 * with the mouse and only worked if you turned pages with the wheel.
                 *
                 * So the turn is deliberate rather than incidental: it needs a button held, a
                 * selection actually in progress, and the pointer parked at an edge for
                 * SEL_EDGE_MS. None of those are true of the accidental nudge the original
                 * fix was written for, so both behaviours can hold at once.
                 */
                function stopSelEdgeTurn() {
                    if (_selEdgeTimer) { clearInterval(_selEdgeTimer); _selEdgeTimer = null; }
                }
                function startSelEdgeTurn() {
                    stopSelEdgeTurn();
                    _selEdgeTimer = setInterval(function () {
                        if (!_selDragging || !isPaginatedLayout()) { stopSelEdgeTurn(); return; }
                        let live = false;
                        try {
                            const sel = window.getSelection();
                            live = !!(sel && sel.rangeCount > 0 && !sel.isCollapsed);
                        } catch (eS) {}
                        if (!live) return;              // a held button alone is not a selection
                        let dir = 0;
                        try {
                            const r = editor.getBoundingClientRect();
                            if (_selEdgeY <= r.top + SEL_EDGE_PX) dir = -1;
                            else if (_selEdgeY >= r.bottom - SEL_EDGE_PX) dir = 1;
                        } catch (eR) {}
                        if (!dir) return;
                        try {
                            if (window.markProgrammaticScroll) window.markProgrammaticScroll(300);
                            PageMap.step(dir);
                            updatePageIndicator();
                            // Turning is only half of it. The pointer is parked at the edge,
                            // so after the turn it is not over the newly shown text and the
                            // browser has no reason to extend anything -- the pages moved and
                            // the selection sat still. Walk the focus onto the page that just
                            // arrived, keeping the anchor: extend() moves the focus only,
                            // which is exactly the "far end follows the reader" behaviour.
                            try {
                                const er = editor.getBoundingClientRect();
                                const blocks = editor.querySelectorAll('.block');
                                let target = null;
                                for (let i = 0; i < blocks.length; i++) {
                                    const b = blocks[i];
                                    const r = b.getBoundingClientRect();
                                    if (r.width === 0 && r.height === 0) continue;
                                    if (r.right <= er.left + 1 || r.left >= er.right - 1) continue;
                                    if (dir < 0) { target = b; break; }   // first on the page
                                    target = b;                            // ... or the last
                                }
                                if (target) {
                                    const sel2 = window.getSelection();
                                    if (sel2 && sel2.rangeCount > 0) {
                                        sel2.extend(target, dir < 0 ? 0 : target.childNodes.length);
                                    }
                                }
                            } catch (eExt) {}
                            // The reader is still dragging, so where they landed is now the
                            // page to keep. Without this the mouseup restore would haul them
                            // back to where the drag began and undo every turn.
                            _selDragPage = PageGeometry.localIndex();
                        } catch (eStep) {}
                    }, SEL_EDGE_MS);
                }
                document.addEventListener('mousemove', function (e) {
                    if (_selDragging) _selEdgeY = e.clientY;
                }, true);

                editor.addEventListener('mousedown', function (e) {
                    if (!isPaginatedLayout() || e.button !== 0) return;
                    _selDragging = true;
                    _selEdgeY = e.clientY;
                    try { _selDragPage = PageGeometry.localIndex(); }
                    catch (eLi) { _selDragPage = -1; }
                    startSelEdgeTurn();
                });
                document.addEventListener('mouseup', function () {
                    if (!_selDragging) return;
                    _selDragging = false;
                    stopSelEdgeTurn();
                    if (!isPaginatedLayout() || _selDragPage < 0) return;
                    // Only for a click or a nudge. This puts the page back where the drag
                    // began, which is right when the browser's auto-scroll moved it while
                    // somebody reached for the first word -- and wrong when they have
                    // actually selected something across pages, because it scrolls them off
                    // the text they just highlighted and undoes a deliberate turn. A live
                    // range means they meant it, so leave them where they landed.
                    try {
                        const sel = window.getSelection();
                        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
                    } catch (eSel) {}
                    try {
                        if (window.markProgrammaticScroll) window.markProgrammaticScroll(300);
                        PageGeometry.go(_selDragPage);
                        updatePageIndicator();
                    } catch (eGo) {}
                });

                // Keep scrollLeft on a page boundary. PageGeometry owns the stride.
                let _snapTimer = null;
                editor.addEventListener('scroll', function () {
                    if (!isPaginatedLayout()) return;
                    if (_selDragging) return;   // mid-selection: see above
                    if (window.getProgScrollUntil && Date.now() <= window.getProgScrollUntil()) return;
                    if (_snapTimer) clearTimeout(_snapTimer);
                    _snapTimer = setTimeout(function () {
                        _snapTimer = null;
                        if (!isPaginatedLayout()) return;
                        try {
                            if (typeof PageGeometry !== 'undefined' && PageGeometry.snap) {
                                PageGeometry.snap();
                                updatePageIndicator();
                            }
                        } catch (eS) {}
                    }, 80);
                }, { passive: true });
                // Typing in multi-column contenteditable reflows the page flow in the
                // browser — that cost is inherent. PageMap.invalidate is a no-op; we only
                // mark that the reader moved so column-position memory is not restored
                // after an edit. Stats flush lives on the other input listener.
                editor.addEventListener('input', function () {
                    noteUserMovement();
                    // The one place that knows the document was actually edited. The host's
                    // "is this tab unsaved" flag hangs off this, and updateStats() -- which
                    // used to raise it -- runs on programmatic changes too.
                    window.__tzLastUserEditAt = Date.now();
                });
            }
            initFindBar();
            // ',' and '.' step through search results while reading, sidebar or no sidebar.
            try { bindReaderFindKeys(); } catch (eRF) {}

            mainContainer.addEventListener('click', (e) => {
                const sel = window.getSelection();
                if (sel && !sel.isCollapsed && sel.toString().length > 0) return;

                if (e.target === mainContainer || e.target === document.getElementById('editor-wrapper') || e.target === editor) {
                    const blocks = editor.querySelectorAll('.block');
                    if (blocks.length === 0) {
                        const newBlock = createBlock("");
                        focusBlock(newBlock, 0);
                        return;
                    }
                    for (let i = 0; i < blocks.length; i++) {
                        const bRect = blocks[i].getBoundingClientRect();
                        if (e.clientY >= bRect.top && e.clientY <= bRect.bottom) {
                            focusBlock(blocks[i]);
                            return;
                        }
                    }
                    const lastBlock = blocks[blocks.length - 1];
                    const lastRect = lastBlock.getBoundingClientRect();
                    if (e.clientY > lastRect.bottom) {
                        focusBlock(lastBlock);
                    }
                }
            });

            tzMark('(page) onload complete, signalling ready');
            tzFlush();
            postMsg("ready:" + (state.themeIndex || 0));

            // Auto-focus the editor on startup so the user doesn't have to click
            setTimeout(() => {
                if (_resumeAtTimer) return;
                try {
                    if (state.mode === 'wysiwyg' || state.mode === 'preview') {
                        if (editor) {
                            const first = editor.querySelector('.block');
                            if (first && typeof focusBlock === 'function') {
                                focusBlock(first, 0);
                            } else if (typeof focusEditorNoScroll === 'function') {
                                focusEditorNoScroll();
                            } else {
                                editor.focus();
                            }
                        }
                    } else if (state.mode === 'source') {
                        const src = document.getElementById('sourceEditor');
                        if (src) src.focus();
                    }
                } catch(eFocus) {}
            }, 250);
        };

        function postMsg(msg) {
            if (window.chrome && window.chrome.webview) {
                window.chrome.webview.postMessage(msg);
            }
        }

        if (window.chrome && window.chrome.webview) {
            window.chrome.webview.addEventListener('message', (event) => {
                const msg = event.data;
                if (!msg) return;

                if (msg.startsWith("init_themes:")) {
                    try {
                        const json = JSON.parse(msg.substring(12));
                        window.allThemes = json;
                        let startIdx = state.themeIndex || 0;
                        if (state.themeName && json && json.length) {
                            const byName = json.findIndex(t => t && t.Name === state.themeName);
                            if (byName >= 0) startIdx = byName;
                        }
                        if (json && json.length > startIdx) {
                            state.themeIndex = startIdx;
                            applyTheme(json[startIdx]);
                        } else if (json && json.length > 0) {
                            state.themeIndex = 0;
                            applyTheme(json[0]);
                        }
                    } catch(e) {}
                }
                else if (msg.startsWith("restore_prefs:")) {
                    try {
                        const p = JSON.parse(msg.substring(14));
                        if (p) applySavedPrefs(p);
                    } catch(e) {}
                }
                else if (msg.startsWith("set_theme:")) {
                    const idx = parseInt(msg.substring(10));
                    if (window.allThemes && window.allThemes[idx]) {
                        state.themeIndex = idx;
                        state.themeName = window.allThemes[idx].Name || '';
                        applyTheme(window.allThemes[idx]);
                        scheduleSavePreferences();
                    }
                }
                else if (msg.startsWith("preview_theme:")) {
                    // Live theme editor preview — do not change themeIndex or prefs
                    try {
                        const t = JSON.parse(msg.substring(14));
                        if (t) applyTheme(t);
                    } catch (e) {}
                }
                else if (msg.startsWith("load_content_plain:")) {
                    try { cancelPositionReport(); } catch (eCP) {}
                    finishLoadContent(msg.substring(19), false, true);
                }
                else if (msg.startsWith("load_content:")) {
                    // This document is being replaced; a position report armed by the
                    // one on screen must not be attributed to the one arriving.
                    try { cancelPositionReport(); } catch (eCP) {}
                    const content = msg.substring(13);
                    finishLoadContent(content, false, false);
                }
                else if (msg.startsWith("fetch_and_load_book:")) {
                    // This document is being replaced; a position report armed by the
                    // one on screen must not be attributed to the one arriving.
                    try { cancelPositionReport(); } catch (eCP) {}
                    // A book arrives as a staged JSON payload rather than through the
                    // message channel: an omnibus is tens of megabytes of markup.
                    // "<url>" or "<url>|at=<block>", the latter being where this reader was
                    // when the book was last closed.
                    let spec = msg.substring(20);
                    let resumeAt = -1;
                    const atPos = spec.indexOf('|at=');
                    if (atPos >= 0) {
                        resumeAt = parseInt(spec.substring(atPos + 4), 10);
                        spec = spec.substring(0, atPos);
                        if (!isFinite(resumeAt)) resumeAt = -1;
                    }
                    const url = spec;
                    window._isFetching = true;
                    fetch(url, { cache: 'no-store' })
                        .then(function (r) {
                            if (!r.ok) throw new Error('fetch ' + r.status);
                            return r.text();
                        })
                        .then(function (json) {
                            window._isFetching = false;
                            const ok = loadBookPayload(json, resumeAt);
                            if (ok && resumeAt > 0 && resumeAt < DocumentModel.blocks.length) {
                                // After the layout, not with it: the book has to be
                                // paginated before a block can be put on a page, and
                                // windowing may still be mounting the chunk it lands in.
                                scheduleResumeAtBlock(resumeAt);
                            }
                            try { postMsg(ok ? 'load_done' : 'load_failed:book'); } catch (e0) {}
                        })
                        .catch(function (err) {
                            window._isFetching = false;
                            try { console.error('TypoZen fetch_and_load_book failed', err); } catch (e) {}
                            try { postMsg('load_failed:' + String(err && err.message ? err.message : err)); } catch (e2) {}
                        });
                    return;
                }
                else if (msg.startsWith("fetch_and_load:")) {
                    // This document is being replaced; a position report armed by the
                    // one on screen must not be attributed to the one arriving.
                    try { cancelPositionReport(); } catch (eCP) {}
                    // Optional trailing |at=<block> and/or |plain=1.
                    let spec = msg.substring(15);
                    let resumeAt = -1;
                    let forcePlain = false;
                    // Parse flags from the end: |at=N |plain=1 (order flexible).
                    for (;;) {
                        const atPos = spec.lastIndexOf('|at=');
                        const plainPos = spec.lastIndexOf('|plain=');
                        const cut = Math.max(atPos, plainPos);
                        if (cut < 0) break;
                        const flag = spec.substring(cut + 1);
                        spec = spec.substring(0, cut);
                        if (flag.indexOf('at=') === 0) {
                            resumeAt = parseInt(flag.substring(3), 10);
                            if (!isFinite(resumeAt)) resumeAt = -1;
                        } else if (flag.indexOf('plain=') === 0) {
                            forcePlain = flag.substring(6) === '1';
                        } else break;
                    }
                    const url = spec;
                    window._isFetching = true;
                    fetch(url, { cache: 'no-store' })
                        .then(function (r) {
                            if (!r.ok) throw new Error('fetch ' + r.status);
                            return r.text();
                        })
                        .then(function (content) {
                            window._isFetching = false;
                            finishLoadContent(content, false, forcePlain);
                            if (resumeAt > 0) scheduleResumeAtBlock(resumeAt);
                            try { postMsg('load_done'); } catch (e0) {}
                        })
                        .catch(function (err) {
                            window._isFetching = false;
                            try {
                                console.error('TypoZen fetch_and_load failed', err);
                            } catch (e) {}
                            try {
                                postMsg('load_failed:' + String(err && err.message ? err.message : err));
                            } catch (e2) {}
                        });
                }
                else if (msg.startsWith("resume_at:")) {
                    // After an inline load_content: host already has the path; jump when laid out.
                    const resumeAt = parseInt(msg.substring(10), 10);
                    if (isFinite(resumeAt) && resumeAt > 0) scheduleResumeAtBlock(resumeAt);
                }
                else if (msg.startsWith("definition:")) {
                    // "definition:<installed 0|1>	<word>	<text>	<synonyms>"
                    const parts = msg.substring(11).split('	');
                    try { showDefinition(parts[1] || '', parts[2] || '', parts[0] === '1', parts[3] || ''); }
                    catch (eDf) {}
                }
                else if (msg.startsWith("marks_load:")) {
                    // This document's stored marks. Deferred a beat: the host sends it in the
                    // same breath as the content, and resolving a fingerprint against a model
                    // that has not been built yet would unresolve every one of them.
                    const payload = msg.substring(11);
                    setTimeout(function () {
                        try { loadMarksPayload(payload); } catch (eMl) {}
                    }, 0);
                }
                else if (msg.startsWith("external_find:")) {
                    // Phase 6 (ZenSeek): external_find:<url-encoded query>|match=N
                    applyExternalFind(msg.substring(14));
                }
                else if (msg.startsWith("external_goto_line:")) {
                    // Phase 6: 1-based hard line (ZenSeek's 0-based line + 1).
                    const line = parseInt(msg.substring(19), 10);
                    if (isFinite(line) && line >= 1) applyExternalGotoLine(line);
                }
                else if (msg == "stats_refresh") {
                    // Coming back to a document tab from a PDF or an image. The host
                    // blanked the counts for the native surface and cannot refill them
                    // itself -- word count, line and characters are the page's to know.
                    updateStatsNow();
                    try { if (typeof updateOutline === 'function') updateOutline(); } catch (eO) {}
                }
                else if (msg == "mark_dirty") {
                    // Host restored an unsaved session buffer — force dirty without changing text.
                    // lastSavedContent must never equal a real serialize (empty doc is valid content).
                    state.lastSavedContent = '\0__session_unsaved__';
                    updateStatsNow();
                }
                else if (msg.startsWith("image_data:")) {
                    // image_data:<relative path>\n<data uri>
                    const body = msg.substring(11);
                    const nl = body.indexOf('\n');
                    if (nl > 0) tzApplyImageData(body.slice(0, nl), body.slice(nl + 1));
                }
                else if (msg.startsWith("insert_image:")) {
                    // Host saved the image beside the document and gave us a relative path.
                    const rel = msg.substring(13);
                    if (rel) {
                        // The round trip through the host can leave the caret nowhere (a
                        // dialog, or WPF chrome taking focus). Land it somewhere real
                        // rather than dropping the image on the floor.
                        try {
                            const sel = window.getSelection();
                            const inEditor = sel && sel.anchorNode && editor.contains(sel.anchorNode);
                            if (!inEditor && state.mode !== 'source') {
                                const blocks = editor.querySelectorAll('.block');
                                const last = blocks.length ? blocks[blocks.length - 1] : createBlock('');
                                focusBlock(last, (last.getAttribute('data-raw') || '').length);
                            }
                        } catch (e) {}
                        // ONE atomic history step whose committed state is what you end up
                        // looking at. Previously the text insert was committed and the
                        // re-render happened afterwards in a setTimeout, so undo restored a
                        // state that disagreed with the screen and the image appeared to
                        // survive being undone.
                        const sel2 = window.getSelection();
                        const blk = (sel2 && sel2.anchorNode ? getAncestorBlock(sel2.anchorNode) : null)
                            || currentActiveBlock
                            || editor.querySelector('.block');
                        if (blk) {
                            HistoryManager.beginEdit();
                            const before = getBlockRaw(blk) || '';
                            writeBlockRaw(blk, before + '![](' + rel + ')');
                            window.isProgrammaticFocus = true;
                            focusBlock(blk, (blk.getAttribute('data-raw') || '').length);
                            updateStatsNow();
                            updateOutline();
                            HistoryManager.commitEdit();
                        }
                    }
                }
                else if (msg === "doc_folder_mapped") {
                    // No-op. This used to re-render the WHOLE document so relative images
                    // could resolve through the newly mapped host — a full reload on every
                    // file open, for nothing. Images are fetched as bytes now, so there is
                    // nothing to re-resolve.
                }
                else if (msg.startsWith("paste_text:")) {
                    // Host menu Paste (and any host-side clipboard feed) — same path as Ctrl+V
                    insertPastedPlainText(msg.substring(11));
                }
                else if (msg == "leave_book_surface") {
                    // Do NOT call leaveBookViewForMarkdown while kind is still 'epub'.
                    // That raced tab-switch: tore down Reader while blocks were still HTML,
                    // and a following remount via toMarkdown painted raw calibre markup.
                    // Full teardown runs inside loadMarkdownContent after fromMarkdown
                    // when wasBook is true. This message is a no-op reserved for the host.
                }
                else if (msg == "new_document") {
                    // This document is being replaced; a position report armed by the
                    // one on screen must not be attributed to the one arriving.
                    try { cancelPositionReport(); } catch (eCP) {}
                    // Empty on purpose. Fake "Untitled Document" / "Start typing here..."
                    // was real markdown: deleting it still left a CSS ::before on the
                    // block (the 10px gutter rail) that innerText then saved as the file.
                    loadMarkdownContent('', { replaceBook: true });
                    try {
                        state.lastSavedContent = (typeof DocumentModel !== 'undefined')
                            ? DocumentModel.toMarkdown() : '';
                    } catch (eU) { state.lastSavedContent = ''; }
                    if (state.mode === 'source') {
                        sourceEditor.value = state.lastSavedContent;
                        requestAnimationFrame(resizeSourceEditor);
                    }
                    try {
                        if (typeof invalidateSearchForDocumentChange === 'function')
                            invalidateSearchForDocumentChange();
                    } catch (eInv) {}
                    updateStatsNow();
                }
                else if (msg.startsWith("request_save:")) {
                    const saveAs = msg.substring(13) === "true";
                    // Pure read — repair freezes large docs on the save path.
                    const content = getMarkdownContent(false);
                    if (saveAs) postMsg("save_as_content:" + content);
                    else postMsg("save_content:" + content);
                }
                else if (msg == "save_success") {
                    state.lastSavedContent = getMarkdownContent(false);
                    updateStatsNow();
                }
                else if (msg == "export_html") {
                    const html = generateExportHtml();
                    postMsg("export_html_content:" + html);
                }
                else if (msg.startsWith("table:")) {
                    // Table edits act on the table holding the caret. WPF has focus while
                    // the menu is open, so the frozen selection is what we go on.
                    const spec = msg.substring(6).split(':');
                    applyTableOp(spec[0], spec.length > 1 ? spec[1] : null);
                }
                else if (msg.startsWith("cmd:")) {
                    handleCommand(msg.substring(4));
                }
                else if (msg.startsWith("fmt:")) {
                    // WPF already stole focus — do not re-read live selection
                    freezeFormatSelection();
                    applyFormatting(msg.substring(4));
                }
            });
        }

        // --- THEME APPLIER ---

        function applyTheme(t) {
            const root = document.documentElement.style;
            const bg = t.Bg || '#18181B';
            const tx = t.Tx || '#F4F4F5';
            const accent = t.Accent || t.Hi || '#3B82F6';
            const font = t.FontFamily || t.FN || "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif";

            let isLight = false;
            if (bg.startsWith('#') && bg.length >= 7) {
                const r = parseInt(bg.substr(1, 2), 16) || 0;
                const g = parseInt(bg.substr(3, 2), 16) || 0;
                const b = parseInt(bg.substr(5, 2), 16) || 0;
                isLight = (r * 0.299 + g * 0.587 + b * 0.114) > 130;
            }

            let isAccentLight = false;
            let ar = 0, ag = 0, ab = 0;
            if (accent.startsWith('#') && accent.length >= 7) {
                const r = parseInt(accent.substr(1, 2), 16) || 0;
                const g = parseInt(accent.substr(3, 2), 16) || 0;
                const b = parseInt(accent.substr(5, 2), 16) || 0;
                ar = r; ag = g; ab = b;
                isAccentLight = (r * 0.299 + g * 0.587 + b * 0.114) > 130;
            }

            root.setProperty('--bg', bg);
            root.setProperty('--tx', tx);
            root.setProperty('--accent', accent);
            // Black or white on the accent, chosen by measured contrast rather than by a
            // brightness cutoff. The 0.299/0.587/0.114 rule got it backwards for mid-tone
            // accents: Solarized Light's #268BD2 sits just under the threshold, so it took
            // white at 3.68 when black scores 5.70. Same for Solarized Dark, Rose Pine Dawn
            // and One Light. It matters most on the current search match, which paints text
            // directly on solid accent.
            root.setProperty('--accent-tx', (function () {
                const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
                const L = 0.2126 * ch(ar) + 0.7152 * ch(ag) + 0.0722 * ch(ab);
                const onWhite = 1.05 / (L + 0.05);
                const onBlack = (L + 0.05) / 0.05;
                return onBlack >= onWhite ? '#000000' : '#FFFFFF';
            })());
            // Search highlighting is built from the theme accent, not from a fixed amber.
            // It used to be hardcoded #f59e0b over rgba(255,180,0,.45), which happened to
            // look deliberate on one or two light themes and arbitrary everywhere else --
            // the same "fix it in the palette, not around it" point the theme contrast work
            // settled. --find-soft is the accent at low alpha for every match; the current
            // match uses the accent solid with --accent-tx, which is already chosen for
            // contrast against it.
            (function () {
                let rr = 0, gg = 0, bb = 0;
                if (/^#[0-9a-f]{6}$/i.test(accent)) {
                    rr = parseInt(accent.substr(1, 2), 16);
                    gg = parseInt(accent.substr(3, 2), 16);
                    bb = parseInt(accent.substr(5, 2), 16);
                }
                // A touch stronger on dark themes: the same alpha reads fainter against a
                // dark background than a light one.
                const a = isLight ? 0.30 : 0.38;
                root.setProperty('--find-soft', 'rgba(' + rr + ',' + gg + ',' + bb + ',' + a + ')');
            })();
            root.setProperty('--font', font);
            // Theme font size (FS) — with sane clamp; CSS body uses var(--fs)
            let fs = parseInt(t.FS != null ? t.FS : (t.FontSize != null ? t.FontSize : 16), 10);
            if (isNaN(fs) || fs < 10) fs = 14;
            if (fs > 28) fs = 28;
            root.setProperty('--fs', fs + 'px');
            
            root.setProperty('--surface', t.Surface || (isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)'));
            root.setProperty('--border', t.Border || (isLight ? 'rgba(0, 0, 0, 0.18)' : 'rgba(255, 255, 255, 0.18)'));
            root.setProperty('--tx-muted', t.TxMuted || (isLight ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.55)'));
            // A quiet neutral fill, for surfaces that must NOT take the accent: the band
            // under the focused block, and table chrome. Both sit in the document, where
            // the accent already means "search match" -- tinting them would put two
            // washes of one hue in one surface saying two different things. Neutral here
            // is a choice, not a leftover: the focused band marks a block's extent, which
            // is structure, not emphasis.
            root.setProperty('--fill-quiet',
                isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)');

            // The selected row: the accent at the shell's own selection alpha, so a
            // selected row in the sidebar and a selected button in the toolbar are the
            // same colour rather than two guesses at one.
            //
            // No theme has ever defined AccentBg, so this fell through to a neutral grey
            // for all 26 of them and the accent never reached a single filled surface,
            // only strokes and text. That left the hierarchy inverted: hover is
            // rgba(128,128,128,0.16) and selection was 0.06, so passing the mouse over a
            // row made it look more chosen than the row that was.
            //
            // 0.282 is 0x48/255 -- SelectionFillAlpha in TypoZen_App.cs, which paints the
            // Mode, Column and Scroll buttons. Not a number picked here: it is the
            // smallest alpha at which all the themes clear a 1.25 contrast ratio against
            // their own surface, and tests/theme-contrast-selftest.mjs holds it. That
            // test also records that 0x28 (16%) was measured and rejected as too faint
            // for every theme, which is exactly the value this first shipped with.
            //
            // Translucent, and that is the whole correction. The first version mixed the
            // accent into --bg and painted the result opaque, which is wrong wherever the
            // ground is not --bg: the sidebar sits on --surface, so a colour computed
            // against the page background landed on it as a distinctly lighter, bluer
            // patch instead of a tint of what was already there. An alpha composites with
            // whatever it is actually on, which is why the shell uses one.
            root.setProperty('--accent-bg', t.AccentBg || (function () {
                if (!/^#[0-9a-f]{6}$/i.test(accent)) {
                    return isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)';
                }
                const ch = (o) => parseInt(accent.substr(o, 2), 16);
                return 'rgba(' + ch(1) + ',' + ch(3) + ',' + ch(5) + ',0.282)';
            })());
            root.setProperty('--code-bg', t.CodeBg || 'rgba(128, 128, 128, 0.15)');
            root.setProperty('--quote-bg', t.QuoteBg || 'rgba(128, 128, 128, 0.08)');
        }

        function postViewFlags() {
            postMsg('view_flags:reveal=' + (state.revealOnFocus ? '1' : '0')
                + ',focus=' + (state.focusMode ? '1' : '0')
                + ',typewriter=' + (state.typewriterMode ? '1' : '0'));
        }

        /**
         * Write a spacing custom property and put the reader back where they were.
         *
         * Taller lines mean fewer of them per page, so the page a reader is on is not the
         * page their paragraph is on once the value changes -- and the total moves under
         * them too. The ResizeObserver that normally re-anchors cannot help here: it only
         * fires on a width change, and spacing changes height. So this does the same three
         * things by hand: relayout for the new stride, retire the page count, and seek back
         * to the block that was on screen.
         *
         * Reads the page rather than _readingAnchor, which is the opposite way round from
         * the column-switch path, and deliberately. That variable is a memory of where the
         * reader was when the layout last changed under them; it is not refreshed by every
         * page turn, so after a few turns it names a page they left long ago. A spacing
         * change is different -- the reader is looking at the text at this moment, and the
         * DOM is the only thing that knows which text that is. Trusting the remembered
         * value here threw the reader back to wherever the last relayout had put them.
         */
        let _spacingSeekToken = 0;

        /**
         * @param {Object<string,string>} props one or more custom properties, applied
         *   together. Together matters: the anchor is read before anything changes, and
         *   reading it forces layout. Setting justification and hyphenation in two calls
         *   would take the second anchor from a page the first change had already
         *   re-broken, so the reader would be returned to where the half-applied state
         *   happened to put them rather than to where they were reading.
         */
        function applySpacing(props) {
            const anchor = isPaginatedLayout() ? topLeftModelIndexTwoCol() : -1;
            Object.keys(props).forEach(function (p) {
                document.documentElement.style.setProperty(p, props[p]);
            });
            if (!isPaginatedLayout()) return;

            // Twice, because once is not enough and measurably so. The first seek runs
            // against a multi-column flow that has been told its lines are taller but has
            // not finished re-breaking on it, so it computes the right page number from
            // stale geometry and leaves the view three pages back -- page counter correct,
            // reader in the wrong place. The second, on the settle chain the column switch
            // already uses, sees the real layout and lands. Keeping the first is what stops
            // the page jumping visibly in between.
            //
            // The chain runs for a second and a half, which is long enough for the reader
            // to have turned a page or grabbed the scrubber, and a correction that fires
            // after that would drag them back to a paragraph they have left. So it stands
            // down on two conditions: a newer spacing change, and any movement of the view
            // it did not make itself. Their movement is newer than our correction.
            const token = ++_spacingSeekToken;
            let placedAt = -1;
            const seek = function () {
                if (token !== _spacingSeekToken) return;
                const ed = document.getElementById('editor');
                if (placedAt >= 0 && ed && Math.abs(ed.scrollLeft - placedAt) > 2) {
                    _spacingSeekToken++;
                    return;
                }
                try {
                    PageGeometry.relayout();
                    PageMap.invalidate();
                    if (anchor >= 0) goToPageHoldingBlock(anchor);
                    else PageGeometry.snap();
                    updatePageIndicator();
                } catch (e) {}
                if (ed) placedAt = ed.scrollLeft;
            };
            seek();
            if (typeof scheduleColumnSettle === 'function') scheduleColumnSettle(seek);
        }

        // --- COMMAND & FORMATTING HANDLER ---
        // True while the sidebar is open only because the pointer is on the extreme left.
        // Edge-hover must not pin; a user toggle (toolbar / Alt+S) posts sidebar_state and clears this.
        let _sidebarEdgeOnly = false;
        // Pointer currently over #sidebar (or its descendants). Host edge-close is ignored
        // while this is true — otherwise Match case / Whole word (right of the search row)
        // sit past the host stay-band and the bar collapses under the cursor.
        let _pointerOverSidebar = false;
        let _sidebarEdgeCloseTimer = null;

        function wireSidebarEdgePointerGuard() {
            if (!sidebar || sidebar.__tzEdgePtrWired) return;
            sidebar.__tzEdgePtrWired = true;
            sidebar.addEventListener('mouseenter', function () {
                _pointerOverSidebar = true;
                if (_sidebarEdgeCloseTimer) {
                    try { clearTimeout(_sidebarEdgeCloseTimer); } catch (eC) {}
                    _sidebarEdgeCloseTimer = null;
                }
            });
            sidebar.addEventListener('mouseleave', function () {
                _pointerOverSidebar = false;
                // Leaving the bar while edge-open: close after a short grace so a diagonal
                // move toward the document is not a fight with the host hot-zone.
                if (!_sidebarEdgeOnly) return;
                if (_sidebarEdgeCloseTimer) {
                    try { clearTimeout(_sidebarEdgeCloseTimer); } catch (eC2) {}
                }
                _sidebarEdgeCloseTimer = setTimeout(function () {
                    _sidebarEdgeCloseTimer = null;
                    if (_pointerOverSidebar || !_sidebarEdgeOnly) return;
                    sidebar.classList.add('collapsed');
                    _sidebarEdgeOnly = false;
                }, 220);
            });
        }
        try { wireSidebarEdgePointerGuard(); } catch (eW) {}

        function handleCommand(cmd) {
            if (cmd === "wordwrap_on") { document.body.classList.remove("nowrap"); return; }
            if (cmd === "wordwrap_off") { document.body.classList.add("nowrap"); return; }

            // The scrubber is the one piece of reading chrome the page owns rather than the
            // shell, so hiding it has to come through here. A class, because
            // updatePageScrubber writes display on every page turn and would undo anything
            // set directly.
            if (cmd === "scrubber_on") { document.body.classList.remove("tz-no-scrubber"); return; }
            if (cmd === "scrubber_off") { document.body.classList.add("tz-no-scrubber"); return; }

            // Reading comfort. Both are plain CSS custom properties on the root: line-height
            // is inherited so it reaches a book's text as well as a Markdown file's, and the
            // paragraph gap is the block's own margin, and a block is one paragraph in both
            // kinds of document.
            if (cmd.startsWith("set_line_spacing:")) {
                const v = parseFloat(cmd.substring(17));
                if (isFinite(v) && v > 0.5 && v < 4) {
                    applySpacing({ '--lh': String(v) });
                }
                return;
            }
            // Whether hovering a paragraph offers its bookmark gutter: off | gutter.
            // Never affects an existing bookmark — only the hover preview (see typozen.css).
            if (cmd.startsWith("set_block_hover:")) {
                const mode = String(cmd.substring(16) || 'gutter').toLowerCase();
                const ok = (mode === 'off') ? 'off' : 'gutter';
                try { document.documentElement.setAttribute('data-block-hover', ok); } catch (eH) {}
                return;
            }
            if (cmd.startsWith("set_para_spacing:")) {
                const v = parseFloat(cmd.substring(17));
                if (isFinite(v) && v >= 0 && v < 200) {
                    applySpacing({ '--para': v + 'px' });
                }
                return;
            }
            // Justification is the third part of the same decision, and it re-breaks every
            // line exactly as leading does -- so it goes through the same path, which sets
            // the property and then puts the reader back on the block they were reading.
            // #editor reads --tz-align, and so does every book rule that asked to justify
            // (applyBookStyles), so one property covers Markdown and books alike.
            //
            // Hyphenation is set with it, not beside it. On a screen they are one
            // decision: the browser justifies by stretching word spaces and nothing else,
            // so justified-without-hyphens is the rivers-of-white setting this feature
            // defaults away from, and ragged-right-with-hyphens breaks words to close a
            // gap that is not there. One switch, both properties, one re-anchor.
            if (cmd.startsWith("set_justify:")) {
                const on = cmd.substring(12) === '1';
                applySpacing({
                    '--tz-align': on ? 'justify' : 'left',
                    '--tz-hyphens': on ? 'auto' : 'manual'
                });
                return;
            }
            if (cmd.startsWith("set_font_family:")) {
                const family = cmd.substring(16);
                let style = document.getElementById("tz-font-family-override");
                if (!style) {
                    style = document.createElement("style");
                    style.id = "tz-font-family-override";
                    document.head.appendChild(style);
                }
                if (family) {
                    style.textContent = `body, #editor { font-family: ${family} !important; }`;
                } else {
                    style.textContent = "";
                }
                applySpacing({}); 
                return;
            }
            if (cmd.startsWith("set_font_size:")) {
                const sizeIndex = parseInt(cmd.substring(14));
                let sizes = ['12px', '14px', '', '18px', '22px'];
                let size = sizes[sizeIndex] || '';
                
                let style = document.getElementById("tz-font-size-override");
                if (!style) {
                    style = document.createElement("style");
                    style.id = "tz-font-size-override";
                    document.head.appendChild(style);
                }
                if (size) {
                    style.textContent = `:root { --base-font-size: ${size} !important; } #editor { font-size: var(--base-font-size) !important; }`;
                } else {
                    style.textContent = "";
                }
                applySpacing({}); 
                return;
            }

            if (cmd.startsWith("view_set:")) {
                // "view_set:<selector>:<value>" from one of the segmented controls.
                const bits = cmd.substring(9).split(':');
                const which = bits[0], value = bits[1];
                const change = {};
                if (which === 'mode') change.mode = value;
                else if (which === 'columns') change.columns = parseInt(value, 10) === 2 ? 2 : 1;
                else if (which === 'scroll') change.scroll = value;
                else return;
                applyViewState(resolveViewState(currentViewState(), change));
                try { if (typeof syncScratchEmpty === 'function') syncScratchEmpty(); } catch (eSc) {}
                return;
            }
            if (cmd === "view_sync") { postViewState(currentViewState()); return; }
            if (cmd.startsWith("debug_log:")) {
                window.__tzDebugLog = (cmd.substring(10) === '1');
                return;
            }
            if (cmd.startsWith("host_zoom:")) {
                // WebView2's ZoomFactor scales the whole page. The sidebar is chrome and
                // has to stay at menu size, so it divides the factor back out (see the
                // zoom rule on #sidebar in typozen.css).
                const z = parseFloat(cmd.substring(10));
                if (isFinite(z) && z > 0) {
                    document.documentElement.style.setProperty('--host-zoom', String(z));
                }
                return;
            }
            if (cmd.startsWith("set_page_advance:")) {
                // Resolve the anchor before the layout changes under us.
                let _pgAnchor = 0;
                try {
                    const _l = (typeof _stickyLineCache !== 'undefined' && _stickyLineCache) ? _stickyLineCache : 1;
                    _pgAnchor = isPaginatedLayout()
                        ? topLeftModelIndexTwoCol()
                        : modelIndexAtViewportCenter();
                    if (!(_pgAnchor >= 0)) _pgAnchor = modelLocationFromDocumentLine(_l).blockIndex;
                } catch (e) { _pgAnchor = 0; }

                state.pageAdvance = (cmd.substring(17) === '1');
                // Pagination is a different layout, not just a different scroll gesture:
                // put the document into (or out of) CSS multi-column to match.
                syncPaginationClass();
                applyEditorChromeForMode();
                if (state.pageAdvance) {
                    // Land on the true page holding what the reader was looking at, aligned
                    // to its real start -- not on a page synthesised from the scroll offset.
                    settleTwoColToLine(1, _pgAnchor);
                } else {
                    scheduleColumnSettle(function () { ensurePageWindow(); PageMap.invalidate(); updatePageIndicator(); });
                }
                // Report it: the selectors must follow the view however it was changed,
                // not only when the change came from a selector click.
                postViewState(currentViewState());
                return;
            }
            if (cmd.startsWith("set_column_mode:")) {
                window.showDebugTelemetry("set_column_mode called with: " + cmd);
                const twoCol = cmd.substring(16) === "2";
                
                let stickyLine = 1;
                if (typeof DocumentModel !== 'undefined') {
                    let idx = modelIndexAtViewportCenter();
                    stickyLine = modelBlockStartLine(idx);
                    window.showDebugTelemetry('set_column_mode: computed idx=' + idx + ' stickyLine=' + stickyLine);
                }

                // Use the reading anchor if we have one. Only fall back to measuring the
                // current view when there is none -- measuring it on every switch is what
                // made the anchor decay to the top of whatever page we had just landed on.
                let _anchorBlock = 0;
                try {
                    if (isPaginatedLayout() && _readingAnchor >= 0) {
                        _anchorBlock = _readingAnchor;
                    } else {
                        _anchorBlock = isPaginatedLayout()
                            ? topLeftModelIndexTwoCol()
                            : modelLocationFromDocumentLine(Math.max(1, stickyLine | 0)).blockIndex;
                    }
                    if (!(_anchorBlock >= 0)) {
                        _anchorBlock = modelLocationFromDocumentLine(Math.max(1, stickyLine | 0)).blockIndex;
                    }
                    _readingAnchor = _anchorBlock;
                } catch (e) { _anchorBlock = 0; }

                // Remember where the layout being left was sitting, and decide whether the
                // one being entered can simply be put back exactly as it was.


                markProgrammaticScroll(1200);

                if (twoCol) {
                    editor.classList.add('two-col-layout');
                } else {
                    editor.classList.remove('two-col-layout');
                    if (editor && !isPaginatedLayout()) editor.scrollLeft = 0;
                    currentTwoColPage = 0;
                }
                // One column's page counts say nothing about two. Without this the totals
                // after a switch were part measurement of the layout just left, which is
                // why the same book reported a different length in each.
                try { if (typeof PageChunks !== 'undefined') PageChunks.invalidate(); } catch (ePC) {}
                syncPaginationClass();
                applyEditorChromeForMode();

                // A paginated view does not use the sticky-line restore.
                //
                // That path (restoreStickyDocumentLine -> ensureModelBlockVisible ->
                // seedFromHeightMap -> snapOnce -> focus the caret) puts an arbitrary
                // scroll offset back on a line. Pages have no arbitrary offsets. Running it
                // as well meant several things assigning scrollLeft against each other, and
                // the caret focus scrolled the view off a page boundary after the page had
                // been chosen -- the half-of-one-page-half-of-the-next symptom.
                const _pagedTarget = isPaginatedLayout();

                if (typeof DocumentModel !== 'undefined') {
                    if (DocumentModel.kind === 'epub') {
                        // Never loadMarkdownContent(toMarkdown()) for a book (HTML → source dump).
                        if (typeof remountBookSurface === 'function') {
                            remountBookSurface({ anchorBlock: _anchorBlock });
                        }
                    } else {
                        const shouldVirt = DocumentModel.shouldVirtualize();
                        if (DocumentModel.virtEnabled !== shouldVirt) {
                            const restoreHistory = typeof HistoryManager !== 'undefined' ? HistoryManager.isRestoring : false;
                            if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = true;
                            const md = DocumentModel.toMarkdown();
                            loadMarkdownContent(md, _pagedTarget
                                ? { deferPaint: true }
                                : { deferPaint: true, stickyLine: stickyLine });
                            if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = restoreHistory;
                        } else if (!_pagedTarget) {
                            requestAnimationFrame(function () {
                                restoreStickyDocumentLine(stickyLine);
                            });
                        }
                    }
                }
                // Go to the page holding what the reader was looking at. That is the whole
                // operation, and it is the same operation whichever direction you switch.
                //
                // The remembered-position path that used to sit here has gone. It restored
                // the offset a layout was last left at, which overrode this and, because
                // page turns do not dirty it, kept restoring a stale spot -- switching to
                // 1-column landed on the old 1-column page rather than the reader's
                // content. It was also unnecessary: pageOfBlock is deterministic, so
                // switching back returns to the same page on its own.
                if (isPaginatedLayout()) goToPageHoldingBlock(_anchorBlock);

                // Column remount replaces every text node; CSS Highlight ranges die with them.
                // goToPageHoldingBlock repaints when it lands, but keep painting while the
                // multi-column flow finishes so search marks do not vanish after 1↔2-col.
                if (typeof scheduleColumnSettle === 'function') {
                    scheduleColumnSettle(function () {
                        try { if (typeof repaintFindHighlights === 'function') repaintFindHighlights(); } catch (eRf) {}
                    });
                } else {
                    try { if (typeof repaintFindHighlights === 'function') repaintFindHighlights(); } catch (eRf2) {}
                }

                // Report it: the selectors must follow the view however it was changed.
                // The host restores 2-column on startup through this command, and without
                // this the toolbar kept saying 1-Col over a two-column document.
                postViewState(currentViewState());
                return;
            }
            if (cmd === "toggle_mode") {
                // Sticky line: what the user is looking at (viewport), not only caret.
                // Source scroll without click leaves selectionStart far from the visible
                // region — that produced Preview jumps 2000→700 / 3000→1500.
                let stickyLine = 1;
                try {
                    if (state.mode === 'source') {
                        stickyLine = captureSourceStickyLineForModeSwitch();
                    } else {
                        stickyLine = captureStickyDocumentLine();
                    }
                } catch (eA) { stickyLine = 1; }
                stickyLine = Math.max(
                    stickyLine | 0,
                    _stickyLineCache | 0,
                    _lastCaretLine | 0,
                    1
                );
                // Last chance: if still in source, viewport wins over a lower sticky
                if (state.mode === 'source') {
                    try {
                        const v = hardLineFromSourceScrollTop();
                        if (v > stickyLine) stickyLine = v;
                    } catch (eV) {}
                }
                rememberStickyLine(stickyLine);

                if (state.mode === 'wysiwyg') {
                    state.mode = 'reader';
                    setEditorEditable(false);
                    applyEditorChromeForMode();
                    postMsg("mode_changed:reader");
                    if (!state.pageAdvance) {
                        state.pageAdvance = true;
                        postMsg("sync_page_advance:1");
                    }
                } else if (state.mode === 'reader') {
                    // A book stays in Reader: there is nothing to edit and nothing to
                    // serialise to Source, so leaving would only produce an empty editor.
                    if (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub') {
                        postMsg("mode_changed:reader");
                        return;
                    }
                    setEditorEditable(true);
                    // Expand soft-breaks → real blocks BEFORE Source serialize
                    try { expandAllFragmentedBlocks(); } catch (e0) {}
                    // Phase 1: flush active DOM → data-raw, then serialize (I3).
                    try { flushActiveBlockToRaw(); } catch (e) {}
                    // Soft-break expand changes hard-line numbering. Re-capture sticky
                    // against the structure Source will actually show — using the pre-expand
                    // line was a common jump (e.g. mid-doc Preview → top of Source).
                    try {
                        const afterExpand = (typeof captureStickyDocumentLineLive === 'function')
                            ? (captureStickyDocumentLineLive() | 0) : 0;
                        const viewAfter = (typeof hardLineFromPreviewViewport === 'function')
                            ? (hardLineFromPreviewViewport() | 0) : 0;
                        stickyLine = Math.max(stickyLine | 0, afterExpand, viewAfter,
                            _stickyLineCache | 0, _lastCaretLine | 0, 1);
                        rememberStickyLine(stickyLine);
                    } catch (eRecap) {}
                    const md = getMarkdownContent(false, { flushActive: false });
                    try {
                        const total = (typeof countHardLines === 'function')
                            ? countHardLines(md) : String(md || '').split('\n').length;
                        if (stickyLine > total) stickyLine = Math.max(1, total);
                        rememberStickyLine(stickyLine);
                    } catch (eClamp) {}
                    sourceEditor.value = md;
                    // Keep undo stack: mode switch must not wipe history. Align stack top
                    // with the flushed document so the next edit/undo is coherent.
                    try {
                        if (typeof HistoryManager !== 'undefined') {
                            const top = HistoryManager.undoStack.length
                                ? HistoryManager._contentOf(HistoryManager.undoStack[HistoryManager.undoStack.length - 1])
                                : '';
                            if (!HistoryManager.undoStack.length) {
                                HistoryManager.resetToCurrent();
                            } else if (!HistoryManager._sameContent(md, top)) {
                                HistoryManager._push(HistoryManager._stateFromContent(md), false);
                            }
                        }
                    } catch (eHist) {}
                    editor.style.display = 'none';
                    sourceEditor.style.display = 'block';
                    state.mode = 'source';
                    applyEditorChromeForMode();
                    resizeSourceEditor();
                    postMsg("mode_changed:source");
                    // Restore immediately (not only next frame) so status/scroll match Source.
                    try { restoreStickyDocumentLine(stickyLine); } catch (eS0) {}
                    requestAnimationFrame(function () {
                        try { resizeSourceEditor(); } catch (eR) {}
                        try { restoreStickyDocumentLine(stickyLine); } catch (eS) {}
                    });
                } else {
                    setEditorEditable(true);
                    editor.classList.remove('reader-mode', 'two-col-layout');
                    // Normalize source newlines so we do not create empty blocks from \r\n doubling
                    let src = sourceEditor ? sourceEditor.value : '';
                    src = String(src).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                    // Prefer deferred buffer from large-file open if source is empty/stale.
                    if ((!src || !src.length) && window.__tzDeferredWysiwyg) {
                        src = String(window.__tzDeferredWysiwyg);
                    }
                    window.__tzDeferredWysiwyg = null;
                    // loadMarkdownContent() calls resetToCurrent() unless isRestoring —
                    // that wiped the entire undo stack on every Source → Preview switch.
                    let wasRestoring = false;
                    try {
                        if (typeof HistoryManager !== 'undefined') {
                            wasRestoring = HistoryManager.isRestoring;
                            HistoryManager.isRestoring = true;
                        }
                        // Always full markdown render (lists, headings, …). Large docs paint
                        // progressively inside loadMarkdownContent — never leave plain "-" text.
                        // Pass stickyLine so load does not leave you on block 0 / Ln 1.
                        loadMarkdownContent(src, { stickyLine: stickyLine });
                    } finally {
                        try {
                            if (typeof HistoryManager !== 'undefined') {
                                HistoryManager.isRestoring = wasRestoring;
                                // If the user edited in Source, record that as a stack frame
                                // so Ctrl+Z can still step back after returning to Preview.
                                const live = src;
                                const top = HistoryManager.undoStack.length
                                    ? HistoryManager._contentOf(HistoryManager.undoStack[HistoryManager.undoStack.length - 1])
                                    : '';
                                if (!HistoryManager.undoStack.length) {
                                    HistoryManager.resetToCurrent();
                                } else if (!HistoryManager._sameContent(live, top)) {
                                    HistoryManager._push(HistoryManager._stateFromContent(live), true);
                                }
                            }
                        } catch (eHist2) {}
                    }
                    sourceEditor.style.display = 'none';
                    editor.style.display = 'block';
                    state.mode = 'wysiwyg';
                    applyEditorChromeForMode(); // restore page margins + main-container scroll
                    postMsg("mode_changed:wysiwyg");
                    // Restore after layout: first paint may have zero rects while display flips.
                    // Hold stickyLine closed over rAF so a late paint cannot leave you mid-doc.
                    const stickyToPreview = stickyLine;
                    function restorePreviewSticky() {
                        try { restoreStickyDocumentLine(stickyToPreview); } catch (eS) {}
                    }
                    try { restorePreviewSticky(); } catch (eS2a) {}
                    requestAnimationFrame(function () {
                        restorePreviewSticky();
                        requestAnimationFrame(function () {
                            restorePreviewSticky();
                            // Third settle after virt measure of target window
                            setTimeout(restorePreviewSticky, 48);
                        });
                    });
                }
                // Find: recount only — never navigate (would override sticky line).
                // Sidebar Search shares findState without opening the find bar; clearing
                // highlights whenever Ctrl+F is closed wiped every match on mode switch.
                const sideQ = (function () {
                    try {
                        const s = document.getElementById('sidebarSearchInput');
                        return s ? String(s.value || '').trim() : '';
                    } catch (e) { return ''; }
                })();
                const liveQ = (isFindBarOpen()
                    ? ((document.getElementById('findInput') || {}).value || '')
                    : '') || sideQ || findState.query || '';
                if (liveQ) {
                    runFind(liveQ, true, { navigate: false });
                    // Keep 1/N near the reading position (do not leave match 0 after mode switch).
                    try {
                        if (typeof syncSearchIndexToLocation === 'function'
                            && !window.__tzExternalSearchActive) {
                            syncSearchIndexToLocation();
                        }
                    } catch (eSyncM) {}
                    if (isFindBarOpen()) focusFindInput();
                } else {
                    clearFindHighlights();
                }
                // Reader/Preview/Source changes whether pages apply at all.
                syncPaginationClass();
                applyEditorChromeForMode();
                scheduleColumnSettle(function () { ensurePageWindow(); PageMap.invalidate(); updatePageIndicator(); });
                // Mode changes from the toolbar selector (and host view_set), not a shortcut.
                postViewState(currentViewState());
            }
            else if (cmd === "toggle_sidebar") {
                // User pin: open if collapsed (or only edge-open), close if permanently open.
                // Edge-hover leaves the bar open without pinning; a toolbar click in that
                // state must pin it, not slam it shut.
                if (!sidebar) return;
                if (sidebar.classList.contains('collapsed')) {
                    sidebar.classList.remove('collapsed');
                    postSidebarState();
                } else if (_sidebarEdgeOnly) {
                    postSidebarState(); // keep open, pin permanently
                } else {
                    sidebar.classList.add('collapsed');
                    postSidebarState();
                }
            }
            else if (cmd === "sidebar_edge:1" || cmd === "sidebar_edge:0") {
                // Temporary left-edge hover. Never posts sidebar_state — that would pin.
                if (!sidebar) return;
                try { wireSidebarEdgePointerGuard(); } catch (eW2) {}
                if (cmd === "sidebar_edge:1") {
                    if (_sidebarEdgeCloseTimer) {
                        try { clearTimeout(_sidebarEdgeCloseTimer); } catch (eC3) {}
                        _sidebarEdgeCloseTimer = null;
                    }
                    if (!sidebar.classList.contains('collapsed')) return; // already open (pinned)
                    sidebar.classList.remove('collapsed');
                    _sidebarEdgeOnly = true;
                } else {
                    if (!_sidebarEdgeOnly) return; // pinned open stays open
                    // Host leave-hot-zone: keep open while the pointer is still on the bar.
                    if (_pointerOverSidebar) return;
                    if (_sidebarEdgeCloseTimer) {
                        try { clearTimeout(_sidebarEdgeCloseTimer); } catch (eC4) {}
                    }
                    // Brief grace so a move from the left strip into the search row is not
                    // a close-open-close flicker when host ticks before mouseenter fires.
                    _sidebarEdgeCloseTimer = setTimeout(function () {
                        _sidebarEdgeCloseTimer = null;
                        if (!_sidebarEdgeOnly || _pointerOverSidebar) return;
                        sidebar.classList.add('collapsed');
                        _sidebarEdgeOnly = false;
                    }, 180);
                }
            }
            else if (cmd === "goto_page") {
                try { if (typeof openGoToPageDialog === 'function') openGoToPageDialog(); } catch (eGp) {}
            }
            else if (cmd === "goto_chapter") {
                try {
                    if (typeof _currentChapterBi === 'number' && _currentChapterBi >= 0
                        && typeof goToReadingBlock === 'function') {
                        if (typeof captureReturnJump === 'function') captureReturnJump();
                        goToReadingBlock(_currentChapterBi);
                    }
                } catch (eCh) {}
            }
            else if (cmd === "mark_toggle") {
                try { if (!annotateSelection()) toggleMarkAtBlock(markTargetBlock()); } catch (eMk) {}
                return;
            }
            else if (cmd === "show_marks") {
                try {
                    const sb = document.getElementById('sidebar');
                    if (sb) sb.classList.remove('collapsed');
                    postMsg('sidebar_state:1');
                    if (typeof switchTab === 'function') switchTab('marks');
                } catch (eSm) {}
                return;
            }
            else if (cmd === "show_outline") {
                try {
                    const sb = document.getElementById('sidebar');
                    if (sb) sb.classList.remove('collapsed');
                    postMsg('sidebar_state:1');
                    if (typeof switchTab === 'function') switchTab('outline');
                } catch (eSo) {}
                return;
            }
            else if (cmd === "show_search") {
                try {
                    const sb = document.getElementById('sidebar');
                    if (sb) sb.classList.remove('collapsed');
                    postMsg('sidebar_state:1');
                    if (typeof switchTab === 'function') switchTab('search');
                } catch (eSs) {}
                return;
            }
            else if (cmd === "return_jump") {
                try { if (typeof returnFromJump === 'function') returnFromJump(); } catch (eRj) {}
            }
            else if (cmd === "clear_search_history") {
                try { if (typeof clearSearchHistoryOnly === 'function') clearSearchHistoryOnly(); } catch (eCs) {}
            }
            else if (cmd === "toggle_search_sidebar") {
                // Alt+S, the ZenSeek gesture. Closed, or open on another tab, means the
                // user wants search: reveal it. Only a sidebar already showing Search
                // collapses, so the key is a true toggle rather than an open-only.
                const searchPane = document.getElementById('tab-search');
                const showingSearch = searchPane && searchPane.classList.contains('active');
                if (sidebar.classList.contains('collapsed') || !showingSearch) {
                    let savedSticky = (typeof _stickyLineCache !== 'undefined') ? (_stickyLineCache | 0) : null;
                    try {
                        if (state.mode === 'wysiwyg' && typeof getCaretLineNumber === 'function') {
                            const liveCaret = getCaretLineNumber();
                            if (liveCaret >= 1) savedSticky = liveCaret;
                        }
                    } catch (e) {}
                    if (window.markProgrammaticScroll) window.markProgrammaticScroll(800);
                    sidebar.classList.remove('collapsed');
                    postSidebarState();
                    if (savedSticky !== null && savedSticky >= 1 && typeof rememberStickyLine === 'function') {
                        rememberStickyLine(savedSticky);
                    }
                    if (typeof switchTab === 'function') switchTab('search');
                    if (typeof wireSidebarSearch === 'function') wireSidebarSearch();
                    // Seed from the selection, else restore the last Search query.
                    const input = document.getElementById('sidebarSearchInput');
                    if (input) {
                        try {
                            const sel = window.getSelection();
                            if (sel && !sel.isCollapsed && sel.toString().trim()) {
                                input.value = sel.toString().trim().slice(0, 200);
                            } else if (state.mode === 'source' && sourceEditor) {
                                const a = sourceEditor.selectionStart, b = sourceEditor.selectionEnd;
                                if (b > a) input.value = sourceEditor.value.substring(a, b).slice(0, 200);
                            }
                            if (!String(input.value || '').trim()
                                && typeof _lastSearchQuery === 'string' && _lastSearchQuery) {
                                input.value = _lastSearchQuery;
                            }
                        } catch (e) {}
                        if (input.value) {
                            runFind(input.value, true, { navigate: false });
                            if (typeof syncSearchIndexToLocation === 'function') {
                                try { 
                                    if (!window.__tzExternalSearchActive) syncSearchIndexToLocation(); 
                                } catch (eSync) {}
                            }
                        }
                        updateSidebarSearchCount();
                        if (typeof updateSearchSidebar === 'function') updateSearchSidebar();
                        
                        focusSidebarSearchInput(true);
                        if (typeof armSidebarSearchIdle === 'function') armSidebarSearchIdle();
                    } else {
                        focusSidebarSearchInput(true);
                        if (typeof armSidebarSearchIdle === 'function') armSidebarSearchIdle();
                    }
                } else {
                    const savedStickyClose = (typeof _stickyLineCache !== 'undefined') ? (_stickyLineCache | 0) : null;
                    if (window.markProgrammaticScroll) window.markProgrammaticScroll(800);
                    sidebar.classList.add('collapsed');
                    postSidebarState();
                    if (savedStickyClose !== null && savedStickyClose >= 1 && typeof rememberStickyLine === 'function') {
                        rememberStickyLine(savedStickyClose);
                    }
                    cancelSidebarSearchIdle();
                    try {
                        const input = document.getElementById('sidebarSearchInput');
                        if (input) input.value = '';
                        if (typeof runFind === 'function') runFind('', false, { navigate: false });
                        if (typeof updateSidebarSearchCount === 'function') updateSidebarSearchCount();
                        if (typeof updateSearchSidebar === 'function') updateSearchSidebar();
                        if (typeof commitSearchFocus === 'function') commitSearchFocus();
                    } catch (e) {}
                }
                scheduleSavePreferences();
            }
            else if (cmd === "persist_content_on" || cmd === "persist_content_off") {
                state.persistContent = (cmd === "persist_content_on");
                if (!state.persistContent) {
                    // Drop the copy already sitting in localStorage rather than waiting
                    // for the next prefs write to overwrite it.
                    try {
                        const p = localStorage.getItem('typozen_prefs');
                        if (p) {
                            const o = JSON.parse(p);
                            o.lastContent = '';
                            localStorage.setItem('typozen_prefs', JSON.stringify(o));
                        }
                    } catch (e) {}
                }
            }
            else if (cmd === "clear_local_storage") {
                // Host-driven purge. This drops the live values; the backing LevelDB keeps
                // superseded copies until it compacts, so the host also deletes the store
                // itself at next launch.
                try { localStorage.clear(); } catch (e) {}
                try { if (typeof clearSearchHistoryOnly === 'function') clearSearchHistoryOnly(); } catch (eH) {}
                try {
                    const mc = document.getElementById('findMatchCase');
                    const ww = document.getElementById('findWholeWord');
                    if (mc) mc.checked = false;
                    if (ww) ww.checked = false;
                    if (typeof syncSearchOptionButtons === 'function') syncSearchOptionButtons();
                } catch (eFo) {}
            }
            else if (cmd === "toggle_reveal") {
                state.revealOnFocus = !state.revealOnFocus;
                const active = document.activeElement;
                if (active && active.classList && active.classList.contains('block')) {
                    const raw = active.getAttribute('data-raw') || '';
                    if (state.revealOnFocus) {
                        active.innerText = raw;
                    } else {
                        renderBlockPreview(active, raw);
                    }
                }
            }
            else if (cmd === "toggle_focus") {
                state.focusMode = !state.focusMode;
                editor.classList.toggle('focus-mode', state.focusMode);
            }
            else if (cmd === "toggle_typewriter") {
                state.typewriterMode = !state.typewriterMode;
                // Immediate feedback when turning on — scroll active line/block to vertical center
                if (state.typewriterMode) applyTypewriterScroll(true);
            }
            else if (cmd === "set_margin_narrow") { setMargin("narrow"); }
            else if (cmd === "set_margin_regular") { setMargin("regular"); }
            else if (cmd === "set_margin_wide") { setMargin("wide"); }
            if (cmd.startsWith("toggle_")) {
                postViewFlags();
                scheduleSavePreferences();
            }
            if (cmd === "undo") { if (typeof HistoryManager !== 'undefined') HistoryManager.undo(); else document.execCommand('undo'); }
            else if (cmd === "redo") { if (typeof HistoryManager !== 'undefined') HistoryManager.redo(); else document.execCommand('redo'); }
            else if (cmd === "cut") { document.execCommand('cut'); }
            else if (cmd === "copy") { document.execCommand('copy'); }
            else if (cmd === "paste") {
                // execCommand('paste') is blocked in WebView2. Host menu uses paste_text:;
                // if something still sends cmd:paste, try async clipboard API then same insert path.
                if (navigator.clipboard && navigator.clipboard.readText) {
                    navigator.clipboard.readText().then(function (t) {
                        if (t) insertPastedPlainText(t);
                    }).catch(function () {});
                }
            }
            else if (cmd === "find") {
                openFindBar();
            }
            else if (cmd === "find_replace") {
                openFindBar(null, true);
            }
            else if (cmd === "help_syntax") {
                // Open, do not toggle. F1 can arrive from page JS and from the host
                // key filter for the same key; toggling made a working F1 look dead.
                closeTzOverlay('aboutModal');
                if (!isTzOverlayOpen('helpModal'))
                    openTzOverlay('helpModal', 'helpClose', 'helpOk');
            }
            else if (cmd === "help_about") {
                closeTzOverlay('helpModal');
                if (!isTzOverlayOpen('aboutModal'))
                    openTzOverlay('aboutModal', 'aboutClose', 'aboutOk');
            }
            else if (cmd === "toggle_debug_hud") {
                if (typeof window.toggleDebugHUD === 'function') window.toggleDebugHUD();
            }
        }

        // Table size picker: 10 columns × 8 data-rows (Notepad-style hover grid)
        const TABLE_PICKER_COLS = 10;
        const TABLE_PICKER_ROWS = 8;
        let _tablePickerBuilt = false;
        let _tablePickerCols = 1;
        let _tablePickerRows = 1;

        function ensureTableSizePicker() {
            if (_tablePickerBuilt) return;
            const grid = document.getElementById('tableSizeGrid');
            if (!grid) return;
            grid.innerHTML = '';
            for (let r = 1; r <= TABLE_PICKER_ROWS; r++) {
                for (let c = 1; c <= TABLE_PICKER_COLS; c++) {
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'tz-table-picker-cell';
                    cell.setAttribute('data-c', String(c));
                    cell.setAttribute('data-r', String(r));
                    cell.setAttribute('aria-label', c + ' by ' + r + ' table');
                    cell.addEventListener('mouseenter', function () {
                        highlightTablePicker(c, r);
                    });
                    cell.addEventListener('click', function (e) {
                        e.preventDefault();
                        e.stopPropagation();
                        insertMarkdownTable(c, r);
                        closeTableSizePicker();
                    });
                    grid.appendChild(cell);
                }
            }
            const custom = document.getElementById('tableSizeCustom');
            if (custom) {
                custom.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTableSizePicker(false);
                    openTableCustomModal();
                });
            }
            // Click outside closes
            document.addEventListener('mousedown', function (e) {
                const picker = document.getElementById('tableSizePicker');
                if (!picker || picker.style.display === 'none' || !picker.classList.contains('open')) return;
                if (picker.contains(e.target)) return;
                closeTableSizePicker();
            }, true);
            document.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape') return;
                const picker = document.getElementById('tableSizePicker');
                if (!picker || !picker.classList.contains('open')) return;
                closeTableSizePicker();
                e.preventDefault();
            }, true);
            _tablePickerBuilt = true;
        }

        function highlightTablePicker(cols, rows) {
            _tablePickerCols = cols;
            _tablePickerRows = rows;
            const grid = document.getElementById('tableSizeGrid');
            const label = document.getElementById('tableSizeLabel');
            if (label) label.textContent = cols + ' × ' + rows + ' Table';
            if (!grid) return;
            const cells = grid.querySelectorAll('.tz-table-picker-cell');
            for (let i = 0; i < cells.length; i++) {
                const c = parseInt(cells[i].getAttribute('data-c'), 10);
                const r = parseInt(cells[i].getAttribute('data-r'), 10);
                if (c <= cols && r <= rows) cells[i].classList.add('on');
                else cells[i].classList.remove('on');
            }
        }

        /** Open grid picker (default for Ctrl+T / Table button). */
        function openTableSizePicker() {
            if (state.mode === 'wysiwyg') {
                try { state.targetTableBlock = getFormatTargetBlock(); } catch (e) {}
            }
            ensureTableSizePicker();
            const picker = document.getElementById('tableSizePicker');
            if (!picker) {
                openTableCustomModal();
                return;
            }
            picker.style.display = 'block';
            picker.classList.add('open');
            highlightTablePicker(1, 1);
        }

        function closeTableSizePicker(refocus) {
            const picker = document.getElementById('tableSizePicker');
            if (picker) {
                picker.classList.remove('open');
                picker.style.display = 'none';
            }
            if (refocus === false) return;
            if (state.mode === 'wysiwyg' && state.targetTableBlock) {
                try { state.targetTableBlock.focus(); } catch (e) {}
            } else if (state.mode === 'source' && sourceEditor) {
                try { sourceEditor.focus(); } catch (e2) {}
            }
        }

        /** Number fields for sizes beyond the 10×8 grid. */
        function openTableCustomModal() {
            if (state.mode === 'wysiwyg') {
                try { state.targetTableBlock = getFormatTargetBlock(); } catch (e) {}
            }
            const modal = document.getElementById('tableModal');
            if (modal) {
                modal.style.display = 'flex';
                const colInput = document.getElementById('tblCols');
                if (colInput) {
                    colInput.focus();
                    colInput.select();
                }
            }
        }

        function closeTableModal() {
            const modal = document.getElementById('tableModal');
            if (modal) modal.style.display = 'none';
            if (state.mode === 'wysiwyg' && state.targetTableBlock) {
                try { state.targetTableBlock.focus(); } catch (e) {}
            } else if (state.mode === 'source' && sourceEditor) {
                try { sourceEditor.focus(); } catch (e2) {}
            }
        }

        /**
         * Themed help/about overlays (not browser alert / WinForms MessageBox).
         * Shared shell: #helpModal, #aboutModal — class tz-help-overlay.
         */
        function isTzOverlayOpen(id) {
            const m = document.getElementById(id);
            return !!(m && m.classList.contains('open') && !m.hasAttribute('hidden'));
        }

        function openTzOverlay(id, closeId, okId) {
            const modal = document.getElementById(id);
            if (!modal) return;
            try { modal.removeAttribute('hidden'); } catch (eH) {}
            modal.hidden = false;
            modal.classList.add('open');
            const panel = modal.querySelector('.tz-help-panel');
            const closeBtn = (closeId && document.getElementById(closeId))
                || (okId && document.getElementById(okId));
            try {
                if (closeBtn) closeBtn.focus();
                else if (panel) panel.focus();
            } catch (eF) {}
        }

        function closeTzOverlay(id) {
            const modal = document.getElementById(id);
            if (!modal) return;
            const wasOpen = modal.classList.contains('open') || !modal.hasAttribute('hidden');
            modal.classList.remove('open');
            modal.hidden = true;
            if (!wasOpen) return;
            try {
                if (state.mode === 'source' && sourceEditor) sourceEditor.focus();
                else if (typeof focusEditorNoScroll === 'function') focusEditorNoScroll();
                else if (editor) editor.focus({ preventScroll: true });
            } catch (eC) {}
        }

        // Removed: closeAllTzOverlays, and the isHelpModalOpen / openHelpModal /
        // closeHelpModal back-compat wrappers. The wiring and evals they were kept for
        // are gone -- nothing in the engine, the host, the template or the suites named
        // any of them. openTzOverlay / closeTzOverlay / isTzOverlayOpen are the interface.

        (function bindTzOverlaysOnce() {
            function wire(id, closeId, okId) {
                const modal = document.getElementById(id);
                if (!modal || modal.__tzOverlayBound) return;
                modal.__tzOverlayBound = true;
                function shut(e) {
                    if (e) e.preventDefault();
                    closeTzOverlay(id);
                }
                const closeBtn = closeId && document.getElementById(closeId);
                const okBtn = okId && document.getElementById(okId);
                if (closeBtn) closeBtn.addEventListener('click', shut);
                if (okBtn) okBtn.addEventListener('click', shut);
                modal.addEventListener('click', function (e) {
                    if (e.target === modal) shut(e);
                });
            }
            wire('helpModal', 'helpClose', 'helpOk');
            wire('aboutModal', 'aboutClose', 'aboutOk');

            // About -> "Report a problem or suggest a feature".
            //
            // A fixed command, deliberately not 'open_url:<href>'. A host handler that
            // launches whatever URL the page hands it is a hole: everything rendered in
            // this page is document content, and the shell is one postMessage away. The
            // host holds the address; the page can only ask for that one thing.
            //
            // The overlay stays open behind the browser: closing it would leave the
            // reader looking at the editor with no sign anything happened if the browser
            // takes a moment to come up.
            (function () {
                const fb = document.getElementById('aboutFeedback');
                if (!fb || fb.__tzBound) return;
                fb.__tzBound = true;
                fb.addEventListener('click', function () {
                    try { postMsg('feedback'); } catch (e) {}
                });
            })();

            // About -> "Buy me a coffee". Same fixed-command shape as feedback: the page
            // never learns the address. It also stays HIDDEN unless the host unhides it,
            // because only the host knows whether a support URL is configured at all.
            (function () {
                const sp = document.getElementById('aboutSupport');
                if (!sp || sp.__tzBound) return;
                sp.__tzBound = true;
                sp.addEventListener('click', function () {
                    try { postMsg('support'); } catch (e) {}
                });
            })();
            document.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape') return;
                if (isTzOverlayOpen('aboutModal')) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTzOverlay('aboutModal');
                    return;
                }
                if (isTzOverlayOpen('helpModal')) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTzOverlay('helpModal');
                }
            }, true);
        })();

        /** Build GFM table markdown and insert (shared by picker + custom modal). */
        function insertMarkdownTable(cols, rows) {
            cols = parseInt(cols, 10);
            rows = parseInt(rows, 10);
            if (isNaN(cols) || cols < 1) cols = 3;
            if (isNaN(rows) || rows < 1) rows = 3;
            if (cols > 20) cols = 20;
            if (rows > 50) rows = 50;

            const headerRow = '| ' + Array.from({ length: cols }, function (_, i) {
                return 'Header ' + (i + 1);
            }).join(' | ') + ' |';
            const sepRow = '| ' + Array.from({ length: cols }, function () { return '---'; }).join(' | ') + ' |';
            const bodyRows = Array.from({ length: rows }, function (_, r) {
                return '| ' + Array.from({ length: cols }, function (_, c) {
                    return 'Cell ' + (r + 1) + ',' + (c + 1);
                }).join(' | ') + ' |';
            }).join('\n');
            const tableMd = headerRow + '\n' + sepRow + '\n' + bodyRows;

            const pre = (typeof getMarkdownContent === 'function') ? getMarkdownContent(false) : '';

            if (state.mode === 'source') {
                const start = sourceEditor.selectionStart || 0;
                const end = sourceEditor.selectionEnd || 0;
                // Ensure blank lines around table when inserting mid-document
                let text = tableMd;
                const val = sourceEditor.value || '';
                if (start > 0 && val.charAt(start - 1) !== '\n') text = '\n' + text;
                sourceEditor.setRangeText(text, start, end, 'select');
                sourceEditor.focus();
                if (typeof HistoryManager !== 'undefined') {
                    try { HistoryManager.recordEditPair(pre, sourceEditor.value); } catch (e) {}
                }
                savePreferences();
                updateStats();
                return;
            }

            let active = state.targetTableBlock;
            if (!active || !active.classList || !active.classList.contains('block')) {
                const blocks = editor.querySelectorAll('.block');
                if (blocks.length > 0) active = blocks[blocks.length - 1];
            }
            if (active && active.classList.contains('block')) {
                let raw = active.getAttribute('data-raw') || active.innerText;
                if (!String(raw || '').trim()) {
                    writeBlockRaw(active, tableMd);
                    focusBlock(active, 0);
                } else {
                    const newBlock = createBlock(tableMd, active);
                    focusBlock(newBlock, 0);
                }
            } else {
                const newBlock = createBlock(tableMd);
                focusBlock(newBlock, 0);
            }
            if (typeof HistoryManager !== 'undefined') {
                try { HistoryManager.recordEditPair(pre, getMarkdownContent(false)); } catch (e2) {}
            }
            updateStats();
            updateOutline();
            savePreferences();
        }

        function confirmInsertTable() {
            const colInput = document.getElementById('tblCols');
            const rowInput = document.getElementById('tblRows');
            let cols = parseInt(colInput ? colInput.value : 3, 10);
            let rows = parseInt(rowInput ? rowInput.value : 3, 10);
            const modal = document.getElementById('tableModal');
            if (modal) modal.style.display = 'none';
            insertMarkdownTable(cols, rows);
        }

