# Known issues

Baseline inventory of **user-visible** residual risk for the current tree.

- **Open defect-class items:** none.
- Suite-only failures belong in the harness, not here. See `docs/for-agents.md`.
- This file is the living record. The health reviews are archived snapshots of older
  trees (`docs/archive/`) and do not describe current state, whatever their own text says.

## Product limits (not defects — do not “fix” by inventing precision)

### The page TOTAL is an estimate until the document has been laid out — and says so

`PageChunks` measures only the ranges the reader has visited and infers the rest from
pages-per-block. So the total moves as a long book is read. Three rules keep that honest
rather than misleading:

- **It is marked.** The indicator reads `43 / ~264` and the Go To prompt says the total is
  an estimate, until every range has been measured. The page you are *on* is always exact.
- **It converges, in both directions.** Unmeasured ranges follow the refined pages-per-block
  as measurements come in, up or down. Making that a ratchet — "never take away a page the
  reader has been shown" — was tried and reverted: an estimate that cannot fall never
  converges, so every range the reader had not visited stayed at the seed (800 × 0.06 = 48
  pages) while the measured ones read 20, the total sat at more than double the document,
  and a column switch could not correct it. A figure that is honestly wrong both ways and
  settles beats one that is wrong in a flattering direction forever.
- **The end is exact.** Dragging the scrubber fully right seeks the last *block*, not the
  last estimated page — the end of a document is knowable without any estimate.

**User expectation:** the page you are on is right; the total is marked `~` while it is
still being learned, and is exact once the document has been read through. Mark sidebar
**p N** uses the same map and can lag until its range is real.

---

### What a book's own files can still get wrong

Measured across a 148-book library on 2026-09-27. None of it loses text.

- **A rule scoped under a container the block split removed.** Every top-level element is
  mounted in its own `.block`, and a wrapper `div` with many children is split into its
  children. `p + p`, `h2 + p` and a leading `:first-child` are translated across blocks
  (0.7.13); `div.poem p + p` is not, because the `div` may no longer be there and guessing
  would style the wrong text. Seen in one book (*Gods of Risk*, its poems).
- **A broken font file in the book itself.** *Alien: Covenant*'s `00007.ttf` (Univers
  italic) is refused by Chromium as invalid font data once unscrambled; its ten siblings
  load. That style falls back, as it would in any reader.

Not present in that library and not handled: DRM, fixed-layout (pre-paginated) books,
right-to-left or vertical text, EPUB 3 footnote markup, MathML, audio and video.

---

## Product notes (not defects)

### Spelling is not the bundled dictionary

`dictionary.tsv` / `thesaurus.tsv` are WordNet **Look up**. Preview spelling is
WPF’s dictionaries (English, French, German, Spanish). Source uses Chromium.
Books, PDFs and Reader are not checked.

---

## Fixed / mitigated (kept briefly so regressions are recognized)

### A book's stylesheet could move the page — **fixed** (0.7.10–0.7.11)

Zones of Thought's `body { margin: 0 1.5em 0 1em }` landed on `#editor`, the element that
is the page, and pushed the right column of every spread off the window whatever View >
Margins said. It was a class, not a book: 36 of 148 library books put layout on the page
this way, and 49 had rules that escaped the book into the application (rules inside
`@media` were never scoped). Book CSS is now parsed by the browser and rewritten through
an allowlist (`applyBookStyles`): the page takes text properties only; elements inside the
book take text properties and bounded box properties; the app's `.block` boxes take
nothing. Inline `style=""` goes through the same allowlist. Guarded by
`book-css-browser` (a hostile stylesheet).

### No book's embedded fonts ever loaded — **fixed** (0.7.13)

Three faults in a row. The book host was mapped `DenyCors`, and a font is always fetched
in CORS mode, so none of the 18 library books with `@font-face` got their fonts (images are
not CORS requests, which is why nothing else looked wrong). Fonts EPUB obfuscates
(`META-INF/encryption.xml`, IDPF and Adobe schemes) were served still scrambled
(`RestoreObfuscatedFonts`, on extraction). And a stylesheet's `url()`s were resolved
against the OPF folder instead of the stylesheet's own, so `Styles/x.css` asking for
`../Fonts/a.ttf` looked outside the book (`cssDirs` in the payload).

### Sibling rules and tables in books — **fixed** (0.7.13)

