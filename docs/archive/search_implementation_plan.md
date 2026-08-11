# Alt-S Search Implementation Requirements & Fix Guide

This document outlines the behavioral requirements for `Alt-S` search in TypoZen, the 4 bugs preventing them from working, and exact code-level fixes.

## Core Requirements

**1. Invocation**
- `Alt-S` immediately triggers and focuses the search tab input.

**2. Navigation & Interaction**
- **2a. Existing Search Results:** If there is already an active search result populated, pressing `Enter` or `ArrowDown` inside the search box will move focus to the current search match, meaning the **current location**. From there, pressing `ArrowUp` goes to the previous search match, and pressing `ArrowDown` goes to the next search match.
- **2b. No Search Results:** If there is no search result for the given query, nothing happens when interacting with the search box.
- **2c. New Search Queries:** If the user triggers a new search (types a new query), then presses `Enter` or `ArrowDown`, they must be taken to the search result that is located **immediately AFTER** their current reading/cursor position in the document.

**3. Current Location Tracking**
- Navigating the search results updates the **current location** to the line number of the search match.
- NOTE: there appears to be a bug where the search result current line isn't the same as the actual line in the edit window, so be careful.

**4. Dismissal & State Restoration**
- If the user presses `Alt-S` to close the search sidebar, the search closes and the user is returned to their **current location**, based accurately on where their cursor is (or the current page location if in reader mode), without any aggressive scrolling, jumping, or forced padding to the top of the screen.

---

## Architecture Overview (READ THIS FIRST)

The app is a WebView2-hosted web frontend. All JS files share page globals (no modules). Key files:

- **`js/modules/02-layout.js`** — Search sidebar UI, `findJumpTo`, `findStep`, `syncSearchIndexToLocation`, `commitSearchFocus`, `wireSearchResultKeys`, `runFind`, `revealModelMatch`, `documentLineForModelOffset`, `updateSearchSidebar`
- **`js/modules/03-shell.js`** — Global shortcuts including `Alt-S` handler (`toggle_search_sidebar` command at ~line 1393)
- **`js/modules/04b-format.js`** — Cursor/line tracking: `captureStickyDocumentLine`, `captureStickyDocumentLineLive`, `rememberStickyLine`, `_stickyLineCache`, `getCaretLineNumber`, `modelBlockStartLine`, `modelLocationFromDocumentLine`, `restoreStickyDocumentLine`, `hardLineFromPreviewViewport`

### Key data types — CRITICAL to understand
- **Document line number**: 1-based line in the full markdown document. This is what `_stickyLineCache` stores, what the status bar shows ("Ln 100"), and what `documentLineForModelOffset()` returns.
- **Block index**: 0-based index into `DocumentModel.blocks[]`. NOT a line number. A document with 4500 lines might have ~3700 blocks.
- **Markdown char offset**: 0-based character position in the concatenated markdown text. This is what `findState.matches[i].start` contains for model-kind searches.

### Key state variables
- `_stickyLineCache` (in 04b-format.js, line 1031): The last known good document line number. Updated by `rememberStickyLine()`.
- `_lastCaretLine` (in 04b-format.js): Also updated by `rememberStickyLine()`, always equals `_stickyLineCache`.
- `findState.index`: Which match is currently active (0-based index into `findState.matches[]`).
- `findState.kind`: `'model'`, `'source'`, or `'visual'` — determines which haystack/offset system is in use.
- `currentActiveBlock`: DOM element of the last focused `.block` div.

### Key functions you'll use
- `rememberStickyLine(lineNum)` — sets `_stickyLineCache = lineNum` (04b-format.js:1033)
- `documentLineForModelOffset(charOffset)` — converts a markdown char offset to a 1-based document line number (02-layout.js:~300). This is the ACCURATE function used by the sidebar to render line numbers.
- `modelLocationFromDocumentLine(line1Based)` — returns `{ blockIndex, within }` (04b-format.js:1002)
- `focusBlock(el, offset)` — places caret in a block element
- `focusEditorNoScroll()` — gives focus to editor without scrolling
- `revealModelMatch(match, navigate, noFocus)` — scrolls to a match and highlights it. ALREADY calls `rememberStickyLine(matchLine)` at line ~3075. This means `_stickyLineCache` IS correctly updated when navigating via search results.

---

## Bug Analysis & Fixes

### BUG 0: Sidebar open/close corrupts `_stickyLineCache` via scroll reflow (ROOT CAUSE)

