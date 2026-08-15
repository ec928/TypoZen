# For agents working on TypoZen

Read this before inventing scope, filing “bugs”, or rewriting keyboard behaviour.
Product truth lives here and in the README; `docs/archive/` is history.

## What TypoZen is

- **Windows prose editor + reader**: WPF shell + WebView2; Markdown/text in Preview/Source; epubs in Reader; PDF/images/media as native read-only tabs.
- **Not a code editor.** A developer/code surface was attempted and **parked** (file corruption via contenteditable). See `docs/developer-editor-analysis.md`. Do not revive code-kind / fence-as-document editing unless the user explicitly reopens that work.
- **Not ZenSeek.** CLI hooks (`--reader`, `--search`, …) exist for ZenSeek; do not merge the two apps.
- **Native Reader:** PDF, HTML, images, media — second WebView. HTML Mode: **Source** = edit markup; **Reader** = read-only real page; **Preview locked** (Preview is Markdown editor mode, not HTML). CSS/XML/XAML → editor Source. See `docs/native-reader-plan.md`.

## Where truth lives

| Document | Use |
|----------|-----|
| `README.md` | User-facing product behaviour (current) |
| `docs/for-agents.md` | This file — constraints, keyboard matrix, non-goals |
| `docs/known-issues.md` | Product limits + fixed/mitigated notes (not a dump of suite noise) |
| `docs/developer-editor-analysis.md` | Parked code-editor attempt |
| `docs/archive/` | Historical plans and decision records — not current contracts |

If README and code disagree, fix one of them; do not paper over with a third story.

## Do not invent defects

- A failing or silent **test suite** is not automatically a product bug. Suite health (harness, fixtures, env) stays out of `known-issues.md` until a user-visible defect is reproduced.
- Do not list “pre-existing / not investigated” suite lines. Characterise or drop.
- Folklore from older comments is not product law. Prefer the keyboard matrix below and the handlers that implement it.
- Hygiene nitpicks (rename, reformat, “thin the arrows”) are out of scope unless asked.

## Keyboard model (product)

Implemented in:

- `js/modules/05-model.js` — page / scroll keydown (capture)
- `js/modules/02-layout.js` — `bindReaderFindKeys` (Up/Down → search hits)

**Search mode** means: `findState.matches.length > 0` (a live result list), not “sidebar is open”.

| Context | PageUp / PageDown | Arrow Left / Right | Arrow Up / Down | Space / Shift+Space |
|---------|-------------------|--------------------|-----------------|---------------------|
| **Preview, Pages** (caret, no search hits) | Turn page (`PageMap.step`) | Move caret | Move caret | Type space / select |
| **Preview, Pages + search hits** | Turn page | Turn page | Prev / next hit | Type space |
| **Reader / book, Pages** (no hits) | Turn page | Turn page | Turn page | Turn page |
| **Reader / book + search hits** | Turn page | Turn page | Prev / next hit | Turn page |
| **Preview, Scroll** | Scroll `#main-container` | Caret / default | Caret; with hits → step hits | Space types (Reader-like only pages with Space) |
| **Source** | Default textarea | Default | Default | Default |
| **INPUT / TEXTAREA / sidebar / find bar** | Leave alone | Leave alone | Leave alone | Leave alone |

### Critical implementation rules

1. **Never** early-return the page handler solely because `#editor` is `contenteditable`. That made PageUp/PageDown dead in Preview. Bail only for real fields: `INPUT`, `TEXTAREA`, and chrome (`#sidebar`, `#findBar`, `#tableModal`).
2. **Reader** sets `#editor` `contenteditable="false"`. That is the reliable signal for “no caret to move” (not a mode-name guess alone).
3. **Wheel** always turns pages when `state.pageAdvance` (outside the sidebar).
4. Up/Down with hits are owned by `bindReaderFindKeys` (capture). The page handler must **return** for those keys when hits exist so search wins.
5. There is **no** `,` `.` `<` `>` search chord. Removed: collided with typing.

Help: **F1** / **Help → Syntax & Shortcuts** → `#helpModal`. **Help → About TypoZen** → `#aboutModal`. Both are themed in-page overlays (`openTzOverlay` in `03-shell.js`), not `alert` / MessageBox. Debug HUD: **Ctrl+Shift+D**.

## Search UX (related)

- Whole-document model search; virtualized docs still find off-screen matches.
- Match case / whole word shared between Ctrl+F and sidebar (`Alt+S`).
- Recent searches: last **8**, **global** (not per tab), in `settings.json`.
- **F3** / **Shift+F3** also step next/prev.
- **Image-only lines** (query hits asset path): jump via block navigation; do **not** text-highlight or fall back to another match. Sidebar badge is clickable.
- **Highlighter:** only scroll when `currentRange` names this match. Never `ranges[0]` as a substitute target.
- Search and Marks jumps share **`flashMarkFocus`**. Status Ln after jump: pin sticky / prefer sticky when focus is outside the editor.

