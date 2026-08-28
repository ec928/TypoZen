// TypoZen module: 01-core.js
// Lines 1-498 of the former monolith. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.

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

        /** HUD + telemetry for a thrown error. Empty catches on authority paths call this. */
        window.tzLogException = function(where, err) {
            const msg = String(where || 'error') + ': ' +
                (err && err.message ? err.message : String(err || ''));
            try { if (typeof window.addDebugLog === 'function') window.addDebugLog(msg); } catch (e) {}
            try { if (typeof window.showDebugTelemetry === 'function') window.showDebugTelemetry(msg); } catch (e2) {}
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
                // Always re-sync editability. toggle_mode is skipped when already on the
                // target mode, which left contenteditable=false after book→Preview if
                // leaveBook had set editable against the old reader mode.
                try {
                    if (typeof setEditorEditable === 'function') {
                        if (state.mode === 'wysiwyg') setEditorEditable(true);
                        else setEditorEditable(false);
                    }
                } catch (eEd) {}
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
         * Keep #editor / #source-editor visibility aligned with state.mode.
         * Half-applied mode switches left Source lit on the shell while Preview DOM
         * stayed visible (or the reverse).
         */
        function syncModeSurface() {
            const isSource = state.mode === 'source';
            try {
                if (editor) editor.style.display = isSource ? 'none' : 'block';
            } catch (eE) {}
            try {
                if (sourceEditor) sourceEditor.style.display = isSource ? 'block' : 'none';
            } catch (eS) {}
            // The mirror is a sibling of the textarea, not a child, so hiding the
            // textarea does not hide it: leaving Source would strand a page of amber
            // boxes over the Preview editor.
            try { if (!isSource) clearSourceHighlights(); } catch (eH) {}
            try {
                state.viewMode = viewModeFromInternal(state.mode);
            } catch (eV) {}
            try { applyEditorChromeForMode(); } catch (eC) {}
            if (isSource) {
                try { requestAnimationFrame(resizeSourceEditor); } catch (eR) {}
            }
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
                
                // Configure the container BEFORE measuring it. This used to run the other
                // way round, so clientHeight was read while main-container still carried
                // the outgoing layout's overflow settings -- and a scrollbar that was about
                // to be removed (or added) is 20px of height. The first entry into
                // 2-column measured 774 and every later one measured 794, which made the
                // column 766px on the first visit and 786px afterwards.
                //
                // Nothing downstream could survive that: a 20px taller column fits more per
                // page, so the same document was 106 pages on the first visit and 103 on
                // the second. Switching 2-col -> 1-col -> 2-col returned to the page the
                // reading anchor named, faithfully -- but the pages had moved underneath
                // it, so it landed one page early. The anchoring was never the bug.
                if (mainContainer) {
                    // Pages: pane does not scroll — page turns are programmatic on #editor.
                    // body.tz-pages also hides native scrollbar chrome (CSS); the scrubber
                    // is the only position track.
                    mainContainer.style.overflowY = isTwoCol ? 'hidden' : 'auto';
                    mainContainer.style.overflowX = isTwoCol ? 'hidden' : '';
                }
                try { document.body.classList.toggle('tz-pages', !!isTwoCol); } catch (eTz) {}

                if (isTwoCol) {
                    // A column IS a page, so its height must be the height the reader can
                    // actually see. This was 100vh -- the whole window, including the
                    // toolbar, tab strip and status bar, roughly 130px the editor does not
                    // own. Every column was therefore taller than the viewport, so the
                    // editor could scroll vertically as well as horizontally, and a page
                    // ended up offset in both directions at once: the tail of one page down
                    // the left, the head of the next across the rest. The old code reset
                    // scrollTop on every page turn, which hid this; removing those resets
                    // when page turns moved to the page map exposed it again.
                    //
                    // Measured from #editor-wrapper, not #main-container: the wrapper is the
                    // box the editor actually sits in, and it is unaffected by whether the
                    // container is currently showing a scrollbar. Same number every time.
                    applyPageModeHeight();
                    editor.scrollTop = 0;   // nothing to scroll to now; keep it honest
                } else {
                    editor.style.height = '';
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
            // The mirror is sized from the textarea's computed style, so it has to be
            // re-read after the inline height/width above -- and after the wrap swap,
            // which changes white-space and so changes where every line breaks.
            try { syncSourceHighlightGeometry(); } catch (eHl) {}
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

