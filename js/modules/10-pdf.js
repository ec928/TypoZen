/**
 * PDFs, read in the editor page with PDF.js (docs/pdf-and-audit-plan.md, Phase 1).
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
    }

    function teardown() {
        clearTimeout(S.reportTimer);
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
        S.pageTexts = S.pageItems = S.pageStarts = S.outline = null;
        S.haystack = '';
        S.findMatches = [];
        S.pendingReveal = false;
        S.blocks = null; S.blocksKey = ''; S.readEl = null; S.flashEl = null; S.textReady = false;
        try { CSS.highlights.delete('typozen-find'); CSS.highlights.delete('typozen-find-current'); } catch (e) { }
        try { CSS.highlights.delete('typozen-tts'); CSS.highlights.delete('typozen-pdf-flash'); } catch (e) { }
        const host = document.getElementById('pdfView');
        if (host) host.innerHTML = '';
    }

    /**
     * The status bar on a PDF: words and characters of its text, and the page in place of
     * the line (07-stats-host.js asks for this while a PDF is on screen).
     */
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
            page: S.viewer.currentPageNumber || 1,
            pages: S.viewer.pagesCount || 0
        };
    };
    function refreshStats() {
        try { if (typeof updateStats === 'function') updateStats(); } catch (e) { }
    }

    /** Where the reader is, for the host to reopen the PDF there. Debounced like books. */
    function reportPage(page) {
        refreshStats();
        clearTimeout(S.reportTimer);
        const gen = window.__docGen || 0;
        S.reportTimer = setTimeout(() => {
            try { postMsg('book_position:' + page + '|gen=' + gen); } catch (e) { }
        }, 800);
    }

    window.tzOpenPdf = async function (url, page) {
        const seq = ++S.seq;
        try {
            await ensureLib();
            if (seq !== S.seq) return;
            teardown();
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
                annotationMode: lib.AnnotationMode.ENABLE_FORMS,
                removePageBorders: false
            });
            linkService.setViewer(viewer);
            Object.assign(S, { eventBus, linkService, findController, viewer, url });

            eventBus.on('scalechanging', (ev) => { if (seq === S.seq) postZoom(ev && ev.scale); });
            eventBus.on('pagesinit', () => {
                applyView();
                if (page > 1) viewer.currentPageNumber = Math.min(page, viewer.pagesCount);
                postView();
            });
            eventBus.on('pagechanging', (e) => { if (seq === S.seq) reportPage(e.pageNumber); });
            eventBus.on('textlayerrendered', () => { if (seq === S.seq) onTextLayer(); });

            const task = lib.getDocument({
                url,
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
            viewer.setDocument(doc);
            linkService.setDocument(doc, null);
            try { host.focus({ preventScroll: true }); } catch (e) { }
            try { postMsg('pdf_loaded:' + doc.numPages); } catch (e) { }
            // The sidebar: the PDF's own outline, and its text for Search.
            doc.getOutline().then((o) => {
                if (seq !== S.seq) return;
                S.outline = o || [];
                try { if (typeof updateOutline === 'function') updateOutline(); } catch (e) { }
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
        try {
            v.spreadMode = S.cols === 2 ? ui.SpreadMode.ODD : ui.SpreadMode.NONE;
            v.scrollMode = S.scroll === 'pagination' ? ui.ScrollMode.PAGE : ui.ScrollMode.VERTICAL;
            v.currentScaleValue = (S.scroll === 'pagination' || S.cols === 2) ? 'page-fit' : 'page-width';
        } catch (e) { }
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
    function postZoom(scale) {
        try { postMsg('pdf_zoom:' + Math.round((scale || 1) * 100)); } catch (e) { }
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
            outline: S.outline ? S.outline.length : 0
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
                    // Where it sits (baseline y, font height) is what splits paragraphs.
                    if (str.length) items.push({
                        start: text.length, len: str.length,
                        y: it.transform ? it.transform[5] : 0, h: it.height || 0
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
        const layer = document.querySelector('#pdfView .page[data-page-number="' + (p + 1) + '"] .textLayer');
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
        try { CSS.highlights.delete('typozen-find'); CSS.highlights.delete('typozen-find-current'); } catch (e) { }
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
    // PDF text has lines, not paragraphs. A paragraph ends where the gap to the next line is
    // clearly more than a line's spacing, where the text size changes (a heading), or where
    // the next line is higher on the page (another column or box). Each paragraph is a
    // detached <div class="block"> holding its text, with its page and its span of that
    // page's text on data attributes: Read Aloud (09-speech.js) and marks (02-layout.js)
    // work on blocks, so a PDF hands them these and they need to know little more.

    /** [start, end) spans of page p's text, one per paragraph. */
    function paragraphSpans(p) {
        const text = S.pageTexts && S.pageTexts[p];
        const items = S.pageItems && S.pageItems[p];
        if (!text || !items || !items.length) return [];
        const out = [];
        let start = items[0].start, prev = items[0];
        for (let k = 1; k < items.length; k++) {
            const it = items[k];
            const h = Math.max(prev.h || 0, it.h || 0) || 10;
            if (Math.abs(it.y - prev.y) > 0.5 * h) {                 // a new line
                const gap = prev.y - it.y;                           // PDF y grows upwards
                const resized = prev.h && it.h && Math.abs(prev.h - it.h) > 0.2 * h;
                if (gap > 1.6 * h || gap < -0.5 * h || resized) { out.push([start, it.start]); start = it.start; }
            }
            prev = it;
        }
        out.push([start, text.length]);
        return out;
    }

    /** A paragraph's text as it should be read: lines joined, hyphenated words mended. */
    function readable(raw) {
        return raw.replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').replace(/\s+/g, ' ').trim();
    }

    /** Every paragraph of the PDF, as blocks; the same objects until more text arrives. */
    function blocks() {
        const texts = S.pageTexts || [];
        const key = texts.map(t => (t == null ? '-' : 'y')).join('');
        if (S.blocks && S.blocksKey === key) return S.blocks;
        const list = [];
        for (let p = 0; p < texts.length; p++) {
            for (const [a, b] of paragraphSpans(p)) {
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
        const layer = pageEl && pageEl.querySelector('.textLayer');
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

    /** Index of the block holding a page offset, or the next one on that page. */
    function blockIndexAt(page, off) {
        const list = blocks();
        let next = -1;
        for (let i = 0; i < list.length; i++) {
            const bp = +list[i].dataset.pdfPage;
            if (bp < page) continue;
            if (bp > page) return next >= 0 ? next : i;
            if (off < +list[i].dataset.pdfEnd) return i;
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

    /** The paragraph being read: paint it, and bring it into view (09-speech.js). */
    window.tzPdfReadFocus = function (el) {
        S.readEl = el;
        bringIntoView(el);
        paintRead();
    };
    window.tzPdfReadClear = function () {
        S.readEl = null;
        try { CSS.highlights.delete('typozen-tts'); } catch (e) { }
    };
    function paintRead() {
        const el = S.readEl;
        try { CSS.highlights.delete('typozen-tts'); } catch (e) { }
        if (!el || !window.Highlight) return;
        const r = rangeOnPage(+el.dataset.pdfPage, +el.dataset.pdfStart, +el.dataset.pdfEnd);
        if (!r) return;
        try { CSS.highlights.set('typozen-tts', new Highlight(r)); } catch (e) { }
        if (S.revealRead) { S.revealRead = false; revealRange(r); }
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
        S.flashTimer = setTimeout(() => { S.flashEl = null; try { CSS.highlights.delete('typozen-pdf-flash'); } catch (e) { } }, 1600);
        return true;
    };
    function paintFlash() {
        const el = S.flashEl;
        if (!el || !window.Highlight) return;
        const r = rangeOnPage(+el.dataset.pdfPage, +el.dataset.pdfStart, +el.dataset.pdfEnd);
        if (!r) return;
        try { CSS.highlights.set('typozen-pdf-flash', new Highlight(r)); } catch (e) { }
        if (S.revealFlash) { S.revealFlash = false; revealRange(r); }
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
