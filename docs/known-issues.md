# Known issues

Open defects, each with what is actually known about it rather than a symptom. A line
here means it has been reproduced and characterised; anything not reproduced is not
listed.

Verified against `baseline-2026-08-12` where noted, so "pre-existing" means measured
rather than assumed.

---

## Tab does not indent a list item after an undo

**Where:** Preview, every layout. `editing-sweep-app` reports it as
"Tab indents a list item".

**What actually happens:** Tab works. Pressing it on a list item indents the item, in
1-column Scroll, 1-column Pages and 2-column Pages -- verified directly, dispatching the
key at both `#editor` and the focused element. It stops working after a particular
sequence, and only then.

Narrowed by bisecting the sweep's own steps:

| Sequence | Result |
|---|---|
| Tab on a clean document | indents |
| `applyListIndentToSelection(1)` called directly, any state | returns `true`, indents |
| Enter on a bullet, 8 undos, then Tab | **prevented, but does not indent** |
| Tab, undo it, Enter on a bullet, 8 undos, then Tab | **prevented, does not indent** |

So the keystroke reaches the handler -- `defaultPrevented` is `true` -- and the indent
does not happen, while the same function called by hand in the same state succeeds.

**Ruled out by measurement:**

- the handler not firing (it fires, and prevents default)
- the indent logic (returns `true` and indents when called directly after the same undos)
- stale `data-model-index` after undo (checked every mounted block against the model
  after an edit and eight undos: zero mismatches)
- layout (fails identically in all three)
- the dispatch target (`#editor` and the focused element behave the same)

**Likely cause (addressed):** after undo, a **frozen format-selection snapshot** (or a
fallback index of `0`) could name a non-list block while the caret was back on a list
item. `applyListIndentToSelection` then found no list lines and returned `false`, but
the Tab keydown still `preventDefault`ed (keep-focus path). A later direct call or a
second Tab saw a live caret and worked.

**Mitigation in code:** clear format freeze on undo/redo; prefer live selection for
list indent; fall back to the caret / active block when the index set has no list line.

**Impact:** low historically (second Tab worked). Re-check `editing-sweep-app` after the
mitigation.

---

## `external-find-focus-app`: one assertion fails

Pre-existing and unchanged from the baseline. Not investigated.

## `epub-open-app`: produces no result

Pre-existing and unchanged from the baseline. Not investigated.

---

## The `: 0` fallback in the search highlighter

`highlightModelMatchInMountedDom` ends with
`ranges[currentRange >= 0 ? currentRange : 0]`. When the requested match has no range,
the view is scrolled to a **different** match -- whichever was built first, which is the
top of the document.

The image case is handled at the caller (a match on an image-only line travels nowhere,
deliberately), but the general defect remains for any match with no range. Removing the
fallback outright was tried and regressed `search-highlight-app`: `currentRange` is `-1`
in more cases than that one.

## Page counts are approximate until every range is laid out

`PageChunks.estimateChunkPages` estimates ranges that have not been measured, so
`count()` is approximate on a long document until it has been paged through. Documented
behaviour, tolerated deliberately, and the suite allows for it.
