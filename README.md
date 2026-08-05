# 🧘 TypoZen — WYSIWYG Markdown & Text Editor

**TypoZen** is a standalone hybrid Markdown and plain-text editor for Windows. It pairs a **WPF** shell with **WebView2** (Chromium) for a block-based live preview and a raw Source mode — native OS integration with a modern rendering engine.

Works well with **`.md`**, **`.txt`**, and related text files.

---

## Highlights

### Dual-mode editing
- **Live Preview** — block-based WYSIWYG (headings, lists, tasks, tables, code fences, emphasis)
- **Source Mode** — raw Markdown/text in a growing textarea (one scrollbar with the outer pane, never nested)
- Toggle with **`Ctrl+/`** or the toolbar; labels show the **current** mode
- **Sticky mode switching** — the same hard line stays put for both the status readout *and* the scroll position when you toggle
- Source uses the **active theme font** (pick a **(Mono)** theme if you want monospaced source and preview)

### Large documents
TypoZen opens by document *type*, not size — Markdown of any size opens in Live Preview, and the engine picks its own strategy:

| Band | Strategy |
|------|----------|
| **S** — small | Full DOM, immediate paint |
| **M** — medium | Full DOM, progressive paint in `requestAnimationFrame` batches (≥ ~800 blocks; windowed creation ≥ ~1500) |
| **L / XL** — large | **Virtualized Preview** — only viewport ± overscan is mounted (≥ ~2000 blocks or ~120 KB) |

Virtualized Preview keeps a per-block height map, estimated from the raw Markdown and refined from real measurements as blocks mount, with **scroll anchoring** so correcting a height never moves the content under your cursor. `.txt` / `.log` / `.csv` open in Source, which is the Notepad-class path.

### Themes & typography
**27 handcrafted themes** in `TypoZen_Themes.json` — modern dark/light, reading and serif faces, Gruvbox and warm palettes, plus **4 mono themes** grouped at the end and labelled `(Mono)`.

Each theme is built around a deliberately chosen typeface, not just a colour palette — the reading themes use **Literata** and **Merriweather** because they were designed for long-form reading; the UI themes use **Inter** and **Source Sans 3** for clarity at small sizes.

