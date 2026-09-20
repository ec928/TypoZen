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
| `docs/releasing.md` | Build, package, release, Store. Read section 5 before touching install identity |
| `docs/store-listing.md` | Store listing copy and the certification answers, with field limits |
| `docs/fonts-ab.md` | Measured: loading only the active theme's fonts does not cut startup |
| `docs/scripts-ab.md` | Measured: concatenating the modules into one runtime script does not either |
| `docs/archive/` | Dated snapshots. Every health review lives here now -- none of them describes the current tree |
| `docs/archive/` | Historical plans and decision records — not current contracts |

If README and code disagree, fix one of them; do not paper over with a third story.

**Releasing, packaging and the Store:** [releasing.md](releasing.md). Build order, what
the build stages and why that list has been wrong twice, the two test tiers and how
app-tier suites have lied, MSIX and Store submission, and the install-identity rules —
read section 5 before touching the single-instance mutex, the open pipe or the profile
folder. Account-specific operational detail is in `docs/internal/`, which is not in git
because this repository is public.

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
6. **A WebView2 virtual host mapping must be installed BEFORE the page navigates.** One
   added afterwards never reaches the live document -- the renderer goes on resolving the
   name it was given at navigation time, and `SetVirtualHostNameToFolderMapping` reports
   no error. Measured 2026-09-15 in both directions: toggling Privacy Mode re-pointed
   `localload` at the correct folder, the payload was written there, the host and the file
   agreed, and every fetch still failed with `Failed to fetch`. Renaming the host per
   generation was tried and failed too, which is what isolated the cause to navigation
   timing rather than name reuse.

   So map **every** folder the page could ever fetch from at init -- `MapLoadHosts` and
   `MapBookHosts` -- and choose between the hosts when the URL is minted
   (`LoadHostName`, `BookHostName`). Never re-map mid-session. A payload cached with the
   canonical host baked in is rewritten to the current one as it is sent, which is why the
   book payload cache does not need invalidating.
7. **Privacy Mode cleans up on exit, not on the toggle.** Leaving the mode used to delete
   the private extraction directory immediately, which destroyed the images of a book the
   reader had open -- while a comment above it claimed an open book kept its directory.
   `EndPrivateSession` now only sweeps abandoned roots; `DisposePrivateSession` removes
   this process's root at exit, and the launch-time sweep covers a crash. Staged document
   bodies *are* dropped on the toggle, because the page has already consumed them.
   **Tidying up must never cost someone the thing they are using.**

Spelling: **not** `dictionary.tsv` (that is Look up). Preview uses WPF `TextBox` spellcheck (`SpellCheck.cs`, .NET 4 dictionaries); the page paints `::highlight(typozen-spell)` and the selection popover offers replacements. Source uses Chromium `spellcheck` on the textarea. `cmd:spell_check_doc` / `cmd:spell_next`. Do not feed WordNet to a spell loop.

Help: **F1** / **Help → Syntax & Shortcuts** → `#helpModal`. **Help → About TypoZen** → `#aboutModal`. Both are themed in-page overlays (`openTzOverlay` in `03-shell.js`), not `alert` / MessageBox. Debug HUD: **Ctrl+Shift+D**. F1 is bound in **two** places because Window.KeyDown does not run while the editor WebView has focus, and `AreBrowserAcceleratorKeysEnabled=false` can swallow Chromium Help: page JS (`02-layout.js`, next to F7/F8/F9) and the host `ThreadPreprocessMessage` filter (same path as Ctrl+Z). `cmd:help_syntax` **opens** the overlay; it does not toggle. Esc / the Close button dismisses it. Guarded by `scratch-hint-selftest` and `scratch-help-app`.

## Search UX (related)

- Whole-document model search; virtualized docs still find off-screen matches.
- Match case / whole word shared between Ctrl+F and sidebar (`Alt+S`).
- Recent searches: last **8**, **global** (not per tab), in `settings.json`.
- **F3** / **Shift+F3** also step next/prev.
- **Image-only lines** (query hits asset path): jump via block navigation; do **not** text-highlight or fall back to another match. Sidebar badge is clickable.
- **Highlighter:** only scroll when `currentRange` names this match. Never `ranges[0]` as a substitute target.
- Search and Marks jumps share **`flashMarkFocus`**. Status Ln after jump: pin sticky / prefer sticky when focus is outside the editor.