## Layout / view rules agents hit often

- **Word Wrap**: applies in Source and **scroll** Preview only. On Pages, Reader, or epub the menu item is **disabled** (no fake tick); preference is stored and returns when wrap applies.
- **Sticky mode switch** (Preview ↔ Source ↔ Reader): keep the same hard document line for status **and** scroll; re-capture after expand. Tests: `mode-switch-line-selftest`, `mode-switch-sticky-e2e`.
- **A page turn must never skip text.** `PageGeometry.localCount()` counts the content (`byContent`), never "pages reachable by `index x stride`" — a range's last page is partial, its start sits past `maxScroll`, and `go()` deliberately ends it there so the tail shows flush right. Dropping it from the count is how Pages mode lost a paragraph at every 800-block boundary, silently, at every font size. `localIndex()` must answer "parked at `maxScroll` = the last page", or the reader is stranded on it and `stepLocal` reads the turn as "did not move". Guarded by `page-coverage-app` — the other pagination suites only ask whether a turn *moves*, which a turn that skips a page passes.
- **Page totals** are estimates until every range is measured, and the UI says so (`pageTotalIsApproximate` → `43 / ~264`). The page you are **on** is always exact, and "the end" is the last **block**, never the last estimated page. Estimates refine in **both directions** — do *not* make `setMeasured` a ratchet "so a total never revokes a page": that was tried and reverted, because an estimate that cannot fall never converges, and every unvisited range froze at the seed (48 pages against a measured 20) leaving the total at double the document with no way back, which `pagination-browser`'s column round trip catches.
- **Never assert an exact page number against an estimated map.** Arriving measures ranges, so the total moves while a request is in flight and the number you asked for is not the number you land on — `page-count-truth-app` settles the map first (`PageChunks.allMeasured()`), `page-scrubber-app` seeks twice and asserts the second, and `pagination-browser` allows ±1 across a column switch while checking the *block* exactly. The content is the promise; the label is approximate and says so.
- **The gutter is bookmarks only.** One `::before` rail on `.block`, `--mark-ink`, four opacities: `0` unmarked, `.30` hover-unmarked ("click adds"), `1` marked, `.65` hover-marked ("click removes"). Hover previews the click; that is the whole design. Do **not** add a second meaning to that lane — a hover edge, a focus bar, anything. Both previous attempts were accent-coloured left borders, which is what `blockquote` already is, and the more specific selector always erased the bookmark.
- **No block-body hover cue exists** and none should be added. `View → Block Hover` is `off` / `gutter` (default) and controls the *preview only* — a bookmark that exists is always drawn, in Reader as well as Preview.
- **Never turn a cue off with `!important`.** The reader-mode rules that did were blanket-killing `box-shadow` and `background-color`, which took the bookmark rail and the arrival wash with them. Turning a cue off means not drawing it.
- **Do not widen `.block` padding to "make room" for the gutter.** It is `2px 8px`, and the 16px click strip (`wireMarkGutter`) deliberately overlaps the first characters — the selection guard in that handler is what arbitrates. Widening it to 16px was tried and reverted: block geometry feeds pagination, page windowing and the virtualisation decision, and it broke `edit-integrity-app`, `page-window-app`, `page-arrow-keys-app`, `multi-block-edit-app`, `editing-sweep-app` and `bookmark-pane-app` at once while every browser-level suite stayed green.
- **Marks list active row:** prefer marks visible on the spread (2-col), then list-click pin (pinned by *block*, not list index — `sortMarks` reorders), then last-before reading block.
- **Leave book → Preview:** set destination mode, then `setEditorEditable(true)`; `applyViewState` re-syncs editability.
- **Per-tab view bag (mode + columns):** written **only** by a deliberate choice — the column toggle, the Mode segment click, session restore. `SnapshotActiveTabView` records **position only**. Nothing derived from `_viewMode` / `_viewColumns` / `view_state` may write it: during a mount those describe what the page has managed to draw, not what the tab is for, and storing a book's first 1-col paint erases its spread.
- **Marks resolve only against a settled model.** `loadMarksPayload` does *not* resolve — `marks_load` often arrives while the previous tab is still mounted, and matching against it wrote the wrong document's index into `mark.hint`, which is persisted. `resolveMarksAfterDocumentLoad` is the one place a full resolve belongs; `armMarkSettleWatch` is the fallback for the other message ordering.
- **Fingerprints are cached per document** (`markFingerprintIndex`). A book block is publisher HTML, so a fingerprint is an HTML parse — 45,390 of them on the Xeelee omnibus. Invalidate via `invalidateMarkCaches` if you add a path that rewrites block raws.
- **Multi-block Delete** in Preview goes through the **model** (freeze + reload), not browser multi-range delete alone.
- **Tab after undo** (list indent): clear format-selection freeze on undo/redo; prefer live caret for list Tab (`04-lists.js`). Mitigated — re-check `editing-sweep-app` if touching list Tab.

