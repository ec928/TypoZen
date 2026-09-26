# PDF reading and the audit fixes: implementation plan

_Written 25 September 2026. Progress is kept in the next section; update it with each version._

## Progress

| Phase | State | Version |
|---|---|---|
| 0 — audit fixes | **Done.** 0.1 bookmarks/positions kept (LRU, 5000), 0.2 drop to open, 0.3 Help over every tab, 0.4 autosave-off indicator, and 1.4 image paste into untitled. Git tag `baseline-before-pdf` marks the state before Phase 1. | 0.5.8 |
| 1 — PDF reading core | **Done, in testing with Ed.** See below. | 0.6.0, 0.6.1 |
| 2 — reader features | **Done, in testing with Ed.** See below. | 0.6.2 |
| 2b — save as images | **Done, in testing with Ed.** See below. Right-click Save Image As not built. | 0.6.3 |
| 3 — OCR | **Done, in testing with Ed.** See below. | 0.6.4 |
| 4 — annotate, forms | **Done, in testing with Ed.** See below. Signatures and page operations not built. | 0.6.5 |
| Audit 1.3 — Source colouring | **Not now** (Ed, 2026-09-26). Options costed: colour the existing mirror (about a day; colour only, no sizes) or CodeMirror 6 (1-2 weeks: ~280 places treat Source as a textarea). | — |

**Outstanding, to come back to (not PDF-specific):**

- ~~**Look up's speaker uses a different voice from the narrator**~~ (Ed, 2026-09-25). **Done in 0.6.6, then changed in 0.6.8 (Ed):** 0.6.6 had the narrator say the word, which took about 25 seconds when the narrator had to start -- Qwen is for long-form reading only. Now, with the Qwen narrator chosen, the word is said by the quick voice on this computer closest to the narrator: same country and gender, read from the voice's description (`PickWordVoice` in TypoZen_App.cs; local voices only, neural preferred, a Windows voice over Kokoro on a tie). For the built-in narrator that is Microsoft Sonia. Other voices say words in themselves, as before.

**Phase 1 as built, against the plan:**

- Built as planned: outline, Find and Search by page, Go to Page, remembered page, zoom through the existing commands, two-page view on the column toggle, Print of the original file, book menu rules.
- Also built: Pages (one page at a time) on the scroll toggle; status bar word count and Page N/M; File > Open in Default App; refit when the window or sidebar changes size.
- Changed from the plan: theme colours are **opt-in** (View > PDF Pages in Theme Colours) because `pageColors` recolours pictures too. The position is the page only, without a scroll offset. The file is streamed through `WebResourceRequested` rather than a mapped host.
- Tests: `tests/pdf-reader-app.mjs` (26 checks) instead of an extension to core-smoke. `privacy-app` opens a PDF since 0.6.22 and proves against a control that Privacy Mode keeps neither its page nor a recent-files entry (OCR text goes to the private folder too, by `OcrCacheRoot`). **Not done:** `packaged-smoke-app` does not open a PDF.
- Fixed after Ed's first look (0.6.1): the text layer sat about 3% right of and below the ink, so Find's highlight and selections landed on the line below. The cause was the app-wide `box-sizing: border-box`. Also fixed: a fitted page not refitting after the window was maximised or restored (seen as 164% after switching columns), and a PDF with no text showing 22 characters.
- Fixed after Ed's report (0.6.7): a PDF opened once stayed open in TypoZen for the rest of the session, tab closed or not -- WebView2 never disposes the stream it is served from -- so Microsoft Print to PDF could not save over it ("Printing failed"; a new file name worked). It is now served from a stream that closes the file once read (`CloseAtEndFileStream`); pdf-reader-app checks the file can be opened exclusively once loaded.
- Reset Zoom returns to the fit, which at a given window size can read 99% rather than 100%: not rounding, the fitted scale. Since 0.6.23 the status bar says so ("99% (fit)") while the page is fitted. Printing landscape pages rotated them onto portrait pages: the Windows print dialog opens on portrait whatever the document, and choosing Landscape prints as expected (Ed, 2026-09-26). WebView2's dialog takes no starting settings and Edge's own preview would draw inside the hidden viewer, so presetting it means a different dialog; left as is, Ed's call.

**Phase 2 as built (0.6.2):**

