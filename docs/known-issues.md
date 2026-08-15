# Known issues

Baseline inventory of **user-visible** residual risk for the current tree.

- **Open defect-class items:** none.
- Suite-only failures belong in the harness, not here. See `docs/for-agents.md`.

---

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

## Fixed / mitigated (kept briefly so regressions are recognized)

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