**Files:** `js/modules/03-shell.js` (toggle handler ~line 1400) and `js/modules/04b-format.js` (rememberStickyFromPreviewScroll, line 1148)

**Problem:** When Alt-S opens the search sidebar, `sidebar.classList.remove('collapsed')` shrinks the editor width. Content reflows, and the browser fires a native `scroll` event on `#main-container`. The scroll listener at 03-shell.js:404-411 calls `rememberStickyFromPreviewScroll()`, which computes the **viewport center** of the now-reflowed layout and writes it to `_stickyLineCache`. If the user was at line 100, this overwrites it to ~90 (the new viewport center after reflow).

This happens **before** `focusSidebarSearchInput` is called, so focus is still in the editor — the Bug 2 sidebar-focus guard doesn't apply. And this goes through `rememberStickyFromPreviewScroll()`, not `captureStickyDocumentLine()`, so Bug 2's fix is on the wrong function entirely.

The scroll listener code that fires:
```javascript
// 03-shell.js:404-411
mainContainer.addEventListener('scroll', function () {
    if (typeof _progScrollUntil !== 'undefined' && Date.now() <= _progScrollUntil) return;
    if (typeof rememberStickyFromPreviewScroll === 'function')
        rememberStickyFromPreviewScroll();
}, { passive: true });
```

And `rememberStickyFromPreviewScroll` (04b-format.js:1148):
```javascript
function rememberStickyFromPreviewScroll() {
    if (state.mode === 'source') return;
    try {
        const line = hardLineFromPreviewViewport();
        if (line >= 1) rememberStickyLine(line);  // <-- OVERWRITES _stickyLineCache
    } catch (e) {}
}
```

**Fix:** In the `toggle_search_sidebar` handler (03-shell.js ~1399), save `_stickyLineCache` before the sidebar opens and restore it after the reflow:

```javascript
// OPENING branch — before sidebar.classList.remove('collapsed'):
const savedSticky = (typeof _stickyLineCache !== 'undefined') ? (_stickyLineCache | 0) : null;

sidebar.classList.remove('collapsed');
postSidebarState();

// Restore what the reflow-scroll just corrupted:
if (savedSticky !== null && savedSticky >= 1 && typeof rememberStickyLine === 'function') {
    rememberStickyLine(savedSticky);
}

if (typeof switchTab === 'function') switchTab('search');
// ... rest of the handler continues unchanged
```

The same save/restore pattern should also wrap the CLOSING branch (sidebar.classList.add('collapsed')), since collapsing also triggers a reflow scroll that could corrupt the cache:

```javascript
// CLOSING branch — before sidebar.classList.add('collapsed'):
const savedStickyClose = (typeof _stickyLineCache !== 'undefined') ? (_stickyLineCache | 0) : null;

sidebar.classList.add('collapsed');
postSidebarState();

// Restore before commitSearchFocus reads it:
if (savedStickyClose !== null && savedStickyClose >= 1 && typeof rememberStickyLine === 'function') {
    rememberStickyLine(savedStickyClose);
}

cancelSidebarSearchIdle();
// ... rest of close handler
```

**Why this is the root cause:** Without this fix, `_stickyLineCache` is wrong from the moment the sidebar opens. Every downstream function — `syncSearchIndexToLocation`, `commitSearchFocus`, the Enter handler — reads the corrupted value and produces wrong results. Bugs 1-4 are all correct fixes, but they operate on garbage input.

---

### BUG 1: `syncSearchIndexToLocation` is completely broken (MOST CRITICAL)

**File:** `js/modules/02-layout.js`, lines 3182-3232

**Problem:** The function tries to call `modelBlockStartLineToIndex(line)` to convert a sticky line number into a comparable position. **This function does not exist anywhere in the codebase.** The `typeof` guard silently skips it. The fallback chain produces garbage:

1. `currentActiveBlock` → `DocumentModel.modelIndexOfEl()` → gives a **block index** (e.g., 8)
2. `_stickyLineCache - 1` → gives a **line number minus 1** (e.g., 99)

The comparison loop compares `targetPos` against `matchPos` from `markdownOffsetToBlock().blockIndex` (a **block index**). When `targetPos` is 99 (a line number) and match block indices are 0-70, EVERY match is "before" the target. Result: `bestIdx` lands on the last match instead of the first match after the cursor.

**Fix:** Rewrite to use **document line numbers** for both sides:

