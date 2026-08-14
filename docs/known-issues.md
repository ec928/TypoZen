# Known issues

Baseline inventory of **user-visible** residual risk for the current tree.

- **Open defect-class items:** none as of this baseline (page-map precision is a product
  limit below, not a bug backlog).
- Suite-only failures belong in the harness, not here. See `docs/for-agents.md`.

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

## Preferences (not bugs)

- **View → Block Hover:** `none` / `wash` / `edge` (default) / `hint`. Bookmark ▮ hover
  only in **Mark hint only**. Off in Reader/epub.
- Search and Marks jumps share **`flashMarkFocus`** (brief amber wash).

---

## If something still feels wrong

1. Reproduce once with Debug HUD (Ctrl+Shift+D): sticky line, find index, mode.
2. Prefer a new entry here over reopening a “fixed” section without evidence.
3. Page-number drift on first pass through a huge book is the product limit above, not a
   regression of mark resolve or search jump.
