# PDF reading and the audit fixes: implementation plan

_Draft for Ed, 25 September 2026. No code written yet. Local only; not tracked._

## Decisions needed before building

| # | Question | Recommendation |
|---|---|---|
Decided with Ed, 25 September 2026:

| # | Question | Decision |
|---|---|---|
| D1 | Does the embedded Edge PDF viewer stay? | **No, not for reading.** Its WebView is kept only to print the original file (Edge prints the PDF's own vector content; PDF.js prints page images). For the rare file PDF.js cannot handle, **File > Open in default PDF app** hands it to whatever Windows opens PDFs with. |
| D2 | Annotation editing (highlight, ink, text, forms, signature) in scope? | **Yes, Phase 4**, after reading is solid. The one phase that writes a PDF file. |
| D3 | OCR on by default for pages with no text? | **Yes**, on demand per page, in the OCR languages Windows has installed. |
| D4 | Versions | **Audit fixes ship as 0.5.x; the PDF release is 0.6.0.** |

## Security: PDF.js is ours to keep current

Edge's viewer is patched through Windows Update with the WebView2 runtime; a bundled PDF.js
is frozen at the version shipped. PDF.js has had a crafted-PDF script-execution flaw
(CVE-2024-4367), so:

- pin a recent `pdfjs-dist`, and load it with `isEvalSupported: false`;
- treat Mozilla's PDF.js security releases as a reason to cut a TypoZen release;
- PDFs are untrusted input: the viewer runs in the editor page's sandbox with no host
  messages beyond the ones Phase 1–4 define.

A password-protected PDF needs a small prompt (PDF.js asks through a callback; Edge's viewer
prompted by itself).

## Order of work

1. **Phase 0 — audit fixes and quick wins** (independent of PDF, each small).
2. **Phase 1 — PDF reading core.**
3. **Phase 2 — PDF joins the reader features** (Read Aloud, narration, bookmarks), and
   **Phase 2b — saving pages and pictures as images**, in batches.
4. **Phase 3 — OCR for scanned pages.**
5. **Phase 4 — annotate and fill forms, and save.**
6. **Source-mode syntax colouring** (audit 1.3) and **image paste into untitled** (1.4) fit anywhere after Phase 0.

Option A from the earlier analysis (steering the Edge viewer from TypoZen's menus) is dropped: Phase 1 replaces that viewer.

---

## Phase 0 — audit fixes and quick wins

### 0.1 Bookmarks and reading positions stop being lost (audit 1.2) — first

- Today: `MaxRememberedBooks` and `MaxBookmarkDocs` are both 64, and the write order is "the document just touched, then storage order", so the 65th document evicts an arbitrary one, not the oldest. Bookmarks are the reader's own work.
- Change: a true recency order (touching a document moves it to the front, persisted in file order) and a cap in the thousands (both files are a line per document).
- Risk addressed: silent loss of user data. **Test:** one headless/host-level check that 200 documents with bookmarks all survive a save and reload, and that the least recently touched is what goes when the cap is hit.

### 0.2 Open files by dropping them on the window (audit 1.1)

- Today: dropping a .md, .epub or .pdf on the document does nothing (the page's drop handler takes images only; the navigation guard cancels the file navigation). The audit's fix (WPF `AllowDrop`) cannot work over the document, which belongs to the browser process.
- Change: the page's `drop` handler passes non-image files to the host with `chrome.webview.postMessageWithAdditionalObjects`; the host reads each `CoreWebView2File.Path` and opens it as a tab. Images dropped on a Markdown document keep inserting as today. Drops on the WPF chrome (tab strip) use `AllowDrop` there. The native WebView (images/media tabs) gets the same guard so a drop never navigates it away.
- **Test:** one app check: a dropped .md opens as a tab; a dropped image still inserts.

### 0.3 Help works on every tab (option B)

- Today: Help is greyed on native tabs because its panels live in the hidden editor page.
- Change: Help items bring the editor page forward long enough to show the panel, or About/Syntax become native dialogs. Decide at build time; either is small.
- **Test:** one menu read on an image tab.

### 0.4 A lasting "autosave is off" indicator (audit 1.5)

- Today: one message box on the first unexpected error; nothing afterwards.
- Change: a status-bar item ("Autosave off after an error") while `DocumentStateSuspect` is set. Native WPF, per AGENTS.md rule 1 (no floating HTML).
- **Test:** none automated; a look.

---

## Phase 1 — PDF reading core

### Where it lives

PDF becomes a **read-only document kind inside the editor page**, beside `epub` — not a native tab. That is what gives it the machinery books have: sidebar, search, bookmarks, positions, Read Aloud, themes, and the menu rules built on 2026-09-25 (Copy / Select All / Find / Go to Page live; editing greyed).

- The page uses **PDF.js's own viewer component** (`pdf_viewer` from the `pdfjs-dist` package), not a hand-built renderer: it already renders only the pages in view, keeps a text layer for selection and copy, handles links and the document outline, and has a find controller.
- The PDF file is streamed to the page by the host's `WebResourceRequested` handler at `https://localpdf/<token>/<name>`, a per-open token standing for the path. Nothing is mapped per file: a virtual-host mapping added after the page has navigated never reaches it (docs/for-agents.md), and one PDF can live in any folder.
- `#editor` is hidden while a PDF is shown; the PDF viewer mounts in its place. Tab switching, Privacy Mode and session restore treat it like a book.

### What the reader gets in Phase 1

| Feature | How |
|---|---|
| Theme colours | PDF.js `pageColors: { background, foreground }` from the current theme — pages drawn dark on a dark theme. A per-tab "Original colours" toggle for PDFs whose images or diagrams need the real colours. |
| Remembered page | Page number plus scroll offset, stored beside book positions (same recency rules as 0.1). |
| Outline in the sidebar | `pdfDocument.getOutline()` feeds the existing Outline tab. |
| Find and sidebar search | PDF.js find controller for Ctrl+F; the Search sidebar lists hits across pages from each page's text. |
| Go to Page | Straight to a page number. |
| Zoom / fit | The existing zoom commands drive the viewer's scale. No new controls. |
| Two-page view | The existing column toggle maps to the viewer's spread mode. |
| Print | Prints the **original file** (loaded into the hidden native WebView and printed with `ShowPrintUI`), so print output is exactly the PDF, not a re-render. |
| Menus | PDF is a read-only kind: the book rules apply unchanged. |

### Packaging

- `pdfjs-dist` pinned to one version, shipped offline in `js/vendor/pdfjs/` with its worker, standard fonts and CMaps (a few MB). Nothing fetched at run time.
- Licence: Apache-2.0 — add to `docs/releasing.md` §6 and ship its LICENSE.
- Build scripts (`Build-Portable.ps1`, the installer, `Build-Msix.ps1`) must include the new folder: easy to miss, which is how fonts once went missing.

### Risks and the tests that address them (risk-based, few and cheap)

| Risk | Test |
|---|---|
| A PDF does not open, or shows nothing | Extend `core-smoke-app` with one small PDF fixture: real text painted, page 2 reachable (~3s). |
| The packaged app misses the vendor folder | `packaged-smoke-app` opens the same PDF. |
| Position lost | Reopen lands on the same page (part of the smoke). |
| Privacy Mode leaves a trace | Extend `privacy-app`: no position written for a PDF while private. |

Not tested by automation: zoom steps, spread layout, theme colours — a look by Ed settles each in seconds.

---

## Phase 2 — PDF joins the reader features

- **Read Aloud and Qwen narration.** Text comes from each page's text content, grouped into paragraphs by position (PDF text has no paragraphs of its own); the reading highlight follows the text layer's spans. Narration's render-ahead works per page.
- **Bookmarks and highlights (TypoZen marks).** Anchored to page plus text offset, stored with the existing marks.
- **Word count and reading time** from the text.
- **Risk:** reading order on multi-column pages (academic papers) can interleave columns. Use PDF.js's text order first; measure on two real papers before adding any column detection.
- **Test:** one app check that Read Aloud starts on a PDF page and the highlight moves.

## Phase 2b — Saving images from a PDF

Only possible with PDF.js: the Edge viewer gives TypoZen no access to a page's pixels or a
PDF's embedded pictures. Both actions are batch operations — one command, every page or every
picture — with a progress bar and Cancel, working one page at a time so a 500-page file does
not fill memory. Output uses the PDF's **original colours**, never the dark-theme rendering.

### Save pages as images — File > Save Pages as Images...

- **Format:** PNG or JPEG (JPEG quality setting, default 90).
- **Resolution:** presets 150 DPI (screen / sharing), 300 DPI (print, the default), 600 DPI
  (archival / fine text), plus a custom value. The dialog shows the resulting pixel size of
  page 1, so the choice is concrete.
- **Pages:** all (default), current page, or a range.
- **Where:** a chosen folder; files named `<pdf name> - p001.png` (zero-padded to the page
  count so they sort).

### Save every picture in the PDF — File > Save All Images in PDF...

- Finds every embedded picture on every page (PDF.js operator list: image drawing
  operations), and saves each **at the resolution it is stored at**, not the screen size.
- **JPEG pictures keep their original bytes** (a PDF stores them as JPEG streams), so nothing
  is re-compressed; all other pictures are saved as lossless PNG. Needs raw stream access —
  PDF.js decodes images to pixels, so the original-bytes path uses pdf-lib (MIT) or PDF.js's
  raw stream; confirm which at build time.
- **Skips the clutter:** pictures smaller than 32×32 (icons, bullets, spacer images) are left
  out by default, and a picture repeated on many pages (a logo in the header) is saved once,
  by content hash. Both are options in the dialog.
- Transparency (soft masks) is applied, so a cut-out figure saves as a transparent PNG.
- **Pages:** all (default), current page, or a range — the same choice as page export.
- **Layout:** one folder, files named `<pdf name> - p012 - img03.jpg` (default), or one
  subfolder per page. Several pictures on one page are always separate files.
- **Text is never included:** a PDF stores text and pictures separately, so an extracted
  picture has no page text, captions or headings on it. Text that is part of the picture
  itself (a screenshot, a scan, words in a photo) is pixels and stays.
- **Known limit:** some PDFs store one picture as several strips or tiles; extraction saves
  the pieces. Reassembling them is possible but not planned.
- Right-click on a single picture: **Save Image As...** for one-offs.

### Menus and tests

- Both File items are live only on a PDF tab; greyed elsewhere, like the other kind-specific
  items.
- **Tests (risk-based):** one fixture PDF with known contents — a page export produces the
  right number of files at the right pixel size for the DPI; image extraction finds the
  known pictures, keeps a JPEG byte-for-byte, and skips the icon.

## Phase 3 — OCR for scanned pages

- Detect a page with no text (empty text content).
- Render it to an image in the page, send it to the host, and run **Windows.Media.Ocr** (built into Windows, offline, already reachable: TypoZen references `Windows.winmd` and uses WinRT for its Windows voices).
- Words and their boxes come back and become that page's text layer, so search, copy, Read Aloud and narration work on scans.
- On demand per page, cached per file (keyed by content hash) in the profile. The cache holds document text, so: **Privacy Mode keeps it in the per-session temp folder**, and **Clear Stored Data** gets an "OCR text" line.
- Languages: those installed in Windows (`OcrEngine.TryCreateFromUserProfileLanguages`).
- Limits to state in the UI: handwriting, poor scans, complex layouts.
- **Unmeasured:** speed per page. Measure on one scanned PDF before promising anything.
- **Test:** one scanned-page fixture: OCR text appears and is searchable.

## Phase 4 — annotate, fill forms, save

- PDF.js's annotation editor: highlight, free text, ink, image/stamp, signature; AcroForm filling.
- Save writes a **new file by default** (Save As `name-annotated.pdf`); overwriting the original is an explicit choice, atomic, with the same loss guard documents have. This is the only phase that writes a PDF.
- Page operations (delete, reorder, rotate, merge) would need pdf-lib (MIT) — out of scope unless you want them.
- Menus: in a PDF with the editor active, Save / Save As become live again; Undo/Redo map to the annotation editor's own history.
- **Test:** one app check: add a highlight, save, reopen, the highlight is there.

---

## Separately: Source-mode syntax colouring (audit 1.3)

- Reuse the Source search-highlight mirror (a painted copy of the text behind the transparent textarea) to colour headings, emphasis, code, links, lists and quotes from theme colours.
- Paint only the visible part and repaint after typing pauses briefly, or large documents stutter.
- **Test:** the existing typing-latency measure on an 80 KB document stays clean.

## Separately: image paste into an untitled document (audit 1.4)

- Hold pasted images in a per-tab pending folder in the profile (temp in Privacy Mode), shown through a mapped host; on first Save, move them beside the document and rewrite the links.
- Session restore carries the pending folder; closing the tab without saving discards it.
- **Test:** paste into untitled, save, the image file exists beside the document and the link points at it.