```javascript
window.syncSearchIndexToLocation = function() {
    try {
        if (!findState.matches || findState.matches.length === 0) return;

        // Get the user's current line (already a 1-based document line number)
        let targetLine = (_stickyLineCache | 0) || 1;

        // For source mode, compute line from cursor position
        if (state.mode === 'source' && typeof sourceEditor !== 'undefined' && sourceEditor) {
            const pos = sourceEditor.selectionStart || 0;
            targetLine = sourceEditor.value.substring(0, pos).split(/\r?\n/).length;
        }

        // Find the first match whose document line is >= targetLine
        let bestIdx = 0; // default to first match
        if (findState.kind === 'source') {
            // Source mode: compare char offsets directly
            const targetPos = (state.mode === 'source' && sourceEditor) 
                ? (sourceEditor.selectionStart || 0) : 0;
            for (let i = 0; i < findState.matches.length; i++) {
                if (findState.matches[i].start >= targetPos) {
                    bestIdx = i;
                    break;
                }
                bestIdx = i; // fallback to last
            }
        } else {
            // Model/visual mode: compare document line numbers
            for (let i = 0; i < findState.matches.length; i++) {
                let matchLine = 1;
                if (findState.kind === 'model' && typeof documentLineForModelOffset === 'function') {
                    matchLine = documentLineForModelOffset(findState.matches[i].start);
                } else if (findState.kind === 'visual') {
                    // For visual, use block start line as approximation
                    try {
                        const blk = findState.ranges && findState.ranges[i]
                            ? getAncestorBlock(findState.ranges[i].startContainer) : null;
                        if (blk && typeof DocumentModel !== 'undefined' && typeof modelBlockStartLine === 'function') {
                            const mi = DocumentModel.modelIndexOfEl(blk);
                            if (mi >= 0) matchLine = modelBlockStartLine(mi);
                        }
                    } catch (e) {}
                }
                if (matchLine >= targetLine) {
                    bestIdx = i;
                    break;
                }
                bestIdx = i;
            }
        }

        findState.index = bestIdx;
        updateFindCount();
        updateSearchSidebar();
    } catch (e) {}
};
```

---

### BUG 2: `captureStickyDocumentLine` returns viewport center when sidebar has focus

**File:** `js/modules/04b-format.js`, lines 1161-1205

**Problem:** When focus is on `sidebarSearchInput`, `document.activeElement` is the input element, not the editor. The function falls through all checks to the bottom "mode button stole focus" branch (line 1198):
```javascript
const chosen = Math.max(frozen, viewLine | 0);
```
where `viewLine` comes from `hardLineFromPreviewViewport()` → `modelIndexAtViewportCenter()` → `modelBlockStartLine(mi)`. This is the line of the block at the **viewport center**, NOT the user's cursor position. That's why DebugHUD shows line 90 when cursor was at line 100.

**NOTE:** This fix alone is insufficient because the main corruption path is through `rememberStickyFromPreviewScroll` (Bug 0), not this function. However, this fix is still needed to prevent `captureStickyDocumentLine` from overwriting the cache when called while the sidebar has focus (e.g., during mode switches).

**Fix:** Add an early return after the source-mode block (after line 1176, before "Preview: prefer what is on screen"). If focus is in the sidebar, return the `frozen` cache directly:

```javascript
// After line 1176 (return frozen; for source mode focus gone)
// and before line 1177 (// Preview: prefer what is on screen...)

// Sidebar search has focus — the frozen cache IS the user's position.
// Do NOT consult viewport center, it's inaccurate.
const sidebarFocused = document.activeElement && (
    document.activeElement.id === 'sidebarSearchInput' ||
    (document.activeElement.closest && document.activeElement.closest('#tab-search'))
);
if (sidebarFocused) {
    return frozen;
}
```

Insert this block at line 1177, before the comment `// Preview: prefer what is on screen over a stale caret after scroll.`

---

### BUG 3: Enter handler always jumps to match 0

**File:** `js/modules/02-layout.js`, lines ~930-943

**Current code (broken):**
```javascript
if (e.key === 'Enter') {
    e.preventDefault();
    cancelSidebarSearchIdle();
    closeSearchHistoryMenu();
    if (_sidebarSearchDebounce) { clearTimeout(_sidebarSearchDebounce); _sidebarSearchDebounce = null; }
    rememberSearchQuery(input.value);
    try { if (typeof captureReturnJump === 'function') captureReturnJump(); } catch (eRj) {}
    runFind(input.value, false, { navigate: true });  // <-- BUG: navigate:true with keepIndex=false → jumps to match[0]
    updateSidebarSearchCount();
    focusSearchResults();
}
```

