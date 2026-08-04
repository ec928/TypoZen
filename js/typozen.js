// --- STARTUP INSTRUMENTATION (see PerfMark in TypoZen_App.cs) ---
        // Inert unless the host navigates with ?perf=1, which it only does when the
        // TYPOZEN_PERF environment variable is set. Marks are buffered and flushed to the
        // host in one batch at "ready", so timing them does not itself cost round trips.
        var TZ_PERF = /[?&]perf=1/.test(location.search);
        var TZ_MARKS = [];
        function tzMark(label) {
            if (TZ_PERF) TZ_MARKS.push(Math.round(performance.now()) + '|' + label);
        }
        function tzFlush() {
            if (!TZ_PERF) return;
            try {
                var nav = performance.getEntriesByType('navigation')[0];
                if (nav) {
                    TZ_MARKS.unshift(Math.round(nav.responseEnd) + '|(page) html fetched');
                    TZ_MARKS.unshift(Math.round(nav.domInteractive) + '|(page) DOM interactive');
                }
                if (typeof window.__tzHead === 'number')
                    TZ_MARKS.unshift(window.__tzHead + '|(page) first script in <head> ran');
                if (typeof window.__tzBeforeMain === 'number')
                    TZ_MARKS.unshift(window.__tzBeforeMain + '|(page) styles+body parsed, before main script');
            } catch (e) {}
            TZ_MARKS.sort(function (a, b) { return parseInt(a) - parseInt(b); });
            for (var i = 0; i < TZ_MARKS.length; i++) postMsg('perf:' + TZ_MARKS[i]);
            TZ_MARKS = [];
        }
        tzMark('(page) top-level script begins');

        // --- CORE APPLICATION STATE ---
        let state = {
            mode: 'wysiwyg',
            revealOnFocus: false,
            focusMode: false,
            typewriterMode: false,
            margin: 'narrow',
            themeIndex: 0,
            lastSavedContent: '',
            currentFilePath: '',
            // Off until the host says otherwise: defaulting to true would write a copy of
            // the document to settings.json and localStorage during the startup window,
            // before the setting arrives.
            persistContent: false,
            blocks: [],

            // --- View selectors (Phase 3) ---
            // Canonical names, deliberately independent of the older internals:
            // state.mode still uses 'wysiwyg' for Preview, columns live on an editor CSS
            // class, and pagination lives in state.pageAdvance. viewMode/viewColumns/
            // viewScroll are the single truth the three segmented controls render from.
            viewMode: 'preview',        // 'source' | 'preview' | 'reader'
            viewColumns: 1,             // 1 | 2
            viewScroll: 'scroll'        // 'scroll' | 'pagination'
        };

        // Counts any listener still bound to an individual .block. Editing is routed
        // through #editor because only the editing host receives these events; anything
        // registered per block is unreachable, which is how several handlers came to be
        // silently dead. Stays at zero — the E2E asserts it.
        window.__tzBlockFire = { keydown: 0, input: 0 };

        const editor = document.getElementById('editor');
        const sourceEditor = document.getElementById('source-editor');
        const mainContainer = document.getElementById('main-container');
        const sidebar = document.getElementById('sidebar');
        const outlineList = document.getElementById('outline-list');

        let isRestoring = false;

        // Off unless the host says --debug was passed. The in-page ring buffer is always
        // kept (the test harnesses read it and it costs nothing), but nothing is sent to
        // the host or printed, so a normal run neither writes debug.log nor pays for the
        // IPC on every scroll and column probe.
        window.__tzDebugLog = false;
        window.showDebugTelemetry = function(msg) {
            window.__tzTelemetry = window.__tzTelemetry || [];
            window.__tzTelemetry.push(msg);
            if (window.__tzTelemetry.length > 500) window.__tzTelemetry.shift();
            if (!window.__tzDebugLog) return;
            console.log("TELEMETRY: " + msg);
            if (window.chrome && window.chrome.webview) {
                window.chrome.webview.postMessage("telemetry:" + msg);
            }
        };

        /**
         * Phase 3B: resolve the Mode / Column / Scroll selectors after a click.
         *
         * Pure function of (current state, one requested change) -> new state plus the
         * lock flags the shell greys out. No DOM, no side effects, so the whole rule set
         * is exhaustively testable -- see tests/view-state-selftest.mjs.
         *
         * The point is that no click can strand the user on a disabled control. Rather
         * than forbidding a combination and leaving a dead button, a click always
         * succeeds and drags the conflicting sub-selectors somewhere legal.
         *
         * Legal combinations (from the spec's matrix):
         *   Source   1-col scroll only
         *   Preview  1-col scroll | 1-col pagination | 2-col pagination
         *   Reader   1-col pagination | 2-col pagination
         *
         * Two of those fall out of a single invariant -- 2 columns needs a bottom
         * boundary to flow into, so 2-col implies pagination -- and Reader is pages only
         * by definition. Locks are therefore derived from the resulting state rather than
         * tracked separately, which is what stops them drifting out of step:
         *
         *   Source   both locked (nothing else is valid)
         *   Reader   scroll locked (pages only), columns free
         *   Preview  columns free; scroll locked exactly when 2 columns are showing
         *
         * @param {{mode:string,columns:number,scroll:string}} current
         * @param {{mode?:string,columns?:number,scroll?:string}} change  exactly one key
         */
        function resolveViewState(current, change) {
            let mode = (current && current.mode) || 'preview';
            let columns = (current && current.columns) === 2 ? 2 : 1;
            let scroll = (current && current.scroll) === 'pagination' ? 'pagination' : 'scroll';
            change = change || {};

            // What is locked right now decides whether a click is even allowed through.
            const wasLocked = viewLocksFor(mode, columns);
            if (change.columns !== undefined && wasLocked.columnsLocked) return viewStateOf(mode, columns, scroll);
            if (change.scroll !== undefined && wasLocked.scrollLocked) return viewStateOf(mode, columns, scroll);

            if (change.mode !== undefined) {
                mode = change.mode;
                // Rule A (Mode Master)
                if (mode === 'source') {
                    columns = 1;            // a textarea cannot flow into columns
                    scroll = 'scroll';      // paginating raw source fragments it
                } else if (mode === 'reader') {
                    scroll = 'pagination';  // Reader is pages only
                }
                // 'preview' forces nothing; it just unlocks, which the derivation handles.
            } else if (change.columns !== undefined) {
                columns = change.columns === 2 ? 2 : 1;
                // Rule B (Column Master): 2 columns need a fixed bottom to flow into.
                if (columns === 2) scroll = 'pagination';
            } else if (change.scroll !== undefined) {
                scroll = change.scroll === 'pagination' ? 'pagination' : 'scroll';
                // Rule C (Scroll Master): continuous scroll cannot carry 2 columns.
                if (scroll === 'scroll') columns = 1;
            }

            // Mode invariants win over whatever a sub-selector asked for. Reachable when
            // a column or scroll click happens while a mode still constrains it.
            if (mode === 'source') { columns = 1; scroll = 'scroll'; }
            else if (mode === 'reader') { scroll = 'pagination'; }

            return viewStateOf(mode, columns, scroll);
        }

        /** Locks implied by a (mode, columns) pair. Derived, never stored. */
        function viewLocksFor(mode, columns) {
            if (mode === 'source') return { columnsLocked: true, scrollLocked: true };
            if (mode === 'reader') return { columnsLocked: false, scrollLocked: true };
            return { columnsLocked: false, scrollLocked: columns === 2 };
        }

        function viewStateOf(mode, columns, scroll) {
            const locks = viewLocksFor(mode, columns);
            return {
                mode: mode,
                columns: columns,
                scroll: scroll,
                columnsLocked: locks.columnsLocked,
                scrollLocked: locks.scrollLocked
            };
        }

        /** state.mode uses 'wysiwyg' for what the UI calls Preview. */
        function viewModeFromInternal(m) { return m === 'wysiwyg' ? 'preview' : (m || 'preview'); }
        function internalModeFromView(v) { return v === 'preview' ? 'wysiwyg' : v; }

        /** Current selector state, read back from the live editor rather than assumed. */
        function currentViewState() {
            const twoCol = !!(editor && editor.classList.contains('two-col-layout'));
            return viewStateOf(
                viewModeFromInternal(state.mode),
                twoCol ? 2 : 1,
                state.pageAdvance ? 'pagination' : 'scroll'
            );
        }

        /**
         * Apply a resolved view state to the editor and report it to the host.
         *
         * Mode changes go through toggle_mode rather than setting state.mode directly:
         * that path already captures and restores the sticky document line, flushes blocks
         * to data-raw before serialising to Source, and keeps the undo stack aligned.
         * Duplicating any of that here is how the two would drift apart. The cycle is
         * wysiwyg -> reader -> source, so at most two steps are ever needed.
         */
        function applyViewState(next) {
            _applyingViewState = true;
            try {
                const targetInternal = internalModeFromView(next.mode);
                for (let i = 0; i < 3 && state.mode !== targetInternal; i++) {
                    handleCommand('toggle_mode');
                }

                const twoColNow = !!(editor && editor.classList.contains('two-col-layout'));
                if ((next.columns === 2) !== twoColNow) {
                    handleCommand('set_column_mode:' + next.columns);
                }

                const wantAdvance = next.scroll === 'pagination';
                if (!!state.pageAdvance !== wantAdvance) {
                    state.pageAdvance = wantAdvance;
                    postMsg('sync_page_advance:' + (wantAdvance ? '1' : '0'));
                }
                // Pagination is a layout, so the class has to follow the state however the
                // state was reached. Setting the flag alone left 2-Column in Preview with
                // no page-mode class, and therefore no columns at all.
                syncPaginationClass();
                applyEditorChromeForMode();
            } finally {
                _applyingViewState = false;
            }

            state.viewMode = next.mode;
            state.viewColumns = next.columns;
            state.viewScroll = next.scroll;
            postViewState(next);
            scheduleSavePreferences();
        }

        /**
         * Push the resolved state so the shell can render the selectors.
         *
         * Suppressed while applyViewState is mid-flight: it drives the change through
         * toggle_mode / set_column_mode, each of which reports on its own, so the shell
         * would otherwise see half-applied states (columns already 2, pagination not yet
         * on) and paint them. applyViewState posts once at the end, when it is coherent.
         */
        let _applyingViewState = false;
        function postViewState(s) {
            if (_applyingViewState) return;
            postMsg('view_state:' + s.mode + ',' + s.columns + ',' + s.scroll + ',' +
                (s.columnsLocked ? '1' : '0') + ',' + (s.scrollLocked ? '1' : '0'));
        }

        /** Defaults for a freshly opened document in each mode (spec: Initial State). */
        function defaultViewStateFor(mode) {
            if (mode === 'source') return viewStateOf('source', 1, 'scroll');
            if (mode === 'reader') return viewStateOf('reader', 1, 'pagination');
            return viewStateOf('preview', 1, 'scroll');
        }

        function getPageMarginPads() {
            // Real page margins (side padding), not max-width / line-length tricks.
            const m = state.margin || 'narrow';
            if (m === 'narrow') return { top: 0, right: 16, bottom: 0, left: 16 };
            if (m === 'wide') return { top: 0, right: 160, bottom: 0, left: 160 };
            return { top: 0, right: 64, bottom: 0, left: 64 };
        }

        /**
         * Layout chrome so Source and Preview put the vertical scrollbar in the same place
         * (far right of #main-container). Preview scrolls #main-container; Source scrolls
         * the textarea — so we zero the wrapper's right padding in Source and pad the
         * textarea text instead, leaving the scrollbar track at the pane edge.
         */
        function applyEditorChromeForMode() {
            const wrapper = document.getElementById('editor-wrapper');
            if (!wrapper) return;
            wrapper.style.maxWidth = 'none';
            wrapper.style.width = '100%';
            wrapper.style.margin = '0';
            wrapper.style.boxSizing = 'border-box';
            const p = getPageMarginPads();
            
            let isTwoCol = isPaginatedLayout();
            
            if (state.mode === 'source') {
                // Right pad 0 → scrollbar of #source-editor sits on the pane edge (like Preview).
                wrapper.style.padding = '0 0 0 ' + p.left + 'px';
                if (mainContainer) {
                    mainContainer.style.overflowY = 'hidden'; // one scrollbar only (textarea)
                    mainContainer.style.overflowX = 'hidden';
                }
                if (sourceEditor) {
                    sourceEditor.style.paddingTop = '0px';
                    sourceEditor.style.paddingBottom = '0px';
                    sourceEditor.style.paddingLeft = '0px';
                    sourceEditor.style.paddingRight = p.right + 'px';
                    sourceEditor.style.boxSizing = 'border-box';
                }
            } else {
                wrapper.style.padding = '0 ' + p.right + 'px 0 ' + p.left + 'px';
                
                if (isTwoCol) {
                    editor.style.height = `100vh`;
                } else {
                    editor.style.height = '';
                }
                
                if (mainContainer) {
                    mainContainer.style.overflowY = isTwoCol ? 'hidden' : 'auto';
                    mainContainer.style.overflowX = '';
                }
                
                if (sourceEditor) {
                    sourceEditor.style.paddingTop = '';
                    sourceEditor.style.paddingBottom = '';
                    sourceEditor.style.paddingLeft = '';
                    sourceEditor.style.paddingRight = '';
                }
            }
        }

        function setMargin(marginType) {
            state.margin = marginType || 'narrow';
            if (state.margin !== 'regular' && state.margin !== 'wide') state.margin = 'narrow';
            applyEditorChromeForMode();
            postMsg("margin_changed:" + state.margin);
            scheduleSavePreferences();
            if (state.mode === 'source') resizeSourceEditor();
        }

        function countHardLines(text) {
            text = String(text == null ? '' : text);
            if (!text.length) return 1;
            let n = 1;
            for (let i = 0; i < text.length; i++) {
                if (text.charCodeAt(i) === 10) n++;
            }
            return n;
        }

        function getSourceLineHeight() {
            try {
                const cs = window.getComputedStyle(sourceEditor);
                const fs = parseFloat(cs.fontSize) || 16;
                const parsedLh = parseFloat(cs.lineHeight);
                if (parsedLh && !isNaN(parsedLh) && parsedLh >= fs * 0.9) return parsedLh;
                return fs * 1.6;
            } catch (e) {
                return 22;
            }
        }

        function clampMainScroll() {
            if (!mainContainer) return;
            try {
                const max = Math.max(0, mainContainer.scrollHeight - mainContainer.clientHeight);
                if (mainContainer.scrollTop > max) mainContainer.scrollTop = max;
                if (mainContainer.scrollTop < 0) mainContainer.scrollTop = 0;
            } catch (e) {}
        }

        /**
         * Source uses a viewport-tall textarea with overflow:auto.
         * Browser clamps scroll to real content (never past EOF). Scrollbar is aligned to
         * the pane's right edge via applyEditorChromeForMode() (not inset by page margins).
         */
        function resizeSourceEditor() {
            if (!sourceEditor || sourceEditor.style.display === 'none') return;
            applyEditorChromeForMode();
            const container = (typeof mainContainer !== 'undefined' && mainContainer)
                ? mainContainer
                : document.getElementById('main-container');
            let viewH = 0;
            try {
                viewH = container ? container.clientHeight : 0;
            } catch (e) { viewH = 0; }
            if (viewH < 120) viewH = Math.max(320, Math.floor(window.innerHeight * 0.7));

            let topPad = 40;
            try {
                const wrap = document.getElementById('editor-wrapper');
                if (wrap) {
                    const cs = window.getComputedStyle(wrap);
                    topPad = parseFloat(cs.paddingTop) || 40;
                }
            } catch (e2) {}
            // Fill remaining height inside wrapper (scrollbar stays in-pane, not off-screen).
            const h = Math.max(120, viewH - topPad - 8);
            sourceEditor.style.height = h + 'px';
            sourceEditor.style.maxHeight = h + 'px';
            sourceEditor.style.width = '100%';
            sourceEditor.style.overflowY = 'auto';
            sourceEditor.style.overflowX = document.body.classList.contains('nowrap') ? 'auto' : 'hidden';
            try {
                if (mainContainer) mainContainer.scrollTop = 0;
            } catch (e3) {}
            clampMainScroll();
        }

        /** Char offset of the start of 1-based hard line in source text. */
        function sourceOffsetAtHardLine(text, hardLine1Based) {
            text = String(text == null ? '' : text);
            let line = Math.max(1, hardLine1Based | 0);
            let pos = 0;
            let ln = 1;
            while (pos < text.length && ln < line) {
                if (text.charCodeAt(pos) === 10) ln++;
                pos++;
            }
            return pos;
        }

        /**
         * Scroll the source textarea to a 1-based hard line.
         * Map hard-line index → fraction of real scrollHeight (word-wrap safe).
         * (line-1)*lineHeight was wrong: last hard line landed ~halfway down wrapped text.
         */
        function scrollSourceToHardLine(hardLine1Based, takeFocus) {
            if (!sourceEditor) return;
            const text = sourceEditor.value || '';
            const total = countHardLines(text);
            let line = Math.max(1, Math.min(total, hardLine1Based | 0));
            const pos = sourceOffsetAtHardLine(text, line);
            try {
                if (takeFocus) sourceEditor.focus();
                sourceEditor.setSelectionRange(pos, pos);
            } catch (e) {}
            function applyScroll() {
                try {
                    const max = Math.max(0, sourceEditor.scrollHeight - sourceEditor.clientHeight);
                    if (total <= 1 || max <= 0 || line <= 1) {
                        sourceEditor.scrollTop = 0;
                    } else if (line >= total) {
                        sourceEditor.scrollTop = max; // true EOF — never past
                    } else {
                        const t = (line - 1) / (total - 1);
                        sourceEditor.scrollTop = Math.round(max * t);
                    }
                } catch (e2) {}
                try {
                    if (mainContainer) mainContainer.scrollTop = 0;
                } catch (e3) {}
            }
            applyScroll();
            // Focus can restore a stale scrollTop; re-apply next frame.
            try { requestAnimationFrame(applyScroll); } catch (e4) { setTimeout(applyScroll, 0); }
        }

        /**
         * Invert scrollSourceToHardLine's proportional map: scrollTop → hard line.
         * Used for mode-switch stickiness when the user scrolled without moving the caret
         * (caret/status can lag far behind what's on screen).
         */
        function hardLineFromSourceScrollTop() {
            if (!sourceEditor) return 1;
            try {
                const text = sourceEditor.value || '';
                const total = countHardLines(text);
                const max = Math.max(0, sourceEditor.scrollHeight - sourceEditor.clientHeight);
                const st = sourceEditor.scrollTop || 0;
                if (total <= 1 || max <= 0) return 1;
                if (st <= 2) return 1;
                if (st >= max - 2) return total;
                const t = st / max;
                return Math.max(1, Math.min(total, Math.round(1 + t * (total - 1))));
            } catch (e) {
                return 1;
            }
        }

        /**
         * Source → Preview stickiness: use the line at the Source viewport, not only caret.
         * Scrolling the textarea without clicking leaves selectionStart far from the view;
         * mode switch must follow what is on screen.
         */
        function captureSourceStickyLineForModeSwitch() {
            const viewLine = hardLineFromSourceScrollTop();
            let caretLine = Math.max(1, _stickyLineCache | 0, _lastCaretLine | 0);
            try {
                if (sourceEditor && document.activeElement === sourceEditor) {
                    const live = lineFromMarkdownOffset(
                        sourceEditor.value || '', sourceEditor.selectionStart | 0);
                    // Ignore poisoned selectionStart=0 after chrome focus-steal
                    if (!(live <= 1 && caretLine > 1 && (sourceEditor.selectionStart | 0) === 0)) {
                        caretLine = live;
                    }
                }
            } catch (e) {}
            // Viewport wins when it disagrees with caret (user scrolled without clicking).
            const chosen = (Math.abs(viewLine - caretLine) > 12) ? viewLine : caretLine;
            rememberStickyLine(chosen);
            return chosen;
        }

        // --- DOCUMENT FIND (editor + source only; never sidebar/outline/chrome) ---
        const findState = {
            query: '',
            matches: [], // { start, end } char offsets in search haystack
            index: -1,
            ranges: [],
            /** 'source' | 'visual' (full DOM) | 'model' (virt: full DocumentModel markdown) */
            kind: 'visual'
        };

        function isFindBarOpen() {
            const bar = document.getElementById('findBar');
            return !!(bar && bar.classList.contains('open'));
        }

        function focusFindInput(selectAll) {
            const input = document.getElementById('findInput');
            if (!input || !isFindBarOpen()) return false;
            const attempt = () => {
                try {
                    input.focus({ preventScroll: true });
                } catch (e) {
                    try { input.focus(); } catch (e2) {}
                }
                if (selectAll) {
                    try { input.select(); } catch (e3) {}
                }
                return document.activeElement === input;
            };
            if (attempt()) return true;
            // Host/WebView often steals focus on the same turn as Ctrl+F — retry
            requestAnimationFrame(() => {
                if (attempt()) return;
                setTimeout(attempt, 0);
                setTimeout(attempt, 40);
                setTimeout(attempt, 120);
            });
            return document.activeElement === input;
        }

        function openFindBar(prefill, focusReplace) {
            const bar = document.getElementById('findBar');
            const input = document.getElementById('findInput');
            const replaceInput = document.getElementById('replaceInput');
            if (!bar || !input) return;
            bar.classList.add('open');
            if (prefill != null && prefill !== '') input.value = prefill;
            else if (!input.value) {
                try {
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed && sel.toString().trim()) {
                        input.value = sel.toString().trim().slice(0, 200);
                    } else if (state.mode === 'source' && sourceEditor) {
                        const a = sourceEditor.selectionStart, b = sourceEditor.selectionEnd;
                        if (b > a) input.value = sourceEditor.value.substring(a, b).slice(0, 200);
                    }
                } catch (e) {}
            }
            runFind(input.value, false, { navigate: false });
            if (focusReplace && replaceInput) {
                requestAnimationFrame(() => {
                    try { replaceInput.focus(); replaceInput.select(); } catch (e) {}
                });
            } else {
                focusFindInput(true);
            }
        }

        function closeFindBar() {
            const bar = document.getElementById('findBar');
            if (bar) bar.classList.remove('open');
            clearFindHighlights();
            findState.query = '';
            findState.matches = [];
            findState.ranges = [];
            findState.index = -1;
            updateFindCount();
        }

        function clearFindHighlights() {
            try {
                if (CSS && CSS.highlights) {
                    CSS.highlights.delete('typozen-find');
                    CSS.highlights.delete('typozen-find-current');
                }
            } catch (e) {}
        }

        function updateFindCount() {
            const el = document.getElementById('findCount');
            if (!el) return;
            const n = findState.matches.length;
            if (!findState.query || n === 0) {
                el.textContent = findState.query ? '0/0' : '0/0';
                updateSearchSidebar();
                return;
            }
            el.textContent = (findState.index + 1) + '/' + n;
            updateSearchSidebar();
        }

        window.findJumpTo = function(index) {
            if (!findState.matches.length || index < 0 || index >= findState.matches.length) return;
            findState.index = index;
            if (state.mode === 'source' || findState.kind === 'source') {
                const m = findState.matches[findState.index];
                scrollSourceMatchIntoView(m.start, m.end, true);
            } else if (findState.kind === 'model') {
                revealModelMatch(findState.matches[findState.index], true);
            } else {
                const surface = getFindHaystack();
                findState.ranges = rangesFromWysiwygMatches(findState.matches, surface.map);
                applyWysiwygHighlights();
                const r = findState.ranges[findState.index];
                if (r) {
                    scrollRangeIntoMain(r);
                    try {
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(r.cloneRange());
                    } catch (e) {}
                }
            }
            updateFindCount();
            focusFindInput(false);
        };

        function updateSearchSidebar() {
            const list = document.getElementById('search-results-list');
            if (!list) return;
            // Listeners live on the containers, so they survive the innerHTML rewrites below.
            wireSearchResultKeys();
            wireSidebarSearch();
            updateSidebarSearchCount();
            if (!findState.query || findState.matches.length === 0) {
                list.innerHTML = '<div class="search-item" style="opacity:0.5;">No results...</div>';
                return;
            }
            let html = '';
            const haystack = getFindHaystack().haystack;
            const qLen = findState.query.length;
            const limit = Math.min(findState.matches.length, 150);

            const offsets = [];
            for (let i = 0; i < limit; i++) {
                const m = findState.matches[i];
                offsets.push(typeof m === 'number' ? m : m.start);
            }
            const lines = lineNumbersForOffsets(haystack, offsets);

            for (let i = 0; i < limit; i++) {
                const idx = offsets[i];

                // Show the line the match sits on, starting at the line, the way ZenSeek
                // does. The old window of +/-20 chars around the match started mid-word
                // behind a leading ellipsis, which threw away most of the context the row
                // had space for and made every result look alike.
                const b = lineBoundsAt(haystack, idx);
                let start = b.start;
                let leading = '';
                // Long line with the match far along it: keep the match visible.
                if (idx - b.start > 48) { start = idx - 24; leading = '…'; }
                const end = Math.min(b.end, start + 160);

                const before = haystack.substring(start, idx);
                const hit = haystack.substring(idx, Math.min(idx + qLen, b.end));
                const after = haystack.substring(idx + qLen, end);
                const trailing = end < b.end ? '…' : '';

                const snippet = escapeHtml(leading + before) +
                    '<strong>' + escapeHtml(hit) + '</strong>' +
                    escapeHtml(after + trailing);

                const active = (i === findState.index) ? ' active' : '';
                html += '<div class="search-item' + active + '" onclick="window.findJumpTo(' + i + ')"' +
                    ' title="Line ' + lines[i] + ' — match ' + (i + 1) + ' of ' + findState.matches.length + '">' +
                    '<span class="search-line">' + lines[i] + '</span>' +
                    '<span class="search-text">' + snippet + '</span></div>';
            }
            if (findState.matches.length > limit) {
                html += `<div class="search-item" style="opacity:0.5; text-align:center;">+${findState.matches.length - limit} more...</div>`;
            }
            list.innerHTML = html;
            
            // Scroll active item into view
            const activeEl = list.querySelector('.active');
            if (activeEl) {
                activeEl.scrollIntoView({ block: 'nearest' });
            }
        }

        // How long the sidebar search box waits after the last keystroke before handing
        // focus to the results. Typing must not be interrupted, but a user who stops
        // should get the navigation keys without reaching for Enter or the mouse.
        const SIDEBAR_SEARCH_IDLE_MS = 3000;
        const SIDEBAR_SEARCH_DEBOUNCE_MS = 200;
        let _sidebarSearchDebounce = null;
        let _sidebarSearchIdle = null;

        function focusSearchResults() {
            const list = document.getElementById('search-results-list');
            if (!list) return;
            if (!findState.matches.length) return; // nothing to step through; stay in the box
            try { list.focus({ preventScroll: true }); } catch (e) { list.focus(); }
        }

        function focusSidebarSearchInput(selectAll) {
            const input = document.getElementById('sidebarSearchInput');
            if (!input) return;
            const grab = () => {
                try {
                    input.focus({ preventScroll: true });
                    if (selectAll) input.select();
                } catch (e) { try { input.focus(); } catch (e2) {} }
            };
            grab();

            // Alt+S arrives as an Alt chord, and WPF activates menu mode on the Alt key
            // *up* -- after this handler has already run. That pulls keyboard focus out of
            // the WebView and onto the menu bar, so everything typed next went to the menu
            // instead of the search box. preventDefault() in the page cannot stop it: the
            // WebView's HWND belongs to the browser process and the host window handles
            // Alt itself.
            //
            // So ask the host to hand focus back to the WebView, then re-assert the input
            // over the next few frames. Each retry bails the moment the box already has
            // focus, and stops outright if the user has moved to another field, so this
            // never fights a deliberate click.
            postMsg('focus_webview');
            let tries = 0;
            const reassert = () => {
                if (++tries > 6) return;
                const active = document.activeElement;
                if (active === input) return; // won

                // Only reclaim from the places a steal actually lands: nothing focused, the
                // body, or the document surfaces. Anything else -- the results list, the
                // find bar, another sidebar control -- means the user went there on
                // purpose, so leave it alone rather than yanking focus back.
                const stolenToDocument = !active
                    || active === document.body
                    || active === document.documentElement
                    || active === editor
                    || active === sourceEditor
                    || (editor && editor.contains(active));
                if (!stolenToDocument) return;

                grab();
                setTimeout(reassert, 40);
            };
            requestAnimationFrame(() => setTimeout(reassert, 0));
        }

        function cancelSidebarSearchIdle() {
            if (_sidebarSearchIdle) { clearTimeout(_sidebarSearchIdle); _sidebarSearchIdle = null; }
        }

        function armSidebarSearchIdle() {
            cancelSidebarSearchIdle();
            _sidebarSearchIdle = setTimeout(() => {
                _sidebarSearchIdle = null;
                const input = document.getElementById('sidebarSearchInput');
                // Only steal focus if the user is still sitting in the search box.
                if (!input || document.activeElement !== input) return;
                focusSearchResults();
            }, SIDEBAR_SEARCH_IDLE_MS);
        }

        /** Update the "3/17" counter beside the sidebar search box. */
        function updateSidebarSearchCount() {
            const el = document.getElementById('sidebarSearchCount');
            if (!el) return;
            const n = findState.matches.length;
            el.textContent = (n === 0 ? 0 : findState.index + 1) + '/' + n;
        }

        /**
         * The Search pane's own query box.
         *
         * Kept separate from the Ctrl+F find bar on purpose. The navigation keys , . < >
         * are ordinary printable characters, so while a text field holds focus they can
         * only ever be typed. Focus therefore has to move off the input and onto the
         * results list before they can mean prev/next -- Enter does that immediately, and
         * so does SIDEBAR_SEARCH_IDLE_MS of no typing.
         */
        function wireSidebarSearch() {
            const input = document.getElementById('sidebarSearchInput');
            if (!input || input.__tzWired) return;
            input.__tzWired = true;

            input.addEventListener('input', () => {
                if (_sidebarSearchDebounce) clearTimeout(_sidebarSearchDebounce);
                _sidebarSearchDebounce = setTimeout(() => {
                    _sidebarSearchDebounce = null;
                    runFind(input.value, false, { navigate: false });
                    updateSidebarSearchCount();
                }, SIDEBAR_SEARCH_DEBOUNCE_MS);
                armSidebarSearchIdle();
            });

            input.addEventListener('keydown', (e) => {
                // The editor's global shortcut handlers must not see ordinary typing here.
                e.stopPropagation();
                if (e.key === 'Enter') {
                    e.preventDefault();
                    cancelSidebarSearchIdle();
                    if (_sidebarSearchDebounce) { clearTimeout(_sidebarSearchDebounce); _sidebarSearchDebounce = null; }
                    // Run synchronously so Enter acts on what is on screen, then jump to
                    // the first match and hand the navigation keys to the results.
                    runFind(input.value, false, { navigate: true });
                    updateSidebarSearchCount();
                    focusSearchResults();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    cancelSidebarSearchIdle();
                    focusSearchResults();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelSidebarSearchIdle();
                    input.value = '';
                    runFind('', false, { navigate: false });
                    updateSidebarSearchCount();
                }
            });

            // Typing again after focus moved away should not fight the idle timer.
            input.addEventListener('blur', cancelSidebarSearchIdle);
        }

        /**
         * Keyboard navigation for the search results list.
         *
         * With focus anywhere inside the results, , and . step prev/next through matches,
         * as do < and > (the same physical keys with Shift, so it works whether or not the
         * user is holding it). Arrow keys and Enter are supported too, since a focused
         * listbox is expected to answer them.
         *
         * findStep() already moves findState.index, highlights, scrolls the match into
         * view and re-renders this list with the new .active item, so this only routes.
         */
        function wireSearchResultKeys() {
            const list = document.getElementById('search-results-list');
            if (!list || list.__tzKeysWired) return;
            list.__tzKeysWired = true;
            list.addEventListener('keydown', (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                let dir = 0;
                if (e.key === ',' || e.key === '<' || e.key === 'ArrowUp') dir = -1;
                else if (e.key === '.' || e.key === '>' || e.key === 'ArrowDown') dir = 1;
                else if (e.key === 'Enter') {
                    // Re-reveal the current match without moving, so Enter confirms.
                    if (findState.matches.length) window.findJumpTo(findState.index);
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                else if (e.key === 'Escape') {
                    // Back to the query box to refine the search.
                    focusSidebarSearchInput(true);
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                else if (e.key.length === 1) {
                    // Any other printable key means the user wants to type a new query;
                    // send it to the search box rather than dropping it on the floor.
                    const input = document.getElementById('sidebarSearchInput');
                    if (input) {
                        focusSidebarSearchInput(false);
                        input.value = e.key;
                        runFind(input.value, false, { navigate: false });
                        updateSidebarSearchCount();
                        armSidebarSearchIdle();
                        e.preventDefault();
                        e.stopPropagation();
                    }
                    return;
                }
                if (!dir) return;
                e.preventDefault();
                e.stopPropagation();
                if (!findState.matches.length) return;
                findStep(dir);
                updateSidebarSearchCount();
                // findStep moves focus to the match in the document; keep it here so a
                // run of , or . keeps stepping instead of typing into the editor.
                try { list.focus({ preventScroll: true }); } catch (err) { list.focus(); }
            });
        }

        /**
         * --- Two-column paging geometry ---
         *
         * A "page" is one screenful: both visible columns plus the gap after them, which is
         * exactly how far scrollLeft moves to turn a page.
         *
         * These read the layout Chromium produced rather than trying to predict it. The
         * previous version walked the blocks accumulating offsetHeight and incremented a
         * column counter whenever the running total passed the column height, then derived
         * the page from that. It is a reimplementation of the browser's column breaker, and
         * it disagreed with the real thing as soon as margin collapsing, blockquote spacing
         * or a heading's break behaviour came into play. The error accumulated over the
         * document, so paging away and back landed pages earlier than it started -- exactly
         * what "go to pages 5 and 6, switch to 1-Col, switch back, arrive at 3 and 4" is.
         *
         * The single-column path never had this problem because it always used real rects.
         *
         * Safe to measure because virtualisation is off in 2-column mode
         * (DocumentModel.shouldVirtualize returns false for .two-col-layout), so every
         * block is mounted and has a real position in the column flow.
         */
        /**
         * Is the document laid out as pages right now?
         *
         * This, not .two-col-layout, is what the paging machinery keys off. Both 1- and
         * 2-column pagination are the same CSS multi-column layout scrolled horizontally;
         * the column count only decides how much fits on a page.
         */
        function isPaginatedLayout() {
            return !!(editor && editor.classList.contains('page-mode'));
        }

        /**
         * Page numbers in the bottom-right of each page, as a book has.
         *
         * Read straight from the page map, so they are a check on it rather than
         * decoration: if the numbering skips, repeats, or disagrees with what a page turn
         * does, the map is wrong and it shows immediately.
         *
         * A 2-column page is a spread, so it carries two numbers, one under each column.
         */
        function updatePageIndicator() {
            const host = document.getElementById('page-indicator');
            if (!host) return;
            // Shown wherever the document is actually paginated, not only in Reader.
            // Preview + Pagination is a real paginated view, and hiding the numbers there
            // meant the one mode being tested was the one with no way to see the page state.
            if (!isPaginatedLayout() || !PageMap.ensure()) {
                host.style.display = 'none';
                return;
            }
            const spread = PageMap.current();
            const spreads = PageMap.pages.length;
            const twoCol = editor.classList.contains('two-col-layout');
            const total = twoCol ? spreads * 2 : spreads;
            host.style.display = 'flex';
            host.classList.toggle('two-up', twoCol);
            if (twoCol) {
                const left = spread * 2 + 1;
                host.innerHTML =
                    '<span class="page-num">' + left + '</span>' +
                    '<span class="page-num">' + Math.min(left + 1, total) + '</span>';
            } else {
                host.innerHTML = '<span class="page-num">' + (spread + 1) + ' / ' + total + '</span>';
            }
        }

        /** Put the editor into or out of page layout to match the current view state. */
        function syncPaginationClass() {
            if (!editor) return;
            const on = !!state.pageAdvance && state.mode !== 'source';
            const was = editor.classList.contains('page-mode');
            if (on === was) return;
            editor.classList.toggle('page-mode', on);
            PageMap.invalidate();
            if (!on) { editor.scrollLeft = 0; currentTwoColPage = 0; }

            // Pagination and virtualisation are incompatible: the browser can only break
            // content into pages it has actually laid out, so a mounted window of blocks
            // yields a handful of pages for a whole book. shouldVirtualize() already
            // refuses in page mode, but that is only consulted on a (re)mount -- without
            // forcing one here the document stays virtualised and 4582 lines reported 3
            // pages. This is the cost the page model buys: full layout while paginated.
            try {
                if (typeof DocumentModel === 'undefined') return;
                const shouldVirt = DocumentModel.shouldVirtualize();
                if (DocumentModel.virtEnabled === shouldVirt) return;
                const wasRestoring = (typeof HistoryManager !== 'undefined') ? HistoryManager.isRestoring : false;
                if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = true;
                const line = (typeof _stickyLineCache !== 'undefined' && _stickyLineCache) ? _stickyLineCache : 1;
                const md = DocumentModel.toMarkdown();
                loadMarkdownContent(md, { deferPaint: true, stickyLine: line });
                if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = wasRestoring;
            } catch (e) {
                window.showDebugTelemetry('syncPaginationClass: remount failed ' + e.message);
            }
        }

        function twoColGap() {
            try {
                const g = parseFloat(getComputedStyle(editor).columnGap);
                if (isFinite(g)) return g;
            } catch (e) {}
            return 60; // matches column-gap in css/typozen.css
        }

        function twoColPageWidth() {
            return Math.max(1, (editor ? editor.clientWidth : 0) + twoColGap());
        }

        /** The mounted .block element for a model index, or null. */
        function elementForModelIndex(bi) {
            if (!editor) return null;
            const blocks = editor.querySelectorAll('.block');
            for (let i = 0; i < blocks.length; i++) {
                if (DocumentModel.modelIndexOfEl(blocks[i]) === bi) return blocks[i];
            }
            return null;
        }

        /**
         * Which page an element sits on, from its measured x in the column flow.
         * Returns null when the element is not laid out.
         */
        function twoColPageOfElement(el) {
            if (!el || !editor) return null;
            try {
                const r = el.getBoundingClientRect();
                if (!r || (r.width === 0 && r.height === 0)) return null;
                const edRect = editor.getBoundingClientRect();
                // Position within the scrollable column flow, independent of where it is
                // scrolled to right now.
                const absX = (r.left - edRect.left) + (editor.scrollLeft || 0);
                // +1 absorbs sub-pixel rounding on a block that starts exactly on a page
                // boundary, which would otherwise floor to the previous page.
                return Math.max(0, Math.floor((absX + 1) / twoColPageWidth()));
            } catch (e) {
                return null;
            }
        }

        /**
         * Model index of the block a reader would start on: topmost block of the leftmost
         * visible column. Blocks scrolled onto another page are excluded horizontally, so
         * this answers for the page actually on screen.
         */
        function topLeftModelIndexTwoCol() {
            if (!editor) return -1;
            const host = editor.getBoundingClientRect();
            const blocks = editor.querySelectorAll('.block');
            let best = null;
            for (let i = 0; i < blocks.length; i++) {
                const r = blocks[i].getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) continue;   // above/below
                if (r.right <= host.left + 1 || r.left >= host.right - 1) continue;   // another page
                const mi = DocumentModel.modelIndexOfEl(blocks[i]);
                if (mi < 0) continue;
                if (best === null || r.left < best.left - 1 ||
                    (Math.abs(r.left - best.left) <= 1 && r.top < best.top)) {
                    best = { mi: mi, left: r.left, top: r.top };
                }
            }
            return best ? best.mi : -1;
        }

        /**
         * Re-check the page after the column layout has settled, and correct it.
         *
         * Entering 2-column on a long document turns virtualisation off, which remounts
         * every block through loadMarkdownContent. The synchronous seed/snap inside
         * ensureModelBlockVisible therefore measures a layout that is still changing: it
         * converges on a self-consistent answer, but against stale geometry, landing a page
         * or two early. Re-measuring across a few frames catches that; each pass is a no-op
         * once the answer stops moving.
         */
        /**
         * === PAGE MAP ===
         *
         * Pagination needs a model of where pages begin. Without one there is nothing to
         * navigate to, and every operation degrades into nudging the scroll offset and
         * hoping: 1-column "page down" was scrollBy(window.innerHeight * 0.9) with smooth
         * behaviour, so pages were never aligned to anything, the offset drifted a little
         * further on every press, and going back stuttered because there was no boundary to
         * return to. 2-column paging inferred its page from scrollLeft, which is a
         * reasonable guess but still not a model.
         *
         * So: lay the content out once, find every break, and store page -> position.
         * Navigation then sets a known offset instead of accumulating deltas, and switching
         * columns is "which page holds this block in the other layout", answered by lookup
         * rather than by re-measuring on a timer.
         *
         * Two layouts, two ways to find the breaks:
         *
         *   1-column  walk DocumentModel's height map and break when the next block would
         *             cross the bottom of the viewport. Blocks are never split across a
         *             page. Uses the same heights virtualisation scrolls by, so the map and
         *             the scrollbar always agree.
         *   2-column  Chromium already broke the content into columns; read back where each
         *             block landed and group columns into pages, two per page.
         *
         * Built on demand and thrown away whenever anything that affects layout changes.
         */
        const PageMap = {
            valid: false,
            layout: null,      // '1col' | '2col'
            pages: [],         // [{ block, offset }] -- offset is scrollTop or scrollLeft
            viewportKey: '',

            /** Identity of the current layout; if this changes the map is stale. */
            _key: function () {
                const paged = isPaginatedLayout();
                const cols = (editor && editor.classList.contains('two-col-layout')) ? 2 : 1;
                const w = paged ? (editor.clientWidth || 0) : (mainContainer ? mainContainer.clientWidth : 0);
                const h = paged ? (editor.clientHeight || 0) : (mainContainer ? mainContainer.clientHeight : 0);
                const n = (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
                    ? DocumentModel.blocks.length : 0;
                return (paged ? 'p' : 's') + cols + ':' + w + 'x' + h + ':' + n;
            },

            invalidate: function () { this.valid = false; this.pages = []; },

            ensure: function () {
                if (!isPaginatedLayout()) { this.valid = false; this.pages = []; this.layout = 'scroll'; return false; }
                const key = this._key();
                if (this.valid && this.viewportKey === key) return this.pages.length > 0;
                this.viewportKey = key;
                this.layout = (editor.classList.contains('two-col-layout')) ? '2col' : '1col';
                this.pages = this._buildPaginated();
                this.valid = this.pages.length > 0;
                window.showDebugTelemetry('PageMap: built ' + this.layout + ' with ' + this.pages.length + ' pages');
                return this.valid;
            },

            /**
             * Read back where the browser actually broke the content.
             *
             * One implementation for both layouts, because both are the same multi-column
             * flow. There is deliberately no height-estimate path any more: the previous
             * 1-column map was computed from DocumentModel's estimated heights, so its
             * offsets agreed with the scrollbar but not with where blocks really rendered,
             * and driving a mode switch from it put the reader ~130 blocks out.
             */
            _buildPaginated: function () {
                if (!editor || typeof DocumentModel === 'undefined') return [];
                const pw = twoColPageWidth();
                const blocks = editor.querySelectorAll('.block');
                if (!blocks.length) return [];
                const edRect = editor.getBoundingClientRect();
                const scrollLeft = editor.scrollLeft || 0;
                const firstOfPage = {};
                for (let i = 0; i < blocks.length; i++) {
                    const r = blocks[i].getBoundingClientRect();
                    if (r.width === 0 && r.height === 0) continue;
                    const absX = (r.left - edRect.left) + scrollLeft;
                    const p = Math.max(0, Math.floor((absX + 1) / pw));
                    const mi = DocumentModel.modelIndexOfEl(blocks[i]);
                    if (mi < 0) continue;
                    if (firstOfPage[p] === undefined || mi < firstOfPage[p]) firstOfPage[p] = mi;
                }
                const nums = Object.keys(firstOfPage).map(Number).sort((a, b) => a - b);
                if (!nums.length) return [];
                const pages = [];
                for (let i = 0; i < nums.length; i++) {
                    pages.push({ block: firstOfPage[nums[i]], offset: nums[i] * pw });
                }
                return pages;
            },

            count: function () { return this.ensure() ? this.pages.length : 0; },

            /** Page currently on screen. Always a horizontal offset now. */
            current: function () {
                if (!this.ensure()) return 0;
                const pos = editor.scrollLeft || 0;
                let best = 0;
                for (let i = 0; i < this.pages.length; i++) {
                    if (this.pages[i].offset <= pos + 2) best = i; else break;
                }
                return best;
            },

            /** Page holding a given model block. */
            pageOfBlock: function (bi) {
                if (!this.ensure()) return 0;
                let best = 0;
                for (let i = 0; i < this.pages.length; i++) {
                    if (this.pages[i].block <= bi) best = i; else break;
                }
                return best;
            },

            blockOfPage: function (n) {
                if (!this.ensure()) return 0;
                n = Math.max(0, Math.min(this.pages.length - 1, n | 0));
                return this.pages[n].block;
            },

            /** Jump to a page. Absolute offset, so repeated turns cannot drift. */
            goto: function (n) {
                if (!this.ensure()) return false;
                n = Math.max(0, Math.min(this.pages.length - 1, n | 0));
                const p = this.pages[n];
                markProgrammaticScroll(400);
                editor.scrollTop = 0;             // columns never scroll vertically
                editor.scrollLeft = p.offset;
                currentTwoColPage = n;
                updatePageIndicator();
                return true;
            },

            step: function (dir) { return this.goto(this.current() + (dir < 0 ? -1 : 1)); }
        };

        // --- Column position memory -------------------------------------------------
        //
        // "Going back to the original column mode without making any changes returns you
        // to the original layout and position." Each column count remembers where it was
        // left; returning restores it exactly, provided the reader did not move or edit in
        // between. Anything else and the saved spot is stale, so the normal anchoring runs.
        //
        // This is not a shortcut around anchoring: the two layouts break content
        // differently, so re-deriving a position from an anchor can only ever land close.
        // Only a remembered position can return exactly.
        let _colMemory = { c1: null, c2: null };
        let _colMemoryDirty = false;
        let _progScrollUntil = 0;

        /** Scrolls we cause ourselves must not count as the reader moving. */
        function markProgrammaticScroll(ms) { _progScrollUntil = Date.now() + (ms || 600); }
        function noteUserMovement() { if (Date.now() > _progScrollUntil) _colMemoryDirty = true; }

        function captureColumnPosition() {
            if (!editor) return;
            if (editor.classList.contains('two-col-layout')) {
                _colMemory.c2 = { scrollLeft: editor.scrollLeft || 0, page: currentTwoColPage || 0 };
            } else if (mainContainer) {
                _colMemory.c1 = { scrollTop: mainContainer.scrollTop || 0 };
            }
        }

        /**
         * Run a correction repeatedly over the second or so after a column switch.
         *
         * Switching columns remounts the whole document, and the column flow keeps moving
         * while thousands of block heights resolve. A chain of animation frames is not
         * enough: it finishes within ~150ms, long before the layout is final, and a value
         * that is merely stale looks perfectly stable while it does. These delays keep
         * checking well past that, at a cost of a handful of measurements.
         */
        const COLUMN_SETTLE_DELAYS_MS = [0, 16, 50, 100, 200, 350, 550, 800, 1100, 1500];
        function scheduleColumnSettle(fn) {
            COLUMN_SETTLE_DELAYS_MS.forEach(function (d) {
                setTimeout(function () { try { fn(); } catch (e) {} }, d);
            });
        }

        /** Re-apply a remembered position until the relayout stops undoing it. */
        function restoreColumnPosition(twoCol, mem) {
            if (!mem) return;
            scheduleColumnSettle(function () {
                markProgrammaticScroll(400);
                if (twoCol) {
                    if (!editor || !editor.classList.contains('two-col-layout')) return;
                    if (Math.abs((editor.scrollLeft || 0) - mem.scrollLeft) > 2) {
                        editor.scrollLeft = mem.scrollLeft;
                    }
                    currentTwoColPage = mem.page;
                } else {
                    if (!mainContainer || (editor && editor.classList.contains('two-col-layout'))) return;
                    if (Math.abs((mainContainer.scrollTop || 0) - mem.scrollTop) > 2) {
                        mainContainer.scrollTop = mem.scrollTop;
                    }
                }
            });
        }

        /**
         * Keep the anchor line's page correct while the column layout settles.
         *
         * Never exits early on "the value did not change": right after the switch the page
         * is wrong AND unchanging, because the layout it was measured against has not
         * finished. That looked stable and stopped several pages short of the target.
         */
        function settleTwoColToLine(line, anchorBlockHint) {
            // Resolve the anchor block up front. After the switch the sticky line is
            // recomputed against a layout that is still moving, and it drifts badly --
            // entering pagination from a scroll at line ~1945 ended up reporting 287.
            const anchorBlock = (anchorBlockHint != null)
                ? anchorBlockHint
                : modelLocationFromDocumentLine(Math.max(1, line | 0)).blockIndex;

            scheduleColumnSettle(function () {
                if (!isPaginatedLayout()) return;
                // Rebuild against the current geometry, then jump to the page that holds
                // the anchor. Going through the map matters for more than picking the page:
                // goto() always lands on a stored boundary, so it also re-snaps after
                // anything that scrolled us off one. Restoring the caret focuses a block,
                // and focusing an element inside a horizontally scrolled multi-column
                // container makes the browser scroll it into view -- which left the view
                // parked between two pages, showing half of each.
                PageMap.invalidate();
                if (!PageMap.ensure()) return;
                const want = PageMap.pageOfBlock(anchorBlock);
                if (want !== PageMap.current() || (editor.scrollLeft || 0) !== PageMap.pages[want].offset) {
                    PageMap.goto(want);
                    window.showDebugTelemetry('settle: page=' + want + ' for block ' + anchorBlock);
                }
                updatePageIndicator();
            });
        }

        /** Collect text nodes under #editor only (skips sidebar, find bar, etc.). */
        function collectEditorTextNodes() {
            const nodes = [];
            if (!editor) return nodes;
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            let n;
            while ((n = walker.nextNode())) nodes.push(n);
            return nodes;
        }

        /**
         * Build a continuous haystack of editor visible text + map each char to a text node + offset.
         * Uses rendered text (inner text flow) so find matches what the user sees.
         */
        function buildWysiwygSearchIndex() {
            const nodes = collectEditorTextNodes();
            const parts = [];
            const map = []; // map[charIndex] = { node, offset }
            let lastBlock = null;
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const text = node.nodeValue;

                // Separate blocks with a newline. Without it the haystack ran every block
                // together, so a query could match across a block boundary and the sidebar
                // snippets read as "...marker row 14- bullet item o...". The newline also
                // gives this surface line numbers, which the model path already had.
                let block = null;
                try { block = getAncestorBlock(node); } catch (e) {}
                if (lastBlock !== null && block !== lastBlock) {
                    map.push({ node: node, offset: 0, boundary: true });
                    parts.push('\n');
                }
                lastBlock = block;

                for (let j = 0; j < text.length; j++) {
                    map.push({ node: node, offset: j });
                    parts.push(text.charAt(j));
                }
            }
            return { haystack: parts.join(''), map: map };
        }

        /**
         * 1-based line numbers for a set of ascending match offsets.
         * One pass over the haystack rather than a scan per match: a 4500-line document
         * with several hundred hits made the per-match version visibly stutter.
         */
        function lineNumbersForOffsets(haystack, offsets) {
            const out = new Array(offsets.length);
            let line = 1, pos = 0;
            for (let i = 0; i < offsets.length; i++) {
                const target = offsets[i];
                while (pos < target && pos < haystack.length) {
                    if (haystack.charCodeAt(pos) === 10) line++;
                    pos++;
                }
                out[i] = line;
            }
            return out;
        }

        /** Bounds of the line containing an offset. */
        function lineBoundsAt(haystack, offset) {
            let s = haystack.lastIndexOf('\n', Math.max(0, offset - 1));
            s = (s < 0) ? 0 : s + 1;
            let e = haystack.indexOf('\n', offset);
            if (e < 0) e = haystack.length;
            return { start: s, end: e };
        }

        function getFindOptions() {
            const mc = document.getElementById('findMatchCase');
            const ww = document.getElementById('findWholeWord');
            return {
                matchCase: !!(mc && mc.checked),
                wholeWord: !!(ww && ww.checked)
            };
        }

        function isWordChar(ch) {
            return ch && /[A-Za-z0-9_]/.test(ch);
        }

        function findAllIndices(haystack, query, opts) {
            const matches = [];
            if (!query || !haystack) return matches;
            const matchCase = opts && opts.matchCase;
            const wholeWord = opts && opts.wholeWord;
            const h = matchCase ? haystack : haystack.toLowerCase();
            const q = matchCase ? query : query.toLowerCase();
            let from = 0;
            while (from <= h.length - q.length) {
                const idx = h.indexOf(q, from);
                if (idx < 0) break;
                let ok = true;
                if (wholeWord) {
                    const before = idx > 0 ? haystack.charAt(idx - 1) : '';
                    const after = idx + q.length < haystack.length ? haystack.charAt(idx + q.length) : '';
                    if (isWordChar(before) || isWordChar(after)) ok = false;
                }
                if (ok) matches.push({ start: idx, end: idx + query.length });
                from = idx + Math.max(1, q.length);
            }
            return matches;
        }

        function rangesFromWysiwygMatches(matches, map) {
            const ranges = [];
            for (let i = 0; i < matches.length; i++) {
                const m = matches[i];
                if (m.start >= map.length || m.end - 1 >= map.length) continue;
                const a = map[m.start];
                const b = map[m.end - 1];
                if (!a || !b) continue;
                try {
                    const r = document.createRange();
                    r.setStart(a.node, a.offset);
                    r.setEnd(b.node, b.offset + 1);
                    ranges.push(r);
                } catch (e) {}
            }
            return ranges;
        }

        function applyWysiwygHighlights() {
            clearFindHighlights();
            if (!CSS || !CSS.highlights || findState.ranges.length === 0) return;
            try {
                const all = new Highlight(...findState.ranges);
                CSS.highlights.set('typozen-find', all);
                if (findState.index >= 0 && findState.index < findState.ranges.length) {
                    CSS.highlights.set('typozen-find-current', new Highlight(findState.ranges[findState.index]));
                }
            } catch (e) {
                // Highlight API unavailable — still navigate via selection
            }
        }

        function scrollRangeIntoMain(range) {
            if (!range || !mainContainer) return;
            try {
                const rect = range.getBoundingClientRect();
                const cRect = mainContainer.getBoundingClientRect();
                const pad = 80;
                if (rect.top < cRect.top + pad || rect.bottom > cRect.bottom - pad) {
                    const delta = rect.top - cRect.top - cRect.height / 3;
                    mainContainer.scrollTop += delta;
                }
            } catch (e) {
                try {
                    const node = range.startContainer;
                    const el = node.nodeType === 1 ? node : node.parentElement;
                    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                } catch (e2) {}
            }
        }

        function scrollSourceMatchIntoView(start, end, takeFocus) {
            if (!sourceEditor) return;
            const before = sourceEditor.value.substring(0, Math.max(0, start | 0));
            const line = Math.max(1, before.split(/\r?\n/).length);
            try {
                if (takeFocus) sourceEditor.focus();
                sourceEditor.setSelectionRange(start, end);
            } catch (e) {}
            // Same proportional mapping as scrollSourceToHardLine (wrap-safe)
            try {
                const total = countHardLines(sourceEditor.value || '');
                const max = Math.max(0, sourceEditor.scrollHeight - sourceEditor.clientHeight);
                if (total <= 1 || max <= 0) sourceEditor.scrollTop = 0;
                else {
                    const t = (Math.min(line, total) - 1) / (total - 1);
                    sourceEditor.scrollTop = Math.round(max * Math.max(0, Math.min(1, t)));
                }
                if (mainContainer) mainContainer.scrollTop = 0;
            } catch (e2) {}
        }

        /**
         * Single search surface for count + navigation.
         * Source → textarea. Full Preview → rendered DOM text. Virtualized Preview → full
         * DocumentModel markdown (mounted DOM alone would miss off-screen hits).
         * Replace always rewrites full markdown via getMarkdownContent().
         */
        function getFindHaystack() {
            if (state.mode === 'source') {
                return { haystack: sourceEditor ? sourceEditor.value : '', map: null, kind: 'source' };
            }
            // Virt: only a window of blocks is mounted — search the model, not the viewport DOM.
            if (typeof DocumentModel !== 'undefined' && DocumentModel.virtEnabled) {
                try { DocumentModel.syncMountedToModel(); } catch (eS) {}
                let md = '';
                try { md = DocumentModel.toMarkdown(); } catch (eT) {
                    try { md = getMarkdownContent(false, { flushActive: true }); } catch (eG) { md = ''; }
                }
                return { haystack: md, map: null, kind: 'model' };
            }
            const idx = buildWysiwygSearchIndex();
            return { haystack: idx.haystack, map: idx.map, kind: 'visual' };
        }

        /**
         * Map a char offset in DocumentModel.toMarkdown() → block index + offset in that block's raw.
         * toMarkdown joins blocks with '\n' (same as getMarkdownContent model path).
         */
        function markdownOffsetToBlock(offset) {
            const blocks = (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
                ? DocumentModel.blocks : [];
            let pos = 0;
            const n = blocks.length;
            if (!n) return { blockIndex: 0, offsetInBlock: 0, blockStart: 0 };
            const off = Math.max(0, offset | 0);
            for (let i = 0; i < n; i++) {
                const raw = String(blocks[i].raw == null ? '' : blocks[i].raw);
                const end = pos + raw.length;
                // Match at the joining newline belongs to the next block start
                if (off < end || (off === end && i === n - 1)) {
                    return { blockIndex: i, offsetInBlock: Math.min(raw.length, Math.max(0, off - pos)), blockStart: pos };
                }
                if (off === end && i < n - 1) {
                    // exactly on '\n' between blocks → start of next
                    pos = end + 1;
                    continue;
                }
                pos = end + 1; // +1 for '\n'
            }
            const last = n - 1;
            const lastRaw = String(blocks[last].raw == null ? '' : blocks[last].raw);
            return { blockIndex: last, offsetInBlock: lastRaw.length, blockStart: Math.max(0, pos - lastRaw.length - 1) };
        }

        /**
         * Build text-node index under a single root (one .block), for post-mount highlight.
         */
        function buildSearchIndexInRoot(root) {
            const nodes = [];
            if (!root) return { haystack: '', map: [] };
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            let n;
            while ((n = walker.nextNode())) nodes.push(n);
            let haystack = '';
            const map = [];
            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const text = node.nodeValue;
                for (let j = 0; j < text.length; j++) {
                    map.push({ node: node, offset: j });
                    haystack += text.charAt(j);
                }
            }
            return { haystack: haystack, map: map };
        }

        /**
         * Highlight a model match inside already-mounted DOM (no scroll/remount).
         * Returns true if a visual range was applied.
         */
        function highlightModelMatchInMountedDom(match, navigate) {
            if (!match || !editor || typeof DocumentModel === 'undefined') return false;
            const loc = markdownOffsetToBlock(match.start);
            const blockIdx = loc.blockIndex;
            const blockEl = editor.querySelector('.block[data-model-index="' + blockIdx + '"]');
            if (!blockEl) {
                findState.ranges = [];
                clearFindHighlights();
                return false;
            }

            const q = findState.query;
            const opts = getFindOptions();
            const local = buildSearchIndexInRoot(blockEl);
            const localMatches = findAllIndices(local.haystack, q, opts);

            // Which model match is this among matches that land in the same block?
            let which = 0;
            for (let i = 0; i < findState.matches.length; i++) {
                const mm = findState.matches[i];
                if (mm.start === match.start && mm.end === match.end) break;
                const loc2 = markdownOffsetToBlock(mm.start);
                if (loc2.blockIndex === blockIdx) which++;
            }

            let ranges = [];
            if (localMatches.length) {
                const pick = localMatches[Math.min(which, localMatches.length - 1)];
                ranges = rangesFromWysiwygMatches([pick], local.map);
            }
            findState.ranges = ranges;
            applyWysiwygHighlights();
            if (ranges.length && ranges[0]) {
                scrollRangeIntoMain(ranges[0]);
                if (navigate) {
                    try {
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(ranges[0].cloneRange());
                    } catch (eSel) {}
                }
                return true;
            }
            return false;
        }

        /**
         * Virt find: scroll/mount the block that owns the model match, then highlight the
         * query in that block's rendered text (best-effort when raw ≠ visual).
         */
        function revealModelMatch(match, navigate) {
            if (!match || typeof DocumentModel === 'undefined') return;
            const loc = markdownOffsetToBlock(match.start);
            const blockIdx = loc.blockIndex;
            try {
                DocumentModel.ensureHeights();
                if (mainContainer) {
                    mainContainer.scrollTop = Math.max(0, DocumentModel.prefixHeight(blockIdx) - 80);
                }
            } catch (eScr) {}
            // Suppress refreshFindAfterVirtMount re-entry while we intentionally remount
            findState._revealing = true;
            try { mountVirtWindow(true); } catch (eM) {}
            findState._revealing = false;

            const blockEl = editor
                ? editor.querySelector('.block[data-model-index="' + blockIdx + '"]')
                : null;
            if (blockEl) {
                try {
                    currentActiveBlock = blockEl;
                    blockEl.classList.add('focused');
                } catch (eF) {}
            }
            const ok = highlightModelMatchInMountedDom(match, navigate);
            if (!ok) {
                // Query only in markdown (e.g. "**") — still bring the block into view
                try {
                    if (blockEl && blockEl.scrollIntoView) {
                        blockEl.scrollIntoView({ block: 'center', behavior: 'auto' });
                    }
                } catch (eV) {}
            }
            // Status Ln must use model index (not mounted-window ordinal)
            try { updateStatsNow(); } catch (eSt) {}
        }

        /** After virt remount (user scroll), re-highlight current match if its block is mounted. */
        function refreshFindAfterVirtMount() {
            if (findState._revealing) return;
            if (!isFindBarOpen() || !findState.query) return;
            if (state.mode === 'source') return;
            if (typeof DocumentModel === 'undefined' || !DocumentModel.virtEnabled) return;
            if (findState.kind !== 'model') return;
            if (findState.index < 0 || findState.index >= findState.matches.length) return;
            try {
                highlightModelMatchInMountedDom(findState.matches[findState.index], false);
            } catch (e) {}
        }

        function runFind(query, keepIndex, options) {
            const navigate = !!(options && options.navigate);
            const q = (query == null ? '' : String(query));
            findState.query = q;
            clearFindHighlights();
            findState.matches = [];
            findState.ranges = [];
            const opts = getFindOptions();

            if (!q) {
                findState.index = -1;
                findState.kind = 'visual';
                updateFindCount();
                setFindStatus('');
                if (isFindBarOpen() && !navigate) focusFindInput(false);
                return;
            }

            const surface = getFindHaystack();
            findState.kind = surface.kind || 'visual';
            findState.matches = findAllIndices(surface.haystack, q, opts);
            if (!keepIndex || findState.index < 0 || findState.index >= findState.matches.length) {
                findState.index = findState.matches.length > 0 ? 0 : -1;
            }

            // navigate=false: update count/highlights only — do NOT move caret/scroll
            // (mode switch used to re-run find and yank you off the sticky line).
            if (state.mode === 'source' || findState.kind === 'source') {
                if (navigate && findState.index >= 0) {
                    const m = findState.matches[findState.index];
                    scrollSourceMatchIntoView(m.start, m.end, true);
                }
            } else if (findState.kind === 'model') {
                if (findState.index >= 0) {
                    if (navigate) revealModelMatch(findState.matches[findState.index], true);
                    else highlightModelMatchInMountedDom(findState.matches[findState.index], false);
                }
            } else {
                findState.ranges = rangesFromWysiwygMatches(findState.matches, surface.map);
                applyWysiwygHighlights();
                if (navigate && findState.index >= 0 && findState.ranges[findState.index]) {
                    scrollRangeIntoMain(findState.ranges[findState.index]);
                    try {
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(findState.ranges[findState.index].cloneRange());
                    } catch (e) {}
                }
            }
            updateFindCount();
            setFindStatus(findState.matches.length === 0 ? 'No results' : '');
            if (isFindBarOpen()) focusFindInput(false);
        }

        function setFindStatus(text) {
            const el = document.getElementById('findStatus');
            if (el) el.textContent = text || '';
        }

        /** Replace using full markdown document (reliable for both modes). */
        function replaceCurrentMatch() {
            const q = (document.getElementById('findInput') || {}).value || '';
            const rep = (document.getElementById('replaceInput') || {}).value;
            if (rep === undefined) return;
            if (!q) {
                runFind(q, false, { navigate: true });
                return;
            }
            // Always replace against markdown so Source/Live stay consistent
            const opts = getFindOptions();
            const hay = getMarkdownContent();
            const matches = findAllIndices(hay, q, opts);
            if (!matches.length) {
                runFind(q, false, { navigate: false });
                setFindStatus('No results');
                return;
            }
            let idx = findState.index;
            if (idx < 0 || idx >= matches.length) idx = 0;
            const m = matches[idx];
            const next = hay.slice(0, m.start) + rep + hay.slice(m.end);
            applyReplacedDocument(next);
            runFind(q, false, { navigate: true });
            setFindStatus('Replaced 1');
            focusFindInput(false);
        }

        function replaceAllMatches() {
            const q = (document.getElementById('findInput') || {}).value || '';
            const repEl = document.getElementById('replaceInput');
            const rep = repEl ? repEl.value : '';
            if (!q) return;
            const opts = getFindOptions();
            const hay = getMarkdownContent();
            const matches = findAllIndices(hay, q, opts);
            if (!matches.length) {
                setFindStatus('No results');
                runFind(q, false, { navigate: false });
                return;
            }
            let next = hay;
            for (let i = matches.length - 1; i >= 0; i--) {
                const m = matches[i];
                next = next.slice(0, m.start) + rep + next.slice(m.end);
            }
            applyReplacedDocument(next);
            runFind(q, false, { navigate: false });
            setFindStatus('Replaced ' + matches.length);
            focusFindInput(false);
        }

        function applyReplacedDocument(markdown) {
            if (typeof HistoryManager !== 'undefined') HistoryManager.beginEdit();
            if (state.mode === 'source') {
                const start = sourceEditor.selectionStart;
                sourceEditor.value = markdown;
                resizeSourceEditor();
                try { sourceEditor.setSelectionRange(start, start); } catch (e) {}
            } else {
                // loadMarkdownContent resets history when not restoring — suppress that
                const wasRestoring = HistoryManager.isRestoring;
                HistoryManager.isRestoring = true;
                try {
                    loadMarkdownContent(markdown);
                } finally {
                    HistoryManager.isRestoring = wasRestoring;
                }
            }
            if (typeof HistoryManager !== 'undefined') HistoryManager.commitEdit();
            updateStatsNow();
            updateOutline();
            scheduleSavePreferences();
        }

        window.findStepGlobal = findStep;
        function findStep(dir) {
            const input = document.getElementById('findInput');
            if (!findState.matches.length) {
                runFind(input ? input.value : '', false, { navigate: true });
                focusFindInput(false);
                return;
            }
            findState.index = (findState.index + dir + findState.matches.length) % findState.matches.length;
            if (state.mode === 'source' || findState.kind === 'source') {
                const m = findState.matches[findState.index];
                scrollSourceMatchIntoView(m.start, m.end, true);
            } else if (findState.kind === 'model') {
                revealModelMatch(findState.matches[findState.index], true);
            } else {
                // Rebuild ranges from current visual text (same list as matches)
                const surface = getFindHaystack();
                findState.ranges = rangesFromWysiwygMatches(findState.matches, surface.map);
                applyWysiwygHighlights();
                const r = findState.ranges[findState.index];
                if (r) {
                    scrollRangeIntoMain(r);
                    try {
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(r.cloneRange());
                    } catch (e) {}
                }
            }
            updateFindCount();
            focusFindInput(false);
        }

        function initFindBar() {
            const bar = document.getElementById('findBar');
            const input = document.getElementById('findInput');
            const replaceInput = document.getElementById('replaceInput');
            const prev = document.getElementById('findPrev');
            const next = document.getElementById('findNext');
            const close = document.getElementById('findClose');
            const repOne = document.getElementById('findReplaceOne');
            const repAll = document.getElementById('findReplaceAll');
            const matchCase = document.getElementById('findMatchCase');
            const wholeWord = document.getElementById('findWholeWord');
            if (!bar || !input) return;

            bar.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    // Ctrl+Enter = replace one; Alt+Enter = replace all; Enter = next; Shift+Enter = prev
                    if (e.ctrlKey || e.metaKey) replaceCurrentMatch();
                    else if (e.altKey) replaceAllMatches();
                    else if (e.shiftKey) findStep(-1);
                    else findStep(1);
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFindBar();
                    return;
                }
            }, true);

            bar.addEventListener('keydown', (e) => { e.stopPropagation(); }, false);
            bar.addEventListener('keypress', (e) => { e.stopPropagation(); }, false);
            bar.addEventListener('keyup', (e) => { e.stopPropagation(); }, false);
            bar.addEventListener('mousedown', (e) => { e.stopPropagation(); });

            let debounce = null;
            const scheduleFind = () => {
                clearTimeout(debounce);
                debounce = setTimeout(() => {
                    runFind(input.value, false, { navigate: false });
                    focusFindInput(false);
                }, 60);
            };
            input.addEventListener('input', scheduleFind);
            if (matchCase) matchCase.addEventListener('change', scheduleFind);
            if (wholeWord) wholeWord.addEventListener('change', scheduleFind);

            if (prev) prev.addEventListener('click', (e) => { e.preventDefault(); findStep(-1); });
            if (next) next.addEventListener('click', (e) => { e.preventDefault(); findStep(1); });
            if (close) close.addEventListener('click', (e) => { e.preventDefault(); closeFindBar(); });
            if (repOne) repOne.addEventListener('click', (e) => { e.preventDefault(); replaceCurrentMatch(); });
            if (repAll) repAll.addEventListener('click', (e) => { e.preventDefault(); replaceAllMatches(); });

            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    openFindBar();
                    return;
                }
                if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
                    e.preventDefault();
                    e.stopPropagation();
                    openFindBar(null, true);
                    return;
                }
                // Function keys when WebView has focus (host may not see them)
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    if (e.key === 'F7') { e.preventDefault(); handleCommand('toggle_reveal'); return; }
                    if (e.key === 'F8') { e.preventDefault(); handleCommand('toggle_focus'); return; }
                    if (e.key === 'F9') { e.preventDefault(); handleCommand('toggle_typewriter'); return; }
                }
                if (!e.ctrlKey && !e.metaKey && !e.altKey && isFindBarOpen()) {
                    const t = e.target;
                    const isTyping = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
                    if (!isTyping) {
                        if (e.key === '<' || e.key === ',') { e.preventDefault(); e.stopPropagation(); findStep(-1); return; }
                        if (e.key === '>' || e.key === '.') { e.preventDefault(); e.stopPropagation(); findStep(1); return; }
                    }
                }
                if (isFindBarOpen() && e.key === 'Enter' && e.target && e.target.closest && !e.target.closest('#findBar')) {
                    if (e.target.closest && e.target.closest('#tableModal')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    findStep(e.shiftKey ? -1 : 1);
                    focusFindInput(false);
                    return;
                }
                if (!isFindBarOpen()) return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFindBar();
                } else if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
                    e.preventDefault();
                    e.stopPropagation();
                    findStep(e.shiftKey ? -1 : 1);
                    focusFindInput(false);
                }
            }, true);
        }

        let _prefsSaveTimer = null;

        /** Debounced prefs write — avoids thrashing disk on every keystroke. */
        function scheduleSavePreferences() {
            if (isRestoring) return;
            clearTimeout(_prefsSaveTimer);
            _prefsSaveTimer = setTimeout(() => savePreferences(true), 800);
        }

        function savePreferences(fromScheduler) {
            if (isRestoring) return;
            if (!fromScheduler) {
                // Immediate callers still debounce unless forced via schedule path completion
                scheduleSavePreferences();
                return;
            }
            const themeName = (window.allThemes && window.allThemes[state.themeIndex] && window.allThemes[state.themeIndex].Name)
                ? window.allThemes[state.themeIndex].Name
                : (state.themeName || '');
            const prefs = {
                themeIndex: state.themeIndex || 0,
                themeName: themeName,
                mode: state.mode || 'wysiwyg',
                sidebarCollapsed: sidebar ? sidebar.classList.contains('collapsed') : false,
                revealOnFocus: state.revealOnFocus || false,
                focusMode: state.focusMode || false,
                typewriterMode: state.typewriterMode || false,
                margin: state.margin || 'narrow',
                // A full copy of the open document. Only sent when the host says content
                // persistence is on — otherwise it would land in settings.json AND in
                // localStorage, which is a duplicate of your document in two more places.
                // Reuse the serialize updateStatsNow just did (invalidated by any edit)
                // instead of walking the whole document a second time.
                lastContent: state.persistContent
                    ? (_contentCache != null ? _contentCache : getMarkdownContent(false))
                    : '',
                lastFilePath: state.lastFilePath || ''
            };
            const payload = JSON.stringify(prefs);

            // Host settings.json is the source of truth — write it FIRST and in its own
            // try. localStorage has a hard ~5 MB quota, and setItem used to run first
            // inside a shared try: past the quota it threw, the catch swallowed it, and
            // postMsg never ran, so theme / mode / margins / scratchpad silently stopped
            // persisting for large documents.
            try {
                postMsg("save_prefs:" + payload);
            } catch (e) {}

            // localStorage is a same-session backup only. If the document is too big to
            // fit, keep the small settings rather than losing the backup entirely.
            try {
                localStorage.setItem('typozen_prefs', payload);
            } catch (e) {
                try {
                    const lite = {};
                    Object.keys(prefs).forEach(function (k) {
                        if (k !== 'lastContent') lite[k] = prefs[k];
                    });
                    lite.lastContent = '';
                    localStorage.setItem('typozen_prefs', JSON.stringify(lite));
                } catch (e2) {}
            }
        }

        function applySavedPrefs(savedPrefs) {
            if (!savedPrefs) return;
            isRestoring = true;
            try {
                // Prefer theme by name (stable across reordering), fall back to index
                let themeIdx = savedPrefs.themeIndex;
                if (window.allThemes && window.allThemes.length) {
                    if (savedPrefs.themeName) {
                        const byName = window.allThemes.findIndex(t => t && t.Name === savedPrefs.themeName);
                        if (byName >= 0) themeIdx = byName;
                    }
                    if (themeIdx !== undefined && window.allThemes[themeIdx]) {
                        state.themeIndex = themeIdx;
                        state.themeName = window.allThemes[themeIdx].Name || savedPrefs.themeName || '';
                        applyTheme(window.allThemes[themeIdx]);
                    }
                }
                if (savedPrefs.lastContent && savedPrefs.lastContent.trim() !== '') {
                    loadMarkdownContent(savedPrefs.lastContent);
                    state.lastSavedContent = getMarkdownContent(false);
                }
                if (savedPrefs.sidebarCollapsed) {
                    sidebar.classList.add('collapsed');
                } else {
                    sidebar.classList.remove('collapsed');
                }
                state.revealOnFocus = !!savedPrefs.revealOnFocus;
                state.focusMode = !!savedPrefs.focusMode;
                if (editor) editor.classList.toggle('focus-mode', state.focusMode);
                state.typewriterMode = !!savedPrefs.typewriterMode;
                setMargin(savedPrefs.margin || 'narrow');

                if (savedPrefs.mode === 'source') {
                    const currentWysiwyg = getMarkdownContent();
                    if (currentWysiwyg && currentWysiwyg.trim() !== '') {
                        sourceEditor.value = currentWysiwyg;
                    }
                    state.mode = 'source';
                    editor.style.display = 'none';
                    sourceEditor.style.display = 'block';
                    postMsg("mode_changed:source");
                    requestAnimationFrame(resizeSourceEditor);
                } else {
                    state.mode = 'wysiwyg';
                    editor.style.display = 'block';
                    sourceEditor.style.display = 'none';
                    postMsg("mode_changed:wysiwyg");
                }
                postViewFlags();
                updateStatsNow();
                updateOutline();
            } finally {
                isRestoring = false;
            }
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
            loadMarkdownContent(initialContent);
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

            // Any movement or edit by the reader invalidates the remembered column
            // positions, so switching back anchors afresh instead of restoring a spot they
            // have since left. Scrolls we perform ourselves are excluded by the
            // markProgrammaticScroll window.
            if (mainContainer) mainContainer.addEventListener('scroll', noteUserMovement, { passive: true });
            if (editor) {
                editor.addEventListener('scroll', noteUserMovement, { passive: true });

                // Invariant: while the document is paginated, the scroll offset is always a
                // page boundary. There is no free scrolling in page mode -- you are either
                // on a page or the view is broken -- so anything that moves us off one gets
                // snapped back to the nearest.
                //
                // This exists because a real run parks between two pages, showing the tail
                // of one and the head of the next, and I could not reproduce it in a bare
                // browser: headless Preview lands correctly on a boundary. The likely cause
                // is the caret restore (placing a selection in a contenteditable makes the
                // browser scroll the caret into view, after the snap has run), but rather
                // than guess at every source, this holds the invariant whatever moved us:
                // caret, focus, trackpad momentum, or the browser's own scroll anchoring.
                let _snapTimer = null;
                editor.addEventListener('scroll', function () {
                    if (!isPaginatedLayout()) return;
                    if (Date.now() <= _progScrollUntil) return;   // our own scrolling
                    if (_snapTimer) clearTimeout(_snapTimer);
                    _snapTimer = setTimeout(function () {
                        _snapTimer = null;
                        if (!isPaginatedLayout() || !PageMap.ensure()) return;
                        const sl = editor.scrollLeft || 0;
                        let nearest = PageMap.pages[0], best = Infinity;
                        for (let i = 0; i < PageMap.pages.length; i++) {
                            const d = Math.abs(PageMap.pages[i].offset - sl);
                            if (d < best) { best = d; nearest = PageMap.pages[i]; }
                        }
                        if (best > 2) {
                            markProgrammaticScroll(300);
                            editor.scrollTop = 0;
                            editor.scrollLeft = nearest.offset;
                            currentTwoColPage = PageMap.pages.indexOf(nearest);
                            updatePageIndicator();
                            window.showDebugTelemetry('snap: was ' + Math.round(sl) +
                                ', off boundary by ' + Math.round(best) + ', snapped to ' + nearest.offset);
                        }
                    }, 120);
                }, { passive: true });
                editor.addEventListener('input', function () {
                    noteUserMovement();
                    PageMap.invalidate();   // editing moves every break after the caret
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
                else if (msg.startsWith("fetch_and_load:")) {
                    const url = msg.substring(15);
                    fetch(url, { cache: 'no-store' })
                        .then(function (r) {
                            if (!r.ok) throw new Error('fetch ' + r.status);
                            return r.text();
                        })
                        .then(function (content) {
                            finishLoadContent(content, false);
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
                else if (msg == "new_document") {
                    loadMarkdownContent("# Untitled Document\n\nStart typing here...");
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
            if (accent.startsWith('#') && accent.length >= 7) {
                const r = parseInt(accent.substr(1, 2), 16) || 0;
                const g = parseInt(accent.substr(3, 2), 16) || 0;
                const b = parseInt(accent.substr(5, 2), 16) || 0;
                isAccentLight = (r * 0.299 + g * 0.587 + b * 0.114) > 130;
            }

            root.setProperty('--bg', bg);
            root.setProperty('--tx', tx);
            root.setProperty('--accent', accent);
            root.setProperty('--accent-tx', isAccentLight ? '#000000' : '#FFFFFF');
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
                    scheduleColumnSettle(function () { PageMap.invalidate(); updatePageIndicator(); });
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

                // Resolve the anchor to a block while the OLD layout is still on screen and
                // measurable. Recomputing it afterwards reads a layout mid-remount.
                let _anchorBlock = 0;
                try {
                    _anchorBlock = isPaginatedLayout()
                        ? topLeftModelIndexTwoCol()
                        : modelLocationFromDocumentLine(Math.max(1, stickyLine | 0)).blockIndex;
                    if (!(_anchorBlock >= 0)) {
                        _anchorBlock = modelLocationFromDocumentLine(Math.max(1, stickyLine | 0)).blockIndex;
                    }
                } catch (e) { _anchorBlock = 0; }

                // Remember where the layout being left was sitting, and decide whether the
                // one being entered can simply be put back exactly as it was.
                captureColumnPosition();
                const _memForTarget = twoCol ? _colMemory.c2 : _colMemory.c1;
                const _restoreExact = !!_memForTarget && !_colMemoryDirty;
                markProgrammaticScroll(1200);

                if (twoCol) {
                    editor.classList.add('two-col-layout');
                } else {
                    editor.classList.remove('two-col-layout');
                    if (editor && !isPaginatedLayout()) editor.scrollLeft = 0;
                    currentTwoColPage = 0;
                }
                syncPaginationClass();
                applyEditorChromeForMode();

                if (typeof DocumentModel !== 'undefined') {
                    const shouldVirt = DocumentModel.shouldVirtualize();
                    if (DocumentModel.virtEnabled && !shouldVirt) {
                        const restoreHistory = typeof HistoryManager !== 'undefined' ? HistoryManager.isRestoring : false;
                        if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = true;
                        const md = DocumentModel.toMarkdown();
                        loadMarkdownContent(md, { deferPaint: true, stickyLine: stickyLine });
                        if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = restoreHistory;
                    } else if (!DocumentModel.virtEnabled && shouldVirt) {
                        const restoreHistory = typeof HistoryManager !== 'undefined' ? HistoryManager.isRestoring : false;
                        if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = true;
                        const md = DocumentModel.toMarkdown();
                        loadMarkdownContent(md, { deferPaint: true, stickyLine: stickyLine });
                        if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = restoreHistory;
                    } else {
                        requestAnimationFrame(function() {
                            restoreStickyDocumentLine(stickyLine);
                        });
                    }
                }
                // The layout changed, so any page map built for the old one is meaningless.
                PageMap.invalidate();

                if (_restoreExact) {
                    // Returning to a layout the reader has not moved away from: put it back
                    // exactly. Even a correct page map cannot do this on its own -- the two
                    // layouts break content differently, so a block that started a page in
                    // one may sit mid-page in the other, and re-deriving can only land on
                    // the page that contains it, not the position it was left at.
                    window.showDebugTelemetry('set_column_mode: restoring remembered position');
                    restoreColumnPosition(twoCol, _memForTarget);
                } else {
                    // Otherwise anchor to what the reader was looking at. Paginated layouts
                    // resolve this against the real column geometry; an unpaginated 1-column
                    // view is left to the ordinary sticky-line restore that already ran.
                    if (isPaginatedLayout()) settleTwoColToLine(stickyLine, _anchorBlock);
                }
                // The switch itself is not the reader moving.
                _colMemoryDirty = false;
                scheduleColumnSettle(function () { updatePageIndicator(); });

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
                    editor.setAttribute('contenteditable', 'false');
                    editor.classList.add('reader-mode');
                    applyEditorChromeForMode();
                    postMsg("mode_changed:reader");
                    if (!state.pageAdvance) {
                        state.pageAdvance = true;
                        postMsg("sync_page_advance:1");
                    }
                } else if (state.mode === 'reader') {
                    editor.setAttribute('contenteditable', 'true');
                    editor.classList.remove('reader-mode');
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
                    editor.setAttribute('contenteditable', 'true');
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
                // Find: recount only — never navigate (would override sticky line)
                if (isFindBarOpen()) {
                    const fi = document.getElementById('findInput');
                    runFind(fi ? fi.value : '', true, { navigate: false });
                    focusFindInput();
                } else {
                    clearFindHighlights();
                }
                // Reader/Preview/Source changes whether pages apply at all.
                syncPaginationClass();
                applyEditorChromeForMode();
                scheduleColumnSettle(function () { PageMap.invalidate(); updatePageIndicator(); });
                // Mode can change from Ctrl+/ or the View menu, not just a selector click.
                postViewState(currentViewState());
            }
            else if (cmd === "toggle_sidebar") {
                sidebar.classList.toggle('collapsed');
            }
            else if (cmd === "toggle_search_sidebar") {
                // Alt+S, the ZenSeek gesture. Closed, or open on another tab, means the
                // user wants search: reveal it. Only a sidebar already showing Search
                // collapses, so the key is a true toggle rather than an open-only.
                const searchPane = document.getElementById('tab-search');
                const showingSearch = searchPane && searchPane.classList.contains('active');
                if (sidebar.classList.contains('collapsed') || !showingSearch) {
                    sidebar.classList.remove('collapsed');
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

                // Any newline inside one block is browser filler, never a real line
                lines.push(String(inter.toString()).replace(/[\r\n]+/g, ' '));
            }
            if (!lines.length) return String(sel.toString());
            return lines.join('\n');
        }

        /**
         * Delete a selection that spans several blocks, joining the surviving head and tail
         * into one line, and return where the caret belongs. Shared by cut and paste-over:
         * left to the browser, both restructured blocks in ways the one-block-one-line
         * serializer then mangled.
         * Returns { block, offset } or null when the selection sits inside one block.
         */
        function removeCrossBlockSelection() {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
            const range = sel.getRangeAt(0);
            const startBlock = getAncestorBlock(range.startContainer);
            const endBlock = getAncestorBlock(range.endContainer);
            if (!startBlock || !endBlock || startBlock === endBlock) return null;

            const head = document.createRange();
            head.selectNodeContents(startBlock);
            head.setEnd(range.startContainer, range.startOffset);
            const prefix = head.toString();

            const tail = document.createRange();
            tail.selectNodeContents(endBlock);
            tail.setStart(range.endContainer, range.endOffset);
            const suffix = tail.toString();

            // Batch-remove middle blocks + keep DocumentModel aligned.
            let fromIdx = DocumentModel.modelIndexOfEl(startBlock);
            let toIdx = DocumentModel.modelIndexOfEl(endBlock);
            if (startBlock.parentNode) {
                const doomed = [];
                let node = startBlock.nextElementSibling;
                while (node && node !== endBlock) {
                    doomed.push(node);
                    node = node.nextElementSibling;
                }
                if (endBlock !== startBlock) doomed.push(endBlock);
                for (let i = 0; i < doomed.length; i++) {
                    try { doomed[i].remove(); } catch (e) {}
                }
            }

            writeBlockRaw(startBlock, coerceBlockRaw(prefix + suffix));
            // Model: drop removed range, keep start block raw (writeBlockRaw already set it).
            try {
                if (fromIdx < 0 || toIdx < 0) {
                    if (!DocumentModel.virtEnabled) DocumentModel.rebuildFromFullDom();
                } else if (toIdx > fromIdx) {
                    DocumentModel.removeBlockRange(fromIdx + 1, toIdx);
                    if (DocumentModel.virtEnabled) mountVirtWindow(true);
                    else reindexMountedBlocks();
                }
            } catch (eM) {
                try { DocumentModel.rebuildFromFullDom(); } catch (e2) {}
            }
            return { block: startBlock, offset: prefix.length };
        }

        /**
         * Backspace/Delete over a multi-block selection. Must not fall through to the
         * browser: contenteditable then rewrites thousands of nodes and we freeze.
         */
        function handleMultiBlockSelectionDelete(e) {
            if (window.isComposing || (e && e.isComposing) || (e && e.keyCode === 229)) return false;
            if (state.mode === 'source') return false;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
            if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return false;
            const range = sel.getRangeAt(0);
            const startBlock = getAncestorBlock(range.startContainer);
            const endBlock = getAncestorBlock(range.endContainer);
            if (!startBlock || !endBlock) return false;
            if (startBlock === endBlock) return false; // single block: browser is fine

            if (e) {
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            }

            const pre = getMarkdownContent(false);
            const cutAt = removeCrossBlockSelection();
            if (!cutAt) return true;

            try {
                window.isProgrammaticFocus = true;
                focusBlock(cutAt.block);
                setCaretAtOffset(cutAt.block, cutAt.offset | 0);
            } catch (err) {}

            const post = getMarkdownContent(false);
            if (typeof HistoryManager !== 'undefined') {
                HistoryManager.recordEditPair(pre, post);
            }
            // Defer outline/stats so the delete paints first
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
            const allBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
            if (!allBlocks.length) return false;

            // Snapshot FIRST — single source for mutation AND undo pre-state.
            // Prefer frozen format raws (mouseup); else readBlockRawSafe (DOM fallback).
            const allRaws = allBlocks.map(function (b, bi) {
                if (typeof _formatSelectionFrozen !== 'undefined' && _formatSelectionFrozen
                    && typeof _selectedFormatRaws !== 'undefined'
                    && Object.prototype.hasOwnProperty.call(_selectedFormatRaws, bi)
                    && _selectedFormatRaws[bi] != null
                    && String(_selectedFormatRaws[bi]).trim()) {
                    return coerceBlockRaw(_selectedFormatRaws[bi]);
                }
                // Frozen empty is useless — re-read DOM (may still have text)
                return readBlockRawSafe(b);
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
                        editor.focus();
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
            const allBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
            if (!allBlocks.length) return false;
            const selectedIdx = getSelectedBlockIndices();
            const focusIndices = {};
            let any = false;
            for (let i = 0; i < selectedIdx.length; i++) {
                const idx = selectedIdx[i];
                if (idx >= 0 && idx < allBlocks.length && isListLine(getBlockRaw(allBlocks[idx]))) {
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
                try { editor.focus(); } catch (e4) {}
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
                        editor.focus();
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
                editor.focus();
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
                const allBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
                const idx = allBlocks.indexOf(block);
                if (idx >= 0) {
                    const focusIndices = {};
                    focusIndices[idx] = true;
                    mutateDocumentMarkdown(function (raw, index) {
                        if (index === idx) return pieces.slice();
                        return raw;
                    }, { focusIndices: focusIndices });
                    const newBlocks = Array.prototype.slice.call(editor.querySelectorAll('.block'));
                    // One block expanded to pieces.length lines at the same index
                    return newBlocks.slice(idx, idx + pieces.length);
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
                        try { editor.focus(); } catch (e4) {}
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
                        this.restore(prevStr);
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

            restore(stateStr) {
                if (!stateStr) return;
                try {
                    let data;
                    try {
                        data = JSON.parse(stateStr);
                    } catch (e) {
                        data = null;
                    }
                    const caret = data && data.caret ? data.caret : this._caretOf(stateStr);
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
                    }
                    updateStatsNow();
                    updateOutline();
                    scheduleSavePreferences();
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

        // --- Inline selection → Markdown (bold / italic / code / link) ---
        let _inlineSelCache = null; // { block, start, end, text }
        /** Source textarea selection frozen for toolbar (WPF steals focus → selection collapses). */
        let _sourceFormatSel = null; // { start, end }

        function rememberSourceFormatSelection() {
            if (!sourceEditor || state.mode !== 'source') return;
            try {
                const a = sourceEditor.selectionStart | 0;
                const b = sourceEditor.selectionEnd | 0;
                if (a !== b) _sourceFormatSel = { start: Math.min(a, b), end: Math.max(a, b) };
            } catch (e) {}
        }

        function takeSourceFormatSelection() {
            let start = 0, end = 0;
            try {
                start = sourceEditor.selectionStart | 0;
                end = sourceEditor.selectionEnd | 0;
            } catch (e) {}
            // Toolbar focus-steal often collapses to a caret; prefer last non-empty range
            if (start === end && _sourceFormatSel
                && _sourceFormatSel.start !== _sourceFormatSel.end) {
                start = _sourceFormatSel.start | 0;
                end = _sourceFormatSel.end | 0;
            }
            if (start > end) { const t = start; start = end; end = t; }
            return { start: start, end: end };
        }

        /**
         * setRangeText / setSelectionRange often scrolls the caret into view (≈1–2 lines).
         * Preserve scroll so multi-line bold does not disorient mid-document.
         */
        function withSourceScrollPreserved(fn) {
            if (!sourceEditor) { try { return fn(); } catch (e0) { return; } }
            let st = 0, sl = 0;
            try {
                st = sourceEditor.scrollTop || 0;
                sl = sourceEditor.scrollLeft || 0;
            } catch (e1) {}
            let result;
            try { result = fn(); } catch (e2) { result = undefined; }
            function pin() {
                try {
                    sourceEditor.scrollTop = st;
                    sourceEditor.scrollLeft = sl;
                } catch (e3) {}
            }
            pin();
            try { requestAnimationFrame(pin); } catch (e4) { setTimeout(pin, 0); }
            return result;
        }

        function sourceSetRangeTextPreserveScroll(text, start, end, selectMode) {
            withSourceScrollPreserved(function () {
                sourceEditor.setRangeText(text, start, end, selectMode || 'select');
            });
        }

        /** Map visible plain-text offsets to indices in Markdown raw (skip emphasis/link markers). */
        /**
         * Map visible plain-text offsets [plainStart, plainEnd) → raw markdown slice.
         * Skips emphasis/code/link markers so "hybrid" inside **hybrid** maps to the word only.
         */
        function plainRangeToRawOffsets(raw, plainStart, plainEnd) {
            raw = String(raw || '');
            if (plainStart > plainEnd) {
                const t = plainStart; plainStart = plainEnd; plainEnd = t;
            }
            plainStart = Math.max(0, plainStart | 0);
            plainEnd = Math.max(0, plainEnd | 0);

            let i = 0;
            let plain = 0;
            let rStart = null;
            let rEnd = null;

            function skipMarkersOnly() {
                if (i >= raw.length) return false;
                // Strikethrough before single ~ (GFM ~~)
                if (i + 1 < raw.length && raw[i] === '~' && raw[i + 1] === '~') {
                    i += 2;
                    return true;
                }
                if (i + 1 < raw.length && ((raw[i] === '*' && raw[i + 1] === '*') || (raw[i] === '_' && raw[i + 1] === '_'))) {
                    i += 2;
                    return true;
                }
                if (raw[i] === '*' || raw[i] === '_') {
                    i += 1;
                    return true;
                }
                // Opening ` or [ handled below as structured spans (inner text is plain)
                return false;
            }

            function consumeCodeOrLink() {
                if (i >= raw.length) return false;
                if (raw[i] === '`') {
                    i += 1;
                    while (i < raw.length && raw[i] !== '`') {
                        if (rStart === null && plain === plainStart) rStart = i;
                        if (rEnd === null && plain === plainEnd) rEnd = i;
                        if (rStart !== null && rEnd !== null) return true;
                        i++;
                        plain++;
                        if (rEnd === null && plain === plainEnd) rEnd = i;
                    }
                    if (i < raw.length) i += 1;
                    return true;
                }
                if (raw[i] === '[') {
                    const closeB = raw.indexOf(']', i);
                    const openP = closeB >= 0 ? raw.indexOf('(', closeB) : -1;
                    const closeP = openP === closeB + 1 ? raw.indexOf(')', openP) : -1;
                    if (closeB > i && openP === closeB + 1 && closeP > openP) {
                        i += 1;
                        while (i < closeB) {
                            if (rStart === null && plain === plainStart) rStart = i;
                            if (rEnd === null && plain === plainEnd) rEnd = i;
                            if (rStart !== null && rEnd !== null) return true;
                            i++;
                            plain++;
                            if (rEnd === null && plain === plainEnd) rEnd = i;
                        }
                        i = closeP + 1;
                        return true;
                    }
                }
                return false;
            }

            while (i < raw.length && (rStart === null || rEnd === null)) {
                // Skip pure markers first so rStart never lands on **
                while (skipMarkersOnly()) {}
                if (consumeCodeOrLink()) {
                    if (rStart !== null && rEnd !== null) break;
                    continue;
                }
                if (i >= raw.length) break;

                // i is at a visible character
                if (rStart === null && plain === plainStart) rStart = i;
                if (rEnd === null && plain === plainEnd) rEnd = i;
                if (rStart !== null && rEnd !== null) break;

                i++;
                plain++;
                if (rEnd === null && plain === plainEnd) rEnd = i;
            }

            if (rStart === null) rStart = plainStart <= 0 ? 0 : raw.length;
            if (rEnd === null) rEnd = plainEnd >= plain ? raw.length : rStart;
            return { r0: Math.min(rStart, rEnd), r1: Math.max(rStart, rEnd), plainLength: plain };
        }

        function getPlainOffsetsInBlock(block) {
            if (!block) return null;
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && !sel.isCollapsed
                && block.contains(sel.anchorNode) && block.contains(sel.focusNode)) {
                try {
                    const range = sel.getRangeAt(0);
                    const pre = document.createRange();
                    pre.selectNodeContents(block);
                    pre.setEnd(range.startContainer, range.startOffset);
                    const start = pre.toString().length;
                    const end = start + range.toString().length;
                    return { start: start, end: end, text: range.toString() };
                } catch (e) {}
            }
            if (_inlineSelCache && _inlineSelCache.block === block)
                return { start: _inlineSelCache.start, end: _inlineSelCache.end, text: _inlineSelCache.text };
            return null;
        }

        function cacheInlineSelection() {
            if (state.mode === 'source') return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.isCollapsed) return;
            if (!sel.anchorNode || !editor.contains(sel.anchorNode)) return;
            const block = getAncestorBlock(sel.anchorNode);
            if (!block || !block.contains(sel.focusNode)) return;
            const off = getPlainOffsetsInBlock(block);
            if (off && off.start !== off.end) {
                _inlineSelCache = { block: block, start: off.start, end: off.end, text: off.text };
            }
        }

        /**
         * Parse inline markdown → plain text + per-character mark flags.
         * Uses parseInline HTML so Preview and the toggle model share one truth.
         */
        function plainAndMarksFromMarkdown(body) {
            body = String(body == null ? '' : body);
            const htmlStr = typeof parseInline === 'function' ? parseInline(body) : body;
            const plainChars = [];
            const marks = [];
            try {
                if (typeof document !== 'undefined' && document.createElement) {
                    const div = document.createElement('div');
                    div.innerHTML = htmlStr;
                    function walk(node, st) {
                        if (!node) return;
                        if (node.nodeType === 3) {
                            const t = String(node.nodeValue || '');
                            for (let i = 0; i < t.length; i++) {
                                const ch = t.charAt(i);
                                if (ch === '​') continue;
                                plainChars.push(ch);
                                marks.push({
                                    bold: !!st.bold,
                                    italic: !!st.italic,
                                    strike: !!st.strike
                                });
                            }
                            return;
                        }
                        if (node.nodeType !== 1) return;
                        const tag = (node.tagName || '').toLowerCase();
                        const next = {
                            bold: st.bold || tag === 'strong' || tag === 'b',
                            italic: st.italic || tag === 'em' || tag === 'i',
                            strike: st.strike || tag === 'del' || tag === 's' || tag === 'strike'
                        };
                        const kids = node.childNodes;
                        for (let k = 0; k < kids.length; k++) walk(kids[k], next);
                    }
                    walk(div, { bold: false, italic: false, strike: false });
                    const plainJoined = plainChars.join('');
                    for (let i = 0; i < plainJoined.length; i++) {
                        if (/\s/.test(plainJoined.charAt(i))) {
                            marks[i] = { bold: false, italic: false, strike: false };
                        }
                    }
                    return { plain: plainJoined, marks: marks, html: htmlStr };
                }
            } catch (eDom) {}
            const stripped = String(htmlStr).replace(/<[^>]+>/g, '');
            for (let i = 0; i < stripped.length; i++) {
                plainChars.push(stripped.charAt(i));
                marks.push({ bold: false, italic: false, strike: false });
            }
            return { plain: plainChars.join(''), marks: marks, html: htmlStr };
        }

        /**
         * Emit clean inline markdown from plain text + per-character marks.
         * bold+italic uses **_text_** so adjacent runs do not glue into ***** soup.
         */
        function emitInlineMarkdownFromMarks(plain, marks) {
            plain = String(plain == null ? '' : plain);
            if (!marks || !marks.length) return plain;
            function same(a, b) {
                return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike;
            }
            function wrapRun(text, m) {
                if (!text) return '';
                // parseInline requires markers to hug non-space (\S). Keep leading/trailing
                // spaces outside markers so "hello " / " hi" never produce **hello **.
                if (!/\S/.test(text)) return text;
                const lead = (text.match(/^\s*/) || [''])[0];
                const trail = (text.match(/\s*$/) || [''])[0];
                const core = text.slice(lead.length, text.length - trail.length);
                if (!core) return text;
                let s = core;
                if (m.bold && m.italic) s = '***' + s + '***';
                else if (m.bold) s = '**' + s + '**';
                else if (m.italic) s = '*' + s + '*';
                if (m.strike) s = '~~' + s + '~~';
                return lead + s + trail;
            }
            let out = '';
            let i = 0;
            let prevPiece = '';
            while (i < plain.length) {
                const m = marks[i] || { bold: false, italic: false, strike: false };
                let j = i + 1;
                while (j < plain.length && same(marks[j] || {}, m)) j++;
                let piece = wrapRun(plain.slice(i, j), m);
                // Prevent **aa*****bb*** glue across runs (ZWSP skipped on decode).
                if (prevPiece && /[*~]$/.test(prevPiece) && /^[*~]/.test(piece)) {
                    out += '​';
                }
                out += piece;
                prevPiece = piece;
                i = j;
            }
            return out;
        }

        /**
         * Wrap/toggle inline mark around a plain-text range inside one block's Markdown.
         * Bold/italic/strike: decode → toggle per-character marks → emit clean markdown
         * (no marker-soup surgery). Prefixes (# / > / - / 1.) preserved; offsets are plain.
         */
        function applyInlineFormatToRaw(raw, plainStart, plainEnd, type) {
            raw = String(raw || '');
            if (plainStart > plainEnd) {
                const t = plainStart; plainStart = plainEnd; plainEnd = t;
            }
            const pref = raw.match(/^(#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]?\]\s+)?|\d+\.\s+)/);
            const prefix = pref ? pref[0] : '';
            const body = raw.slice(prefix.length);

            function withPrefix(newBody) { return prefix + newBody; }

            if (type === 'bold' || type === 'italic' || type === 'strike') {
                const pm = plainAndMarksFromMarkdown(body);
                const n = pm.plain.length;
                let a = Math.max(0, plainStart | 0);
                let b = Math.max(0, plainEnd | 0);
                if (a > n) a = n;
                if (b > n) b = n;
                if (a > b) { const t = a; a = b; b = t; }

                if (a === b) {
                    const left = emitInlineMarkdownFromMarks(pm.plain.slice(0, a), pm.marks.slice(0, a));
                    const right = emitInlineMarkdownFromMarks(pm.plain.slice(a), pm.marks.slice(a));
                    const empty = type === 'bold' ? '****' : type === 'italic' ? '**' : '~~~~';
                    return withPrefix(left + empty + right);
                }

                const flag = type;
                // Only non-space characters participate (spaces never carry marks).
                const idxs = [];
                for (let i = a; i < b; i++) {
                    if (i < pm.plain.length && !/\s/.test(pm.plain.charAt(i))) idxs.push(i);
                }
                let allOn = idxs.length > 0;
                for (let i = 0; i < idxs.length; i++) {
                    const ix = idxs[i];
                    if (!pm.marks[ix] || !pm.marks[ix][flag]) { allOn = false; break; }
                }
                for (let i = 0; i < idxs.length; i++) {
                    const ix = idxs[i];
                    if (!pm.marks[ix]) pm.marks[ix] = { bold: false, italic: false, strike: false };
                    pm.marks[ix][flag] = !allOn;
                }
                // Whitespace cannot carry emphasis through parseInline — drop flags on spaces.
                for (let i = 0; i < pm.plain.length; i++) {
                    if (/\s/.test(pm.plain.charAt(i))) {
                        pm.marks[i] = { bold: false, italic: false, strike: false };
                    }
                }
                return withPrefix(emitInlineMarkdownFromMarks(pm.plain, pm.marks));
            }

            const offs = plainRangeToRawOffsets(body, plainStart, plainEnd);
            const r0 = offs.r0, r1 = offs.r1;

            if (type === 'link') {
                let inner = body.slice(r0, r1) || 'Link Text';
                const m = inner.match(/^\[([^\]]*)\]\([^)]*\)$/);
                if (m) return withPrefix(body.slice(0, r0) + m[1] + body.slice(r1));
                return withPrefix(body.slice(0, r0) + '[' + inner + '](https://)' + body.slice(r1));
            }

            if (type === 'code') {
                if (plainStart === plainEnd) {
                    return withPrefix(body.slice(0, r0) + '``' + body.slice(r0));
                }
                let inner = body.slice(r0, r1);
                if (/^`([\s\S]*)`$/.test(inner)) {
                    return withPrefix(body.slice(0, r0) + inner.replace(/^`([\s\S]*)`$/, '$1') + body.slice(r1));
                }
                if (r0 >= 1 && body[r0 - 1] === '`' && body[r1] === '`') {
                    return withPrefix(body.slice(0, r0 - 1) + inner + body.slice(r1 + 1));
                }
                return withPrefix(body.slice(0, r0) + '`' + inner + '`' + body.slice(r1));
            }

            return null;
        }

        function tryApplyInlineFormat(type) {
            if (type !== 'bold' && type !== 'italic' && type !== 'code' && type !== 'link' && type !== 'strike') return false;

            // Source mode
            if (state.mode === 'source') {
                if (!sourceEditor) return false;
                const range = takeSourceFormatSelection();
                let start = range.start;
                let end = range.end;
                const full = sourceEditor.value || '';

                if (start === end && type !== 'link') {
                    const markers = type === 'bold' ? '****' : type === 'italic' ? '**' : type === 'strike' ? '~~~~' : '``';
                    const mid = (type === 'bold' || type === 'strike') ? 2 : 1;
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(markers, start, end, 'end');
                    withSourceScrollPreserved(function () {
                        sourceEditor.setSelectionRange(start + mid, start + mid);
                    });
                    resizeSourceEditor();
                    updateStats();
                    HistoryManager.commitEdit();
                    return true;
                }

                // Multi-line: format each hard line (never wrap the whole span in one **…**).
                // Cross-line **…** splits across blocks and produces marker soup like r**ow 2001*.
                if (full.slice(start, end).indexOf('\n') >= 0
                    && (type === 'bold' || type === 'italic' || type === 'strike' || type === 'code')) {
                    let s = start;
                    let e = end;
                    while (s > 0 && full.charAt(s - 1) !== '\n') s--;
                    while (e < full.length && full.charAt(e) !== '\n') e++;
                    const lines = full.substring(s, e).split('\n');
                    const out = lines.map(function (line) {
                        if (!String(line).trim()) return line;
                        return transformRawForFormat(line, type, {});
                    }).join('\n');
                    HistoryManager.beginEdit();
                    // Keep scroll pin: setRangeText('select') otherwise jumps ~1–2 lines
                    sourceSetRangeTextPreserveScroll(out, s, e, 'select');
                    try { _sourceFormatSel = { start: s, end: s + out.length }; } catch (eF) {}
                    resizeSourceEditor();
                    // resize can also nudge; re-pin once more after layout
                    withSourceScrollPreserved(function () {});
                    updateStats();
                    HistoryManager.commitEdit();
                    return true;
                }

                let open = '', close = '';
                if (type === 'bold') { open = '**'; close = '**'; }
                else if (type === 'italic') { open = '*'; close = '*'; }
                else if (type === 'code') { open = '`'; close = '`'; }
                else if (type === 'strike') { open = '~~'; close = '~~'; }
                else if (type === 'link') {
                    const inner = full.slice(start, end) || 'Link Text';
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll('[' + inner + '](https://)', start, end, 'select');
                    resizeSourceEditor();
                    updateStats();
                    HistoryManager.commitEdit();
                    return true;
                }
                let inner = full.slice(start, end);
                let rep;
                if (type === 'bold' && /^\*\*([\s\S]*)\*\*$/.test(inner))
                    rep = inner.replace(/^\*\*([\s\S]*)\*\*$/, '$1');
                else if (type === 'italic' && /^\*([\s\S]*)\*$/.test(inner) && !/^\*\*/.test(inner))
                    rep = inner.replace(/^\*([\s\S]*)\*$/, '$1');
                else if (type === 'code' && /^`([\s\S]*)`$/.test(inner))
                    rep = inner.replace(/^`([\s\S]*)`$/, '$1');
                else if (type === 'strike' && /^~~([\s\S]*)~~$/.test(inner))
                    rep = inner.replace(/^~~([\s\S]*)~~$/, '$1');
                else if (type === 'bold' && start >= 2 && full.slice(start - 2, start) === '**' && full.slice(end, end + 2) === '**') {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 2, end + 2, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    return true;
                } else if (type === 'strike' && start >= 2 && full.slice(start - 2, start) === '~~' && full.slice(end, end + 2) === '~~') {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 2, end + 2, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    return true;
                } else if (type === 'italic' && start >= 1 && full[start - 1] === '*' && full[end] === '*'
                    && (start < 2 || full[start - 2] !== '*') && full[end + 1] !== '*') {
                    HistoryManager.beginEdit();
                    sourceSetRangeTextPreserveScroll(inner, start - 1, end + 1, 'select');
                    resizeSourceEditor(); updateStats(); HistoryManager.commitEdit();
                    return true;
                } else if (type === 'bold' || type === 'italic' || type === 'strike') {
                    // Single-line partial: marks model on that hard line only
                    let lineStart = start;
                    while (lineStart > 0 && full.charAt(lineStart - 1) !== '\n') lineStart--;
                    let lineEnd = start;
                    while (lineEnd < full.length && full.charAt(lineEnd) !== '\n') lineEnd++;
                    const line = full.slice(lineStart, lineEnd);
                    const rawNext = applyInlineFormatToRaw(line, start - lineStart, end - lineStart, type);
                    if (rawNext != null) {
                        HistoryManager.beginEdit();
                        sourceSetRangeTextPreserveScroll(rawNext, lineStart, lineEnd, 'select');
                        resizeSourceEditor();
                        updateStats();
                        HistoryManager.commitEdit();
                        return true;
                    }
                    rep = open + inner + close;
                } else {
                    rep = open + inner + close;
                }
                HistoryManager.beginEdit();
                sourceSetRangeTextPreserveScroll(rep, start, end, 'select');
                resizeSourceEditor();
                updateStats();
                HistoryManager.commitEdit();
                return true;
            }

            // Live Preview: multi-block whole-line inline first
            const multiIdx = getSelectedBlockIndices();
            if (multiIdx.length > 1
                && (type === 'bold' || type === 'italic' || type === 'strike' || type === 'code')) {
                applyFormatInPlaceToSelection(type, false, false);
                return true;
            }

            // Live Preview: single block + partial selection
            let block = null;
            let offsets = null;
            if (_inlineSelCache && _inlineSelCache.block && editor.contains(_inlineSelCache.block)
                && _inlineSelCache.start !== _inlineSelCache.end) {
                block = _inlineSelCache.block;
                offsets = { start: _inlineSelCache.start, end: _inlineSelCache.end, text: _inlineSelCache.text };
            } else {
                const targets = getSelectedBlocks();
                if (targets.length === 1) {
                    block = targets[0];
                    offsets = getPlainOffsetsInBlock(block);
                }
            }
            if (!block || !offsets || offsets.start === offsets.end) return false;

            // Bold / italic / strike: apply on the live DOM first, then serialize → raw.
            // Raw-only applyInlineFormatToRaw fails when the selection sits *inside* a wider
            // ***…*** / **…** span (common after nested toolbar use): Source gains extra **
            // but Preview already looked bold, so nothing appears to change. execCommand
            // toggles the visual marks the user actually sees; tree-walk serialize keeps
            // Source in sync.
            if (type === 'bold' || type === 'italic' || type === 'strike') {
                const prevRaw = block.getAttribute('data-raw') || getBlockRaw(block) || '';
                try { if (editor && editor.focus) editor.focus(); } catch (eF) {}
                selectPlainRangeInBlock(block, offsets.start, offsets.end);
                const cmd = type === 'bold' ? 'bold'
                    : type === 'italic' ? 'italic'
                    : 'strikeThrough';
                let domOk = false;
                try { domOk = document.execCommand(cmd, false, null); } catch (eC) { domOk = false; }

                let next = null;
                try { next = serializeBlockDomToRaw(block); } catch (eS) { next = null; }

                let applied = null;
                if (next != null && next !== prevRaw) {
                    applied = next;
                } else {
                    // execCommand no-op or serialize unchanged → raw marker fallback
                    const rawNext = applyInlineFormatToRaw(prevRaw, offsets.start, offsets.end, type);
                    if (rawNext != null && rawNext !== prevRaw) {
                        applied = rawNext;
                    } else {
                        // Interior of a wider ** / *** / ~~ span: split outer marks
                        const split = splitInteriorInlineFormat(prevRaw, offsets.start, offsets.end, type);
                        if (split != null && split !== prevRaw) applied = split;
                    }
                }
                if (applied == null) {
                    // execCommand may have mutated the DOM without a serializable change —
                    // restore from the pre-click raw so Preview and data-raw stay aligned.
                    try { renderBlockPreview(block, prevRaw); } catch (eR) {}
                    return false;
                }

                HistoryManager.beginEdit();
                writeBlockRaw(block, applied);
                currentActiveBlock = block;
                _selectedFormatBlocks = [block];
                try {
                    block.scrollIntoView({ block: 'nearest' });
                    focusBlock(block, null);
                    selectPlainRangeInBlock(block, offsets.start, offsets.end);
                } catch (e) {}
                updateStats();
                updateOutline();
                HistoryManager.commitEdit();
                return true;
            }

            // code / link: still raw-marker path
            const raw = getBlockRaw(block);
            const next = applyInlineFormatToRaw(raw, offsets.start, offsets.end, type);
            if (next == null || next === raw) return false;

            HistoryManager.beginEdit();
            writeBlockRaw(block, next);
            currentActiveBlock = block;
            _selectedFormatBlocks = [block];
            try {
                block.scrollIntoView({ block: 'nearest' });
                focusBlock(block, null);
                // Reselect the formatted span (plain offsets unchanged for wrap)
                selectPlainRangeInBlock(block, offsets.start, offsets.end);
            } catch (e) {}
            updateStats();
            updateOutline();
            HistoryManager.commitEdit();
            return true;
        }

        /**
         * Match emphasis/strike pairs the same way parseInline does (~~, then ***, **, *),
         * left-to-right nearest close. Used so mid-span toolbar toggles agree with Preview.
         */
        function findInlineMarkPairs(body) {
            body = String(body || '');
            const pairs = [];
            const blocked = new Array(body.length).fill(false);

            function isFree(from, to) {
                for (let i = from; i < to; i++) if (blocked[i]) return false;
                return true;
            }
            function blockRange(from, to) {
                for (let i = from; i < to; i++) blocked[i] = true;
            }

            /** True if body[pos..pos+len) is a standalone marker, not part of a longer *** run. */
            function isStandaloneMarker(pos, marker) {
                const len = marker.length;
                if (pos < 0 || pos + len > body.length) return false;
                if (body.slice(pos, pos + len) !== marker) return false;
                if (marker === '~~') return true;
                // Longest-match: *** wins over ** and *
                if (marker === '**') {
                    if (body.slice(pos, pos + 3) === '***') return false;
                    if (pos > 0 && body.slice(pos - 1, pos + 2) === '***') return false;
                    return true;
                }
                if (marker === '*') {
                    if (body.slice(pos, pos + 2) === '**') return false;
                    if (pos > 0 && body[pos - 1] === '*') return false;
                    return true;
                }
                if (marker === '***') return true;
                return true;
            }

            function matchMarker(marker, kind, blockInterior) {
                const len = marker.length;
                let i = 0;
                while (i <= body.length - len) {
                    if (blocked[i] || !isStandaloneMarker(i, marker)) {
                        i++;
                        continue;
                    }

                    let j = i + len;
                    let found = false;
                    while (j <= body.length - len) {
                        if (blocked[j] || !isStandaloneMarker(j, marker)) {
                            j++;
                            continue;
                        }
                        const inner = body.slice(i + len, j);
                        // Same hug rules as parseInline: non-empty, non-space at ends.
                        // Only delimiters must be free — interior may hold ~~ (parseInline
                        // applies strike first, then *** across the del content).
                        if (inner.length && !/^\s/.test(inner) && !/\s$/.test(inner)
                            && isFree(i, i + len) && isFree(j, j + len)) {
                            pairs.push({
                                kind: kind,
                                marker: marker,
                                open: i,
                                close: j,
                                len: len
                            });
                            blockRange(i, i + len);
                            blockRange(j, j + len);
                            // *** / ** consume their interior for lower-priority * markers
                            // (same as parseInline replacing the span before * runs).
                            if (blockInterior) blockRange(i + len, j);
                            i = j + len;
                            found = true;
                            break;
                        }
                        j++;
                    }
                    if (!found) i++;
                }
            }

            // Order must match parseInline
            matchMarker('~~', 'strike', false);
            matchMarker('***', 'bolditalic', true);
            matchMarker('**', 'bold', true);
            matchMarker('*', 'italic', false);
            return pairs;
        }

        /**
         * Toggle bold/italic/strike when the selection sits inside a wider mark span
         * (markers do not hug the range). Splits the enclosing pair so Preview and Source
         * agree — e.g. ***preBBBsuf*** + unbold BBB → ***pre*** *BBB* ***suf*** (BBB not bold).
         */
        function splitInteriorInlineFormat(raw, plainStart, plainEnd, type) {
            raw = String(raw || '');
            if (plainStart > plainEnd) {
                const t = plainStart; plainStart = plainEnd; plainEnd = t;
            }
            if (plainStart === plainEnd) return null;
            if (type !== 'bold' && type !== 'italic' && type !== 'strike') return null;

            const pref = raw.match(/^(#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]?\]\s+)?|\d+\.\s+)/);
            const prefix = pref ? pref[0] : '';
            const body = raw.slice(prefix.length);
            const off = plainRangeToRawOffsets(body, plainStart, plainEnd);
            const r0 = off.r0, r1 = off.r1;
            if (r0 >= r1) return null;

            const pairs = findInlineMarkPairs(body);
            // Pairs that strictly enclose the selection (content strictly inside markers)
            const covering = pairs.filter(function (p) {
                return p.open + p.len <= r0 && r1 <= p.close;
            });

            function coversType(p) {
                if (type === 'bold') return p.kind === 'bold' || p.kind === 'bolditalic';
                if (type === 'italic') return p.kind === 'italic' || p.kind === 'bolditalic';
                if (type === 'strike') return p.kind === 'strike';
                return false;
            }

            const hit = covering.filter(coversType);
            // Prefer innermost covering pair of this type
            hit.sort(function (a, b) {
                return (b.open - a.open) || (a.close - b.close);
            });

            const mid = body.slice(r0, r1);
            if (!mid.length) return null;

            // --- Toggle OFF: split enclosing pair ---
            if (hit.length) {
                const p = hit[0];
                const pre = body.slice(p.open + p.len, r0);
                const suf = body.slice(r1, p.close);
                const head = body.slice(0, p.open);
                const tail = body.slice(p.close + p.len);

                function hasVisibleText(s) {
                    return String(s || '')
                        .replace(/~~/g, '')
                        .replace(/\*\*\*/g, '')
                        .replace(/\*\*/g, '')
                        .replace(/\*/g, '')
                        .replace(/`/g, '')
                        .replace(/\s+/g, '')
                        .length > 0;
                }
                // Entire visible span (pre/suf empty or markers only) → not a mid-span split
                if (!hasVisibleText(pre) && !hasVisibleText(suf)) {
                    return null;
                }

                function joinSegments(segs) {
                    return segs.filter(function (s) { return s != null && s !== ''; }).join('');
                }

                // Unbold inside ***: keep italic on the middle only
                if (type === 'bold' && p.kind === 'bolditalic') {
                    return prefix + joinSegments([
                        head,
                        pre ? '***' + pre + '***' : '',
                        '*' + mid + '*',
                        suf ? '***' + suf + '***' : '',
                        tail
                    ]);
                }
                // Unitalic inside ***: keep bold on the middle only
                if (type === 'italic' && p.kind === 'bolditalic') {
                    return prefix + joinSegments([
                        head,
                        pre ? '***' + pre + '***' : '',
                        '**' + mid + '**',
                        suf ? '***' + suf + '***' : '',
                        tail
                    ]);
                }
                // Unbold inside **, unitalic inside *, unstrike inside ~~
                const m = p.marker;
                return prefix + joinSegments([
                    head,
                    pre ? m + pre + m : '',
                    mid,
                    suf ? m + suf + m : '',
                    tail
                ]);
            }

            // --- Toggle ON: wrap selection (not already covered by this type) ---
            let open = '', close = '';
            if (type === 'bold') { open = '**'; close = '**'; }
            else if (type === 'italic') { open = '*'; close = '*'; }
            else if (type === 'strike') { open = '~~'; close = '~~'; }
            else return null;
            return prefix + body.slice(0, r0) + open + mid + close + body.slice(r1);
        }

        function selectPlainRangeInBlock(block, plainStart, plainEnd) {
            // Best-effort: walk text nodes in rendered block
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
            let count = 0;
            let startNode = null, startOff = 0, endNode = null, endOff = 0;
            let n;
            while ((n = walker.nextNode())) {
                const len = n.nodeValue.length;
                if (!startNode && count + len >= plainStart) {
                    startNode = n;
                    startOff = plainStart - count;
                }
                if (count + len >= plainEnd) {
                    endNode = n;
                    endOff = plainEnd - count;
                    break;
                }
                count += len;
            }
            if (startNode && endNode) {
                const range = document.createRange();
                range.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
                range.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                cacheInlineSelection();
            }
        }

        function getAncestorBlock(node) {
            while (node && node !== document && node !== editor) {
                if (node.classList && node.classList.contains('block')) return node;
                node = node.parentNode;
            }
            return null;
        }

        let currentActiveBlock = null;
        let _lastCaretLine = 1;

        /** Center active block / source caret line in #main-container (typewriter mode). */
        function applyTypewriterScroll(force) {
            if (!force && !state.typewriterMode) return;
            if (!mainContainer) return;
            try {
                if (state.mode === 'source' && sourceEditor) {
                    const pos = sourceEditor.selectionStart || 0;
                    const before = sourceEditor.value.substring(0, pos);
                    const line = Math.max(1, before.split(/\r?\n/).length);
                    scrollSourceToHardLine(line, false);
                    return;
                }
                const block = currentActiveBlock
                    || (document.activeElement && document.activeElement.classList
                        && document.activeElement.classList.contains('block') ? document.activeElement : null);
                if (!block || !editor.contains(block)) return;
                const cRect = mainContainer.getBoundingClientRect();
                const bRect = block.getBoundingClientRect();
                const delta = (bRect.top + bRect.height / 2) - (cRect.top + cRect.height / 2);
                if (force || Math.abs(delta) > 8) {
                    mainContainer.scrollTop += delta;
                }
            } catch (e) {}
        }

        /** Total document lines (same basis as status "total"). */
        function getTotalLineCount(precomputedContent) {
            const content = precomputedContent != null ? precomputedContent : getMarkdownContent();
            if (!content || content.length === 0) return 1;
            return content.split(/\r?\n/).length;
        }

        /**
         * Lines in one block raw (min 1 for empty blocks so line numbers stay contiguous).
         */
        function linesInBlockRaw(raw) {
            const s = String(raw == null ? '' : raw);
            if (!s.length) return 1;
            let n = 1;
            for (let i = 0; i < s.length; i++) {
                if (s.charCodeAt(i) === 10) n++;
            }
            return n;
        }

        /**
         * 1-based line of the first line of model block `blockIndex` (0-based).
         */
        function modelBlockStartLine(blockIndex) {
            if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks) return 1;
            let line = 1;
            const n = Math.min(blockIndex | 0, DocumentModel.blocks.length);
            for (let i = 0; i < n; i++) {
                line += linesInBlockRaw(DocumentModel.blocks[i] ? DocumentModel.blocks[i].raw : '');
            }
            return line;
        }

        /**
         * 1-based caret line in the full document (for status bar). Always 1..total.
         * Under virtualization, only a window of .block nodes is mounted — counting those
         * alone reported "Ln 73/4532" while viewing the last line. Prefer model indices.
         */
        function getCaretLineNumber(precomputedContent) {
            try {
                const total = getTotalLineCount(precomputedContent);
                let caret = 1;

                if (state.mode === 'source' && sourceEditor) {
                    const pos = sourceEditor.selectionStart || 0;
                    caret = sourceEditor.value.substring(0, pos).split(/\r?\n/).length || 1;
                } else {
                    const sel = window.getSelection();
                    const selInEditor = !!(sel && sel.anchorNode && editor
                        && editor.contains(sel.anchorNode));
                    let active = currentActiveBlock;
                    if (selInEditor) {
                        active = getAncestorBlock(sel.anchorNode) || active;
                    }

                    // Virt without a caret in the editor: report the line at viewport center
                    // (first mounted block would read as window-start, e.g. 4474/4532 at bottom).
                    if (typeof DocumentModel !== 'undefined' && DocumentModel.virtEnabled
                        && DocumentModel.blocks && DocumentModel.blocks.length && !selInEditor) {
                        const idx = modelIndexAtViewportCenter();
                        caret = modelBlockStartLine(idx);
                    } else if (!active || !editor || !editor.contains(active)) {
                        return 1;
                    } else {
                        let within = 0;
                        const rawAttr = active.hasAttribute('data-raw')
                            ? active.getAttribute('data-raw')
                            : (active.innerText || '');
                        const blockLines = linesInBlockRaw(rawAttr);
                        if (selInEditor && sel.rangeCount && active.contains(sel.anchorNode)) {
                            try {
                                const r = document.createRange();
                                r.selectNodeContents(active);
                                r.setEnd(sel.anchorNode, sel.anchorOffset);
                                within = r.toString().split(/\r?\n/).length - 1;
                                if (within < 0) within = 0;
                                if (within >= blockLines) within = blockLines - 1;
                            } catch (e) { within = 0; }
                        }

                        let mi = -1;
                        try {
                            if (typeof DocumentModel !== 'undefined') {
                                mi = DocumentModel.modelIndexOfEl(active);
                            }
                        } catch (eMi) { mi = -1; }

                        if (mi >= 0 && typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                            && DocumentModel.blocks.length) {
                            caret = modelBlockStartLine(mi) + within;
                        } else {
                            const blocks = editor.querySelectorAll('.block');
                            let line = 1;
                            for (let i = 0; i < blocks.length; i++) {
                                const b = blocks[i];
                                const raw = b.hasAttribute('data-raw')
                                    ? b.getAttribute('data-raw') : (b.innerText || '');
                                const bl = linesInBlockRaw(raw);
                                if (b === active) {
                                    caret = line + within;
                                    break;
                                }
                                line += bl;
                            }
                        }
                    }
                }

                if (caret < 1) caret = 1;
                if (caret > total) caret = total;
                return caret;
            } catch (e) {
                return 1;
            }
        }

        /**
         * 1-based hard line from markdown string + char offset (canonical for stickiness).
         */
        function lineFromMarkdownOffset(md, offset) {
            md = String(md == null ? '' : md);
            let off = offset | 0;
            if (off < 0) off = 0;
            if (off > md.length) off = md.length;
            let line = 1;
            for (let i = 0; i < off; i++) {
                if (md.charCodeAt(i) === 10) line++;
            }
            return line;
        }

        /**
         * Map 1-based hard line → model block index and line-within-block (0-based).
         */
        function modelLocationFromDocumentLine(line1Based) {
            const blocks = (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
                ? DocumentModel.blocks : [];
            if (!blocks.length) return { blockIndex: 0, within: 0 };
            let remaining = Math.max(1, line1Based | 0);
            for (let bi = 0; bi < blocks.length; bi++) {
                const bl = linesInBlockRaw(blocks[bi].raw);
                if (remaining <= bl) {
                    return { blockIndex: bi, within: remaining - 1 };
                }
                remaining -= bl;
            }
            const last = blocks.length - 1;
            return { blockIndex: last, within: Math.max(0, linesInBlockRaw(blocks[last].raw) - 1) };
        }

        /**
         * Last known document line while the user was actually editing.
         * WPF Preview/Source button steals focus BEFORE cmd:toggle_mode runs; the textarea
         * then often reports selectionStart=0 → capture would wrongly return line 1.
         * We freeze the line on every real edit/selection while focused.
         */
        let _stickyLineCache = 1;

        function rememberStickyLine(line) {
            const n = line | 0;
            if (n >= 1) {
                _stickyLineCache = n;
                _lastCaretLine = n;
            }
        }

        /**
         * Host Preview/Source buttons often zero selectionStart while focus still
         * reports the textarea. Never let a poisoned "offset 0 → line 1" clobber a
         * higher sticky line the user actually had.
         */
        function isPoisonedSourceLineOne(liveLine, pos) {
            const live = liveLine | 0;
            const cache = _stickyLineCache | 0;
            if (live > 1) return false;
            if (cache <= 1) return false;
            // offset 0 with a higher cached line is the classic focus-steal poison
            if ((pos | 0) === 0) return true;
            return false;
        }

        /** Update cache only while the source textarea still has focus. */
        function rememberStickyFromSourceIfFocused() {
            if (state.mode !== 'source' || !sourceEditor) return;
            try {
                if (document.activeElement !== sourceEditor) return;
                const pos = sourceEditor.selectionStart | 0;
                const live = lineFromMarkdownOffset(sourceEditor.value || '', pos);
                if (isPoisonedSourceLineOne(live, pos)) return; // keep cache
                rememberStickyLine(live);
            } catch (e) {}
        }

        /** Update cache from preview selection/active block while focus is in the editor. */
        function rememberStickyFromPreviewIfFocused() {
            if (state.mode === 'source') return;
            try {
                const sel = window.getSelection();
                const inEd = sel && sel.anchorNode && editor && editor.contains(sel.anchorNode);
                if (!inEd && !(currentActiveBlock && editor && editor.contains(currentActiveBlock))) return;
                const line = captureStickyDocumentLineLive();
                // Do not collapse sticky to 1 when selection was destroyed by chrome
                if ((line | 0) <= 1 && (_stickyLineCache | 0) > 1 && !inEd) return;
                if (line >= 1) rememberStickyLine(line);
            } catch (e) {}
        }

        /**
         * Live read of sticky line (no focus-steal protection). Used while focused.
         */
        function captureStickyDocumentLineLive() {
            if (state.mode === 'source' && sourceEditor) {
                const pos = sourceEditor.selectionStart | 0;
                return lineFromMarkdownOffset(sourceEditor.value || '', pos);
            }
            let mi = -1;
            let within = 0;
            const sel = window.getSelection();
            if (sel && sel.anchorNode && editor && editor.contains(sel.anchorNode)) {
                const b = getAncestorBlock(sel.anchorNode);
                if (b) {
                    mi = (typeof DocumentModel !== 'undefined')
                        ? DocumentModel.modelIndexOfEl(b) : -1;
                    if (mi >= 0 && sel.rangeCount) {
                        try {
                            const raw = b.getAttribute('data-raw') || '';
                            const blockLines = linesInBlockRaw(raw);
                            const r = document.createRange();
                            r.selectNodeContents(b);
                            r.setEnd(sel.anchorNode, sel.anchorOffset);
                            within = r.toString().split(/\r?\n/).length - 1;
                            if (within < 0) within = 0;
                            if (within >= blockLines) within = blockLines - 1;
                        } catch (eW) { within = 0; }
                    }
                }
            }
            if (mi < 0 && currentActiveBlock && editor && editor.contains(currentActiveBlock)) {
                mi = (typeof DocumentModel !== 'undefined')
                    ? DocumentModel.modelIndexOfEl(currentActiveBlock) : -1;
            }
            if (mi < 0) return Math.max(1, _stickyLineCache | 0);
            return modelBlockStartLine(mi) + within;
        }

        /**
         * Line to restore on mode switch. Prefer frozen sticky cache when live caret
         * looks like focus-steal poison (selectionStart 0 → line 1).
         */
        function captureStickyDocumentLine() {
            try {
                const frozen = Math.max(1, _stickyLineCache | 0, _lastCaretLine | 0);
                if (state.mode === 'source' && sourceEditor) {
                    if (document.activeElement === sourceEditor) {
                        const pos = sourceEditor.selectionStart | 0;
                        const live = captureStickyDocumentLineLive();
                        if (isPoisonedSourceLineOne(live, pos)) {
                            return frozen;
                        }
                        rememberStickyLine(live);
                        return live;
                    }
                    // Focus already gone (toolbar/mode button) → frozen cache
                    return frozen;
                }
                // Preview: if selection still in editor, live; else cache
                const sel = window.getSelection();
                const inEd = sel && sel.anchorNode && editor && editor.contains(sel.anchorNode);
                if (inEd || (document.activeElement === editor
                    || (editor && editor.contains(document.activeElement)))) {
                    const live = captureStickyDocumentLineLive();
                    // Chrome-destroyed selection often reports block 0 / line 1
                    if ((live | 0) <= 1 && frozen > 1 && !inEd) return frozen;
                    if ((live | 0) <= 1 && frozen > 1) {
                        // focused but live collapsed — keep frozen for mode switch safety
                        // (user truly on L1 already has frozen === 1)
                        return frozen;
                    }
                    rememberStickyLine(live);
                    return live;
                }
                return frozen;
            } catch (e) {
                return Math.max(1, _stickyLineCache | 0, _lastCaretLine | 0);
            }
        }

        /**
         * Scroll/mount so model block `blockIndex` is VISIBLE in #main-container.
         * Height-map estimates (prefixHeight) often overshoot: status can show Ln N
         * while the block sits above the viewport. After estimate+mount, snap with
         * getBoundingClientRect so the block top lands ~topPad px below the container top.
         * @returns {Element|null} mounted block element if found
         */
        function ensureModelBlockVisible(blockIndex, options) {
            options = options || {};
            const pad = (options.topPad != null) ? (options.topPad | 0) : 48;
            if (!mainContainer || !editor || typeof DocumentModel === 'undefined'
                || !DocumentModel.blocks || !DocumentModel.blocks.length) {
                return null;
            }
            let bi = blockIndex | 0;
            if (bi < 0) bi = 0;
            if (bi >= DocumentModel.blocks.length) bi = DocumentModel.blocks.length - 1;

            function queryEl() {
                return editor.querySelector('.block[data-model-index="' + bi + '"]');
            }

            function seedFromHeightMap() {
                try {
                    const isTwoCol = isPaginatedLayout();
                    if (isTwoCol) {
                        const el = elementForModelIndex(bi);
                        const pageForBlock = twoColPageOfElement(el);
                        if (pageForBlock !== null) {
                            editor.scrollLeft = pageForBlock * twoColPageWidth();
                            currentTwoColPage = pageForBlock;
                            window.showDebugTelemetry('ensureVisible: 2col seed page=' + pageForBlock +
                                ' scrollLeft=' + editor.scrollLeft);
                        }
                        return;
                    }
                    DocumentModel.ensureHeights();
                    const y = Math.max(0, DocumentModel.prefixHeight(bi) - pad);
                    window.showDebugTelemetry('ensureVisible: seeding scroll to ' + y);
                    mainContainer.scrollTop = y;
                } catch (eS) { window.showDebugTelemetry('ensureVisible: seed threw ' + eS.message); }
                if (DocumentModel.virtEnabled) {
                    // Lock pin to target block — do not re-anchor from noisy scrollTop
                    try {
                        window.showDebugTelemetry('ensureVisible: calling mountVirtWindow anchorIndex=' + bi);
                        mountVirtWindow(true, { anchorIndex: bi, anchorOffset: -pad });
                    } catch (eM) {}
                }
            }

            function snapOnce(el) {
                if (!el) return 9999;
                try {
                    if (el.offsetHeight > 12) {
                        DocumentModel.setMeasuredHeight(bi, el.offsetHeight);
                    }
                } catch (eH) {}
                try {
                    const isTwoCol = isPaginatedLayout();
                    if (isTwoCol) {
                        const pg = twoColPageOfElement(el);
                        if (pg === null) return 0;
                        const target = pg * twoColPageWidth();
                        const delta = target - (editor.scrollLeft || 0);
                        editor.scrollLeft = target;
                        currentTwoColPage = pg;
                        return delta;
                    } else {
                        const rect = el.getBoundingClientRect();
                        const cRect = mainContainer.getBoundingClientRect();
                        // Desired: block top just below the visible top (pad)
                        const delta = rect.top - (cRect.top + pad);
                        if (Math.abs(delta) < 3) return 0;
                        mainContainer.scrollTop = Math.max(0, (mainContainer.scrollTop || 0) + delta);
                        if (DocumentModel.virtEnabled) {
                            try {
                                mountVirtWindow(true, { anchorIndex: bi, anchorOffset: -pad });
                            } catch (eV) {}
                        }
                        return delta;
                    }
                } catch (eSnap) {
                    return 9999;
                }
            }

            // 1) Estimate → mount (virt) so the block is hopefully in the window
            seedFromHeightMap();

            // 2) Geometric snap loop: measure, correct scroll, remount if virt
            //    (remount remeasures heights/spacers which can shift layout again)
            let el = queryEl();
            for (let iter = 0; iter < 6; iter++) {
                if (!el) {
                    seedFromHeightMap();
                    el = queryEl();
                    if (!el) break;
                }
                const delta = snapOnce(el);
                el = queryEl();
                if (Math.abs(delta) < 3) break;
            }

            try { clampMainScroll(); } catch (eC) {}
            el = queryEl();

            // 3) Last resort: if still fully off-screen, start-align then re-snap
            //    Skip for 2-col — getBoundingClientRect and scrollIntoView are
            //    broken for CSS overflow columns; the seed+snap above already handled it.
            if (el && !(isPaginatedLayout())) {
                try {
                    const r = el.getBoundingClientRect();
                    const c = mainContainer.getBoundingClientRect();
                    const fullyAbove = r.bottom < c.top + 4;
                    const fullyBelow = r.top > c.bottom - 4;
                    if (fullyAbove || fullyBelow) {
                        try {
                            el.scrollIntoView({ block: 'start', behavior: 'auto' });
                        } catch (eSi) {}
                        // scrollIntoView may use a different scroller — force mainContainer
                        try {
                            const r2 = el.getBoundingClientRect();
                            const c2 = mainContainer.getBoundingClientRect();
                            mainContainer.scrollTop = Math.max(
                                0, (mainContainer.scrollTop || 0) + (r2.top - c2.top - pad));
                        } catch (e2) {}
                        if (DocumentModel.virtEnabled) {
                            try { mountVirtWindow(true); } catch (eM2) {}
                        }
                        el = queryEl();
                        if (el) snapOnce(el);
                        try { clampMainScroll(); } catch (eC2) {}
                        el = queryEl();
                    }
                } catch (eLast) {}
            }
            return el || queryEl();
        }

        /**
         * Put the user on hard line `line1Based` in the CURRENT mode and leave the caret there
         * so the next captureStickyDocumentLine() returns the same number.
         */
        function restoreStickyDocumentLine(line1Based) {
            let line = Math.max(1, line1Based | 0);
            rememberStickyLine(line);
            try {
                if (state.mode === 'source' && sourceEditor) {
                    const total = countHardLines(sourceEditor.value || '');
                    if (line > total) line = total;
                    rememberStickyLine(line);
                    // Source text is authoritative — drop stale preview cache so stats
                    // do not clamp Ln 16 → Ln 11 against an old short document.
                    _contentCache = sourceEditor.value || '';
                    resizeSourceEditor();
                    scrollSourceToHardLine(line, true);
                    try { updateStatsNow({ forceCaretLine: line }); } catch (eU) {}
                    return;
                }
                // Preview
                if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks
                    || !DocumentModel.blocks.length || !mainContainer) {
                    try { updateStatsNow({ forceCaretLine: line }); } catch (eEarly) {}
                    return;
                }
                const totalLines = (function () {
                    let t = 0;
                    for (let i = 0; i < DocumentModel.blocks.length; i++) {
                        t += linesInBlockRaw(DocumentModel.blocks[i].raw);
                    }
                    return Math.max(1, t);
                })();
                if (line > totalLines) line = totalLines;
                rememberStickyLine(line);
                const loc = modelLocationFromDocumentLine(line);
                const bi = loc.blockIndex;
                window.showDebugTelemetry('restoreSticky: line=' + line + ' maps to blockIndex=' + bi);
                // Never trust prefixHeight alone for visual restore — estimates overshoot
                // and leave Ln N focused/status-correct but scrolled off-screen above.
                const el = ensureModelBlockVisible(bi, { topPad: 48 });
                if (el) {
                    window.showDebugTelemetry('restoreSticky: ensureModelBlockVisible returned el, setting focus');
                    currentActiveBlock = el;
                    try {
                        // Focus editor + caret so status Ln and next capture see this block
                        focusBlock(el, 0);
                    } catch (eF) {}
                    // Focus/caret can nudge scroll in WebView2 — re-snap once
                    try {
                        const r = el.getBoundingClientRect();
                        const c = mainContainer.getBoundingClientRect();
                        if (r.bottom < c.top + 8 || r.top > c.bottom - 8 || r.top < c.top - 2) {
                            ensureModelBlockVisible(bi, { topPad: 48 });
                        }
                    } catch (eRe) {}
                }
                // Force status to sticky line — getCaretLineNumber often returns 1 right
                // after mode switch before selection settles.
                try { updateStatsNow({ forceCaretLine: line }); } catch (eU2) {}
            } catch (e) {}
        }

        // Back-compat aliases used elsewhere
        function getScrollAnchorLine() { return captureStickyDocumentLine(); }
        function scrollToDocumentLine(line1Based) { restoreStickyDocumentLine(line1Based); }
        function modelIndexAtViewportCenter() {
            if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks || !DocumentModel.blocks.length) {
                return 0;
            }
            try {
                let isTwoCol = isPaginatedLayout();
                
                // --- 2-col: read the block positions the browser produced, rather than
                //     simulating the column breaker. The simulation this replaces walked
                //     offsetHeight to guess which block began the visible left column; it
                //     drifted from the real layout over a long document, which is what made
                //     leaving and re-entering 2-column land pages earlier than it started.
                //     Rects are dependable here: virtualisation is off in 2-column mode, so
                //     every block is mounted and positioned. ---
                if (isTwoCol) {
                    const mi = topLeftModelIndexTwoCol();
                    if (mi >= 0) {
                        window.showDebugTelemetry('modelIndex: 2col topLeft rect mi=' + mi +
                            ' page=' + (currentTwoColPage || 0));
                        return mi;
                    }
                    window.showDebugTelemetry('modelIndex: 2col topLeft rect found nothing');
                }
                
                // --- 1-col: fast probe near the TOP of the viewport (not the center)
                //     so the anchor = first visible line the user sees. ---
                // Measured from the scroll container, not the window. A hardcoded y=60 in
                // window coordinates lands on the toolbar/tab strip rather than inside the
                // document, so elementFromPoint found no block and the fallback below
                // measured distance from a point outside the viewport -- which selected a
                // block already scrolled off the top. Leaving 2-column then returning
                // therefore anchored several blocks early, enough to land a page back.
                const _cRect = mainContainer.getBoundingClientRect();
                let cy = _cRect.top + 8;
                let cx = _cRect.left + (_cRect.width / 2);
                let pts = [];
                for (let ox of [0, 20, 60, -20]) {
                    for (let oy of [0, 20, 40]) {
                        pts.push([cx + ox, cy + oy]);
                    }
                }
                for (let i = 0; i < pts.length; i++) {
                    let el = document.elementFromPoint(pts[i][0], pts[i][1]);
                    if (el) {
                        let block = el.closest('.block');
                        if (block) {
                            let mi = DocumentModel.modelIndexOfEl(block);
                            if (mi >= 0) {
                                window.showDebugTelemetry('modelIndex: topLeft probe mi=' + mi + ' y=' + pts[i][1]);
                                return mi;
                            }
                        }
                    }
                }

                // 2. Robust probe
                let bestBlock = null;
                let bestDist = Infinity;
                let blocks = editor ? editor.querySelectorAll('.block') : [];
                for (let i = 0; i < blocks.length; i++) {
                    let r = blocks[i].getBoundingClientRect();
                    if (r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight) {
                        let dx = 0, dy = 0;
                        if (cx < r.left) dx = r.left - cx;
                        else if (cx > r.right) dx = cx - r.right;
                        if (cy < r.top) dy = r.top - cy;
                        else if (cy > r.bottom) dy = cy - r.bottom;
                        let dist = dx * dx + dy * dy;
                        
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestBlock = blocks[i];
                            if (dist === 0) break;
                        }
                    }
                }
                
                if (bestBlock) {
                    let mi = DocumentModel.modelIndexOfEl(bestBlock);
                    if (mi >= 0) {
                        window.showDebugTelemetry('modelIndex: robust probe found ' + mi);
                        return mi;
                    }
                }
            } catch (e) {
                window.showDebugTelemetry('modelIndex: threw exception ' + e.message);
            }
            
            const active = currentActiveBlock;
            if (active) {
                const mi = DocumentModel.modelIndexOfEl(active);
                if (mi >= 0) {
                    window.showDebugTelemetry('modelIndex: returning currentActiveBlock mi=' + mi);
                    return mi;
                }
            }

            if (DocumentModel.virtEnabled && mainContainer) {
                DocumentModel.ensureHeights();
                const midY = (mainContainer.scrollTop || 0) + (mainContainer.clientHeight || 0) / 2;
                let idx = DocumentModel.indexAtScrollTop(midY);
                if (idx < 0) idx = 0;
                if (idx >= DocumentModel.blocks.length) idx = DocumentModel.blocks.length - 1;
                const max = Math.max(0, mainContainer.scrollHeight - mainContainer.clientHeight);
                if (max > 0 && (mainContainer.scrollTop || 0) >= max - 2) {
                    idx = DocumentModel.blocks.length - 1;
                }
                window.showDebugTelemetry('modelIndex: returning virt midY idx=' + idx);
                return idx;
            }
            window.showDebugTelemetry('modelIndex: returning 0 fallback');
            return 0;
        }

        function updateCaretLineStatus() {
            const line = getCaretLineNumber();
            if (line === _lastCaretLine) return;
            _lastCaretLine = line;
            // Piggy-back on stats so the host updates "Ln X" without a new protocol
            updateStats();
        }

        function updateActiveBlock() {
            if (state.mode === 'source') {
                updateCaretLineStatus();
                if (state.typewriterMode) applyTypewriterScroll(false);
                return;
            }
            const sel = window.getSelection();
            let newActive = null;
            if (sel && sel.anchorNode && editor.contains(sel.anchorNode)) {
                newActive = getAncestorBlock(sel.anchorNode);
            }
            if (!newActive && (document.activeElement === editor || editor.contains(document.activeElement)) && editor.children.length > 0) {
                newActive = currentActiveBlock || editor.lastElementChild;
            }

            if (currentActiveBlock !== newActive) {
                if (currentActiveBlock && currentActiveBlock.classList && editor.contains(currentActiveBlock)) {
                    currentActiveBlock.classList.remove('focused');
                    if (state.revealOnFocus) {
                        const raw = currentActiveBlock.getAttribute('data-raw') || currentActiveBlock.innerText || '';
                        currentActiveBlock.setAttribute('data-raw', raw);
                        renderBlockPreview(currentActiveBlock, raw);
                    }
                }
                currentActiveBlock = newActive;
                if (currentActiveBlock && currentActiveBlock.classList && editor.contains(currentActiveBlock)) {
                    currentActiveBlock.classList.add('focused');
                    if (state.revealOnFocus) {
                        const raw = currentActiveBlock.getAttribute('data-raw') || '';
                        if (currentActiveBlock.innerText !== raw) currentActiveBlock.innerText = raw;
                    }
                    if (state.typewriterMode) applyTypewriterScroll(true);
                }
                updateStats();
                updateOutline();
            } else {
                updateCaretLineStatus();
                if (state.typewriterMode) applyTypewriterScroll(false);
            }
        }

        function focusBlock(block, offset = null) {
            if (!block) return;
            editor.focus();
            if (offset !== null) {
                try { setCaretAtOffset(block, offset); } catch(e) {}
            }
            updateActiveBlock();
        }

        document.addEventListener('selectionchange', () => {
            if (state.mode === 'source' && document.activeElement === sourceEditor) {
                rememberStickyFromSourceIfFocused();
                updateCaretLineStatus();
                // Selection size can change without line change — refresh sel word count
                updateStats(false);
                if (state.typewriterMode) applyTypewriterScroll(false);
                return;
            }
            // If focus left the editor, freeze format indices (toolbar path) — do not
            // overwrite with the destroyed selection WebView reports on blur.
            const sel = window.getSelection();
            const inEditor = sel && sel.anchorNode && editor && editor.contains(sel.anchorNode);
            if (!inEditor && state.mode !== 'source') {
                freezeFormatSelection();
                // Toolbar blur: selection may be gone — refresh sel counts without reserializing
                updateStats(false);
                return;
            }
            if (state.mode !== 'source' && (document.activeElement === editor || editor.contains(document.activeElement) || inEditor)) {
                if (!_formatSelectionFrozen) {
                    cacheSelectedBlocks();
                    cacheInlineSelection();
                }
                updateActiveBlock();
                rememberStickyFromPreviewIfFocused();
                updateStats(false);
            }
        });
        editor.addEventListener('focus', function () {
            // Do NOT clear freeze here — applyFormatting re-focuses the editor after
            // toolbar clicks; unfreezing early re-enabled live (destroyed) selection.
            updateActiveBlock();
        });
        // Snapshot selection on real user gestures (before toolbar can steal focus)
        editor.addEventListener('mousedown', function () {
            // CRITICAL: capture full document HERE, before drag-select corrupts data-raw.
            // Without this, multi-select → bullet reloads from empty and wipes the doc.
            try { refreshLastGoodDocRaws(); } catch (e) {}
            _formatSelectionFrozen = false;
            _selectedFormatRaws = {};
        }, true);
        // Keyboard multi-select (Shift+Arrow): snapshot while still collapsed / first extend
        editor.addEventListener('keydown', function (e) {
            if (!e.shiftKey) return;
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft'
                && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End'
                && e.key !== 'PageUp' && e.key !== 'PageDown') return;
            try {
                const sel = window.getSelection();
                if (sel && sel.isCollapsed) refreshLastGoodDocRaws();
            } catch (err) {}
        }, true);
        editor.addEventListener('mouseup', function () {
            snapshotFormatSelectionFromEditor();
            cacheInlineSelection();
            updateActiveBlock();
        });
        editor.addEventListener('keyup', function () {
            if (!_formatSelectionFrozen) {
                snapshotFormatSelectionFromEditor();
                cacheInlineSelection();
            }
            updateActiveBlock();
        });
        editor.addEventListener('click', function () {
            if (!_formatSelectionFrozen) {
                snapshotFormatSelectionFromEditor();
                cacheInlineSelection();
            }
            updateActiveBlock();
        });
        editor.addEventListener('focusout', function () {
            // FREEZE ONLY — do not re-snapshot. WebView has often already destroyed the
            // multi-block range; re-reading it overwrote good mouseup indices/raws and
            // multi-select list convert wiped lines (regression).
            freezeFormatSelection();
        });
        if (sourceEditor) {
            sourceEditor.addEventListener('keyup', () => {
                updateCaretLineStatus();
                if (state.typewriterMode) applyTypewriterScroll(false);
            });
            sourceEditor.addEventListener('click', () => {
                updateCaretLineStatus();
                if (state.typewriterMode) applyTypewriterScroll(false);
            });
        }

        function handleCrossBoundarySelection(e) {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
            const range = sel.getRangeAt(0);
            const startBlock = getAncestorBlock(range.startContainer);
            const endBlock = getAncestorBlock(range.endContainer);

            if (startBlock && endBlock && startBlock !== endBlock) {
                if (e.key === 'Backspace' || e.key === 'Delete' || (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey)) {
                    e.preventDefault();
                    HistoryManager.beginEdit();

                    const startRange = document.createRange();
                    startRange.selectNodeContents(startBlock);
                    startRange.setEnd(range.startContainer, range.startOffset);
                    const prefix = startRange.toString();

                    const endRange = document.createRange();
                    endRange.selectNodeContents(endBlock);
                    endRange.setStart(range.endContainer, range.endOffset);
                    const suffix = endRange.toString();

                    const combinedRaw = prefix + (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey ? e.key : '') + suffix;

                    let fromIdx = DocumentModel.modelIndexOfEl(startBlock);
                    let toIdx = DocumentModel.modelIndexOfEl(endBlock);
                    let curr = startBlock.nextElementSibling;
                    while (curr && curr !== endBlock) {
                        const next = curr.nextElementSibling;
                        if (curr.classList.contains('block')) curr.remove();
                        curr = next;
                    }
                    if (endBlock && endBlock.classList.contains('block')) endBlock.remove();

                    writeBlockRaw(startBlock, coerceBlockRaw(combinedRaw));
                    try {
                        if (fromIdx >= 0 && toIdx > fromIdx) {
                            DocumentModel.removeBlockRange(fromIdx + 1, toIdx);
                            if (DocumentModel.virtEnabled) mountVirtWindow(true);
                            else reindexMountedBlocks();
                        } else if (!DocumentModel.virtEnabled) {
                            DocumentModel.rebuildFromFullDom();
                        }
                    } catch (eM) {}
                    window.isProgrammaticFocus = true;
                    focusBlock(startBlock, 0);

                    setTimeout(() => {
                        try { setCaretAtOffset(startBlock, prefix.length + (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey ? 1 : 0)); } catch(err) {}
                    }, 0);

                    HistoryManager.commitEdit();
                    updateStats();
                    updateOutline();
                    return true;
                }
            }
            return false;
        }

        // --- WYSIWYG AST / BLOCK ENGINE ---

        // --- Document size thresholds (Stage D: no dual-use of one constant) ---
        // Source-first open: Notepad-class path for medium+ files (no per-line WYSIWYG DOM).
        const SOURCE_FIRST_CHARS = 16000;
        // Back-compat alias for prefs / stats / history — Source-first only, NOT progressive.
        const LARGE_DOC_CHARS = SOURCE_FIRST_CHARS;
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
                try { DocumentModel.fromMarkdown(content); } catch (eM) {}
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
                try {
                    if (editor) editor.style.display = 'none';
                    if (sourceEditor) sourceEditor.style.display = 'block';
                    state.mode = 'source';
                    postMsg('mode_changed:source');
                } catch (e2) {}
                try {
                    if (mainContainer) mainContainer.scrollTop = 0;
                } catch (eScr) {}
                // Viewport-tall textarea after layout
                try { requestAnimationFrame(resizeSourceEditor); } catch (e1) {}
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
                setTimeout(function () { try { updateStatsNow(); } catch (eS) {} }, 0);
                return;
            }

            window.__tzDeferredWysiwyg = null;
            loadMarkdownContent(content);
            tzRequestPendingImages(editor);
            tzScheduleImageRescan();
            try {
                state.lastSavedContent = getMarkdownContent(false);
            } catch (e) {
                state.lastSavedContent = content;
            }
            if (markDirty) {
                state.lastSavedContent = '\0__session_unsaved__';
            }
            if (state.mode === 'source' && sourceEditor) {
                sourceEditor.value = content;
                requestAnimationFrame(resizeSourceEditor);
            }
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

            fromMarkdown: function (text) {
                const raws = splitMarkdownToBlockRaws(text);
                this.blocks = [];
                this._nextId = 1;
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
                const nChars = this.toMarkdown().length;
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
                }
                this.invalidateHeights();
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
                this.invalidateHeights();
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
                if (!this.blocks.length) {
                    this.blocks.push({ id: this._nextId++, raw: '' });
                }
                this.invalidateHeights();
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
                        const el = createPreviewBlockEl(raw, false);
                        el.setAttribute('data-model-index', String(i));
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

                try { refreshFindAfterVirtMount(); } catch (eF) {}
                try { clampMainScroll(); } catch (eCl) {}
            } finally {
                DocumentModel._virtMounting = false;
            }
        }

        function createPreviewBlockEl(raw, progressive) {
            const block = document.createElement('div');
            block.className = 'block';
            const initialRaw = raw == null ? '' : String(raw);
            block.setAttribute('data-raw', initialRaw);
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
            _contentCache = null;
            try { releaseDocumentStateForHost(); } catch (e0) {}
            const text = markdown == null ? '' : String(markdown);
            DocumentModel.fromMarkdown(text);
            window.__tzPaintGen = (window.__tzPaintGen || 0) + 1;
            const paintGen = window.__tzPaintGen;

            if (typeof sourceEditor !== 'undefined' && sourceEditor) {
                sourceEditor.value = text;
            }

            const stickyWanted = (opts && opts.stickyLine >= 1) ? (opts.stickyLine | 0) : 0;

            function seedHistoryAndCache() {
                // Do NOT reset _stickyLineCache / _lastCaretLine when loading for a mode
                // switch — that wiped line 16 → 1 before restore could run.
                if (!stickyWanted) {
                    _lastCaretLine = 1;
                }
                if (typeof HistoryManager !== 'undefined' && !HistoryManager.isRestoring) {
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
                currentActiveBlock = editor.querySelector('.block');
                if (currentActiveBlock) currentActiveBlock.classList.add('focused');
                seedHistoryAndCache();
                window.__tzPreviewPainting = false;
                try { updateOutline(); } catch (eO) {}
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

            DocumentModel.virtEnabled = false;
            unbindVirtScroll();
            editor.innerHTML = '';

            const blockRaws = DocumentModel.blocks.map(function (b) { return b.raw; });
            // M-band progressive: block count only (or explicit deferPaint).
            // Do NOT key off LARGE_DOC_CHARS / SOURCE_FIRST_CHARS — that is Source-first open,
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
                    currentActiveBlock = blocks[0] || null;
                    if (currentActiveBlock) currentActiveBlock.classList.add('focused');
                } catch (e) {
                    currentActiveBlock = editor.firstElementChild;
                }
                seedHistoryAndCache();
            }

            function afterPaint() {
                window.__tzPreviewPainting = false;
                try { updateOutline(); } catch (eO) {}
                try { tzRequestPendingImages(editor); tzScheduleImageRescan(); } catch (eI) {}
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
                    const el = createPreviewBlockEl(blockRaws[i], progressive);
                    el.setAttribute('data-model-index', String(i));
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
                    const el = createPreviewBlockEl(blockRaws[createIdx], true);
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
            try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
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
                const kids = Array.from(node.childNodes).map(walkNode).join('');
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
                    }
                    matrix.push(row);
                }
                let colCount = 0;
                for (let r = 0; r < matrix.length; r++) {
                    if (matrix[r].length > colCount) colCount = matrix[r].length;
                }
                for (let r = 0; r < matrix.length; r++) {
                    while (matrix[r].length < colCount) matrix[r].push('');
                }
                let lines = [];
                lines.push('| ' + matrix[0].join(' | ') + ' |');
                // Always add separator after first row
                lines.push('| ' + matrix[0].map(function() { return '---'; }).join(' | ') + ' |');
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

                let currentBlock = active;
                for (let i = 1; i < blockTexts.length; i++) {
                    const newBlock = createBlock(blockTexts[i], currentBlock);
                    currentBlock = newBlock;
                }
                focusBlock(currentBlock, 0);
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

        document.addEventListener('keydown', function (e) {
            if (state.pageAdvance) {
                if (e.target && e.target.closest && e.target.closest('#sidebar')) return;
                if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;

                if (e.key === 'PageDown' || e.key === 'PageUp' || e.key === ' ') {
                    e.preventDefault();
                    let now = Date.now();
                    if (now - lastPageScrollTime < 150) return;
                    lastPageScrollTime = now;
                    
                    // PageUp/PageDown/Space turn exactly one page, in both layouts. In
                    // 1-column these did nothing but nudge the scroll offset, which is why
                    // Page Down appeared to only move the caret.
                    const back = (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey));
                    PageMap.step(back ? -1 : 1);
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    let mainContainer = document.getElementById('main-container') || document.documentElement;
                    let isTwoCol = isPaginatedLayout();
                    let scrollEl = isTwoCol ? editor : mainContainer;
                    let jumpY = 0;
                    let jumpX = 0;
                    if (isTwoCol) {
                        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') jumpX = -50;
                        else jumpX = 50;
                        if (scrollEl.scrollTop !== 0) scrollEl.scrollTop = 0; // Fix diagonal offset
                    } else {
                        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') jumpY = -50;
                        else jumpY = 50;
                    }
                    scrollEl.scrollBy({ top: jumpY, left: jumpX, behavior: 'smooth' });
                }
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
                } else {
                    for (let i = 0; i < node.childNodes.length; i++) {
                        walk(node.childNodes[i]);
                        if (found) return;
                    }
                }
            }
            walk(el);
            if (!found && el.childNodes.length > 0) {
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
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal')) return;
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
                    holder.appendChild(sel.getRangeAt(0).cloneContents());
                    e.clipboardData.setData('text/plain', text);
                    e.clipboardData.setData('text/html', holder.innerHTML); // keep rich paste working
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
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal')) return;
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
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal')) return;
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
                flushActiveBlockToRaw();
                if (typeof HistoryManager !== 'undefined') HistoryManager.snapshot();
                updateStats();
            } catch (err) {}
        });

        editor.addEventListener('input', function onEditorInputSync(e) {
                if (window.isComposing || (e && e.isComposing)) return;
                if (state.mode === 'source') return;
                // Phase 1: every browser edit (type, delete, spellcheck, cut) updates data-raw.
                try {
                    flushActiveBlockToRaw();
                    updateStats();
                } catch (err) {}
            });

        // Leaving a block: commit data-raw so unfocused reads stay canonical.
        editor.addEventListener('focusout', function onEditorFocusOutFlush(e) {
            if (state.mode === 'source') return;
            if (window.isComposing) return;
            try {
                const blk = e && e.target ? getAncestorBlock(e.target) : null;
                if (!blk || !editor.contains(blk)) return;
                const raw = serializeBlockDomToRaw(blk);
                blk.setAttribute('data-raw', raw);
                setBlockListIndentAttr(blk, raw);
                try { touchLastGoodDocRawAtBlock(blk, raw); } catch (e2) {}
                try { blk.setAttribute('data-tz-dirty', '1'); } catch (e3) {}
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
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed || !sel.rangeCount) return;
                const range = sel.getRangeAt(0);
                const startBlock = getAncestorBlock(range.startContainer);
                const endBlock = getAncestorBlock(range.endContainer);
                if (!startBlock || !endBlock || startBlock === endBlock) return;  // one block: browser is fine

                try {
                    if (e.clipboardData) e.clipboardData.setData('text/plain', selectionToPlainText());
                } catch (err) {}
                e.preventDefault();

                HistoryManager.beginEdit();
                const cutAt = removeCrossBlockSelection();
                if (cutAt) {
                    window.isProgrammaticFocus = true;
                    focusBlock(cutAt.block);
                    setTimeout(function () {
                        try { setCaretAtOffset(cutAt.block, cutAt.offset); } catch (err2) {}
                        ensureCaretVisible(cutAt.block);
                    }, 0);
                }
                updateStats();
                updateOutline();
                HistoryManager.commitEdit();
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
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal')) return;
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
                    if (e.target && e.target.closest && e.target.closest('#findBar, #tableModal')) return;
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

        // --- MARKDOWN TO WYSIWYG HTML RENDERING ---

        /**
         * CommonMark-style thematic break on a single line:
         * three or more -, *, or _ (same character), optional spaces between.
         * So ---, ***, ___, - - -, * * *, _ _ _ all count; -- or - - do not.
         */
        function isThematicBreakLine(line) {
            const s = String(line == null ? '' : line).trim();
            if (!s) return false;
            return /^(-(?:\s*-){2,}|\*(?:\s*\*){2,}|_(?:\s*_){2,})\s*$/.test(s);
        }

        function clearListIndentClasses(block) {
            if (!block || !block.classList) return;
            block.classList.remove('list-block');
            for (let i = 0; i <= LIST_MAX_INDENT; i++) {
                block.classList.remove('list-indent-' + i);
            }
        }

        function renderBlockPreview(block, rawInput = null) {
            const raw = rawInput !== null ? rawInput : (block.getAttribute('data-raw') || '');
            clearListIndentClasses(block);
            setBlockListIndentAttr(block, raw);

            if (!raw.trim()) {
                block.innerHTML = '';
                return;
            }

            let html = raw;

            // Tables
            if (/^\|.*\|/m.test(html) && /\|[\s-:]+\|/.test(html)) {
                block.innerHTML = renderMarkdownTable(html);
                return;
            }

            // Code Blocks (fenced). Note: lines is an Array — never call string methods like endsWith on it.
            if (html.startsWith('```')) {
                const lines = html.split('\n');
                const lang = (lines[0] || '').replace(/^\s*```/, '').trim();
                let end = lines.length;
                if (lines.length > 1) {
                    const last = (lines[lines.length - 1] || '').trim();
                    if (last === '```' || /^```/.test(last)) end = lines.length - 1;
                }
                const code = lines.slice(1, end).join('\n');
                block.innerHTML = `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`;
                return;
            }

            // Headings (no leading indent)
            if (/^#{1,6}\s/.test(html)) {
                const level = html.match(/^#+/)[0].length;
                const text = parseInline(html.replace(/^#+\s*/, ''));
                block.innerHTML = `<h${level} id="heading-${Math.random().toString(36).substr(2, 6)}">${text}</h${level}>`;
                return;
            }

            // Blockquotes
            if (html.startsWith('>')) {
                const text = parseInline(html.replace(/^>\s*/, ''));
                block.innerHTML = `<blockquote>${text}</blockquote>`;
                return;
            }

            // Horizontal rule BEFORE lists: "- - -" is a thematic break in CommonMark,
            // but also matches a bullet line ("- " + body "- -") if lists run first.
            // Accept --- / *** / ___ and spaced forms - - - / * * * / _ _ _.
            if (isThematicBreakLine(html)) {
                block.innerHTML = `<hr/>`;
                return;
            }

            // Lists (optional leading spaces = nest level)
            const list = parseListLine(html);
            if (list) {
                block.classList.add('list-block');
                if (list.indent > 0) block.classList.add('list-indent-' + list.indent);
                const text = parseInline(list.body);
                if (list.kind === 'task') {
                    block.innerHTML =
                        `<ul class="task-list"><li class="task-list-item">` +
                        `<input type="checkbox" class="task-checkbox" contenteditable="false" ` +
                        `${list.checked ? 'checked ' : ''}onclick="toggleTask(this, event)" />` +
                        `<span class="task-text">${text || '&nbsp;'}</span>` +
                        `</li></ul>`;
                    return;
                }
                if (list.kind === 'ul') {
                    block.innerHTML = `<ul><li>${text}</li></ul>`;
                    return;
                }
                if (list.kind === 'ol') {
                    const num = list.num != null ? list.num : 1;
                    block.innerHTML = `<ol start="${num}"><li value="${num}">${text}</li></ol>`;
                    return;
                }
            } else {
                block.classList.remove('list-block');
            }

            // Standard Paragraph
            block.innerHTML = `<p>${parseInline(html)}</p>`;
            tzRequestPendingImages(block);
        }

        // --- TABLE MODEL ---------------------------------------------------------
        // A table is ONE .block whose data-raw holds the whole markdown, so every edit
        // is a pure string transform. Keeping these free of DOM lets them be tested
        // directly (tests/table-edit-selftest.mjs) instead of only through the browser.

        /** Split "| a | b |" into ["a","b"], tolerating missing outer pipes. */
        function splitTableRow(line) {
            let s = String(line == null ? '' : line).trim();
            if (s.indexOf('|') === 0) s = s.slice(1);
            if (s.length && s.lastIndexOf('|') === s.length - 1) s = s.slice(0, -1);
            return s.split('|').map(function (c) { return c.trim(); });
        }

        /** Markdown table -> { header, align, rows, cols }, or null if it isn't one. */
        function parseTableMarkdown(raw) {
            const lines = String(raw == null ? '' : raw)
                .split('\n')
                .map(function (l) { return l.trim(); })
                .filter(function (l) { return l.indexOf('|') === 0; });
            if (lines.length < 2) return null;

            const sepCells = splitTableRow(lines[1]);
            if (!sepCells.length) return null;
            const isSep = sepCells.every(function (c) { return /^:?-+:?$/.test(c); });
            if (!isSep) return null;

            const header = splitTableRow(lines[0]);
            const align = sepCells.map(function (c) {
                const l = c.charAt(0) === ':';
                const r = c.charAt(c.length - 1) === ':';
                if (l && r) return 'center';
                if (r) return 'right';
                if (l) return 'left';
                return '';
            });
            const rows = lines.slice(2).map(splitTableRow);

            let cols = Math.max(header.length, align.length);
            rows.forEach(function (r) { cols = Math.max(cols, r.length); });
            const pad = function (arr, fill) {
                const out = arr.slice(0, cols);
                while (out.length < cols) out.push(fill);
                return out;
            };
            return {
                header: pad(header, ''),
                align: pad(align, ''),
                rows: rows.map(function (r) { return pad(r, ''); }),
                cols: cols
            };
        }

        function tableAlignToSep(a) {
            if (a === 'center') return ':---:';
            if (a === 'right') return '---:';
            if (a === 'left') return ':---';
            return '---';
        }

        /** { header, align, rows } -> markdown. */
        function formatTableMarkdown(model) {
            if (!model) return '';
            const line = function (cells) { return '| ' + cells.join(' | ') + ' |'; };
            const out = [line(model.header), line(model.align.map(tableAlignToSep))];
            model.rows.forEach(function (r) { out.push(line(r)); });
            return out.join('\n');
        }

        /**
         * Table operations. rowIndex is -1 for the header row, 0..n-1 for body rows.
         * Every one returns a NEW model so callers can compare or discard.
         */
        function tableOp(model, op, rowIndex, colIndex, value) {
            if (!model) return null;
            const m = {
                header: model.header.slice(),
                align: model.align.slice(),
                rows: model.rows.map(function (r) { return r.slice(); }),
                cols: model.cols
            };
            const blankRow = function () {
                const r = [];
                for (let i = 0; i < m.cols; i++) r.push('');
                return r;
            };

            if (op === 'row_above' || op === 'row_below') {
                // Above the header inserts at the top of the body (the header stays a
                // header — markdown tables cannot have two).
                let at = rowIndex < 0 ? 0 : (op === 'row_below' ? rowIndex + 1 : rowIndex);
                if (at < 0) at = 0;
                if (at > m.rows.length) at = m.rows.length;
                m.rows.splice(at, 0, blankRow());
                return m;
            }
            if (op === 'row_delete') {
                if (rowIndex < 0) return m;          // never delete the header row
                if (!m.rows.length) return m;
                m.rows.splice(Math.min(rowIndex, m.rows.length - 1), 1);
                return m;
            }
            if (op === 'col_left' || op === 'col_right') {
                let at = op === 'col_right' ? colIndex + 1 : colIndex;
                if (at < 0) at = 0;
                if (at > m.cols) at = m.cols;
                m.header.splice(at, 0, '');
                m.align.splice(at, 0, '');
                m.rows.forEach(function (r) { r.splice(at, 0, ''); });
                m.cols += 1;
                return m;
            }
            if (op === 'col_delete') {
                if (m.cols <= 1) return m;           // a table needs at least one column
                const at = Math.max(0, Math.min(colIndex, m.cols - 1));
                m.header.splice(at, 1);
                m.align.splice(at, 1);
                m.rows.forEach(function (r) { r.splice(at, 1); });
                m.cols -= 1;
                return m;
            }
            if (op === 'align') {
                const at = Math.max(0, Math.min(colIndex, m.cols - 1));
                m.align[at] = value || '';
                return m;
            }
            return m;
        }

        /** The <td>/<th> holding the caret, or null. */
        function tableCellFromNode(node) {
            try {
                const el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
                return el && el.closest ? el.closest('td, th') : null;
            } catch (e) { return null; }
        }

        /** Table block under the caret plus the current cell, or null. */
        function getTableContext() {
            if (state.mode === 'source') return null;
            const sel = window.getSelection();
            const node = sel && sel.anchorNode;
            let block = node ? getAncestorBlock(node) : null;
            if (!block && currentActiveBlock) block = currentActiveBlock;
            if (!block) return null;

            const model = parseTableMarkdown(block.getAttribute('data-raw') || '');
            if (!model) return null;

            let rowIndex = -1;   // -1 = header row
            let colIndex = 0;
            const cell = tableCellFromNode(node);
            if (cell && block.contains(cell)) {
                const rowEl = cell.parentElement;
                colIndex = Array.prototype.indexOf.call(rowEl.children, cell);
                if (cell.tagName.toLowerCase() !== 'th') {
                    rowIndex = Array.prototype.indexOf.call(rowEl.parentElement.children, rowEl);
                }
            }
            return { block: block, model: model, rowIndex: rowIndex, colIndex: colIndex };
        }

        function tableCellAt(block, rowIndex, colIndex) {
            const table = block.querySelector('table');
            if (!table) return null;
            const clamp = function (list, i) {
                if (!list.length) return null;
                return list[Math.max(0, Math.min(i, list.length - 1))];
            };
            if (rowIndex < 0) {
                return clamp(table.querySelectorAll('thead th'), colIndex);
            }
            const tr = clamp(table.querySelectorAll('tbody tr'), rowIndex);
            if (!tr) return null;
            return clamp(tr.querySelectorAll('td'), colIndex);
        }

        function putCaretInTableCell(block, rowIndex, colIndex) {
            const cell = tableCellAt(block, rowIndex, colIndex);
            if (!cell) return false;
            try {
                const range = document.createRange();
                range.selectNodeContents(cell);
                range.collapse(false);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                return true;
            } catch (e) { return false; }
        }

        /** Apply a table operation to the table under the caret. */
        function applyTableOp(op, value) {
            const ctx = getTableContext();
            if (!ctx) return false;

            HistoryManager.beginEdit();
            const next = tableOp(ctx.model, op, ctx.rowIndex, ctx.colIndex, value);
            writeBlockRaw(ctx.block, formatTableMarkdown(next));

            // Land the caret where the edit happened, so you can keep typing
            let r = ctx.rowIndex;
            let c = ctx.colIndex;
            if (op === 'row_above') r = ctx.rowIndex < 0 ? 0 : ctx.rowIndex;
            if (op === 'row_below') r = ctx.rowIndex + 1;
            if (op === 'col_right') c = ctx.colIndex + 1;
            if (op === 'col_delete') c = Math.max(0, ctx.colIndex - 1);

            window.isProgrammaticFocus = true;
            focusBlock(ctx.block);
            const block = ctx.block;
            setTimeout(function () { putCaretInTableCell(block, r, c); }, 0);

            updateStats();
            updateOutline();
            HistoryManager.commitEdit();
            return true;
        }

        /**
         * Tab / Shift+Tab between cells, the way every table editor works. Tab in the
         * last cell appends a row, so you can fill a table without touching the mouse.
         */
        function tableTabNavigate(back) {
            const ctx = getTableContext();
            if (!ctx) return false;
            const cols = ctx.model.cols;
            const lastRow = ctx.model.rows.length - 1;
            let r = ctx.rowIndex;
            let c = ctx.colIndex + (back ? -1 : 1);

            if (c >= cols) { c = 0; r = r + 1; }
            if (c < 0) { c = cols - 1; r = r - 1; }
            if (r < -1) return false;                      // before the header: let Tab be Tab

            if (r > lastRow) {
                // Past the end: grow the table rather than losing the keystroke
                HistoryManager.beginEdit();
                const grown = tableOp(ctx.model, 'row_below', lastRow, 0, null);
                writeBlockRaw(ctx.block, formatTableMarkdown(grown));
                updateStats();
                HistoryManager.commitEdit();
                r = lastRow + 1;
                c = 0;
            }
            const block = ctx.block;
            window.isProgrammaticFocus = true;
            focusBlock(block);
            setTimeout(function () { putCaretInTableCell(block, r, c); }, 0);
            return true;
        }

        /**
         * Render a markdown table, INCLUDING its column alignment.
         *
         * The separator row used to be parsed only to be skipped, so ":---:" and "---:"
         * were decoration that never moved any text — writing alignment was possible but
         * seeing it was not. Build from the shared model instead, which already reads the
         * alignments, and emit them per cell. Inline styles beat .zen-table's
         * "text-align: left" (no !important), so they actually take effect.
         */
        function renderMarkdownTable(markdown) {
            const model = parseTableMarkdown(markdown);
            if (!model) return escapeHtml(markdown);

            const alignStyle = function (a) {
                return a ? ' style="text-align:' + a + '"' : '';
            };

            let html = '<div class="table-wrapper"><table class="zen-table"><thead><tr>';
            model.header.forEach(function (cell, i) {
                html += '<th' + alignStyle(model.align[i]) + '>' + parseInline(cell) + '</th>';
            });
            html += '</tr></thead>';

            if (model.rows.length) {
                html += '<tbody>';
                model.rows.forEach(function (row) {
                    html += '<tr>';
                    row.forEach(function (cell, i) {
                        html += '<td' + alignStyle(model.align[i]) + '>' + parseInline(cell) + '</td>';
                    });
                    html += '</tr>';
                });
                html += '</tbody>';
            }
            html += '</table></div>';
            return html;
        }

        /**
         * URL for href/src. Input is already HTML-escaped, so quotes cannot break out
         * of the attribute; reject them anyway (a real URL percent-encodes those) plus
         * every script-bearing scheme. Empty result → caller renders the label as text.
         */
        function safeUrl(url, allowDataImage) {
            const raw = String(url == null ? '' : url).trim();
            if (!raw) return '';
            if (/&quot;|&#39;|&lt;|&gt;/.test(raw)) return '';
            const probe = raw.replace(/[\x00-\x20]/g, '').toLowerCase();
            if (allowDataImage && /^data:image\//.test(probe)) return raw;
            if (/^(javascript|vbscript|data|about):/.test(probe)) return '';
            return raw;
        }

        function parseInline(text) {
            // 1. Code spans first — body must stay literal (no emphasis, no links inside).
            //    Serializing back through blockHtmlToMarkdown then round-trips exactly.
            const codeSpans = [];
            let res = String(text == null ? '' : text).replace(/`([^`]*)`/g, function (m, body) {
                codeSpans.push(body);
                return '@@TZCODE' + (codeSpans.length - 1) + '@@';
            });

            // 2. Escape once — quotes included, so nothing below can break out of an attribute.
            res = escapeHtml(res);

            // 3. Images BEFORE links: ![alt](src) also matches the link pattern, and the
            //    link rule used to win, so images rendered as "!" + hyperlink.
            res = res.replace(/!\[(.*?)\]\((.*?)\)/g, function (m, alt, src) {
                const u = safeUrl(src, true);
                if (!u) return alt;
                // Relative paths are relative to the DOCUMENT, but the page is served from
                // https://localapp/ (the app folder), so they would 404. The host maps the
                // document's folder to https://docfolder/ — display through that, and keep
                // the authored path in data-src so serializing back cannot rewrite the
                // markdown to an absolute URL.
                // Relative images are served by the host as bytes, NOT through the
                // https://docfolder virtual host. That mapping registers fine but never
                // serves: the request hangs instead of failing, so waiting for onerror
                // meant a ~5 second wait before the image appeared. Ask up front instead,
                // and reuse an already-fetched image immediately on re-render.
                const isAbsolute = /^(https?:|data:)/i.test(u);
                if (!isAbsolute) {
                    const cached = _tzImageData[u];
                    if (cached) {
                        return '<img src="' + cached + '" data-src="' + u + '" alt="' + alt +
                            '" contenteditable="false" draggable="true" class="zen-img"' +
                            ' style="max-width:100%;border-radius:6px;margin:8px 0;" />';
                    }
                    // 1x1 transparent placeholder: no network request, no broken-image flash
                    return '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"' +
                        ' data-src="' + u + '" data-pending="1" alt="' + alt +
                        '" contenteditable="false" draggable="true" class="zen-img"' +
                        ' style="max-width:100%;border-radius:6px;margin:8px 0;" />';
                }
                // Percent-encode the characters that actually break a URL path. A document
                // called "my notes.md" produced "my notes-assets/…", and the raw space made
                // the browser fail the request — the image just silently never appeared.
                // A lone % is escaped, but an existing valid %XX escape is left alone so
                // already-encoded paths do not get double-encoded.
                const display = isAbsolute ? u : 'https://docfolder/' + u.replace(/^\.?\//, '')
                    .replace(/%(?![0-9A-Fa-f]{2})/g, '%25')
                    .replace(/ /g, '%20')
                    .replace(/#/g, '%23')
                    .replace(/\?/g, '%3F');
                // onerror: if the mapped host does not serve the file, ask the host for the
                // bytes instead. An <img> that fails with alt="" collapses to nothing, so
                // without this a missing mapping looks exactly like "no image was inserted".
                return '<img src="' + display + '" data-src="' + u + '" alt="' + alt +
                    '" onerror="tzImageFallback(this)" contenteditable="false" draggable="true" class="zen-img"' +
                    ' style="max-width:100%;border-radius:6px;margin:8px 0;" />';
            });
            res = res.replace(/\[(.*?)\]\((.*?)\)/g, function (m, label, href) {
                const u = safeUrl(href, false);
                if (!u) return label;
                return '<a href="' + u + '" target="_blank" onclick="event.stopPropagation()">' + label + '</a>';
            });

            // 4. Emphasis. Longest marker first. Markers must hug non-space text so
            //    "2 * 3 and 4 * 5" stays literal, and underscores never match inside a
            //    word so snake_case / MAX_BUFFER_SIZE survive untouched (they used to
            //    render as <em> and then serialize back as some*var*name).
            // data-mark records which marker the author typed so blockHtmlToMarkdown can
            // put the same one back. Without it every _italic_ in a file turned into
            // *italic* the first time the document was saved.
            // Strikethrough (GitHub flavoured) before emphasis, so ~~a *b* c~~ nests right.
            res = res.replace(/~~(?=\S)(.*?\S)~~/g, '<del>$1</del>');
            res = res.replace(/\*\*\*(?=\S)(.*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
            // NB: the marker value is "u", not "_". Emitting a literal underscore here
            // fed the underscore rules below their own output attributes.
            res = res.replace(/(^|[^\w])___(?=\S)(.*?\S)___(?!\w)/g,
                '$1<strong data-mark="u"><em data-mark="u">$2</em></strong>');
            res = res.replace(/\*\*(?=\S)(.*?\S)\*\*/g, '<strong>$1</strong>');
            res = res.replace(/(^|[^\w])__(?=\S)(.*?\S)__(?!\w)/g, '$1<strong data-mark="u">$2</strong>');
            res = res.replace(/\*(?=\S)(.*?\S)\*/g, '<em>$1</em>');
            res = res.replace(/(^|[^\w])_(?=\S)(.*?\S)_(?!\w)/g, '$1<em data-mark="u">$2</em>');

            // 5. Restore code spans as literal text.
            res = res.replace(/@@TZCODE(\d+)@@/g, function (m, i) {
                return '<code>' + escapeHtml(codeSpans[Number(i)] || '') + '</code>';
            });
            return res;
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
        }

        function toggleTask(checkbox, event) {
            event.stopPropagation();
            const block = checkbox.closest('.block');
            if (block) {
                let raw = block.getAttribute('data-raw') || '';
                const p = parseListLine(raw);
                if (p && p.kind === 'task') {
                    p.checked = !!checkbox.checked;
                    raw = formatListLine(p);
                } else if (checkbox.checked) {
                    raw = raw.replace(/\[ \]/, '[x]');
                } else {
                    raw = raw.replace(/\[[xX]\]/, '[ ]');
                }
                block.setAttribute('data-raw', raw);
                setBlockListIndentAttr(block, raw);
                updateStats();
            }
        }

        /**
         * Serialize the document to markdown.
         *
         * repairFragments=false makes this a PURE READ. Expanding soft-break fragments
         * rewrites block.innerHTML, which detaches whatever node the caret is sitting in.
         * That was safe while serializing only happened inside the input handler (which
         * re-focuses immediately afterwards), but the debounced stats pass and the prefs
         * autosave both run on timers: firing this mid-edit silently dropped the caret,
         * and the next Enter or Delete then went nowhere. Edit paths still repair; timers
         * must not. (Typing repairs fragments on every input event anyway.)
         */
        /**
         * @param {boolean} [repairFragments]
         * @param {{flushActive?:boolean}} [opts] flushActive:true — write focused DOM → data-raw
         *   before read (host Save / close / tab sync). Timers omit this; getBlockRaw still
         *   sees live DOM for the focused block.
         */
        function getMarkdownContent(repairFragments, opts) {
            // Stage B: DocumentModel is save authority after flush / source read.
            if (state.mode === 'source') {
                const v = sourceEditor ? sourceEditor.value : '';
                try { DocumentModel.fromMarkdown(v); } catch (eS) {}
                return v;
            }
            if (opts && opts.flushActive === true) {
                try { flushActiveBlockToRaw(); } catch (eF) {}
            }
            // Expand soft-breaks only when repairing (mutates DOM).
            if (repairFragments !== false) {
                try { expandAllFragmentedBlocks(); } catch (e) {}
            }
            try {
                if (DocumentModel.virtEnabled) {
                    DocumentModel.syncMountedToModel();
                    return DocumentModel.toMarkdown();
                }
                // Full mount: push each block into model (handles inserts/deletes not dual-written).
                if (editor) {
                    const blocks = editor.querySelectorAll('.block');
                    if (blocks.length) {
                        // If counts diverge (Enter/delete), rebuild model from DOM.
                        if (blocks.length !== DocumentModel.blocks.length) {
                            DocumentModel.rebuildFromFullDom();
                        } else {
                            for (let i = 0; i < blocks.length; i++) {
                                if (DocumentModel.modelIndexOfEl(blocks[i]) < 0) {
                                    blocks[i].setAttribute('data-model-index', String(i));
                                }
                                // Prefer live getBlockRaw for focused; attribute for rest after flush.
                                try {
                                    DocumentModel.setBlockRaw(i, getBlockRaw(blocks[i]));
                                } catch (e1) {
                                    DocumentModel.setBlockRaw(i, blocks[i].getAttribute('data-raw') || '');
                                }
                            }
                        }
                    }
                }
                return DocumentModel.toMarkdown();
            } catch (e2) {
                // Fallback: legacy DOM walk
                const blocks = editor ? editor.querySelectorAll('.block') : [];
                const lines = [];
                for (let i = 0; i < blocks.length; i++) {
                    try { lines.push(coerceBlockRaw(getBlockRaw(blocks[i]))); }
                    catch (e3) { lines.push(blocks[i].getAttribute('data-raw') || ''); }
                }
                while (lines.length > 1 && !String(lines[lines.length - 1]).trim()) lines.pop();
                return lines.join('\n');
            }
        }

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
            if (now - _lastTypingPing > 1000) { _lastTypingPing = now; postMsg('typing'); }
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
            const isDirty = content !== state.lastSavedContent;

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
            _hostDocDirty = (content !== state.lastSavedContent) ? '1' : '0';
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

        function updateOutline() {
            if (!outlineList) return;
            outlineList.innerHTML = '';
            let found = 0;

            // Prefer DocumentModel so outline works when Preview is virtualized
            // (most blocks are not in the DOM).
            const useModel = DocumentModel && DocumentModel.blocks && DocumentModel.blocks.length;
            const count = useModel ? DocumentModel.blocks.length : 0;

            function addHeading(idx, raw) {
                if (!/^#{1,6}\s/.test(raw)) return;
                found++;
                const level = raw.match(/^#+/)[0].length;
                const title = raw.replace(/^#+\s*/, '').replace(/[*`_]/g, '');
                const item = document.createElement('div');
                item.className = 'outline-item outline-h' + level;
                item.innerText = title;
                item.onclick = function () {
                    try {
                        if (typeof ensureModelBlockVisible === 'function') {
                            const el = ensureModelBlockVisible(idx, { topPad: 48 });
                            if (el) {
                                el.classList.add('focused');
                                currentActiveBlock = el;
                                try { focusBlock(el, 0); } catch (eF) {}
                                setTimeout(function () {
                                    try { el.classList.remove('focused'); } catch (e) {}
                                }, 1500);
                                try { updateStatsNow({ forceCaretLine: modelBlockStartLine(idx) }); } catch (eU) {}
                                return;
                            }
                        }
                        if (DocumentModel.virtEnabled && mainContainer) {
                            DocumentModel.syncMountedToModel();
                            try {
                                DocumentModel.ensureHeights();
                                mainContainer.scrollTop = Math.max(0, DocumentModel.prefixHeight(idx) - 40);
                            } catch (eScr) {
                                mainContainer.scrollTop = Math.max(0, idx * (DocumentModel.rowHeight || 28) - 40);
                            }
                            mountVirtWindow(true);
                        }
                        const el = editor
                            ? editor.querySelector('.block[data-model-index="' + idx + '"]')
                            : null;
                        if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            el.classList.add('focused');
                            currentActiveBlock = el;
                            setTimeout(function () { try { el.classList.remove('focused'); } catch (e) {} }, 1500);
                        }
                    } catch (e2) {}
                };
                outlineList.appendChild(item);
            }

            if (useModel) {
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
        }

        /**
         * Show one sidebar pane. Matches on data-tab rather than :nth-child so that
         * adding or removing a tab cannot silently mis-target the header (removing the
         * Files tab shifted every nth-child index by one).
         */
        window.switchTab = function(tab) {
            if (tab !== 'outline' && tab !== 'search') tab = 'outline';
            document.querySelectorAll('.sidebar-tab').forEach(t => {
                t.classList.toggle('active', t.getAttribute('data-tab') === tab);
            });
            document.querySelectorAll('.tab-pane').forEach(p => {
                p.classList.toggle('active', p.id === 'tab-' + tab);
            });
        };

        function generateExportHtml() {
            const content = editor.innerHTML;
            const theme = document.getElementById('theme-styles').innerHTML;
            return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Exported Document</title><style>${theme} body{padding:40px;max-width:800px;margin:0 auto;background:var(--bg);color:var(--tx);font-family:var(--font);} pre,code{background:var(--code-bg);padding:4px;border-radius:4px;} blockquote{border-left:4px solid var(--accent);padding-left:16px;}</style></head><body>${content}</body></html>`;
        }

        tzMark('(page) top-level script evaluated');
    