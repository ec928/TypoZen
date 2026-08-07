// TypoZen module: 06-render-epub.js
// Lines 11013-12338 of the former monolith. Classic script; shares page globals.
// Load order is fixed -- see js/modules/load-order.json and TypoZen_Template.html.

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

        /**
         * Open a book.
         *
         * The host has done the parts that need a filesystem -- unzip, container.xml, the
         * OPF spine in reading order, the table of contents, and a URL the extracted assets
         * can be fetched from. Everything that needs an HTML parser happens here, because
         * the browser is the HTML authority and a second parser in C# would disagree with
         * this one at the edges.
         *
         * Payload:
         *   { title, author, assetsBase, css: [text...],
         *     docs: [{ href, html }...], toc: [{ title, level, href }...] }
         */
        /**
         * @param {string} payload  the staged JSON
         * @param {number} [resumeAt]  block to open at, if the reader has been here before
         */
        function loadBookPayload(payload, resumeAt) {
            let data = payload;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (e) { data = null; }
            }
            if (!data || !data.docs || !data.docs.length) {
                window.showDebugTelemetry('loadBookPayload: empty payload');
                return false;
            }

            const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;

            const split = bookBlocksFromDocs(data.docs);
            const toc = bookRepairTocByTitle(bookTocToBlockIndices(data.toc, split.docStart), split.blocks);
            _bookDocStarts = {};
            for (let i = 0; i < split.docStarts.length; i++) _bookDocStarts[split.docStarts[i]] = 1;
            _bookPlateBlocks = bookFindPlateBlocks(split.blocks, split.docStarts);
            _bookAssetsBase = String(data.assetsBase || '');
            _bookDocIndex = split.docStart;
            _bookBlockDirs = split.dirs || [];
            _bookAnchorIndex = null;   // belongs to the book that is open, not to the session
            _bookTitleIndex = null;
            _bookPosLast = -1;
            _bookTextScaleK = 0;
            if (_bookPosTimer) { clearTimeout(_bookPosTimer); _bookPosTimer = null; }

            // Styles before blocks: the first paint should already be the book's own
            // typography rather than a flash of unstyled text a reader would notice.
            // Kept because the size correction re-applies them with a divisor, and it has to
            // divide the publisher's own numbers rather than numbers it divided before.
            _bookCssTexts = data.css || [];
            _bookEmDivisor = 1;
            try { applyBookStyles(_bookCssTexts, data.assetsBase || ''); } catch (eS) {}

            DocumentModel.fromBookBlocks(split.blocks, toc);
            _contentCache = null;
            // Immediately, not thirty lines further down.
            //
            // Between the model becoming the book and lastSavedContent being told about it,
            // the document is "different from what was last saved" -- which is what dirty
            // means. Anything in that window that posts stats reports a dirty document, and
            // the host applies that flag to whichever tab it currently thinks is active. A
            // Markdown tab that had never been touched came back marked unsaved, and closing
            // offered to save the book's text over it.
            state.lastSavedContent = DocumentModel.toPlainText();

            // A book is read-only and paginated: that is what it is, not a preference.
            // Going through the same commands a reader would use keeps one code path.
            state.mode = 'reader';
            setEditorEditable(false);

            // Reader is pages only. Setting the mode without the pagination it implies left
            // a book in reader + scroll -- a combination resolveViewState cannot produce --
            // and since Reader locks the scroll selector there was no way to click out of
            // it. Opening a book while the previous document was scrolling put the reader
            // there every time; the only escape was a round trip through Preview.
            //
            // The class is set here rather than through syncPaginationClass() because that
            // remounts the document to turn virtualisation off, and this loader mounts the
            // book itself a few statements below. Going through it would lay the book out
            // twice, the first time as Markdown.
            if (!state.pageAdvance) {
                state.pageAdvance = true;
                try { postMsg('sync_page_advance:1'); } catch (eP) {}
            }
            editor.classList.add('page-mode');
            PageMap.invalidate();
            state.viewMode = 'reader';
            state.viewScroll = 'pagination';

            try { applyEditorChromeForMode(); } catch (eC) {}
            // Tell the shell, or the toolbar keeps showing Preview while the document is
            // in Reader -- the selectors are driven by what the page reports, not by what
            // it happens to be doing.
            try { postMsg('mode_changed:reader'); } catch (eM) {}
            try { postViewState(currentViewState()); } catch (eV) {}

            editor.innerHTML = '';
            DocumentModel.virtEnabled = DocumentModel.shouldVirtualize();
            if (DocumentModel.virtEnabled) {
                bindVirtScroll();
                mountVirtWindow(true, { anchorIndex: 0, anchorOffset: 0 });
            } else if (pageWindowingActive()) {
                // Paginated, and pagination refuses virtualisation because the browser can
                // only fragment what it has laid out. Without this the omnibus opened with
                // all 40,656 of its blocks in one multi-column flow -- precisely the case
                // page windowing exists to prevent, arrived at by a different door.
                PageChunks.invalidate();
                PageChunks.ensure(DocumentModel.blocks.length);
                // Straight to the range being resumed into, rather than mounting the front
                // of the book and correcting afterwards. The correction works, but it is a
                // second layout the reader watches happen: opening a book you are 3,000
                // blocks into showed its cover for a moment and then jumped.
                const wantBlock = (resumeAt > 0 && resumeAt < DocumentModel.blocks.length)
                    ? resumeAt : 0;
                mountPageChunk(PageChunks.chunkOfBlock(wantBlock));
                if (wantBlock > 0) {
                    try { goToModelBlock(wantBlock); } catch (eG) {}
                }
            } else {
                const frag = document.createDocumentFragment();
                for (let i = 0; i < DocumentModel.blocks.length; i++) {
                    const el = createPreviewBlockEl(DocumentModel.blocks[i].raw, false, i);
                    el.setAttribute('data-model-index', String(i));
                    if (_bookDocStarts[i]) el.setAttribute('data-chapter-start', '1');
                    frag.appendChild(el);
                }
                editor.appendChild(frag);
            }

            currentActiveBlock = editor.querySelector('.block');
            // Theme-sized body text: run now and again after layout/fonts settle.
            try { scheduleNormaliseBookTextSize(); } catch (eN) {}
            // Page numbers and the scrubber, now rather than at the first page turn: a book
            // that has just opened is exactly when a reader looks for where they are.
            try { updatePageIndicator(); } catch (eP) {}
            try { updateOutline(); } catch (eO) {}
            try { updateStatsNow(); } catch (eSt) {}
            try { HistoryManager.clear(); } catch (eH) {}

            const ms = (typeof performance !== 'undefined')
                ? Math.round(performance.now() - t0) : 0;
            window.showDebugTelemetry('book: ' + (data.title || '(untitled)') + ' — ' +
                data.docs.length + ' documents, ' + split.blocks.length + ' blocks, ' +
                toc.length + ' TOC entries, ' + ms + 'ms');

            postMsg('book_loaded:' + encodeURIComponent(JSON.stringify({
                title: data.title || '', author: data.author || '',
                blocks: split.blocks.length, toc: toc.length
            })));
            return true;
        }


        /**
         * Where a book's extracted assets live, and where each of its documents begins.
         *
         * Both are set when a book loads and are what turn a relative href into something
         * that resolves: an <img src="../images/plate.jpg"> means nothing until it is
         * anchored to the directory the book was unpacked into, and an
         * <a href="chapter7.xhtml"> means nothing until it is turned into a block index.
         */
        let _bookAssetsBase = '';
        let _bookDocIndex = {};
        let _bookBlockDirs = [];

        /** Resolve a book-relative path against the extracted assets, keeping ../ honest. */
        function bookResolveUrl(href, docDir) {
            const h = String(href == null ? '' : href).trim();
            if (!h || /^(data:|https?:|mailto:|blob:)/i.test(h)) return h;
            if (!_bookAssetsBase) return h;
            // The base is the book root plus the directory of the document this markup came
            // from. new URL then does the ../ walking, so a chapter in Text/ reaching into
            // Images/ resolves the way the publisher wrote it.
            const base = _bookAssetsBase + String(docDir || '');
            try {
                return new URL(h.replace(/^\.\//, ''), base).href;
            } catch (e) {
                return base + h.replace(/^(\.\/|\/)/, '');
            }
        }

        /** The directory of the spine document a mounted block came from. */
        function bookDirOfBlockEl(el) {
            if (!el || !_bookBlockDirs.length) return '';
            const n = parseInt(el.getAttribute('data-model-index'), 10);
            if (!isFinite(n) || n < 0) return '';
            return _bookBlockDirs[n] || '';
        }

        /**
         * Rewrite a book fragment's URLs so images load and links can be followed.
         *
         * Done at render rather than at load: the raw stays exactly as the publisher wrote
         * it, which keeps the model a faithful copy of the book and means a change of
         * asset location does not require re-parsing every block.
         *
         * Internal links keep their original target in data-book-href. Following them is a
         * jump within the document, not a navigation -- the whole book is already open, and
         * letting the browser follow the link would replace the application with a chapter.
         */
        function rewriteBookUrls(root) {
            if (!root) return;
            const dir = bookDirOfBlockEl(root);
            try {
                const imgs = root.querySelectorAll('img');
                for (let i = 0; i < imgs.length; i++) {
                    const el = imgs[i];
                    const raw = el.getAttribute('src');
                    if (!raw) continue;
                    const abs = bookResolveUrl(raw, dir);
                    if (abs !== raw) el.setAttribute('src', abs);
                    if (!el.getAttribute('loading')) el.setAttribute('loading', 'lazy');
                }

                // Covers are almost always an SVG wrapper around <image xlink:href>, not an
                // <img> at all -- both test books do it, and it is the first thing a reader
                // sees. Nothing above touches those, so the cover never loaded.
                // Calibre's title pages carry preserveAspectRatio="none" on that wrapper,
                // which tells the renderer to stretch the cover to whatever box it is given
                // -- so bounding its height squashes it instead of scaling it. Dropping the
                // attribute restores the xMidYMid meet default. Chromium will not take this
                // from CSS, so it has to be done in the markup.
                const svgs = root.querySelectorAll('svg[preserveAspectRatio]');
                for (let i = 0; i < svgs.length; i++) {
                    const pav = svgs[i].getAttribute('preserveAspectRatio') || '';
                    if (/\bnone\b/i.test(pav)) svgs[i].removeAttribute('preserveAspectRatio');
                }

                const svgImgs = root.querySelectorAll('image');
                const XLINK = 'http://www.w3.org/1999/xlink';
                for (let i = 0; i < svgImgs.length; i++) {
                    const el = svgImgs[i];
                    const raw = el.getAttributeNS(XLINK, 'href') || el.getAttribute('href')
                        || el.getAttribute('xlink:href');
                    if (!raw) continue;
                    const abs = bookResolveUrl(raw, dir);
                    if (abs === raw) continue;
                    try { el.setAttributeNS(XLINK, 'xlink:href', abs); } catch (eNs) {}
                    el.setAttribute('href', abs);
                }
                const links = root.querySelectorAll('a[href]');
                for (let i = 0; i < links.length; i++) {
                    const a = links[i];
                    const href = a.getAttribute('href');
                    if (!href || /^(https?:|mailto:)/i.test(href)) continue;
                    a.setAttribute('data-book-href', href);
                    a.removeAttribute('href');   // nothing navigates away from the book
                    a.style.cursor = 'pointer';
                }
            } catch (e) {}
        }

        /**
         * Jump to a place in the book named by an href, e.g. "chapter7.xhtml#s3".
         *
         * Resolves to the block the document begins at, then refines to the element bearing
         * the fragment id if that block is on screen -- an anchor part way into a long
         * chapter should land there, not at the chapter's first paragraph.
         */
        /**
         * Titles to blocks, for links whose hrefs are dangling in the book itself.
         *
         * Matter's contents page links to #filepos3742 and the book contains no filepos
         * anchor at all -- 70 anchors, every one of them calibre_pb_*. No reader can follow
         * that by href. The outline already recovers those chapters by title, so a link
         * whose href resolves to nothing lands wherever clicking the outline would.
         *
         * The outline's own targets come first: they have been repaired where the hrefs
         * collapsed, so the two routes agree by construction.
         */
        let _bookTitleIndex = null;

        function bookTitleKey(s) {
            return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
        }

        function buildBookTitleIndex() {
            const map = {};
            if (typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'epub') return map;
            const toc = DocumentModel.toc || [];
            for (let i = 0; i < toc.length; i++) {
                const key = bookTitleKey(toc[i].title);
                if (key && toc[i].blockIndex >= 0 &&
                    !Object.prototype.hasOwnProperty.call(map, key)) map[key] = toc[i].blockIndex;
            }
            const raws = [];
            for (let i = 0; i < DocumentModel.blocks.length; i++) raws.push(DocumentModel.blocks[i].raw);
            const headings = bookHeadingIndex(raws);
            const keys = Object.keys(headings);
            for (let i = 0; i < keys.length; i++) {
                if (!Object.prototype.hasOwnProperty.call(map, keys[i])) map[keys[i]] = headings[keys[i]];
            }
            return map;
        }

        function bookGoToHref(href, linkText) {
            const raw = String(href == null ? '' : href);
            const file = bookNormalizeHref(raw);
            const hash = raw.indexOf('#') >= 0 ? raw.slice(raw.indexOf('#') + 1) : '';

            let idx = -1;
            let hashHit = false;
            if (file && Object.prototype.hasOwnProperty.call(_bookDocIndex, file)) {
                idx = _bookDocIndex[file];
            } else if (file) {
                const bare = file.slice(file.lastIndexOf('/') + 1);
                const keys = Object.keys(_bookDocIndex);
                for (let i = 0; i < keys.length; i++) {
                    if (keys[i] === bare || keys[i].endsWith('/' + bare)) {
                        idx = _bookDocIndex[keys[i]];
                        break;
                    }
                }
            }
            // A bare "#id" means somewhere in the document already open.
            if (hash) {
                const byId = findBookBlockWithId(hash);
                if (byId >= 0) { idx = byId; hashHit = true; }
            }

            // Title fallback when the fragment is missing (or the whole href failed).
            // Matter-style links are often `chapter.xhtml#filepos3742` where the file
            // resolves but the fragment does not exist — landing on the file start is
            // wrong when the link text names a chapter the outline already knows.
            // Sound books hit hashHit and never enter this branch.
            if (!hashHit) {
                const key = bookTitleKey(linkText);
                if (key) {
                    if (!_bookTitleIndex) _bookTitleIndex = buildBookTitleIndex();
                    if (Object.prototype.hasOwnProperty.call(_bookTitleIndex, key)) {
                        idx = _bookTitleIndex[key];
                    }
                }
            }
            if (idx < 0) return false;

            goToModelBlock(idx);
            return true;
        }

        /**
         * Every anchor in the book, mapped to the block that carries it.
         *
         * Built once and kept, because a link click would otherwise scan 40,000 blocks of
         * markup. Matches `name` as well as `id`: books converted from older formats
         * anchor with <a name="filepos3742">, and Matter's internal links are all of that
         * shape -- looking only for id= found none of them and every link went nowhere.
         */
        let _bookAnchorIndex = null;

        function buildBookAnchorIndex() {
            const map = {};
            if (typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'epub') return map;
            const re = /\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
            const blocks = DocumentModel.blocks;
            for (let i = 0; i < blocks.length; i++) {
                const r = blocks[i].raw;
                if (!r || r.indexOf('=') < 0) continue;
                let m;
                re.lastIndex = 0;
                while ((m = re.exec(r))) {
                    const id = m[1] || m[2] || m[3];
                    // First wins: an anchor repeated later in the book is still first
                    // encountered where the reader would expect to land.
                    if (id && !Object.prototype.hasOwnProperty.call(map, id)) map[id] = i;
                }
            }
            return map;
        }

        /** The block carrying a given anchor, or -1. */
        function findBookBlockWithId(id) {
            if (!id || typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'epub') return -1;
            if (!_bookAnchorIndex) _bookAnchorIndex = buildBookAnchorIndex();
            return Object.prototype.hasOwnProperty.call(_bookAnchorIndex, id)
                ? _bookAnchorIndex[id] : -1;
        }

        /**
         * Show a model block, using whatever navigation the current layout actually uses.
         *
         * One place, because there were three -- the outline, search and the TOC each had
         * their own, and each had to learn separately that seeding scrollTop under
         * virtualisation does nothing.
         */
        function goToModelBlock(idx) {
            if (typeof DocumentModel === 'undefined' || !DocumentModel.blocks.length) return;
            const bi = Math.max(0, Math.min(idx | 0, DocumentModel.blocks.length - 1));
            try {
                if (isPaginatedLayout()) {
                    goToPageHoldingBlock(bi);
                } else {
                    restoreStickyDocumentLine(modelBlockStartLine(bi));
                }
                _readingAnchor = bi;
                rememberStickyLine(modelBlockStartLine(bi));
            } catch (e) {
                window.showDebugTelemetry('goToModelBlock: ' + e.message);
            }
        }


        /**
         * Split one spine document into blocks: the top-level children of <body>.
         *
         * The browser is the HTML authority, so the host sends each document as it was
         * written and the splitting happens here. Doing it in C# would mean a second HTML
         * parser, of the regex kind, disagreeing with this one at the edges -- which is the
         * shape of most of the bugs already fixed in this project.
         *
         * One paragraph-ish unit per block, matching the granularity the Markdown model
         * uses, so pagination breaks where a reader expects and PageChunks ranges stay
         * meaningful. A chapter wrapped in a single container contributes its children
         * rather than itself: one block per chapter would defeat pagination entirely.
         */
        function bookBlocksFromHtml(html) {
            const out = [];
            let doc;
            try { doc = new DOMParser().parseFromString(String(html || ''), 'text/html'); }
            catch (e) { return out; }
            const body = doc.body;
            if (!body) return out;

            const WRAP = /^(DIV|SECTION|ARTICLE|MAIN|BODY)$/;
            const push = function (el, depth) {
                const kids = el.children;
                // Descend through pure wrappers. Depth is capped because a book that nests
                // containers deeply would otherwise be split down to individual spans.
                //
                // Also descend a single wrapper (Calibre often wraps a whole chapter in one
                // DIV with one child DIV) and oversized containers with a few children —
                // one enormous block defeats pagination and page windowing.
                const tagOk = WRAP.test(el.tagName);
                const textLen = (el.textContent || '').length;
                if (depth < 4 && tagOk && kids.length === 1 && WRAP.test(kids[0].tagName)) {
                    push(kids[0], depth + 1);
                    return;
                }
                if (depth < 3 && tagOk && kids.length > 3) {
                    for (let i = 0; i < kids.length; i++) push(kids[i], depth + 1);
                    return;
                }
                if (depth < 3 && tagOk && kids.length >= 2 && textLen > 8000) {
                    for (let i = 0; i < kids.length; i++) push(kids[i], depth + 1);
                    return;
                }
                const frag = el.outerHTML;
                if (frag && frag.trim()) out.push(frag);
            };
            push(body, 0);
            return out;
        }

        /** A TOC href reduced to something comparable: no fragment, no ./, decoded. */
        function bookNormalizeHref(href) {
            let h = String(href == null ? '' : href).split('#')[0].replace(/^\.\//, '');
            try { h = decodeURIComponent(h); } catch (e) {}
            return h;
        }

        /**
         * Blocks for a whole book, and where each spine document starts.
         *
         * The start map is what turns a table of contents into something navigable: a TOC
         * entry names a document, and the reader needs a block index to scroll to.
         */
        function bookBlocksFromDocs(docs) {
            const blocks = [];
            const docStart = {};
            const starts = [];
            // A block's images are relative to the document it came from, not to the book
            // root, so each block has to remember its own directory. Xeelee's cover lives in
            // OEBPS/Text/cover_page.xhtml and points at ../Images/cover.jpeg; resolving that
            // against one shared base lands a level too high and the image 404s. Matter is
            // flat at the root, which is the only reason a shared base ever appeared to work.
            const dirs = [];
            for (let i = 0; i < (docs ? docs.length : 0); i++) {
                docStart[bookNormalizeHref(docs[i].href)] = blocks.length;
                const href = String(docs[i].href || '').replace(/\\/g, '/');
                const dir = href.indexOf('/') >= 0 ? href.slice(0, href.lastIndexOf('/') + 1) : '';
                const bs = bookBlocksFromHtml(docs[i].html);
                for (let j = 0; j < bs.length; j++) dirs.push(dir);
                // A spine document is a chapter, and a chapter starts a page. Without this
                // a book runs continuously and a chapter heading turns up halfway down a
                // column, which no printed book does and no reader expects.
                if (bs.length) starts.push(blocks.length);
                for (let j = 0; j < bs.length; j++) blocks.push(bs[j]);
            }
            return { blocks: blocks, docStart: docStart, docStarts: starts, dirs: dirs };
        }
        /**
         * When a book's TOC hrefs are useless, match its chapter titles instead.
         *
         * Matter's ncx points all 36 entries at the same document with #filepos fragments
         * that Calibre did not carry over, so every entry resolved to block 1 and the
         * outline could only ever jump to the front of the book. Its chapters are perfectly
         * good <h2>1. Factory</h2> headings; the titles in the ncx match them exactly.
         *
         * Only used when the href resolution has visibly collapsed, so books whose hrefs are
         * sound -- Xeelee resolves 441 entries to 441 distinct blocks -- are untouched.
         */
        function bookHeadingIndex(blocks) {
            const map = {};
            for (let i = 0; i < blocks.length; i++) {
                const m = String(blocks[i] || '').match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i);
                if (!m) continue;
                const key = htmlFragmentToText(m[1]).toLowerCase();
                if (key && !Object.prototype.hasOwnProperty.call(map, key)) map[key] = i;
            }
            return map;
        }

        function bookRepairTocByTitle(toc, blocks) {
            if (!toc || toc.length < 3) return toc;
            const distinct = {};
            for (let i = 0; i < toc.length; i++) distinct[toc[i].blockIndex] = 1;
            // Sound hrefs give roughly one target per entry. Anything under half is a
            // collapse, not a book with a few duplicate destinations.
            if (Object.keys(distinct).length * 2 >= toc.length) return toc;

            const headings = bookHeadingIndex(blocks);
            let repaired = 0;
            for (let i = 0; i < toc.length; i++) {
                const key = String(toc[i].title || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (Object.prototype.hasOwnProperty.call(headings, key)) {
                    toc[i].blockIndex = headings[key];
                    repaired++;
                }
            }
            window.showDebugTelemetry('book toc: hrefs collapsed to ' +
                Object.keys(distinct).length + ' targets for ' + toc.length +
                ' entries; matched ' + repaired + ' by title');
            return toc;
        }


        /**
         * Resolve a table of contents onto block indices.
         *
         * Entries arrive as { title, level, href }. hrefs in a nav document are relative to
         * that document, which is not always the OPF directory, so a plain lookup misses and
         * the fallback compares filenames. A book whose TOC silently resolves to nothing
         * looks exactly like a book with no TOC at all, which is why this is worth being
         * careful about rather than clever.
         */
        function bookTocToBlockIndices(toc, docStart) {
            const out = [];
            if (!toc || !toc.length || !docStart) return out;
            const keys = Object.keys(docStart);
            for (let i = 0; i < toc.length; i++) {
                const e = toc[i];
                if (!e || !e.title) continue;
                const want = bookNormalizeHref(e.href);
                let idx = Object.prototype.hasOwnProperty.call(docStart, want)
                    ? docStart[want] : -1;
                if (idx < 0) {
                    const bare = want.slice(want.lastIndexOf('/') + 1);
                    for (let k = 0; k < keys.length; k++) {
                        if (keys[k] === bare || keys[k].endsWith('/' + bare)) {
                            idx = docStart[keys[k]];
                            break;
                        }
                    }
                }
                if (idx < 0) continue;
                out.push({
                    title: String(e.title).replace(/\s+/g, ' ').trim(),
                    level: Math.max(1, Math.min(6, (e.level | 0) || 1)),
                    blockIndex: idx
                });
            }
            return out;
        }

        /**
         * The book's own stylesheets, scoped to the editor.
         *
         * This is what makes carrying HTML worth the trouble: small caps, drop caps, poetry
         * indentation and epigraph alignment are the book's CSS doing its job, and the
         * browser resolves them. Both regex converters spend real effort recovering a
         * fraction of this by hand and still lose most of it.
         *
         * Scoped so a book cannot restyle the application around it, and replaced whole on
         * each load so one book's rules never leak into the next.
         */
        /**
         * Make the reader's chosen size the size the book's body text renders at.
         *
         * A publisher's stylesheet sizes text against a device default it cannot see:
         * Xeelee asks for 0.88 of base for every paragraph, so it came out at 12.32px
         * while the theme said 14 and Matter, which asks for 1em, sat at 14. Two books
         * open side by side in different sizes, and neither is the one that was chosen.
         *
         * The book keeps its own proportions -- a heading it wants at 1.5 stays half again
         * as large as its body -- and only the base moves. Measured rather than parsed,
         * because which selector carries body text is a question about a specific book and
         * not one a stylesheet answers: the most common size among the long paragraphs on
         * screen is the body, whatever it is called.
         *
         * Expressed as a multiple of --fs rather than a fixed pixel size, so changing the
         * theme's font size still moves the book.
         */
        /**
         * Make body text render at the theme's --fs size.
         *
         * Publishers often set p { font-size: 0.88em } (Xeelee). We measure the dominant
         * body size against the theme size and scale #editor so body ≈ --fs while keeping
         * relative sizes (headings still larger). Uses --fs, not documentElement (the UI
         * root is often 16px while the theme asks for something else).
         *
         * Safe to call after every page-window remount; short-circuits when already correct.
         */
        // Last scale factor applied to #editor for an epub. Avoids clear→remeasure→set on
        // every page turn, which kept scrollWidth moving and fed goToPage re-anchor thrash.
        let _bookTextScaleK = 0;
        // The publisher's stylesheets as delivered, and the divisor currently applied to
        // their declared sizes. Both belong to the book that is open.
        let _bookCssTexts = [];
        let _bookEmDivisor = 1;

        function normaliseBookTextSize() {
            if (!editor) return;
            if (typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'epub') {
                editor.style.fontSize = '';
                _bookTextScaleK = 0;
                return;
            }

            // Theme size: --fs on the document (set by applyTheme), not the browser root.
            let themePx = 0;
            try {
                const raw = getComputedStyle(document.documentElement).getPropertyValue('--fs').trim();
                if (raw) themePx = parseFloat(raw);
            } catch (e0) {}
            if (!(themePx > 0)) {
                try { themePx = parseFloat(getComputedStyle(editor).fontSize); } catch (e1) {}
            }
            if (!(themePx > 0)) themePx = 16;

            // Refine, rather than lock on the first measurement.
            //
            // This used to return here as soon as any correction had been applied, so the
            // factor was whatever the very first mounted range happened to imply -- and
            // page windowing mounts one range at a time, so on a book that opens at its
            // cover that range is front matter, whose title page and copyright block carry
            // different em factors from the body. Two launches of the same book measured
            // 0.6564 and 0.7447 for a factor that should be 0.75, purely on where the
            // reader had left off. The body then rendered at 0.88x and 0.99x of the theme.
            //
            // So when a correction is already in place we measure the text *as corrected*
            // and adjust the existing factor by however far off it landed, which needs no
            // clearing and therefore none of the reflow the old comment was avoiding. It
            // converges on the true factor as more of the book is seen, instead of
            // freezing whatever the first glimpse suggested.
            const alreadyCorrected = _bookTextScaleK > 0 && !!editor.style.fontSize;
            if (!alreadyCorrected) {
                // Nothing applied yet: measure the book's own CSS against the theme base.
                editor.style.fontSize = '';
            }

            const counts = new Map();
            const blocks = editor.querySelectorAll('.block');
            let sampled = 0, chars = 0;
            for (let i = 0; i < blocks.length && sampled < 60; i++) {
                // Prefer long body paragraphs; fall back to medium lines if the window
                // is front-matter (page windowing mounts one range at a time).
                const t = (blocks[i].innerText || '').trim();
                if (t.length < 40) continue;

                // Measure the element that OWNS the text, not the one that contains it.
                //
                // This used to read blocks[i].querySelector('p') || firstElementChild.
                // Matter's blocks are div.block > div.calibre7 > span.calibre15, with no
                // <p> anywhere: the fallback measured div.calibre7, which inherits the
                // theme's 14px, so the book looked correct and was left alone -- while
                // 99.2% of its body text painted from span.calibre15 at 1.33333em, a third
                // larger than the theme asked for. Xeelee only ever worked because its
                // blocks happen to be div.block > p.bodytext, so querySelector('p') landed
                // on the right element by luck. Side by side in two tabs, the correct book
                // looked 25% smaller than the broken one, which is how this was reported.
                const walker = document.createTreeWalker(blocks[i], NodeFilter.SHOW_TEXT, null);
                let node;
                while ((node = walker.nextNode())) {
                    const s = (node.nodeValue || '').trim();
                    if (s.length < 20) continue;          // skip glue between inline tags
                    const owner = node.parentElement;
                    if (!owner) continue;
                    const fs = Math.round(parseFloat(getComputedStyle(owner).fontSize) * 100) / 100;
                    if (!fs || fs < 6) continue;
                    // Weighted by characters, because what the eye judges is the size of
                    // the bulk of the text -- not how many elements it is spread across.
                    // A drop cap is one element and one character; a chapter is one
                    // element and four thousand.
                    counts.set(fs, (counts.get(fs) || 0) + s.length);
                    chars += s.length;
                }
                sampled++;
            }
            if (!chars) {
                // No measurable body yet — force 1em base so later remounts can refine.
                editor.style.fontSize = 'var(--fs, 16px)';
                _bookTextScaleK = 1;
                return;
            }

            let dominant = 0, best = 0;
            counts.forEach(function (n, fs) { if (n > best) { best = n; dominant = fs; } });
            if (!(dominant > 0)) return;

            // How far the body is from the theme size, right now, as rendered.
            const off = themePx / dominant;
            if (!isFinite(off) || off <= 0) return;

            // The editor always sits at exactly --fs. Text the publisher left unstyled is
            // then correct without anyone doing anything to it, which is the whole point of
            // correcting the declarations rather than the container.
            if (editor.style.fontSize !== 'var(--fs, 16px)') {
                editor.style.fontSize = 'var(--fs, 16px)';
            }
            _bookTextScaleK = 1;

            // Within a hair of correct: leave it alone. Re-applying the stylesheet
            // re-fragments the whole multi-column flow, so a no-op pass is not free.
            if (Math.abs(off - 1) < 0.02) return;

            // What the publisher's body class actually asks for, in em. Cumulative, because
            // the sizes just measured were rendered through the divisor already in force --
            // and the first measurement can come from front matter, whose classes differ
            // from the body's, so this has to be able to correct itself later.
            const emFactor = _bookEmDivisor * (dominant / themePx);
            if (!(emFactor >= 0.4 && emFactor <= 2.5)) return;
            if (Math.abs(emFactor - _bookEmDivisor) < 0.005) return;

            _bookEmDivisor = emFactor;
            try { applyBookStyles(_bookCssTexts, _bookAssetsBase, emFactor); } catch (eD) { return; }
            window.showDebugTelemetry('book text: body at ' + dominant + 'px against --fs=' +
                themePx + 'px, declared sizes divided by ' + emFactor.toFixed(4));
            // Font change reflows multicol; re-lock page columns and stay on this page.
            try {
                if (typeof isPaginatedLayout === 'function' && isPaginatedLayout()
                    && typeof PageGeometry !== 'undefined') {
                    const page = PageGeometry.localIndex();
                    PageGeometry.relayout();
                    PageGeometry.go(page);
                    if (typeof updatePageIndicator === 'function') updatePageIndicator();
                }
            } catch (ePg) {}
        }

        /** Schedule normalise after layout paints (fonts, multicol, page window). */
        function scheduleNormaliseBookTextSize() {
            if (typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'epub') return;
            // Once a factor is in place, one shot instead of three.
            //
            // This used to return outright, which is what made the first measurement final:
            // every later remount -- the ones that mount actual body text rather than the
            // cover -- was skipped here before normaliseBookTextSize could refine anything.
            // It still needs to be cheap, because it runs on every page turn, so the
            // multi-shot schedule is dropped and the single call short-circuits inside
            // normaliseBookTextSize when the body is already within 2% of the theme.
            const pinned = _bookTextScaleK > 0 && editor && editor.style.fontSize;
            const run = function () {
                try { normaliseBookTextSize(); } catch (e) {}
            };
            run();
            if (pinned) return;
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(function () {
                    requestAnimationFrame(run);
                });
            }
            setTimeout(run, 120);
        }

        /**
         * Remount a book from model HTML blocks. Never go through loadMarkdownContent —
         * that path calls fromMarkdown and treats HTML as Markdown source.
         */
        function remountBookSurface(opts) {
            opts = opts || {};
            if (!editor || typeof DocumentModel === 'undefined' || DocumentModel.kind !== 'epub')
                return false;
            const n = DocumentModel.blocks.length;
            if (!n) return false;

            DocumentModel.virtEnabled = false;
            try { unbindVirtScroll(); } catch (eV) {}

            // Books stay paginated Reader.
            state.mode = 'reader';
            state.viewMode = 'reader';
            state.viewScroll = 'pagination';
            if (!state.pageAdvance) {
                state.pageAdvance = true;
                try { postMsg('sync_page_advance:1'); } catch (eP) {}
            }
            editor.classList.add('page-mode');
            editor.classList.add('reader-mode');
            try { editor.style.display = ''; } catch (eD) {}
            if (sourceEditor) {
                try { sourceEditor.style.display = 'none'; } catch (eS) {}
            }
            setEditorEditable(false);
            PageMap.invalidate();

            const anchor = (opts.anchorBlock != null && opts.anchorBlock >= 0)
                ? (opts.anchorBlock | 0)
                : ((_readingAnchor >= 0) ? _readingAnchor : 0);

            if (pageWindowingActive() || n >= PAGE_WINDOW_MIN_BLOCKS) {
                PageChunks.ensure(n);
                mountPageChunk(PageChunks.chunkOfBlock(Math.min(anchor, n - 1)));
            } else {
                PageChunks.mounted = -1;
                const frag = document.createDocumentFragment();
                for (let i = 0; i < n; i++) {
                    const el = createPreviewBlockEl(DocumentModel.blocks[i].raw, false, i);
                    el.setAttribute('data-model-index', String(i));
                    if (_bookDocStarts[i]) el.setAttribute('data-chapter-start', '1');
                    frag.appendChild(el);
                }
                editor.innerHTML = '';
                editor.appendChild(frag);
            }
            currentActiveBlock = elementForModelIndex(Math.min(anchor, n - 1))
                || editor.querySelector('.block');
            try { applyEditorChromeForMode(); } catch (eC) {}
            try { scheduleNormaliseBookTextSize(); } catch (eN) {}
            try { updatePageIndicator(); } catch (eI) {}
            try { goToPageHoldingBlock(Math.min(anchor, n - 1)); } catch (eG) {}
            try { postViewState(currentViewState()); } catch (eV) {}
            try { postMsg('mode_changed:reader'); } catch (eM) {}
            return true;
        }

        /**
         * Tear down everything a book leaves on the page so a markdown/txt tab is not
         * painted under publisher CSS, Reader locks, or page-mode multicol.
         *
         * Without this, switching from Xeelee/Matter to README left #book-styles active
         * (often black text on a dark theme = "empty" document) and Pages still on
         * (1/35 of a short note). The buffer was fine; the surface was not.
         */
        function clearBookSession() {
            try {
                const el = document.getElementById('book-styles');
                if (el) el.textContent = '';
            } catch (e0) {}
            try {
                if (editor) {
                    editor.style.fontSize = '';
                    editor.style.height = '';
                }
            } catch (e1) {}
            try { _bookTextScaleK = 0; } catch (eK) {}
            _bookAssetsBase = '';
            _bookDocIndex = {};
            _bookBlockDirs = [];
            try { _bookDocStarts = {}; } catch (e2) {}
            try { _bookPlateBlocks = null; } catch (e2b) {}
            try { _bookCssTexts = []; _bookEmDivisor = 1; } catch (e2c) {}
            try { _bookAnchorIndex = null; } catch (e3) {}
            try { _bookTitleIndex = null; } catch (e4) {}
            try { _bookPosLast = -1; } catch (e5) {}
            if (_bookPosTimer) {
                try { clearTimeout(_bookPosTimer); } catch (e6) {}
                _bookPosTimer = null;
            }
        }

        /**
         * Leave Reader + Pages that a book forced on, and restore a normal markdown surface.
         * Only call when leaving an epub for a non-book document (not for sticky mode-switch).
         */
        function leaveBookViewForMarkdown() {
            clearBookSession();
            try {
                state.mode = 'wysiwyg';
                state.viewMode = 'preview';
                state.viewScroll = 'scroll';
                // Keep column count if the user had 2-col; still force scroll not pages.
                if (state.pageAdvance) {
                    state.pageAdvance = false;
                    try { postMsg('sync_page_advance:0'); } catch (eP) {}
                }
                if (editor) {
                    editor.classList.remove('page-mode', 'reader-mode');
                    // two-col without pagination is invalid for preview scroll — drop it
                    editor.classList.remove('two-col-layout');
                    state.viewColumns = 1;
                    try { editor.scrollLeft = 0; } catch (eS) {}
                    try { editor.style.display = ''; } catch (eD) {}
                }
                if (sourceEditor) {
                    try { sourceEditor.style.display = 'none'; } catch (eSrc) {}
                }
                try { PageMap.invalidate(); } catch (eM) {}
                try { if (typeof PageChunks !== 'undefined') PageChunks.invalidate(); } catch (eC) {}
                try { currentTwoColPage = 0; } catch (eT) {}
                try { setEditorEditable(true); } catch (eE) {}
                try { applyEditorChromeForMode(); } catch (eCh) {}
                try { updatePageIndicator(); } catch (eI) {}
                try { postMsg('mode_changed:wysiwyg'); } catch (eMode) {}
                try { postViewState(currentViewState()); } catch (eV) {}
            } catch (e) {
                try { window.showDebugTelemetry('leaveBookViewForMarkdown: ' + e.message); } catch (e2) {}
            }
        }

        /**
         * The book's own stylesheets, optionally with every declared size divided through.
         *
         * emDivisor is how the reader's text size is honoured without touching the box the
         * text sits in. A publisher sizes against a device default it cannot see -- Xeelee
         * asks for 0.88em on its body classes, Matter for 1.33333em -- and the old fix
         * scaled #editor by the reciprocal so the dominant size landed on the theme. That
         * works for text wearing the class and only for that text: anything the publisher
         * left unstyled inherited the scaled base and came out wrong in the other
         * direction. Measured on Xeelee, about one paragraph in ten.
         *
         * Dividing the declarations instead leaves #editor at exactly --fs, so unstyled
         * text is right by definition, 0.88em/0.88 is 1em and right too, and a 1.5em
         * heading becomes 1.7em -- still half again the size of the body, which is the
         * proportion the publisher was expressing.
         */
        function applyBookStyles(cssTexts, assetsBase, emDivisor) {
            let el = document.getElementById('book-styles');
            if (!el) {
                el = document.createElement('style');
                el.id = 'book-styles';
                document.head.appendChild(el);
            }
            if (!cssTexts || !cssTexts.length) { el.textContent = ''; return; }

            const base = String(assetsBase || '');
            let joined = cssTexts.join('\n')
                // @page and @import belong to the book's own pagination and packaging;
                // TypoZen owns the page and has already fetched the stylesheets.
                .replace(/@page[^{]*\{[^}]*\}/gi, '')
                .replace(/@import[^;]*;/gi, '')
                // A book marks its own page breaks -- .pb, .pagebreak, .mbppagebreak -- and
                // says so with page-break-before, which is an alias for break-before: page.
                // A multi-column layout ignores a paged-media break, so a part title that
                // has its own page in every other reader ran on mid-column here. Same trap
                // TypoZen's own rule fell into. left/right mean recto/verso, which a
                // two-column spread has no notion of; a column break is the honest reading.
                .replace(/\bpage-break-(before|after)\s*:\s*(always|left|right)\s*(;|})/gi,
                    function (m, side, how, end) { return 'break-' + side + ': column' + end; })
                // `break-after: page` is deliberately NOT converted, and this is the reason.
                //
                // It looks like the same request as `page-break-after: always` and it is not.
                // Xeelee carries it on body classes -- .bt1-body-text2, .bt1-fo1, .story-dates
                // -- which is to say on ordinary paragraphs, in their thousands. In the reader
                // the publisher wrote for, each spine document is laid out on its own, so a
                // paged break on the last paragraph of a file costs nothing and a paged break
                // anywhere else is simply ignored. Our flow is every document concatenated,
                // so converting it to a column break fires after nearly every paragraph.
                // Measured: columns went from 97% and 99% full to 9% and 12% -- two paragraphs
                // on a whole spread, which is what a reader would call the app being broken.
                //
                // The legacy `page-break-*` conversion above is safe because publishers use
                // that spelling to mean a break they actually want. This spelling, in this
                // book, means nothing at all. Honouring a declaration is not the same as
                // honouring an intention, and the two only look alike from the stylesheet.
                .replace(/\bpage-break-inside\s*:\s*avoid\s*(;|})/gi, 'break-inside: avoid$1')
                // rem is rooted at the application, not at the reader's text, so a book
                // asking for 0.88rem renders at 0.88 of TypoZen's UI size and the reader's
                // own font-size setting cannot touch it. Xeelee does exactly this and came
                // out at 12.32px while Matter, which uses em, sat at the chosen 14px.
                .replace(/(\d*\.?\d+)rem\b/gi, '$1em')
                .replace(/\burl\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (m, q, u) {
                    if (/^(data:|https?:|\/)/i.test(u)) return m;
                    return 'url("' + base + u.replace(/^\.\//, '') + '")';
                });

            // The reader's leading, not the publisher's.
            //
            // An omnibus is not one book: Xeelee is twelve, each with its own stylesheet,
            // and they disagree. Measured across it -- 1.6 for the first books, 1.2 for the
            // later ones, with the occasional paragraph at something else again. Reading
            // straight through, the page visibly tightens and loosens for no reason the
            // reader can see, which is what "messy, and often very tight in some places"
            // means. The theme already decides the typeface and the size; leading is the
            // third part of the same decision and there is no sense in honouring a
            // publisher's on a page whose width and font neither of us chose.
            //
            // Dropped rather than rewritten, so everything inherits the one value the app
            // sets. The cost is that deliberately tight setting -- a verse, a title page --
            // is levelled too. That is a real loss and a small one against a novel that
            // changes leading halfway through.
            joined = joined.replace(/(^|[;{])\s*line-height\s*:[^;}]*/gi, '$1');

            // Divide the declared sizes through, after rem has become em so both are caught.
            // Relative units only: an em or a % is the publisher expressing a proportion,
            // which is exactly what we are renormalising. A px is an absolute the publisher
            // meant literally, and there is no proportion in it to rescale.
            const d = Number(emDivisor);
            if (isFinite(d) && d > 0 && Math.abs(d - 1) > 0.001) {
                joined = joined.replace(
                    /(font-size\s*:\s*)(\d*\.?\d+)(em|%)/gi,
                    function (m, head, num, unit) {
                        const v = parseFloat(num) / d;
                        return head + (Math.round(v * 10000) / 10000) + unit;
                    });
            }

            // Every rule is confined to the editor. Naive but sufficient: these are book
            // stylesheets, not application ones, and shipping a CSS parser would gain
            // nothing a reader would ever notice.
            el.textContent = joined.replace(/(^|\})\s*([^@{}][^{}]*)\{/g,
                function (m, brace, sel) {
                    const parts = sel.split(',').map(function (one) {
                        const t = one.trim();
                        if (!t) return '';
                        if (/^(html|body)\b/i.test(t)) return '#editor';
                        return '#editor ' + t;
                    }).filter(Boolean);
                    return brace + ' ' + parts.join(', ') + '{';
                });
        }


        /**
         * A book's HTML fragment as the text a reader sees.
         *
         * Never a regex over the markup: search, the outline and the word count all run on
         * this, and matching inside `class` or `href` would be both wrong and invisible.
         * DOMParser gives the browser's own answer.
         */
        function htmlFragmentToText(html) {
            if (html == null) return '';
            const s = String(html);
            if (s.indexOf('<') < 0) return s;          // plain text already
            try {
                const doc = new DOMParser().parseFromString(s, 'text/html');
                return (doc.body.textContent || '').replace(/[ \t\u00a0]+/g, ' ').trim();
            } catch (e) {
                return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            }
        }

        /**
         * Strip anything executable from a book's markup before it enters the page.
         *
         * The HTML comes from a file the user opened, which is not the same as trusting it.
         * Scripts, event handlers and javascript: URLs are removed; everything structural is
         * left exactly as the book wrote it, because that fidelity is the whole reason for
         * carrying HTML rather than converting it.
         */
        function sanitizeBookHtml(html) {
            if (html == null) return '';
            try {
                const doc = new DOMParser().parseFromString(String(html), 'text/html');
                // Executable / navigation chrome the book must not bring into the page.
                const kill = doc.body.querySelectorAll(
                    'script, iframe, object, embed, link, meta, base, form, template, ' +
                    'foreignObject, handler, set, animate, animateTransform');
                for (let i = 0; i < kill.length; i++) kill[i].remove();
                const all = doc.body.querySelectorAll('*');
                for (let i = 0; i < all.length; i++) {
                    const el = all[i];
                    const attrs = el.attributes;
                    for (let a = attrs.length - 1; a >= 0; a--) {
                        const name = attrs[a].name.toLowerCase();
                        const val = String(attrs[a].value || '');
                        if (name.indexOf('on') === 0) { el.removeAttribute(attrs[a].name); continue; }
                        // External SVG use / xlink can pull remote markup; strip those.
                        if ((name === 'href' || name === 'src' || name === 'xlink:href')
                            && (/^\s*javascript:/i.test(val)
                                || /^\s*data\s*:\s*text\/html/i.test(val)
                                // localName, not tagName: an SVG element's tagName keeps
                                // the case it was written in, so 'use' never equalled 'USE'
                                // and this guard had never once fired. HTML elements report
                                // uppercase, which is what made it look right.
                                || (el.localName === 'use' && /^\s*https?:/i.test(val)))) {
                            el.removeAttribute(attrs[a].name);
                        }
                    }
                }
                return doc.body.innerHTML;
            } catch (e) {
                return '';
            }
        }

        /**
         * Is this block a plate -- a picture that is the whole of the page it sits on?
         *
         * Two conditions, and the second was learned the hard way. The block must carry no
         * text, so an illustration set beside prose is left alone. And the picture has to be
         * page art in the first place: Matter's "About the Author" is a 230x233 portrait
         * alone in its block, which satisfies the first condition perfectly and looked
         * ridiculous blown up to 718x757 -- a three-fold upscale of a thumbnail, filling a
         * page nobody wanted filled.
         *
         * An <svg> wrapper always qualifies: that is the shape every epub cover in the test
         * set uses, <svg viewBox><image/></svg>, and it exists precisely to say "this
         * picture is the page". A bare <img> has to prove its size instead.
         *
         * naturalHeight is 0 until the image loads, so a picture that has not arrived yet is
         * re-judged when it does rather than being written off on first sight.
         */
        const PLATE_MIN_NATURAL_PX = 400;

        /**
         * Which blocks belong to a document that is nothing but pictures.
         *
         * "A picture alone in its block" is not enough to mean "this picture is the page",
         * and Matter's appendix proves it: a heading, a table of abbreviations as an image,
         * another heading, and four character lists as images. Every one of those images is
         * alone in its block, so every one became a full-page plate and the appendix ran to
         * six columns where a real reader uses two pages. They are reference tables set as
         * pictures, not cover art.
         *
         * A spine document is the unit that means "page" in an epub. If a document contains
         * no text at all, then its pictures *are* the page -- that is what a cover, a
         * frontispiece or a full-page plate looks like in the file. If the document has any
         * prose in it, its pictures are illustrations sitting inside a page, however alone
         * they may be in their own block.
         */
        let _bookPlateBlocks = null;

        function bookFindPlateBlocks(blocks, docStarts) {
            const plates = {};
            if (!blocks || !docStarts || !docStarts.length) return plates;
            const strip = (s) => String(s == null ? '' : s)
                .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
            for (let d = 0; d < docStarts.length; d++) {
                const from = docStarts[d];
                const to = (d + 1 < docStarts.length) ? docStarts[d + 1] : blocks.length;
                let hasPicture = false, hasText = false;
                for (let i = from; i < to; i++) {
                    const raw = blocks[i] && blocks[i].raw != null ? blocks[i].raw : blocks[i];
                    if (/<(img|svg)\b/i.test(String(raw))) hasPicture = true;
                    if (strip(raw)) { hasText = true; break; }
                }
                if (!hasPicture || hasText) continue;
                for (let i = from; i < to; i++) plates[i] = 1;
            }
            return plates;
        }

        function markBookPlate(block) {
            const pics = block.querySelectorAll('img, svg');
            if (!pics.length || (block.textContent || '').trim()) {
                block.classList.remove('tz-plate');
                return;
            }
            // Its document has to be a picture document, not merely its block.
            if (_bookPlateBlocks) {
                const mi = +block.getAttribute('data-model-index');
                if (!(mi >= 0) || !_bookPlateBlocks[mi]) {
                    block.classList.remove('tz-plate');
                    return;
                }
            }
            let qualifies = false, waiting = [];
            for (const el of pics) {
                if (el.localName === 'svg') { qualifies = true; continue; }
                if ((el.naturalHeight || 0) >= PLATE_MIN_NATURAL_PX ||
                    (el.naturalWidth || 0) >= PLATE_MIN_NATURAL_PX) { qualifies = true; continue; }
                if (!el.complete) waiting.push(el);
            }
            block.classList.toggle('tz-plate', qualifies);
            if (qualifies || !waiting.length) return;
            for (const el of waiting) {
                el.addEventListener('load', function once() {
                    el.removeEventListener('load', once);
                    // The block may have been unmounted and reused by then.
                    if (el.isConnected) { try { markBookPlate(block); } catch (e) {} }
                }, { once: true });
            }
        }

        function renderBlockPreview(block, rawInput = null) {
            const raw = rawInput !== null ? rawInput : (block.getAttribute('data-raw') || '');
            clearListIndentClasses(block);

            // A book's block renders its own markup. Everything below this is the Markdown
            // renderer, and none of it applies: there is no list indent to derive, no fence
            // to detect, no inline syntax to parse. The book already said what it meant.
            if (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub') {
                block.innerHTML = sanitizeBookHtml(raw);
                // At render, not at load: the raw stays exactly as the publisher wrote it.
                rewriteBookUrls(block);

                // Tagged here because this is the one function that fills a block's content.
                // Five separate mount paths set data-chapter-start, and adding a sixth thing
                // for each of them to remember is how one of them ends up not remembering.
                try { markBookPlate(block); } catch (ePl) {}
                return;
            }

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
            // A book is read-only and its blocks are HTML, so there is nothing to serialise
            // back: the model is the document, full stop. Falling through would reach the
            // full-mount branch below, which rebuilds the model from whatever is mounted --
            // the same shape of mistake as windowing, with a whole novel at stake.
            if (typeof DocumentModel !== 'undefined' && DocumentModel.kind === 'epub') {
                return DocumentModel.toPlainText();
            }

            try {
                // Whenever the DOM holds only part of the document, the model is the
                // document and the DOM is a projection of it. That is true under
                // virtualisation and equally true under page windowing.
                //
                // This matters more than anything else in the windowing work: the full-mount
                // branch below rebuilds the model from the DOM when the counts differ, which
                // is right when the DOM really is everything and catastrophic when it is one
                // range of 400 blocks out of 3767. Saving would have written the window and
                // discarded the rest of the file.
                if (DocumentModel.virtEnabled || pageWindowingActive()) {
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

