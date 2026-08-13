# For agents working on TypoZen

Read this before inventing scope, filing “bugs”, or rewriting keyboard behaviour.
Product truth lives here and in the README; `docs/archive/` is history.

## What TypoZen is

- **Windows prose editor + reader**: WPF shell + WebView2; Markdown/text in Preview/Source; epubs in Reader; PDF/images/media as native read-only tabs.
- **Not a code editor.** A developer/code surface was attempted and **parked** (file corruption via contenteditable). See `docs/developer-editor-analysis.md`. Do not revive code-kind / fence-as-document editing unless the user explicitly reopens that work.
- **Not ZenSeek.** CLI hooks (`--reader`, `--search`, …) exist for ZenSeek; do not merge the two apps.
- **Native Reader:** PDF, images, and media open as read-only tabs under Reader-like chrome on a **second WebView** (`OpenNative` / `localview` in `TypoZen_App.cs`) — not DocumentModel. Images use a fit shell (speed); Edge right‑click Magnify for zoom/pan. Scrubber is editor-page only — absent on native tabs. App Privacy Mode already covers history/session; native files are not book-style temp extracts. See `docs/native-reader-plan.md`.

## Where truth lives

| Document | Use |
|----------|-----|
| `README.md` | User-facing product behaviour (current) |
| `docs/for-agents.md` | This file — constraints, keyboard matrix, non-goals |
| `docs/known-issues.md` | Open defects **reproduced and characterised** only |
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
- Highlighter fallback `: 0` — if a match has no range, the view can land on a **different** match (often top of doc). Not data loss. See `docs/known-issues.md`.

## Layout / view rules agents hit often

- **Word Wrap**: applies in Source and **scroll** Preview only. On Pages, Reader, or epub the menu item is **disabled** (no fake tick); preference is stored and returns when wrap applies.
- **Sticky mode switch** (Preview ↔ Source ↔ Reader): keep the same hard document line for status **and** scroll; re-capture after expand. Tests: `mode-switch-line-selftest`, `mode-switch-sticky-e2e`.
- **Page counts** are approximate until ranges are measured (`PageChunks.estimateChunkPages`). Tolerated; suites allow for it.
- **Multi-block Delete** in Preview goes through the **model** (freeze + reload), not browser multi-range delete alone.
- **Tab after undo** (list indent): clear format-selection freeze on undo/redo; prefer live caret for list Tab (`04-lists.js`). Was a real defect; mitigated — re-check `editing-sweep-app` if touching list Tab.

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

- `page-arrow-keys-app.mjs` — Preview: arrows = caret, PageDown pages; Reader: arrows page. Does **not** fully cover search-mode Left/Right.
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