Each top-level element sits alone in a `.block`, so Blindsight's `p + p` indent and The
Churn's `h2 + p` never matched, and `p:first-child` matched every paragraph. Sibling rules
between top-level elements are translated across blocks, a leading `:first-child` means a
chapter's first element, and positions are never claimed for a top-level element. A book
table is capped at its column and its cells may break anywhere (a Zones of Thought table
was 337px in a 290px column). Guarded by `book-css-browser`.

### PDF selection painted twice, and on line breaks — **fixed** (0.7.12)

PDF.js's own selection painter stacked with the theme's, and the theme's rule painted the
text layer's line breaks, a dashed column at the page's left edge.

### A PDF tab forgot its columns and Pages — **fixed** (0.7.11)

The PDF viewer held its layout in page memory, shared by every PDF tab and lost on
restart. `DocTab.Scroll` beside `Columns`, saved in the session and sent with `load_pdf`.
Guarded by `pdf-layout-restore-app`.

### Keyboard shortcuts did nothing while typing — **fixed** (0.5.7)

Ctrl+S, Ctrl+Shift+S, Ctrl+N, Ctrl+O, Ctrl+P and F11 were handled only by `Window.KeyDown`,
which never sees a key while the editor has focus: the WebView's HWND belongs to the browser
process, so the key goes to the page and nowhere else. Save therefore worked only after
clicking outside the text. The page now forwards them (`save_shortcut`, `shortcut:*`) and the
host runs them on the next dispatcher turn -- called inside the WebView's message callback,
saving read nothing from the editor and silently wrote nothing. Ctrl+Shift+D also sat on the
`else` of the Ctrl check, so it could not run at all. Guarded by `save-shortcut-app` (app
tier). A host-side key filter does **not** fix this; that was tried and measured to do nothing.

### Menus offered what the tab could not do — **fixed** (0.5.7)

On a book or in Reader, Undo/Redo/Cut/Paste/Spelling were live and Insert Table stayed bright
(the lock list named `tableMenu`, which does not exist; the button is `btnTable`). On a book,
Save and Save As led to an export that wrote an empty file; both are greyed. On a PDF, image or
media tab, Save, Save As and Export as HTML are greyed. **Book export to Markdown is broken**
and is only hidden, not fixed.

### Book links unreadable on dark themes — **fixed** (0.5.6)

Dune's stylesheet sets its contents links `color: blue` (`#0000FF`): about 1.7:1 on a dark
theme. Links in the editor now take the theme accent. A book link has no `href` when shown
(06-render-epub.js moves it to `data-book-href`), so a rule on `a[href]` matched none of them
-- 0.5.5 shipped that and changed nothing.

### Pasting into a line — **fixed** (0.5.5)

A paste lost its own leading and trailing spaces, and `**bold**` pasted into bold text saved as
unnestable `**a **b** c**`, showing stray asterisks. Guarded by `paste-inline-browser`.

### A book opened on the other tab's page — **fixed** (0.2.49–0.2.51)

One symptom, three causes, each hidden behind the one before, which is why it survived
several rounds of fixes that were each correct as far as they went:

1. **Scroll offset (0.2.49).** `loadBookPayload` never reset `editor.scrollLeft`, and the
   page number is `scrollLeft / stride`, so a book with no remembered position opened on
   the previous book's page *number*, whatever either book's length.
2. **Pending resume (0.2.50).** The jump to a remembered block retries for up to ~5s and
   jumps again 700ms later; nothing cancelled it when another document arrived. A tab
   switch under a second landed the next book on the previous book's block.
3. **Stale reading anchor (0.2.51).** `_readingAnchor` was never cleared. A book opened at
   a remembered block overwrote it, so only a book on page 1 kept the previous book's —
   and the next remount (`set_column_mode`) moved it there. Showed as Hilldiggers on its
   cover coming back at Prador Moon's exact line.

`cancelResumeAt()` (which also calls `forgetReadingAnchor()`) runs beside
`cancelPositionReport()` on every document-replacing host message. Confirmed in the app by
the reader who reported it. Guarded by `tab-position-browser` (~12s, headless), which fails
all three cases on 0.2.48 and the third on 0.2.50.

The generation stamp on `book_position` reports (`doc_gen`, 0.2.48) was added for a
suspected misattributed report and never shown to matter; it is kept because it closes a
real, if unobserved, window. When measuring anything here in two-column mode, read the
`.page-num` spans individually: the indicator's `textContent` runs pages 9 and 10 together
as `910`, and that produced two false reproductions.

