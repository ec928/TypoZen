# TypoZen Architecture & Refactor Plan — Index

This file has three parts:

1. **[Part 1 — OBSOLETE: original Antigravity/Gemini proposal](#part-1)** — kept verbatim for the record. **Do not act on it.**
2. **[Part 2 — Errors in the Part 1 proposal](#part-2)** — every mistake found, with the verified fact.
3. **[Part 3 — Current proposal](#part-3)** — the plan to follow, including the verified file and data layout.

---

<a id="part-1"></a>

# Part 1 — OBSOLETE: Original Antigravity/Gemini Proposal (2026-10-04)

> [!CAUTION]
> **OBSOLETE — DO NOT FOLLOW.** Everything between the two `====` markers below is the original document exactly as Antigravity/Gemini wrote it (commit `dc9e30b`), text unchanged. It contains factual errors and an unsafe plan; see Part 2. The plan to follow is Part 3.

==================== BEGIN OBSOLETE TEXT (verbatim) ====================

# TypoZen Architecture & Refactor Plan

This document outlines the high-level architecture of TypoZen, its target file structure (where data and binaries live), and the active refactoring plan to dismantle the C# monolith (`TypoZen_App.cs`) into a manageable, agent-friendly file structure.

## 1. Target File Structure & Caches

TypoZen stores application binaries and user caches separately to ensure clean updates and safe uninstalls.

### Application Data & Caches
All user preferences, application state, and WebView2 cached data are stored securely in the user's Local AppData directory:
*   **Path:** `%LocalAppData%\TypoZen_Cache` (e.g., `C:\Users\<User>\AppData\Local\TypoZen_Cache`)
*   **Contents:**
    *   `EBWebView/`: The Microsoft Edge WebView2 runtime profile and cache storage.
    *   `window_state.json`: Persists window bounds, maximization state, and column layout preferences across sessions.
    *   `recent_files.json` / Type preferences: Tracks recently opened files and file-type-specific view overrides (e.g., margins, font sizes for PDFs vs. Markdown).

### Installation / Program Files
Depending on how the user installs the app, the compiled binaries and UI assets live in one of the following locations:
*   **MSIX (Microsoft Store):** Managed securely by Windows in `C:\Program Files\WindowsApps\...\`
*   **Standalone Installer:** Typically defaults to `%LocalAppData%\Programs\TypoZen\` or `C:\Program Files\TypoZen\`.
*   **Portable Zip:** Wherever the user extracts it.

At runtime, the executable (`TypoZen.exe`) expects to find its frontend assets in adjacent directories (`css/`, `js/`, `fonts/`, `TypoZen_Template.html`, `TypoZen_Themes.json`).

---

## 2. Source Code Organization

The current repository layout follows a hybrid Native-Web structure:

*   **`TypoZen_App.cs`** - The monolithic C# backend (currently ~18,600 lines) handling WPF windowing, WebView2 initialization, File I/O, IPC bridging, and Native UI events.
*   **`js/modules/`** - Frontend logic, broken into distinct domains:
    *   `01-core.js` & `01a-source.js` - Initialization and CodeMirror 6 (Source mode) logic.
    *   `02-layout.js` - Pagination and column logic.
    *   `07-stats-host.js` - UI Outlining, word counting, read-time estimates.
    *   `09-speech.js` - Kokoro/WebGPU TTS integrations.
    *   `10-pdf.js` - PDF.js wrapper logic.
*   **`css/typozen.css`** - Global stylesheet.
*   **`tests/`** - JavaScript-based regression suites using Puppeteer/Headless Chrome.
*   **`tools/`** - Build and release pipeline scripts (`Build-Portable.ps1`, `Build-Msix.ps1`).

---

## 3. The Refactor Implementation Plan (Monolith Split)

### Rationale
`TypoZen_App.cs` is nearly 19,000 lines long. This is a severe architectural anti-pattern that slows down IDE performance, complicates git merges, and drastically reduces the efficiency and reliability of Agentic AI development. 

### Approach: Safe Partial Classes
To avoid breaking the build or introducing runtime regressions, we will use **Partial Classes**. This allows us to physically split the file into smaller logical pieces (`TypoZen_App.WebView.cs`, `TypoZen_App.Files.cs`, etc.) without altering namespaces, access modifiers, or internal logic.

### Progress Tracker

*   [ ] **Phase 1: Extract Static Utilities & Data Models**
    *   [ ] Create `TypoZen_Models.cs`
    *   [ ] Move `enum` definitions, simple data structs, and pure helper classes out of the main file.
    *   [ ] Create `TypoZen_Utils.cs` for pure static helper functions (e.g., regex checks, string sanitization).

*   [ ] **Phase 2: Split by Domain (Partial Classes)**
    *   [ ] Add `partial` to `public class MainWindow` (or equivalent main class).
    *   [ ] Extract `TypoZen_App.Themes.cs` (Theme parsing, color management, window chrome updates).
    *   [ ] Extract `TypoZen_App.WebView.cs` (WebView2 lifecycle, `CoreWebView2_WebMessageReceived`, bridging).
    *   [ ] Extract `TypoZen_App.Files.cs` (File I/O, saving, loading, recent files list).

*   [ ] **Phase 3: IPC Modernization (Optional/Later)**
    *   [ ] Replace the massive string-matching `if-else` blocks in `CoreWebView2_WebMessageReceived` with a structured JSON dispatcher schema.

*   [ ] **Phase 4: Frontend Performance (JS)**
    *   [ ] Refactor `07-stats-host.js` -> `updateOutline()` to use `sourceEditor.view.state.doc.iterLines()` instead of allocating array copies via `sourceEditor.value.split()`.

==================== END OBSOLETE TEXT ====================

---

<a id="part-2"></a>

# Part 2 — Errors in the Part 1 Proposal

Checked against the code on 2026-10-04 (0.14.1). Grouped by kind.

## 2.1 Factual errors in the document

| # | Part 1 claim | Verified fact |
|---|---|---|
| F1 | Cache lives in `%LocalAppData%\TypoZen_Cache` | Folder is `TypoZen_Cache` + an install suffix (`Program.CacheFolderName`). Installer and portable builds: `TypoZen_Cache_Portable`. MSIX: `TypoZen_Cache_<PackageFamilyName>`, and Windows redirects it into the package's private AppData. Plain `TypoZen_Cache` belongs only to the old 0.2.40 package. |
| F2 | Cache holds `EBWebView/`, `window_state.json`, `recent_files.json` / "Type preferences" | Leaves out most of what's there: `settings.json` (prefs, including per-type prefs), `tabs_session.txt`, `book_positions.txt`, `bookmarks.txt`, `user_words.txt`, `typozen_user.lex`, `TypoZen_Themes.json`, `debug.log`, `perf.log`, `typozen_books/`, `typozen_load/`, `dictionaries/`, `extensions/`, `ocr/`, and the narrator files. "Type preferences" isn't a file. |
| F3 | Installer goes to "`%LocalAppData%\Programs\TypoZen\` or `C:\Program Files\TypoZen\`" | Always `%LocalAppData%\Programs\TypoZen` (per-user Inno Setup install). |
| F4 | "Add `partial` to `public class MainWindow` (or equivalent main class)" | There's no `MainWindow`. The class is `TypoZenWindow`; nobody checked. |
| F5 | Source layout: `TypoZen_App.cs` plus 5 JS modules | There are **11 C# files** (`EpubReader`, `Extensions`, `Lexicon`, `NarratorDialog`, `PdfPictures`, `QwenInstaller`, `QwenNarrator`, `SpellCheck`, `TypoZen_Launch`, `TypoZen_TTS`, `TypoZen_App`) and **12 JS modules**. It misses `03-shell`, `04-lists`, `04b-format`, `05-model`, `06-render-epub`, `08-code`, `08b-compromise`, and `load-order.json`. |
| F6 | "`01-core.js` & `01a-source.js` — Initialization …" / "`02-layout.js` — Pagination and column logic" | `01-core.js` is state, view selectors and sticky helpers; startup is in `03-shell.js`. `02-layout.js` (7,819 lines, a monolith of its own and not mentioned) also holds find/search, search history and reader find keys. |
| F7 | `tests/` = "Puppeteer/Headless Chrome" suites | Also wrong by omission: about **239 `Pass(`/`Fail(` self-test checks and the E2E harness live inside `TypoZen_App.cs`**. |
| F8 | Duplicates a module map | A module map already exists in `docs/for-agents.md`. Part 1 adds a second, less accurate copy, so there are now two sources of truth. |

## 2.2 Errors in the plan

| # | Part 1 claim | Problem |
|---|---|---|
| P1 | "MSBuild naturally handles multi-file compilation" | Not in this project. `TypoZen.csproj` lists every file with `<Compile Include=…>`. A new file without an entry silently isn't compiled, so the build breaks or code goes missing. |
| P2 | Phase 1: move enums, structs and models to `TypoZen_Models.cs` "without a single line of code changing" | `DocKind`, `NativeRole`, `DocTab`, `DocType`, `TypePrefs`, `HostPrefs` and others are **private types nested inside `TypoZenWindow`**. Moving them to a top-level file means changing their access and every reference. That's not a zero-change move. |
| P3 | Phase 1: `TypoZen_Utils.cs` — "update the main file to call `TypoZen_Utils.X()`" | That edits call sites, which contradicts "zero risk / no changes". |
| P4 | Calls itself "zero risk", "near-zero risk of introducing bugs" | It has no verification step: no way to prove a move was only a move, no rule of one move per commit, no test gate per step. You asked for a plan that would "hopefully avoid the regression issues"; it has no mechanism for that. |
| P5 | Phase 3: rewrite messaging between C# and the page as JSON, "Optional/Later" | Every message changes on both sides of the C#/page boundary. That's a behaviour rewrite, not a refactor. It's not safe, and since 0.14.1 fixed the NUL case it has no strong reason. |
| P6 | Phase 4: outline needs `iterLines()` because of "heavy GC pressure" / "micro-stutters" | Never measured. Measured: splitting 18,000 lines takes about 3 ms; split plus regex takes about 7 ms per 2-second debounce. There's nothing to fix. |
| P7 | Ordering | It misses the biggest, least-coupled win: moving the in-file self-tests and the standalone classes (`Program`, `ThemeInfo`, `CustomFontWindow`, `ThemeCustomizeWindow`, `FolderPicker`, `CloseAtEndFileStream`) out first. |

## 2.3 Process errors during the same session

| # | What happened | Effect |
|---|---|---|
| S1 | Wrote `architecture.md` with a double-quoted PowerShell here-string, so backticks became escape codes (`` `r `` → CR, `` `f `` → form feed, `` `0 `` → NUL, `` `t `` → tab). | The document itself was corrupted. The NUL made TypoZen show it cut short and marked it "Unsaved", one Ctrl+S from truncating the file on disk. |
| S2 | First explanation blamed the file ("the fault of the file") and guessed TypoZen "treated the null byte as an EOF marker / stripped it". | Wrong. The actual cause was that the C#→page message call (`PostWebMessageAsString`) stops at the first NUL. Identified only after you pushed back. |
| S3 | Audit said the codebase was "surprisingly clean" with "0 leftover `console.log`" and leftovers "successfully cleaned up", after you had asked it to tidy its leftovers. | Its own untracked scratch files were still in the repo root: `patch.js`, `patch2.js`, `patch_readme.js`, `patch_test.js`, `release_script.ps1`, `test.html`, `test_colspan.html`, `test_apca.js`, `test_pass.js`, `test_pass2.js`, `test_regex.js`, `tests/throwaway.md`. The `console.log` search found `test_*.js` and it didn't follow up. |
| S4 | Audit checks were narrow but reported as broad: "unused CSS variables" checked only inside `typozen.css`; "CSS duplication" checked one class name. | Overstated how far the audit actually went. |
| S5 | Said "TypoZen already has a fix … large files (>96 KB) would load perfectly" via the staged `fetch` path. | Unverified. |

---

<a id="part-3"></a>

# Part 3 — Current Proposal

## 3.0 Is it worth doing? Recommendation (2026-10-04)

**Short answer: modest value. Do steps 0–5; defer 6–11.**

**It does not:**
- Make the app faster or better for users. The compiled program is the same.
- Fix regressions. Past regressions came from behaviour bugs (layout, alignment, state) and process mistakes (e.g. S1), not edits landing in the wrong place because the file is big. Targeted search and replace edits the 18.7k-line file reliably.
- Fix an AI's refactoring record. The Part 1 failures were unchecked facts and unverified steps, which file size doesn't cause.

**It does:**
- Make the code easier to find your way around, for people and AIs: cheaper reads, and an edit is less likely to match the wrong one of two similar blocks.
- Separate concerns. Test code stops sitting next to the code it tests, and a theme change no longer means opening the file that handles saving.

**Costs:** a few hours, plus a small risk that `Verify-PureMove.ps1` and the test gate should catch. `git blame` on moved code points at the move commit; use `git log -C` / `--follow` to see past it.

**Recommendation:**
1. **Do steps 0–5:** `Program`, the standalone dialog and helper classes, then the self-tests and E2E harness. About an hour, near-zero risk because no code depends on how they're arranged, and most of the size reduction. (The exact line count moved hasn't been measured yet.)
2. **Defer steps 6–11** (splitting `TypoZenWindow` into areas). They're the riskier part and give the least back. Pick one up only when working in that area actually becomes painful.
3. **If regressions are the real problem, put the effort elsewhere:** tests around the behaviours that keep breaking. `js/modules/02-layout.js` (7.8k lines, layout and find code) has caused more regressions than `TypoZen_App.cs`.
4. Skipping the refactor entirely is also a defensible choice. Feature work being paused only makes now the cheapest time to do it.

## 3.1 Where TypoZen lives (verified 0.14.1)

> Belongs in `README.md` (section "Files and folders"). Copy it there when Part 3 is accepted, and keep this as the detailed version.

### Program files

| Install type | Location |
|---|---|
| Installer (Inno Setup, per-user), the author's daily build | `%LocalAppData%\Programs\TypoZen\` |
| Portable zip | Wherever it's extracted |
| MSIX / Microsoft Store | `C:\Program Files\WindowsApps\<package>\` (read-only, managed by Windows) |

The app folder holds `TypoZen.exe`, the `WebView2` DLLs, `TypoZen_Template.html`, `css/`, `js/` (modules plus `vendor/`: CodeMirror, PDF.js, compromise), `fonts/`, and the shipped `TypoZen_Themes.json`. Nothing in it is written at run time.

### Profile / cache (per user)

`%LocalAppData%\TypoZen_Cache<suffix>\`. The suffix is `_Portable` for installer and portable builds and `_<PackageFamilyName>` for MSIX, where Windows redirects it into `%LocalAppData%\Packages\<PFN>\LocalCache\Local\`. You can override it with the profile-dir switch (`Program.ProfileDirOverride`); E2E runs use their own folder.

| Item | Purpose |
|---|---|
| `settings.json` | Host preferences, including per-document-type view prefs and last open folder |
| `window_state.json` | Window size, position, maximised state |
| `tabs_session.txt` | Open tabs for session restore |
| `recent_files.json` | File → Open Recent |
| `book_positions.txt` | Reading position per document |
| `bookmarks.txt` | Bookmarks |
| `user_words.txt`, `typozen_user.lex` | User dictionary / lexicon |
| `TypoZen_Themes.json` | User's custom themes (the shipped copy stays in the app folder) |
| `dictionaries/` | Installed spell-check dictionaries |
| `extensions/` | Installed extensions (File → Extensions) |
| `ocr/` | OCR data |
| `typozen_books/` | Extracted EPUB cache (served as `localbooks`) |
| `typozen_load/` | Temporary staged document bodies over 96 KB (served as `localload`); old ones are swept |
| `EBWebView/` | WebView2 browser profile |
| `debug.log`, `perf.log` | Only with `--debug` / perf tracing; size-limited |
| Narrator folder (`QwenNarrator.RootDir`) | `narrator.json`, `presets.json`, `voices/`, `narration.log`, installer `install.log` |

Help → Clear data (`ClearChoices`) is the user-facing way to remove these items one by one.

## 3.2 Source layout: target

The module map stays in **`docs/for-agents.md`** (single source of truth). The C# target after the split:

| File | Contents |
|---|---|
| `TypoZen_Program.cs` | `Program` (entry, single instance, logging, version) |
| `TypoZen_Launch.cs` | (exists) launch request parsing |
| `TypoZen_App.cs` | `partial class TypoZenWindow`: fields, constructor, window chrome, menus |
| `TypoZen_App.Tabs.cs` | `DocTab`, tab strip, switching, session save/restore |
| `TypoZen_App.Files.cs` | Open / save / encoding / disk watch / recent files |
| `TypoZen_App.WebView.cs` | WebView2 setup, host mappings, `CoreWebView2_WebMessageReceived`, `SendMsg` |
| `TypoZen_App.Prefs.cs` | `HostPrefs`, `TypePrefs`, settings and window state |
| `TypoZen_App.Themes.cs` | Theme load and apply |
| `TypoZen_App.Pdf.cs` | PDF open and export (`PdfExportJob`) |
| `TypoZen_App.SelfTest.cs` | All in-app self-tests and the E2E harness |
| `TypoZen_Dialogs.cs` | `ThemeInfo`, `CustomFontWindow`, `ThemeCustomizeWindow` |
| `TypoZen_Interop.cs` | `FolderPicker`, `CloseAtEndFileStream` |
| Existing files | Unchanged |

`02-layout.js` (7.8k lines) is a candidate for a later, separate plan. It's out of scope here.

## 3.3 Rules: how every step is done

1. **Move only.** Cut and paste whole members. No renames, no reformatting, no "while I'm here" fixes. Nested private types stay nested: they move as part of a `partial class TypoZenWindow` block, never to top level.
2. **Prove it's only a move.** Before committing, run `tools/Verify-PureMove.ps1` (to be written as step 0). It compares the sorted set of non-blank code lines across all `*.cs` files before and after. The only allowed differences are new `partial`/`namespace`/`using`/brace wrapper lines. Any other difference fails the step.
3. **Register the file** in `TypoZen.csproj` (`<Compile Include=…>`) in the same commit.
4. **Build, then run the full gate** (`Build_TypoZen.ps1`). This is a structural change, which is what the gate is for.
5. **One step = one commit**, message `refactor(split): <step>`. If anything regresses, `git revert` that one commit.
6. **No feature work** is mixed in while a step is open.
7. An internal build goes to the author's machine after each phase (not each step) for a quick manual check.

## 3.4 Steps and tracker

| # | Step | Risk | Status |
|---|---|---|---|
| 0 | ~~Write `tools/Verify-PureMove.ps1`~~ — done, self-tested (see script header); ~~delete Part 1's leftover scratch files (S3)~~ — deleted 2026-10-04 | none | ☑ |
| 1 | `Program` → `TypoZen_Program.cs` | very low | ☐ |
| 2 | `ThemeInfo`, `CustomFontWindow`, `ThemeCustomizeWindow` → `TypoZen_Dialogs.cs` | very low | ☐ |
| 3 | `FolderPicker`, `CloseAtEndFileStream` → `TypoZen_Interop.cs` | very low | ☐ |
| 4 | Mark `TypoZenWindow` `partial` (one-word change, verified with the gate) | very low | ☐ |
| 5 | Self-tests and E2E harness → `TypoZen_App.SelfTest.cs` | low | ☐ |
| — | **Checkpoint:** internal build to author, tag `refactor-a`. **Recommended stopping point (3.0).** | | ☐ |
| 6 | Prefs → `TypoZen_App.Prefs.cs` | low | ☐ |
| 7 | Themes → `TypoZen_App.Themes.cs` | low | ☐ |
| 8 | PDF → `TypoZen_App.Pdf.cs` | low | ☐ |
| 9 | Files → `TypoZen_App.Files.cs` | medium (most cross-references) | ☐ |
| 10 | WebView bridge → `TypoZen_App.WebView.cs` | medium | ☐ |
| 11 | Tabs and session → `TypoZen_App.Tabs.cs` | medium | ☐ |
| — | **Checkpoint:** internal build, tag `refactor-b`; update `for-agents.md` and the `typozen-internals` skill with the new file map | | ☐ |

**Steps 6–11 are deferred** (3.0): do one only when work in that area is actually painful, using the same rules.

**Explicitly not in this plan:** the Part 1 JSON messaging rewrite (P5), outline `iterLines()` (P6), splitting `02-layout.js`, and any behaviour change.


## Architecture
TypoZen is a **native shell around a browser engine**. The WPF side owns the window, tabs, menus and file I/O; everything inside the document area is HTML, CSS and JavaScript running in WebView2. Nearly every design decision follows from that split.

### Stack
| Layer | Shell (native) | Document surface (web) |
| --- | --- | --- |
| Runtime | .NET Framework 4.7.2 — `TypoZen.exe`, `WinExe` | same process |
| UI | **WPF** — `TypoZen.xaml`, loaded at runtime via `XamlReader.Load` | `TypoZen_Template.html` — HTML + CSS |
| Controls | Title-bar tabs, menus, sidebar, status bar | `contenteditable` div; **vanilla JS, no framework** |
| Bridge | `WindowsFormsHost` → WebView2 (**WinForms flavour**) | `window.chrome.webview` messages |
| Theming | Recursive logical/visual tree walk + `SystemColors` brush keys | CSS from the same `TypoZen_Themes.json` |
| Typography | — | 4 families bundled in `fonts/`, `local()` first |
| Engine | Tabs, session, file I/O, themes — all of it in `TypoZenWindow` (`TypoZen_App.cs`) | `js/modules/*` — `DocumentModel`, `HistoryManager`, virtualization |
| Build | MSBuild / `Build_TypoZen.ps1` (CodeDom over all `*.cs`) | Runtime assets — edit without recompiling |

Because the XAML, HTML template and theme JSON are all loaded at runtime, the shell chrome, editor engine and themes can be changed without touching C# or rebuilding. Only the `.cs` sources require a recompile — see [Build](#build) for what those are.

> Sibling project **ZenSeek** uses the same content approach — WebView2 rendering a generated HTML document against a shared-shape theme JSON — but hosts it from a PowerShell script with a WinForms reader window rather than a compiled WPF shell.

### Document model
`DocumentModel` holds one canonical raw Markdown string per block and is the **authority for save, tab sync and host serialization** — the DOM is a projection of it, not a peer.

In Live Preview each line also carries a rendered form, so the two must never disagree. The invariants that keep them honest:

- **`data-raw` is canonical.** Every edit path updates it in the same transaction as the DOM.
- **Flush before leaving.** The active block is written back before any save, tab switch, mode toggle or host pull.
- **No length heuristics.** Truth is never decided by "whichever copy is longer" — that rule silently reverted deletions on save, and it is gone.
- **Model indices, not DOM ordinals.** Under virtualization the first mounted block is not block 0, so formatting, undo, find and caret restore all resolve through model indices.
- **A whole-document mutation reads the model, not the mounted DOM.** `mutateDocumentMarkdown` snapshots every block, mutates, and reloads the document from the result — so snapshotting `editor.querySelectorAll('.block')` meant rebuilding a virtualized document from the ~99 blocks on screen. Its indices are model indices throughout: what the mutator sees, what `opts.focusIndices` means, and what `_selectedFormatRaws` was already keyed by. Those three agreed only while the mounted window started at block 0, which is why a list indent deep in a document silently did nothing — a bounds check in the caller was the only thing keeping the call away from it.
- **A model splice renumbers the mounted DOM.** `data-model-index` is not decoration: `syncMountedToModel()` writes each mounted element's `data-raw` back into the slot its attribute names. Inserting or removing a block shifts every row after it, so the attributes on already-mounted elements must move too — `insertBlockAfterIndex` / `removeBlockAt` / `removeBlockRange` call `shiftMountedModelIndices` for exactly that. Leave them stale and the next remount copies the DOM's content into the _wrong_ rows: a mid-document paste destroyed the line after the caret this way, and a cross-block delete lost an untouched line.
- **A structural edit splices the height map, it does not discard it.** `invalidateHeights()` throws away every measurement taken so far, so the next `prefixHeight()` for a distant row is rebuilt from estimates and the viewport pin moves with the error — 1562px per pasted block on a 3769-block document. `spliceHeights` keeps every untouched row's real height.
- **An element returned by `createBlock` may already be detached.** Under virtualization it remounts, which replaces every mounted element. Chain off the model index and re-resolve, never off the returned node.
- **Ordinary notes are never virtualized.** Virtualization is for large documents only; normal writing gets the full WYSIWYG DOM.
- **Progressive paint is M-band only**, gated on block count — never on a character count.

### Books
A book is a second **document kind**, not a second document model. `DocumentModel.kind` is `'markdown'` or `'epub'`, and everything downstream branches on it rather than on a separate code path: search, the outline, the word count, page windowing and the column round trip are the same code for both.

| Piece | Where | Does |
| --- | --- | --- |
| `EpubReader.cs` | shell | Unzips to a cache folder, reads `container.xml` → OPF → spine, returns one JSON payload: title, author, assets base, stylesheets, TOC, documents. **No HTML processing at all.** |
| `loadBookPayload()` | page | Splits each spine document into blocks, builds the TOC, applies the book's CSS, mounts |
| `bookBlocksFromDocs()` | page | One block per top-level element of each `<body>`; also returns each block's owning document directory |
| `applyBookStyles()` | page | Scopes every rule to `#editor` and applies the four corrections listed under Highlights |
| `rewriteBookUrls()` | page | Resolves `src` / `href` / `xlink:href` **against the document the block came from** |

Two things about that last row, because both were wrong first:

- **An image href is relative to its own spine document, not to the book root.** One test book keeps documents in `OEBPS/Text/` and images in `OEBPS/Images/`, so its covers are `../Images/…`; the other is flat at the archive root and resolved correctly under a shared base by accident. A single assets base works for exactly one of them.
- **A cover is usually not an `<img>`.** Both test books wrap it in `<svg><image xlink:href="…"></svg>`, which no `img` rule and no `src` rewrite touches.

Two things make reopening a book cheap. `EpubReader` caches the assembled payload beside the extracted assets against the same stamp, so a reopen is a file read rather than a re-read and re-escape of every spine document. And `SyncActiveTabFromEditor` skips a book entirely: it is read-only, never dirty, never saved, and reloaded from the file rather than from `Content`, so pulling it was marshalling the whole book across the WebView bridge on every tab switch — 1,043,141 characters, which the page produces in 2 ms and the bridge takes six seconds to hand over.

A book's block `raw` is the publisher's markup, so `renderBlockPreview` sets it as HTML and returns before any of the Markdown renderer runs. The editor refuses to become editable while a book is open, `GetDirtyTabs()` skips `.epub` tabs, and `ReadTextFileDetect` returns empty for one — a book cannot be edited, marked dirty, or saved over.

### Page windowing
Pagination lays out the whole document, because the browser can only fragment content it has already laid out. That is correct and it is why an unwindowed 40,656-block omnibus put every block into one multi-column flow. `PageChunks` splits the document into fixed block ranges, lays out **one range at a time**, and keeps a per-range page count — cumulative sums give the global page number, exactly as `blockHeights` + `prefixHeight()` give the global scroll offset.

- Unmeasured ranges are estimated from pages-per-block and refined as they are laid out — but only **upward**. Refining an unmeasured range downward removed pages the reader had already been shown, and the act of seeking was what removed them: seeking mounts a range, mounting measures it, measuring shrank the total. Ask for page 267 of 268, land on 261.
- Because part of the total can be a guess, the UI marks it (`pageTotalIsApproximate`) rather than presenting an estimate as an exact figure.
- **Blocks are the anchor, not page numbers.** Page numbers move as estimates are refined; block indices do not, and the column round trip already depends on that.
- The range on screen is measured exactly, never trusted from its estimate.
- A structural edit **splices** the map rather than discarding it, the same rule as the height map.

`PageChunks.size` is 800 blocks. It was 400, tuned on a Markdown fixture; measured on two real novels, the cost that matters is the page turn that crosses a range boundary and has to lay out the next one:

| Range size | In-range turn | Boundary crossing | Pages per range |
| ---------- | ------------- | ----------------- | --------------- |
| 200        | 1 ms          | 18 / 20 ms        | 7 / 16          |
| **800**    | **2 ms**      | **74 / 84 ms**    | **28 / 62**     |
| 1600       | 3 ms          | 201 / 172 ms      | 55 / 124        |

Amortised over the pages between crossings it is flat at every size, so the choice is the worst case a reader feels against how much of the book is laid out at once — which is also how far the editor's own scrollbar reaches.

**The scrubber exists because that scrollbar cannot reach the ends.** It addresses pages; `PageMap.goto()` already mounts the range a page falls in, so seeking anywhere is the same operation as turning a page. It seeks on release rather than on every input event, because a drag would otherwise mount a range per pixel of travel.

### Thresholds
Live constants in `TypoZen_Template.html`. Changing them changes which strategy a document gets, so they are listed here rather than left to be rediscovered:

| Constant | Default | Role |
| --- | --- | --- |
| `VIRT_MIN_BLOCKS` | 2 000 | Virtualize at or above this block count |
| `VIRT_MIN_CHARS` | 120 000 | Virtualize at or above ~120 KB |
| `PROGRESSIVE_PAINT_BLOCKS` | 800 | M-band: full mount, deferred HTML paint |
| `PROGRESSIVE_CREATE_BATCH_BLOCKS` | 1 500 | M-band: create blocks in `requestAnimationFrame` batches |
| `overscan` | 40 | Blocks kept mounted above and below the viewport |
| `LARGE_DOC_CHARS` | 16 000 | Stats/preferences throttling only — **not** an open-mode or paint threshold |
| `PAGE_WINDOW_MIN_BLOCKS` | 800 | Page windowing engages at or above this block count |
| `PageChunks.size` | 800 | Blocks per laid-out range while paginated (measured — see Page windowing) |
| `PageChunks.perBlock` | 0.06 | Seed pages-per-block for ranges not yet measured |
| `PAGE_FOOT_RESERVE` | 26 px | Strip at the foot of a page for the numbers and the scrubber |
| `MaxRememberedBooks` | 64 | Reading positions kept in `book_positions.txt` |

`LARGE_DOC_CHARS` is **only** for stats/preferences throttling. It is no longer aliased from a historical `SOURCE_FIRST_CHARS` name — size does not choose Source vs Preview; document type does.

Which path a Preview load takes:

| Condition | Path |
| --- | --- |
| blocks ≥ 2 000 **or** chars ≥ 120 KB | **Virtualized** — progressive never runs |
| 1 500 ≤ blocks < 2 000 | Progressive paint **+ windowed creation** |
| 800 ≤ blocks < 1 500 | Progressive paint, full DOM |
| blocks < 800 | Immediate full paint |

Two rules worth keeping: don't gate progressive paint on a character count (it belongs to block count), and don't lower the virtualization floor toward 16 KB without a deliberate product decision — ordinary notes are meant to stay full WYSIWYG.

### Editor engine
Preview is standalone vanilla JavaScript — no framework. Source is [CodeMirror 6](https://codemirror.net/), bundled into the app (`js/vendor/codemirror/`, built by `tools/Update-CodeMirror.ps1`), behind an adapter that gives the rest of the editor a textarea-like surface (`js/modules/01a-source.js`).

- **Custom snapshot undo/redo** (`HistoryManager`) rather than the fragile `contenteditable` undo stack, with byte- and step-capped history
- **2-stage Backspace** on list and heading prefixes — first press strips the marker, second merges blocks
- Precision join-point caret placement on merge and split
- Cross-boundary selection guard for multi-block delete
- **IME composition protection** — CJK and accent composition is never interrupted
- Plain-text-oriented paste; multi-line paste becomes clean blocks
- Horizontal rules: `---`, `***`, `___`, and spaced forms `- - -`, `* * *`, `_ _ _`

The reasoning behind these decisions — including the failure modes that motivated them — is preserved in [`docs/archive/`](docs/archive/). Those records are historical; this README describes what the code does now.

---
## Build
From the project folder:

```powershell
.\Build_TypoZen.ps1
```

- Uses **MSBuild** when available; otherwise compiles with **`CSharpCodeProvider`** (CodeDom) against the WebView2 DLLs beside the sources. The provider is used rather than `Add-Type` because `Add-Type` collapses every failure into one opaque message with no file or line.
- Output: `TypoZen.exe` in the project folder
- The full self-test suite runs first — a failing suite fails the build

**Compiled sources.** Three files, and the CodeDom path finds them by globbing **`*.cs` in the project folder** — so anything with that extension dropped beside them is compiled too. A throwaway experiment goes somewhere else, or gets another extension.

| Source | Holds |
| --- | --- |
| `TypoZen_App.cs` | `Program` (entry point, single-instance pipe, CLI), `TypoZenWindow` (the whole shell: tabs, session, menus, themes, file I/O, host↔page bridge), `ThemeInfo`, `ThemeCustomizeWindow` |
| `EpubReader.cs` | `EpubReader` — unzip, `container.xml` → OPF → spine, and the cached JSON payload. No HTML processing (see [Books](#books)) |
| `TypoZen_Launch.cs` | `LaunchRequest` — how a document was asked for: path plus ZenSeek's `--reader` / `--search` / `--line` / `--match-index` hints |

**Referenced assemblies.** Three DLLs sit beside the sources — `Microsoft.Web.WebView2.Core`, `Microsoft.Web.WebView2.WinForms` and `WebView2Loader`. The **WinForms** flavour only: the control is hosted in a `WindowsFormsHost`, nothing imports `Microsoft.Web.WebView2.Wpf`, and neither of the other two assemblies references it, so it is not shipped. The build fails with a named list if any is missing, and falls back to a sibling `Text Search` folder for the ones it cannot find. `TypoZen.ico` is passed as `/win32icon`. `TypoZen.csproj` describes the same build for MSBuild and Visual Studio — **keep it and `Build_TypoZen.ps1` in step**, since each carries its own copy of the reference list.

**PdfPig** (Save All Images in PDF, `PdfPictures.cs`) is ten more DLLs beside the sources, about 5.5 MB: PdfPig 0.1.16's .NET Framework 4.7.1 build (`UglyToad.PdfPig`, `.Core`, `.Fonts`, `.Tokenization`, `.Tokens`) and what it needs (`Microsoft.Bcl.HashCode`, `System.Memory`, `System.Buffers`, `System.Numerics.Vectors`, `System.Runtime.CompilerServices.Unsafe`), from nuget.org. Their versions match one another exactly, so no binding redirects are needed. The build compiles with the .NET Framework C# compiler, which cannot use `Span<T>`: use PdfPig's `RawMemory` and `TryGetBytesAsMemory`, never `RawBytes` or any `Span`-typed member. They are listed in `$pdfDlls` in both build scripts, in `tools/Build-Portable.ps1` and in `TypoZen.csproj`.

**Runtime assets** (edit without recompiling C#):

- `TypoZen.xaml` — shell and menus
- `TypoZen_Template.html` — page shell; loads CSS and the engine modules by reference
- `js/modules/` — editor engine (ordered classic scripts; see `js/modules/load-order.json`)
- `js/typozen.js` — **deprecated stub** that throws if loaded; do not edit
- `css/typozen.css` — editor styling
- `TypoZen_Themes.json` — themes
- `fonts/` — bundled typefaces, with `fonts/OFL.txt` (their licence travels with them)

The engine is nine modules sharing one global scope (not ES modules), loaded in the order `js/modules/load-order.json` gives:

| Module | Concern |
| --- | --- |
| `01-core.js` | State, view selectors, margins, sticky line helpers |
| `02-layout.js` | Find/search (history, Up/Down hits), pagination, page windowing, column memory |
| `03-shell.js` | `onload`, themes, host commands, table picker |
| `04-lists.js` | List engine (indent, parse, Tab/Backspace ladder) |
| `04b-format.js` | Inline format, clipboard, keyboard editing paths |
| `05-model.js` | `DocumentModel`, virtualization, page keyboard, load/save of content |
| `06-render-epub.js` | Markdown render, epub load, book links/styles |
| `07-stats-host.js` | Stats bar, outline, host sync, export |
| `08-code.js` | Fence syntax highlight (Highlight API only — not a code editor) |

Edit a module and reload — no bundler step for the app. Tests concat the same files via `tests/engine-source.mjs` / `tests/build-test-template.mjs`.

Rebuild after changing any of the three `.cs` sources. The build also parses `TypoZen.xaml` before compiling: it is loaded at runtime by `XamlReader`, so markup errors are invisible to the compiler and would otherwise surface as a crash on launch.

**Other scripts in the folder:** `Build_TypoZen.bat` (double-click wrapper for the build) · `TypoZen_Debug.bat` (launch with `--debug`; see [Debugging](#debugging)) · `Create_Shortcut.ps1` · `Generate_Icon.ps1`

**Not in source control, rebuilt on demand:** `TypoZen_Template.runtime.html` (stamped with `?v=` at launch so WebView2 cannot cache stale modules), `TypoZen_Template_Test.html` (the jsdom fixture, regenerated by `tests/build-test-template.mjs`), `obj/` (MSBuild intermediates), `TypoZen.pdb`, `%LocalAppData%\TypoZen_Cache\typozen_load\` (staged document and book payloads, swept after 5 minutes; under Privacy Mode an opaque TEMP folder instead), `%LocalAppData%\TypoZen_Cache\typozen_books\` (extracted book assets), `%LocalAppData%\TypoZen_Cache\debug.log`.

### Tests

```powershell
.\tests\run-tests.ps1                          # default gate — jsdom + browser suites
$env:RUN_APP_E2E = '1'; .\tests\run-tests.ps1  # + the suites driving the real TypoZen.exe
```

Tests are split into four tiers depending on what they need to observe:

| Tier | Naming | Runs by default | Sees |
| --- | --- | --- | --- |
| jsdom | `*-selftest.mjs`, `*-e2e.mjs` | yes | model, string and DOM-structure logic |
| browser | `*-browser.mjs` | yes | real layout, via headless Chrome |
| application | `*-app.mjs` | `RUN_APP_E2E=1` | the shipped `.exe` — WPF shell, real window |
| pending | `*-pending.mjs` | `RUN_PENDING_E2E=1` | behaviour not built yet |

- **jsdom** covers the document model, parse checks, and logic that doesn't depend on a layout engine.
- **Browser** suites load `TypoZen_Template.html` in headless Chrome to assert real layout, geometry, and search performance.
- **Application** suites use `puppeteer-core` to attach to `TypoZen.exe --debug` via the DevTools protocol, verifying WPF shell interactions and complex paginated layout behaviours. `disk-conflict-app.mjs` is the one that can see the dirty-tab disk prompt: a `MessageBox` pumps the UI thread, so the suite answers it with `TYPOZEN_DISK_PROMPT=Yes|No|Cancel` rather than clicking the dialog. In-process `TYPOZEN_TAB_E2E` requires `--debug` as well as the env var (same gate as the disk stubs), and still skips the feature unless that env is set, so suites that rewrite the open file do not silent-reload.
- The bookmark, annotation and privacy suites (`marks-surfaces-app`, `annotations-app`, `privacy-app`) are written against one recurring failure shape rather than against their features: **two things deciding one answer**. They assert that _pressing a control does what the control said it would_, and — for anything that claims to suppress a write — they run a **control** first, so a green result means the suppression did something rather than that the trace was never written.
- `book-to-markdown-app.mjs` guards the transition that put a Markdown document into a book's column: **leaving a book leaves nothing behind**, and **a pane that cannot be measured is refused rather than invented**. It deliberately does _not_ assert the rendering — `column-width` is a preferred width, so a single leaked column stretches to fill the pane and looks perfectly healthy; two earlier versions of that assertion passed with the bug present. The geometry checks are strictly more sensitive, because the leak has to happen before it can fragment anything.
- Some of them also drive the **chrome from outside the process** through `tests/shell-ui.ps1`, which reports menus, tab chips, dialogs and — via `-Command controls` — whether each toolbar control is actually enabled, over UI Automation as JSON. `format-availability-app.mjs` is the one that needs that last part: "greyed out" is a claim about the running window that no page-level suite can see. That is the only tier that can see what is actually painted: the page knows nothing about tabs, and the session file is written from the same model the model tests read, so both agreed with each other while the tab strip disagreed with both — see `tab-strip-paint-app.mjs`.

### Known issues and agent notes
Open defects and deliberate limitations: [docs/known-issues.md](docs/known-issues.md) — reproduced and characterised only (not bare suite names).

**Agents / other tools:** read [docs/for-agents.md](docs/for-agents.md) first — keyboard matrix, non-goals (no code editor revival, no inventing defects from suite noise), and where truth lives. Parked developer-editor work: [docs/developer-editor-analysis.md](docs/developer-editor-analysis.md).

### Debugging
A normal run writes no log and opens no port. To debug:

```powershell
.\TypoZen_Debug.bat "tests\large-scroll-mixed.md"
```

This turns on the page's telemetry channel (appending to `debug.log`) and opens the DevTools port the application harness attaches to.

### Startup profiling
Set `TYPOZEN_PERF` to write a startup timeline:

```powershell
$env:TYPOZEN_PERF = '1'        # this shell only — never set it persistently
.\TypoZen.exe "some\file.md"
Get-Content "$env:LOCALAPPDATA\TypoZen_Cache_Portable\perf.log"
```

Marks are milliseconds from entry to `Main`; the log is appended, so delete it between runs.

---
### Developer & Diagnostic Tools

TypoZen includes built-in tools to help diagnose layout and focus issues:

- **Developer Debug HUD (`Ctrl+Shift+D`)**: Toggle a real-time, on-screen HUD (also accessible via `Help -> Toggle Debug HUD`). It overlays current focus state, exact layout metrics (pagination, scroll position, page width), and search state. When toggled off, it has zero performance overhead.
- **Telemetry Logging (`TypoZen_Debug.bat`)**: Launching TypoZen via this script passes the `--debug` flag, which records high-volume layout telemetry (such as progressive rendering and column measurements) to a `debug.log` file in the application directory.

---