# Known issues

Open defects and deliberate limitations that still surprise people. Each entry is
**reproduced and characterised**, or an explicit product tolerance with a short why.

Suite failures that have not been turned into a user-visible defect do **not** belong
here — fix the suite or the harness, or leave them alone. See `docs/for-agents.md`.

---

## Search: no DOM range for the current match

**Where:** `highlightModelMatchInMountedDom` in `js/modules/02-layout.js`.

**What happens:** Some matches have no on-screen text range (image-only lines where the
query hits the asset path, or markup-only queries). When the target **block is known**
(`curBlock >= 0`) but no range was built, the highlighter **must not** scroll to another
match. Earlier code used `ranges[0]`, which yanked the view to the first mounted hit
(often the top of the document).

**Current behaviour:**

- **Image-only lines:** `revealModelMatch` navigates with `ensureModelBlockVisible` /
  page map and **never** calls the text highlighter for that hit. Sidebar shows a
  clickable image badge (`search-item-image`).
- **Other no-range cases with a known block:** no wrong-match scroll; navigation is the
  caller's job (`revealModelMatch` / sticky restore).
- **Fallback to `ranges[0]`:** only when the current match never mapped to a block
  (`curBlock < 0`) and some ranges exist (legacy paint path for ambiguous mapping).

**Impact if regresses:** Confusing jump; list counts stay correct.

---

## Page counts are approximate until every range is laid out

`PageChunks.estimateChunkPages` estimates unmeasured ranges, so `count()` on a long
document is approximate until the reader has paged through enough material. Documented
behaviour, tolerated deliberately; the suite allows for it.

Scrubber mark ticks use the same page map: mounted ranges are measured, unmounted ones
are placed proportionally inside the range (not piled on the range start). Ticks still
shift slightly as estimates refine — same contract as the scrubber thumb — but they
should track mark order and spacing across the book rather than collapsing by chapter.
Mark page labels in the sidebar can lag the same estimates until layout settles.

---

## Marks / bookmarks after reopen (fixed in engine; re-verify if seen again)

Historically, `marks_load` could resolve against the previous tab's model while an epub
was still fetching; book load did not re-resolve, and a failed resolve set `block` to
`-1` so the next search had no mid-book hint (±400 from 0). Marks then showed
"the text this marked is no longer here" for the whole session (and could be dropped
from the store if `-1` was written). Engine now re-resolves on book load, full-document
fingerprint match, preserves a position hint, and re-checks when opening the Marks tab.

---

## Marks list "active" row vs 2-column page (mitigated)

Historically the active mark was "last mark at or before top-left reading block". In
2-col Pages that ignored marks on the right of the same spread. Active selection now
prefers marks **visible on screen**, then pin-from-list-click, then last-before.

---

## Tab after undo (list indent) — mitigated

Historically, after undo a frozen format-selection snapshot (or fallback index `0`)
could name a non-list block while the caret sat on a list item: Tab `preventDefault`ed
without indenting, while a direct `applyListIndentToSelection(1)` still worked.

**Mitigation:** clear format freeze on undo/redo; prefer live selection / caret for list
Tab (`js/modules/04-lists.js`, commit `01efea8`). If `editing-sweep-app` still reports
"Tab indents a list item", re-characterise — do not re-file the old freeze theory without
measurement.

---

## View preferences worth knowing

- **View → Block Hover:** mouse-over block cue in Preview (`none` / `wash` / `edge` /
  `hint`). Default is **left edge**. The bookmark ▮ hover ribbon appears only in **Mark
  hint only**. Reader/epub never show block hover.
- **Search jump** and **Marks jump** share `flashMarkFocus` (brief amber wash).
