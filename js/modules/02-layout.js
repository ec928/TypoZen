// TypoZen module: 02-layout.js
// Lines 499-3027 of the former monolith. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.

        // --- DOCUMENT FIND (editor + source only; never sidebar/outline/chrome) ---
        const findState = {
            query: '',
            matches: [], // { start, end } char offsets in search haystack
            index: -1,
            ranges: [],
            /** 'source' | 'visual' (full DOM) | 'model' (virt: full DocumentModel markdown) */
            kind: 'visual'
        };

        /**
         * Up and Down step through search results from the document itself.
         *
         * Only while reading, and only when there is a result list to step through -- so an
         * arrow key still scrolls a book that nobody has searched. The sidebar's result list
         * has always used these keys; this is the same behaviour when the reader's eyes and
         * focus are on the text instead of on the panel.
         *
         * There used to be ',' '.' '<' '>' here as well. They are gone: they collided with
         * ordinary typing whenever focus sat in any input, and an editor that sometimes
         * eats a full stop is worse than one with fewer shortcuts.
         */
        function bindReaderFindKeys() {
            if (!editor || editor.__tzReaderFindKeys) return;
            editor.__tzReaderFindKeys = true;
            document.addEventListener('keydown', function (e) {
                if (!findState.matches || !findState.matches.length) return;
                if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

                // Never while something is being typed into, wherever the event came from.
                const t = e.target;
                const isInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
                if (isInput) return;

                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    if (state.mode === 'reader' || window.__tzExternalSearchActive) {
                        e.preventDefault();
                        e.stopPropagation();
                        findStep(e.key === 'ArrowUp' ? -1 : 1);
                        try { updateSidebarSearchCount(); } catch (err) {}
                        try { focusEditorNoScroll(); } catch (err2) {}
                    }
                } else {
                    if (window.__tzExternalSearchActive) {
                        window.__tzExternalSearchActive = false;
                    }
                }
            }, true);

            document.addEventListener('mousedown', function() {
                window.__tzExternalSearchActive = false;
            }, true);
        }

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

        /** Hide Ctrl+F chrome only — never touch shared findState / sidebar results. */
        function hideFindBarChrome() {
            const bar = document.getElementById('findBar');
            if (bar) bar.classList.remove('open');
        }

        function closeFindBar() {
            hideFindBarChrome();
            // Ctrl+F and the Search sidebar share findState. Closing the find bar must
            // not wipe a live sidebar search (that showed 1/6 then 0/0 + "No results...").
            clearFindHighlights();
            const side = document.getElementById('sidebarSearchInput');
            const sideQ = side ? String(side.value || '').trim() : '';
            const searchPane = document.getElementById('tab-search');
            const searchActive = !!(searchPane && searchPane.classList.contains('active'));
            // Only fall back to the sidebar's query if the sidebar is actually open.
            // Otherwise, closing the find bar would resurrect old searches instead of exiting search mode.
            const keepQ = searchActive ? (sideQ || (findState.query ? String(findState.query) : '')) : '';
            if (keepQ) {
                if (side && !sideQ) side.value = keepQ;
                // Keep matches for the sidebar; re-paint highlights for the current hit.
                try {
                    runFind(keepQ, true, { navigate: false });
                    if (typeof updateSearchSidebar === 'function') updateSearchSidebar();
                    if (typeof updateSidebarSearchCount === 'function') updateSidebarSearchCount();
                } catch (e) {
                    try { updateSearchSidebar(); } catch (e2) {}
                }
                return;
            }
            findState.query = '';
            findState.matches = [];
            findState.ranges = [];
            findState.currentRange = -1;
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

        /**
         * Bring a find range on screen using whichever navigation the layout uses.
         *
         * Paginated views take the visual find path, not the model one: virtualization is
         * off in page mode, so getFindHaystack falls through to the wysiwyg index. That
         * path scrolled mainContainer, which is overflow-hidden while paginated, so
         * clicking a search result did nothing at all.
         */
        function revealVisualRange(r) {
            if (!r) return;
            if (!isPaginatedLayout()) { scrollRangeIntoMain(r); return; }
            let el = r.startContainer;
            if (el && el.nodeType === 3) el = el.parentElement;
            while (el && !(el.classList && el.classList.contains('block'))) el = el.parentElement;
            const mi = el ? DocumentModel.modelIndexOfEl(el) : -1;
            if (mi >= 0) goToPageHoldingBlock(mi);
        }

        window.findJumpTo = function(index) {
            if (!findState.matches.length || index < 0 || index >= findState.matches.length) return;
            // Leave a breadcrumb so Return from Jump can restore reading position.
            try { if (typeof captureReturnJump === 'function') captureReturnJump(); } catch (eRj) {}
            findState.index = index;
            const takeFocus = isFindBarOpen();
            if (state.mode === 'source' || findState.kind === 'source') {
                const m = findState.matches[findState.index];
                scrollSourceMatchIntoView(m.start, m.end, takeFocus);
            } else if (findState.kind === 'model') {
                revealModelMatch(findState.matches[findState.index], true, !takeFocus);
            } else {
                const surface = getFindHaystack();
                findState.ranges = rangesFromWysiwygMatches(findState.matches, surface.map);
                // Visual path: ranges covers every match, so findState.index indexes it directly.
                findState.currentRange = -1;
                applyWysiwygHighlights();
                const r = findState.ranges[findState.index];
                if (r) {
                    revealVisualRange(r);
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

        /**
         * The alt text and source of a line that is nothing but an image, or null.
         *
         * One definition, used twice and deliberately not duplicated: the search row
         * decides how to draw the result with it, and revealModelMatch decides how to
         * travel to it. Those two have to agree -- a row that says "this is an image"
         * and a jump that tries to scroll to a character inside its URL is the pair of
         * answers that produced the original defect.
         *
         * Image-only, not image-anywhere. `![alt](src)` alone on a line renders as an
         * <img> and contributes no text to the page, so a match inside it has nothing on
         * screen to reveal. An image inside a sentence leaves the sentence, and that is
         * ordinary text with an ordinary position.
         */
        function imageOnlyLine(text) {
            const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]*)/.exec(String(text == null ? '' : text).trim());
            if (!m) return null;
            return { alt: m[1] || '', src: m[2] || '' };
        }

        /** What to call an image in one row of a list: its alt text, else its file name. */
        function imageBadgeLabel(img) {
            if (!img) return 'image';
            let label = String(img.alt || '').trim();
            if (!label) {
                const src = String(img.src || '');
                // Strip the query/fragment first, or a cache-busted URL names itself "?v=2".
                const clean = src.split(/[?#]/)[0];
                label = clean.substring(clean.lastIndexOf('/') + 1);
                try { label = decodeURIComponent(label); } catch (e) {}
            }
            if (!label) return 'image';
            // A data: URI has no name worth printing -- it would be 40 characters of base64.
            if (/^data:/i.test(img.src) && !String(img.alt || '').trim()) return 'embedded image';
            return label.length > 34 ? label.slice(0, 33) + '…' : label;
        }

        // How many result rows to add at a time. Rows are cheap, but a query matching
        // several thousand times should not build every row before showing the first.
        const SEARCH_RENDER_CHUNK = 150;
        let _searchRenderLimit = SEARCH_RENDER_CHUNK;
        let _searchRenderedQuery = null;
        // Identifies the row set currently painted, so a step can move the .active class
        // instead of rebuilding it. Query and match count are in the signature because a
        // different search can land on the same render limit.
        let _searchRenderedSig = null;
        let _searchRenderedList = null;

        /** Extend the rendered window. Bound to the "+N more" row and to scrolling. */
        window.searchShowMore = function () {
            if (!findState.matches || _searchRenderLimit >= findState.matches.length) return;
            _searchRenderLimit += SEARCH_RENDER_CHUNK;
            updateSearchSidebar();
        };

        /**
         * Document line numbers for a list of ascending model-markdown offsets, in one
         * walk of the blocks.
         *
         * The obvious spelling -- markdownOffsetToBlock(off) then modelBlockStartLine(bi)
         * per row -- is O(blocks) twice per row. Stepping to match 4581 of a 3769-block
         * document therefore raised the render window to ~4650 rows and cost roughly 26
         * million iterations (each allocating a string, each calling linesInBlockRaw) on
         * every single , or . keypress. It looked like a hang because it very nearly was.
         *
         * Matches arrive in document order, so one pointer over the blocks answers all of
         * them: O(blocks + rows), ~8k iterations for the same search.
         */
        function documentLinesForModelOffsets(offsets) {
            const out = new Array(offsets.length);
            const blocks = (typeof DocumentModel !== 'undefined' && DocumentModel.blocks)
                ? DocumentModel.blocks : null;
            if (!blocks || !blocks.length) { out.fill(1); return out; }

            // Same surface as the offsets themselves: a book's are into its text.
            const book = DocumentModel.kind === 'epub';
            const rawOf = function (i) {
                return book ? DocumentModel.blockText(i)
                            : String(blocks[i].raw == null ? '' : blocks[i].raw);
            };
            let bi = 0;              // block under the pointer
            let pos = 0;             // char offset of that block's start
            let line = 1;            // document line of that block's start
            let raw = rawOf(0);
            let rawLen = raw.length;

            for (let i = 0; i < offsets.length; i++) {
                const off = Math.max(0, offsets[i] | 0);
                // Offsets ascend, so the pointer only ever moves forward.
                while (bi < blocks.length - 1 && off > pos + rawLen) {
                    line += linesInBlockRaw(raw);
                    pos += rawLen + 1;          // +1 for the joining newline
                    bi++;
                    raw = rawOf(bi);
                    rawLen = raw.length;
                }
                // Block start alone is wrong: a multi-line paragraph/chapter body would
                // label every hit with the first line of its block, while the status bar
                // (and the page) report the real line within the block. Count newlines
                // from the block start up to the match.
                let within = 0;
                const lim = Math.min(Math.max(0, off - pos), rawLen);
                for (let j = 0; j < lim; j++) {
                    if (raw.charCodeAt(j) === 10) within++;
                }
                out[i] = line + within;
            }
            return out;
        }

        /** 1-based document line for a model-surface match offset (same basis as status Ln). */
        function documentLineForModelOffset(offset) {
            const lines = documentLinesForModelOffsets([Math.max(0, offset | 0)]);
            return lines[0] | 0 || 1;
        }

        function forceSearchSidebarRepaint() {
            _searchRenderedSig = '';
            _searchRenderedList = null;
        }
        window.forceSearchSidebarRepaint = forceSearchSidebarRepaint;
        window.updateSearchSidebar = updateSearchSidebar;
        window.rememberSearchQuery = rememberSearchQuery;

        function updateSearchSidebar() {
            const list = document.getElementById('search-results-list');
            if (!list) return;
            // Listeners live on the containers, so they survive the innerHTML rewrites below.
            wireSearchResultKeys();
            wireSidebarSearch();
            updateSidebarSearchCount();
            if (!findState.query || findState.matches.length === 0) {
                _searchRenderedSig = '';
                _searchRenderedList = null;
                list.innerHTML = '<div class="search-item" style="opacity:0.5;">No results...</div>';
                return;
            }
            let html = '';
            // One build per render. getFindHaystack() reconstructs the whole search
            // surface -- for the visual path that is an object per character of the
            // document -- so calling it twice here doubled the cost of every repaint.
            let surface;
            try {
                surface = getFindHaystack();
            } catch (eSurf) {
                list.innerHTML = '<div class="search-item" style="opacity:0.5;">Search failed</div>';
                return;
            }
            const haystack = surface.haystack || '';
            const qLen = (findState.query || '').length;
            // escapeHtml lives in a later module; guard so a missing helper cannot blank the list.
            const esc = (typeof escapeHtml === 'function')
                ? escapeHtml
                : function (s) {
                    return String(s == null ? '' : s)
                        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;');
                };
            // Render a window of results and extend it as the reader scrolls, rather than
            // capping the list. The cap was a flat 150: a search with 2135 hits showed the
            // first 150 and "+1985 more", and those 1985 were unreachable from the list
            // even though , and . still stepped through every one of them.
            if (_searchRenderedQuery !== findState.query) {
                _searchRenderedQuery = findState.query;
                _searchRenderLimit = SEARCH_RENDER_CHUNK;
            }
            // Stepping past the rendered window with , or . must bring it into view rather
            // than leave the active row unrendered.
            if (findState.index >= _searchRenderLimit) {
                _searchRenderLimit = (Math.floor(findState.index / SEARCH_RENDER_CHUNK) + 1)
                    * SEARCH_RENDER_CHUNK;
            }
            const limit = Math.min(findState.matches.length, _searchRenderLimit);

            // Stepping with , or . changes exactly one thing: which row is active. The rows
            // themselves are identical, so rebuilding their HTML -- and recomputing every
            // line number to do it -- is pure waste, and it is the common case: one keypress
            // per step, thousands of rows each time. Move the class instead.
            const sig = findState.query + '|' + findState.matches.length + '|' + limit;
            if (_searchRenderedSig === sig && _searchRenderedList === list) {
                const prev = list.querySelector('.search-item.active');
                const next = list.children[findState.index];
                if (next && next !== prev) {
                    if (prev) prev.classList.remove('active');
                    next.classList.add('active');
                    next.scrollIntoView({ block: 'nearest' });
                    return;
                }
                if (next && next === prev) return;
            }
            _searchRenderedSig = sig;
            _searchRenderedList = list;

            const offsets = [];
            for (let i = 0; i < limit; i++) {
                const m = findState.matches[i];
                offsets.push(typeof m === 'number' ? m : m.start);
            }
            // Document line numbers, not haystack line numbers.
            //
            // Counting newlines in the haystack only works when the haystack IS the file,
            // which is true for Source and nothing else. The model haystack is
            // DocumentModel.toMarkdown(), which joins blocks with a single newline and so
            // loses the blank lines between them: a match on file line 3 was reported as 2.
            // The visual haystack is block text with our own separators, which is further
            // adrift still. modelBlockStartLine is the app's own authority for this and is
            // what the status bar reports.
            const kind = surface.kind;
            let lines;
            if (kind === 'source' || typeof DocumentModel === 'undefined') {
                lines = lineNumbersForOffsets(haystack, offsets);
            } else {
                // The visual path needs the char -> node map to find a block. Build it
                // once for the whole render: blockIndexForVisualOffset used to rebuild it
                // per row, so drawing 150 rows rebuilt a 200k-entry index 150 times and a
                // single search jump cost ~1.6 seconds.
                if (kind === 'model') {
                    lines = documentLinesForModelOffsets(offsets);
                } else {
                    const visualMap = surface.map;
                    lines = offsets.map(function (off) {
                        try { return modelBlockStartLine(blockIndexFromMap(visualMap, off)); }
                        catch (e) { return 1; }
                    });
                }
            }

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

                // A line that is nothing but an image is shown as what it is, rather than
                // as the markdown that produces it. Searching "scroll" in this document
                // matches inside an asset path -- large-scroll-mixed-assets/... -- and the
                // row filled with raw syntax around a hit the reader cannot see anywhere
                // on the page. The badge says which image without pretending the URL is
                // prose. Only for image-ONLY lines: an image sitting inside a sentence
                // still has real text worth quoting.
                const img = imageOnlyLine(haystack.substring(b.start, b.end));
                let snippet;
                if (img) {
                    snippet = '<span class="search-badge">' +
                        '<span class="search-badge-icon" aria-hidden="true">\u{1F5BC}</span>' +
                        esc(imageBadgeLabel(img)) + '</span>';
                } else {
                    snippet = esc(leading + before) +
                        '<strong>' + esc(hit) + '</strong>' +
                        esc(after + trailing);
                }

                const active = (i === findState.index) ? ' active' : '';
                html += '<div class="search-item' + active + '" onclick="window.findJumpTo(' + i + '); try { this.closest(\'#search-results-list\').focus({preventScroll:true}); } catch(e) {}"' +
                    ' title="Line ' + lines[i] + ' — match ' + (i + 1) + ' of ' + findState.matches.length + '">' +
                    '<span class="search-line">' + lines[i] + '</span>' +
                    '<span class="search-text">' + snippet + '</span></div>';
            }
            if (findState.matches.length > limit) {
                const rest = findState.matches.length - limit;
                html += `<div class="search-item search-more" onclick="window.searchShowMore()" ` +
                    `title="Show more results">+${rest} more — click or scroll to show ` +
                    `${Math.min(rest, SEARCH_RENDER_CHUNK)}</div>`;
            }
            // innerHTML resets scrollTop, which would fight scrolling to the end of the
            // list to load the next chunk. Put the reader back where they were.
            const scroller = list.closest('.sidebar-content');
            const keepScroll = scroller ? scroller.scrollTop : 0;
            list.innerHTML = html;
            if (scroller && keepScroll && scroller.scrollTop !== keepScroll) {
                scroller.scrollTop = keepScroll;
            }
            
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
        const SIDEBAR_SEARCH_DEBOUNCE_MS = 2000;
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

            // Whenever the box takes focus, not only when it is typed into.
            //
            // The hand-off to the results list was armed from the input's own `input`
            // handler, so focus placed here programmatically -- by Alt+S, or by a search
            // arriving from ZenSeek -- was never scheduled to move on. It sat in the box
            // indefinitely, and ',' and '.' typed punctuation into a query instead of
            // stepping through the results.
            armSidebarSearchIdle();
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
        /**
         * Match case and whole word, shown in the sidebar, stored in the find bar.
         *
         * getFindOptions() reads the Ctrl+F checkboxes, and both surfaces search the same
         * findState -- so the sidebar buttons drive those checkboxes rather than keeping a
         * second copy of the answer. Open Ctrl+F after using them and it already agrees.
         */
        function syncSearchOptionButtons() {
            const pairs = [['sidebarMatchCase', 'findMatchCase'], ['sidebarWholeWord', 'findWholeWord']];
            for (const [btnId, boxId] of pairs) {
                const btn = document.getElementById(btnId);
                const box = document.getElementById(boxId);
                if (!btn || !box) continue;
                btn.setAttribute('aria-pressed', box.checked ? 'true' : 'false');
            }
        }

        function wireSearchOptionButtons() {
            const pairs = [['sidebarMatchCase', 'findMatchCase'], ['sidebarWholeWord', 'findWholeWord']];
            for (const [btnId, boxId] of pairs) {
                const btn = document.getElementById(btnId);
                const box = document.getElementById(boxId);
                if (!btn || !box || btn.__tzWired) continue;
                btn.__tzWired = true;
                btn.addEventListener('click', function () {
                    box.checked = !box.checked;
                    syncSearchOptionButtons();
                    scheduleSavePreferences();
                    // Re-run whatever is in the box now: changing an option with results on
                    // screen and leaving them stale is worse than not offering the option.
                    const input = document.getElementById('sidebarSearchInput');
                    const q = (input && input.value) || findState.query || '';
                    if (q) {
                        runFind(q, false, { navigate: false });
                        updateSidebarSearchCount();
                    }
                });
                // The find bar can change them too.
                box.addEventListener('change', function () {
                    syncSearchOptionButtons();
                    scheduleSavePreferences();
                });
            }
            syncSearchOptionButtons();
        }

        // Global recent Search-tab queries (not per tab). Most-recent first, max 8.
        // Survives restarts via settings.json + localStorage; cleared with Clear Stored Data
        // or Privacy → Clear Recent Searches (history only).
        const SEARCH_HISTORY_MAX = 8;
        let _searchHistory = [];
        let _searchHistOpen = false;
        let _searchHistHighlight = -1;
        // Last text in the Search box (including uncommitted typing), restored on Alt+S.
        let _lastSearchQuery = '';
        // Search-return breadcrumb: where the reader was before a jump, so Ctrl+Shift+J
        // can undo it. Not persisted, and deliberately not a bookmark -- it is dropped
        // automatically rather than chosen, and folding the two together would cost the
        // automatic one. The session place marker that used to sit beside it is gone,
        // replaced by bookmarks, which are the same idea with a name and a life beyond
        // this session.
        let _returnJumpBlock = -1;

        /* ---- Bookmarks ---------------------------------------------------------
           A bookmark is a promise that a place will still be there tomorrow, and a
           block index alone cannot keep it. Indices are stable for a book -- the same
           file yields the same spine and the same blocks -- but not for Markdown:
           insert a paragraph near the top and every index below it shifts, so
           yesterday's mark silently points at a different sentence. Silently is the
           problem. A mark that has moved is worse than one that is missing, because
           nothing tells the reader to distrust it.

           So a mark carries the text it was set on as well as where it was. The index
           is a hint, the fingerprint is the truth, and resolving one against the other
           on open is what makes the promise good. This is a modest version of what
           EPUB CFI exists to do, and annotations will need exactly the same anchor --
           a highlight is a mark with a range, a note is a highlight with text. */

        /** Enough text to identify a paragraph, not so much that an edit inside it breaks the match. */
        const MARK_FP_CHARS = 80;
        /** How far from the hint to look. See resolveMarkIndex for why it is bounded. */
        const MARK_SEARCH_RADIUS = 400;
        /** Field and record separators for the stored payload; not text a document contains. */
        const MARK_FS = '\u001f';
        const MARK_RS = '\u001e';

        /**
         * What the reader sees at a block, normalised for comparison.
         *
         * A book's block is the publisher's HTML and a Markdown block is its source, so
         * both are reduced to their text, and case is dropped: neither changes which
         * paragraph this is.
         *
         * Whitespace is removed outright rather than collapsed, which looks excessive and
         * is not. Reducing markup to text does not agree with itself about spacing:
         * textContent gives "the <i>Tower</i>, and" as "the Tower, and", while the regex
         * fallback that runs where DOMParser is unavailable substitutes a space per tag
         * and gives "the Tower , and". The same sentence would then fingerprint two ways
         * depending on which path ran, and a mark set under one would not resolve under
         * the other. Whitespace is not part of a paragraph's identity, so it is not part
         * of its fingerprint -- which also makes a mark survive a publisher's inline
         * markup being different from the one it was set on. Caught by
         * bookmark-anchor-selftest, which is the only reason it is written down here.
         */
        function markFingerprint(raw) {
            let s = String(raw == null ? '' : raw);
            if (s.indexOf('<') >= 0 && typeof htmlFragmentToText === 'function') {
                try { s = htmlFragmentToText(s); } catch (e) {}
            }
            return s.replace(/\s+/g, '').toLowerCase().slice(0, MARK_FP_CHARS);
        }

        /**
         * The block a mark should actually land on, given the one the reader is at.
         *
         * A blank line is a block, and the block at the top of the viewport is very often
         * one: marking the page put the mark on nothing, which named itself "(untitled
         * mark)" and — worse, because it is invisible — fingerprinted as the empty string,
         * so it had no anchor and could not survive the document being edited. Both faults
         * from the same cause.
         *
         * Forward first, because the reader's eye is on the text below the gap rather than
         * above it, and this is the same rule the book loader already applies when it
         * anchors a chapter break on the first block that renders something rather than on
         * the spacer in front of it. Bounded: a run of blanks longer than this is the end
         * of the document, and then backward, and then wherever we started.
         */
        function markSnapToInk(block, raws) {
            const n = raws ? raws.length : 0;
            if (!(block >= 0) || !n) return block;
            const LOOK = 8;
            for (let i = block; i < n && i < block + LOOK; i++) {
                if (markFingerprint(raws[i])) return i;
            }
            for (let i = block - 1; i >= 0 && i > block - LOOK; i--) {
                if (markFingerprint(raws[i])) return i;
            }
            return block;
        }

        /** A mark names itself from its text, so a new one is legible without being typed. */
        function markNameFromRaw(raw) {
            let s = String(raw == null ? '' : raw);
            if (s.indexOf('<') >= 0 && typeof htmlFragmentToText === 'function') {
                try { s = htmlFragmentToText(s); } catch (e) {}
            }
            s = s.replace(/^[#>\-*+\s]+/, '').replace(/\s+/g, ' ').trim();
            if (s.length <= 48) return s;
            // Cut at a word so the name does not end mid-syllable.
            const cut = s.slice(0, 48);
            const sp = cut.lastIndexOf(' ');
            return (sp > 24 ? cut.slice(0, sp) : cut) + '…';
        }

        /**
         * Where a mark actually is now, or -1 if its text is gone.
         *
         * Outward from the hint, nearest first, because the same sentence can legitimately
         * appear twice and the one the reader meant is the one nearest where they left it.
         * Forward is tried before backward at equal distance: text is far more often
         * inserted above a mark than removed, so the block it moved to is usually later.
         *
         * Bounded rather than a whole-document scan. Fingerprinting a block means parsing
         * its HTML, and a 45,000-block omnibus with a dozen marks would pay that half a
         * million times on every open. 400 blocks either way covers any edit a person makes
         * by hand; past that the honest answer is "I cannot find it", which the caller shows
         * as unresolved rather than quietly pointing somewhere plausible and wrong.
         */
        function resolveMarkIndex(mark, raws, radius) {
            const n = raws ? raws.length : 0;
            const want = (mark && mark.fp) ? String(mark.fp) : '';
            let hint = mark ? (mark.block | 0) : 0;
            if (hint < 0) hint = 0;
            // No fingerprint: a mark from a store written before this existed. Trust the
            // index, which is all it has.
            if (!want) return hint < n ? hint : -1;
            if (hint < n && markFingerprint(raws[hint]) === want) return hint;
            const r = radius > 0 ? radius : MARK_SEARCH_RADIUS;
            for (let d = 1; d <= r; d++) {
                const after = hint + d;
                if (after < n && markFingerprint(raws[after]) === want) return after;
                const before = hint - d;
                if (before >= 0 && before < n && markFingerprint(raws[before]) === want) return before;
            }
            return -1;
        }

        /* The marks for the document currently open, in document order. Kept resolved:
           every entry's .block is where its text is now, not where it was when stored. */
        let _marks = [];

        /** Raw text of every block, for fingerprinting. Cheap: the model already holds it. */
        function markBlockRaws() {
            try {
                if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks) return [];
                return DocumentModel.blocks.map(function (b) { return b ? b.raw : ''; });
            } catch (e) { return []; }
        }

        /** Marks in the order a reader meets them, which is the only order worth showing. */
        function sortMarks() {
            _marks.sort(function (a, b) { return (a.block | 0) - (b.block | 0); });
        }

        /**
         * Take the host's stored payload and work out where each mark is in THIS document.
         *
         * Resolution happens once, here, rather than every time the list is drawn: it costs
         * a fingerprint per block examined, and the answer cannot change until the document
         * does. A mark whose text has gone keeps its place in the list with block -1, so it
         * can be shown as unresolved and removed deliberately rather than vanishing on open
         * and taking the reader's note with it.
         */
        function loadMarksPayload(payload) {
            // The gutter must work whether or not the pane has ever been opened, so it
            // is wired on every document rather than when the tab is first shown.
            try { wireMarkGutter(); } catch (eG) {}
            _marks = parseMarks(payload);
            const raws = markBlockRaws();
            for (let i = 0; i < _marks.length; i++) {
                _marks[i].block = resolveMarkIndex(_marks[i], raws);
            }
            sortMarks();
            try { renderMarks(); } catch (e) {}
        }

        /** Hand the whole list back to the host, which keys it by the document's path. */
        function persistMarks() {
            try { postMsg('marks_set:' + serializeMarks(_marks)); } catch (e) {}
        }

        function markIndexAtBlock(block) {
            for (let i = 0; i < _marks.length; i++) {
                if (_marks[i].block === block) return i;
            }
            return -1;
        }

        /**
         * Mark this block, or unmark it if it is already marked.
         *
         * One operation rather than add and delete, because the affordances are all
         * toggles -- the gutter ribbon, the toolbar button and the shortcut are the same
         * gesture in three places, and each shows which state it is in.
         */
        function toggleMarkAtBlock(block) {
            if (!(block >= 0)) return false;
            const raws0 = markBlockRaws();
            block = markSnapToInk(block, raws0);
            const at = markIndexAtBlock(block);
            if (at >= 0) {
                _marks.splice(at, 1);
                persistMarks();
                try { renderMarks(); } catch (e) {}
                return false;
            }
            const raws = raws0;
            const raw = (block < raws.length) ? raws[block] : '';
            _marks.push({
                block: block,
                named: false,
                fp: markFingerprint(raw),
                name: markNameFromRaw(raw)
            });
            sortMarks();
            persistMarks();
            try { renderMarks(); } catch (e) {}
            return true;
        }

        /** Where a mark sits, said in whatever unit this document has: page, or line. */
        function markWhereText(bi) {
            try {
                if (isPaginatedLayout() && typeof PageMap !== 'undefined' && PageMap.pageOfBlock) {
                    const p = PageMap.pageOfBlock(bi);
                    if (p >= 0) return 'p ' + (p + 1);
                }
            } catch (e) {}
            try {
                if (typeof documentLineForBlock === 'function') {
                    const ln = documentLineForBlock(bi);
                    if (ln >= 1) return 'ln ' + ln;
                }
            } catch (e2) {}
            return '';
        }

        /**
         * Draw the pane.
         *
         * Ordered by position, never by when they were made: you read forwards, and a list
         * in creation order has to be translated every time you look at it. The mark you
         * are nearest is highlighted -- in a 600-page novel "which of these is behind me"
         * is the first question, and it is the same signal the search list already gives
         * for the current match.
         */
        /**
         * Ticks across the scrubber: the only view that spans the whole book.
         *
         * Five marks over 604 pages is a shape you read at a glance; five rows in a list
         * is not. Drawn as a background gradient on the track rather than as elements, so
         * there is nothing to keep in step with the thumb and nothing to clean up.
         */
        function paintScrubberTicks() {
            const host = document.getElementById('page-scrubber');
            if (!host) return;
            // No marks, no work. This runs from updatePageScrubber, which runs on every page
            // turn, and PageMap.ensure/count can force a measurement -- not something to do
            // on behalf of a list that is empty.
            if (!_marks.length) { host.style.removeProperty('--tick-image'); return; }
            let stops = [];
            try {
                if (isPaginatedLayout() && typeof PageMap !== 'undefined' && PageMap.ensure
                    && PageMap.ensure() && PageMap.pageOfBlock) {
                    const total = Math.max(1, PageMap.count());
                    for (let i = 0; i < _marks.length; i++) {
                        if (!(_marks[i].block >= 0)) continue;
                        const p = PageMap.pageOfBlock(_marks[i].block);
                        if (!(p >= 0)) continue;
                        const pct = Math.max(0, Math.min(100, (p / Math.max(1, total - 1)) * 100));
                        stops.push(pct);
                    }
                }
            } catch (e) { stops = []; }
            if (!stops.length) { host.style.removeProperty('--tick-image'); return; }
            const c = 'var(--mark-ink, #E8A33D)';
            const img = stops.map(function (pct) {
                // A 2px sliver at each mark. calc keeps the sliver a fixed width at any
                // scrubber length rather than a percentage that grows with the window.
                return 'linear-gradient(' + c + ', ' + c + ') no-repeat calc(' + pct +
                    '% - 1px) 50% / 2px 11px';
            }).join(', ');
            host.style.setProperty('--tick-image', img);
        }

        /**
         * The block "Mark this page" would act on, right now.
         *
         * The single source of truth for both the action and every control that describes
         * it. They were computed separately at first -- the button asked whether
         * currentReadingBlock() was marked, while the toggle acted on that block *snapped
         * to one with ink* -- and where the top of the viewport was a blank line the two
         * answered about different blocks. The button then described one thing and did
         * another.
         */
        function markTargetBlock() {
            let here = -1;
            try { here = currentReadingBlock(); } catch (e) { return -1; }
            if (!(here >= 0)) return -1;
            try { return markSnapToInk(here, markBlockRaws()); } catch (e2) { return here; }
        }

        /**
         * What the Mark button says and how it looks. The only place that decides.
         *
         * Written twice at first -- once in renderMarks and once in refreshMarkState --
         * and the two promptly disagreed: only one of them knew that a selection turns the
         * button into Highlight selection, so selecting text and letting the other one run
         * put the label back to "Mark this page" over highlighted words, which it would
         * then have highlighted. That is the same lie this button was just fixed for, and
         * it came back the moment the answer had two authors.
         */
        function updateMarkButton() {
            const btn = document.getElementById('markAddBtn');
            if (!btn) return;
            const sel = selectionInsideOneBlock();
            const here = markTargetBlock();
            const on = !sel && here >= 0 && markIndexAtBlock(here) >= 0;
            btn.classList.toggle('on', on);
            btn.lastElementChild.textContent = sel ? 'Highlight selection'
                : (on ? 'Remove this mark' : 'Mark this page');
        }

        /**
         * Follow the reader.
         *
         * Everything that describes "the page you are on" has to be recomputed when the
         * page you are on changes, and nothing was: renderMarks ran when the list changed
         * or the pane opened, so the toolbar kept saying Marked from wherever the last mark
         * was set, however far away the reader had since gone. Clicking it then added a
         * mark, because the button was stale and the action was not.
         *
         * Deliberately not a full renderMarks: that rebuilds every row, and this runs on
         * scroll. Only the two things that depend on position are touched.
         */
        let _markStateTimer = null;
        function refreshMarkState() {
            if (_markStateTimer) return;
            _markStateTimer = setTimeout(function () {
                _markStateTimer = null;
                const here = markTargetBlock();
                // The chapter label answers the same question -- "where am I now" -- and
                // scanning the mounted blocks twice per scroll to ask it separately would be
                // wasteful. One read, both answers.
                try {
                    if (typeof postChapterLabel === 'function') postChapterLabel(here);
                } catch (eCh) {}
                updateMarkButton();
                // The row the reader is nearest, without redrawing the list.
                const rows = document.querySelectorAll('#marks-list .mark-item');
                if (rows.length) {
                    let nearest = -1;
                    for (let i = 0; i < _marks.length; i++) {
                        if (_marks[i].block >= 0 && _marks[i].block <= here) nearest = i;
                    }
                    if (nearest < 0) nearest = 0;
                    for (let i = 0; i < rows.length; i++) {
                        rows[i].classList.toggle('active',
                            i === nearest && !rows[i].classList.contains('lost'));
                    }
                }
            }, 120);
        }

        function renderMarks() {
            try { paintMarkRibbons(); } catch (e) {}
            try { paintAnnotations(); } catch (e) {}
            try { paintScrubberTicks(); } catch (e) {}
            const list = document.getElementById('marks-list');
            if (!list) return;
            const count = document.getElementById('marksCount');
            if (count) count.textContent = _marks.length + (_marks.length === 1 ? ' mark' : ' marks');

            const here = markTargetBlock();
            updateMarkButton();

            if (!_marks.length) {
                list.innerHTML = '';
                const empty = document.createElement('div');
                empty.className = 'mark-empty';
                empty.textContent = 'No bookmarks in this document yet.';
                list.appendChild(empty);
                return;
            }

            // The nearest mark at or before where the reader is; the first one otherwise.
            let nearest = -1;
            for (let i = 0; i < _marks.length; i++) {
                const b = _marks[i].block;
                if (b >= 0 && b <= here) nearest = i;
            }
            if (nearest < 0) nearest = 0;

            const frag = document.createDocumentFragment();
            for (let i = 0; i < _marks.length; i++) {
                const m = _marks[i];
                const lost = !(m.block >= 0);
                const row = document.createElement('div');
                row.className = 'mark-item' + (i === nearest && !lost ? ' active' : '') +
                    (lost ? ' lost' : '');
                row.setAttribute('role', 'option');
                row.setAttribute('data-mark', String(i));

                const rib = document.createElement('span');
                rib.className = 'mark-rib';
                rib.setAttribute('aria-hidden', 'true');
                rib.textContent = '▮';

                const body = document.createElement('span');
                body.className = 'mark-body';
                const name = document.createElement('span');
                name.className = 'mark-name';
                name.textContent = m.name || '(untitled mark)';
                body.appendChild(name);
                const where = document.createElement('span');
                where.className = 'mark-where';
                let chapter = '';
                try {
                    if (!lost && typeof chapterTitleForBlock === 'function') {
                        chapter = chapterTitleForBlock(m.block) || '';
                    }
                } catch (e) {}
                const isNote = m.e > m.s;
                if (isNote) {
                    rib.textContent = '\u270E';   // a highlight, not a place
                    row.classList.add('annot');
                }
                where.textContent = lost
                    ? 'the text this marked is no longer here'
                    : (isNote && m.note ? m.note : chapter);
                if (isNote && m.note) where.classList.add('mark-note');
                if (where.textContent) body.appendChild(where);

                const page = document.createElement('span');
                page.className = 'mark-page';
                page.textContent = lost ? '' : markWhereText(m.block);

                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'mark-del';
                del.textContent = '×';
                del.title = 'Remove this bookmark';
                del.setAttribute('aria-label', 'Remove bookmark: ' + (m.name || ''));

                row.appendChild(rib);
                row.appendChild(body);
                row.appendChild(page);
                row.appendChild(del);
                frag.appendChild(row);
            }
            list.innerHTML = '';
            list.appendChild(frag);
        }

        /**
         * Paint tz-marked onto whichever blocks are mounted right now.
         *
         * By model index, never by DOM position: under virtualization the first mounted
         * block is not block 0, and the whole engine already resolves through
         * data-model-index for exactly this reason. Called after any change to the list and
         * after a remount, because a remount replaces every element and takes the classes
         * with it.
         */
        function paintMarkRibbons() {
            if (!editor) return;
            const want = Object.create(null);
            for (let i = 0; i < _marks.length; i++) {
                if (_marks[i].block >= 0) want[_marks[i].block] = 1;
            }
            const nodes = editor.querySelectorAll('.block[data-model-index]');
            for (let i = 0; i < nodes.length; i++) {
                const mi = parseInt(nodes[i].getAttribute('data-model-index'), 10);
                nodes[i].classList.toggle('tz-marked', !!want[mi]);
            }
        }

        /**
         * A click in the ribbon strip marks the block; a click in the text does not.
         *
         * The strip is the block's own left padding, which is empty. Hit-testing by
         * coordinate rather than by element because the ribbon is a pseudo-element -- see
         * the CSS for why it has to be one. Guarded on a collapsed selection so that
         * finishing a drag-select near the left edge does not also drop a bookmark.
         */
        function wireMarkGutter() {
            if (!editor || editor.__tzMarkGutter) return;
            editor.__tzMarkGutter = true;

            /* Repaint when blocks arrive.
               An observer rather than a call at each mount site: blocks are created by
               virtualization, by progressive paint, by a book remount and by ordinary
               editing, and a ribbon missing from one of those paths would be a bug nobody
               reports because the mark is still in the list. Debounced, and only when
               elements were actually added, so typing costs nothing. */
            let pending = null;
            try {
                new MutationObserver(function (recs) {
                    let added = false;
                    for (let i = 0; i < recs.length && !added; i++) {
                        added = recs[i].addedNodes && recs[i].addedNodes.length > 0;
                    }
                    if (!added || pending) return;
                    pending = setTimeout(function () {
                        pending = null;
                        try { paintMarkRibbons(); } catch (e) {}
                        try { paintAnnotations(); } catch (e) {}
                    }, 60);
                }).observe(editor, { childList: true, subtree: true });
            } catch (eObs) {}

            const STRIP = 16;
            editor.addEventListener('click', function (e) {
                const block = e.target && e.target.closest ? e.target.closest('.block') : null;
                if (!block || !editor.contains(block)) return;
                const r = block.getBoundingClientRect();
                if (e.clientX > r.left + STRIP) return;
                try {
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed) return;
                } catch (e2) {}
                const mi = parseInt(block.getAttribute('data-model-index'), 10);
                if (!isFinite(mi) || mi < 0) return;
                e.preventDefault();
                e.stopPropagation();
                toggleMarkAtBlock(mi);
            }, true);
        }

        /** One delegated listener on the pane, so a redraw cannot leave stale ones behind. */
        function wireMarksPane() {
            const list = document.getElementById('marks-list');
            if (list && !list.__tzWired) {
                list.__tzWired = true;
                list.addEventListener('click', function (e) {
                    const row = e.target.closest ? e.target.closest('.mark-item') : null;
                    if (!row) return;
                    const i = parseInt(row.getAttribute('data-mark'), 10);
                    if (!isFinite(i) || !_marks[i]) return;
                    if (e.target.classList && e.target.classList.contains('mark-del')) {
                        _marks.splice(i, 1);
                        persistMarks();
                        renderMarks();
                        return;
                    }
                    const bi = _marks[i].block;
                    if (!(bi >= 0)) return;   // unresolved: nowhere to go
                    // Same courtesy search and the outline give: leave a breadcrumb so
                    // Ctrl+Shift+J comes back to where the reader was.
                    try { captureReturnJump(); } catch (e2) {}
                    goToReadingBlock(bi);
                    renderMarks();
                });
                // Rename in place. Double-click rather than a button: renaming is the rare
                // case -- a mark names itself from its text and that is usually right --
                // so it should not cost a control on every row.
                list.addEventListener('dblclick', function (e) {
                    const row = e.target.closest ? e.target.closest('.mark-item') : null;
                    if (!row || row.classList.contains('lost')) return;
                    const i = parseInt(row.getAttribute('data-mark'), 10);
                    if (!isFinite(i) || !_marks[i]) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // A highlight is named by the words it quotes, so renaming it
                    // would be rewriting the book. The second line -- the note -- is
                    // the part that is the reader's to write.
                    const annot = _marks[i].e > _marks[i].s;
                    const nameEl = annot
                        ? (row.querySelector('.mark-where') || row.querySelector('.mark-name'))
                        : row.querySelector('.mark-name');
                    if (!nameEl) return;
                    nameEl.setAttribute('contenteditable', 'plaintext-only');
                    nameEl.focus();
                    try {
                        const r = document.createRange();
                        r.selectNodeContents(nameEl);
                        const s = window.getSelection();
                        s.removeAllRanges(); s.addRange(r);
                    } catch (e3) {}
                    const commit = function (keep) {
                        nameEl.removeAttribute('contenteditable');
                        if (keep) {
                            const v = (nameEl.textContent || '').replace(/\s+/g, ' ').trim();
                            // Emptying the name asks for the text back, rather than leaving
                            // a row with nothing written on it.
                            if (annot) {
                                _marks[i].note = v;
                            } else if (v) { _marks[i].name = v; _marks[i].named = true; }
                            else {
                                const raws = markBlockRaws();
                                _marks[i].name = markNameFromRaw(raws[_marks[i].block] || '');
                                _marks[i].named = false;
                            }
                            persistMarks();
                        }
                        renderMarks();
                    };
                    nameEl.addEventListener('blur', function () { commit(true); }, { once: true });
                    nameEl.addEventListener('keydown', function (ev) {
                        if (ev.key === 'Enter') { ev.preventDefault(); nameEl.blur(); }
                        else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
                        ev.stopPropagation();
                    });
                });
            }
            try { wireMarkGutter(); } catch (eG) {}

            const add = document.getElementById('markAddBtn');
            if (add && !add.__tzWired) {
                add.__tzWired = true;
                // mousedown, not click: the button taking focus collapses the
                // selection before a click handler ever runs, so by then there is
                // nothing left to highlight.
                add.addEventListener('mousedown', function (ev) {
                    if (annotateSelection()) { ev.preventDefault(); return; }
                });
                add.addEventListener('click', function () {
                    if (annotateSelection()) return;
                    toggleMarkAtBlock(markTargetBlock());
                });
            }
            const clear = document.getElementById('marksClearBtn');
            if (clear && !clear.__tzWired) {
                clear.__tzWired = true;
                clear.addEventListener('click', function () {
                    if (!_marks.length) return;
                    _marks = [];
                    persistMarks();
                    renderMarks();
                });
            }
        }

        /* ---- Annotations -------------------------------------------------------
           A highlight is a mark with a range, and a note is a highlight with text
           attached -- which is why bookmarks were built first: the anchoring is the
           whole problem, and this reuses it unchanged. A mark carries s and e, two
           character offsets into its block's text; absent, it is a plain bookmark.

           Drawn with the CSS Custom Highlight API, the same mechanism search already
           uses for its matches, and for the same reason the gutter ribbon is a
           pseudo-element: a .block round-trips into data-raw, so a <mark> element
           wrapped round the words would become part of the document the moment
           anything serialised. A custom highlight paints over text without being in
           it. */

        /** DOM point -> character offset within a block, counting a BR as one. */
        function blockOffsetOfPoint(blockEl, node, nodeOffset) {
            if (!blockEl || !node) return -1;
            let seen = 0, found = -1;
            (function walk(n) {
                if (found >= 0) return;
                if (n.nodeType === 3) {
                    if (n === node) { found = seen + nodeOffset; return; }
                    seen += n.nodeValue.length;
                } else if (n.nodeName === 'BR') {
                    if (n === node) { found = seen; return; }
                    seen += 1;
                } else {
                    for (let i = 0; i < n.childNodes.length; i++) {
                        if (n === node && i === nodeOffset) { found = seen; return; }
                        walk(n.childNodes[i]);
                        if (found >= 0) return;
                    }
                    if (n === node && nodeOffset >= n.childNodes.length) found = seen;
                }
            })(blockEl);
            return found;
        }

        /** Character offsets -> a live Range inside a mounted block, or null. */
        function rangeForBlockOffsets(blockEl, s, e) {
            if (!blockEl || !(e > s)) return null;
            let seen = 0, startNode = null, startOff = 0, endNode = null, endOff = 0;
            (function walk(n) {
                if (endNode) return;
                if (n.nodeType === 3) {
                    const len = n.nodeValue.length;
                    if (!startNode && seen + len >= s) { startNode = n; startOff = s - seen; }
                    if (startNode && seen + len >= e) { endNode = n; endOff = e - seen; }
                    seen += len;
                } else if (n.nodeName === 'BR') {
                    seen += 1;
                } else {
                    for (let i = 0; i < n.childNodes.length && !endNode; i++) walk(n.childNodes[i]);
                }
            })(blockEl);
            if (!startNode || !endNode) return null;
            try {
                const r = document.createRange();
                r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
                r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
                return r;
            } catch (err) { return null; }
        }

        /** True when there is text selected inside one block -- the thing to annotate. */
        function selectionInsideOneBlock() {
            try {
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
                const r = sel.getRangeAt(0);
                const a = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
                const b = r.endContainer.nodeType === 1 ? r.endContainer : r.endContainer.parentElement;
                if (!a || !b) return null;
                const ba = a.closest('.block'), bb = b.closest('.block');
                if (!ba || ba !== bb || !editor.contains(ba)) return null;
                const mi = parseInt(ba.getAttribute('data-model-index'), 10);
                if (!isFinite(mi) || mi < 0) return null;
                const s = blockOffsetOfPoint(ba, r.startContainer, r.startOffset);
                const e = blockOffsetOfPoint(ba, r.endContainer, r.endOffset);
                if (!(e > s) || s < 0) return null;
                return { block: mi, s: s, e: e, text: r.toString() };
            } catch (err) { return null; }
        }

        /** Highlight what is selected. Returns false when nothing usable is selected. */
        function annotateSelection() {
            const pick = selectionInsideOneBlock();
            if (!pick) return false;
            // An identical range twice is a request to remove it, the same toggle the
            // gutter and the button already use.
            for (let i = 0; i < _marks.length; i++) {
                if (_marks[i].block === pick.block && _marks[i].s === pick.s && _marks[i].e === pick.e) {
                    _marks.splice(i, 1);
                    persistMarks(); renderMarks();
                    return true;
                }
            }
            const raws = markBlockRaws();
            const raw = raws[pick.block] || '';
            _marks.push({
                block: pick.block, named: false,
                fp: markFingerprint(raw),
                // The quoted words name it, which is what a highlight is for.
                name: markNameFromRaw(pick.text),
                s: pick.s, e: pick.e, note: ''
            });
            sortMarks(); persistMarks(); renderMarks();
            try { window.getSelection().removeAllRanges(); } catch (e) {}
            return true;
        }

        /** Paint every annotation whose block is mounted. */
        function paintAnnotations() {
            let CSSH = null;
            try { CSSH = (window.CSS && CSS.highlights) ? CSS.highlights : null; } catch (e) {}
            if (!CSSH || typeof Highlight === 'undefined') return;
            const ranges = [];
            for (let i = 0; i < _marks.length; i++) {
                const m = _marks[i];
                if (!(m.block >= 0) || !(m.e > m.s)) continue;
                const el = editor && editor.querySelector('.block[data-model-index="' + m.block + '"]');
                if (!el) continue;
                const r = rangeForBlockOffsets(el, m.s, m.e);
                if (r) ranges.push(r);
            }
            try {
                if (ranges.length) CSSH.set('typozen-mark', new Highlight(...ranges));
                else CSSH.delete('typozen-mark');
            } catch (e2) {}
        }

        /* ---- Selection popover and dictionary lookup ---------------------------
           Reading a novel and not being able to ask what a word means is a real gap,
           and the gesture belongs beside the sentence rather than in a panel you have
           to look away to. It carries Highlight too, which is what finally makes
           annotating discoverable without the Marks pane open.

           Definitions come from the host, not from here: a dictionary worth having is
           tens of megabytes, and pushing that across the bridge to sit in the page
           would cost more than the feature. */

        let _selPopWord = '';
        /** Words looked up on the way here, so following a synonym can be walked back. */
        let _lookupTrail = [];

        function hideSelPop() {
            const el = document.getElementById('selPop');
            if (el) { el.hidden = true; const b = document.getElementById('selPopBody'); if (b) b.hidden = true; }
        }

        /** True while the popover is showing an answer, which must outlive its selection. */
        function selPopHoldsResult() {
            const pop = document.getElementById('selPop');
            const body = document.getElementById('selPopBody');
            return !!(pop && !pop.hidden && body && !body.hidden && body.childNodes.length);
        }

        /** The single word under a selection, if that is what it is. */
        function selectedWord(text) {
            const t = String(text || '').trim();
            if (!t || t.length > 40) return '';
            // Letters, apostrophes and hyphens: "well-being" and "don't" are words.
            return /^[\p{L}][\p{L}'’-]*$/u.test(t) ? t.replace(/[’']s$/u, '') : '';
        }

        /** How often the selected word appears in this document -- always available. */
        function occurrenceCount(word) {
            if (!word) return 0;
            let n = 0;
            try {
                // A function replacement, deliberately, where the idiomatic escape would be
                // the string '\\$&'. Every tool that inlines this engine into an HTML fixture
                // does it with String.replace, and a literal $& in the *source* is read there
                // as "the matched text" -- which spliced the whole engine bundle into the
                // middle of itself. The fixture came out corrupt and the only symptom was a
                // sanity check failing in a different file.
                const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g,
                    function (ch) { return '\\' + ch; }) + '\\b', 'giu');
                const blocks = DocumentModel.blocks;
                for (let i = 0; i < blocks.length; i++) {
                    const m = String(blocks[i].raw || '').match(re);
                    if (m) n += m.length;
                }
            } catch (e) { return 0; }
            return n;
        }

        function showSelPop() {
            const pop = document.getElementById('selPop');
            if (!pop) return;
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || !sel.rangeCount) { hideSelPop(); return; }
            const r = sel.getRangeAt(0);
            const host = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
            if (!host || !editor || !editor.contains(host)) { hideSelPop(); return; }
            const rect = r.getBoundingClientRect();
            if (!rect || (!rect.width && !rect.height)) { hideSelPop(); return; }

            _selPopWord = selectedWord(r.toString());
            _lookupTrail = [];      // a new selection is a new walk, not a continuation

            const body = document.getElementById('selPopBody');
            if (body) { body.hidden = true; body.innerHTML = ''; }
            pop.hidden = false;

            // Offered, not fired.
            //
            // This looked the word up on selection for a while, on the reasoning that
            // selecting a word is the whole gesture. It is not: a word is selected to copy
            // it at least as often as to ask about it, and an unasked-for definition then
            // sits over the text being worked with. So the button appears -- only for a
            // single word, because a paragraph has no definition -- and the answer waits to
            // be asked for.
            const lookup = document.getElementById('selPopLookup');
            if (lookup) lookup.hidden = !_selPopWord;
            // Above the selection, or below when there is no room. Clamped to the window
            // so a selection at the edge does not push it off screen.
            const w = pop.offsetWidth || 240, h = pop.offsetHeight || 40;
            let x = rect.left + rect.width / 2 - w / 2;
            let y = rect.top - h - 8;
            if (y < 4) y = rect.bottom + 8;
            x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
            pop.style.left = Math.round(x) + 'px';
            pop.style.top = Math.round(y) + 'px';
        }

        /** Render whatever the host found, or say plainly that there is nothing to look in. */
        function showDefinition(word, definition, installed, synonyms) {
            const body = document.getElementById('selPopBody');
            if (!body) return;
            body.innerHTML = '';

            const head = document.createElement('div');
            head.className = 'selpop-word';
            if (_lookupTrail.length) {
                // Following synonyms is a walk, and a walk needs a way back. Only shown
                // once there is somewhere to go, so it is not a permanently dead control.
                const back = document.createElement('button');
                back.type = 'button';
                back.className = 'selpop-back';
                back.textContent = '‹';
                back.title = 'Back to ' + _lookupTrail[_lookupTrail.length - 1];
                back.setAttribute('data-back', '1');
                head.appendChild(back);
            }
            head.appendChild(document.createTextNode(word));
            body.appendChild(head);

            /* Definition, then synonyms, then where else the word appears. One answer, in
               the order the question is usually asked.

               This used to be two buttons and a setting to fold them together. Selecting a
               word is the whole gesture: pressing something afterwards to find out what it
               means is a step too many for something done mid-sentence, and a reader who
               wants the definition almost always wants the near-words too. */

            if (definition) {
                const d = document.createElement('div');
                d.className = 'selpop-def';
                d.textContent = definition;
                body.appendChild(d);
            } else {
                const h = document.createElement('div');
                h.className = 'selpop-hint';
                if (installed) {
                    h.textContent = 'Not in the installed dictionary.';
                } else {
                    // A setup state, not an error, so it says what to do rather than what
                    // went wrong -- and names the script, because "supply a dictionary
                    // file" is not an instruction anyone can act on without one.
                    h.innerHTML = 'No dictionary installed. TypoZen bundles none and ' +
                        'downloads nothing. Run <code>tools\Make-Dictionary.ps1</code> ' +
                        'against a WordNet download to build it.';
                }
                body.appendChild(h);
            }

            if (synonyms) {
                const label = document.createElement('div');
                label.className = 'selpop-label';
                label.textContent = 'Synonyms';
                body.appendChild(label);

                // One element per word, not one blob of text: a synonym you cannot look up
                // is a dead end, and following one is the whole point of a thesaurus.
                // Senses are separated by "; " and words within a sense by ", ".
                const sy = document.createElement('div');
                sy.className = 'selpop-def selpop-syn';
                String(synonyms).split(';').forEach(function (sense, si) {
                    if (si) sy.appendChild(document.createTextNode(' · '));
                    sense.split(',').forEach(function (w, wi) {
                        const t = w.trim();
                        if (!t) return;
                        if (wi) sy.appendChild(document.createTextNode(', '));
                        const b = document.createElement('button');
                        b.type = 'button';
                        b.className = 'selpop-synlink';
                        b.textContent = t;
                        b.setAttribute('data-word', t);
                        b.title = 'Look up ' + t;
                        sy.appendChild(b);
                    });
                });
                body.appendChild(sy);
            } else if (installed) {
                // Only worth saying when there is a thesaurus to have looked in. With
                // nothing installed the dictionary hint above has already said so, and
                // repeating it under every word would be noise.
                const h = document.createElement('div');
                h.className = 'selpop-hint';
                h.textContent = 'No synonyms for this word.';
                body.appendChild(h);
            }

            // Always useful, dictionary or not: where else this word is in what you are
            // reading. In a novel that is often the question actually being asked.
            const n = occurrenceCount(word);
            if (n > 0) {
                const o = document.createElement('div');
                o.className = 'selpop-occ';
                o.textContent = n === 1
                    ? 'Appears once in this document.'
                    : 'Appears ' + n.toLocaleString() + ' times in this document.';
                body.appendChild(o);
            }

            body.hidden = false;
            showSelPopKeepPosition();
        }

        /** Re-clamp after the body grows, without moving it away from the selection. */
        function showSelPopKeepPosition() {
            const pop = document.getElementById('selPop');
            if (!pop || pop.hidden) return;
            const h = pop.offsetHeight || 40;
            let y = parseFloat(pop.style.top) || 0;
            if (y + h > window.innerHeight - 6) y = Math.max(6, window.innerHeight - h - 6);
            pop.style.top = Math.round(y) + 'px';
        }

        function wireSelPop() {
            const pop = document.getElementById('selPop');
            if (!pop || pop.__tzWired) return;
            pop.__tzWired = true;
            // mousedown/preventDefault throughout: the popover taking focus would collapse
            // the selection its buttons are about, which is the same trap the Marks pane
            // button fell into.
            pop.addEventListener('mousedown', function (e) { e.preventDefault(); });

            const mark = document.getElementById('selPopMark');
            if (mark) mark.addEventListener('click', function () {
                let made = false;
                try { made = !!annotateSelection(); } catch (e) {}
                hideSelPop();
                // Show the reader where the highlight went. A highlight is a faint wash
                // on text you are already looking at, so on its own the button gave no
                // evidence it had done anything -- and the list it joined was behind a
                // collapsed sidebar and an unselected tab. Same move Find in document
                // makes below, and through the same command the menu and Ctrl+Shift+P
                // use, so there is one implementation of "open the Marks pane".
                //
                // Only when a highlight was actually made: annotateSelection() returns
                // false when there is no range to mark, and opening a pane to show a
                // thing that does not exist is worse than doing nothing.
                if (made) {
                    try { handleCommand('show_marks'); } catch (e2) {}
                }
            });
            const lookupBtn = document.getElementById('selPopLookup');
            if (lookupBtn) lookupBtn.addEventListener('click', function () {
                if (!_selPopWord) return;
                try { postMsg('define:' + _selPopWord); } catch (e) {}
            });

            const find = document.getElementById('selPopFind');
            if (find) find.addEventListener('click', function () {
                const q = (window.getSelection() || '').toString().trim();
                hideSelPop();
                if (!q) return;
                try {
                    const sb = document.getElementById('sidebar');
                    if (sb) sb.classList.remove('collapsed');
                    postMsg('sidebar_state:1');
                    if (typeof switchTab === 'function') switchTab('search');
                    const input = document.getElementById('sidebarSearchInput');
                    if (input) {
                        input.value = q;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                } catch (e) {}
            });
            // Following a synonym, and walking back out again. Delegated to the body
            // because it is rebuilt on every lookup, and mousedown-prevented for the same
            // reason the buttons above are: taking focus would collapse the selection the
            // popover is anchored to and close it mid-walk.
            const body = document.getElementById('selPopBody');
            if (body && !body.__tzWired) {
                body.__tzWired = true;
                body.addEventListener('mousedown', function (e) { e.preventDefault(); });
                body.addEventListener('click', function (e) {
                    const t = e.target;
                    if (!t || !t.getAttribute) return;
                    if (t.getAttribute('data-back')) {
                        const prev = _lookupTrail.pop();
                        if (!prev) return;
                        _selPopWord = prev;
                        try { postMsg('define:' + prev); } catch (err) {}
                        return;
                    }
                    const w = t.getAttribute('data-word');
                    if (!w) return;
                    if (_selPopWord && _selPopWord !== w) _lookupTrail.push(_selPopWord);
                    _selPopWord = w;
                    try { postMsg('define:' + w); } catch (err) {}
                });
            }

            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && !pop.hidden) hideSelPop();
            }, true);
            document.addEventListener('mousedown', function (e) {
                if (pop.hidden) return;
                if (e.target && e.target.closest && e.target.closest('#selPop')) return;
                hideSelPop();
            }, true);
        }

        /** Marks -> one line for the host, which stores it against the document's path. */
        function serializeMarks(marks) {
            const out = [];
            for (let i = 0; i < (marks ? marks.length : 0); i++) {
                const m = marks[i];
                if (!m) continue;
                const clean = function (s) {
                    return String(s == null ? '' : s).split(MARK_FS).join(' ').split(MARK_RS).join(' ');
                };
                out.push([m.block | 0, m.named ? '1' : '0', clean(m.fp), clean(m.name),
                          (m.s == null ? '' : m.s | 0), (m.e == null ? '' : m.e | 0),
                          clean(m.note)].join(MARK_FS));
            }
            return out.join(MARK_RS);
        }

        /** The host's line back into marks. Anything malformed is dropped, never guessed at. */
        function parseMarks(payload) {
            const out = [];
            const s = String(payload == null ? '' : payload);
            if (!s) return out;
            const recs = s.split(MARK_RS);
            for (let i = 0; i < recs.length; i++) {
                if (!recs[i]) continue;
                const f = recs[i].split(MARK_FS);
                if (f.length < 4) continue;
                const block = parseInt(f[0], 10);
                if (!isFinite(block) || block < 0) continue;
                const rec = { block: block, named: f[1] === '1', fp: f[2], name: f[3],
                              note: f.length > 6 ? f[6] : '' };
                // Fields added after the first release: a record without them is a
                // plain bookmark, which is what parseMarks tolerating a short record
                // was for.
                const s = parseInt(f[4], 10), e = parseInt(f[5], 10);
                if (isFinite(s) && isFinite(e) && e > s) { rec.s = s; rec.e = e; }
                out.push(rec);
            }
            return out;
        }

        function normalizeSearchHistory(list) {
            const out = [];
            const seen = Object.create(null);
            if (!Array.isArray(list)) return out;
            for (let i = 0; i < list.length; i++) {
                const q = String(list[i] == null ? '' : list[i]).trim();
                if (!q || seen[q]) continue;
                seen[q] = true;
                out.push(q);
                if (out.length >= SEARCH_HISTORY_MAX) break;
            }
            return out;
        }

        function setSearchHistory(list) {
            _searchHistory = normalizeSearchHistory(list);
            try { renderSearchHistoryMenu(); } catch (eR) {}
            try { syncSearchHistoryButton(); } catch (eB) {}
        }

        function removeSearchHistoryItem(q) {
            q = String(q == null ? '' : q);
            setSearchHistory(_searchHistory.filter(function (x) { return x !== q; }));
            scheduleSavePreferences();
        }

        function clearSearchHistoryOnly() {
            setSearchHistory([]);
            _lastSearchQuery = '';
            try {
                const input = document.getElementById('sidebarSearchInput');
                if (input) input.value = '';
            } catch (eI) {}
            scheduleSavePreferences();
        }

        /** Record a committed search (Enter / history pick). Live typing does not count. */
        function rememberSearchQuery(q) {
            q = String(q == null ? '' : q).trim();
            if (!q) return;
            _lastSearchQuery = q;
            const next = [q].concat(_searchHistory.filter(function (x) { return x !== q; }));
            setSearchHistory(next);
            scheduleSavePreferences();
        }

        function rememberLastSearchText(q) {
            _lastSearchQuery = String(q == null ? '' : q);
            scheduleSavePreferences();
        }

        function currentReadingBlockIndex() {
            try {
                if (typeof _readingAnchor === 'number' && _readingAnchor >= 0) return _readingAnchor;
                if (typeof topLeftModelIndexTwoCol === 'function') {
                    const t = topLeftModelIndexTwoCol();
                    if (t >= 0) return t;
                }
            } catch (e) {}
            return 0;
        }

        /** Jump to a model block using the layout's own navigation path. */
        function goToReadingBlock(bi) {
            bi = bi | 0;
            if (bi < 0) return false;
            try {
                if (typeof DocumentModel !== 'undefined' && DocumentModel.blocks
                    && bi >= DocumentModel.blocks.length) {
                    bi = Math.max(0, DocumentModel.blocks.length - 1);
                }
            } catch (eB) {}
            try {
                if (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub'
                    && typeof goToModelBlock === 'function') {
                    goToModelBlock(bi);
                } else if (typeof isPaginatedLayout === 'function' && isPaginatedLayout()
                    && typeof goToPageHoldingBlock === 'function') {
                    goToPageHoldingBlock(bi);
                } else if (typeof modelBlockStartLine === 'function'
                    && typeof restoreStickyDocumentLine === 'function') {
                    restoreStickyDocumentLine(modelBlockStartLine(bi));
                } else if (typeof goToModelBlock === 'function') {
                    goToModelBlock(bi);
                } else return false;
                if (typeof _readingAnchor !== 'undefined') _readingAnchor = bi;
                try { if (typeof postChapterLabel === 'function') postChapterLabel(); } catch (eC) {}
                return true;
            } catch (eG) {
                return false;
            }
        }

        function captureReturnJump() {
            const bi = currentReadingBlockIndex();
            if (bi >= 0) _returnJumpBlock = bi;
        }

        function returnFromJump() {
            if (!(_returnJumpBlock >= 0)) return;
            const bi = _returnJumpBlock;
            _returnJumpBlock = -1;
            goToReadingBlock(bi);
        }

        function syncSearchHistoryButton() {
            const btn = document.getElementById('sidebarSearchHistoryBtn');
            if (!btn) return;
            btn.disabled = _searchHistory.length === 0;
            btn.setAttribute('aria-expanded', _searchHistOpen ? 'true' : 'false');
        }

        function closeSearchHistoryMenu() {
            const menu = document.getElementById('sidebarSearchHistoryMenu');
            if (menu) menu.hidden = true;
            _searchHistOpen = false;
            _searchHistHighlight = -1;
            syncSearchHistoryButton();
        }

        function renderSearchHistoryMenu() {
            const menu = document.getElementById('sidebarSearchHistoryMenu');
            if (!menu) return;
            menu.innerHTML = '';
            if (!_searchHistory.length) {
                const empty = document.createElement('div');
                empty.className = 'sidebar-search-hist-empty';
                empty.textContent = 'No recent searches';
                menu.appendChild(empty);
                return;
            }
            for (let i = 0; i < _searchHistory.length; i++) {
                const q = _searchHistory[i];
                const row = document.createElement('div');
                row.className = 'sidebar-search-hist-row';
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'sidebar-search-hist-item';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', i === _searchHistHighlight ? 'true' : 'false');
                item.textContent = q;
                item.title = q;
                item.addEventListener('mousedown', function (e) {
                    // mousedown so the input does not steal focus and close first.
                    e.preventDefault();
                    pickSearchHistoryItem(q);
                });
                const rm = document.createElement('button');
                rm.type = 'button';
                rm.className = 'sidebar-search-hist-remove';
                rm.title = 'Remove from recent searches';
                rm.setAttribute('aria-label', 'Remove ' + q);
                rm.textContent = '\u00D7';
                rm.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    removeSearchHistoryItem(q);
                    if (_searchHistory.length) openSearchHistoryMenu();
                    else closeSearchHistoryMenu();
                });
                row.appendChild(item);
                row.appendChild(rm);
                menu.appendChild(row);
            }
            const clearRow = document.createElement('button');
            clearRow.type = 'button';
            clearRow.className = 'sidebar-search-hist-clear';
            clearRow.textContent = 'Clear recent searches';
            clearRow.addEventListener('mousedown', function (e) {
                e.preventDefault();
                e.stopPropagation();
                clearSearchHistoryOnly();
                closeSearchHistoryMenu();
            });
            menu.appendChild(clearRow);
        }

        function openSearchHistoryMenu() {
            if (!_searchHistory.length) return;
            renderSearchHistoryMenu();
            const menu = document.getElementById('sidebarSearchHistoryMenu');
            if (!menu) return;
            menu.hidden = false;
            _searchHistOpen = true;
            _searchHistHighlight = -1;
            syncSearchHistoryButton();
        }

        function toggleSearchHistoryMenu() {
            if (_searchHistOpen) closeSearchHistoryMenu();
            else openSearchHistoryMenu();
        }

        function pickSearchHistoryItem(q) {
            const input = document.getElementById('sidebarSearchInput');
            closeSearchHistoryMenu();
            if (!input) return;
            input.value = q;
            rememberSearchQuery(q);
            if (_sidebarSearchDebounce) { clearTimeout(_sidebarSearchDebounce); _sidebarSearchDebounce = null; }
            try { if (typeof captureReturnJump === 'function') captureReturnJump(); } catch (eRj) {}
            runFind(q, false, { navigate: true });
            updateSidebarSearchCount();
            focusSearchResults();
        }

        function moveSearchHistoryHighlight(delta) {
            if (!_searchHistOpen || !_searchHistory.length) return;
            const n = _searchHistory.length;
            if (_searchHistHighlight < 0) _searchHistHighlight = delta > 0 ? 0 : n - 1;
            else _searchHistHighlight = (_searchHistHighlight + delta + n) % n;
            renderSearchHistoryMenu();
            const menu = document.getElementById('sidebarSearchHistoryMenu');
            if (!menu) return;
            const el = menu.querySelectorAll('.sidebar-search-hist-item')[_searchHistHighlight];
            if (el && el.scrollIntoView) try { el.scrollIntoView({ block: 'nearest' }); } catch (eS) {}
        }

        function wireSidebarSearch() {
            const input = document.getElementById('sidebarSearchInput');
            if (!input || input.__tzWired) return;
            input.__tzWired = true;
            wireSearchOptionButtons();
            syncSearchHistoryButton();

            const histBtn = document.getElementById('sidebarSearchHistoryBtn');
            if (histBtn && !histBtn.__tzWired) {
                histBtn.__tzWired = true;
                histBtn.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSearchHistoryMenu();
                });
            }

            // Click outside closes the recent-query menu.
            if (!document.__tzSearchHistDocWired) {
                document.__tzSearchHistDocWired = true;
                document.addEventListener('mousedown', function (e) {
                    if (!_searchHistOpen) return;
                    const combo = document.querySelector('.sidebar-search-combo');
                    if (combo && combo.contains(e.target)) return;
                    closeSearchHistoryMenu();
                }, true);
            }

            input.addEventListener('focus', () => {
                armSidebarSearchIdle();
            });

            input.addEventListener('input', () => {
                if (_searchHistOpen) closeSearchHistoryMenu();
                if (_sidebarSearchDebounce) clearTimeout(_sidebarSearchDebounce);
                
                if (!input.value) {
                    _sidebarSearchDebounce = null;
                    rememberLastSearchText('');
                    runFind('', false, { navigate: false });
                    if (typeof syncSearchIndexToLocation === 'function') {
                        try { syncSearchIndexToLocation(); } catch (eSync) {}
                    }
                    updateSidebarSearchCount();
                    updateSearchSidebar();
                    armSidebarSearchIdle();
                    return;
                }
                
                _sidebarSearchDebounce = setTimeout(() => {
                    _sidebarSearchDebounce = null;
                    rememberLastSearchText(input.value);
                    runFind(input.value, false, { navigate: false });
                    if (typeof syncSearchIndexToLocation === 'function') {
                        try { syncSearchIndexToLocation(); } catch (eSync) {}
                    }
                    updateSidebarSearchCount();
                    updateSearchSidebar();
                }, SIDEBAR_SEARCH_DEBOUNCE_MS);
                armSidebarSearchIdle();
            });

            input.addEventListener('keydown', (e) => {
                // The editor's global shortcut handlers must not see ordinary typing here.
                e.stopPropagation();
                if (_searchHistOpen) {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        moveSearchHistoryHighlight(+1);
                        return;
                    }
                    if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveSearchHistoryHighlight(-1);
                        return;
                    }
                    if (e.key === 'Enter' && _searchHistHighlight >= 0) {
                        e.preventDefault();
                        pickSearchHistoryItem(_searchHistory[_searchHistHighlight]);
                        return;
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        closeSearchHistoryMenu();
                        return;
                    }
                }
                if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey)) {
                    e.preventDefault();
                    cancelSidebarSearchIdle();
                    
                    if (e.key === 'ArrowDown' && !String(input.value || '').trim() && _searchHistory.length) {
                        openSearchHistoryMenu();
                        moveSearchHistoryHighlight(+1);
                        return;
                    }
                    
                    closeSearchHistoryMenu();
                    if (_sidebarSearchDebounce) { clearTimeout(_sidebarSearchDebounce); _sidebarSearchDebounce = null; }
                    rememberSearchQuery(input.value);
                    try { if (typeof captureReturnJump === 'function') captureReturnJump(); } catch (eRj) {}
                    
                    runFind(input.value, false, { navigate: false });
                    if (typeof syncSearchIndexToLocation === 'function') syncSearchIndexToLocation();
                    if (findState.matches && findState.matches.length > 0 && typeof findJumpTo === 'function') {
                        findJumpTo(findState.index);
                    } else {
                        updateSidebarSearchCount();
                    }
                    focusSearchResults();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelSidebarSearchIdle();
                    closeSearchHistoryMenu();
                    input.value = '';
                    runFind('', false, { navigate: false });
                    updateSidebarSearchCount();
                    updateSearchSidebar();
                    if (typeof commitSearchFocus === 'function') commitSearchFocus();
                }
            });

            // Typing again after focus moved away should not fight the idle timer.
            input.addEventListener('blur', function () {
                cancelSidebarSearchIdle();
                // Delay close so a mousedown on a history item still fires first.
                setTimeout(function () {
                    if (_searchHistOpen && document.activeElement !== input
                        && document.activeElement !== histBtn) {
                        const menu = document.getElementById('sidebarSearchHistoryMenu');
                        if (menu && menu.contains(document.activeElement)) return;
                        closeSearchHistoryMenu();
                    }
                }, 120);
            });
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

            // Reaching the end of the list pulls in the next chunk. The sidebar content is
            // the scroller, not the list itself.
            const scroller = list.closest('.sidebar-content');
            if (scroller && !scroller.__tzMoreWired) {
                scroller.__tzMoreWired = true;
                scroller.addEventListener('scroll', function () {
                    if (!findState.matches || !findState.matches.length) return;
                    if (_searchRenderLimit >= findState.matches.length) return;
                    const nearEnd = scroller.scrollTop + scroller.clientHeight
                        >= scroller.scrollHeight - 60;
                    if (nearEnd) window.searchShowMore();
                }, { passive: true });
            }
            list.addEventListener('keydown', (e) => {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (typeof isPaginatedLayout === 'function' && isPaginatedLayout() && typeof PageMap !== 'undefined' && PageMap.step) {
                    if (e.key === 'PageDown' || e.key === 'ArrowRight') {
                        e.preventDefault(); e.stopPropagation(); PageMap.step(1); return;
                    }
                    if (e.key === 'PageUp' || e.key === 'ArrowLeft') {
                        e.preventDefault(); e.stopPropagation(); PageMap.step(-1); return;
                    }
                }
                let dir = 0;
                if (e.key === 'ArrowUp') dir = -1;
                else if (e.key === 'ArrowDown') dir = 1;
                else if (e.key === 'Enter') {
                    // Re-reveal the current match without moving, so Enter confirms.
                    if (findState.matches.length) window.findJumpTo(findState.index);
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                else if (e.key === 'Escape') {
                    cancelSidebarSearchIdle();
                    const input = document.getElementById('sidebarSearchInput');
                    if (input) input.value = '';
                    runFind('', false, { navigate: false });
                    updateSidebarSearchCount();
                    updateSearchSidebar();
                    if (typeof commitSearchFocus === 'function') commitSearchFocus();
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
         * PageMap counts *spreads* (one horizontal step = one screenful). In 2-column
         * mode a spread is two leaf pages under the columns. Leaf numbers are display
         * only — never seek, mount, or store them. All * 2 / + 1 arithmetic lives here.
         *
         * @param {number} spread0 0-based spread index from PageMap.current()
         * @param {number} spreadCount total spreads from PageMap.count()
         * @param {boolean} twoCol
         * @returns {{ twoCol:boolean, left:number, right:number, totalLeaves:number,
         *            bubble:string, spread0:number, spreadCount:number }}
         */
        function pageDisplayFromSpread(spread0, spreadCount, twoCol) {
            const n = Math.max(1, spreadCount | 0);
            const s = Math.max(0, Math.min(spread0 | 0, n - 1));
            if (twoCol) {
                const totalLeaves = n * 2;
                const left = s * 2 + 1;
                const right = Math.min(left + 1, totalLeaves);
                return {
                    twoCol: true,
                    left: left,
                    right: right,
                    totalLeaves: totalLeaves,
                    bubble: left + ' / ' + totalLeaves,
                    spread0: s,
                    spreadCount: n
                };
            }
            return {
                twoCol: false,
                left: s + 1,
                right: s + 1,
                totalLeaves: n,
                bubble: (s + 1) + ' / ' + n,
                spread0: s,
                spreadCount: n
            };
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
            try { updatePageScrubber(); } catch (eS) {}
            const host = document.getElementById('page-indicator');
            if (!host) return;
            // Shown wherever the document is actually paginated, not only in Reader.
            // Preview + Pagination is a real paginated view, and hiding the numbers there
            // meant the one mode being tested was the one with no way to see the page state.
            if (!isPaginatedLayout() || !PageMap.ensure()) {
                host.style.display = 'none';
                return;
            }
            // count(), not pages.length. Under page windowing pages.length is the MOUNTED
            // range's page count while current() is the spread within the whole document.
            const twoCol = editor.classList.contains('two-col-layout');
            const d = pageDisplayFromSpread(PageMap.current(), PageMap.count(), twoCol);
            host.style.display = 'flex';
            host.classList.toggle('two-up', twoCol);
            host.title = 'Click to go to page';
            host.setAttribute('role', 'button');
            if (twoCol) {
                host.innerHTML =
                    '<span class="page-num">' + d.left + '</span>' +
                    '<span class="page-num">' + d.right + '</span>';
            } else {
                host.innerHTML = '<span class="page-num">' + d.bubble + '</span>';
            }
            if (!host.__tzGotoBound) {
                host.__tzGotoBound = true;
                host.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    openGoToPageDialog();
                });
            }
            try { if (typeof postChapterLabel === 'function') postChapterLabel(); } catch (eCh) {}
        }

        /**
         * Leaf page number → spread index (PageMap addresses spreads). In 2-column mode
         * the display shows two leaf numbers per spread; the user enters a leaf.
         */
        function openGoToPageDialog() {
            if (!isPaginatedLayout() || !PageMap.ensure()) return;
            const twoCol = !!(editor && editor.classList.contains('two-col-layout'));
            const d = pageDisplayFromSpread(PageMap.current(), PageMap.count(), twoCol);
            const raw = window.prompt(
                'Go to page (1\u2013' + d.totalLeaves + '):',
                String(d.left));
            if (raw == null) return;
            const leaf = parseInt(String(raw).replace(/[^\d].*$/, '').trim(), 10);
            if (!isFinite(leaf) || leaf < 1) return;
            const clamped = Math.min(leaf, d.totalLeaves);
            const spread0 = twoCol ? Math.floor((clamped - 1) / 2) : (clamped - 1);
            try { if (typeof captureReturnJump === 'function') captureReturnJump(); } catch (eRj) {}
            PageMap.goto(spread0);
            try {
                const t = topLeftModelIndexTwoCol();
                if (t >= 0) _readingAnchor = t;
            } catch (eA) {}
            try { updatePageIndicator(); } catch (eI) {}
            try { if (typeof postChapterLabel === 'function') postChapterLabel(); } catch (eC) {}
        }

        /**
         * Position in the whole book, in pages.
         *
         * The editor's own scrollbar spans the range currently laid out and nothing more --
         * about 28 pages of a 1400-page novel -- so dragging it could not reach either end.
         * This addresses pages, which is the coordinate the paginated model is built on and
         * the only one that describes the document however little of it is mounted.
         * PageMap.goto() already mounts the range a page falls in, so seeking anywhere is
         * the same operation as turning a page.
         */
        let _scrubDragging = false;

        function updatePageScrubber() {
            const host = document.getElementById('page-scrubber');
            const range = document.getElementById('page-scrubber-range');
            if (!host || !range) return;
            if (!isPaginatedLayout() || !PageMap.ensure()) {
                host.style.display = 'none';
                return;
            }
            host.style.display = 'block';
            // While a drag is in flight the thumb belongs to the reader: writing a position
            // into it from the view they have not arrived at yet fights their hand.
            if (_scrubDragging) return;
            const total = Math.max(1, PageMap.count());
            range.max = String(total - 1);
            range.value = String(Math.max(0, Math.min(PageMap.current(), total - 1)));
            try { paintScrubberTicks(); } catch (eTk) {}
        }

        function bindPageScrubber() {
            const range = document.getElementById('page-scrubber-range');
            const bubble = document.getElementById('page-scrubber-bubble');
            if (!range || range.__tzBound) return;
            range.__tzBound = true;

            function showBubble() {
                if (!bubble) return;
                const total = Math.max(1, PageMap.count());
                const v = parseInt(range.value, 10) || 0;
                // Scrubber steps are spreads; the bubble shows leaf pages via the helper.
                const twoCol = !!(editor && editor.classList.contains('two-col-layout'));
                const d = pageDisplayFromSpread(v, total, twoCol);
                bubble.textContent = d.bubble;
                bubble.style.left = (total > 1 ? (v / (total - 1)) * 100 : 0) + '%';
                bubble.classList.add('showing');
            }
            function hideBubble() { if (bubble) bubble.classList.remove('showing'); }

            function seek() {
                _scrubDragging = false;
                hideBubble();
                const v = parseInt(range.value, 10);
                if (!isFinite(v)) return;
                const wantedEnd = v >= (parseInt(range.max, 10) || 0);
                PageMap.goto(v);
                // Pages beyond the ranges that have been laid out are an estimate, so
                // arriving somewhere re-measures it and the total moves: dragging to the end
                // of a 2,907-page estimate landed on page 5,210 of a now 5,355-page book --
                // the last range of the book, but visibly short of its end. Settle onto
                // whatever the last page turns out to be once we are standing on it.
                if (wantedEnd) {
                    for (let i = 0; i < 3; i++) {
                        const last = Math.max(0, PageMap.count() - 1);
                        if (PageMap.current() >= last) break;
                        PageMap.goto(last);
                    }
                }

                // Dragging the scrubber is a reader saying where they are, so it moves the
                // reading anchor -- the same as turning a page, and for the same reason.
                //
                // Only PageMap.step() used to set it, and the anchor is what a column switch
                // restores. So: read to page 576, drag the thumb back to the title page,
                // switch to 2-column, and the switch put you back at page 576 -- it had been
                // told the reader was still there. Reported exactly that way.
                //
                // Set here rather than inside PageMap.goto(), which would look tidier and be
                // wrong: goto() is also the tail of the column switch itself, and re-reading
                // the anchor from the view a switch just produced replaces "what I was
                // reading" with "the top of the page it landed on", so switching back and
                // forth walks backwards a page at a time. That is the decay the comment on
                // step() describes. The distinction is not where the code sits, it is
                // whether a person asked to move.
                try {
                    const t = topLeftModelIndexTwoCol();
                    if (t >= 0) _readingAnchor = t;
                } catch (eA) {}

                updatePageIndicator();
            }

            // Seek on release rather than on every input event: a drag across a novel would
            // otherwise mount a range per pixel of travel, and a mount lays out 800 blocks.
            // The bubble is what makes that acceptable -- it names the page under the thumb
            // while the view stays where it is.
            range.addEventListener('pointerdown', function () { _scrubDragging = true; showBubble(); });
            range.addEventListener('input', showBubble);
            range.addEventListener('change', seek);
            range.addEventListener('blur', function () { _scrubDragging = false; hideBubble(); });
        }

        /** Put the editor into or out of page layout to match the current view state. */
        function syncPaginationClass() {
            if (!editor) return;
            const on = !!state.pageAdvance && state.mode !== 'source';
            const was = editor.classList.contains('page-mode');
            if (on === was) {
                try { document.body.classList.toggle('tz-pages', on); } catch (eB) {}
                return;
            }
            editor.classList.toggle('page-mode', on);
            try { document.body.classList.toggle('tz-pages', on); } catch (eB2) {}
            PageMap.invalidate();
            // Entering or leaving pagination changes what a page is, so nothing measured
            // under the old layout describes the new one.
            try { PageChunks.invalidate(); } catch (ePC) {}
            if (!on) {
                editor.scrollLeft = 0;
                currentTwoColPage = 0;
                // Drop any leftover inline column overrides from broken experiments.
                try {
                    editor.style.columnWidth = '';
                    editor.style.columnGap = '';
                    editor.style.columnCount = '';
                    editor.style.columnFill = '';
                    editor.style.paddingLeft = '';
                    editor.style.paddingRight = '';
                } catch (eClr) {}
            }
            // The page numbers and the scrubber belong to a paginated layout, and this is
            // the one place every route into and out of one passes through. Without it the
            // scrubber stayed on screen after a switch to scrolling, offering to seek pages
            // that no longer existed.
            try { updatePageIndicator(); } catch (ePI) {}

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
                // Entering pagination on a large document lays out ONE range instead of
                // remounting the whole thing.
                //
                // Not "remount everything, then narrow it": loadMarkdownContent paints
                // progressively, so a window mounted synchronously beforehand was buried by
                // the deferred batches arriving after it -- 4167 elements for a 3767-block
                // document. The full mount is skipped entirely, which is also where the
                // saving is. Turning virtualisation off by hand is what the remount was for.
                //
                // This is the only chokepoint that catches every route into pagination:
                // applyViewState sets state.pageAdvance directly and never goes through the
                // set_page_advance command, so hooking there missed the selector entirely.
                const windowing = PAGE_WINDOWING_ENABLED
                    && on
                    && DocumentModel.blocks
                    && DocumentModel.blocks.length >= PAGE_WINDOW_MIN_BLOCKS;
                // Books must never remount via loadMarkdownContent(toMarkdown()): that
                // treats publisher HTML as Markdown and paints raw <div class="calibre…">.
                if (DocumentModel.kind === 'epub') {
                    const anchor = (typeof _readingAnchor === 'number' && _readingAnchor >= 0)
                        ? _readingAnchor
                        : modelLocationFromDocumentLine(Math.max(1, line | 0)).blockIndex;
                    if (typeof remountBookSurface === 'function') {
                        remountBookSurface({ anchorBlock: anchor });
                    } else if (windowing) {
                        DocumentModel.virtEnabled = false;
                        unbindVirtScroll();
                        PageChunks.ensure(DocumentModel.blocks.length);
                        mountPageChunk(PageChunks.chunkOfBlock(anchor));
                    }
                } else if (windowing) {
                    DocumentModel.virtEnabled = false;
                    unbindVirtScroll();
                    PageChunks.ensure(DocumentModel.blocks.length);
                    const anchor = modelLocationFromDocumentLine(Math.max(1, line | 0)).blockIndex;
                    mountPageChunk(PageChunks.chunkOfBlock(anchor));
                } else {
                    PageChunks.mounted = -1;
                    const md = DocumentModel.toMarkdown();
                    loadMarkdownContent(md, { deferPaint: true, stickyLine: line });
                }
                if (typeof HistoryManager !== 'undefined') HistoryManager.isRestoring = wasRestoring;
            } catch (e) {
                window.showDebugTelemetry('syncPaginationClass: remount failed ' + e.message);
            }
        }

        // A block that begins a page can measure a few pixels short of the boundary: the
        // column break falls on its margin edge, and sub-pixel layout adds to that.
        // Measured in the running app, a block starting page 4 at x=3452 reported 3450, so
        // a 1px epsilon floored it onto page 3 and every switch landed a page early.
        // --- PAGE GEOMETRY (complete rewrite) -----------------------------------------
        // One owner for: page height, column sizing, page stride, and horizontal seek.
        // Callers: PageMap, applyPageModeHeight, mountPageChunk, resize, scrubber.
        //
        // Contract (1-column):
        //   column-width = paneW (integer px), column-gap = 0, column-count = auto
        //   pageStride   = paneW   (identical integer — never clientWidth+gap guesswork)
        //   scrollLeft   = pageIndex * pageStride
        //
        // Contract (2-column):
        //   column-width = floor((paneW - gap) / 2), column-gap = 60
        //   pageStride   = paneW + gap   (one screen of two columns, then the following gap)
        //   scrollLeft   = pageIndex * pageStride
        //
        // Native scrollbars are hidden (body.tz-pages); the scrubber is the only track.
        // -----------------------------------------------------------------------------
        const PAGE_EDGE_SLOP = 12;
        const PAGE_FOOT_RESERVE = 26;
        const PAGE_TWO_COL_GAP = 60;

        const PageGeometry = {
            _stride: 0,
            _paneW: 0,
            _twoCol: false,

            clear: function () {
                this._stride = 0;
                this._paneW = 0;
                this._twoCol = false;
                if (!editor) return;
                editor.style.height = '';
                editor.style.width = '';
                editor.style.maxWidth = '';
                editor.style.minWidth = '';
                editor.style.columnWidth = '';
                editor.style.columnGap = '';
                editor.style.columnCount = '';
                editor.style.columnFill = '';
                editor.style.paddingLeft = '';
                editor.style.paddingRight = '';
                editor.style.boxSizing = '';
                // relayout() sets this; clear() is its opposite and must undo all of it.
                try { editor.style.removeProperty('--tz-page-h'); } catch (eVar) {}
                editor.scrollLeft = 0;
            },

            /** Recompute pane size, lock columns, cache stride. Returns stride. */
            relayout: function () {
                if (!editor || typeof isPaginatedLayout !== 'function' || !isPaginatedLayout()) {
                    this.clear();
                    try { document.body.classList.remove('tz-pages'); } catch (e) {}
                    return 0;
                }
                try { document.body.classList.add('tz-pages'); } catch (e) {}
                try {
                    if (mainContainer) {
                        mainContainer.scrollLeft = 0;
                        mainContainer.scrollTop = 0;
                        mainContainer.style.overflow = 'hidden';
                    }
                } catch (e2) {}

                const wrap = document.getElementById('editor-wrapper');
                const box = wrap || mainContainer;
                const h = Math.max(0, (box ? box.clientHeight : 0) - PAGE_FOOT_RESERVE);

                // Every write here is guarded on change. relayout() runs from a
                // ResizeObserver on the editor, so any style that alters its box schedules
                // another observation -- and re-applying identical values on every pass is
                // what produced "ResizeObserver loop completed with undelivered
                // notifications" for each layout.
                const setStyle = function (prop, value) {
                    if (editor.style[prop] !== value) editor.style[prop] = value;
                };

                setStyle('boxSizing', 'border-box');
                setStyle('minWidth', '0');
                setStyle('paddingLeft', '0');
                setStyle('paddingRight', '0');
                setStyle('height', h > 40 ? (h + 'px') : '');
                setStyle('columnFill', 'auto');
                setStyle('columnCount', 'auto');

                // Publish the page box so CSS can size a plate against the page rather than
                // against the window.
                //
                // vh is the window, and the page is the window minus the tab strip, toolbar
                // and status bar -- so a cover bounded by 66vh stopped 240px short of the
                // bottom of a 763px page, and stopped there harder the more chrome was on
                // screen. Worse, it shrank covers below their own resolution: Matter ships
                // 510x680 and was being painted at 391x521. This is the only number that
                // actually describes the space a page has, and it is already computed here.
                if (h > 40) editor.style.setProperty('--tz-page-h', h + 'px');
                else editor.style.removeProperty('--tz-page-h');

                // Force layout, then read the only width we will ever trust.
                //
                // Fractional, deliberately. width:100% resolves against a parent that is very
                // often fractional -- 911.36px and 1848.32px, measured in the running app --
                // and the browser lays the columns out on that. Flooring it to an integer
                // made the stride disagree with the real column pitch by a third of a pixel a
                // page: invisible on page 2, 148px of drift by page 411, with the previous
                // column showing down the margin.
                //
                // Pinning the pane to a whole number of pixels fixed the arithmetic and broke
                // something worse: a pixel width does not follow its container, so collapsing
                // the sidebar or resizing the window left the column at its old size and the
                // text ran off the edge of the window until something happened to relayout.
                //
                // A fractional stride costs nothing, because drift only accumulates when
                // pages are stepped by addition. Every seek here is index * stride computed
                // from the page number, so the error is one rounding, once, and never grows.
                void editor.offsetWidth;
                // getBoundingClientRect(), not clientWidth: clientWidth is rounded to an
                // integer and rounding it back is the whole bug. Padding and border are set
                // to zero above, so the border box and the content box are the same.
                //
                // Refuse a pane we cannot measure, rather than inventing one. A hidden
                // editor -- Source mode, or the gap in a tab switch where the outgoing
                // document has been torn down -- measures 0, and Math.max(1, 0) turned
                // "I cannot measure this" into a one-pixel column. One pixel is a
                // perfectly valid-looking number: it is > 0, so _stride passed every
                // later guard, and column-width: 1px went out to the layout, where a
                // document sets one glyph per line. Returning 0 puts this back in the
                // same shape as go(), which already refuses rather than seeking to zero.
                // The previous column styles stay put; the ResizeObserver re-measures the
                // moment the editor is on screen again.
                const measured = editor.getBoundingClientRect().width || editor.clientWidth;
                if (!(measured > 1)) {
                    this._stride = 0;
                    this._paneW = 0;
                    return 0;
                }
                let paneW = measured;
                setStyle('width', '100%');
                setStyle('maxWidth', '100%');
                const twoCol = editor.classList.contains('two-col-layout');
                const gap = twoCol ? PAGE_TWO_COL_GAP : 0;

                // The exact width the browser will use, not a floor of it: with column-count
                // auto the used width is (pane - gap) / N whatever we ask for, so asking for
                // the same figure keeps our arithmetic and its layout identical.
                let colW;
                let stride;
                if (twoCol) {
                    colW = Math.max(1, (paneW - gap) / 2);
                    // Two columns plus the gap between them fill the pane; the next spread
                    // begins after the trailing gap.
                    stride = paneW + gap;
                } else {
                    colW = paneW;
                    stride = paneW; // gap 0 => stride is the column pitch exactly
                }

                setStyle('columnGap', gap + 'px');
                setStyle('columnWidth', colW + 'px');
                void editor.offsetWidth;

                this._paneW = paneW;
                this._twoCol = twoCol;
                this._stride = stride;
                return this._stride;
            },

            stride: function () {
                if (!(this._stride > 0)) this.relayout();
                return this._stride > 0 ? this._stride : 1;
            },

            maxScroll: function () {
                if (!editor) return 0;
                return Math.max(0, editor.scrollWidth - editor.clientWidth);
            },

            localCount: function () {
                if (!editor || !isPaginatedLayout()) return 1;
                const s = this.stride();
                // scrollWidth is the multicol overflow extent; with our lock it is ~ n * stride
                // (or n*stride - gap for 2-col). ceil((sw-1)/s) matches PageMap's old contract.
                const byContent = Math.max(1, Math.ceil((Math.max(editor.scrollWidth, s) - 1) / s));

                // ...but never more pages than the reader can actually reach.
                //
                // Those are different numbers. Content extent says how far the text runs;
                // maxScroll says how far the view can travel, and it is scrollWidth minus a
                // viewport. Paging assigns scrollLeft = i * stride and clamps to maxScroll,
                // so any page whose start lies beyond it is not a page you can turn to --
                // the seek lands on the same pixels as the one before, localIndex reports
                // the page you were already on, and stepLocal's safety net falls through to
                // crossing into the next range. At the end of the document there is no next
                // range, so the reader is simply stuck: "cannot get past page 164 of 166",
                // which is exactly what page-window-app caught.
                //
                // In one column the two agree, which is why this survived so long. They
                // part company where the stride covers two columns and a gap.
                const reachable = Math.max(1,
                    Math.floor(this.maxScroll() / s + 0.001) + 1);
                return Math.min(byContent, reachable);
            },

            localIndex: function () {
                if (!editor || !isPaginatedLayout()) return 0;
                const s = this.stride();
                return Math.max(0, Math.min(
                    this.localCount() - 1,
                    Math.round((editor.scrollLeft || 0) / s)
                ));
            },

            /**
             * Go to a local page. The ONLY place that assigns editor.scrollLeft for paging.
             * Always: scrollLeft = index * stride (clamped to maxScroll).
             */
            go: function (localIndex) {
                if (!editor || !isPaginatedLayout()) return false;
                if (!(this._stride > 0)) this.relayout();

                // Refuse rather than seek to zero.
                //
                // This read _stride raw where every other caller goes through stride(),
                // which floors at 1. A relayout does not always produce a stride -- during
                // a column switch the multicol has been asked for but not yet applied, so
                // the measurement comes back 0 -- and then target = i * 0 = 0, the reader
                // is put at the very front of the book, and this returned true. The caller
                // believed the seek had happened.
                //
                // That is not a hypothetical: reading-chrome-browser lost this race about
                // one run in three, seeking to 60% of a 384-page book and landing on block
                // 0, and it was patched twice in the suite -- first by waiting for the page
                // map to have counted, then by retrying the seek -- because the failure
                // looked like a flaky test rather than a seek that had reported success
                // without moving. Reporting false lets the caller retry, which is what the
                // retry in that suite was standing in for.
                if (!(this._stride > 0)) return false;

                const s = this._stride;
                const maxL = Math.max(0, this.localCount() - 1);
                const i = Math.max(0, Math.min(localIndex | 0, maxL));
                const max = this.maxScroll();
                // Integer math only — never fractional page positions, except the last one.
                //
                // The final page of a range is usually partial: content ends part way into
                // it, so its start offset sits just past the end of the scroll range.
                // Measured on Xeelee -- page 39 of 40 begins at 70200 while the furthest
                // scrollLeft can reach is 70181, nineteen pixels short.
                //
                // This used to snap back to the previous whole boundary, which had two
                // costs. It hid the tail of every range -- close to a page of text per
                // chunk, unreachable by paging. And it stranded the reader: PageMap.step
                // sees a page it believes is in range, seeks to it, is silently returned to
                // where it started, and reports success -- so it never tries the next range
                // and every further press does nothing. That is the "cannot go beyond this
                // page unless I force the scrubber" report, and the scrubber escapes only
                // because it seeks into a different range and remounts.
                //
                // Ending at maxScroll shows the tail flush to the right edge, which is what
                // a short last page should look like, and it keeps localIndex() in step:
                // 70181 rounds to page 39, so the map and the view agree that the range is
                // exhausted and the next turn crosses into the next one.
                let target = i * s;
                if (target > max) target = max;
                if (target < 0) target = 0;

                if (typeof markProgrammaticScroll === 'function') markProgrammaticScroll(400);
                try {
                    if (mainContainer) {
                        mainContainer.scrollLeft = 0;
                        mainContainer.scrollTop = 0;
                    }
                } catch (e) {}
                editor.scrollTop = 0;
                editor.scrollLeft = target;
                // Re-assert once; some engines clamp then leave a fraction.
                if (editor.scrollLeft !== target) editor.scrollLeft = target;
                return true;
            },

            /** Snap whatever scrollLeft is to the nearest page (user scroll / trackpad). */
            snap: function () {
                if (!editor || !isPaginatedLayout()) return false;
                return this.go(this.localIndex());
            }
        };

        function twoColPageWidth() {
            return PageGeometry.stride();
        }

        /** The mounted .block element for a model index, or null. */
        function elementForModelIndex(bi) {
            if (!editor) return null;
            // Blocks carry their index as an attribute, so ask for it directly rather than
            // walking every block. The linear scan showed up wherever this is called in a
            // loop, and it is.
            const direct = editor.querySelector('.block[data-model-index="' + (bi | 0) + '"]');
            if (direct) return direct;
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
                // A block that begins a page can measure a few pixels short of the
                // boundary -- the column break lands on its margin edge, and sub-pixel
                // layout adds to that. Measured in the real app: a block starting page 4
                // at x=3452 reported absX 3450, so a 1px epsilon floored it onto page 3.
                // Everything downstream followed: the switch landed a page early, and the
                // anchor filter then rejected every block on screen.
                // PAGE_EDGE_SLOP is far below a page width, so it cannot pull a block onto
                // the wrong page, only onto the one it visually starts.
                return Math.max(0, Math.floor((absX + PAGE_EDGE_SLOP) / twoColPageWidth()));
            } catch (e) {
                return null;
            }
        }

        /**
         * Model index of the block a reader would start on: topmost block of the leftmost
         * visible column. Blocks scrolled onto another page are excluded horizontally, so
         * this answers for the page actually on screen.
         */
        /**
         * Where the reader is in a book, reported to the host so it can be restored.
         *
         * Driven by scrolling rather than by _readingAnchor: the anchor records deliberate
         * jumps -- an outline click, a page turn we performed -- and someone who simply
         * reads for an hour never sets it. The position that matters is where they are, not
         * where they were last sent.
         *
         * Debounced, and only sent when the block actually changes, so turning pages does
         * not write a file per page.
         */
        let _bookPosLast = -1;
        let _bookPosTimer = null;

        /**
         * Remember where the reader is (block index). The host stores it only when
         * _currentFilePath is set — untitled buffers and the welcome screen are ignored
         * there. Works for epub and markdown alike.
         */
        /**
         * Forget a position report that has not been sent yet.
         *
         * The report is debounced, so one armed by scrolling a document can fire after the
         * host has already switched to another tab -- and the host attributes it to whatever
         * document is current by then. Reading a .txt and switching to a book wrote the
         * .txt's block number against the book's path, and the book then reopened at its
         * cover. Called wherever the host announces that this document is being replaced.
         */
        function cancelPositionReport() {
            if (_bookPosTimer) {
                try { clearTimeout(_bookPosTimer); } catch (e) {}
                _bookPosTimer = null;
            }
            _bookPosLast = -1;
        }

        function reportBookPosition() {
            if (typeof DocumentModel === 'undefined') return;
            if (_bookPosTimer) clearTimeout(_bookPosTimer);
            _bookPosTimer = setTimeout(function () {
                _bookPosTimer = null;
                if (typeof DocumentModel === 'undefined') return;
                const bi = currentReadingBlock();
                if (bi < 0 || bi === _bookPosLast) return;
                _bookPosLast = bi;
                try { postMsg('book_position:' + bi); } catch (e) {}
            }, 1200);
        }

        /**
         * The block the reader is looking at, for remembering a position.
         *
         * Paginated, that is the top-left block of the spread. Scrolling, it is the first
         * block at or below the top of the *viewport* -- and the viewport is
         * #main-container, not #editor, because in a scrolling layout the editor is the
         * whole document and every mounted block intersects it. Measured against the editor
         * it answered "the first block in the mounted window", roughly the overscan ahead of
         * where the reader actually was: 558 reported for a reader sitting at 600, then 516
         * for one sitting at 558. Storing that and restoring it walks backwards through the
         * document a screenful at a time, every time the tab is reopened.
         */
        function currentReadingBlock() {
            if (!editor) return -1;
            if (isPaginatedLayout()) return topLeftModelIndexTwoCol();
            const host = (mainContainer || editor).getBoundingClientRect();
            const blocks = editor.querySelectorAll('.block');
            for (let i = 0; i < blocks.length; i++) {
                const r = blocks[i].getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                if (r.bottom <= host.top + 1) continue;      // scrolled past
                if (r.top >= host.bottom - 1) break;         // below the fold
                const mi = DocumentModel.modelIndexOfEl(blocks[i]);
                if (mi >= 0) return mi;
            }
            return -1;
        }

        function topLeftModelIndexTwoCol() {
            if (!editor) return -1;
            const host = editor.getBoundingClientRect();
            const blocks = editor.querySelectorAll('.block');
            // Hoisted: both of these are constant for the whole scan, and PageMap.width()
            // reaches getComputedStyle, which is not something to do per block.
            const paged = isPaginatedLayout();
            const pageW = paged ? twoColPageWidth() : 0;
            const scrollLeft = editor.scrollLeft || 0;
            
            if (paged && pageW > 0) {
                const rem = scrollLeft % pageW;
                if (rem > 5 && rem < pageW - 5) {
                    return -1; // Stale scrollLeft due to layout change; fallback to _readingAnchor
                }
            }

            const curPage = paged ? Math.max(0, Math.round(scrollLeft / pageW)) : -1;
            let best = null;
            for (let i = 0; i < blocks.length; i++) {
                const r = blocks[i].getBoundingClientRect();
                if (r.width === 0 && r.height === 0) continue;
                if (r.bottom <= host.top + 1 || r.top >= host.bottom - 1) continue;   // above/below
                if (r.right <= host.left + 1 || r.left >= host.right - 1) continue;   // another page
                // Only blocks that this page reports as its own. A block split across a
                // page break has a bounding rect spanning both fragments, so it is visible
                // here while its page resolves to the previous one. Picking such a block as
                // the anchor made the two disagree, and a round trip came back a page early.
                //
                // Computed from the rect already in hand. This used to call
                // PageMap.pageOfBlock(mi), which looked the element up again by scanning
                // every block -- a nested scan inside a scan, on a hot path.
                if (paged) {
                    const absX = (r.left - host.left) + scrollLeft;
                    if (Math.floor((absX + PAGE_EDGE_SLOP) / pageW) !== curPage) continue;
                }
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
        /**
         * === PAGES ===
         *
         * Paginated layouts are uniform: every page is the same width, so page N simply
         * lives at N * pageWidth. There is nothing to precompute and nothing to keep in
         * step with the layout.
         *
         * This replaces a 110-line page map that walked every block, recorded which page
         * each one started on, cached the result and invalidated it on resize, edit and
         * mode change. All of that only to answer questions arithmetic already answers --
         * and it answered one of them wrongly: a block fragmented across a page break
         * reports the bounding box of all its fragments, so the recorded start blocks
         * stopped increasing, and looking a block up returned a page hundreds of blocks
         * early.
         *
         * The only question needing measurement is "which page is this block on", and that
         * is one rect, not a scan of the document.
         */
        // The block the reader is on. Set when they turn a page or scroll; carried across
        // column switches unchanged, because a switch moves the view, not the reader.
        let _readingAnchor = -1;

        /**
         * Pagination in ranges, so the browser is not asked to fragment the whole document.
         *
         * Pagination and virtualisation are mutually exclusive: the browser can only break
         * content it has laid out, so entering page mode mounts everything. That is correct
         * and it is what costs ~66ms per keystroke on a 3767-block document against ~7ms in
         * a scrolling view -- one multi-column flow, re-fragmented per character. An epub is
         * the same shape with an order of magnitude more content.
         *
         * The document is therefore laid out one fixed range of blocks at a time. Each range
         * has a page count; the cumulative sum gives the global page number. This is exactly
         * DocumentModel.blockHeights and prefixHeight() one level up -- per-range pages
         * instead of per-block pixels -- and it carries the same rules, which were all
         * learned the expensive way:
         *
         *   - estimate, then refine from measurement (estimateBlockHeight)
         *   - a structural edit SPLICES the map, it does not discard it: throwing away every
         *     measurement moved the viewport by the accumulated estimate error
         *   - the range on screen is measured exactly, never trusted from its estimate
         *
         * Blocks are the anchor, not page numbers. Page numbers move as estimates are
         * refined; block indices do not, and the column round trip already depends on that.
         */
        const PageChunks = {
            /**
             * Blocks per range. 400 was tuned on a Markdown fixture; measured on two real
             * novels, the cost that matters is the page turn that crosses a boundary and
             * has to lay out the next range:
             *
             *   size    turn (ms)    cross (ms)         pages per range
             *            in-range    Xeelee / Matter    Xeelee / Matter
             *    200        1          18 /  20            7 /  16
             *    400        1          58 /  46           14 /  31
             *    800        2          74 /  84           28 /  62
             *   1600        3         201 / 172           55 / 124
             *
             * Amortised over the pages between crossings it is flat -- about 1.5-4 ms a
             * turn at every size -- so the choice is the worst case a reader feels against
             * how much of the book is laid out at once. 800 keeps that hitch under 100ms
             * while halving how often it happens, and doubles how far the scrollbar reaches,
             * since the scroll extent is the mounted range and nothing more. That last part
             * is a symptom, not a reason: a book-wide position control is the real answer.
             */
            size: 800,
            /** Pages per range: measured where known, estimated elsewhere. */
            counts: null,
            /** Which entries in counts came from a real layout. */
            measured: null,
            /** Pages per block, refined as ranges are measured. Seeds the estimates. */
            perBlock: 0.06,
            /**
             * The figure invalidate() goes back to. A property, not a module constant: the
             * selftest lifts this object out with new Function() and evaluates it alone, so
             * anything it reaches for from an enclosing scope is a ReferenceError there and
             * nowhere else.
             */
            seedPerBlock: 0.06,
            /** The range currently laid out, or -1. */
            mounted: -1,
            /** Blocks in the document, so the last (partial) range is not counted as full. */
            docBlocks: 0,

            chunkCount: function (nBlocks) {
                return Math.max(1, Math.ceil(Math.max(0, nBlocks | 0) / this.size));
            },

            chunkOfBlock: function (bi) {
                const c = Math.floor(Math.max(0, bi | 0) / this.size);
                return this.counts ? Math.min(c, this.counts.length - 1) : c;
            },

            firstBlockOfChunk: function (c) { return Math.max(0, c | 0) * this.size; },

            /** How many blocks a range really holds. The last one is short. */
            blocksInChunk: function (c) {
                const start = this.firstBlockOfChunk(c);
                const total = this.docBlocks > 0 ? this.docBlocks : (this.counts ? this.counts.length * this.size : 0);
                return Math.max(1, Math.min(this.size, total - start));
            },

            /** Build or resize the map. Existing measurements survive. */
            ensure: function (nBlocks) {
                this.docBlocks = Math.max(0, nBlocks | 0);
                const n = this.chunkCount(nBlocks);
                if (!this.counts) { this.counts = []; this.measured = []; }
                while (this.counts.length < n) {
                    this.counts.push(this.estimateChunkPages(this.counts.length, nBlocks));
                    this.measured.push(false);
                }
                if (this.counts.length > n) {
                    this.counts.length = n;
                    this.measured.length = n;
                }
                return n;
            },

            /** Pages a range is expected to need, from its block count. */
            estimateChunkPages: function (c, nBlocks) {
                const blocks = (nBlocks === undefined)
                    ? this.blocksInChunk(c)
                    : Math.max(1, Math.min(this.size, (nBlocks | 0) - this.firstBlockOfChunk(c)));
                return Math.max(1, Math.round(blocks * this.perBlock));
            },

            /**
             * Record a real page count. Only this range's entry changes; every other
             * measurement is left alone, so the pages before the edit do not move.
             */
            setMeasured: function (c, pages) {
                if (!this.counts || c < 0 || c >= this.counts.length) return;
                this.counts[c] = Math.max(1, pages | 0);
                this.measured[c] = true;
                // Refine the estimate for ranges not yet laid out.
                // Each measured range contributes the blocks it actually holds. Adding a
                // full size for every one counts the last, short range as though it were
                // full: Matter ends on 376 blocks, so two measured ranges totalling 180
                // pages were divided by 1600 instead of 1176 and every unmeasured range was
                // estimated at 90 pages when the one that had been laid out took 121. The
                // book read 540 pages in one column and 708 in two, for the same text.
                let sumPages = 0, sumBlocks = 0;
                for (let i = 0; i < this.counts.length; i++) {
                    if (!this.measured[i]) continue;
                    sumPages += this.counts[i];
                    sumBlocks += this.blocksInChunk(i);
                }
                if (sumBlocks > 0) {
                    const next = Math.max(0.005, Math.min(1, sumPages / sumBlocks));
                    const changed = Math.abs(next - this.perBlock) > 1e-6;
                    this.perBlock = next;
                    // Ranges that have never been laid out follow the refined figure. Without
                    // this the total stayed at the seed estimate for every unmeasured range
                    // -- 203 pages reported for a document that is really about 106 -- and
                    // only converged as the reader happened to visit each range.
                    if (changed && this.counts) {
                        for (let i = 0; i < this.counts.length; i++) {
                            if (!this.measured[i]) this.counts[i] = this.estimateChunkPages(i);
                        }
                    }
                }
            },

            /** Pages before range c. */
            prefixPages: function (c) {
                if (!this.counts) return 0;
                let n = 0;
                const end = Math.min(c | 0, this.counts.length);
                for (let i = 0; i < end; i++) n += this.counts[i] || 1;
                return n;
            },

            totalPages: function () {
                return this.prefixPages(this.counts ? this.counts.length : 0);
            },

            /** Which range holds a global page, and the page's index within it. */
            locatePage: function (p) {
                if (!this.counts || !this.counts.length) return { chunk: 0, local: 0 };
                let want = Math.max(0, p | 0);
                for (let i = 0; i < this.counts.length; i++) {
                    const n = this.counts[i] || 1;
                    if (want < n) return { chunk: i, local: want };
                    want -= n;
                }
                const last = this.counts.length - 1;
                return { chunk: last, local: (this.counts[last] || 1) - 1 };
            },

            /**
             * A structural edit. The range that changed loses its measurement -- its page
             * count really is unknown now -- and ranges after it shift if the block count
             * crossed a boundary. Everything else keeps what it measured, which is the rule
             * that stopped the viewport moving on every insert in the scrolling path.
             */
            spliceBlocks: function (atBlock, delta, nBlocksAfter) {
                if (!this.counts) return;
                const c = this.chunkOfBlock(atBlock);
                if (c >= 0 && c < this.measured.length) {
                    this.measured[c] = false;
                    this.counts[c] = this.estimateChunkPages(c, nBlocksAfter);
                }
                this.ensure(nBlocksAfter);
            },

            /**
             * Forget every page count.
             *
             * This was an empty function, which is not the same as "nothing needs doing":
             * a page count belongs to a layout, and one column's measurements describe
             * nothing about two. They survived a column switch, so the totals a reader saw
             * after switching were part measurement of the layout they had just left. It
             * also let each section of the selftest inherit the previous section's density.
             *
             * The seed goes back too. A refined pages-per-block is a fact about a document
             * *in a layout*, and carrying it across is the same mistake one level down.
             */
            invalidate: function () {
                this.counts = null;
                this.measured = null;
                this.mounted = -1;
                this.perBlock = this.seedPerBlock;
            }
        };

        /**
         * Below this many blocks a paginated document is mounted whole, as before.
         * Windowing buys nothing on a normal note and every extra path is somewhere for a
         * bug to live, so it only engages where the cost is real.
         */
        const PAGE_WINDOW_MIN_BLOCKS = 800;

        /**
         * Page windowing is on.
         *
         * Held disabled for one commit while the column round trip was chased down. The
         * suspicion was a real off-by-one in the windowed anchoring; it was not. The app's
         * own telemetry showed goToPage running twice on a column switch -- "block 73 is on
         * page 4 of 230" and then "page 3 of 210" -- because the layout settles twice: once
         * for the new column count and again when the host finishes resizing the window to
         * that mode's saved geometry. The assertion was landing between the two.
         *
         * Both halves of that are now fixed. The test waits for the geometry to hold still
         * rather than sleeping, and goToPageHoldingBlock re-anchors itself if the geometry
         * moves under it, so the landing corrects instead of depending on some other caller
         * happening to re-run. That second part is the product fix: without it the round
         * trip was correct in one run and a page early in the next.
         */
                const PAGE_WINDOWING_ENABLED = true;

        function pageWindowingActive() {
            return PAGE_WINDOWING_ENABLED
                && isPaginatedLayout()
                && typeof DocumentModel !== 'undefined'
                && DocumentModel.blocks
                && DocumentModel.blocks.length >= PAGE_WINDOW_MIN_BLOCKS;
        }

        /**
         * Lay out one range of blocks and measure how many pages it really needs.
         *
         * The measurement is the point. An estimated page count for the range on screen is
         * the 2px page-boundary bug in another form: everything downstream -- the page
         * indicator, a page turn, the block a column switch anchors on -- is derived from
         * it, so it has to come from the layout rather than from arithmetic about it.
         */
        function mountPageChunk(c) {
            if (!editor || !pageWindowingActive()) return false;
            const n = DocumentModel.blocks.length;
            PageChunks.ensure(n);
            c = Math.max(0, Math.min(c | 0, PageChunks.counts.length - 1));

            const start = PageChunks.firstBlockOfChunk(c);
            const end = Math.min(n, start + PageChunks.size);
            const frag = document.createDocumentFragment();
            for (let i = start; i < end; i++) {
                const raw = DocumentModel.blocks[i] ? DocumentModel.blocks[i].raw : '';
                const el = createPreviewBlockEl(raw, false, i);
                el.setAttribute('data-model-index', String(i));
                if (_bookDocStarts[i]) el.setAttribute('data-chapter-start', '1');
                frag.appendChild(el);
            }
            editor.innerHTML = '';
            editor.appendChild(frag);
            PageChunks.mounted = c;
            try {
                const who = (new Error().stack || '').split(String.fromCharCode(10))[2] || '';
                window.showDebugTelemetry('mountPageChunk ' + c + ' blocks ' + start + '..' +
                    (end - 1) + ' <- ' + who.trim().slice(0, 90));
            } catch (eT) {}

            try { PageGeometry.relayout(); } catch (eG) {}
            // Ask PageGeometry, do not re-derive.
            //
            // This carried its own copy of ceil((scrollWidth - 1) / stride) -- the same
            // formula PageGeometry.localCount used, and the same one that counted pages the
            // reader cannot reach. Fixing it in one place therefore fixed the number a turn
            // consults while leaving the number recorded for the range untouched, so the two
            // disagreed by construction and the second was the one that survived into
            // count(). One authority for "how many pages is this range", measured where the
            // geometry is.
            PageChunks.setMeasured(c, PageGeometry.localCount());

            if (!currentActiveBlock || !editor.contains(currentActiveBlock)) {
                currentActiveBlock = editor.querySelector('.block');
            }
            try { repaintFindHighlights(); } catch (eF) {}
            try {
                if (typeof scheduleNormaliseBookTextSize === 'function') scheduleNormaliseBookTextSize();
                else if (typeof normaliseBookTextSize === 'function') normaliseBookTextSize();
            } catch (eN) {}
            try { PageGeometry.relayout(); } catch (eG2) {}
            return true;
        }


        /**
         * Make sure a large paginated document is windowed, whatever route got it here.
         *
         * syncPaginationClass only fires on a transition -- `if (on === was) return` -- so a
         * session restored straight into Pages never passed through it and mounted the whole
         * document every launch. Since that is the state a reader actually saves, the
         * transition hook alone would have missed the common case entirely.
         */
        function ensurePageWindow() {
            try {
                if (!pageWindowingActive()) return false;
                const mountedBlocks = editor ? editor.querySelectorAll('.block').length : 0;
                if (PageChunks.mounted >= 0 && mountedBlocks <= PageChunks.size) return false;
                DocumentModel.virtEnabled = false;
                unbindVirtScroll();
                PageChunks.ensure(DocumentModel.blocks.length);
                const line = (typeof _stickyLineCache !== 'undefined' && _stickyLineCache)
                    ? _stickyLineCache : 1;
                const anchor = modelLocationFromDocumentLine(Math.max(1, line | 0)).blockIndex;
                return mountPageChunk(PageChunks.chunkOfBlock(anchor));
            } catch (e) {
                window.showDebugTelemetry('ensurePageWindow: ' + e.message);
                return false;
            }
        }

        const PageMap = {
            width: function () {
                return PageGeometry.stride();
            },

            /**
             * Pages in the mounted range only, measured from the layout every time.
             *
             * The measurement is also written back to the map. A single reading taken when
             * the range was mounted went stale the moment anything reflowed -- a column
             * change, a font change, a window resize -- and a stale count for the range on
             * screen poisons every global page number after it: chunk 0 recorded as 1 page
             * made the second range start at page 1, so turning past its end reported page 1
             * of a document the reader was ten pages into.
             */
            localCount: function () {
                if (!isPaginatedLayout() || !editor) return 0;
                const n = PageGeometry.localCount();
                if (pageWindowingActive() && PageChunks.mounted >= 0) {
                    if (PageChunks.counts && PageChunks.counts[PageChunks.mounted] !== n) {
                        PageChunks.setMeasured(PageChunks.mounted, n);
                    }
                }
                return n;
            },

            /** Page within the mounted range only. */
            localCurrent: function () {
                if (!isPaginatedLayout() || !editor) return 0;
                return PageGeometry.localIndex();
            },

            count: function () {
                if (!isPaginatedLayout() || !editor) return 0;
                if (!pageWindowingActive()) return this.localCount();
                PageChunks.ensure(DocumentModel.blocks.length);
                // Never report a total below the page actually on screen. Ranges that have
                // not been laid out are estimates, and an estimate that undershoots turned
                // the total into a clamp: "10 pages, currently 7" then a page turn clamped
                // to 9 and the way back landed somewhere else.
                const floor = PageChunks.prefixPages(PageChunks.mounted) + this.localCount();
                return Math.max(1, PageChunks.totalPages(), floor);
            },

            current: function () {
                if (!isPaginatedLayout() || !editor) return 0;
                if (!pageWindowingActive()) return this.localCurrent();
                return PageChunks.prefixPages(PageChunks.mounted) + this.localCurrent();
            },

            /**
             * Which page a model block sits on.
             *
             * Measured when its range is the one on screen, which is the case that matters:
             * every anchoring decision is about content the reader is looking at. For a
             * block in a range that has not been laid out the page can only be the range's
             * start -- an honest lower bound rather than a fabricated offset within it.
             */
            pageOfBlock: function (bi) {
                if (!pageWindowingActive()) {
                    const p0 = twoColPageOfElement(elementForModelIndex(bi));
                    return (p0 == null) ? this.current() : p0;
                }
                PageChunks.ensure(DocumentModel.blocks.length);
                const c = PageChunks.chunkOfBlock(bi);
                const base = PageChunks.prefixPages(c);
                if (c !== PageChunks.mounted) return base;
                const p = twoColPageOfElement(elementForModelIndex(bi));
                return (p == null) ? this.current() : base + p;
            },

            goto: function (n) {
                if (!isPaginatedLayout() || !editor) return false;
                if (!(PageGeometry._stride > 0)) PageGeometry.relayout();
                const last = this.count() - 1;
                n = Math.max(0, Math.min(last, n | 0));

                if (!pageWindowingActive()) {
                    PageGeometry.go(n);
                    currentTwoColPage = n;
                    updatePageIndicator();
                    return true;
                }

                // Mounting re-measures the range, so its page count -- and every global
                // number after it -- can change. Resolve the target again against the map as
                // it now stands, and keep going until the answer stops moving.
                //
                // This used to resolve exactly once and then give up: if re-measuring moved
                // page n into a *different* range, it applied the local index from the stale
                // estimate to the range it had just mounted. Asking the scrubber for page
                // 2101 landed on 1960, and asking it for the title page landed 431 pages in.
                // The page turn that followed then reported the true number, so a single
                // press appeared to jump hundreds of pages -- which is how this was
                // reported, and why it looked like a broken Page Up rather than a broken
                // seek. Each mount measures one more range, so this tightens rather than
                // oscillates; the bound is only there so a pathological map cannot spin.
                let loc = PageChunks.locatePage(n);
                for (let tries = 0; tries < 4 && loc.chunk !== PageChunks.mounted; tries++) {
                    mountPageChunk(loc.chunk);
                    loc = PageChunks.locatePage(n);
                }
                if (loc.chunk !== PageChunks.mounted) {
                    // Still disagreeing after four measurements: land inside the range that
                    // is actually mounted rather than at an index belonging to another one.
                    return this.gotoLocal(Math.max(0, Math.min(loc.local, this.localCount() - 1)));
                }
                // A false here means the geometry was not ready, not that the page does not
                // exist. One relayout and one retry, because the caller has no better
                // information than we do and silently landing at the front of the book is
                // the failure this replaced.
                if (this.gotoLocal(loc.local) !== false) return true;
                try { PageGeometry.relayout(); } catch (e) {}
                return this.gotoLocal(loc.local);
            },

            /**
             * A page turn by the reader. This is what moves the reading anchor; switching
             * columns must not, or the anchor decays: a switch lands you at the start of
             * the page holding your content, so re-reading the anchor from the new view
             * replaces "what I was reading" with "the top of its page", and switching back
             * lands a page earlier every time.
             */
            step: function (dir) {
                let ok;
                if (!pageWindowingActive()) {
                    ok = this.goto(this.current() + (dir < 0 ? -1 : 1));
                } else {
                    // A page turn is "the next page", not "global page N + 1".
                    //
                    // Global numbers are part estimate while ranges are unmeasured, so
                    // routing a turn through them made the turn inherit the estimate error:
                    // forward then back did not return, and in 1-column every turn landed on
                    // offset 0. Within the mounted range this is exact arithmetic on a
                    // measured page count, and crossing a boundary lands on the neighbouring
                    // range's first or last page -- which is precisely where you came from.
                    ok = this.stepLocal(dir < 0 ? -1 : 1);
                }
                if (ok) { const t = topLeftModelIndexTwoCol(); if (t >= 0) _readingAnchor = t; }
                return ok;
            },

            /** One page forward or back, crossing into the neighbouring range at the edge. */
            stepLocal: function (dir) {
                if (!isPaginatedLayout() || !editor) return false;
                PageChunks.ensure(DocumentModel.blocks.length);
                const from = this.localCurrent();
                const target = from + dir;
                if (target >= 0 && target < this.localCount()) {
                    // A turn that lands back where it started is not a turn.
                    //
                    // The page count and the seek derive from different numbers -- the
                    // content extent and the scrollable range -- and any disagreement
                    // between them used to trap the reader here forever: the target looked
                    // in range, the seek clamped back, success was reported, and the branch
                    // that crosses into the next range below was never reached. The clamp
                    // that caused it is fixed, but this is the safety net: whatever the
                    // geometry decides, paging forward cannot stand still.
                    if (this.gotoLocal(target) && this.localCurrent() !== from) return true;
                }
                const c = PageChunks.mounted + dir;
                if (c < 0 || c >= PageChunks.counts.length) return false;
                mountPageChunk(c);
                return this.gotoLocal(dir < 0 ? this.localCount() - 1 : 0);
            },

            /** Scroll to a page within the mounted range. */
            gotoLocal: function (local) {
                if (!isPaginatedLayout() || !editor) return false;
                // Do not relayout on every turn — that reflows multicol mid-read.
                // Geometry is locked on enter/remount/resize only.
                if (!(PageGeometry._stride > 0)) PageGeometry.relayout();
                const l = Math.max(0, Math.min(local | 0, PageGeometry.localCount() - 1));
                PageGeometry.go(l);
                currentTwoColPage = pageWindowingActive()
                    ? PageChunks.prefixPages(PageChunks.mounted) + l
                    : l;
                updatePageIndicator();
                return true;
            },

            /** Page offsets within the mounted range. Used by the tests to check alignment. */
            get pages() {
                const w = this.width(), c = this.localCount(), out = [];
                const max = PageGeometry.maxScroll();
                for (let i = 0; i < c; i++) out.push({ offset: Math.min(i * w, max) });
                return out;
            },

            ensure: function () { return this.count() > 0; },
            invalidate: function () { }
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
        window.getProgScrollUntil = function() { return _progScrollUntil; };

        /** Scrolls we cause ourselves must not count as the reader moving. */
        window.markProgrammaticScroll = function(ms) { _progScrollUntil = Date.now() + (ms || 600); };
        function markProgrammaticScroll(ms) { window.markProgrammaticScroll(ms); }
        function noteUserMovement() { if (Date.now() > _progScrollUntil) _colMemoryDirty = true; }


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


        /**
         * Keep the anchor line's page correct while the column layout settles.
         *
         * Never exits early on "the value did not change": right after the switch the page
         * is wrong AND unchanging, because the layout it was measured against has not
         * finished. That looked stable and stopped several pages short of the target.
         */
        /**
         * You were on a page. Work out which page holds the same content in the layout you
         * just switched to, and go there.
         *
         * The wait exists only because the layout being measured does not exist yet:
         * switching turns virtualisation off and remounts the document. It goes once, when
         * the columns are there, and stops.
         *
         * Only the latest call wins. Search jumps, resume-at, and column switches used to
         * stack concurrent chains; book font normalisation keeps changing scrollWidth, so
         * each chain's "geometry moved → re-anchor" fought the others (page 13 ↔ 141 forever).
         */
        let _gotoBlockGen = 0;
        let _gotoRecheckTimer = null;

        function goToPageHoldingBlock(anchorBlock, tries, lastWidth, gen) {
            const isTopLevel = (tries == null && gen == null);
            if (isTopLevel) {
                _gotoBlockGen++;
                _readingAnchor = anchorBlock;
                if (_gotoRecheckTimer) {
                    try { clearTimeout(_gotoRecheckTimer); } catch (eT) {}
                    _gotoRecheckTimer = null;
                }
            }
            if (gen == null) gen = _gotoBlockGen;
            tries = (tries == null) ? 40 : tries;
            if (tries <= 0) return;
            requestAnimationFrame(function () {
                if (gen !== _gotoBlockGen) return; // superseded by a newer jump
                if (!isPaginatedLayout() || !editor) return;

                // The block has to be laid out before its page can be measured. Under
                // windowing only one range is, and asking for a page in a range that is not
                // mounted can only return that range's first page -- so a column switch
                // anchored on block 140 landed in the range holding block 800, wherever the
                // window happened to be. Mount the anchor's range first; if that changes the
                // layout the width check below will simply wait another frame.
                try {
                    if (pageWindowingActive()) {
                        PageChunks.ensure(DocumentModel.blocks.length);
                        const want = PageChunks.chunkOfBlock(anchorBlock);
                        if (want !== PageChunks.mounted) {
                            mountPageChunk(want);
                            goToPageHoldingBlock(anchorBlock, tries - 1, null, gen);
                            return;
                        }
                    }
                } catch (eW) {}

                // Wait for the relayout to finish before asking anything about it. The flow
                // keeps growing while the remounted blocks lay out, and asking too early
                // answers against the layout being replaced: switching 2-col to 1-col
                // returned the 2-column page number, so the view never moved.
                //
                // scrollWidth alone is not the relayout. A page is clientWidth + gap wide,
                // and a column switch asks the host to resize the window, so clientWidth
                // changes after the switch and on its own schedule. scrollWidth could hold
                // still across a frame while the viewport was still moving -- the block was
                // then measured onto a page the layout was about to renumber, which is the
                // off-by-one that had a 2-col -> 1-col -> 2-col round trip come back a page
                // early. Wait on everything the page geometry is derived from.
                const w = editor.scrollWidth + 'x' + editor.clientWidth + 'x' + editor.clientHeight;
                if (w !== lastWidth) {
                    goToPageHoldingBlock(anchorBlock, tries - 1, w, gen);
                    return;
                }

                // Go by the page the block is measurably on, in the range that is mounted.
                //
                // Routing this through a global page number was wrong in a way that only
                // showed up under windowing: pageOfBlock measures a LOCAL page and adds the
                // prefix, goto() then resolves that number against the counts as they stand
                // -- and the mounted range had just been re-measured for the new column
                // count, so its page count shrank and the same number resolved into a
                // different range. A switch anchored on block 140 landed on block 800.
                // Locally there is nothing to disagree with.
                if (pageWindowingActive()) {
                    const el = elementForModelIndex(anchorBlock);
                    const lp = twoColPageOfElement(el);
                    PageMap.gotoLocal(lp == null ? 0 : lp);
                } else {
                    const want = PageMap.pageOfBlock(anchorBlock);
                    PageMap.goto(want);
                }
                // This block is what the reader asked to see, so it is the reading
                // position. Recording it here means a later width change re-derives from
                // it rather than from whatever happens to be on screen afterwards.
                _readingAnchor = anchorBlock;
                window.showDebugTelemetry('goToPage: block ' + anchorBlock + ' is on page ' +
                    PageMap.current() + ' of ' + PageMap.count());

                // Ranges are over live DOM; remount/page turn/column switch invalidates them.
                // mountPageChunk already repaints, but goToPage without a remount does not.
                try { repaintFindHighlights(); } catch (eF0) {}

                // One late correction only. Book text normalise rewrites font-size and
                // changes scrollWidth for hundreds of ms; re-entering the full 40-frame wait
                // on every wobble fought concurrent resume/search jumps forever.
                const settledKey = editor.scrollWidth + 'x' + editor.clientWidth +
                    'x' + editor.clientHeight;
                if (_gotoRecheckTimer) {
                    try { clearTimeout(_gotoRecheckTimer); } catch (eT2) {}
                }
                _gotoRecheckTimer = setTimeout(function () {
                    _gotoRecheckTimer = null;
                    try {
                        if (gen !== _gotoBlockGen) return;
                        if (!isPaginatedLayout() || !editor) return;
                        const nowKey = editor.scrollWidth + 'x' + editor.clientWidth +
                            'x' + editor.clientHeight;
                        // Same generation, same target: only re-measure local page, do not
                        // start a brand-new multi-frame chain (that was the thrash fuel).
                        if (pageWindowingActive()) {
                            const el2 = elementForModelIndex(anchorBlock);
                            if (el2) {
                                const lp2 = twoColPageOfElement(el2);
                                if (lp2 != null) PageMap.gotoLocal(lp2);
                            }
                        } else if (nowKey !== settledKey) {
                            const want2 = PageMap.pageOfBlock(anchorBlock);
                            PageMap.goto(want2);
                        }
                        try { repaintFindHighlights(); } catch (eF1) {}
                    } catch (eR) {}
                }, 280);
            });
        }

        function settleTwoColToLine(line, anchorBlockHint) {
            const anchorBlock = (anchorBlockHint != null)
                ? anchorBlockHint
                : modelLocationFromDocumentLine(Math.max(1, line | 0)).blockIndex;
            goToPageHoldingBlock(anchorBlock);
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

        /**
         * Model block holding an offset in the visual (non-virtualized) haystack.
         * That haystack is built from the mounted blocks in order, separated by newlines,
         * so the block is found by walking the same map the index was built from.
         */
        function blockIndexFromMap(map, off) {
            if (!map || !map.length) return 0;
            const entry = map[Math.max(0, Math.min(map.length - 1, off | 0))];
            if (!entry || !entry.node) return 0;
            let el = entry.node.parentElement;
            while (el && !(el.classList && el.classList.contains('block'))) el = el.parentElement;
            const mi = el ? DocumentModel.modelIndexOfEl(el) : -1;
            return mi >= 0 ? mi : 0;
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
                // findState.index counts matches in the whole document; ranges holds only
                // what is mounted. findState.currentRange is the position of the active
                // match within THIS list, and is the only one of the two that can index it.
                const cur = (findState.currentRange != null && findState.currentRange >= 0)
                    ? findState.currentRange
                    : findState.index;
                if (cur >= 0 && cur < findState.ranges.length) {
                    CSS.highlights.set('typozen-find-current', new Highlight(findState.ranges[cur]));
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
            // Search the model whenever there is one, not the mounted DOM.
            //
            // This used to switch on virtEnabled, which meant the surface changed with the
            // layout: page mode turns virtualization off, so the same document searched the
            // markdown while scrolling and the viewport text while paginated. The two give
            // different results. In the DOM a wrapped paragraph is one long run, so eight
            // matches inside it all reported the same line and their snippets came out as
            // mid-word fragments, while the same search in Scroll mode listed them cleanly
            // one markdown line at a time.
            //
            // The model is also the only surface that covers the whole document rather than
            // whatever happens to be mounted.
            if (typeof DocumentModel !== 'undefined' && DocumentModel.blocks && DocumentModel.blocks.length) {
                // A book is searched by its text. Its raw is HTML, so searching that would
                // match class names and hrefs -- and would do it invisibly, since a hit
                // inside an attribute has no on-screen position to scroll to.
                if (DocumentModel.kind === 'epub') {
                    return { haystack: DocumentModel.toPlainText(), map: null, kind: 'model' };
                }
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
            // For a book the search offsets come from toPlainText(), so the walk has to be
            // over the same strings. Walking the HTML instead made every offset land in a
            // block far from the match -- searching found the right words and then showed
            // somewhere else entirely.
            const book = DocumentModel.kind === 'epub';
            for (let i = 0; i < n; i++) {
                const raw = book ? DocumentModel.blockText(i)
                                 : String(blocks[i].raw == null ? '' : blocks[i].raw);
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
        /**
         * Highlight EVERY match on screen, and mark the current one.
         *
         * This used to build a range for the current match alone. Once the search surface
         * became the model for every document, that made it the only path there is -- so a
         * page showing eight hits highlighted one, and every other editor's behaviour
         * (highlight them all, distinguish the active one) was quietly lost.
         *
         * The active one disappeared with it: applyWysiwygHighlights marks
         * ranges[findState.index], and findState.index is the index among ALL matches in
         * the document. Against a one-element array, match 7 of 2135 asked for ranges[7]
         * and got undefined, so nothing was marked current either.
         *
         * Model offsets are offsets into the raw markdown; the DOM has the markers removed,
         * so they do not correspond. Matches are counted per block and paired with that
         * block's own matches in order, which is what the single-match version did and is
         * the only mapping that survives rendering.
         */
        function highlightModelMatchInMountedDom(match, navigate) {
            if (!editor || typeof DocumentModel === 'undefined') return false;
            const q = findState.query;
            const opts = getFindOptions();

            // Model start offset of every block, in one walk. Doing this per match via
            // markdownOffsetToBlock is O(blocks) each -- 8M iterations for this document.
            //
            // MUST use the same surface as getFindHaystack / findState.matches:
            // books search toPlainText() (blockText), not HTML raw. Mapping plain-text
            // match offsets onto raw HTML lengths put every hit in the wrong block, so
            // byBlock skipped the visible paragraph and ranges stayed empty — sidebar
            // said 4/6 while the page never painted orange.
            const blocks = DocumentModel.blocks || [];
            const book = DocumentModel.kind === 'epub';
            const rawOf = function (i) {
                return book ? DocumentModel.blockText(i)
                            : String(blocks[i].raw == null ? '' : blocks[i].raw);
            };
            const starts = new Array(blocks.length);
            let pos = 0;
            for (let i = 0; i < blocks.length; i++) {
                starts[i] = pos;
                pos += rawOf(i).length + 1;
            }

            // Group matches by block. Matches ascend, so the block pointer only moves on.
            const byBlock = new Map();
            let bi = 0;
            for (let i = 0; i < findState.matches.length; i++) {
                const s = findState.matches[i].start;
                while (bi < blocks.length - 1 && s >= starts[bi + 1]) bi++;
                let list = byBlock.get(bi);
                if (!list) { list = []; byBlock.set(bi, list); }
                list.push(i);
            }

            // Locate the current match by the block that holds it and its ordinal within
            // that block, rather than by scanning each block's global indices for equality.
            // The scan silently found nothing whenever a block's rendered matches and its
            // raw-markdown matches did not line up one for one, and a miss is indertinguishable
            // from "not on this block" -- so the mark fell on whichever match happened to be
            // built first. It sat on line 3 while the sidebar was on line 12.
            let curBlock = -1;
            let curOrdinal = 0;
            const curMatch = (match && match.start != null)
                ? match
                : ((findState.index >= 0) ? findState.matches[findState.index] : null);
            if (curMatch) {
                let b = 0;
                while (b < blocks.length - 1 && curMatch.start >= starts[b + 1]) b++;
                curBlock = b;
                const inBlock = byBlock.get(b);
                if (inBlock) {
                    const at = inBlock.indexOf(findState.index);
                    curOrdinal = at >= 0 ? at : 0;
                }
            }

            const ranges = [];
            let currentRange = -1;
            const mounted = editor.querySelectorAll('.block[data-model-index]');
            const paintBlock = function (el, idx, requireKnown) {
                if (requireKnown) {
                    const globals = byBlock.get(idx);
                    if (!globals || !globals.length) return;
                }
                const local = buildSearchIndexInRoot(el);
                const localMatches = findAllIndices(local.haystack, q, opts);
                if (!localMatches.length) return;
                const built = rangesFromWysiwygMatches(localMatches, local.map);
                if (idx === curBlock && built.length && currentRange < 0) {
                    currentRange = ranges.length + Math.min(curOrdinal, built.length - 1);
                }
                for (let k = 0; k < built.length; k++) ranges.push(built[k]);
            };
            for (let n = 0; n < mounted.length; n++) {
                const el = mounted[n];
                const idx = parseInt(el.getAttribute('data-model-index'), 10);
                if (!isFinite(idx)) continue;
                paintBlock(el, idx, true);
            }
            // Fallback: if model→block mapping still missed (HTML vs text whitespace drift),
            // scan every mounted block for the query so something still lights up on screen.
            if (!ranges.length && q) {
                currentRange = -1;
                for (let n = 0; n < mounted.length; n++) {
                    const el = mounted[n];
                    const idx = parseInt(el.getAttribute('data-model-index'), 10);
                    if (!isFinite(idx)) continue;
                    paintBlock(el, idx, false);
                }
            }

            if (!ranges.length) {
                findState.ranges = [];
                findState.currentRange = -1;
                clearFindHighlights();
                return false;
            }
            findState.ranges = ranges;
            findState.currentRange = currentRange;
            applyWysiwygHighlights();
            // Scroll to and select the CURRENT match, not the first one on screen. With
            // only one range built these were the same thing; they are not any more.
            const active = ranges[currentRange >= 0 ? currentRange : 0];
            if (active) {
                // Paginated layout: mainContainer does not scroll; page turn already moved
                // the view. Only nudge the scroll surface in continuous mode.
                //
                // NOTE: when the current match has no range of its own -- an image line
                // has no text node -- currentRange is -1 and the `: 0` above seeks to a
                // DIFFERENT match, the first one built, at the top of the document.
                // Removing that fallback was tried and regressed search-highlight-app,
                // so it stays; currentRange is -1 in more cases than that one.
                if (!isPaginatedLayout()) scrollRangeIntoMain(active);
                // Select the match only for the Ctrl+F bar, where Replace acts on the
                // selection and the caret is expected to land in the text.
                //
                // The sidebar is a reading tool, not a caret move, and selecting there hid
                // the thing it had just been asked to show: the browser paints the native
                // selection above custom highlights, so the current-match colour appeared
                // for one frame and was then covered by the OS selection blue. That flash
                // was the whole of the reported "dark orange for a split second, then white
                // on blue".
                if (navigate && isFindBarOpen()) {
                    try {
                        const sel = window.getSelection();
                        sel.removeAllRanges();
                        sel.addRange(active.cloneRange());
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
        /**
         * Exactly one block carries .focused at a time.
         *
         * The search reveals added it to the block they landed on and never removed it from
         * the one before, so every jump left another permanently shaded row behind: line 3
         * stayed lit from the first jump while the caret was on line 12. updateActiveBlock
         * only clears the class from currentActiveBlock when the caret moves, which cannot
         * help once a second block has been given it directly.
         */
        function setFocusedBlock(el) {
            try {
                const lit = editor.querySelectorAll('.block.focused');
                for (let i = 0; i < lit.length; i++) {
                    if (lit[i] !== el) lit[i].classList.remove('focused');
                }
            } catch (e) {}
            if (el && el.classList) {
                try { el.classList.add('focused'); } catch (e2) {}
                currentActiveBlock = el;
            }
        }

        function applyPageModeHeight() {
            if (!editor) return;
            if (!isPaginatedLayout()) {
                try { PageGeometry.clear(); } catch (e0) {}
                return;
            }
            try { PageGeometry.relayout(); } catch (e1) {}
        }

        try { bindPageScrubber(); } catch (eB) {}

        window.addEventListener('resize', function () {
            try {
                if (!isPaginatedLayout()) return;
                const page = PageGeometry.localIndex();
                PageGeometry.relayout();
                PageGeometry.go(page);
                updatePageIndicator();
            } catch (e) {}
        });

        function revealModelMatch(match, navigate, noFocus) {
            if (!match || typeof DocumentModel === 'undefined') return;
            const loc = markdownOffsetToBlock(match.start);
            const blockIdx = loc.blockIndex;
            // Same coordinate as the Search sidebar gutter and status "Ln N".
            // Paginated jumps used to skip stats entirely, so the status bar kept the
            // previous sticky line (e.g. 13612) while the list showed the match (13488+).
            let matchLine = 1;
            try {
                matchLine = documentLineForModelOffset(match.start);
            } catch (eL) {
                try { matchLine = modelBlockStartLine(blockIdx); } catch (eL2) { matchLine = 1; }
            }
            try {
                if (typeof rememberStickyLine === 'function') rememberStickyLine(matchLine);
            } catch (eSt) {}

            // An image-only line: stay put.
            //
            // The match is inside the asset path -- searching "scroll" matches
            // `![](large-scroll-mixed-assets/...)` -- and the line renders as an <img>, so
            // there is no text on the page to travel to. Everything downstream assumes
            // there is: the highlighter finds no range for it and its `: 0` fallback then
            // seeks to a different match, the first one built, which is at the top of the
            // document. Clicking the row threw the reader back to page one.
            //
            // Doing nothing is the right answer, not a placeholder for a better one. The
            // sidebar row already says which image and what line it is on, the reader has
            // not asked to leave where they are, and no scroll is better than a wrong one.
            try {
                const blk = DocumentModel.blocks && DocumentModel.blocks[blockIdx];
                if (blk && imageOnlyLine(blk.raw)) return;
            } catch (eImg) {}

            // Paginated views do not scroll mainContainer at all -- it is overflow-hidden
            // and the editor scrolls sideways -- so setting scrollTop here did nothing and
            // clicking a search result left the view wherever it was. Same defect the
            // outline had, same fix: use the navigation the current layout actually uses.
            if (isPaginatedLayout()) {
                goToPageHoldingBlock(blockIdx);
                const el = elementForModelIndex(blockIdx);
                if (el) currentActiveBlock = el;
                // Highlight after the page turn has a chance to mount the right chunk.
                // One delayed paint is enough; a spray of timeouts stacked with resume-at
                // and external_find retries was part of the page thrash.
                const paintPage = function () {
                    try { highlightModelMatchInMountedDom(match, navigate); } catch (e) {}
                };
                paintPage();
                requestAnimationFrame(function () { setTimeout(paintPage, 120); });
                try { updateStatsNow({ forceCaretLine: matchLine }); } catch (eStP) {}
                return;
            }

            // Scrolling view: hand it to the sticky-line restore rather than seeding
            // scrollTop and remounting. The remount rebuilds the virtual spacers, the
            // document height collapses for a frame and the browser clamps the scroll back
            // to 0 -- so clicking a result moved the caret and left the view where it was.
            // Exactly the defect the outline had; this is the same path.
            try {
                restoreStickyDocumentLine(matchLine, noFocus);
                const el0 = elementForModelIndex(blockIdx);
                if (el0) {
                    setFocusedBlock(el0);
                }
                // Must paint after restore — early return used to leave the sidebar
                // correct and the document with no CSS Highlight at all.
                const paintScroll = function () {
                    try { highlightModelMatchInMountedDom(match, navigate); } catch (eP) {}
                };
                paintScroll();
                requestAnimationFrame(function () { setTimeout(paintScroll, 80); });
                try { updateStatsNow({ forceCaretLine: matchLine }); } catch (eSt0) {}
                return;
            } catch (eScr) {}
            // Suppress refreshFindAfterVirtMount re-entry while we intentionally remount
            findState._revealing = true;
            try { mountVirtWindow(true); } catch (eM) {}
            findState._revealing = false;

            const blockEl = editor
                ? editor.querySelector('.block[data-model-index="' + blockIdx + '"]')
                : null;
            if (blockEl) setFocusedBlock(blockEl);
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
        /**
         * Repaint the find highlights against whatever is mounted right now.
         *
         * One entry point for every layout. The highlights are ranges over live DOM nodes,
         * so anything that replaces those nodes -- a virt remount, a page turn, a column
         * switch, entering or leaving pagination -- invalidates all of them. There is no
         * layout in which that is not true, so there is no layout this may skip.
         *
         * Every previous version of this guarded itself into irrelevance: first on the
         * Ctrl+F bar being open (the sidebar is a different surface driving the same
         * findState), then on virtualisation being enabled (pagination turns it off). Each
         * guard silently disabled highlighting for exactly the case being reported.
         */
        function repaintFindHighlights() {
            if (findState._revealing) return;
            if (!findState.query) return;
            if (state.mode === 'source') return;
            if (findState.kind !== 'model') return;
            if (findState.index < 0 || findState.index >= findState.matches.length) return;
            try {
                highlightModelMatchInMountedDom(findState.matches[findState.index], false);
            } catch (e) {}
        }

        window.commitSearchFocus = function() {
            try {
                if (state.mode === 'source') {
                    if (typeof sourceEditor !== 'undefined' && sourceEditor && sourceEditor.style.display !== 'none') {
                        sourceEditor.focus();
                    }
                } else {
                    // Use _stickyLineCache to find the block to focus.
                    // It was updated by revealModelMatch during search navigation.
                    let handled = false;
                    if (typeof _stickyLineCache !== 'undefined' && _stickyLineCache >= 1
                        && typeof modelLocationFromDocumentLine === 'function'
                        && typeof editor !== 'undefined' && editor) {
                        try {
                            const loc = modelLocationFromDocumentLine(_stickyLineCache);
                            const el = editor.querySelector('.block[data-model-index="' + loc.blockIndex + '"]');
                            if (el && typeof focusBlock === 'function') {
                                focusBlock(el, 0);
                                handled = true;
                            }
                        } catch (eSticky) {}
                    }
                    if (!handled) {
                        if (typeof focusEditorNoScroll === 'function') {
                            focusEditorNoScroll();
                        }
                    }
                }
            } catch (e) {}
        };

        window.syncSearchIndexToLocation = function() {
            try {
                if (!findState.matches || findState.matches.length === 0) return;

                // Get the user's current line (already a 1-based document line number)
                let targetLine = (_stickyLineCache | 0) || 1;
                try {
                    if (state.mode === 'wysiwyg' && typeof getCaretLineNumber === 'function') {
                        const caretLine = getCaretLineNumber();
                        if (caretLine >= 1 && Math.abs(targetLine - caretLine) <= 100) {
                            targetLine = caretLine;
                        }
                    }
                } catch (e) {}

                // For source mode, compute line from cursor position
                if (state.mode === 'source' && typeof sourceEditor !== 'undefined' && sourceEditor) {
                    const pos = sourceEditor.selectionStart || 0;
                    targetLine = sourceEditor.value.substring(0, pos).split(/\r?\n/).length;
                }

                // Find the first match whose document line is >= targetLine
                let bestIdx = 0; // default to first match
                if (findState.kind === 'source') {
                    // Source mode: compare char offsets directly
                    const targetPos = (state.mode === 'source' && sourceEditor) 
                        ? (sourceEditor.selectionStart || 0) : 0;
                    for (let i = 0; i < findState.matches.length; i++) {
                        if (findState.matches[i].start >= targetPos) {
                            bestIdx = i;
                            break;
                        }
                        bestIdx = i; // fallback to last
                    }
                } else {
                    // Model/visual mode: compare document line numbers
                    for (let i = 0; i < findState.matches.length; i++) {
                        let matchLine = 1;
                        if (findState.kind === 'model' && typeof documentLineForModelOffset === 'function') {
                            matchLine = documentLineForModelOffset(findState.matches[i].start);
                        } else if (findState.kind === 'visual') {
                            // For visual, use block start line as approximation
                            try {
                                const blk = findState.ranges && findState.ranges[i]
                                    ? getAncestorBlock(findState.ranges[i].startContainer) : null;
                                if (blk && typeof DocumentModel !== 'undefined' && typeof modelBlockStartLine === 'function') {
                                    const mi = DocumentModel.modelIndexOfEl(blk);
                                    if (mi >= 0) matchLine = modelBlockStartLine(mi);
                                }
                            } catch (e) {}
                        }
                        if (matchLine >= targetLine) {
                            bestIdx = i;
                            break;
                        }
                        bestIdx = i;
                    }
                }

                findState.index = bestIdx;
                updateFindCount();
                updateSearchSidebar();
            } catch (e) {}
        };

        function runFind(query, keepIndex, options) {
            const navigate = !!(options && options.navigate);
            const q = (query == null ? '' : String(query));
            findState.query = q;
            clearFindHighlights();
            findState.matches = [];
            findState.ranges = [];
            findState.currentRange = -1;
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
            // Force sidebar list rebuild (empty-state sig must not stick when hits arrive).
            _searchRenderedSig = '';
            _searchRenderedList = null;

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
                // Visual path: ranges covers every match, so findState.index indexes it directly.
                findState.currentRange = -1;
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
                scrollSourceMatchIntoView(m.start, m.end, isFindBarOpen());
            } else if (findState.kind === 'model') {
                revealModelMatch(findState.matches[findState.index], true, !isFindBarOpen());
            } else {
                // Rebuild ranges from current visual text (same list as matches)
                const surface = getFindHaystack();
                findState.ranges = rangesFromWysiwygMatches(findState.matches, surface.map);
                // Visual path: ranges covers every match, so findState.index indexes it directly.
                findState.currentRange = -1;
                applyWysiwygHighlights();
                const r = findState.ranges[findState.index];
                if (r) {
                    revealVisualRange(r);
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
                // Ctrl+G → go-to-page (paginated). F3 remains find next.
                if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
                    && (e.key === 'g' || e.key === 'G')) {
                    e.preventDefault();
                    e.stopPropagation();
                    openGoToPageDialog();
                    return;
                }
                if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
                    if (e.key === 'M' || e.key === 'm') {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!annotateSelection()) toggleMarkAtBlock(markTargetBlock());
                        return;
                    }
                    if (e.key === 'P' || e.key === 'p') {
                        e.preventDefault();
                        e.stopPropagation();
                        try { handleCommand('show_marks'); } catch (eSm) {}
                        return;
                    }
                    if (e.key === 'J' || e.key === 'j') {
                        e.preventDefault();
                        e.stopPropagation();
                        returnFromJump();
                        return;
                    }
                }
                // Function keys when WebView has focus (host may not see them)
                if (!e.ctrlKey && !e.metaKey && !e.altKey) {
                    if (e.key === 'F7') { e.preventDefault(); handleCommand('toggle_reveal'); return; }
                    if (e.key === 'F8') { e.preventDefault(); handleCommand('toggle_focus'); return; }
                    if (e.key === 'F9') { e.preventDefault(); handleCommand('toggle_typewriter'); return; }
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
                // Global recent Search queries (max 8). Host allowlists this into settings.json.
                searchHistory: _searchHistory.slice(0, SEARCH_HISTORY_MAX),
                lastSearchQuery: _lastSearchQuery || '',
                findMatchCase: !!(document.getElementById('findMatchCase')
                    && document.getElementById('findMatchCase').checked),
                findWholeWord: !!(document.getElementById('findWholeWord')
                    && document.getElementById('findWholeWord').checked),
                sidebarTab: (function () {
                    try {
                        const t = document.querySelector('.sidebar-tab.active');
                        const id = t && t.getAttribute('data-tab');
                        return (id === 'search' || id === 'marks') ? id : 'outline';
                    } catch (e) { return 'outline'; }
                })(),
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
                if (Array.isArray(savedPrefs.searchHistory)) {
                    setSearchHistory(savedPrefs.searchHistory);
                }
                if (typeof savedPrefs.lastSearchQuery === 'string') {
                    _lastSearchQuery = savedPrefs.lastSearchQuery;
                    try {
                        const si = document.getElementById('sidebarSearchInput');
                        if (si && !si.value) si.value = _lastSearchQuery;
                    } catch (eSq) {}
                }
                try {
                    const mc = document.getElementById('findMatchCase');
                    const ww = document.getElementById('findWholeWord');
                    if (mc) mc.checked = !!savedPrefs.findMatchCase;
                    if (ww) ww.checked = !!savedPrefs.findWholeWord;
                    syncSearchOptionButtons();
                } catch (eFo) {}
                if (savedPrefs.sidebarTab === 'search' || savedPrefs.sidebarTab === 'outline') {
                    try { if (typeof switchTab === 'function') switchTab(savedPrefs.sidebarTab, true); } catch (eSt) {}
                }

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
                postSidebarState();   // shade the toolbar button to match the restored state
                updateStatsNow();
                updateOutline();
            } finally {
                isRestoring = false;
            }
        }