## Module map (edit without rebuilding C#)

| Module | Concern |
|--------|---------|
| `01-core.js` | State, view selectors, sticky helpers |
| `02-layout.js` | Find/search, pagination, page window, search history, reader find keys |
| `03-shell.js` | onload, themes, host commands |
| `04-lists.js` | List indent, Tab/Backspace, multi-block edit paths that touch lists |
| `04b-format.js` | Inline format, clipboard, some key paths |
| `05-model.js` | DocumentModel, virt, page keyboard, load/save content |
| `06-render-epub.js` | Markdown render, epub, book styles |
| `07-stats-host.js` | Stats, outline, host sync |
| `08-code.js` | Fence highlighting (Highlight API only — not a code editor) |

Shell / host: `TypoZen_App.cs`, `TypoZen.xaml`, `EpubReader.cs`, `TypoZen_Launch.cs`. Rebuild exe only after `.cs` / project changes. JS/CSS/XAML/themes: reload.

## Tests

```powershell
.\tests\run-tests.ps1                          # default gate
$env:RUN_APP_E2E = '1'; .\tests\run-tests.ps1  # + real TypoZen.exe
```

- **`*-app.mjs` run against a throwaway profile**, one directory per suite (`TYPOZEN_PROFILE_DIR`, set by `app-harness.mjs`; use `profileFile('bookmarks.txt')`, never `%LOCALAPPDATA%`). Suites used to share the reader's real profile, which made them order-dependent — `bookmark-store` and `book-position` passed or failed on what had run before them — and left fixture bookmarks and reading positions in the reader's own data. A suite needing two tabs must **open** two; it can no longer inherit them from someone's last session.
- `page-arrow-keys-app.mjs` — Preview: arrows = caret, PageDown pages; Reader: arrows page. Does **not** fully cover search-mode Left/Right.
- **Never wait for a search with a fixed sleep.** `SIDEBAR_SEARCH_DEBOUNCE_MS` is 2000 and `runFind` then crosses the whole document. `search-perf-app` slept 1200ms and so could *never* pass — it reported nothing about search for as long as it was written that way — and `search-highlight-app` slept 2600ms, having already been re-tuned once from 1500. Poll for the state the assertions need (`findState.query === q && findState.matches.length > 0`); a sleep that was re-tuned once is a sleep that will be re-tuned again.
- **A red suite is more often a stale contract than a defect.** Of six failing app suites investigated in this tree, one was a product bug; three were suite debt and one asserted behaviour the product had deliberately superseded (image-only search results navigate now — the suite still demanded "the view does not move"). Read the assertion against current product truth before believing it.
- **`epub-open-app` stalls on the last book — unexplained, and NOT a product hang.** It reproducibly dies of a puppeteer `ProtocolError` immediately after the Xeelee cover assertions, in the density `evaluate`. Measured on the omnibus in isolation, every operation that eval performs is trivial: windowing mounts **800 of 45,486** blocks, `goToModelBlock` into the middle of the book takes **48ms**, and the `getClientRects` sweep over the mounted blocks takes **2ms**. So `goToModelBlock` is *not* slow, and mark / outline / search jumps in a huge book are fine — do not go looking for a hang there. What is not reproduced in isolation is the suite's own shape: four books opened in sequence in one long-lived instance, Xeelee last. Instrument the suite, not the product, and do not raise `protocolTimeout` to get past it — that was tried, and it only bought ten minutes of waiting for the same failure.
- Prefer characterising failures over deleting suites. Skip only when the environment truly cannot run (missing fixture / no display) — document why.

## Explicit non-goals (unless the user reopens them)

- True IDE / Scintilla-class code editing in Preview
- Merging TypoZen and ZenSeek
- “Thinning” or inventing alternate arrow schemes beyond the matrix above
- Remote git / PR unless asked (local repo is fine)
- Filing known-issues from suite names alone

## When you change product behaviour

1. Update the handlers and any suite that asserts the old rule.
2. Update **README** (user-facing) and **this file** (agent-facing) in the same change.
3. Only add to `known-issues.md` after reproduce + characterisation (or a deliberate tolerated limitation with a short why).
