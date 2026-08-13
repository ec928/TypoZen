# Known issues

Open defects and deliberate limitations that still surprise people. Each entry is
**reproduced and characterised**, or an explicit product tolerance with a short why.

Suite failures that have not been turned into a user-visible defect do **not** belong
here — fix the suite or the harness, or leave them alone. See `docs/for-agents.md`.

---

## Search highlighter can land on the wrong match (`: 0` fallback)

**Where:** `highlightModelMatchInMountedDom` ends with
`ranges[currentRange >= 0 ? currentRange : 0]`.

**What happens:** When the requested match has no built range, the view scrolls to a
**different** match — whichever range was built first (often the top of the document).
The match list and counts are not wrong; only the paint / scroll target is.

Image-only matches are handled at the caller (nowhere to paint, deliberately). The
general fallback remains for any match with no range. Removing it outright regressed
`search-highlight-app` (`currentRange` is `-1` more often than the one bad case).

**Impact:** Confusing jump, not data loss or a wrong save.

---

## Page counts are approximate until every range is laid out

`PageChunks.estimateChunkPages` estimates unmeasured ranges, so `count()` on a long
document is approximate until the reader has paged through enough material. Documented
behaviour, tolerated deliberately; the suite allows for it.

---

## Tab after undo (list indent) — mitigated

Historically, after undo a frozen format-selection snapshot (or fallback index `0`)
could name a non-list block while the caret sat on a list item: Tab `preventDefault`ed
without indenting, while a direct `applyListIndentToSelection(1)` still worked.

**Mitigation:** clear format freeze on undo/redo; prefer live selection / caret for list
Tab (`js/modules/04-lists.js`, commit `01efea8`). If `editing-sweep-app` still reports
"Tab indents a list item", re-characterise — do not re-file the old freeze theory without
measurement.