`runFind` with `keepIndex=false` resets `findState.index` to 0. Then `navigate: true` navigates to `findState.matches[0]` — the FIRST match in the entire document.

**Fix:** Change to `navigate: false`, then manually sync and jump:

```javascript
if (e.key === 'Enter') {
    e.preventDefault();
    cancelSidebarSearchIdle();
    closeSearchHistoryMenu();
    if (_sidebarSearchDebounce) { clearTimeout(_sidebarSearchDebounce); _sidebarSearchDebounce = null; }
    rememberSearchQuery(input.value);
    try { if (typeof captureReturnJump === 'function') captureReturnJump(); } catch (eRj) {}
    runFind(input.value, false, { navigate: false });
    if (typeof syncSearchIndexToLocation === 'function') {
        try { syncSearchIndexToLocation(); } catch (eSync) {}
    }
    if (findState.matches && findState.matches.length > 0 && findState.index >= 0) {
        if (typeof window.findJumpTo === 'function') window.findJumpTo(findState.index);
    }
    updateSidebarSearchCount();
    updateSearchSidebar();
    focusSearchResults();
}
```

**Also fix the ArrowDown handler** (lines ~943-953). Currently it just calls `focusSearchResults()` without syncing. Change it to also sync and jump when there's a query with results:

```javascript
} else if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    cancelSidebarSearchIdle();
    if (!String(input.value || '').trim() && _searchHistory.length) {
        openSearchHistoryMenu();
        moveSearchHistoryHighlight(+1);
        return;
    }
    // Sync to current location and jump there
    if (findState.matches && findState.matches.length > 0) {
        if (typeof syncSearchIndexToLocation === 'function') {
            try { syncSearchIndexToLocation(); } catch (eSync) {}
        }
        if (findState.index >= 0 && typeof window.findJumpTo === 'function') {
            window.findJumpTo(findState.index);
        }
        updateSidebarSearchCount();
        updateSearchSidebar();
    }
    focusSearchResults();
}
```

---

### BUG 4: `commitSearchFocus` doesn't restore to correct position after search navigation

**File:** `js/modules/02-layout.js`, lines 3166-3180

**Current code:**
```javascript
window.commitSearchFocus = function() {
    try {
        if (state.mode === 'source') {
            if (typeof sourceEditor !== 'undefined' && sourceEditor && sourceEditor.style.display !== 'none') {
                sourceEditor.focus();
            }
        } else {
            if (typeof currentActiveBlock !== 'undefined' && currentActiveBlock && typeof focusBlock === 'function') {
                focusBlock(currentActiveBlock, 0);
            } else if (typeof focusEditorNoScroll === 'function') {
                focusEditorNoScroll();
            }
        }
    } catch (e) {};
};
```

**Problem:** `currentActiveBlock` may not have been updated during search navigation (it gets set in some paths of `revealModelMatch` but not reliably). Even when it was updated, the search results clearing (`runFind('')`) may destroy/unmount the DOM node it points to.

**Fix:** Use `_stickyLineCache` (which IS reliably updated by `revealModelMatch` → `rememberStickyLine`) to find the correct block:

```javascript
window.commitSearchFocus = function() {
    try {
        if (state.mode === 'source') {
            if (typeof sourceEditor !== 'undefined' && sourceEditor && sourceEditor.style.display !== 'none') {
                sourceEditor.focus();
            }
        } else {
            // Use _stickyLineCache to find the block to focus.
            // It was updated by revealModelMatch during search navigation.
            let handled = false;
            if (typeof _stickyLineCache !== 'undefined' && _stickyLineCache >= 1
                && typeof modelLocationFromDocumentLine === 'function'
                && typeof editor !== 'undefined' && editor) {
                try {
                    const loc = modelLocationFromDocumentLine(_stickyLineCache);
                    const el = editor.querySelector('.block[data-model-index="' + loc.blockIndex + '"]');
                    if (el && typeof focusBlock === 'function') {
                        focusBlock(el, 0);
                        handled = true;
                    }
                } catch (eSticky) {}
            }
            if (!handled) {
                if (typeof focusEditorNoScroll === 'function') {
                    focusEditorNoScroll();
                }
            }
        }
    } catch (e) {}
};
```

---

### CONCERN: `documentLineForModelOffset` may be inaccurate

**File:** `js/modules/02-layout.js`, lines 257-303