- Paragraphs are worked out from the text's layout (10-pdf.js): a new paragraph where the gap to the next line is over 1.6 lines, where the text size changes, or where the next line is higher on the page. Each is a detached `.block` element carrying its page and span, so Read Aloud (09-speech.js) and marks (02-layout.js) use their existing code with a PDF branch at the few places that looked for `#editor .block`.
- Read Aloud with Windows voices and Qwen narration read from the paragraph with the cursor, or the first on screen, highlighting each on the page. Render-ahead works on a PDF as in a book.
- The selection popup appears on a PDF: Look up, Read, Read from here, Find, Search the web, Highlight. Formatting and Link are hidden.
- Bookmarks and highlights anchor to paragraphs by the same fingerprints as documents, are stored by path like any document's, and list with "p N". There is no margin ribbon on a PDF page (documents have one).
- Also done: the password prompt from the Security section. A PDF that cannot be opened says so in the view, not in the document "Load failed" dialog.
- Tests: `tests/pdf-reader-features-app.mjs` (14 checks; speech and the narrator stubbed, so nothing is heard and no GPU is used). `tests/pdf-locked.pdf` comes from `tests/make-locked-pdf.mjs`.
- Word count and reading time came with Phase 1.
- Not checked: real Qwen audio on a PDF (the stubbed test covers what the PDF hands the narrator), and reading order on two-column academic papers (the plan's stated risk).
- Known: letter-spaced headings ("W E L C O M E") come out of the PDF as separate letters, so a voice spells them out. The word boundaries are not in the PDF's text.

**Phase 2b as built (0.6.3):**

- File > Save Pages as Images... and Save All Images in PDF..., live only on a PDF tab. Native WPF dialogs on the app's colours; the modern Windows folder picker (`FolderPicker`, IFileOpenDialog in pick-folders mode), starting in the PDF's folder. A progress window with Cancel; at the end, what was saved and an offer to open the folder.
- The page does the work one page at a time from **its own copy of the document** (not the viewer's, whose cached pictures an export must not clean up), and POSTs each file to `https://localpdf/export/<job>/<name>`. The host writes it only for a job it started, only inside that job's folder (one subfolder at most, names sanitised), and never over an existing file (" (2)").
- Pages: PNG or JPEG (quality), 150/300/600/other DPI, the pixel size of page 1 shown in the dialog. The DPI is written into the file (PNG pHYs, JPEG JFIF density). Pages past a browser canvas's limits are drawn smaller, and the result says so.
- Pictures: PDF.js's operator list gives each picture as drawn; JPEG pictures are found in the file's own bytes (DCTDecode streams) and matched to the picture by comparing pixels, so they are saved byte for byte; anything else, or anything that does not match, is a PNG with its transparency. Skips under 32x32, saves repeats once (by object and by content hash), optional subfolder per page. Pictures that cannot be read are counted and reported, never dropped silently.
- Tests: `tests/pdf-export-app.mjs` (11 checks, using `tests/pdf-pictures.pdf` from `tests/make-pdf-pictures.mjs`). A `pdf_export_test` message, honoured only with --debug and only into the temp folder, runs an export without the dialog and picker. The dialogs and the picker were checked by screenshot, not by a test.
- Found on the way, fixed: a PDF reloaded every time the TypoZen window was activated again (switching back to it). The on-disk change check treated a PDF tab as a document with text to compare; it now skips PDFs as it skips books. This stopped Read Aloud or an export mid-page.
- Not built: right-click **Save Image As...** on one picture. A picture on a PDF page is not an element to click; it needs hit-testing against the drawing operations' positions. "This page" in Save All Images covers one page's pictures meanwhile.
- Not checked: a large real-world PDF (hundreds of pages, big scans) for time and memory; CMYK JPEGs (they are saved as PNG by design).

**Phase 3 as built (0.6.4):**

- A page whose text has no letters or digits is read once the PDF's text is in, starting at the page on screen. On by default (D3); View > Read Text in Scanned PDF Pages turns it off (window state `pdfOcr`).
- The page draws the page from its own copy of the document (about 2600 px on the long side, at most 300 DPI, JPEG) and POSTs it to `https://localpdf/ocr/<token>/<page>/recognize`; the host runs `Windows.Media.Ocr` (`TryCreateFromUserProfileLanguages`) and returns words and boxes. It is not saved there: the page scores the result (letters in real words out of all letters) and, if poor, tries the page turned 90, 270 and 180 degrees, keeping the best -- scans are often sideways (Ed's `Test_PDF_printed.pdf` is: its pages read as "00 on o o" upright and correctly turned). A result with no words (a photograph) is kept as no text. The chosen result is POSTed to `.../save` and cached per file content hash; `GET .../<page>` answers from the cache.
- The words become the page's text and items (lines of one height unless clearly bigger, so paragraphs split on gaps and headings) and an invisible word layer, `.tzOcrLayer`, laid over the scan like PDF.js's text layer, rotated to match a turned page. Find, the Search sidebar, selection and the popup, Read Aloud, narration and marks all use it through the same code as real text.
- Cache in the profile (`ocr/<hash>/p<n>.json`); in Privacy Mode in the session's temp folder. Clear Stored Data: "Text read from scanned PDF pages".
- **Measured:** 0.2-0.4 s a page upright, 0.4-0.8 s when a page needs turning (12 sideways pages in 4.2 s), 20-40 ms from the cache.
- The host project now references `System.Runtime.WindowsRuntime` (for WinRT's `Rect`), a .NET Framework part on every Windows 10/11, not shipped.
- Tests: `tests/pdf-ocr-app.mjs` (12 checks) on `tests/pdf-scanned.pdf` from `tests/make-pdf-scanned.mjs`. Needs an OCR language in Windows.
- Not checked: Privacy Mode's temp-folder cache (by reading only), non-English scans, a PDF with hundreds of scanned pages (reading runs in the background page by page; untested at that size), and whether a machine with no OCR language shows its status line (the message exists; this machine has English).
- Known: recognition errors on real scans ("E86,OOO" for "£86,000" on Ed's printed PDF). Skew beyond what Windows corrects, and handwriting, read badly.

**Phase 4 as built (0.6.5):**

- **Tools:** Edit > Annotate PDF (a native submenu, shown on a PDF only, per AGENTS.md): Highlight, Add Text, Draw, Add Picture..., Stop Annotating. The tick follows PDF.js's actual mode (`annotationeditormodechanged`). PDF.js's own per-annotation toolbar (delete, highlight colour) is used as it comes. Undo/Redo in the Edit menu and Ctrl+Z/Y go to the annotation editor (`editingaction`).
- **Forms:** filled in place (`AnnotationMode.ENABLE_FORMS`), saved with the rest.
- **Integration fixes PDF.js's component needed:** its app, not its viewer, answers the editor's request to change tool (`showannotationeditorui` in PDF.js 6), so the page does; and its app supplies the highlight colours (`annotationEditorHighlightColors`), without which making a highlight threw. `AnnotationStorage` keeps its modified flag private, so the page tracks it from `onSetModified` / `onResetModified`.
- **Unsaved state:** `DocTab.PdfEdited` (not `IsDirty`, which every read-only rule forces false for a PDF): the tab's `*`, the status bar, File > Save, closing the tab and closing TypoZen all use it. Autosave only looks at `IsDirty`, so it never writes a PDF.
- **Saving:** Save asks the first time, suggesting `<name>-annotated.pdf`; choosing the original overwrites it after the dialog's own confirmation. The page commits any edit in progress (a text box, a drawing session), writes `saveDocument()` to `https://localpdf/write/<job>`, and the host writes it beside the target and swaps it in (`File.Replace`). The tab becomes the saved file, and later saves go straight back to it. Save As always offers a copy.
- **Switching tabs:** before any tab change the host asks the page whether anything is pending (changes, a copy carrying them, or a tool in hand) and, if so, has it written to a temp file (the session's temp folder, `PrivateLoadDir()/pdf-edits`); coming back opens that copy. A theme change with page colours on reopens from the unsaved bytes too.
- **Tests:** `tests/pdf-annotate-app.mjs` (15 checks; `tests/pdf-form.pdf` from `tests/make-pdf-form.mjs`): highlight from a selection, Undo/Redo through the menu command, the highlight kept across a tab switch, Save to a new file with the original byte-for-byte unchanged, a form value saved, a drawing kept when switching tabs with the Draw tool still in hand. The Annotate menu and the Save dialog were checked by screenshot; Add Text by a probe (click, type, click away).
- **Not checked:** Add Picture (it opens a file picker), the close-tab and quit prompts for an edited PDF (message boxes), overwriting the original through the dialog, and very large PDFs (each save and each tab switch while annotating writes the whole PDF).
- **Not built:** signatures (PDF.js's signature tool needs its app's signature dialog), page operations (would need pdf-lib), and a check that the original changed on disk before overwriting it.

## Decisions

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
| Zoom / fit | The existing zoom commands drive the viewer's scale. No new controls. Reset returns to the fit. |
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
