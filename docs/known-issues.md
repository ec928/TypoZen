# Known issues

Baseline inventory of **user-visible** residual risk for the current tree.

- **Open defect-class items:** two, below, both with a fix in 0.2.49 that has not yet been
  confirmed in the app.
- Suite-only failures belong in the harness, not here. See `docs/for-agents.md`.
- This file is the living record. The health reviews are archived snapshots of older
  trees (`docs/archive/`) and do not describe current state, whatever their own text says.

## Open defect: a newly opened book takes the previous tab's page number

**Status (0.2.49): cause measured, fix awaiting confirmation in the app.** The scroller's
offset survives `loadBookPayload`, and a resume only runs for a block past 0, so a book
with no remembered position (a new book, or a tab left on page 1) keeps the previous
book's offset. Headless, on the 0.2.48 tree: book A turned to page 16, book B loaded with
no resume -> B reported page 16 at the identical `scrollLeft` (14520). With the reset at
the top of `loadBookPayload`: B opens on page 1, and a resume to block 400 still lands on
its page (40). The notes below predate the measurement and are kept for the record.

**A second cause, found when 0.2.49 was tried (0.2.50).** Slow tab switches were then
right; a switch under about a second still put the next book on a wrong page (Hilldiggers
on page 3 after Prador Moon on page 5). The jump to a remembered block runs on a timer --
up to twelve 400ms retries, then a second jump 700ms later -- and nothing cancelled it when
another document arrived, so the previous book's block was applied to the new one.
Reproduced headless through the host messages: A with `|at=450`, B 300ms later -> B on A's
page (45); 3s later -> page 0. `cancelResumeAt()` now runs beside `cancelPositionReport()`
on every document-replacing message: fast switch -> 0, and A's own resume still lands (45)
including straight after a cancelled one.

**A third cause, found when 0.2.50 was tried.** Fast switching now worked from a book's page
10 but still failed from its first page: Hilldiggers, on its cover, came back at Ln 112 --
Prador Moon's line. `_readingAnchor` (a block index) was never cleared when a document was
replaced; only a resume, page turn or jump sets it, so a book opened at a remembered block
overwrote it and a book on page 1 kept the previous book's. The next remount
(`set_column_mode`, the pagination remount) then used it. Reproduced headless: B on page 1
holding A's anchor 40 -> `set_column_mode:1` -> B on page 5. `forgetReadingAnchor()` (also
retiring pending `goToPageHoldingBlock` rechecks) now runs from `cancelResumeAt()`: B stays
on page 1, A's resume still lands. An uncommitted attempt found in the tree on 2026-09-16
cleared the same anchor; it was dropped unmeasured on 09-16, which was a mistake.
Awaiting confirmation in the app.

Open a book while another book is already open and the new one does not start at page 1.
It starts on **the page number the other tab was showing**, and the reader really is parked
there — the status line shows a line number well into the text, not line 1.

Reported repeatedly and reproducible on demand by the reader who hit it. **Not reproduced
in testing**, across both column modes, page turns as well as programmatic jumps, File >
Open as well as the single-instance hand-off, and a copy of the reporting profile. Treat
the notes below accordingly: the observations are solid, the explanations are not.

### What is established

- The number is **exactly** the other tab's page, never a proportional position, and it is
  the same number whatever the two books' lengths are.
- The content is genuinely displaced, not merely mislabelled.
- It needs a book already open. The first book opened into an empty editor is correct.
- The page indicator is `PageMap.current()`, which derives from `editor.scrollLeft`.
  **A shared scroll offset therefore produces the same page NUMBER in any book**, because
  the page width is the same — which is the one property that explains "always exactly the
  other tab's page, never proportional".
- The only `scrollLeft = 0` on a book path is inside `leaveBookViewForMarkdown`, the
  book-to-markdown transition. Nothing resets it when one book replaces another.

### What is guesswork — none of it verified

- That a debounced `book_position` report is landing on the wrong tab. A generation stamp
  was added for it (`doc_gen`, captured when the report is armed). It did not demonstrably
  change the reported behaviour.
- That resetting the scroller in `loadBookPayload` fixes it. This follows from the
  `scrollLeft` observation above and is the most promising line, but it was never built or
  measured.

### Where to start

Measure `editor.scrollLeft` and `PageMap.current()` at the moment the second book paints,
with the first book scrolled well past page 1. If the offset is non-zero, the reset is the
fix and the position-report work is a red herring.

**A warning about measuring this.** In two-column mode the page indicator renders one
number per column, so reading its `textContent` returns "1" and "2" as `12`, and pages 9
and 10 as `910`. Read the `.page-num` spans individually. A probe that reports the wrong
thing here is worse than none: it produced two confident false reproductions.

## Open defect: a book whose stylesheet forces a text colour is unreadable on some themes

At least one epub sets an explicit colour on its body text, which overrides the theme. On a
dark theme that is dark text on a dark ground.

**Status (0.2.49): fix awaiting confirmation in the app.** Hilldiggers' `stylesheet.css`
declares `color: black` on its paragraph classes. `applyBookStyles` now drops neutral
`color`, `background-color` and bare-colour `background` declarations (black, white,
greys); coloured declarations are kept. Checked against that stylesheet headless: no
`color: black` survives, `#c00` and `rgb(0,0,255)` do. Inline `style=` colours in the
book's markup are not touched.

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

## Product notes (not defects)

### Spelling is not the bundled dictionary

`dictionary.tsv` / `thesaurus.tsv` are WordNet **Look up**. Preview spelling is
WPF’s dictionaries (English, French, German, Spanish). Source uses Chromium.
Books, PDFs and Reader are not checked.

---

## Fixed / mitigated (kept briefly so regressions are recognized)

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

**Now:** the gutter is a single `::before` rail owned by bookmarks, four opacities, and
there is no block-body hover cue at all. Nothing in that lane uses `!important`.

---

## Preferences (not bugs)

- **View → Block Hover:** `off` / `gutter` (default). Controls the hover *preview* only —
  a bookmark that exists is always drawn, in Reader as well as Preview.
- Search and Marks jumps share **`flashMarkFocus`** (brief amber wash, `MARK_FLASH_MS`).

---

## If something still feels wrong

1. Reproduce once with Debug HUD (Ctrl+Shift+D): sticky line, find index, mode.
2. Prefer a new entry here over reopening a “fixed” section without evidence.
3. Page-number drift on first pass through a huge book is the product limit above, not a
   regression of mark resolve or search jump.