**Observation:** After navigating to a match that the sidebar labels "Line 74", the DebugHUD shows StickyLine: 62. Since `revealModelMatch` sets `_stickyLineCache` via `documentLineForModelOffset(match.start)`, this implies the function returned 62 for a match on line 74.

The function walks blocks counting `rawLen + 1` per block (the +1 is for a joining newline). If any block boundary is miscounted — for example, if "Section 3 of 140" (an `<h2>`) and the preceding blank line are merged into a single multi-line block — the accumulated line count will drift. The sidebar's own line numbers are also computed by `documentLinesForModelOffsets` (the batch version), so if the sidebar shows "74" correctly, the mismatch might come from `revealModelMatch` receiving a different `match.start` offset than the sidebar rendered for that row.

**Verification needed:** Log `documentLineForModelOffset(findState.matches[31].start)` vs the sidebar's rendered line number for match index 31. If they differ, there's a bug in how `findJumpTo` or `revealModelMatch` resolves the match. If they agree (both return 62), then the sidebar's displayed "74" comes from elsewhere (e.g., the match text itself containing "Line 74").

This is a secondary concern — fix Bug 0 first and retest. The StickyLine: 62 may simply be a consequence of `_stickyLineCache` being set by a stale scroll event *after* `revealModelMatch` sets it to the correct value.

---

## Important Notes for the Implementing AI

1. **Do NOT use `modelBlockStartLineToIndex`** — it doesn't exist. Don't try to define it either; the fix is to avoid needing it by using consistent units.

2. **`revealModelMatch` already calls `rememberStickyLine(matchLine)` at line ~3075** using the accurate `documentLineForModelOffset`. This means `_stickyLineCache` IS correctly updated when the user clicks a search result or navigates with ArrowUp/ArrowDown in the results list. You don't need to add extra `rememberStickyLine` calls in `findJumpTo` or `findStep` — the reveal functions handle it.

3. **`documentLineForModelOffset(offset)`** (02-layout.js:~300) is the CORRECT function for converting a match's char offset to a document line number. It walks blocks and counts newlines within multi-line blocks. Do NOT use `modelBlockStartLine(blockIndex)` for this — that only gives the FIRST line of the block.

4. **The `wireSearchResultKeys` function** (02-layout.js:~990) handles ArrowUp/ArrowDown when focus is in the results list. It calls `findStep(dir)` which calls `revealModelMatch` which calls `rememberStickyLine`. This chain is ALREADY CORRECT — no changes needed there.

5. **The `toggle_search_sidebar` handler** in 03-shell.js (~line 1393) handles both opening and closing. The OPEN path calls `syncSearchIndexToLocation` (which you're fixing in Bug 1). The CLOSE path calls `commitSearchFocus` (which you're fixing in Bug 4). **Both paths need the save/restore from Bug 0.**

6. **Test with the file `large-scroll-mixed.md`** which has lines like "Line 3 of 4582 — scroll marker row 3". Search for "scroll" — it has 2135 matches. The sidebar shows line numbers; verify they match the status bar's "Ln N" when you navigate to them.

7. **The DebugHUD** shows `StickyLine: N | CaretLine: N`. After your fixes, when you navigate to a search result at line 100, StickyLine should show 100, not 90 or some viewport-center approximation.

8. **Watch out for `rememberStickyFromPreviewScroll` after `revealModelMatch`**: `revealModelMatch` calls `restoreStickyDocumentLine(matchLine)` which scrolls the viewport. This scroll will fire the scroll listener which calls `rememberStickyFromPreviewScroll()`, potentially overwriting the just-set `_stickyLineCache`. The `_progScrollUntil` mechanism is supposed to suppress this, but verify it's being set by `restoreStickyDocumentLine`. If not, `revealModelMatch` should set `_progScrollUntil = Date.now() + 500` before calling `restoreStickyDocumentLine`.

## Order of Implementation

Apply fixes in this order (each builds on the previous):
1. **Bug 0 first** (save/restore _stickyLineCache around sidebar open/close) — this is the root cause; without it, nothing else works
2. **Bug 2 second** (captureStickyDocumentLine sidebar fix) — belt-and-suspenders for mode switches while sidebar is open
3. **Bug 1 third** (syncSearchIndexToLocation rewrite) — this makes location syncing work
4. **Bug 3 fourth** (Enter handler fix) — this uses the now-working sync
5. **Bug 4 last** (commitSearchFocus fix) — this uses the now-reliable `_stickyLineCache`
Focus fix) — this uses the now-reliable `_stickyLineCache`
