/**
 * PDFs, read in the editor page with PDF.js (docs/archive/pdf-and-audit-plan.md, Phase 1).
 *
 * A PDF used to open on a separate WebView showing Edge's viewer, which TypoZen could not
 * reach: no theme, no remembered page, nothing of the reader's own. Here PDF.js's viewer
 * component renders it in this page instead, beside the editor, which is hidden while a PDF
 * is shown. The host streams the file from https://localpdf/<token>/<name> (OpenPdf and
 * ServePdfRequest in TypoZen_App.cs).
 *
 * PDF.js is loaded on first use, from js/vendor/pdfjs (tools/Update-PdfJs.ps1), with script
 * evaluation off: PDFs are untrusted input, and PDF.js has had a crafted-PDF script flaw
 * (CVE-2024-4367).
 *
 * Messages: host -> page  load_pdf:<url>[|page=<n>]
 *           page -> host  pdf_loaded:<pages>, book_position:<page>|gen=<g>, load_failed:<why>
 */
(function () {
    const BASE = 'https://localapp/js/vendor/pdfjs/';
    const S = {
        lib: null, ui: null,
        viewer: null, eventBus: null, linkService: null, findController: null,
        doc: null, url: '', active: false, seq: 0, reportTimer: null
    };

    /** A CSS colour as #rrggbb, whatever form the theme gave it in. */
    function hexOf(css, fallback) {
        try {
            const probe = document.createElement('span');
            probe.style.color = css;
            probe.style.display = 'none';
            document.body.appendChild(probe);
            const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
            probe.remove();
            if (!m || m.length < 3) return fallback;
            return '#' + m.slice(0, 3).map(v => ('0' + Math.round(+v).toString(16)).slice(-2)).join('');
        } catch (e) { return fallback; }
    }

    /**
     * The theme's paper and ink for PDF.js to draw the pages in -- or null for the PDF's own
     * colours, the default (View > PDF Pages in Theme Colours). PDF.js recolours pictures as
     * well as text in this mode, so a designed PDF only gets it when the reader asks.
     */
    let themed = false;
    function themePageColors() {
        if (!themed) return null;
        const root = getComputedStyle(document.documentElement);
        const bg = hexOf(root.getPropertyValue('--bg').trim() || '#18181B', '#18181B');
        const fg = hexOf(root.getPropertyValue('--tx').trim() || '#F4F4F5', '#F4F4F5');
        return { background: bg, foreground: fg };
    }

    async function ensureLib() {
        if (S.lib) return;
        const lib = await import(BASE + 'pdf.min.mjs');
        lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
        // pdf_viewer.mjs finds the library here, so it has to be set before the import.
        globalThis.pdfjsLib = lib;
        S.ui = await import(BASE + 'pdf_viewer.mjs');
        S.lib = lib;
        if (!document.getElementById('pdfjs-viewer-css')) {
            const link = document.createElement('link');
            link.id = 'pdfjs-viewer-css';
            link.rel = 'stylesheet';
            link.href = BASE + 'pdf_viewer.css';
            document.head.appendChild(link);
        }
    }

    function hostEl() {
        let host = document.getElementById('pdfView');
        if (!host) {
            host = document.createElement('div');
            host.id = 'pdfView';
            host.tabIndex = 0;
            host.hidden = true;
            (document.getElementById('main-container') || document.body).appendChild(host);
            watchSize(host);
        }
        return host;
    }

    function show(on) {
        const host = hostEl();
        const ed = document.getElementById('editor');
        host.hidden = !on;
        if (ed) ed.style.display = on ? 'none' : '';
        if (on) { const main = document.getElementById('main-container'); if (main) main.scrollTop = 0; }
        document.documentElement.classList.toggle('tz-pdf-active', on);
        S.active = on;
        window.tzPdfActive = on;
        // The page numbers and scrubber follow: a PDF's in Pages mode, or back to the document's.
        try { if (typeof updatePageIndicator === 'function') updatePageIndicator(); } catch (e) { }
    }

    function teardown() {
        clearTimeout(S.reportTimer);
        // An export of this PDF stops with it (runExport reports it cancelled).
        try { for (const k in exportJobs) exportJobs[k].cancelled = true; } catch (e) { }
        // Reading this PDF aloud ends with it: its paragraphs are about to stop existing.
        try {
            if (typeof isPlaying !== 'undefined' && isPlaying && typeof _currentTTSBlockEl !== 'undefined'
                && _currentTTSBlockEl && _currentTTSBlockEl.dataset && _currentTTSBlockEl.dataset.pdfPage != null
                && typeof stopReading === 'function') stopReading();
        } catch (e) { }
        try { if (S.viewer) S.viewer.setDocument(null); } catch (e) { }
        try { if (S.linkService) S.linkService.setDocument(null); } catch (e) { }
        try { if (S.doc) S.doc.destroy(); } catch (e) { }
        S.viewer = S.eventBus = S.linkService = S.findController = S.doc = null;
        S.pageTexts = S.pageItems = S.pageStarts = S.outline = S.outlinePages = null;
        S.haystack = '';
        S.findMatches = [];
        S.pendingReveal = false;
        S.blocks = null; S.blocksKey = ''; S.readEl = null; S.flashEl = null; S.textReady = false; S.password = null;
        S.ocrRun++; S.ocrPages = {}; S.ocrBoxes = {}; S.ocrSize = {}; S.ocrStats = null;
        S.editMode = 'none'; window.tzPdfEditing = false; S.modified = false;
        try { const h1=CSS.highlights.get('typozen-find'); if(h1)h1.clear(); const h2=CSS.highlights.get('typozen-find-current'); if(h2)h2.clear(); CSS.highlights.delete('typozen-find'); CSS.highlights.delete('typozen-find-current'); } catch(e){}
        clearBand('read'); clearBand('arrive');
        const host = document.getElementById('pdfView');
        if (host) host.innerHTML = '';
    }

    /**
     * The status bar on a PDF: words and characters of its text, and the page in place of
     * the line (07-stats-host.js asks for this while a PDF is on screen).
     */
    /**
     * The page the status bar describes: the right-hand page of a two-page spread, the page
     * itself otherwise -- the same rule as a book's label (Ed, 2026-10-01).
     */
    function statusPage(page) {
        const pages = (S.viewer && S.viewer.pagesCount) || 1;
        const p = Math.max(1, page | 0);
        if (S.cols !== 2 || S.scroll !== 'pagination') return p;
        const left = (p % 2) ? p : p - 1;   // spreads start on odd pages: 1-2, 3-4
        return Math.min(left + 1, pages);
    }

    window.tzPdfStats = function () {
        if (!S.active || !S.viewer) return null;
        if (S.statsFor !== S.haystack) {
            S.statsFor = S.haystack;
            let words = 0;
            try { words = typeof countWordsForStats === 'function' ? countWordsForStats(S.haystack) : 0; } catch (e) { }
            S.statsWords = words;
        }
        return {
            words: S.statsWords || 0,
            // The page texts, not the search haystack: its page separators are not the
            // PDF's characters (a PDF with no text showed "22 chars" -- 11 separators).
            chars: (S.pageTexts || []).reduce((n, t) => n + (t ? t.length : 0), 0),
            page: statusPage(S.viewer.currentPageNumber || 1),
            pages: S.viewer.pagesCount || 0
        };
    };
    function refreshStats() {
        try { if (typeof updateStats === 'function') updateStats(); } catch (e) { }
    }

    /**
     * The page scrubber in Pages mode (updatePageScrubber, 02-layout.js): which page of how
     * many, or null outside Pages mode, where the PDF scrolls natively.
     */
    window.tzPdfPaging = function () {
        if (!S.active || !S.viewer || S.scroll !== 'pagination') return null;
        const pages = S.viewer.pagesCount || 0;
        if (!pages) return null;
        return { page: S.viewer.currentPageNumber || 1, pages: pages, spread: S.cols === 2 };
    };
    window.tzPdfGotoPage = function (n) {
        if (!S.active || !S.viewer) return;
        const pages = S.viewer.pagesCount || 1;
        S.viewer.currentPageNumber = Math.max(1, Math.min(pages, n | 0));
    };
    function refreshScrubber() {
        // updatePageIndicator refreshes the scrubber too, and numbers the pages in the corner.
        try { if (typeof updatePageIndicator === 'function') updatePageIndicator(); } catch (e) { }
    }
    /**
     * In Pages mode, fitted to the window, there is nothing to scroll to: the scroll bar
     * PDF.js leaves showing moved nothing a reader wanted (Ed, 2026-09-30). Hidden then;
     * shown again when the reader zooms in and there is somewhere to scroll.
     */
    function syncPdfScrollbar() {
        const host = document.getElementById('pdfView');
        if (!host || !S.viewer) return;
        let fitted = false;
        try { const m = S.viewer.currentScaleValue; fitted = m === 'page-fit' || m === 'page-width' || m === 'auto'; } catch (e) { }
        host.classList.toggle('tz-pdf-pages-fitted', S.scroll === 'pagination' && fitted);
    }

    /** Where the reader is, for the host to reopen the PDF there. Debounced like books. */
    /**
     * The outline entry each page sits under, for the status bar ("Active outline node",
     * Ed, 2026-10-01): every entry resolved to its page once, then looked up per page turn.
     */
    async function resolveOutlinePages(doc, seq) {
        const flat = [];
        const walk = async (items) => {
            for (const it of items || []) {
                if (seq !== S.seq) return;
                if (!it || !it.title) continue;
                let page = -1;
                try {
                    let dest = it.dest;
                    if (typeof dest === 'string') dest = await doc.getDestination(dest);
                    if (Array.isArray(dest) && dest[0] != null) {
                        page = (typeof dest[0] === 'object') ? await doc.getPageIndex(dest[0]) : (dest[0] | 0);
                    }
                } catch (e) { page = -1; }
                if (page >= 0) flat.push({ page: page + 1, title: String(it.title).replace(/\s+/g, ' ').trim() });
                await walk(it.items);
            }
        };
        await walk(S.outline);
        if (seq !== S.seq) return;
        flat.sort((a, b) => a.page - b.page);
        S.outlinePages = flat;
        S.outlinePosted = null;
        try { postOutlineAt(statusPage(S.viewer ? S.viewer.currentPageNumber : 1)); } catch (e) { }
    }
    function postOutlineAt(page) {
        const list = S.outlinePages;
        let title = '';
        if (list && list.length) for (const e of list) { if (e.page <= page) title = e.title; else break; }
        if (title === S.outlinePosted) return;
        S.outlinePosted = title;
        try { postMsg('chapter:-1\t' + title); } catch (e) { }
    }

    function reportPage(page) {
        try { postOutlineAt(statusPage(page)); } catch (eO) { }
        refreshStats();
        refreshScrubber();
        clearTimeout(S.reportTimer);
        const gen = window.__docGen || 0;
        S.reportTimer = setTimeout(() => {
            try { postMsg('book_position:' + page + '|gen=' + gen); } catch (e) { }
        }, 800);
    }

    /**
     * view: the tab's own layout, { cols, scroll }, either may be absent. Absent means the
     * tab never chose one, and the viewer keeps what it last showed. A redraw in place (a
     * theme change) passes none and keeps the layout on screen.
     */
    window.tzOpenPdf = async function (url, page, view) {
        const seq = ++S.seq;
        try {
            await ensureLib();
            if (seq !== S.seq) return;
            // Redrawn in place (a theme change) keeps its password; opened afresh, it asks.
            const knownPassword = (url === S.url) ? S.password : null;
            // ...and keeps annotations and form entries not yet saved: reopened from the PDF
            // as it stands, not from the file.
            let keepBytes = null;
            try {
                if (url === S.url && S.doc && (S.modified || S.editedCopy))
                    keepBytes = await S.doc.saveDocument();
            } catch (e) { keepBytes = null; }
            if (seq !== S.seq) return;
            teardown();
            // The PDF look held for this PDF (view_profile, 03-shell.js), in force before
            // the viewer draws, as a book's is.
            try { if (typeof takePendingViewProfile === 'function') takePendingViewProfile(); } catch (eVp) {}
            // Before the viewer exists, so pagesinit -> applyView lays it out this way first
            // time rather than drawing 1-column scroll and switching.
            if (view && (view.cols === 1 || view.cols === 2)) S.cols = view.cols;
            if (view && (view.scroll === 'scroll' || view.scroll === 'pagination')) S.scroll = view.scroll;
            S.password = knownPassword;
            S.editedCopy = !!keepBytes;
            // Empty the editor's document first. It stays in the page, hidden, and without
            // this still held the previous document: the status bar counted its words, and
            // Read Aloud or Bookmark This Page acted on text that was not on screen. From a
            // book, replaceBook also takes the book's styles and layout down.
            S.clearingModel = true;
            try { if (typeof loadMarkdownContent === 'function') loadMarkdownContent('', { replaceBook: true }); }
            catch (e) { }
            finally { S.clearingModel = false; }
            show(true);
            const host = hostEl();
            host.innerHTML = '<div class="pdfViewer"></div>';
            const ui = S.ui, lib = S.lib;
            const eventBus = new ui.EventBus();
            const linkService = new ui.PDFLinkService({ eventBus });
            const findController = new ui.PDFFindController({ eventBus, linkService });
            const viewer = new ui.PDFViewer({
                container: host,
                viewer: host.firstElementChild,
                eventBus, linkService, findController,
                pageColors: themePageColors(),
                // One selection painter, the theme's (typozen.css #pdfView .textLayer). PDF.js
                // otherwise draws its own with a backdrop-filter over the page image, and the
                // two together gave a PDF selection a colour of neither.
                enableSelectionRendering: false,
                annotationMode: lib.AnnotationMode.ENABLE_FORMS,
                // The highlight tool's colours, PDF.js's own defaults. Its app supplies these;
                // without them making a highlight threw (the colour's name is looked up here).
                annotationEditorHighlightColors: 'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F',
                removePageBorders: false
            });
            linkService.setViewer(viewer);
            Object.assign(S, { eventBus, linkService, findController, viewer, url });

            eventBus.on('scalechanging', (ev) => { if (seq === S.seq) { postZoom(ev && ev.scale, ev && ev.presetValue); syncPdfScrollbar(); } });
            // PDF.js's editor asks for a change of tool itself (highlighting a selection from
            // reading mode, say); in its own app the app answers, so here the page does.
            // (PDF.js 6 asks with showannotationeditorui; older builds with switchannotationeditormode.)
            const answerMode = (ev) => { if (seq === S.seq && ev && ev.mode != null) { try { viewer.annotationEditorMode = { mode: ev.mode, editId: ev.editId, isFromKeyboard: ev.isFromKeyboard, mustEnterInEditMode: ev.mustEnterInEditMode, editComment: ev.editComment }; } catch (e) { } } };
            eventBus.on('showannotationeditorui', answerMode);
            eventBus.on('switchannotationeditormode', answerMode);
            eventBus.on('annotationeditormodechanged', (ev) => {
                if (seq !== S.seq || !ev) return;
                const name = Object.keys(EDIT_MODES).find(k => EDIT_MODES[k] === ev.mode) || 'none';
                S.editMode = name;
                window.tzPdfEditing = name !== 'none';
                try { postMsg('pdf_edit_mode:' + name); } catch (e) { }
            });
            eventBus.on('pagesinit', () => {
                applyView();
                if (page > 1) viewer.currentPageNumber = Math.min(page, viewer.pagesCount);
                postView();
            });
            eventBus.on('pagechanging', (e) => { if (seq === S.seq) reportPage(e.pageNumber); });
            eventBus.on('textlayerrendered', (ev) => {
                if (seq !== S.seq) return;
                // A scanned page's words go back on before anything paints over them.
                if (ev && ev.pageNumber && S.ocrPages[ev.pageNumber - 1]) paintOcrLayer(ev.pageNumber - 1);
                onTextLayer();
            });

            const task = lib.getDocument({
                url: keepBytes ? undefined : url,
                data: keepBytes || undefined,
                password: knownPassword || undefined,
                cMapUrl: BASE + 'cmaps/', cMapPacked: true,
                standardFontDataUrl: BASE + 'standard_fonts/',
                wasmUrl: BASE + 'wasm/',
                iccUrl: BASE + 'iccs/',
                isEvalSupported: false,
                enableXfa: false
            });
            // A password-protected PDF: ask, and ask again if it was wrong. Cancelling leaves
            // a note in the view with a way to try again (see the catch below).
            let cancelled = false;
            task.onPassword = (update, reason) => {
                if (seq !== S.seq) { task.destroy(); return; }
                const wrong = lib.PasswordResponses && reason === lib.PasswordResponses.INCORRECT_PASSWORD;
                const pw = window.prompt((wrong ? 'That password is not right.\n\n' : '')
                    + 'This PDF is protected. Enter its password to open it:', '');
                if (pw == null) { cancelled = true; task.destroy(); return; }
                S.password = pw;              // kept in memory while open, for exports' own copy
                update(pw);
            };
            let doc;
            try { doc = await task.promise; }
            catch (err) {
                if (seq !== S.seq) return;
                showProblem(cancelled || (err && err.name === 'PasswordException')
                    ? 'This PDF is protected by a password.' : 'This PDF could not be read.',
                    cancelled ? '' : String(err && err.message ? err.message : err),
                    { retry: () => window.tzOpenPdf(url, page) });
                return;
            }
            if (seq !== S.seq) { try { doc.destroy(); } catch (e) { } return; }
            S.doc = doc;
            watchEdits(doc);
            viewer.setDocument(doc);
            linkService.setDocument(doc, null);
            try { host.focus({ preventScroll: true }); } catch (e) { }
            try { postMsg('pdf_loaded:' + doc.numPages); } catch (e) { }
            // The sidebar: the PDF's own outline, and its text for Search.
            doc.getOutline().then((o) => {
                if (seq !== S.seq) return;
                S.outline = o || [];
                try { if (typeof updateOutline === 'function') updateOutline(); } catch (e) { }
                resolveOutlinePages(doc, seq);
            }).catch(() => { });
            extractText(doc, seq);
        } catch (err) {
            try { console.error('TypoZen PDF load failed', err); } catch (e) { }
            try { postMsg('load_failed:' + String(err && err.message ? err.message : err)); } catch (e) { }
        }
    };

    /**
     * A PDF that could not be opened, said in the view where it would have been. Not the
     * host's "Load failed" dialog: its advice (the tab still holds the file text) is about
     * documents, and a PDF tab holds no text.
     */
    function showProblem(title, detail, opts) {
        const host = hostEl();
        host.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'pdf-problem';
        const h = document.createElement('p');
        h.className = 'pdf-problem-title';
        h.textContent = title;
        box.appendChild(h);
        if (detail) { const d = document.createElement('p'); d.textContent = detail; box.appendChild(d); }
        const row = document.createElement('p');
        if (opts && opts.retry) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = 'Enter password';
            if (!/password/i.test(title)) b.textContent = 'Try again';
            b.addEventListener('click', opts.retry);
            row.appendChild(b);
        }
        const hint = document.createElement('span');
        hint.textContent = ' File > Open in Default App opens it in your usual PDF program.';
        row.appendChild(hint);
        box.appendChild(row);
        host.appendChild(box);
    }

    /** Leave the PDF: another document is loading into the page. */
    window.tzClosePdf = function () {
        if (S.clearingModel) return;          // tzOpenPdf emptying the editor's document
        if (!S.active && !S.doc) return;
        S.seq++;
        teardown();
        show(false);
        // The sidebar goes back to describing the editor's document.
        try { if (typeof updateOutline === 'function') updateOutline(); } catch (e) { }
    };

    /** View > PDF Pages in Theme Colours, from the host at start-up and on each toggle. */
    window.tzPdfSetThemed = function (on) {
        on = !!on;
        document.documentElement.classList.toggle('tz-pdf-themed', on);
        if (on === themed) return;
        themed = on;
        if (S.active && S.url) window.tzOpenPdf(S.url, S.viewer ? S.viewer.currentPageNumber : 1);
    };

    /** The theme changed: draw the pages in the new colours, staying on the same page. */
    window.tzPdfThemeChanged = function () {
        if (!S.active || !S.url || !themed) return;
        const page = S.viewer ? S.viewer.currentPageNumber : 1;
        window.tzOpenPdf(S.url, page);
    };

    // applyTheme writes --bg / --tx on the root element's style; watching that catches every
    // way a theme is applied without a hook in each of them.
    let lastColours = '';
    let themeTimer = null;
    try {
        new MutationObserver(() => {
            const cs = getComputedStyle(document.documentElement);
            const now = cs.getPropertyValue('--bg').trim() + '|' + cs.getPropertyValue('--tx').trim();
            if (now === lastColours) return;
            const first = !lastColours;
            lastColours = now;
            if (first || !S.active) return;
            clearTimeout(themeTimer);
            themeTimer = setTimeout(window.tzPdfThemeChanged, 150);
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    } catch (e) { }

    // ---- View: columns and Pages, from the toolbar's segmented controls ---------------------
    //
    // Two columns is a two-page spread; Pages is one page at a time. The page reports its
    // view back (view_state:) so the toolbar buttons show what is on screen.

    S.cols = 1;
    S.scroll = 'scroll';

    function applyView() {
        const v = S.viewer, ui = S.ui;
        if (!v || !ui) return;
        // Keep the page. PDF.js 6.3 jumps to page 1 when spreads are switched on while
        // scrolling vertically at page width (measured: page 3 -> 1 on the spread setter
        // alone; scroll mode or scale alone keep it), so 2 Columns on page 3 of a PDF showed
        // page 1 (pdf-reader-app). Put the page back after the three changes.
        const page = v.currentPageNumber || 1;
        try {
            v.spreadMode = S.cols === 2 ? ui.SpreadMode.ODD : ui.SpreadMode.NONE;
            v.scrollMode = S.scroll === 'pagination' ? ui.ScrollMode.PAGE : ui.ScrollMode.VERTICAL;
            v.currentScaleValue = (S.scroll === 'pagination' || S.cols === 2) ? 'page-fit' : 'page-width';
            if (v.currentPageNumber !== page) v.currentPageNumber = page;
        } catch (e) { }
        syncPdfScrollbar();
        refreshScrubber();
    }

    function postView() {
        try { postMsg('view_state:reader,' + S.cols + ',' + S.scroll + ',0,0'); } catch (e) { }
    }

    window.tzPdfViewSet = function (which, value) {
        if (which === 'columns') S.cols = parseInt(value, 10) === 2 ? 2 : 1;
        else if (which === 'scroll') S.scroll = value === 'pagination' ? 'pagination' : 'scroll';
        applyView();
        postView();
    };

    /**
     * Zoom on a PDF scales the PDF itself, so pages are drawn again sharp rather than
     * magnified, and the sidebar stays put. "in", "out" or "reset" (back to the fit).
     * The menu and Ctrl+plus/minus/0 arrive from the host; Ctrl+wheel is handled here.
     */
    window.tzPdfZoom = function (how) {
        const v = S.viewer;
        if (!S.active || !v) return;
        if (how === 'reset') { applyView(); return; }
        const s = v.currentScale || 1;
        v.currentScale = Math.max(0.25, Math.min(8, how === 'in' ? s * 1.1 : s / 1.1));
    };
    // With ",fit" while the page is fitted to the window: Reset returns to the fit, which at a
    // given window size is 99% or 104%, and a bare number there read as a rounding error.
    function postZoom(scale, preset) {
        let fit = false;
        try { const m = preset || (S.viewer && S.viewer.currentScaleValue); fit = m === 'page-width' || m === 'page-fit' || m === 'auto'; } catch (e) { }
        try { postMsg('pdf_zoom:' + Math.round((scale || 1) * 100) + (fit ? ',fit' : '')); } catch (e) { }
    }

    /** Pages mode turns with the wheel and the keys; Scroll mode scrolls natively. */
    let wheelAt = 0;
    function onWheel(e) {
        if (!S.active || !S.viewer) return;
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            if (e.deltaY) window.tzPdfZoom(e.deltaY < 0 ? 'in' : 'out');
            return;
        }
        if (S.scroll !== 'pagination') return;
        e.preventDefault();
        const now = Date.now();
        if (now - wheelAt < 180) return;
        wheelAt = now;
        if (e.deltaY > 0) S.viewer.nextPage(); else if (e.deltaY < 0) S.viewer.previousPage();
    }
    function onKey(e) {
        if (!S.active || !S.viewer || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const v = S.viewer;
        let handled = true;
        if (S.scroll === 'pagination' && (e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ')) v.nextPage();
        else if (S.scroll === 'pagination' && (e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp')) v.previousPage();
        else if (e.key === 'Home') v.currentPageNumber = 1;
        else if (e.key === 'End') v.currentPageNumber = v.pagesCount;
        else handled = false;
        if (handled) e.preventDefault();
    }
    // A fitted page refits when its space changes: the window maximised or restored, the
    // sidebar opened. PDF.js leaves that to its own app, which is not used here, so a page
    // fitted in a maximised window stayed that size when the window was restored (reported
    // as 164% after switching columns). A zoom set by hand is left alone.
    let refitQueued = false;
    function refitIfFitted() {
        refitQueued = false;
        const v = S.viewer;
        if (!S.active || !v) return;
        const mode = v.currentScaleValue;
        if (mode === 'page-width' || mode === 'page-fit' || mode === 'auto') v.currentScaleValue = mode;
    }
    /** Called by hostEl() when it creates #pdfView, which does not exist at load. */
    function watchSize(host) {
        try {
            if (typeof ResizeObserver !== 'function') return;
            new ResizeObserver(() => {
                if (!refitQueued) { refitQueued = true; requestAnimationFrame(refitIfFitted); }
            }).observe(host);
        } catch (e) { }
    }

    try {
        document.addEventListener('wheel', onWheel, { capture: true, passive: false });
        document.addEventListener('keydown', onKey, true);
    } catch (e) { }

    /** Edit > Go to Page on a PDF. */
    window.tzPdfGotoPrompt = function () {
        if (!S.viewer || !S.viewer.pagesCount) return;
        const n = S.viewer.pagesCount;
        const raw = window.prompt('Go to page (1–' + n + '):', String(S.viewer.currentPageNumber));
        if (raw == null) return;
        const p = parseInt(String(raw).replace(/[^\d].*$/, '').trim(), 10);
        if (!isFinite(p) || p < 1) return;
        S.viewer.currentPageNumber = Math.min(p, n);
    };

    /** For tests and the status bar: what is on screen. */
    window.tzPdfState = function () {
        return S.viewer ? {
            pages: S.viewer.pagesCount, page: S.viewer.currentPageNumber, url: S.url,
            textPages: S.pageTexts ? S.pageTexts.filter(t => t != null).length : 0,
            modified: !!S.modified,
            editMode: S.editMode,
            outline: S.outline ? S.outline.length : 0,
            // The layout, as asked for and as the viewer is actually showing it.
            cols: S.cols, scroll: S.scroll,
            spread: S.viewer.spreadMode, scrollMode: S.viewer.scrollMode
        } : null;
    };

    // ---- Text, for Find and the Search sidebar ------------------------------------------
    //
    // The find bar and the Search sidebar are one engine (02-layout.js): a haystack, a list
    // of match offsets, and a reveal step per surface. A PDF is one more surface, kind 'pdf':
    // its haystack is every page's text, pages joined by a blank line, so the count, next /
    // previous and the sidebar's list with snippets all work unchanged. Revealing a match
    // turns to its page and paints it on that page's text layer with the same highlight
    // names the editor uses.

    const PAGE_SEP = '\n\n';

    async function extractText(doc, seq) {
        const n = doc.numPages;
        S.pageTexts = new Array(n).fill(null);
        S.pageItems = new Array(n).fill(null);
        for (let p = 1; p <= n; p++) {
            if (seq !== S.seq) return;
            try {
                const page = await doc.getPage(p);
                const tc = await page.getTextContent();
                let text = '';
                const items = [];
                for (const it of tc.items) {
                    const str = it.str || '';
                    // The text layer draws one span per non-empty item, in this order, so an
                    // offset into this text maps onto its text nodes by counting items.
                    // Where it sits (baseline y, left x, width, font height) is what splits
                    // paragraphs: line spacing, indents and short last lines.
                    if (str.length) items.push({
                        start: text.length, len: str.length,
                        y: it.transform ? it.transform[5] : 0, h: it.height || 0,
                        x: it.transform ? it.transform[4] : 0, w: it.width || 0
                    });
                    text += str;
                    if (it.hasEOL) text += '\n';
                }
                S.pageTexts[p - 1] = text;
                S.pageItems[p - 1] = items;
            } catch (e) { S.pageTexts[p - 1] = ''; S.pageItems[p - 1] = []; }
        }
        rebuildHaystack();
        S.textReady = true;
        refreshStats();
        // Marks resolve against the paragraphs now they are all known (02-layout.js).
        try { if (typeof window.tzPdfMarksResolve === 'function') window.tzPdfMarksResolve(); } catch (e) { }
        // Pages that are pictures of text get their words read (Phase 3).
        if (seq === S.seq) startOcr();
        // A search typed while the text was still coming in is answered now it is all here.
        try {
            if (typeof findState !== 'undefined' && findState.query && typeof runFind === 'function')
                runFind(findState.query, true, { navigate: false });
        } catch (e) { }
    }

    function rebuildHaystack() {
        S.pageStarts = [];
        let hay = '';
        for (let i = 0; i < (S.pageTexts || []).length; i++) {
            if (i) hay += PAGE_SEP;
            S.pageStarts.push(hay.length);
            hay += S.pageTexts[i] || '';
        }
        S.haystack = hay;
    }

    /** 0-based page holding a haystack offset. */
    function pageOf(off) {
        const s = S.pageStarts || [];
        let lo = 0, hi = s.length - 1, ans = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
        return ans;
    }

    window.tzPdfFindSurface = function () {
        return { haystack: S.haystack || '', map: null, kind: 'pdf' };
    };
    window.tzPdfPageOfOffset = function (off) { return pageOf(off) + 1; };

    /** A DOM Range over [start, end) of a page's text, on its text layer; null if not drawn. */
    function rangeOnPage(p, start, end) {
        const layer = document.querySelector('#pdfView .page[data-page-number="' + (p + 1) + '"] ' + (S.ocrPages[p] ? '.tzOcrLayer' : '.textLayer'));
        const items = S.pageItems && S.pageItems[p];
        if (!layer || !items) return null;
        const nodes = [];
        const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        let t; while ((t = tw.nextNode())) nodes.push(t);
        if (nodes.length < items.length) return null;          // layer still being drawn
        function at(off, isEnd) {
            for (let k = 0; k < items.length; k++) {
                const it = items[k];
                if (off < it.start + it.len || (isEnd && off === it.start + it.len)) {
                    const local = Math.max(0, Math.min(it.len, off - it.start));
                    return { node: nodes[k], off: Math.min(local, nodes[k].length) };
                }
            }
            const last = items.length - 1;
            return last >= 0 ? { node: nodes[last], off: nodes[last].length } : null;
        }
        const a = at(start, false), b = at(end, true);
        if (!a || !b) return null;
        const r = document.createRange();
        try { r.setStart(a.node, a.off); r.setEnd(b.node, b.off); } catch (e) { return null; }
        return r;
    }

    function paintFind() {
        const m = S.findMatches || [];
        const idx = S.findIndex;
        try { const h1=CSS.highlights.get('typozen-find'); if(h1)h1.clear(); const h2=CSS.highlights.get('typozen-find-current'); if(h2)h2.clear(); CSS.highlights.delete('typozen-find'); CSS.highlights.delete('typozen-find-current'); } catch(e){}
        if (!m.length || !window.Highlight || !CSS.highlights) return null;
        const all = [];
        let current = null;
        for (let i = 0; i < m.length; i++) {
            const p = pageOf(m[i].start);
            const base = S.pageStarts[p];
            const r = rangeOnPage(p, m[i].start - base, m[i].end - base);
            if (!r) continue;
            if (i === idx) current = r; else all.push(r);
        }
        try {
            if (all.length) CSS.highlights.set('typozen-find', new Highlight(...all));
            if (current) CSS.highlights.set('typozen-find-current', new Highlight(current));
        } catch (e) { }
        return current;
    }

    /**
     * The find engine's reveal step for a PDF. Paints every match on the pages that are
     * drawn; with navigate, turns to the current match's page and brings it into view.
     */
    window.tzPdfShowMatches = function (matches, index, navigate) {
        S.findMatches = matches || [];
        S.findIndex = index;
        if (navigate && S.viewer && index >= 0 && S.findMatches[index]) {
            const p = pageOf(S.findMatches[index].start);
            const want = p + 1;
            if (S.viewer.currentPageNumber !== want) S.viewer.currentPageNumber = want;
            S.pendingReveal = true;
        }
        const cur = paintFind();
        if (cur && S.pendingReveal) { S.pendingReveal = false; revealRange(cur); }
    };

    function revealRange(r) {
        const host = document.getElementById('pdfView');
        if (!host || !r) return;
        const rr = r.getBoundingClientRect(), hr = host.getBoundingClientRect();
        if (rr.top < hr.top + 40 || rr.bottom > hr.bottom - 40)
            host.scrollTop += (rr.top - hr.top) - host.clientHeight / 3;
    }

    // Pages draw their text layers as they scroll into view: paint (and finish a pending
    // reveal) when one arrives.
    function onTextLayer() {
        paintRead();
        paintFlash();
        try { if (typeof window.tzPdfMarksRepaint === 'function') window.tzPdfMarksRepaint(); } catch (e) { }
        if (!S.findMatches || !S.findMatches.length) return;
        const cur = paintFind();
        if (cur && S.pendingReveal) { S.pendingReveal = false; revealRange(cur); }
    }

    // ---- Paragraphs: the unit Read Aloud and marks work in ------------------------------
    //
    // PDF text has lines, not paragraphs. A paragraph starts where a line
    //   - sits clearly further below the one before than this page's lines usually do,
    //   - starts indented from the page's left margin (a first-line indent),
    //   - follows a line that stopped well short of the right margin (a paragraph's end),
    //   - is set in a different size (a heading), or
    //   - is higher on the page than the one before (another column or box).
    // Spacing and margins are learnt from the page itself. Judging the gap against the
    // text's height instead split a generously leaded book at every line, and missed its
    // paragraphs entirely, which are marked by indents with no extra space (2026-09-26).
    // An indented block whose lines all run full -- a quotation -- stays one paragraph.
    //
    // Each paragraph is a detached <div class="block"> holding its text, with its page and
    // its span of that page's text on data attributes: Read Aloud (09-speech.js) and marks
    // (02-layout.js) work on blocks, so a PDF hands them these and they need to know little
    // more.

    /** Page p's items gathered into lines: baseline, height, left and right edges, start. */
    function pageLines(items) {
        const lines = [];
        let cur = null;
        for (const it of items) {
            const h = Math.max(cur ? cur.h : 0, it.h || 0) || 10;
            if (!cur || Math.abs(it.y - cur.y) > 0.5 * h) {
                cur = { y: it.y, h: it.h || 0, x0: it.x || 0, x1: (it.x || 0) + (it.w || 0), start: it.start };
                lines.push(cur);
            } else {
                cur.h = Math.max(cur.h, it.h || 0);
                cur.x0 = Math.min(cur.x0, it.x || 0);
                cur.x1 = Math.max(cur.x1, (it.x || 0) + (it.w || 0));
            }
        }
        return lines;
    }

    const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

    /** [start, end) spans of page p's text, one per paragraph. */
    function paragraphSpans(p) {
        const text = S.pageTexts && S.pageTexts[p];
        const items = S.pageItems && S.pageItems[p];
        if (!text || !items || !items.length) return [];
        const lines = pageLines(items);
        const hTyp = median(lines.map(l => l.h).filter(h => h > 0)) || 10;
        // The page's usual line spacing: baseline to baseline between neighbouring lines.
        const pitches = [];
        for (let k = 1; k < lines.length; k++) {
            const g = lines[k - 1].y - lines[k].y;               // PDF y grows upwards
            if (g > 0.5 * hTyp && g < 3 * hTyp) pitches.push(g);
        }
        // The lower quartile, from at least three gaps: ordinary line breaks outnumber
        // paragraph gaps, but on a page of a few lines the one gap measured may BE the
        // paragraph gap, which then looked ordinary (a scanned test page, 2026-09-26).
        const ps = pitches.slice().sort((u, v) => u - v);
        const pitch = ps.length >= 3 ? ps[Math.floor(ps.length / 4)] : 1.2 * hTyp;
        // Margins, per column: lines are grouped by where they start (a jump of a quarter of
        // the text's width is another column; an indent is far less), and each column's left
        // margin is where most of its lines start, its right where its full lines end. On a
        // two-column page one set of margins made every line of the other column look
        // indented or short. A column of few lines -- a centred heading, a caption -- has no
        // margins to trust and falls back to spacing and size alone.
        const minX = Math.min(...lines.map(l => l.x0)), maxX = Math.max(...lines.map(l => l.x1));
        const byX = lines.slice().sort((u, v) => u.x0 - v.x0);
        const cols = [];
        for (const l of byX) {
            let c = cols[cols.length - 1];
            if (!c || l.x0 - c.from > 0.25 * (maxX - minX)) { c = { from: l.x0, lines: [] }; cols.push(c); }
            c.lines.push(l);
        }
        for (const c of cols) {
            c.enough = c.lines.length >= 4;
            // The lower fifth, not the median: on a page of dialogue most lines are the
            // indented first lines of one-line paragraphs.
            const xs = c.lines.map(l => l.x0).sort((u, v) => u - v);
            c.left = xs[Math.floor(xs.length / 5)];
            c.right = Math.max(...c.lines.map(l => l.x1));
            for (const l of c.lines) l.col = c;
        }
        const indented = (l) => l.col.enough && l.x0 - l.col.left > 0.8 * hTyp;
        const full = (l) => !l.col.enough || l.col.right - l.x1 < 2.5 * hTyp;

        const out = [];
        let start = lines[0].start;
        for (let k = 1; k < lines.length; k++) {
            const a = lines[k - 1], b = lines[k];
            const gap = a.y - b.y;
            const h = Math.max(a.h, b.h) || hTyp;
            const spaced = gap > 1.4 * pitch;
            const upward = gap < -0.5 * h;
            const resized = a.h && b.h && Math.abs(a.h - b.h) > 0.2 * h;
            // A new indent, not the next line of an indented block that runs full.
            const indent = indented(b) && !(indented(a) && Math.abs(a.x0 - b.x0) < 0.3 * hTyp && full(a));
            const endedShort = !full(a);
            if (spaced || upward || resized || indent || endedShort) { out.push([start, b.start]); start = b.start; }
        }
        out.push([start, text.length]);
        return out;
    }

    /** A paragraph's text as it should be read: lines joined, hyphenated words mended. */
    function readable(raw) {
        return raw.replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').replace(/\s+/g, ' ').trim();
    }

    /**
     * Page furniture in reading order: a running head first, a footer last.
     *
     * Paragraphs come in the order the PDF stores its text, and many PDFs store the page
     * number and running title before the body -- so Read aloud spoke "2 Alice's Adventures
     * in Wonderland" and only then went back to the top of the page (Ed, 2026-10-06).
     *
     * Only furniture moves: a span of at most two lines lying wholly below everything else
     * on the page (a footer) or wholly above it (a header), and either
     *   - repeated: the same words, numbers aside, in that place on at least three pages
     *     and a fifth of them --
     *     what a running footer is. On a page of prose the body runs close to the footer,
     *     so position alone did not tell them apart and 45 of the Alice PDF's footers were
     *     missed; or
     *   - set apart by clear space, for a document too short to repeat anything.
     * The rest keeps the PDF's own order, which is what puts a two-column page's columns in
     * sequence; sorting the whole page by height would interleave them, and a column's last
     * line is neither repeated nor set apart.
     */
    function furnitureKey(raw) {
        return raw.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
    }
    /** Where each of page p's spans sits, and whether it could be a header or footer. */
    function pagePlacement(p, spans) {
        const items = S.pageItems && S.pageItems[p];
        const text = (S.pageTexts && S.pageTexts[p]) || '';
        if (!items || spans.length < 2) return null;
        const hTyp = median(items.map(it => it.h).filter(h => h > 0)) || 10;
        const info = spans.map(([a, b]) => {
            let top = -Infinity, bottom = Infinity;
            const ys = new Set();
            for (const it of items) {
                if (it.start < a || it.start >= b) continue;
                top = Math.max(top, it.y + (it.h || hTyp));
                bottom = Math.min(bottom, it.y);
                ys.add(Math.round(it.y));
            }
            return { span: [a, b], top, bottom, lines: ys.size, key: furnitureKey(text.slice(a, b)) };
        });
        for (let k = 0; k < info.length; k++) {
            const s = info[k];
            if (!(s.lines >= 1 && s.lines <= 2)) continue;
            let othersTop = -Infinity, othersBottom = Infinity;
            for (let j = 0; j < info.length; j++) {
                if (j === k || !(info[j].lines >= 1)) continue;
                // A page number and a running title can be separate spans on one line.
                if (info[j].lines <= 2 && info[j].bottom <= s.top && info[j].top >= s.bottom) continue;
                othersTop = Math.max(othersTop, info[j].top);
                othersBottom = Math.min(othersBottom, info[j].bottom);
            }
            // PDF y grows upwards.
            if (s.top < othersBottom) { s.below = true; s.farBelow = s.top < othersBottom - 1.5 * hTyp; }
            else if (s.bottom > othersTop) { s.above = true; s.farAbove = s.bottom > othersTop + 1.5 * hTyp; }
        }
        return info;
    }
    /** Page p's spans in reading order; a footer comes back as [a, b, 'foot']. */
    function readingOrder(info, spans, repeats, minRepeats) {
        if (!info) return spans;
        const heads = [], body = [], feet = [];
        const often = (s) => s.key && (repeats.get(s.key) || 0) >= minRepeats;
        for (const s of info) {
            if (s.below && (s.farBelow || often(s))) feet.push(s);
            else if (s.above && (s.farAbove || often(s))) heads.push(s);
            else body.push(s);
        }
        if (!heads.length && !feet.length) return spans;
        const down = (u, v) => v.top - u.top;
        // Furniture is marked as such: Read aloud skips it (Ed, 2026-10-06: "an ebook reader
        // shouldn't be reading the headers"), while Find, marks and selection still see it
        // as text on the page. A footer either way; a header only when it recurs -- one set
        // apart by space alone is as likely a chapter title, which must still be read.
        return heads.sort(down).map(s => often(s) ? [s.span[0], s.span[1], 'head'] : s.span)
            .concat(body.map(s => s.span), feet.sort(down).map(s => [s.span[0], s.span[1], 'foot']));
    }

    /** Every paragraph of the PDF, as blocks; the same objects until more text arrives. */
    function blocks() {
        const texts = S.pageTexts || [];
        const key = texts.map(t => (t == null ? '-' : t.length)).join(',');
        if (S.blocks && S.blocksKey === key) return S.blocks;
        const list = [];
        // Two passes: a footer is known by recurring, so every page is placed before any
        // is ordered. Counted once per page per position, below and above separately.
        const spansOf = [], placed = [], repeats = new Map();
        for (let p = 0; p < texts.length; p++) {
            spansOf[p] = paragraphSpans(p);
            placed[p] = pagePlacement(p, spansOf[p]);
            const seen = new Set();
            for (const s of placed[p] || []) {
                if (!(s.below || s.above) || !s.key) continue;
                const k = (s.below ? 'v' : '^') + s.key;
                if (seen.has(k)) continue;
                seen.add(k);
                repeats.set(k, (repeats.get(k) || 0) + 1);
            }
        }
        for (const s of placed.flat()) {
            if (s && (s.below || s.above)) s.key = (s.below ? 'v' : '^') + s.key;
        }
        // Running furniture is on most pages; a chapter opening ("Chapter #" alone at the top)
        // is on a few. At least three pages, and at least a fifth of them.
        const minRepeats = Math.max(3, Math.ceil(texts.length / 5));
        for (let p = 0; p < texts.length; p++) {
            for (const [a, b, kind] of readingOrder(placed[p], spansOf[p], repeats, minRepeats)) {
                const raw = texts[p].slice(a, b);
                const text = readable(raw);
                if (!/[\p{L}\p{N}]/u.test(text)) continue;
                const el = document.createElement('div');
                el.className = 'block';
                el.textContent = text;
                el.dataset.pdfPage = String(p);
                el.dataset.pdfStart = String(a);
                el.dataset.pdfEnd = String(b);
                el.__pdfRaw = raw;
                if (kind === 'foot') el.dataset.pdfFooter = '1';
                if (kind === 'head') el.dataset.pdfHeader = '1';
                list.push(el);
            }
        }
        S.blocks = list;
        S.blocksKey = key;
        return list;
    }
    window.tzPdfBlocks = function () { return S.active ? blocks() : []; };
    window.tzPdfTextReady = function () { return !!(S.active && S.textReady); };

    /** Page (0-based) and offset into that page's text of a DOM point on a text layer. */
    function pointOnPage(node, offset) {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const pageEl = el && el.closest ? el.closest('#pdfView .page') : null;
        const pn = pageEl ? parseInt(pageEl.getAttribute('data-page-number'), 10) - 1 : -1;
        const layer = pageEl && pageEl.querySelector(S.ocrPages[pn] ? '.tzOcrLayer' : '.textLayer');
        if (!pageEl || !layer || !layer.contains(node)) return null;
        const p = parseInt(pageEl.getAttribute('data-page-number'), 10) - 1;
        const items = S.pageItems && S.pageItems[p];
        if (!items) return null;
        const tw = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        let t, k = 0;
        while ((t = tw.nextNode())) {
            if (k >= items.length) break;
            if (t === node) return { page: p, off: items[k].start + Math.min(offset || 0, items[k].len) };
            if (node.nodeType === 1 && node.contains(t)) return { page: p, off: items[k].start };
            k++;
        }
        return null;
    }

    /**
     * A paragraph's text from the cursor on -- from the start of the word it is in -- for
     * Read from here; null when the cursor is not in this paragraph. Cut from the page's raw
     * text, where the cursor's offset is, and only then made readable: the paragraph's own
     * text has its lines joined and hyphens mended, so offsets into it are not the page's.
     */
    window.tzPdfTextFromCaret = function (el) {
        const sel = window.getSelection();
        if (!el || !sel || !sel.rangeCount || !el.__pdfRaw) return null;
        const at = pointOnPage(sel.anchorNode, sel.anchorOffset);
        const a = +el.dataset.pdfStart, b = +el.dataset.pdfEnd;
        if (!at || at.page !== +el.dataset.pdfPage || at.off < a || at.off >= b) return null;
        const raw = el.__pdfRaw;
        let i = at.off - a;
        while (i > 0 && /[\p{L}\p{N}'’-]/u.test(raw[i - 1])) i--;
        if (i <= 0) return null;                               // the start: the whole paragraph
        const text = readable(raw.slice(i));
        return text || null;
    };

    /** Index of the block holding a page offset, or the next one on that page. */
    function blockIndexAt(page, off) {
        // A page's blocks are in reading order, which is not always offset order (a footer
        // stored first in the PDF is read last -- readingOrder), so look for the block that
        // holds the offset rather than the first that ends after it.
        const list = blocks();
        let next = -1, nextStart = Infinity;
        for (let i = 0; i < list.length; i++) {
            const bp = +list[i].dataset.pdfPage;
            if (bp < page) continue;
            if (bp > page) return next >= 0 ? next : i;
            const a = +list[i].dataset.pdfStart, b = +list[i].dataset.pdfEnd;
            if (off >= a && off < b) return i;
            if (a > off && a < nextStart) { next = i; nextStart = a; }
        }
        return next;
    }

    /** The block the selection (or cursor) is in, or null. */
    window.tzPdfBlockAtSelection = function () {
        const sel = window.getSelection();
        if (!S.active || !sel || !sel.rangeCount) return null;
        const at = pointOnPage(sel.anchorNode, sel.anchorOffset);
        if (!at) return null;
        const i = blockIndexAt(at.page, at.off);
        return i >= 0 ? blocks()[i] : null;
    };

    /**
     * Where reading starts: the paragraph holding the cursor or selection, or the first
     * paragraph on screen. `ignoreCaret` for "what is on screen" (render-ahead, marks).
     */
    window.tzPdfReadStart = function (ignoreCaret) {
        const list = blocks();
        if (!list.length || !S.viewer) return -1;
        if (!ignoreCaret) {
            const el = window.tzPdfBlockAtSelection();
            if (el) return list.indexOf(el);
        }
        const host = document.getElementById('pdfView');
        const top = host ? host.getBoundingClientRect().top : 0;
        const cur = (S.viewer.currentPageNumber || 1) - 1;
        for (let i = 0; i < list.length; i++) {
            const p = +list[i].dataset.pdfPage;
            if (p < cur) continue;
            const r = rangeOnPage(p, +list[i].dataset.pdfStart, +list[i].dataset.pdfEnd);
            if (!r) return i;                                  // not drawn yet: its page's first
            if (r.getBoundingClientRect().bottom > top + 4) return i;
        }
        return list.length - 1;
    };

    /**
     * A paragraph-wide band on the page: one rounded rectangle around the paragraph's
     * lines, the way a book paints its paragraph (.block.tts-active, .tz-mark-focus).
     * These used to be CSS highlights on the text layer, which colour only the height of
     * the letters, so a PDF showed the paragraph line by line with gaps -- the look that
     * means "these words" everywhere else, not "this paragraph".
     *
     * Placed in percentages of the page, so it scales with zoom. It sits between the page
     * image and the text layer, and ignores the pointer, so selection works through it.
     * A page redraw (zoom, scrolling back) removes it with the page's other children;
     * onTextLayer paints it again, as it did the highlight.
     */
    function clearBand(kind) {
        document.querySelectorAll('#pdfView .tzPdfBand.' + kind).forEach(n => n.remove());
    }
    function paintBand(kind, el) {
        clearBand(kind);
        if (!el) return null;
        const p = +el.dataset.pdfPage;
        const r = rangeOnPage(p, +el.dataset.pdfStart, +el.dataset.pdfEnd);
        const page = document.querySelector('#pdfView .page[data-page-number="' + (p + 1) + '"]');
        if (!r || !page) return r;
        const pr = page.getBoundingClientRect(), rr = r.getBoundingClientRect();
        if (!pr.width || !pr.height || !rr.width || !rr.height) return r;
        const PAD_X = 6, PAD_Y = 3;
        const band = document.createElement('div');
        band.className = 'tzPdfBand ' + kind;
        band.style.left = ((rr.left - pr.left - PAD_X) / pr.width * 100) + '%';
        band.style.top = ((rr.top - pr.top - PAD_Y) / pr.height * 100) + '%';
        band.style.width = ((rr.width + 2 * PAD_X) / pr.width * 100) + '%';
        band.style.height = ((rr.height + 2 * PAD_Y) / pr.height * 100) + '%';
        const layer = page.querySelector(S.ocrPages[p] ? '.tzOcrLayer' : '.textLayer');
        if (layer && layer.parentNode === page) page.insertBefore(band, layer);
        else page.appendChild(band);
        return r;
    }
    /** Test hook: the text under a band ('read' or 'arrive'), or '' when none is shown. */
    window.tzPdfBandText = function (kind) {
        const el = kind === 'arrive' ? S.flashEl : S.readEl;
        if (!el || !document.querySelector('#pdfView .tzPdfBand.' + kind)) return '';
        const r = rangeOnPage(+el.dataset.pdfPage, +el.dataset.pdfStart, +el.dataset.pdfEnd);
        return r ? r.toString() : '';
    };

    /** The paragraph being read: paint it, and bring it into view (09-speech.js). */
    window.tzPdfReadFocus = function (el) {
        S.readEl = el;
        bringIntoView(el);
        paintRead();
    };
    window.tzPdfReadClear = function () {
        S.readEl = null;
        clearBand('read');
    };
    function paintRead() {
        const r = paintBand('read', S.readEl);
        if (r && S.revealRead) { S.revealRead = false; revealRange(r); }
    }

    /**
     * Turn to a block's page and scroll it into view. Its text layer may not be drawn yet,
     * so the scroll into place finishes when it is (onTextLayer -> paintRead / paintFlash).
     */
    function bringIntoView(el) {
        const v = S.viewer;
        if (!v || !el) return;
        const want = +el.dataset.pdfPage + 1;
        const r = rangeOnPage(want - 1, +el.dataset.pdfStart, +el.dataset.pdfEnd);
        if (S.scroll === 'pagination' || !r) {
            if (v.currentPageNumber !== want) v.currentPageNumber = want;
        }
        if (r) revealRange(r); else S.revealRead = true;
    }

    /** Jump to a block (a mark in the Marks pane) and wash it briefly. */
    window.tzPdfGotoBlock = function (i) {
        const el = blocks()[i];
        if (!el) return false;
        S.flashEl = el;
        S.revealFlash = true;
        bringIntoView(el);
        paintFlash();
        clearTimeout(S.flashTimer);
        S.flashTimer = setTimeout(() => { S.flashEl = null; clearBand('arrive'); }, 1600);
        return true;
    };
    function paintFlash() {
        if (!S.flashEl) return;
        const r = paintBand('arrive', S.flashEl);
        if (r && S.revealFlash) { S.revealFlash = false; revealRange(r); }
    }

    /** A range over [s, e) of block i's raw text, if its page is drawn (marks' highlights). */
    window.tzPdfBlockRange = function (i, s, e) {
        const el = blocks()[i];
        if (!el) return null;
        const a = +el.dataset.pdfStart;
        return rangeOnPage(+el.dataset.pdfPage, a + (s || 0), a + (e == null ? el.__pdfRaw.length : e));
    };
    /** The page (1-based) a block is on, for "p N" in the Marks pane. */
    window.tzPdfBlockPage = function (i) {
        const el = blocks()[i];
        return el ? +el.dataset.pdfPage + 1 : 0;
    };
    /** Block and offsets into its raw text of the current selection, for a highlight mark. */
    window.tzPdfSelectionSpan = function () {
        const sel = window.getSelection();
        if (!S.active || !sel || sel.isCollapsed || !sel.rangeCount) return null;
        const r = sel.getRangeAt(0);
        const a = pointOnPage(r.startContainer, r.startOffset);
        const b = pointOnPage(r.endContainer, r.endOffset);
        if (!a) return null;
        const i = blockIndexAt(a.page, a.off);
        const el = blocks()[i];
        if (!el) return null;
        const start = +el.dataset.pdfStart, end = +el.dataset.pdfEnd;
        // A highlight stays inside one paragraph, as it does in a document.
        const s = Math.max(0, a.off - start);
        const e = (b && b.page === a.page) ? Math.min(end, b.off) - start : end - start;
        if (e <= s) return null;
        return { block: i, s: s, e: e, text: el.__pdfRaw.slice(s, e) };
    };
    /** Raw text of every block, for marks' fingerprints. */
    window.tzPdfBlockRaws = function () { return blocks().map(el => el.__pdfRaw); };

    // ---- Text in scanned pages (Phase 3) ------------------------------------------------
    //
    // A page whose text has no letters or digits is a picture of a page. Once the PDF's
    // text is in, such pages are drawn from the export's kind of private copy of the
    // document and sent to the host, which asks Windows' text recognition for the words
    // and their boxes (TypoZen_App.cs, HandleOcrRequest; cached per file). The words become
    // the page's text and items -- so Find, Search, Read Aloud and marks see them like any
    // other -- and an invisible word layer (.tzOcrLayer) over the scan, which selection,
    // the popup and every highlight use for that page. On unless View > Read Text in
    // Scanned PDF Pages is turned off.

    let ocrOn = true;
    S.ocrPages = {}; S.ocrBoxes = {}; S.ocrSize = {}; S.ocrRun = 0;

    window.tzPdfSetOcr = function (on) {
        on = !!on;
        if (on === ocrOn) return;
        ocrOn = on;
        if (on) startOcr();
        else { S.ocrRun++; ocrStatus(''); }          // stop; text already read stays
    };

    function ocrStatus(text) { try { postMsg('pdf_ocr_status:' + text); } catch (e) { } }

    function needsOcr(p) {
        const t = S.pageTexts && S.pageTexts[p];
        return t != null && !S.ocrPages[p] && !/[\p{L}\p{N}]/u.test(t);
    }

    /**
     * Page p (0-based) of `doc` as a JPEG for recognition, turned clockwise by `rot` degrees:
     * about 2600 px on its long side, at most 300 DPI.
     */
    async function ocrImage(doc, p, rot) {
        const page = await doc.getPage(p + 1);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(300 / 72, 2600 / Math.max(vp1.width, vp1.height));
        const vp = page.getViewport({ scale, rotation: (page.rotate + (rot || 0)) % 360 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
        const bytes = await canvasBytes(canvas, true, 92);
        canvas.width = canvas.height = 0;
        try { page.cleanup(); } catch (e) { }
        return { bytes, w: vp1.width, h: vp1.height };
    }

    /**
     * How much of what came back is words: letters in words of three letters or more, out of
     * all letters. A page read sideways comes back as "00 on o o"; a real page mostly as words.
     */
    function ocrScore(data) {
        let all = 0, good = 0;
        for (const line of (data && data.lines) || []) for (const w of line) {
            const t = String(w[0]);
            const letters = (t.match(/\p{L}/gu) || []).length;
            all += letters;
            const bare = t.replace(/^[("“‘'\[]+/u, '').replace(/[.,;:!?)"”’'\]]+$/u, '');
            if (letters >= 3 && /^\p{L}[\p{L}'’-]*\p{L}$/u.test(bare)) good += letters;
        }
        return { all, good, ratio: all ? good / all : 0 };
    }

    /**
     * The host's words and boxes as page p's text, items and word layer. Boxes are in the
     * picture the host read, which was the page turned by data.rot degrees; they are mapped
     * back onto the page, and each word keeps that turn so it lies along the printed line.
     */
    function applyOcr(p, data, wPt, hPt) {
        const rot = ((data.rot || 0) % 360 + 360) % 360;
        const sideways = rot === 90 || rot === 270;
        const Wr = sideways ? hPt : wPt, Hr = sideways ? wPt : hPt;   // the turned page, in points
        const k = Wr / data.w;
        // A point in the turned picture -> the same point on the page as it is drawn.
        const back = (u, v) => rot === 90 ? [v, hPt - u] : rot === 180 ? [wPt - u, hPt - v] : rot === 270 ? [wPt - v, u] : [u, v];
        const lines = (data.lines || []).filter(l => l && l.length);
        // One height per line, the page's usual one unless the line is clearly bigger (a
        // heading): word boxes vary with ascenders and descenders, and paragraphs split
        // on changes of height (paragraphSpans).
        const heights = lines.map(l => Math.max(...l.map(w => w[2] + w[4])) - Math.min(...l.map(w => w[2]))).sort((a, b) => a - b);
        const median = heights.length ? heights[heights.length >> 1] : 10;
        let text = '';
        const items = [], boxes = [];
        lines.forEach((line, li) => {
            if (li) text += '\n';
            const top = Math.min(...line.map(w => w[2])), bottom = Math.max(...line.map(w => w[2] + w[4]));
            const lh = (bottom - top) > 1.4 * median ? (bottom - top) : median;
            line.forEach((w, wi) => {
                if (wi) text += ' ';
                const t = String(w[0]);
                // Paragraphs are worked out in the turned picture's frame, where lines run across.
                items.push({ start: text.length, len: t.length, y: Hr - bottom * k, h: lh * k, x: w[1] * k, w: w[3] * k });
                const [x, y] = back(w[1] * k, w[2] * k);
                boxes.push({ t, x, y, w: w[3] * k, h: w[4] * k, rot, eol: wi === line.length - 1 });
                text += t;
            });
        });
        S.pageTexts[p] = text;
        S.pageItems[p] = items;
        S.ocrBoxes[p] = boxes;
        S.ocrSize[p] = { w: wPt, h: hPt };
        S.ocrPages[p] = true;
        paintOcrLayer(p);
    }

    let measureCtx = null;
    /** The invisible words over a scanned page, each stretched to its box like PDF.js's own text layer. */
    function paintOcrLayer(p) {
        const boxes = S.ocrBoxes[p], size = S.ocrSize[p];
        const pageEl = document.querySelector('#pdfView .page[data-page-number="' + (p + 1) + '"]');
        if (!boxes || !size || !pageEl) return;
        const old = pageEl.querySelector('.tzOcrLayer');
        if (old) old.remove();
        if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
        measureCtx.font = '100px sans-serif';
        const layer = document.createElement('div');
        layer.className = 'tzOcrLayer';
        for (const b of boxes) {
            const span = document.createElement('span');
            // The trailing space makes a copied selection read as words; the highlight
            // offsets never reach it (one span per word, as rangeOnPage counts them).
            span.textContent = b.t + (b.eol ? '' : ' ');
            span.style.left = (b.x / size.w * 100) + '%';
            span.style.top = (b.y / size.h * 100) + '%';
            span.style.fontSize = 'calc(var(--total-scale-factor, 1) * ' + b.h.toFixed(2) + 'px)';
            const natural = measureCtx.measureText(b.t).width * b.h / 100;
            const turn = b.rot ? 'rotate(' + (-b.rot) + 'deg) ' : '';
            if (natural > 0) span.style.transform = turn + 'scaleX(' + (b.w / natural).toFixed(4) + ')';
            else if (turn) span.style.transform = turn;
            layer.appendChild(span);
            if (b.eol) layer.appendChild(document.createElement('br'));
        }
        pageEl.appendChild(layer);
    }

    async function startOcr() {
        if (!ocrOn || !S.active || !S.doc || !S.pageTexts || !S.url) return;
        const n = S.pageTexts.length;
        const cur = (S.viewer ? S.viewer.currentPageNumber : 1) - 1;
        const todo = [];
        for (let i = 0; i < n; i++) { const p = (cur + i) % n; if (needsOcr(p)) todo.push(p); }
        if (!todo.length) return;
        const run = ++S.ocrRun, seq = S.seq, url = S.url, password = S.password;
        const alive = () => run === S.ocrRun && seq === S.seq && S.active;
        const base = 'https://localpdf/ocr/' + url.slice('https://localpdf/'.length).split('/')[0] + '/';
        let task = null, doc = null, done = 0, failed = 0, fromCache = 0;
        S.ocrStats = { todo: todo.length, done: 0, failed: 0, fromCache: 0, ms: [], finished: false };
        try {
            for (const p of todo) {
                if (!alive()) return;
                ocrStatus('Reading scanned pages: ' + (done + 1) + ' of ' + todo.length);
                const t0 = performance.now();
                try {
                    let data = null;
                    const res = await fetch(base + (p + 1));
                    if (res.ok) { data = await res.json(); fromCache++; }
                    else if (res.status !== 404) throw new Error('status ' + res.status);
                    else {
                        if (!doc) {
                            task = S.lib.getDocument({
                                url, password: password || undefined,
                                cMapUrl: BASE + 'cmaps/', cMapPacked: true, standardFontDataUrl: BASE + 'standard_fonts/',
                                wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/', isEvalSupported: false, enableXfa: false
                            });
                            doc = await task.promise;
                        }
                        // Upright first; a page that does not read as words is tried turned --
                        // scans are often sideways or upside down -- and the best kept.
                        let best = null, bestScore = null;
                        for (const rot of [0, 90, 270, 180]) {
                            const img = await ocrImage(doc, p, rot);
                            if (!alive()) return;
                            const r = await fetch(base + (p + 1) + '/recognize', { method: 'POST', body: img.bytes.buffer });
                            const got = await r.json().catch(() => null);
                            if (r.status === 503) {
                                ocrStatus('Scanned pages cannot be read: Windows has no text recognition language installed');
                                S.ocrStats.error = 'no-language';
                                return;
                            }
                            if (!r.ok || !got) throw new Error((got && got.error) || ('status ' + r.status));
                            got.rot = rot;
                            const sc = ocrScore(got);
                            if (!bestScore || sc.good > bestScore.good) { best = got; bestScore = sc; }
                            if (sc.ratio >= 0.6 && sc.good >= 6) break;
                        }
                        // Nothing that reads as words (a photograph, a blank page): no text, so
                        // a search or a voice never meets "00 on o o".
                        if (!bestScore || bestScore.good < 3 || bestScore.ratio < 0.3) best = { w: best ? best.w : 1, h: best ? best.h : 1, rot: 0, lines: [], empty: true };
                        data = best;
                        try { await fetch(base + (p + 1) + '/save', { method: 'POST', body: JSON.stringify(data) }); } catch (e) { }
                    }
                    if (!alive()) return;
                    const vp = (await S.doc.getPage(p + 1)).getViewport({ scale: 1 });
                    applyOcr(p, data, vp.width, vp.height);
                    rebuildHaystack();
                    refreshStats();
                    try {
                        if (typeof findState !== 'undefined' && findState.query && typeof runFind === 'function')
                            runFind(findState.query, true, { navigate: false });
                    } catch (e) { }
                } catch (e) {
                    failed++;
                    (window.__tzOcrTrace = window.__tzOcrTrace || []).push('p' + (p + 1) + ': ' + (e && e.message || e));
                }
                done++;
                S.ocrStats.done = done; S.ocrStats.failed = failed; S.ocrStats.fromCache = fromCache;
                S.ocrStats.ms.push(Math.round(performance.now() - t0));
            }
            // Marks made on recognised text find their paragraphs now it is all here.
            try { if (typeof window.tzPdfMarksResolve === 'function') window.tzPdfMarksResolve(); } catch (e) { }
            ocrStatus(failed ? failed + (failed === 1 ? ' scanned page' : ' scanned pages') + ' could not be read' : '');
        } finally {
            if (S.ocrStats) S.ocrStats.finished = true;
            try { if (task) await task.destroy(); } catch (e) { }
        }
    }

    /** For tests: how recognition went. */
    window.tzPdfOcrState = function () {
        return Object.assign({ pages: Object.keys(S.ocrPages).map(k => +k + 1) }, S.ocrStats || {});
    };

    // ---- Annotating and filling in, and saving back to a file (Phase 4) -----------------
    //
    // PDF.js's own annotation editor, switched by Edit > Annotate PDF in the host: highlight,
    // text, drawing and pictures; form fields are filled in place (annotationMode
    // ENABLE_FORMS). What changes is held by the document's annotationStorage until saved;
    // saveDocument() writes the PDF with it all in. The host decides where a save goes and
    // receives the bytes as a POST to https://localpdf/write/<job> (TypoZen_App.cs,
    // SavePdfTab / StashActivePdf).

    const EDIT_MODES = { none: 0, text: 3, highlight: 9, picture: 13, draw: 15 };
    S.editMode = 'none';

    function watchEdits(doc) {
        try {
            // Unsaved changes: the host marks the tab and guards closing it.
            // (AnnotationStorage keeps its own flag private, so the page keeps one too.)
            doc.annotationStorage.onSetModified = () => { if (S.doc === doc) S.modified = true; try { postMsg('pdf_modified:1'); } catch (e) { } };
            doc.annotationStorage.onResetModified = () => { if (S.doc === doc) S.modified = false; try { postMsg('pdf_modified:0'); } catch (e) { } };
        } catch (e) { }
    }

    /** Edit > Annotate PDF: "highlight", "text", "draw", "picture", or "none" to read again. */
    window.tzPdfEditMode = function (name) {
        const v = S.viewer;
        if (!S.active || !v) return;
        const mode = EDIT_MODES[name] != null ? EDIT_MODES[name] : 0;
        S.editMode = mode ? name : 'none';
        window.tzPdfEditing = !!mode;
        try { if (typeof hideSelPop === 'function') hideSelPop(); } catch (e) { }
        try { v.annotationEditorMode = { mode }; } catch (e) { }
        if (name === 'picture') {
            // A picture is placed at once: PDF.js asks for the image file itself.
            const add = () => { try { S.eventBus.dispatch('switchannotationeditorparams', { source: null, type: 2 /* CREATE */, value: true }); } catch (e) { } };
            const once = (ev) => { if (ev && ev.mode === mode) { S.eventBus.off('annotationeditormodechanged', once); add(); } };
            S.eventBus.on('annotationeditormodechanged', once);
        }
        try { postMsg('pdf_edit_mode:' + S.editMode); } catch (e) { }
    };

    /** Undo, redo, delete, selectAll in the annotation editor (Edit menu). */
    window.tzPdfEditAction = function (name) {
        try { S.eventBus.dispatch('editingaction', { source: null, name }); } catch (e) { }
    };

    /**
     * Write the PDF with its changes to the host at `url`. The host polls window.__tzPdfSave
     * ('busy', 'ok' or 'error:...') while it waits, so a save is synchronous for it.
     */
    window.tzPdfSaveTo = async function (url) {
        window.__tzPdfSave = 'busy';
        try {
            if (!S.active || !S.doc) throw new Error('the PDF is not open');
            await commitEdits();
            const bytes = await S.doc.saveDocument();
            const res = await fetch(url, { method: 'POST', body: bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer });
            if (!res.ok) throw new Error('the host refused it (' + res.status + ')');
            // "ok-clean": written, but nothing had changed after all (a tool picked up and
            // put down) -- the host need not keep it as unsaved work.
            window.__tzPdfSave = (S.modified || S.editedCopy) ? 'ok' : 'ok-clean';
        } catch (e) {
            window.__tzPdfSave = 'error:' + (e && e.message ? e.message : e);
        }
    };

    /**
     * Finish whatever is being edited, so it is in the document: a text box being typed in
     * is committed by losing focus, and a drawing only becomes an annotation when its
     * drawing session ends -- which is when the tool is put down.
     */
    async function commitEdits() {
        try { const ae = document.activeElement; if (ae && document.getElementById('pdfView').contains(ae)) ae.blur(); } catch (e) { }
        if (S.editMode !== 'none' && S.viewer && S.eventBus) {
            await new Promise((resolve) => {
                const t = setTimeout(done, 2000);
                function done() { clearTimeout(t); try { S.eventBus.off('annotationeditormodechanged', once); } catch (e) { } resolve(); }
                function once(ev) { if (ev && ev.mode === 0) done(); }
                S.eventBus.on('annotationeditormodechanged', once);
                try { S.viewer.annotationEditorMode = { mode: 0 }; } catch (e) { done(); }
            });
        }
        await new Promise(r => setTimeout(r, 30));
    }

    /**
     * For the host before any tab change: is there anything that must be kept? Changes made,
     * a copy carrying unsaved ones, or a tool in hand whose work may not be committed yet.
     */
    window.tzPdfPending = function () {
        if (!S.active || !S.doc) return '0';
        return (S.modified || S.editedCopy || S.editMode !== 'none') ? '1' : '0';
    };

    // A stroke drawn is a change straight away, though PDF.js only commits the drawing when
    // the tool is put down: otherwise Save stayed greyed after drawing.
    try {
        document.addEventListener('pointerup', (e) => {
            if (S.active && S.editMode === 'draw' && e.target && e.target.closest && e.target.closest('#pdfView')) {
                try { postMsg('pdf_modified:1'); } catch (x) { }
            }
        }, true);
    } catch (e) { }

    /** Saved to a file: the PDF on screen is now that file, with nothing unsaved. */
    window.tzPdfSaved = function (url) {
        if (url) S.url = url;
        S.editedCopy = false;
        try { S.doc.annotationStorage.resetModified(); } catch (e) { }
    };

    // ---- Saving pages and pictures as images (Phase 2b) ---------------------------------
    //
    // The host asks (pdf_export_ask:<kind>), shows its dialog with what the page answers,
    // and sends a job (pdf_export_run:<json>). The page does the work one page at a time and
    // hands each file to the host as a POST to https://localpdf/export/<job>/<name> --
    // binary, not base64 across the message bridge -- and the host writes it into the folder
    // the reader chose. Always the PDF's own colours, never the theme's.

    const exportJobs = {};

    function pad(n, width) { return String(n).padStart(width, '0'); }

    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
        return t;
    })();
    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    /**
     * The resolution written into the file, so a 300 DPI page opens at its paper size in a
     * word processor rather than at 96 DPI and three times too big. PNG: a pHYs chunk
     * (replaced if the encoder wrote one); JPEG: the JFIF header's density.
     */
    function withDpi(bytes, dpi, jpeg) {
        if (jpeg) {
            if (bytes[2] === 0xFF && bytes[3] === 0xE0 && String.fromCharCode(...bytes.subarray(6, 10)) === 'JFIF') {
                bytes[13] = 1;
                bytes[14] = dpi >> 8; bytes[15] = dpi & 255;
                bytes[16] = dpi >> 8; bytes[17] = dpi & 255;
            }
            return bytes;
        }
        const ppm = Math.round(dpi / 0.0254);
        const chunk = new Uint8Array(21);
        const dv = new DataView(chunk.buffer);
        dv.setUint32(0, 9);
        chunk.set([0x70, 0x48, 0x59, 0x73], 4);            // pHYs
        dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
        dv.setUint32(17, crc32(chunk.subarray(4, 17)));
        let at = 8;
        while (at + 8 <= bytes.length) {
            const len = new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(0);
            const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
            if (type === 'pHYs') { const out = bytes.slice(); out.set(chunk, at); return out; }
            if (type === 'IDAT') break;
            at += 12 + len;
        }
        const out = new Uint8Array(bytes.length + 21);
        out.set(bytes.subarray(0, at)); out.set(chunk, at); out.set(bytes.subarray(at), at + 21);
        return out;
    }

    function canvasBytes(canvas, jpeg, quality) {
        return new Promise((resolve) => canvas.toBlob(async (b) => {
            resolve(b ? new Uint8Array(await b.arrayBuffer()) : null);
        }, jpeg ? 'image/jpeg' : 'image/png', jpeg ? quality / 100 : undefined));
    }

    /** Hand one file to the host. Throws if it did not take it. */
    async function upload(job, rel, bytes) {
        const res = await fetch(PdfExportBase + encodeURIComponent(job) + '/' + rel.split('/').map(encodeURIComponent).join('/'),
            { method: 'POST', body: bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer });
        if (!res.ok) throw new Error('the host refused ' + rel + ' (' + res.status + ')');
    }
    const PdfExportBase = 'https://localpdf/export/';

    /** Page p (1-based) drawn at `dpi`, as PNG or JPEG bytes. Very large pages are drawn smaller. */
    async function renderPage(doc, p, dpi, jpeg, quality) {
        const page = await doc.getPage(p);
        let scale = dpi / 72;
        let vp = page.getViewport({ scale });
        // A browser canvas has limits (about 16,384 px a side); an A0 poster at 600 DPI is past
        // them. Such a page is drawn at the largest size that fits, and the result says so.
        const k = Math.min(1, 16000 / vp.width, 16000 / vp.height, Math.sqrt(180e6 / (vp.width * vp.height)));
        if (k < 1) { scale *= k; vp = page.getViewport({ scale }); }
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
        let bytes = await canvasBytes(canvas, jpeg, quality);
        canvas.width = canvas.height = 0;
        try { page.cleanup(); } catch (e) { }
        if (!bytes) throw new Error('page ' + p + ' could not be encoded');
        bytes = withDpi(bytes, Math.round(scale * 72), jpeg);
        return { bytes, reduced: k < 1 };
    }

    // -- Pictures ------------------------------------------------------------------------

    /**
     * JPEG pictures, found in the file itself so they can be saved with their original bytes
     * (PDF.js hands over decoded pixels only). A picture stored as a JPEG is a stream object
     * with /Filter /DCTDecode; streams are never inside compressed object streams, so a byte
     * scan finds them all. Skipped: encrypted files (their streams are enciphered), a JPEG with
     * a further filter, a soft mask (the transparency would be lost) or a /Decode array.
     */
    function findJpegStreams(data) {
        const out = [];
        const n = data.length;
        const DCT = [0x2F, 0x44, 0x43, 0x54, 0x44, 0x65, 0x63, 0x6F, 0x64, 0x65];   // /DCTDecode
        const text = (a, b) => { let s = ''; for (let i = a; i < b && i < n; i++) s += String.fromCharCode(data[i]); return s; };
        const find = (pat, from, back) => {
            if (back) {
                for (let i = from; i >= 0; i--) { let k = 0; while (k < pat.length && data[i + k] === pat[k]) k++; if (k === pat.length) return i; }
            } else {
                for (let i = from; i <= n - pat.length; i++) { let k = 0; while (k < pat.length && data[i + k] === pat[k]) k++; if (k === pat.length) return i; }
            }
            return -1;
        };
        const bytesOf = (s) => Array.from(s, ch => ch.charCodeAt(0));
        const OBJ = bytesOf(' obj'), STREAM = bytesOf('stream'), ENDSTREAM = bytesOf('endstream');
        let at = 0;
        while ((at = find(DCT, at, false)) >= 0) {
            const objAt = find(OBJ, at, true);
            const streamAt = find(STREAM, at, false);
            if (objAt < 0 || streamAt < 0 || streamAt - objAt > 4000) { at += DCT.length; continue; }
            const dict = text(objAt, streamAt);
            at = streamAt;
            if (!/\/Subtype\s*\/Image/.test(dict)) continue;
            if (/\/SMask|\/Decode\s*\[|\/Filter\s*\[[^\]]*\/(Flate|LZW|ASCII|RunLength)|\/DeviceCMYK|\/Indexed/.test(dict)) continue;
            const w = +(dict.match(/\/Width\s+(\d+)/) || [])[1];
            const h = +(dict.match(/\/Height\s+(\d+)/) || [])[1];
            let start = streamAt + STREAM.length;
            if (data[start] === 0x0D) start++;
            if (data[start] === 0x0A) start++;
            const end = find(ENDSTREAM, start, false);
            if (!w || !h || end < 0) continue;
            let stop = end;
            while (stop > start && data[stop - 1] !== 0xD9) stop--;          // trailing end-of-line
            if (data[start] !== 0xFF || data[start + 1] !== 0xD8) continue;
            out.push({ w, h, bytes: data.subarray(start, stop) });
            at = end;
        }
        return out;
    }

    /** Wait for a PDF.js object (a picture) to arrive on the main thread. */
    function objectOf(store, id) {
        return new Promise((resolve) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 10000);
            try { store.get(id, (o) => { if (!done) { done = true; clearTimeout(t); resolve(o); } }); }
            catch (e) { clearTimeout(t); resolve(null); }
        });
    }

    /** A decoded PDF.js picture on a canvas, whatever form it came in. */
    function pictureCanvas(img) {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (img.bitmap) { ctx.drawImage(img.bitmap, 0, 0); return c; }
        if (!img.data) return null;
        const d = ctx.createImageData(img.width, img.height);
        const src = img.data, dst = d.data, px = img.width * img.height;
        const K = S.lib.ImageKind || { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 };
        if (img.kind === K.RGBA_32BPP) dst.set(src.subarray(0, px * 4));
        else if (img.kind === K.RGB_24BPP) {
            for (let i = 0, j = 0; i < px; i++, j += 3) { dst[i * 4] = src[j]; dst[i * 4 + 1] = src[j + 1]; dst[i * 4 + 2] = src[j + 2]; dst[i * 4 + 3] = 255; }
        } else if (img.kind === K.GRAYSCALE_1BPP) {
            const row = (img.width + 7) >> 3;
            for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
                const v = (src[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
                const i = (y * img.width + x) * 4; dst[i] = dst[i + 1] = dst[i + 2] = v; dst[i + 3] = 255;
            }
        } else return null;
        ctx.putImageData(d, 0, 0);
        return c;
    }

    /**
     * Whether a JPEG from the file is this picture: decode it and compare pixels on a grid.
     * Size alone is not enough -- a document can hold several photos the same size -- and a
     * wrong match would save the wrong picture under this one's name.
     */
    async function sameAsJpeg(canvas, jpegBytes) {
        let bmp;
        try { bmp = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' })); } catch (e) { return false; }
        if (bmp.width !== canvas.width || bmp.height !== canvas.height) { bmp.close(); return false; }
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0); bmp.close();
        const a = canvas.getContext('2d', { willReadFrequently: true });
        let far = 0, n = 0;
        for (let gy = 1; gy < 8; gy++) for (let gx = 1; gx < 8; gx++) {
            const x = Math.floor(gx * c.width / 8), y = Math.floor(gy * c.height / 8);
            const p = ctx.getImageData(x, y, 1, 1).data, q = a.getImageData(x, y, 1, 1).data;
            n++;
            if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 30) far++;
        }
        c.width = c.height = 0;
        return far <= Math.floor(n / 10);
    }

    async function sha(bytes) {
        const h = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
    }

    /** Every picture page p (1-based) draws: [{ id, img }] in drawing order. */
    async function picturesOn(doc, p) {
        const page = await doc.getPage(p);
        const ops = await page.getOperatorList();
        const OPS = S.lib.OPS;
        const list = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
            const fn = ops.fnArray[i];
            if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
                const id = ops.argsArray[i][0];
                // Pictures used on more than one page are shared ("g_" ids), and held by the
                // page proxy's commonObjs -- the document proxy has none.
                const store = String(id).startsWith('g_') ? page.commonObjs : page.objs;
                const img = await objectOf(store, id);
                list.push({ id: String(id), img });
            } else if (fn === OPS.paintInlineImageXObject) {
                const img = ops.argsArray[i][0];
                if (img && img.width) list.push({ id: 'inline-' + p + '-' + i, img });
            }
        }
        return { page, list };
    }

    async function runExport(job) {
        const state = exportJobs[job.job] = { cancelled: false };
        const url = S.url, password = S.password, pages = S.doc ? S.doc.numPages : 1;
        const base = String(job.base || 'PDF').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'PDF';
        const width = Math.max(3, String(pages).length);
        const result = { job: job.job, kind: job.kind, files: 0, small: 0, repeats: 0, originals: 0, unreadable: 0, reduced: 0, error: '', cancelled: false };
        const report = (done) => { try { postMsg('pdf_export_progress:' + job.job + '|' + done + '|' + job.pages.length + '|' + result.files); } catch (e) { } };
        // The export reads its own copy of the document, never the viewer's. Cleaning up the
        // viewer's pages after each one threw away pictures it still had cached, and the next
        // export then waited on objects that never came (runs 2, 4 and 5 of the suite came
        // back empty). Its own copy can be cleaned page by page and destroyed at the end, so a
        // long export does not hold every page's pictures in memory either.
        let task = null, doc = null;
        try {
            if (!S.active || !url) throw new Error('the PDF is no longer open');
            task = S.lib.getDocument({
                url, password: password || undefined,
                cMapUrl: BASE + 'cmaps/', cMapPacked: true,
                standardFontDataUrl: BASE + 'standard_fonts/',
                wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/',
                isEvalSupported: false, enableXfa: false
            });
            doc = await task.promise;
            const jpeg = job.format === 'jpeg';
            let jpegs = null;
            const seenIds = new Set(), seenHashes = new Set();
            let done = 0;
            report(0);
            for (const p of job.pages) {
                if (state.cancelled || S.url !== url) { result.cancelled = true; break; }
                if (job.kind === 'pages') {
                    const r = await renderPage(doc, p, job.dpi, jpeg, job.quality);
                    if (state.cancelled || S.url !== url) { result.cancelled = true; break; }
                    await upload(job.job, base + ' - p' + pad(p, width) + (jpeg ? '.jpg' : '.png'), r.bytes);
                    result.files++;
                    if (r.reduced) result.reduced++;
                } else {
                    if (!jpegs) {
                        // Only an unencrypted file has its JPEGs readable as they are.
                        const data = await doc.getData();
                        const tail = new TextDecoder('latin1').decode(data.subarray(Math.max(0, data.length - 4096)));
                        const encrypted = /\/Encrypt\s/.test(tail) || !!password;
                        jpegs = encrypted ? [] : findJpegStreams(data);
                    }
                    const { page, list } = await picturesOn(doc, p);
                    // job.only: the host read this PDF's pictures itself (PdfPictures.cs) and
                    // left these to the viewer -- by size, or every picture on a page it could
                    // not read -- numbered on after the ones it saved. A page holding two
                    // pictures of one size, one saved by the host and one not, can get the
                    // wrong one of the two; sizes are all the two readers have in common.
                    const want = job.only ? job.only[String(p)] : null;
                    let k = want && want.start ? want.start : 0;
                    for (const { id, img } of list) {
                        if (state.cancelled) break;
                        if (want && !want.all) {
                            const at = img ? want.sizes.findIndex(s => s[0] === img.width && s[1] === img.height) : -1;
                            if (at < 0) continue;
                            want.sizes.splice(at, 1);
                        }
                        // A picture that cannot be read is counted and reported, never dropped
                        // silently; the reasons go to the page for diagnosis.
                        const unreadable = (why) => { result.unreadable++; (window.__tzExportTrace = window.__tzExportTrace || []).push('p' + p + ' ' + id + ': ' + why); };
                        if (!img) { unreadable('no picture object'); continue; }
                        if (job.skipSmall && (img.width < 32 || img.height < 32)) { result.small++; continue; }
                        if (job.dedupe && seenIds.has(id)) { result.repeats++; continue; }
                        seenIds.add(id);
                        let canvas = null;
                        try { canvas = pictureCanvas(img); } catch (e) { unreadable(String(e && e.message || e)); continue; }
                        if (!canvas) { unreadable('unknown picture format (kind ' + img.kind + ')'); continue; }
                        let bytes = null, ext = '.png';
                        for (const c of jpegs) {
                            if (c.w === img.width && c.h === img.height && await sameAsJpeg(canvas, c.bytes)) { bytes = c.bytes; ext = '.jpg'; break; }
                        }
                        if (bytes) result.originals++;
                        else bytes = await canvasBytes(canvas, false);
                        canvas.width = canvas.height = 0;
                        if (!bytes) { unreadable('could not be encoded'); continue; }
                        if (job.dedupe) {
                            const h = await sha(bytes);
                            if (seenHashes.has(h)) { result.repeats++; continue; }
                            seenHashes.add(h);
                        }
                        k++;
                        const name = base + ' - p' + pad(p, width) + ' - img' + pad(k, 2) + ext;
                        await upload(job.job, job.perPage ? 'p' + pad(p, width) + '/' + name : name, bytes);
                        result.files++;
                    }
                    try { page.cleanup(); } catch (e) { }
                }
                done++;
                report(done);
            }
        } catch (err) {
            result.error = String(err && err.message ? err.message : err);
        } finally {
            try { if (task) await task.destroy(); } catch (e) { }
            delete exportJobs[job.job];
            try { postMsg('pdf_export_done:' + JSON.stringify(result)); } catch (e) { }
        }
    }

    /** The host's dialog needs the page count, where the reader is, and page 1's size. */
    window.tzPdfExportAsk = async function (kind) {
        const info = { kind: kind, pages: 0, page: 1, w: 0, h: 0 };
        try {
            if (S.active && S.doc) {
                info.pages = S.doc.numPages;
                info.page = S.viewer ? S.viewer.currentPageNumber : 1;
                const vp = (await S.doc.getPage(1)).getViewport({ scale: 1 });
                info.w = vp.width; info.h = vp.height;
            }
        } catch (e) { }
        try { postMsg('pdf_export_info:' + JSON.stringify(info)); } catch (e) { }
    };
    window.tzPdfExportRun = function (json) {
        let job = null;
        try { job = JSON.parse(json); } catch (e) { return; }
        if (!job || !job.job || !Array.isArray(job.pages)) return;
        runExport(job);
    };
    window.tzPdfExportCancel = function (id) { if (exportJobs[id]) exportJobs[id].cancelled = true; };

    // ---- Outline, for the sidebar -------------------------------------------------------

    window.tzPdfOutline = function (list) {
        if (!list) return 0;
        list.innerHTML = '';
        let n = 0;
        function add(items, level) {
            for (const it of items || []) {
                if (!it || !it.title) continue;
                n++;
                const row = document.createElement('div');
                row.className = 'outline-item outline-h' + Math.min(6, level);
                row.innerText = it.title;
                row.onclick = function () {
                    try { if (it.dest) S.linkService.goToDestination(it.dest); } catch (e) { }
                };
                list.appendChild(row);
                add(it.items, level + 1);
            }
        }
        add(S.outline, 1);
        if (!n) {
            const none = document.createElement('div');
            none.className = 'outline-empty';
            none.innerText = 'This PDF has no outline.';
            list.appendChild(none);
        }
        return n;
    };
})();
