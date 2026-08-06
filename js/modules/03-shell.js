// TypoZen module: 03-shell.js
// Lines 3028-4154 of the former monolith. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.

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
            _resumeAtTimer = setTimeout(function () {
                _resumeAtTimer = null;
                try {
                    // Search handoff wins over last-read restore.
                    if (Date.now() < _externalFindActiveUntil) return;
                    if (typeof DocumentModel === 'undefined') return;
                    if (resumeAt >= DocumentModel.blocks.length) return;
                    if (typeof goToModelBlock === 'function') goToModelBlock(resumeAt);
                } catch (e1) {}
            }, 400);
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
            if (_resumeAtTimer) {
                try { clearTimeout(_resumeAtTimer); } catch (eR) {}
                _resumeAtTimer = null;
            }

            const run = function () {
                if (gen !== _externalFindGen) return;
                try {
                    // ZenSeek / Phase 6: Search sidebar only — never open Ctrl+F.
                    try {
                        if (typeof postMsg === 'function') postMsg('sidebar_state:1');
                    } catch (eSide) {}
                    try {
                        const sb = document.getElementById('sidebar');
                        if (sb) sb.classList.remove('collapsed');
                    } catch (eSb) {}
                    if (typeof window.switchTab === 'function') window.switchTab('search');
                    const side = document.getElementById('sidebarSearchInput');
                    if (side) side.value = query;
                    try {
                        const fi = document.getElementById('findInput');
                        if (fi) fi.value = query;
                    } catch (eFi) {}
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
                        const idx = Math.min(matchIndex, findState.matches.length - 1);
                        if (typeof window.findJumpTo === 'function') window.findJumpTo(idx);
                        else if (typeof runFind === 'function') {
                            findState.index = idx;
                            runFind(query, true, { navigate: true });
                        }
                        if (typeof hideFindBarChrome === 'function') hideFindBarChrome();
                    }
                    try {
                        _searchRenderedSig = '';
                        _searchRenderedList = null;
                        if (typeof updateSearchSidebar === 'function') updateSearchSidebar();
                        if (typeof updateSidebarSearchCount === 'function') updateSidebarSearchCount();
                        if (typeof wireSidebarSearch === 'function') wireSidebarSearch();
                        if (typeof wireSearchResultKeys === 'function') wireSearchResultKeys();
                        if (typeof focusSidebarSearchInput === 'function') focusSidebarSearchInput(true);
                    } catch (eS) {}
                } catch (e) {
                    try { window.showDebugTelemetry('external_find: ' + e.message); } catch (e2) {}
                }
            };
            // One early attempt + one after layout settle. Three uncancelled retries used
            // to re-fire goToPage against resume-at and thrash the page.
            _externalFindTimers.push(setTimeout(run, 200));
            _externalFindTimers.push(setTimeout(run, 900));
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

            const initialContent = savedPrefs.lastContent || "# Welcome to TypoZen\n\nA modern, distraction-free **WYSIWYG** markdown and text editor.\n\n### Key Features\n- **True Live Preview**: Markdown formatting conceals when you step away, and reveals when focused.\n- **Bulletproof Engine**: Custom snapshot Undo/Redo stack, IME composition protection, and smart clipboard sanitization.\n- **Precision Editing**: 2-stage Backspace formatting clearing and cross-boundary selection merging.\n- **Multiple Themes**: Try switching themes from the menu or toolbar!\n- **Document Outline**: Click any heading in the sidebar to jump directly to it.\n- **Distraction-Free**: Toggle Focus Mode (F8) or Typewriter Scrolling (F9).";

            tzMark('(page) prefs read from localStorage');
            loadMarkdownContent(initialContent, { replaceBook: true });
            tzMark('(page) initial content rendered');
            state.lastSavedContent = getMarkdownContent(false);
            tzMark('(page) markdown round-tripped');

            applySavedPrefs(savedPrefs);
            tzMark('(page) prefs applied (theme/fonts)');

            isRestoring = false;

            sourceEditor.addEventListener('input', () => {
                rememberStickyFromSourceIfFocused();
                resizeSourceEditor();
                try { DocumentModel.fromMarkdown(sourceEditor.value); } catch (eM) {}
                if (typeof HistoryManager !== 'undefined') HistoryManager.snapshot();
                updateStatsNow();
                if (isFindBarOpen()) {
                    runFind(document.getElementById('findInput').value, true, { navigate: false });
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
                const ro = new ResizeObserver(function () {
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
                });
                ro.observe(editor);
            }

            // Any movement or edit by the reader invalidates the remembered column
            // positions, so switching back anchors afresh instead of restoring a spot they
            // have since left. Scrolls we perform ourselves are excluded by the
            // markProgrammaticScroll window.
            if (mainContainer) mainContainer.addEventListener('scroll', noteUserMovement, { passive: true });
            if (mainContainer) mainContainer.addEventListener('scroll', reportBookPosition, { passive: true });
            if (editor) {
                editor.addEventListener('scroll', noteUserMovement, { passive: true });
                editor.addEventListener('scroll', reportBookPosition, { passive: true });

                // Keep scrollLeft on a page boundary. PageGeometry owns the stride.
                let _snapTimer = null;
                editor.addEventListener('scroll', function () {
                    if (!isPaginatedLayout()) return;
                    if (Date.now() <= _progScrollUntil) return;
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
                });
            }
            initFindBar();

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
                else if (msg.startsWith("load_content:")) {
                    const content = msg.substring(13);
                    finishLoadContent(content, false);
                }
                else if (msg.startsWith("fetch_and_load_book:")) {
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
                    fetch(url, { cache: 'no-store' })
                        .then(function (r) {
                            if (!r.ok) throw new Error('fetch ' + r.status);
                            return r.text();
                        })
                        .then(function (json) {
                            const ok = loadBookPayload(json);
                            if (ok && resumeAt > 0 && resumeAt < DocumentModel.blocks.length) {
                                // After the layout, not with it: the book has to be
                                // paginated before a block can be put on a page, and
                                // windowing may still be mounting the chunk it lands in.
                                scheduleResumeAtBlock(resumeAt);
                            }
                            try { postMsg(ok ? 'load_done' : 'load_failed:book'); } catch (e0) {}
                        })
                        .catch(function (err) {
                            try { console.error('TypoZen fetch_and_load_book failed', err); } catch (e) {}
                            try { postMsg('load_failed:' + String(err && err.message ? err.message : err)); } catch (e2) {}
                        });
                    return;
                }
                else if (msg.startsWith("fetch_and_load:")) {
                    // Optional trailing |at=<block> (same shape as fetch_and_load_book).
                    let spec = msg.substring(15);
                    let resumeAt = -1;
                    const atPos = spec.indexOf('|at=');
                    if (atPos >= 0) {
                        resumeAt = parseInt(spec.substring(atPos + 4), 10);
                        spec = spec.substring(0, atPos);
                        if (!isFinite(resumeAt)) resumeAt = -1;
                    }
                    const url = spec;
                    fetch(url, { cache: 'no-store' })
                        .then(function (r) {
                            if (!r.ok) throw new Error('fetch ' + r.status);
                            return r.text();
                        })
                        .then(function (content) {
                            finishLoadContent(content, false);
                            if (resumeAt > 0) scheduleResumeAtBlock(resumeAt);
                            try { postMsg('load_done'); } catch (e0) {}
                        })
                        .catch(function (err) {
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
                else if (msg.startsWith("external_find:")) {
                    // Phase 6 (ZenSeek): external_find:<url-encoded query>|match=N
                    applyExternalFind(msg.substring(14));
                }
                else if (msg.startsWith("external_goto_line:")) {
                    // Phase 6: 1-based hard line (ZenSeek's 0-based line + 1).
                    const line = parseInt(msg.substring(19), 10);
                    if (isFinite(line) && line >= 1) applyExternalGotoLine(line);
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
                    loadMarkdownContent("# Untitled Document\n\nStart typing here...", { replaceBook: true });
                    state.lastSavedContent = getMarkdownContent(false);
                    if (state.mode === 'source') {
                        sourceEditor.value = state.lastSavedContent;
                        requestAnimationFrame(resizeSourceEditor);
                    }
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
            root.setProperty('--accent-bg', t.AccentBg || (isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)'));
            root.setProperty('--code-bg', t.CodeBg || 'rgba(128, 128, 128, 0.15)');
            root.setProperty('--quote-bg', t.QuoteBg || 'rgba(128, 128, 128, 0.08)');
        }

        function postViewFlags() {
            postMsg('view_flags:reveal=' + (state.revealOnFocus ? '1' : '0')
                + ',focus=' + (state.focusMode ? '1' : '0')
                + ',typewriter=' + (state.typewriterMode ? '1' : '0'));
        }

        // --- COMMAND & FORMATTING HANDLER ---
        function handleCommand(cmd) {
            if (cmd === "wordwrap_on") { document.body.classList.remove("nowrap"); return; }
            if (cmd === "wordwrap_off") { document.body.classList.add("nowrap"); return; }
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
                    const md = getMarkdownContent(false, { flushActive: false });
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
                    if (isFindBarOpen()) focusFindInput();
                } else {
                    clearFindHighlights();
                }
                // Reader/Preview/Source changes whether pages apply at all.
                syncPaginationClass();
                applyEditorChromeForMode();
                scheduleColumnSettle(function () { ensurePageWindow(); PageMap.invalidate(); updatePageIndicator(); });
                // Mode can change from Ctrl+/ or the View menu, not just a selector click.
                postViewState(currentViewState());
            }
            else if (cmd === "toggle_sidebar") {
                sidebar.classList.toggle('collapsed');
                postSidebarState();
            }
            else if (cmd === "toggle_search_sidebar") {
                // Alt+S, the ZenSeek gesture. Closed, or open on another tab, means the
                // user wants search: reveal it. Only a sidebar already showing Search
                // collapses, so the key is a true toggle rather than an open-only.
                const searchPane = document.getElementById('tab-search');
                const showingSearch = searchPane && searchPane.classList.contains('active');
                if (sidebar.classList.contains('collapsed') || !showingSearch) {
                    sidebar.classList.remove('collapsed');
                    postSidebarState();
                    switchTab('search');
                    wireSidebarSearch();
                    // Seed from the selection, the way a search box is expected to.
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
                        } catch (e) {}
                        if (input.value) runFind(input.value, true, { navigate: false });
                        updateSidebarSearchCount();
                    }
                    focusSidebarSearchInput(true);
                } else {
                    sidebar.classList.add('collapsed');
                    postSidebarState();
                    cancelSidebarSearchIdle();
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
                alert("TypoZen Markdown Syntax & Shortcuts:\n\n# Heading 1 to ###### Heading 6\n**Bold** (Ctrl+B) | *Italic* (Ctrl+I)\n~~Strikethrough~~ (Ctrl+Shift+X)\n`Inline Code` or ```Code block```\n> Blockquote\n- Bullet List | 1. Numbered List\n- [ ] Task checklist\n[Link Text](URL) (Ctrl+K)\n| Col 1 | Col 2 |\n| --- | --- | (Ctrl+T for Table)\n| Cell | Cell |\n\nEditor Shortcuts:\nCtrl+F Find  |  Ctrl+H Find/Replace\nCtrl+/: Source Mode\nCtrl+\\: Sidebar\nCtrl++ Zoom In  |  Ctrl+- Zoom Out  |  Ctrl+0 Reset Zoom  |  Ctrl+scroll\nCtrl+W Close tab  |  Ctrl+Tab / Ctrl+Shift+Tab cycle tabs\nF1 Help  F7 Reveal  F8 Focus  F9 Typewriter  F11 Fullscreen");
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

        /** Legacy name: toolbar / Ctrl+T open the visual picker. */
        function openTableModal() {
            openTableSizePicker();
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

