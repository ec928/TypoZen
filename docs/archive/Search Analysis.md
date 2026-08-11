# Search Implementation Plan: Root Cause Analysis

The implementation plan identified real bugs but **its fixes are insufficient**. Here's why, traced from your screenshots.

## What the Screenshots Prove

| Step                                | Expected StickyLine    | Actual StickyLine |
| :---------------------------------- | :--------------------- | :---------------- |
| Cursor at line 100                  | 100                    | 100 ✅             |
| Alt-S opens sidebar (no search yet) | 100                    | **90** ❌          |
| Type "scroll", press Enter          | 100 (first match ≥100) | **62** ❌          |

------

## Bug A: StickyLine drifts from 100 → 90 on sidebar open (NOT addressed by the plan)

CAUTION

The implementation plan completely missed this bug. It is the root cause that makes everything else fail.

### The chain of events:

1. User presses Alt-S → `toggle_search_sidebar` in 03-shell.js:1400 runs `sidebar.classList.remove('collapsed')`

2. The sidebar appearing **shrinks the editor width** → content reflows → the browser fires a native `scroll` event on `#main-container`

3. The scroll listener at 03-shell.js:404-411 fires:

   ```
   javascript
   
   
   
   
   
   mainContainer.addEventListener('scroll', function () {
   
       if (typeof _progScrollUntil !== 'undefined' && Date.now() <= _progScrollUntil) return;
   
       if (typeof rememberStickyFromPreviewScroll === 'function')
   
           rememberStickyFromPreviewScroll();
   
   }, { passive: true });
   ```

4. `rememberStickyFromPreviewScroll()` at 04b-format.js:1148-1154 calls `hardLineFromPreviewViewport()` → gets the viewport center (line 90 after reflow) → calls `rememberStickyLine(90)` → **`_stickyLineCache` = 90**.

### Why the plan's Bug 2 fix doesn't help here

The plan's fix guards `captureStickyDocumentLine()` with a `sidebarFocused` check. But the corruption doesn't go through `captureStickyDocumentLine()` at all — it goes through `rememberStickyFromPreviewScroll()`, which is a completely separate code path with **no sidebar guard**.

At the moment the scroll event fires, focus is still in the editor (the sidebar CSS just changed; `focusSidebarSearchInput` hasn't been called yet). So even if there *were* a sidebar check in the scroll handler, it wouldn't trigger.

### The fix needed

In the `toggle_search_sidebar` handler, **save `_stickyLineCache` before opening the sidebar** and **restore it after**:

```
javascript





// At the top of the "open" branch, before sidebar.classList.remove('collapsed'):

const savedSticky = (typeof _stickyLineCache !== 'undefined') ? (_stickyLineCache | 0) : null;



sidebar.classList.remove('collapsed');

postSidebarState();



// Restore what the reflow-scroll just corrupted:

if (savedSticky !== null && savedSticky >= 1 && typeof rememberStickyLine === 'function') {

    rememberStickyLine(savedSticky);

}
```

Alternatively or additionally, `rememberStickyFromPreviewScroll` should set `_progScrollUntil` during sidebar transitions to suppress the scroll handler.

------

## Bug B: `syncSearchIndexToLocation` uses corrupted stickyLine → lands on wrong match

Because Bug A corrupted `_stickyLineCache` to 90, `syncSearchIndexToLocation` reads `targetLine = 90` instead of `100`. But the screenshot shows it landed on match 31 (line 74), which is *before* 90. That means the sync loop didn't even work correctly with the corrupted value — but the root cause is that `targetLine` was wrong to begin with.

The plan's `syncSearchIndexToLocation` rewrite is **logically correct** (comparing document line numbers on both sides), but it's moot when the input (`_stickyLineCache`) is already corrupted.

### Additional concern: `documentLineForModelOffset` accuracy

The screenshot shows StickyLine: 62 after navigating to the match highlighted at "Line 74". This is set by `revealModelMatch` → `documentLineForModelOffset(match.start)` → `rememberStickyLine(matchLine)`.

If `documentLineForModelOffset` returns 62 for a match that's in the text "Line 74 of 4582", either:

- The function is computing line numbers incorrectly for this file (possible off-by-one in block boundaries), OR
- The match at index 31 is actually in a *different* block than expected (e.g., a heading "Section 3 of 140" that also contains "scroll" in a nearby block, and the block's start line is 62)

This needs instrumentation to verify: log `documentLineForModelOffset(findState.matches[31].start)` vs the sidebar's rendered line number for match 31.

------

## Bug C: `commitSearchFocus` restores to corrupted position

The plan's Bug 4 fix uses `_stickyLineCache` to find the block to focus. This is correct **in principle**, but since `_stickyLineCache` was corrupted by Bug A and further corrupted by Bug B, the restore position is wrong.

If Bug A is fixed (stickyLine stays at 100 through the open), then after navigating to a match and pressing Alt-S to close, `_stickyLineCache` would reflect the match position (correct behavior per requirement 3: "Navigating the search results updates the current location").

------

## Summary: Plan Assessment

| Plan Bug Fix                      | Correct Analysis?                                          | Fix Sufficient?                                              |
| :-------------------------------- | :--------------------------------------------------------- | :----------------------------------------------------------- |
| Bug 1 (syncSearchIndexToLocation) | ✅ Correct: old code compared block indices to line numbers | ⚠️ Fix is correct but useless without Bug A fixed             |
| Bug 2 (captureStickyDocumentLine) | ⚠️ Partially correct                                        | ❌ **Missed the real corruption path**: `rememberStickyFromPreviewScroll` on the scroll listener, not `captureStickyDocumentLine` |
| Bug 3 (Enter handler)             | ✅ Correct: old code navigated to match[0]                  | ✅ Fix is correct                                             |
| Bug 4 (commitSearchFocus)         | ✅ Correct: should use _stickyLineCache                     | ✅ Fix is correct (once _stickyLineCache is reliable)         |

IMPORTANT

**The plan missed the most critical bug entirely**: the sidebar open/close causes a viewport reflow that triggers `rememberStickyFromPreviewScroll()` via the native scroll event, corrupting `_stickyLineCache` before any search logic even runs.

Without fixing this, all four of the plan's fixes operate on corrupted data.

## Recommended Fix Order

1. **Fix Bug A first** (save/restore `_stickyLineCache` around sidebar open in `toggle_search_sidebar`) — this makes the input data reliable
2. **Verify `documentLineForModelOffset` accuracy** — instrument to confirm StickyLine matches sidebar line numbers
3. Plan's Bug 1-4 fixes are fine to keep as-is (they're already applied)