### Book text unreadable on dark themes — **fixed** (0.2.49)

Hilldiggers' stylesheet sets `color: black` on its paragraph classes. `applyBookStyles` now
drops neutral `color` / `background-color` / bare-colour `background` declarations (black,
white, greys) so the theme decides; coloured declarations stay. Inline `style=` in a book's
markup now goes through the same rules (0.7.11).

### Source search highlighting jumped to the wrong place — **fixed** (0.2.30)

The mirror that paints hits on a `<textarea>` scrolled by hard-line-index /
line-count × scrollHeight. Wrapped paragraphs are many visual rows, so Search
landed far from the match. It now paints first, then scrolls so the current
`<mark>` is in the textarea viewport. Wrap width follows `clientWidth` (not the
scrollbar box). `source-highlight-app` asserts a late jump is on screen.

### F1 / Help → Syntax & Shortcuts did nothing — **fixed** (0.2.28)

The empty-tab hint and the Help menu advertised F1. Only F7/F8/F9 were bound in
the page. `Window.KeyDown` has F1, but that event never runs while the editor
WebView has focus, and disabled Chromium accelerator keys can swallow F1
(browser Help) before page JS. The key looked dead.

**Now:** page JS binds F1 next to F7/F8/F9; the host key filter posts
`cmd:help_syntax` the same way it posts Ctrl+Z. The overlay **opens** (does not
toggle, so a page+host double-fire cannot close it). CSS `.open` wins over
`[hidden]`. `scratch-help-app` presses a real `{F1}` into the window.

### New-tab placeholder was real document text — **fixed** (0.2.27)

New Tab loaded `# Untitled Document` / `Start typing here...` as markdown.
The CSS hint lived on `.block::before`, which is the 10px bookmark gutter
(`width:10px`), so the sentence painted one glyph per line. Chromium
`innerText` includes `::before`, so a tab switch saved that string as the
file — including after the user had deleted it. Selection drags on that
rail also jumped from the start of the document.

**Now:** new documents are empty. The hint is an overlay on
`#editor-wrapper`, `pointer-events: none`, not in the block. `getBlockRaw`
does not prefer `innerText` over empty `data-raw`.

### Ctrl+B on a PDF formatted the hidden document — **fixed** (0.2.26)

`SendMsg` gated `cmd:` on a native tab but not `fmt:` / `export_html`. The
host key filter posted `fmt:bold` at the editor WebView sitting behind the
PDF, so a chord on a picture dirtied the markdown you were editing.

**Now:** those messages are refused while the native surface is showing;
the filter does not swallow the chord (the viewer can have it).
`native-surface-app` asserts Ctrl+B leaves the hidden document clean.

### Seeking into a very large book looked hung — **harness, not a hang**

`epub-open-app` stalled on the 45,486-block Xeelee omnibus. Isolated,
`goToModelBlock` into the middle is ~120 ms and windowing mounts 800 blocks.
The red run was stacked CDP evaluates (`evalPatiently` abandoning an in-flight
remount and sending another) plus Matter's throwaway-profile session leaking
into the Xeelee relaunch. Suite now passes both books (93/0). Do not raise
`protocolTimeout`.

### Search jumped to the wrong place when a match had no DOM range — **fixed**

Image-only path matches and other no-text-node hits used to fall back to `ranges[0]` and
scroll to the first mounted highlight (often the top of the document).

**Now:** `highlightModelMatchInMountedDom` only scrolls when `currentRange` names this
match. Image-only hits navigate via `ensureModelBlockVisible` / page map and never use
the text highlighter. Status Ln is pinned after jumps (`pinStatusLineAfterJump` + sticky
preferred when focus is outside the editor).

### Marks list active row wrong in 2-col — **fixed**

Active row used “last mark ≤ top-left block,” missing marks on the right of the spread.
**Now:** prefer marks visible on screen, then list-click pin, then last-before.

### Preview not editable after leaving a book — **fixed**

`leaveBookViewForMarkdown` set `contenteditable` while mode was still Reader, then
flipped mode without re-enabling edit. **Now:** mode first, then
`setEditorEditable(true)` for Preview; `applyViewState` re-syncs editability.

### Marks unresolved after reopen — **fixed** (re-verify if seen)

Load-order / fingerprint / hint handling for marks across book open and Marks tab.

### Tab after undo (list indent) — **mitigated**

