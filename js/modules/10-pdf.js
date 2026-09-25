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
        try { if (S.viewer) S.viewer.setDocument(null); } catch (e) { }
        try { if (S.linkService) S.linkService.setDocument(null); } catch (e) { }
        try { if (S.doc) S.doc.destroy(); } catch (e) { }
        S.viewer = S.eventBus = S.linkService = S.findController = S.doc = null;
        S.pageTexts = S.pageItems = S.pageStarts = S.outline = null;
        S.haystack = '';
        S.findMatches = [];
        S.pendingReveal = false;
        try { CSS.highlights.delete('typozen-find'); CSS.highlights.delete('typozen-find-current'); } catch (e) { }
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
            chars: (S.haystack || '').length,
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

            const doc = await lib.getDocument({
                url,
                cMapUrl: BASE + 'cmaps/', cMapPacked: true,
                standardFontDataUrl: BASE + 'standard_fonts/',
                wasmUrl: BASE + 'wasm/',
                iccUrl: BASE + 'iccs/',
                isEvalSupported: false,
                enableXfa: false
            }).promise;
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
                    if (str.length) items.push({ start: text.length, len: str.length });
                    text += str;
                    if (it.hasEOL) text += '\n';
                }
                S.pageTexts[p - 1] = text;
                S.pageItems[p - 1] = items;
            } catch (e) { S.pageTexts[p - 1] = ''; S.pageItems[p - 1] = []; }
        }
        rebuildHaystack();
        refreshStats();
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
        if (!S.findMatches || !S.findMatches.length) return;
        const cur = paintFind();
        if (cur && S.pendingReveal) { S.pendingReveal = false; revealRange(cur); }
    }

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
