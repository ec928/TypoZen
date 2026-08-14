# Known issues

Baseline inventory of **user-visible** residual risk for the current tree.

- **Open defect-class items:** one — a page the count names cannot always be seeked to
  (below). Distinct from the approximate-total product limit it sits next to.
- Suite-only failures belong in the harness, not here. See `docs/for-agents.md`.

---

## Open

### A page `count()` names cannot always be seeked to

**Reproduced:** `page-count-truth-app`, `page-scrubber-app`, both on
`tests/large-scroll-mixed.md`, in 1-col and at baseline `aca2dde` — not a regression from
the gutter/marks work.

- `PageMap.goto(267)` lands on 261. The suite samples 12 pages across 268 and misses one.
- The scrubber: 1 seek in 4 adrift, worst case 4 pages; and the last page reads 3125 of
  3128 once the total is re-measured.

**Why it is filed as a defect and not as the limit below.** An approximate *total* is a
documented trade: the reader sees "about 600 pages" and nothing breaks. This is different
— the UI names page 267, the reader asks for page 267, and the application goes somewhere
else. A number you cannot act on is worse than a number you know is rough.

**Not attempted.** The fix is in `PageChunks` estimation, and making an estimated range
seekable to the page rather than to the range is a real piece of pagination work, not a
tuning constant. Decide whether that is worth doing before touching it; the alternative —
relaxing the suites to tolerate the drift — is a product decision to stop promising this,
and should be taken deliberately rather than by editing an assertion.

---

## Product limits (not defects — do not “fix” by inventing precision)

### Page counts and scrubber mark ticks are approximate until laid out

`PageChunks` estimates unmeasured ranges. On a long book, total pages and tick positions
shift slightly as the reader pages through and measurements replace estimates. The suite
allows for it. Mark sidebar **p N** uses the same map and can lag until the range is real.

**User expectation:** order and rough placement are trustworthy; exact page numbers early
in a first open of an omnibus are not typesetter-precise.

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