## Layout / view rules agents hit often

- **A native tab is a second surface, not a replacement.** PDF / image / media / HTML render in `_nativeWebView`; the editor WebView stays alive behind it holding your document. Two consequences bite. `SendMsg` refuses editor-document messages (`cmd:`, `fmt:`, `export_html`) while `_nativeSurfaceVisible` — without the gate Toggle Sidebar collapsed the sidebar of the document you were *not* looking at, About opened its modal on the hidden surface, and Ctrl+B bolded that document. The host key filter must not swallow those chords on a native tab (the PDF viewer can have Ctrl+B / Ctrl+F). And anything asking "what is the zoom" must read the surface on screen: `ZoomBy` and `WebView_ZoomFactorChanged` both read `_webView` unconditionally, so zoom stuck after one notch on a native tab and the status bar reported a number the content did not match. If something zoom-adjacent misbehaves, that is the shape. Guarded by `native-surface-app.mjs` — which also asserts every disabled menu is **given back**, because a menu greyed on a PDF and never restored is worse than the bug, and that Ctrl+B on the native tab does not dirty the hidden document (keys via `shell-ui.ps1`, not Puppeteer: CDP talks to the editor page even when a PDF is showing). Do not use `TypoZen_Template.html` as an HTML fixture: it runs TypoZen's own JS inside the viewer, including the Ctrl+wheel handler, so it behaves unlike any other page. Use `tests/native-sample.html`.
- **Disk vs buffer** is host-side (`DocTab.DiskWriteTimeUtc` / `DiskLength` / `DiskFingerprint`). Engine documents only. Check on window Activated, tab switch, folder `FileSystemWatcher` (debounced 400 ms), Save and Autosave. Clean → silent reload. Dirty → prompt. The **active** tab is pulled (`SyncActiveTabFromEditor`, not `allowStaleIfClean`) before a silent reload: host dirty flags lag the page, and a just-typed change plus a disk change must prompt, not wipe. `_e2eMode` skips checks so in-process suites that rewrite the open file do not silent-reload — unless `TYPOZEN_DISK_PROMPT=Yes|No|Cancel` is set, which stubs the MessageBox (a real dialog pumps the UI thread and hangs DevTools). `TYPOZEN_SAVE_AS_PATH` supplies a Save As target; unset with the stub means Save As cancelled. **Both stubs are gated on `Program.DebugLogEnabled`** and are inert in a normal launch. They have to be: the Save As stub sits in `SaveTabNow`, so ungated it would make Save As -- and saving an untitled document, and Export Book As -- return false with no dialog and no message for anyone who left the variable set in a shell. **`TYPOZEN_TAB_E2E` is gated the same way** (and `tests/tabs-content-e2e.py` launches with `--debug`): ungated it skipped session restore, ran the in-process harness, and quit. Guarded by `disk-conflict-app.mjs`. After our own atomic save, ignore watcher events for 2 s. Do not poll and do not hash on a timer. Reload uses the text already read for the stamp compare — do not `ReadTextFileDetect` a second time only to fill encoding.
- **Word Wrap**: applies in Source and **scroll** Preview only. On Pages, Reader, or epub the menu item is **disabled** (no fake tick); preference is stored and returns when wrap applies.
- **Sticky mode switch** (Preview ↔ Source ↔ Reader): keep the same hard document line for status **and** scroll; re-capture after expand. Tests: `mode-switch-line-selftest`, `mode-switch-sticky-e2e`.
- **The DOM is a projection; the document is `DocumentModel`.** Under virtualisation or page windowing the page holds a window — 54 blocks of 3767 while scrolling, 800 while paginated. Anything user-facing that reads the DOM instead of the model returns that window and calls it the document. This has bitten six times: saving, turning a page, Select All + copy, Print, Select All + cut/delete, and Export as HTML. Before adding any path that serialises, exports, prints, copies, cuts or persists, ask which of the two it is reading. Guarded by `page-coverage-app` (turns and scrolling), `clipboard-roundtrip-browser` (copy, cut, export, and save, on the default gate), and `page-integrity-app` — which asks the question coverage cannot: after paging deep into 2-column with 800 of 3767 blocks mounted, the save payload must still be the whole file byte for byte, the document must not have been dirtied by reading it, and the text painted at model index *i* must be block *i*'s text. `selectionIsWholeEditor` is the Select All predicate — `getAncestorBlock` stops at `#editor` and will not see it.
- **A coverage test needs a premise assertion.** "No block was skipped" cannot fail on a fully mounted document, so every such test asserts first that the DOM really is a window (`mounted < model.blocks.length`, virt on). The first version of the copy guard shipped green against a seven-line fixture and proved nothing; the first placement of the scroll walk inherited the page-windowed state and proved nothing. Both were caught by the premise, and a test that cannot fail is worse than no test because it reads as cover.
- **A page turn must never skip text.** `PageGeometry.localCount()` counts the content (`byContent`), never "pages reachable by `index x stride`" — a range's last page is partial, its start sits past `maxScroll`, and `go()` deliberately ends it there so the tail shows flush right. Dropping it from the count is how Pages mode lost a paragraph at every 800-block boundary, silently, at every font size. `localIndex()` must answer "parked at `maxScroll` = the last page", or the reader is stranded on it and `stepLocal` reads the turn as "did not move". Guarded by `page-coverage-app` — the other pagination suites only ask whether a turn *moves*, which a turn that skips a page passes. `page-coverage-app` walks **forward** for a fixed 100 turns and reaches block 1554 of 3767, so the two cases outside it have their own guard in `page-reverse-coverage-app`: paging to the **end** (the last page of the last range is the one a partial forward walk can never look at) and paging **back**, where `localIndex()` parked at `maxScroll` is what stops a step reading as "did not move".
- **Page totals** are estimates until every range is measured, and the UI says so (`pageTotalIsApproximate` → `43 / ~264`). The page you are **on** is always exact, and "the end" is the last **block**, never the last estimated page. Estimates refine in **both directions** — do *not* make `setMeasured` a ratchet "so a total never revokes a page": that was tried and reverted, because an estimate that cannot fall never converges, and every unvisited range froze at the seed (48 pages against a measured 20) leaving the total at double the document with no way back, which `pagination-browser`'s column round trip catches.
- **Never assert an exact page number against an estimated map.** Arriving measures ranges, so the total moves while a request is in flight and the number you asked for is not the number you land on — `page-count-truth-app` settles the map first (`PageChunks.allMeasured()`), `page-scrubber-app` seeks twice and asserts the second, and `pagination-browser` allows ±1 across a column switch while checking the *block* exactly. The content is the promise; the label is approximate and says so.
- **The gutter is bookmarks only.** One `::before` rail on `.block`, `--mark-ink`, four opacities: `0` unmarked, `.30` hover-unmarked ("click adds"), `1` marked, `.65` hover-marked ("click removes"). Hover previews the click; that is the whole design. Do **not** add a second meaning to that lane — a hover edge, a focus bar, anything. Both previous attempts were accent-coloured left borders, which is what `blockquote` already is, and the more specific selector always erased the bookmark.
- **No block-body hover cue exists** and none should be added. `View → Block Hover` is `off` / `gutter` (default) and controls the *preview only* — a bookmark that exists is always drawn, in Reader as well as Preview.
- **Never turn a cue off with `!important`.** The reader-mode rules that did were blanket-killing `box-shadow` and `background-color`, which took the bookmark rail and the arrival wash with them. Turning a cue off means not drawing it.
- **Do not widen `.block` padding to "make room" for the gutter.** It is `2px 8px`, and the 16px click strip (`wireMarkGutter`) deliberately overlaps the first characters — the selection guard in that handler is what arbitrates. Widening it to 16px was tried and reverted: block geometry feeds pagination, page windowing and the virtualisation decision, and it broke `edit-integrity-app`, `page-window-app`, `page-arrow-keys-app`, `multi-block-edit-app`, `editing-sweep-app` and `bookmark-pane-app` at once while every browser-level suite stayed green.
- **Marks list active row:** prefer marks visible on the spread (2-col), then list-click pin (pinned by *block*, not list index — `sortMarks` reorders), then last-before reading block.
- **A new tab is empty.** Do not inject "# Untitled Document" or "Start typing here..." as markdown — that is document text, not a hint. The hint is `#editor-wrapper.scratch-empty::after`. Never put visible `content:` on `#editor .block::before` (that pseudo is the 10px bookmark gutter). `getBlockRaw` must not read `innerText` of an empty `data-raw` (Chromium includes `::before`).
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
.\tests\run-tests.ps1                          # default gate — this is the gate
$env:RUN_APP_E2E = '1'; .\tests\run-tests.ps1  # + real TypoZen.exe (slow; only if you changed the WPF shell / pagination that Chrome cannot see)
```

- **Do not run `RUN_APP_E2E` to "be thorough"** after a JS/CSS change. The default gate already includes headless Chrome (`*-browser.mjs`). The `*-app.mjs` suites launch `TypoZen.exe` and take minutes; they exist because column switching was green in Chrome and broken in the app. They are not a general confidence ritual.
- **Never `await sleep(n)` for synchronisation.** Import `settled` / `settledApp` / `untilPage` from `tests/settle.mjs` and poll the condition. `launchApp({ settleMs })` is a **timeout cap**, not a mandatory pause — do not add `settleMs: 6000` to "make it safe".
- **Never park `await sleep` inside `app.eval` / `page.evaluate`.** One CDP call, one short question. Do not raise `protocolTimeout` (tried at 600s; it does not work). `evalPatiently` waits out an in-flight evaluate; it must not send another while the first is still running (that stacked remounts and was the Xeelee density stall).

- **`*-app.mjs` run against a throwaway profile**, one directory per suite (`TYPOZEN_PROFILE_DIR`, set by `app-harness.mjs`; use `profileFile('bookmarks.txt')`, never `%LOCALAPPDATA%`). Suites used to share the reader's real profile, which made them order-dependent — `bookmark-store` and `book-position` passed or failed on what had run before them — and left fixture bookmarks and reading positions in the reader's own data. A suite needing two tabs must **open** two; it can no longer inherit them from someone's last session. `launchApp({ env })` is for per-launch stubs (`TYPOZEN_DISK_PROMPT`); the harness profile directory still wins.
- `page-arrow-keys-app.mjs` — Preview: arrows = caret, PageDown pages; Reader: arrows page. Does **not** fully cover search-mode Left/Right.
- **Never wait for a search with a fixed sleep.** `SIDEBAR_SEARCH_DEBOUNCE_MS` is 2000 and `runFind` then crosses the whole document. `search-perf-app` slept 1200ms and so could *never* pass — it reported nothing about search for as long as it was written that way — and `search-highlight-app` slept 2600ms, having already been re-tuned once from 1500. Poll for the state the assertions need (`findState.query === q && findState.matches.length > 0`); a sleep that was re-tuned once is a sleep that will be re-tuned again.
- **A red suite is more often a stale contract than a defect.** Of six failing app suites investigated in this tree, one was a product bug; three were suite debt and one asserted behaviour the product had deliberately superseded (image-only search results navigate now — the suite still demanded "the view does not move"). Read the assertion against current product truth before believing it.
- **`epub-open-app` stall is NOT a product hang.** Isolated, the omnibus is fine: windowing mounts **800 of 45,486** blocks, a 60% seek arrives in ~120 ms. The suite **relaunches between Matter and Xeelee on a wiped profile**, fires seeks once, and skips the find walk on the 8.1 MB book (one sync pass; CDP cannot wait it out). Do not raise `protocolTimeout`. See `docs/archive/health-review-2026-08-28-combined.md`.
- **Unhandled UI faults stop automatic writes.** `DocumentStateSuspect` is set from `DispatcherUnhandledException` (and AppDomain). Autosave and session persist return without touching disk; File > Save still works. Proved by `tests/fault-autosave-app.mjs` (`debug_throw_ui`, `--debug` only). Do not add a shipped throw-switch.
- Prefer characterising failures over deleting suites. Skip only when the environment truly cannot run (missing fixture / no display) — document why.

## Auditing for dead or duplicated code

Four mechanical scans cover this tree. Each produces candidates, **not findings** — every
one on the 2026-09-17 pass had false positives, and the checking is the work:

1. **Unreferenced functions.** Every declaration in `js/modules/*.js` against every name
   occurrence in the other modules, the template, the `.cs` files (host script strings),
   `tools/` and `tests/`. Same for `private`/`internal` members in the `.cs` files, plus
   `TypoZen.xaml` (handlers are wired there by name). **Strip comments first** or a
   function named only in a war-story comment counts as live.
2. **The message protocol, both ways.** `postMsg(...)` / `SendMsg(...)` literals against
   `msg.startsWith` / `msg ==` / `cmd.startsWith` handlers at the other end. This is where
   dead code survives: a handler with no sender costs nothing and shows no symptom.
3. **Repeated runs of code.** Windows of 6–8 normalised lines occurring more than once.
4. **CSS.** Ids, classes and custom properties whose token appears nowhere else; and the
   same selector declared twice, where the earlier declaration is overridden.

**False positives this tree actually produces:**

- Names built by concatenation: `outline-h' + level`, `'list-indent-' + n` — the exact
  token `outline-h4` appears only in the CSS, and the class is live.
- Messages sent from a ternary (`e.shiftKey ? 'tab:prev' : 'tab:next'`), built with a
  `StringBuilder` (`spell_hits:`), or posted from a host script string (`open_file_path:`).
- Functions referenced only by suites. They are live; the suite is a caller.
- Hex colours read as ids (`#A78BFA`), and doc comments that spell out a CSS function —
  `assets-selftest` reads every `url(` in the built page as a bundled file reference.
- C# `using` directives: a text scan cannot judge them, because types are used without
  their namespace prefix. Only the compiler can, one removal at a time.

**Before removing anything, establish what it does and what stops working without it** —
by reading the code and measuring, not by asking. "It is sent twice" is not evidence that
one is dead: `OpenBook` sends the column request before the book arrives *and* again at
`load_done`, and the early one is what makes the book paint 2-col on its first paint
(measured: without it, 1-col, 120 pages, then a second layout to 113).

Removals that change rendering are checked by computed style before and after, not by eye.

## Extensions (File > Extensions)

Optional downloads, and **the only network request TypoZen makes** -- while an install
runs, never at launch, on a lookup or while reading. `Extensions.cs` owns all of it.

- **Kokoro voices** -> `%LocalAppData%\TypoZen_Cache<disc>\extensions\Kokoro\`, served to
  the page through the `localextensions` virtual host. **fp16 by default**: on a WebGPU
  card it matches fp32's speed for half the download. Quantised builds hang on WebGPU, and
  the CPU path generates about twice as slowly as the speech plays -- so there is no
  fallback, and a machine without WebGPU is told to stay on the Windows voices
- **Wiktionary dictionary** -> `dictionaries\Wiktionary\`, which the existing dictionary
  discovery then finds. Published as a GitHub release asset, checked by SHA-256
- **A missing extension leaves no menu.** The Kokoro node hides, exactly as the dictionary
  menu already hides itself while there is only one dictionary
- **`kokoro-js` reaches the network in two places no setting covers** -- the model host
  inside its copy of Transformers.js, and one hardcoded URL for the voice files. The
  install rewrites both and **fails if either is not found exactly once**, rather than
  shipping an engine that quietly calls out. That check is the point; do not relax it to
  make a version bump work
- **Never install by renaming a folder into place.** It was done that way once: removing
  an extension the app was reading from left the folder behind, the rename then failed,
  the staged download was discarded, and the reader was left with an empty folder. Files
  are moved in one at a time over whatever is there
- Claims about the network in README, About and the Store listing must keep saying "unless
  you install an extension". `docs/releasing.md` section 7 applies to these too

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