Clear format freeze on undo/redo; list Tab prefers live selection.

---

### Select All copied the window, not the document — **fixed**

`Ctrl+A` selects the editor's *contents*, and under virtualisation those are a window: 54
blocks of 3767. `selectionToPlainText` walked the mounted blocks, so Select All + Copy put
**2,797 characters of a 205,842-character document** on the clipboard — one per cent,
silently. **Now:** a whole-editor selection over a partial DOM is answered from
`DocumentModel`. The `text/html` flavour is omitted in that case rather than fixed, so no
rich target can take the window while the plain text carries the document.

### Print produced a fraction of the document — **now refused**

Chromium prints the DOM, so `Ctrl+P` on a long document made a PDF of roughly what was on
screen, with nothing to indicate the rest was missing. Worse than a skipped paragraph: it is
an artefact you keep and may send on. **Now:** Print stops and explains, rather than mounting
the whole document (which is the work windowing exists to avoid). Fails open — an unanswered
probe prints, so a broken check cannot silently disable Print.

**Cut / Delete after Select All, and Export as HTML, used the window too — now fixed.**
`getAncestorBlock` stops at `#editor`, so a `selectNodeContents(editor)` range was not
treated as multi-block. Cut fell through to the browser: clipboard got the window, the view
blanked, the model survived. Delete after Select All was the same hole. Export as HTML
dumped `editor.innerHTML`. **Now:** a whole-editor selection copies/cuts/deletes via
`DocumentModel`, and export renders every model block. Guarded by `clipboard-roundtrip-browser`.

---

### Turning a page silently skipped text — **fixed**

The worst defect found in this tree. Reading any long document in **Pages** mode, text was
lost at every 800-block range boundary, with nothing on screen to say a paragraph had gone.

A range's last page is usually partial, so its start offset (`index x stride`) lies past the
furthest the view can scroll. `PageGeometry.localCount()` treated that as "not a page you can
turn to" and dropped it — but `go()` had already been fixed to end that page at `maxScroll`
so its tail shows flush right. The page was reachable; nothing was ever allowed to ask for
it. The view stopped at the last whole boundary and everything from there to the end of the
range was never painted.

Measured on `tests/large-scroll-mixed.md`, 2-column, over 200 spreads: **16px lost 16 blocks
across three boundaries** (7, 1 and 8); 18px lost 8 across one. The default font size was the
worse case, so this was not an exotic configuration.

**Now:** the count is the content, and `localIndex()` answers from the scroll position — being
parked at `maxScroll` *is* the last page. That keeps the reader from being stranded on it,
which is what the dropped-page clamp had been guarding against. Guarded by
`page-coverage-app`, which walks spreads and asserts no gap in the blocks actually painted.

---

### Hover paint erased bookmarks — **fixed**

The hover cue and the bookmark were both drawn as an inset left `box-shadow`, and the
hover rule was written more specifically, so mousing over a bookmarked paragraph in
Preview swapped its amber edge for the accent one. In Reader the "hover off" rules used
`box-shadow: none !important` / `background-color: transparent !important`, which erased
the bookmark rail *and* the arrival wash on whichever paragraph the pointer rested over.

**Now:** the gutter holds one ribbon beside a marked paragraph's first line, owned by
bookmarks, and nothing appears on hover (0.7.4 removed the hover preview and its View menu
item: the gutter click it previewed had gone in f673fc2). Nothing in that lane uses
`!important`.

---

## Preferences (not bugs)

- Search and Marks jumps share **`flashMarkFocus`**: a brief wash in the theme's text colour
  (`--arrive-bg`), not the marks' colour.

---

### The selection popover sits on the text it is about - **fixed** (0.3.5)

Selecting a word near the top of a document raised the bar *above* the selection, covering the text. Selecting near the bottom put it below, off screen. It frequently overlapped the selected line itself.
This was caused by the native `host-zoom` CSS scaling not being canceled out correctly in the JavaScript absolute positioning logic, inverting the coordinate math.
The bar was also redesigned into a 3x2 grid with new icons, a "Read from here" button, and automatic layout flipping when it expands the dictionary body.

## If something still feels wrong

1. Reproduce once with Debug HUD (Ctrl+Shift+D): sticky line, find index, mode.
2. Prefer a new entry here over reopening a “fixed” section without evidence.
3. Page-number drift on first pass through a huge book is the product limit above, not a
   regression of mark resolve or search jump.