- **Fonts ship with the app.** The families live in `fonts/`, so every theme looks the way it was designed on any machine — no manual installation, nothing to hunt down, and **no font is ever fetched from the network**. TypoZen works identically offline, on a locked-down network, or on a fresh PC. (The app requests nothing over the network at all — though the WebView2 runtime beneath it does; see [Network behaviour](#network-behaviour).)
- **Your installed copies win.** Each `@font-face` lists `local()` first, so if you already have Inter or Literata installed, that's what renders and the bundled file is never touched.
- **Deep recursive theming** — selecting a theme walks the WPF logical and visual trees, so menus, dropdowns, toolbar, sidebar and status bar all inherit matching background, foreground, border and accent brushes.
- **Themes → Customize Theme…** — name, colours and font preset with live preview, **Save as New** (built-ins are never overwritten), Reset, and Cancel that restores the theme you started with.
- Mono themes prefer **Cascadia Mono** / **Consolas**, which ship with Windows.

The four bundled by default (Inter, Source Sans 3, Merriweather, Literata) are SIL Open Font Licence, which permits redistribution.

> **Bookerly is not.** It is Amazon's, drawn by Dalton Maag, and its copyright forbids redistribution without written permission. Two themes name it, and before it was bundled they silently rendered Georgia instead: an "install for me only" copy registers under HKCU and the WebView2 renderer sandbox does not enumerate per-user fonts, so `local('Bookerly')` found nothing. It is fine in a private build; remove `fonts/Bookerly*.ttf` and its `@font-face` block before distributing to anyone else.

> **Merriweather is 4.4 MB, and it is not the letterforms.** Its outlines are 144 KB, the smallest serif here. `GPOS` and `GDEF` account for 3.3 MB: it carries three variable axes (`wght`, `wdth`, `opsz`), so every kerning pair stores deltas for each axis combination. Inter has two axes and 150 KB of `GPOS`. Pinning `wdth` and `opsz` would recover most of it. `tests/fonts-selftest.mjs` checks that variable families declare their weight range, since a single declared weight pins the axis and makes the browser synthesise faux-bold.

> Earlier versions pulled these from Google Fonts via a `<link>` in `<head>`. That was a render-blocking network round trip on every cold start of a local editor, and because Google's CSS omits `local()`, it shadowed already-installed copies and re-downloaded them. Bundling removed both problems.

### Writing tools
- Find / Find & Replace (`Ctrl+F` / `Ctrl+H`) — searches the whole document model, so matches off-screen in a virtualized document are still found
- Table insert (`Ctrl+T`)
- Reveal Markdown on focus (`F7`), Focus mode (`F8`), Typewriter scroll (`F9`), Fullscreen (`F11`)
- Editor margins: Narrow / Regular / Wide — real side padding, not column-width caps
- Sidebar (`Ctrl+\`): live `H1`–`H6` outline plus local `.md` / `.txt` / `.markdown` files
- Zoom: `Ctrl++` / `Ctrl+-` / `Ctrl+0` or Ctrl+scroll
- **Notepad-style chrome** — document tabs in the **title bar** with min/max/close; File/Edit/View and format icons on the command row below
- **Auto-hide menu** — tucks the command row and tab chips, keeping a slim caption for dragging and window controls (pointer to top, or Alt, restores)

### Tabs
Full multi-document editing, with the tab strip living in the title bar.

- **New** with the `+` button or `Ctrl+N`; close with the tab's own button or `Ctrl+W`
- Cycle with `Ctrl+Tab` / `Ctrl+Shift+Tab`
- **Scroll arrows** appear only when the strip overflows, and the active tab is always scrolled into view
- **Per-tab unsaved indicator**, tracked independently of every other tab
- **Per-tab file fidelity** — each tab remembers its file's line-ending style (LF / CRLF) and whether it ended with a trailing newline, so saving one document never quietly rewrites the whole file's line endings
- **Fail-closed switching** — if the editor's content cannot be synced back to the tab, the switch or new-tab operation is *refused* rather than proceeding and risking unsaved edits
- **Session restore** reopens your tabs on next launch (bodies only if you've enabled unsaved-document restore under File → Privacy)

### Lists
Bullet, ordered and task lists, with real nesting.

- **`Tab` / `Shift+Tab`** indent and outdent list lines — 2 spaces per level, maximum depth 6, spaces only (tabs are normalised on parse)
- Inside a table, `Tab` moves between cells instead and grows the table at the end
- **Backspace at column 0** walks a ladder: outdent one level → strip the marker (including ordered `1.` and task `- [ ]`) → merge with the previous block
- `Enter` continues the list at the same indent and kind; ordered numbering follows the previous item *at that level*
- Formatting and toolbar list toggles preserve indent; un-listing clears it to level 0
- Indentation is a property of the raw Markdown (leading spaces), rendered with `margin-left` rather than nested `<ul>` DOM — so Source round-trips exactly

### Live statistics
The status bar updates continuously with word count, character count, estimated reading time (~200 wpm), total lines, current line, and — when text is selected — **selected** word and character counts. Serialization is debounced so counters stay responsive on very large documents.

### Files & export
- New / Open / Save / Save As — UTF-8 (BOM detected on load; saved without BOM)
- **Atomic document save** — write to a temp file, flush, then replace the target
- **Standalone HTML export** — self-contained, with the active theme's styles embedded
- Print / Export PDF (`Ctrl+P`) — Chromium print UI
- CLI and Explorer integration: `TypoZen.exe "C:\path\doc.md"` (or `.txt`)

### Session & privacy
Preferences live under `%LocalAppData%\TypoZen_Cache\`.

| Setting | Default | Meaning |
|--------|---------|---------|
| **Remember unsaved documents between sessions** | **Off** | When on, dirty/untitled tab bodies are stored for restore. When off, nothing document-like is kept in the cache beyond what you explicitly save. |
| **Keep recent files list** | On | File → Open Recent |
| **Clear Stored Data** | — | Wipes TypoZen cache/session data only — **not** your documents |

Also restored: window size and position, theme, margins, mode, F7/F8/F9, zoom, and open tab paths (bodies only if the option above is on).

### Network behaviour

**TypoZen itself requests nothing over the network.** Fonts are bundled, the editor page is served from disk through a virtual host, and the page issues no outbound requests. A document that references a remote image (`![](https://…)`) will still load it — that is the document's request, not the app's.

**The WebView2 runtime is a different matter, and it is not fully silent.** The environment is created with Chromium's background services disabled:

```
--disable-background-networking  --disable-component-update
--disable-sync  --no-first-run  --no-default-browser-check
```

Even so, the browser process holds **two TLS connections to Microsoft-owned addresses** from startup, with no page having requested anything. Measured, not assumed — and several further flag combinations (`--disable-domain-reliability`, `--no-pings`, `--no-service-autorun`, `--disable-breakpad`, various `--disable-features`) did **not** remove them.

The endpoint is **not identified**. It does not appear in the Windows DNS cache (Chromium resolves independently) nor in `--log-net-log` output, so no claim is made here about which service it is. No document content is involved either way.

Removing it entirely requires something outside the app — a firewall rule on `msedgewebview2.exe`, which is the shared runtime binary and would also block remote images, or machine-level Edge policy. Neither is applied.

---

## Architecture

TypoZen is a **native shell around a browser engine**. The WPF side owns the window, tabs, menus and file I/O; everything inside the document area is HTML, CSS and JavaScript running in WebView2. Nearly every design decision follows from that split.

### Stack

| Layer | Shell (native) | Document surface (web) |
|-------|----------------|------------------------|
| Runtime | .NET Framework 4.7.2 — `TypoZen.exe`, `WinExe` | same process |
| UI | **WPF** — `TypoZen.xaml`, loaded at runtime via `XamlReader.Load` | `TypoZen_Template.html` — HTML + CSS |
| Controls | Title-bar tabs, menus, sidebar, status bar | `contenteditable` div; **vanilla JS, no framework** |
| Bridge | `WindowsFormsHost` → WebView2 (**WinForms flavour**) | `window.chrome.webview` messages |
| Theming | Recursive logical/visual tree walk + `SystemColors` brush keys | CSS from the same `TypoZen_Themes.json` |
| Typography | — | 4 families bundled in `fonts/`, `local()` first |
| Engine | Tabs, session, file I/O, encoding detection | `DocumentModel`, `HistoryManager`, virtualization |
| Build | MSBuild, or `CSharpCodeProvider` fallback | Runtime assets — edit without recompiling |

Because the XAML, HTML template and theme JSON are all loaded at runtime, the shell chrome, editor engine and themes can be changed without touching C# or rebuilding. Only `TypoZen_App.cs` requires a recompile.

> Sibling project **ZenSeek** uses the same content approach — WebView2 rendering a generated HTML document against a shared-shape theme JSON — but hosts it from a PowerShell script with a WinForms reader window rather than a compiled WPF shell.

### Document model
`DocumentModel` holds one canonical raw Markdown string per block and is the **authority for save, tab sync and host serialization** — the DOM is a projection of it, not a peer.

In Live Preview each line also carries a rendered form, so the two must never disagree. The invariants that keep them honest:

- **`data-raw` is canonical.** Every edit path updates it in the same transaction as the DOM.
- **Flush before leaving.** The active block is written back before any save, tab switch, mode toggle or host pull.
- **No length heuristics.** Truth is never decided by "whichever copy is longer" — that rule silently reverted deletions on save, and it is gone.
- **Model indices, not DOM ordinals.** Under virtualization the first mounted block is not block 0, so formatting, undo, find and caret restore all resolve through model indices.
- **A model splice renumbers the mounted DOM.** `data-model-index` is not decoration: `syncMountedToModel()` writes each mounted element's `data-raw` back into the slot its attribute names. Inserting or removing a block shifts every row after it, so the attributes on already-mounted elements must move too — `insertBlockAfterIndex` / `removeBlockAt` / `removeBlockRange` call `shiftMountedModelIndices` for exactly that. Leave them stale and the next remount copies the DOM's content into the *wrong* rows: a mid-document paste destroyed the line after the caret this way, and a cross-block delete lost an untouched line.
- **A structural edit splices the height map, it does not discard it.** `invalidateHeights()` throws away every measurement taken so far, so the next `prefixHeight()` for a distant row is rebuilt from estimates and the viewport pin moves with the error — 1562px per pasted block on a 3769-block document. `spliceHeights` keeps every untouched row's real height.
- **An element returned by `createBlock` may already be detached.** Under virtualization it remounts, which replaces every mounted element. Chain off the model index and re-resolve, never off the returned node.
- **Ordinary notes are never virtualized.** Virtualization is for large documents only; normal writing gets the full WYSIWYG DOM.
- **Progressive paint is M-band only**, gated on block count — never on a character count.

### Thresholds

Live constants in `TypoZen_Template.html`. Changing them changes which strategy a document gets, so they are listed here rather than left to be rediscovered:

| Constant | Default | Role |
|----------|---------|------|
| `VIRT_MIN_BLOCKS` | 2 000 | Virtualize at or above this block count |
| `VIRT_MIN_CHARS` | 120 000 | Virtualize at or above ~120 KB |
| `PROGRESSIVE_PAINT_BLOCKS` | 800 | M-band: full mount, deferred HTML paint |
| `PROGRESSIVE_CREATE_BATCH_BLOCKS` | 1 500 | M-band: create blocks in `requestAnimationFrame` batches |
| `overscan` | 40 | Blocks kept mounted above and below the viewport |
| `LARGE_DOC_CHARS` | 16 000 | Stats/preferences throttling only — **not** an open-mode or paint threshold |

Which path a Preview load takes:

| Condition | Path |
|-----------|------|
| blocks ≥ 2 000 **or** chars ≥ 120 KB | **Virtualized** — progressive never runs |
| 1 500 ≤ blocks < 2 000 | Progressive paint **+ windowed creation** |
| 800 ≤ blocks < 1 500 | Progressive paint, full DOM |
| blocks < 800 | Immediate full paint |

Two rules worth keeping: don't gate progressive paint on a character count (it belongs to block count), and don't lower the virtualization floor toward 16 KB without a deliberate product decision — ordinary notes are meant to stay full WYSIWYG.

> **Note:** `LARGE_DOC_CHARS` is aliased from a constant still named `SOURCE_FIRST_CHARS`. That name is historical — size no longer decides Source vs Preview, document type does. Worth renaming.

### Editor engine
Standalone vanilla JavaScript — no framework.

- **Custom snapshot undo/redo** (`HistoryManager`) rather than the fragile `contenteditable` undo stack, with byte- and step-capped history
- **2-stage Backspace** on list and heading prefixes — first press strips the marker, second merges blocks
- Precision join-point caret placement on merge and split
- Cross-boundary selection guard for multi-block delete
- **IME composition protection** — CJK and accent composition is never interrupted
- Plain-text-oriented paste; multi-line paste becomes clean blocks
- Horizontal rules: `---`, `***`, `___`, and spaced forms `- - -`, `* * *`, `_ _ _`

The reasoning behind these decisions — including the failure modes that motivated them — is preserved in [`docs/archive/`](docs/archive/). Those records are historical; this README describes what the code does now.

---

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| New | `Ctrl+N` |
| Open | `Ctrl+O` |
| Save | `Ctrl+S` |
| Save As | `Ctrl+Shift+S` |
| Print / Export PDF | `Ctrl+P` |
| Toggle Source / Live Preview | `Ctrl+/` |
| Toggle Sidebar | `Ctrl+\` |
| Find | `Ctrl+F` |
| Find & Replace | `Ctrl+H` |
| Insert table | `Ctrl+T` |
| Bold / Italic / Link | `Ctrl+B` / `Ctrl+I` / `Ctrl+K` |
| Strikethrough | `Ctrl+Shift+X` |
| Close tab | `Ctrl+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Help (syntax) | `F1` |
| Reveal Markdown | `F7` |
| Focus mode | `F8` |
| Typewriter scroll | `F9` |
| Fullscreen | `F11` |

**Menus (no default shortcut):** Themes → Customize Theme… · View → Editor Margins · File → Privacy

---

## Build

From the project folder:

```powershell
.\Build_TypoZen.ps1
```

- Uses **MSBuild** when available; otherwise compiles with **`CSharpCodeProvider`** (CodeDom) against the WebView2 DLLs beside the sources. The provider is used rather than `Add-Type` because `Add-Type` collapses every failure into one opaque message with no file or line.
- Output: `TypoZen.exe` in the project folder
- The full self-test suite runs first — a failing suite fails the build

**Runtime assets** (edit without recompiling C#):

- `TypoZen.xaml` — shell and menus
- `TypoZen_Template.html` — page shell; loads the two below by reference
- `js/typozen.js` — editor engine
- `css/typozen.css` — editor styling
- `TypoZen_Themes.json` — themes

Rebuild after changing `TypoZen_App.cs`. The build also parses `TypoZen.xaml` before compiling: it is loaded at runtime by `XamlReader`, so markup errors are invisible to the compiler and would otherwise surface as a crash on launch.

Also: `.\Create_Shortcut.ps1` · `.\Generate_Icon.ps1`

### Tests

```powershell
.\tests\run-tests.ps1                          # default gate (~37 suites)
$env:RUN_APP_E2E = '1'; .\tests\run-tests.ps1  # + drives the real TypoZen.exe
```

There are **four tiers**, and which tier a thing belongs in is decided by what it needs to observe, not by preference. Getting this wrong is how TypoZen shipped visibly broken behaviour behind a green suite for a fortnight.

| Tier | Naming | Runs by default | Sees |
|---|---|---|---|
| jsdom | `*-selftest.mjs`, `*-e2e.mjs` | yes | model, string and DOM-structure logic |
| browser | `*-browser.mjs` | yes | real layout, via headless Chrome |
| application | `*-app.mjs` | `RUN_APP_E2E=1` | the shipped `.exe` — WPF shell, real window |
| pending | `*-pending.mjs` | `RUN_PENDING_E2E=1` | behaviour not built yet |

**jsdom** is fast and covers the document model, dual-source invariants, virtualization thresholds and format indices, scroll stability, find under virtualization, sticky mode-switch, lists, undo, tabs, tables and clipboard conversion — plus a whole-file parse check, since the other suites extract individual functions and would not catch a syntax error elsewhere.

**jsdom has no layout engine.** `column-count` never applies, `scrollLeft` is inert and every `getBoundingClientRect()` returns zeros. It cannot distinguish "two columns" from "no columns". Any assertion about what is on screen must be a browser or application suite — writing it in jsdom produces a test that passes forever and proves nothing.

**Browser** suites (`smoke-browser`, `pagination-browser`, `twocol-anchoring-browser`, `edit-integrity-browser`) load `TypoZen_Template.html` in headless Chrome. `smoke-browser` is deliberately shallow — "does each feature visibly do anything" — because that is the class of check that was missing when 2-column mode shipped applying its CSS class while `column-count` stayed `auto`.

**Application** suites are the only ones that see what users see. `tests/app-harness.mjs` launches `TypoZen.exe --debug`, which opens the DevTools protocol on port 9333, and attaches with `puppeteer-core`:

```js
import { launchApp, sleep } from './app-harness.mjs';
const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
await app.eval(() => handleCommand('view_set:columns:2'));
await app.close();
```

This exists because column switching was "fixed" six times against headless Chrome, where the fault cannot occur. The differences that mattered were all outside the page: the WPF shell owns the window, per-layout window geometry resizes it on a column switch (1-column runs ~803px wide, not 1603), page width follows from that, and focus moves between WPF chrome and the WebView. The bug was ultimately a **2px** measurement slop that only produced a wrong answer at the real window size.

> **Run `RUN_APP_E2E=1` before claiming any column or pagination behaviour is fixed.** The runner prints this next to the skipped suites.

**Fixtures.** `tests/large-scroll-4000.md` is uniform; `tests/large-scroll-mixed.md` has images, long code fences, tables, headings and wrapping paragraphs. The second exists because uniform rows cannot exercise the height mapping that virtualized scrolling depends on.

`TypoZen_Template_Test.html` is **generated**, not edited. `tests/build-test-template.mjs` inlines the shipping `js/typozen.js` and `css/typozen.css` into the page shell, and both runners regenerate it first. It is gitignored. Before this existed the jsdom suites had silently pinned themselves to an Aug-1 snapshot missing `htmlToMarkdown`, `walkTable` and `set_column_mode` entirely — 27 suites reporting green against code that no longer shipped.

A GUI smoke test (`RUN_TAB_E2E=1`, pywinauto) drives the window through the WPF shell. It cannot see inside WebView2, so it verifies launch, tabs and window chrome only.

### Debugging

A normal run writes no log and opens no port.

```powershell
.\TypoZen_Debug.bat "tests\large-scroll-mixed.md"
```

`--debug` (or `TYPOZEN_DEBUG`) turns on the page's telemetry channel, appends it to `debug.log` beside the executable, and opens the DevTools port the application harness attaches to. The batch file clears the previous log first. Useful lines:

- `goToPage: block N is on page P of C` — which page a column switch chose, and why
- `settleTwoCol: corrected to page=N` — a post-layout correction fired
- `PageMap: built <layout> with N pages`

The page keeps a capped in-memory telemetry ring regardless, which the harnesses read; only the host round trip and console output are gated.

### Startup profiling

Off by default. Set `TYPOZEN_PERF` to write a startup timeline:

```powershell
$env:TYPOZEN_PERF = '1'        # this shell only — never set it persistently
.\TypoZen.exe "some\file.md"
Get-Content "$env:LOCALAPPDATA\TypoZen_Cache\perf.log"
```

Marks are milliseconds from entry to `Main`; the log is appended, so delete it between runs. The page adds its own marks (prefixed `(page)`) when the host navigates with `?perf=1`, so host and template appear on one timeline.

One representative cold open is below. **Treat the figures as a shape, not a benchmark** — repeat runs vary by roughly ±10%, and the session-restore line scales with how many tabs are being reopened:

| Mark | ms | Cost |
|------|----|------|
| XAML loaded | 309 | 286 |
| window Loaded | 357 | |
| WebView2 environment ready | 434 | 77 |
| WebView2 controller ready | 779 | 345 |
| template navigation completed | 893 | 114 |
| page reported ready | 900 | 7 |
| session restore done (2 tabs) | 915 | 13 |
| requested file loaded | **972** | 40 |

WebView2's own controller startup is now the largest single item and is not ours to remove.

**Two defects were found here, and both were invisible without these marks:**

*Blocking script call inside a message handler.* `LoadFileFromPath` was called synchronously from the WebView2 `ready` handler. It pulls editor state with a blocking script round trip, which cannot be delivered while that handler is still running, so both attempts ran to their 3 s timeouts. Deferring the load with `Dispatcher.BeginInvoke` cut it from 6,015 ms to 35 ms. The same pattern existed on the "reopen last file" path.

*DNS lookups for virtual hosts.* `localapp` and `docfolder` are served from disk by `SetVirtualHostNameToFolderMapping`, but Chromium still resolves them as hostnames on every navigation. Where DNS is remote — a VPN, for instance — that NXDOMAIN round trip cost ~2 s **per navigation** before the mapping was consulted. Measured in isolation, a 146-byte page took exactly as long as the 473 KB template, which is what identified it as per-navigation rather than payload. Pinning both names to loopback via `--host-resolver-rules` took navigation from 2,063 ms to 61 ms.

Together: a cold open went from ~8.9 s to ~1.0 s.

**Measure in-process, not from outside.** UI Automation calls marshal onto TypoZen's UI thread and cost ~150–200 ms each, so polling for a control during startup starves the startup being measured — that approach reported ~9 s for a cold open and stayed flat as the session grew, because the instrument dominated the result. These marks exist because that lesson cost real time.

### Working on TypoZen

**Testing**

- Tests assert **production logic** extracted from or hooked into the shipping files. Don't reimplement an editor helper inside a test when the real function can be extracted — a test that passes against its own copy proves nothing.
- **Pick the tier by what must be observed.** Layout, scroll position, page boundaries and caret behaviour need a browser or application suite. Putting them in jsdom yields a permanently green test of nothing.
- **Prove a new test can fail.** Reintroduce the bug and watch it go red. Several checks here looked like coverage and were tautologies — one compared page offsets against the same estimates the offsets were derived from, so it could only ever agree with itself.
- **A test that cannot pass yet is `*-pending.mjs`, not a commented-out assertion.** An earlier suite detected a real failure, commented out its own `process.exit(1)`, and printed `PASSED`; every build afterwards reported success and failure in the same run.
- If `switchTab` or another function evaluated in isolation gains a dependency, stub it in the suite that evaluates it — and re-run that suite. This has broken twice.

**Anchoring**

Use the anchor that already exists rather than deriving a new one:

- an edit → the **caret** (undo restores the caret of the state being undone, i.e. the edit site, not the restored state's own caret)
- a page turn → the **reading position**, carried across a column switch rather than re-measured, because a switch lands you at a page *start* and re-measuring decays one page per switch
- a mode switch in a scrolling view → caret if visible, else the top-left line

**Never move the view by hand**

- **Never call `editor.focus()`.** `#editor` is the whole contenteditable document, so focusing it scrolls its top edge into view — i.e. to line 1 — before the caller has placed the caret. Use `focusEditorNoScroll()`. This is what sent undo to the top of the document.
- **Never assign `mainContainer.scrollTop` to show a block.** Under virtualization the remount rebuilds the spacers, the document height collapses for a frame and the browser clamps the scroll back to 0 — the caret moves and the view does not. Use `restoreStickyDocumentLine(line)` when scrolling or `goToPageHoldingBlock(block)` when paginated. This pattern has been found and removed three times (outline, search, column switch); if a fourth appears, `grep "scrollTop ="` before adding another.

**Pagination**

> **Next piece of work: page windowing.** Pagination mounts the whole document, because the
> browser can only fragment content it has laid out. That is correct and it is why typing in
> Pages costs ~66ms per keystroke against ~7ms in Scroll on the 4582-line fixture: every
> character re-fragments one multi-column flow containing 3767 blocks. A 500-page epub is the
> same architecture with an order of magnitude more content, and epub reading *is* pagination,
> so this wants doing before Phase 5 rather than retrofitting into it.
>
> The shape that fits what is already here: split the document into fixed block ranges, lay
> out one range at a time, and keep a per-range page count. Cumulative sums give the global
> page number, exactly as `blockHeights` + `prefixHeight()` give the global scroll offset
> today -- same structure, same invariants, and the same rule that a structural edit splices
> the map rather than discarding it (see the Document model section). Unmeasured ranges are
> estimated from pages-per-block and refined as they are laid out, which is `estimateBlockHeight`
> again.
>
> Two things to get right, both already learned the hard way here. Anchor on **blocks**, not
> page numbers: page numbers move as estimates are refined, block indices do not, and the
> column round trip already depends on this. And measure the range currently on screen exactly
> rather than trusting its estimate -- an estimated current page is the 2px-slop bug wearing a
> different hat.


- Pagination is a real layout, not a scroll gesture: `.page-mode` puts the document into CSS multi-column and a page turn is a horizontal scroll. Don't reintroduce "scroll by ~90% of the viewport".
- Pagination and virtualization are mutually exclusive — the browser can only break content it has laid out — so entering page mode remounts the document. That cost is deliberate.
- Page geometry is uniform: page N is at `N × pageWidth`. Prefer arithmetic to a cached map.

**General**

- Prefer one concern per change: small diffs, easy to revert.
- Don't re-couple progressive paint to a character threshold, and don't lower the virtualization floor without a product decision.
- Where something genuinely isn't covered, say so plainly rather than implying coverage that doesn't exist.

This README is the single source of truth for how TypoZen works. Completed design records are kept under `docs/archive/` for history; they are **not** maintained, and where they disagree with this file, this file wins.

---

## Supported Markdown (practical)

**Yes:** headings, bold/italic/strike, inline code, fenced code, links, images (stored beside the document after save), blockquotes, bullet/ordered/task lists with basic indent, tables, thematic breaks (`---`, `- - -`, and friends).

**Limits — not full CommonMark or Typora:** advanced nested-list edge cases, math, Mermaid and similar extensions are not first-class features.

---

*Built with zen and focus for writers, developers, and Markdown enthusiasts.*
