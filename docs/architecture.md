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
