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

### Reading epubs
Open a `.epub` and TypoZen becomes a reader: **Reader mode, paginated, read-only**, with the
book's own table of contents in the outline.

- A book's blocks carry the **publisher's own HTML**, not a Markdown conversion. Converting
  *Blindsight* to Markdown dropped 6/6 images, 162/162 links, 170/170 list items and 210/210
  footnote references, and broke 16 of 17 headings. Carrying the HTML has no conversion step
  and therefore nothing to lose.
- The book's stylesheets are applied, scoped to the editor, with three corrections: `rem`
  becomes `em` (a book sized in `rem` is rooted at the application and the reader's font-size
  control cannot touch it), the book's own `page-break-before: always` becomes
  `break-before: column` (a paged-media break is ignored by a multi-column layout), and
  `preserveAspectRatio="none"` is stripped from cover wrappers.
- **Body text renders at the size the theme asks for.** Publishers size against a device
  default they cannot see — one test book asks for 0.88 of base on every paragraph — so the
  book keeps its proportions and only its base is normalised.
- Chapters start a new page, images and internal links work, and the reading position is
  remembered per book across sessions.
- A book is never dirty, never saved over, and Save As refuses any path ending `.epub`.

### Position in a long document
In a paginated layout the foot of the page carries page numbers and a **scrubber that spans
the whole book**. It addresses pages rather than scroll offset, because the editor's own
scrollbar can only span what is currently laid out — about 28 pages of a 1400-page novel.

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
- Search sidebar (`Alt+S`) with **match case** and **whole word** as two glyph buttons in the search row. They drive the Ctrl+F checkboxes rather than holding a second copy, so the two views of one search cannot disagree
- While reading, **Up and Down** step to the previous and next match with the sidebar shut and your eyes on the text — the same keys the results list has always used. Reader only, and only when a search has results, so an arrow still scrolls a book nobody has searched
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
- CLI and Explorer: `TypoZen.exe "C:\path\doc.md"`; ZenSeek uses `--reader --search "q" --match-index N path` (see Phase 6 under Outstanding work)

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
| Engine | Tabs, session, file I/O (`TypoZen_App.cs` + `TypoZen_Themes.cs` partials) | `js/modules/*` — `DocumentModel`, `HistoryManager`, virtualization |
| Build | MSBuild / `Build_TypoZen.ps1` (CodeDom over all `*.cs`) | Runtime assets — edit without recompiling |

Because the XAML, HTML template and theme JSON are all loaded at runtime, the shell chrome, editor engine and themes can be changed without touching C# or rebuilding. Only `TypoZen_App.cs` requires a recompile.

> Sibling project **ZenSeek** uses the same content approach — WebView2 rendering a generated HTML document against a shared-shape theme JSON — but hosts it from a PowerShell script with a WinForms reader window rather than a compiled WPF shell.

### Document model
`DocumentModel` holds one canonical raw Markdown string per block and is the **authority for save, tab sync and host serialization** — the DOM is a projection of it, not a peer.

In Live Preview each line also carries a rendered form, so the two must never disagree. The invariants that keep them honest:

- **`data-raw` is canonical.** Every edit path updates it in the same transaction as the DOM.
- **Flush before leaving.** The active block is written back before any save, tab switch, mode toggle or host pull.
- **No length heuristics.** Truth is never decided by "whichever copy is longer" — that rule silently reverted deletions on save, and it is gone.
- **Model indices, not DOM ordinals.** Under virtualization the first mounted block is not block 0, so formatting, undo, find and caret restore all resolve through model indices.
- **A whole-document mutation reads the model, not the mounted DOM.** `mutateDocumentMarkdown` snapshots every block, mutates, and reloads the document from the result — so snapshotting `editor.querySelectorAll('.block')` meant rebuilding a virtualized document from the ~99 blocks on screen. Its indices are model indices throughout: what the mutator sees, what `opts.focusIndices` means, and what `_selectedFormatRaws` was already keyed by. Those three agreed only while the mounted window started at block 0, which is why a list indent deep in a document silently did nothing — a bounds check in the caller was the only thing keeping the call away from it.
- **A model splice renumbers the mounted DOM.** `data-model-index` is not decoration: `syncMountedToModel()` writes each mounted element's `data-raw` back into the slot its attribute names. Inserting or removing a block shifts every row after it, so the attributes on already-mounted elements must move too — `insertBlockAfterIndex` / `removeBlockAt` / `removeBlockRange` call `shiftMountedModelIndices` for exactly that. Leave them stale and the next remount copies the DOM's content into the *wrong* rows: a mid-document paste destroyed the line after the caret this way, and a cross-block delete lost an untouched line.
- **A structural edit splices the height map, it does not discard it.** `invalidateHeights()` throws away every measurement taken so far, so the next `prefixHeight()` for a distant row is rebuilt from estimates and the viewport pin moves with the error — 1562px per pasted block on a 3769-block document. `spliceHeights` keeps every untouched row's real height.
- **An element returned by `createBlock` may already be detached.** Under virtualization it remounts, which replaces every mounted element. Chain off the model index and re-resolve, never off the returned node.
- **Ordinary notes are never virtualized.** Virtualization is for large documents only; normal writing gets the full WYSIWYG DOM.
- **Progressive paint is M-band only**, gated on block count — never on a character count.

### Books

A book is a second **document kind**, not a second document model. `DocumentModel.kind` is
`'markdown'` or `'epub'`, and everything downstream branches on it rather than on a separate
code path: search, the outline, the word count, page windowing and the column round trip are
the same code for both.

| Piece | Where | Does |
|---|---|---|
| `EpubReader.cs` | shell | Unzips to a cache folder, reads `container.xml` → OPF → spine, returns one JSON payload: title, author, assets base, stylesheets, TOC, documents. **No HTML processing at all.** |
| `loadBookPayload()` | page | Splits each spine document into blocks, builds the TOC, applies the book's CSS, mounts |
| `bookBlocksFromDocs()` | page | One block per top-level element of each `<body>`; also returns each block's owning document directory |
| `applyBookStyles()` | page | Scopes every rule to `#editor` and applies the three corrections listed under Highlights |
| `rewriteBookUrls()` | page | Resolves `src` / `href` / `xlink:href` **against the document the block came from** |

Two things about that last row, because both were wrong first:

- **An image href is relative to its own spine document, not to the book root.** One test book
  keeps documents in `OEBPS/Text/` and images in `OEBPS/Images/`, so its covers are
  `../Images/…`; the other is flat at the archive root and resolved correctly under a shared
  base by accident. A single assets base works for exactly one of them.
- **A cover is usually not an `<img>`.** Both test books wrap it in
  `<svg><image xlink:href="…"></svg>`, which no `img` rule and no `src` rewrite touches.

Two things make reopening a book cheap. `EpubReader` caches the assembled payload beside
the extracted assets against the same stamp, so a reopen is a file read rather than a
re-read and re-escape of every spine document. And `SyncActiveTabFromEditor` skips a book
entirely: it is read-only, never dirty, never saved, and reloaded from the file rather than
from `Content`, so pulling it was marshalling the whole book across the WebView bridge on
every tab switch — 1,043,141 characters, which the page produces in 2 ms and the bridge
takes six seconds to hand over.

A book's block `raw` is the publisher's markup, so `renderBlockPreview` sets it as HTML and
returns before any of the Markdown renderer runs. The editor refuses to become editable while
a book is open, `GetDirtyTabs()` skips `.epub` tabs, and `ReadTextFileDetect` returns empty
for one — a book cannot be edited, marked dirty, or saved over.

### Page windowing

Pagination lays out the whole document, because the browser can only fragment content it has
already laid out. That is correct and it is why an unwindowed 40,656-block omnibus put every
block into one multi-column flow. `PageChunks` splits the document into fixed block ranges,
lays out **one range at a time**, and keeps a per-range page count — cumulative sums give the
global page number, exactly as `blockHeights` + `prefixHeight()` give the global scroll offset.

- Unmeasured ranges are estimated from pages-per-block and refined as they are laid out.
- **Blocks are the anchor, not page numbers.** Page numbers move as estimates are refined;
  block indices do not, and the column round trip already depends on that.
- The range on screen is measured exactly, never trusted from its estimate.
- A structural edit **splices** the map rather than discarding it, the same rule as the height
  map.

`PageChunks.size` is 800 blocks. It was 400, tuned on a Markdown fixture; measured on two real
novels, the cost that matters is the page turn that crosses a range boundary and has to lay
out the next one:

| Range size | In-range turn | Boundary crossing | Pages per range |
|---|---|---|---|
| 200 | 1 ms | 18 / 20 ms | 7 / 16 |
| **800** | **2 ms** | **74 / 84 ms** | **28 / 62** |
| 1600 | 3 ms | 201 / 172 ms | 55 / 124 |

Amortised over the pages between crossings it is flat at every size, so the choice is the
worst case a reader feels against how much of the book is laid out at once — which is also
how far the editor's own scrollbar reaches.

**The scrubber exists because that scrollbar cannot reach the ends.** It addresses pages;
`PageMap.goto()` already mounts the range a page falls in, so seeking anywhere is the same
operation as turning a page. It seeks on release rather than on every input event, because a
drag would otherwise mount a range per pixel of travel.

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
| `PAGE_WINDOW_MIN_BLOCKS` | 800 | Page windowing engages at or above this block count |
| `PageChunks.size` | 800 | Blocks per laid-out range while paginated (measured — see Page windowing) |
| `PageChunks.perBlock` | 0.06 | Seed pages-per-block for ranges not yet measured |
| `PAGE_FOOT_RESERVE` | 26 px | Strip at the foot of a page for the numbers and the scrubber |
| `MaxRememberedBooks` | 64 | Reading positions kept in `book_positions.txt` |

`LARGE_DOC_CHARS` is **only** for stats/preferences throttling. It is no longer aliased from a historical `SOURCE_FIRST_CHARS` name — size does not choose Source vs Preview; document type does.

Which path a Preview load takes:

| Condition | Path |
|-----------|------|
| blocks ≥ 2 000 **or** chars ≥ 120 KB | **Virtualized** — progressive never runs |
| 1 500 ≤ blocks < 2 000 | Progressive paint **+ windowed creation** |
| 800 ≤ blocks < 1 500 | Progressive paint, full DOM |
| blocks < 800 | Immediate full paint |

Two rules worth keeping: don't gate progressive paint on a character count (it belongs to block count), and don't lower the virtualization floor toward 16 KB without a deliberate product decision — ordinary notes are meant to stay full WYSIWYG.

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
| Previous / next search result (Reader) | `Up` / `Down` |
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
- `TypoZen_Template.html` — page shell; loads CSS and the engine modules by reference
- `js/modules/` — editor engine (ordered classic scripts; see `js/modules/load-order.json`)
- `js/typozen.js` — **deprecated stub** that throws if loaded; do not edit
- `css/typozen.css` — editor styling
- `TypoZen_Themes.json` — themes
- `fonts/` — bundled typefaces

The engine is seven modules sharing one global scope (not ES modules):

| Module | Concern |
|--------|---------|
| `01-core.js` | State, view selectors, margins, sticky line helpers |
| `02-layout.js` | Find/search, pagination, page windowing, column memory |
| `03-shell.js` | `onload`, themes, host commands, table picker |
| `04-lists.js` | List engine (indent, parse, Tab/Backspace ladder) |
| `04b-format.js` | Inline format, clipboard, keyboard editing paths |
| `05-model.js` | `DocumentModel`, virtualization, load/save of content |
| `06-render-epub.js` | Markdown render, epub load, book links/styles |
| `07-stats-host.js` | Stats bar, outline, host sync, export |

Edit a module and reload — no bundler step for the app. Tests concat the same files via `tests/engine-source.mjs` / `tests/build-test-template.mjs`.

Rebuild after changing `TypoZen_App.cs`. The build also parses `TypoZen.xaml` before compiling: it is loaded at runtime by `XamlReader`, so markup errors are invisible to the compiler and would otherwise surface as a crash on launch.

Also: `.\Create_Shortcut.ps1` · `.\Generate_Icon.ps1`

### Tests

```powershell
.\tests\run-tests.ps1                          # default gate — jsdom + browser suites
$env:RUN_APP_E2E = '1'; .\tests\run-tests.ps1  # + 9 suites driving the real TypoZen.exe
```

There are **four tiers**, and which tier a thing belongs in is decided by what it needs to observe, not by preference. Getting this wrong is how TypoZen shipped visibly broken behaviour behind a green suite for a fortnight.

| Tier | Naming | Runs by default | Sees |
|---|---|---|---|
| jsdom | `*-selftest.mjs`, `*-e2e.mjs` | yes | model, string and DOM-structure logic |
| browser | `*-browser.mjs` | yes | real layout, via headless Chrome |
| application | `*-app.mjs` | `RUN_APP_E2E=1` | the shipped `.exe` — WPF shell, real window |
| pending | `*-pending.mjs` | `RUN_PENDING_E2E=1` | behaviour not built yet |

**jsdom** is fast and covers the document model, dual-source invariants, virtualization thresholds and format indices, scroll stability, find under virtualization, sticky mode-switch, lists, undo, tabs, tables and clipboard conversion — plus a whole-file parse check, since the other suites extract individual functions and would not catch a syntax error elsewhere.

**`parse-check.mjs` guards against invisible characters.** Five bugs in this project came from
writing a regex through a tool that interpreted the backslashes: `\b` became `0x08`, `\1`
became `0x01`, and a NUL ended up as a separator. Each produced a pattern that matches nothing
and looks entirely normal in an editor, and each presented as a feature silently doing nothing
— "No headings found" on every book, every internal link going nowhere, zero images reported
by a test that should have failed. The check covers the shipping sources **and** `tests/*.mjs`,
because the fifth one landed in a test.

**jsdom has no layout engine.** `column-count` never applies, `scrollLeft` is inert and every `getBoundingClientRect()` returns zeros. It cannot distinguish "two columns" from "no columns". Any assertion about what is on screen must be a browser or application suite — writing it in jsdom produces a test that passes forever and proves nothing.

**Browser** suites (`smoke-browser`, `pagination-browser`, `page-fit-browser`,
`twocol-anchoring-browser`, `edit-integrity-browser`, `clipboard-roundtrip-browser`,
`paste-code-browser`, `epub-reader-browser`, `search-keys-browser`, `search-perf-browser`)
load `TypoZen_Template.html` in headless Chrome.

Two of those are the fast checks worth running on every change rather than at the end:
`page-fit-browser` (9s) asserts no text passes the pane edge and a column still starts at
the left edge after a hundred page turns, at three fractional viewport widths and after a
resize; `search-keys-browser` (8s) covers the step keys and the search options end to end.
Page drift went unnoticed for a day because the only geometry check was a twenty-minute app
suite, so it was never run mid-iteration. `smoke-browser` is deliberately shallow — "does each feature visibly do anything" — because that is the class of check that was missing when 2-column mode shipped applying its CSS class while `column-count` stayed `auto`.

**Application** suites are the only ones that see what users see. `tests/app-harness.mjs` launches `TypoZen.exe --debug`, which opens the DevTools protocol on port 9333, and attaches with `puppeteer-core`:

```js
import { launchApp, sleep } from './app-harness.mjs';
const app = await launchApp({ file: 'tests/large-scroll-mixed.md' });
await app.eval(() => handleCommand('view_set:columns:2'));
await app.close();
```

This exists because column switching was "fixed" six times against headless Chrome, where the fault cannot occur. The differences that mattered were all outside the page: the WPF shell owns the window, per-layout window geometry resizes it on a column switch (1-column runs ~803px wide, not 1603), page width follows from that, and focus moves between WPF chrome and the WebView. The bug was ultimately a **2px** measurement slop that only produced a wrong answer at the real window size.

> **Run `RUN_APP_E2E=1` before claiming any column or pagination behaviour is fixed.** The runner prints this next to the skipped suites.

The nine application suites, and what each is the only place to check:

| Suite | Covers |
|---|---|
| `column-switch-app` | 2-col → 1-col → 2-col returns to the same layout and position |
| `page-window-app` | Only one range is laid out; page numbers stay in one coordinate system |
| `page-scrubber-app` | Dragging the position control reaches both ends of a 40,656-block book |
| `epub-open-app` | A real book end to end: opens in Reader and paginated, images load, covers keep their ratio, chapters start columns, TOC and outline jump, body text is the theme size, the file on disk is untouched |
| `book-position-app` | A book reopens where reading stopped — across **two real launches**, because surviving the process is the whole claim; and is not overwritten by the tab you came from, and shows no cover frame on the way |
| `tab-position-app` | A Markdown tab returns to its own place across a tab switch and a restart |
| `edit-integrity-app` | Paste and undo do not corrupt neighbouring blocks |
| `editing-sweep-app` | A survey of ordinary editing in every layout: typing, selection replace, Enter, Backspace-join, list continuation, Tab indent, undo/redo, Find and Replace/Replace All through the bar, and editing inside a table cell |
| `multi-block-edit-app` | Typing over a selection spanning two blocks, three trials per layout, each from a freshly entered layout |
| `virt-list-indent-app` | A list edit outside the mounted window lands, and costs no other block |
| `search-highlight-app` | Every match highlighted, the current one marked, and the shaded block is the one holding it |
| `search-perf-app` | Typing in the search box stays responsive on a large document |
| `shell-seam-app` | The WPF chrome, through UI Automation: every menu builds its items once, a theme chosen from the menu repaints the page and is put back, the tab strip lists what the page holds, and nothing is left modal |

**Assert on rendered geometry and loaded bytes, not on structure.** Every epub defect the
user reported had a green structural assertion sitting over it: an attribute *was* set, a
`src` *was* rewritten, a TOC entry *did* map to a block index — while the thing on screen was
broken. The checks that hold now measure `naturalWidth`, bounding-rect ratios against a
`viewBox`, column tops from per-fragment rects, and scroll position after a real `.click()`.

**Run book suites against both books.** `Matter` is flat at the archive root and `Xeelee` is
nested; they fail in opposite directions, and neither alone can catch both bugs. `epub-open-app`
runs its full pass on each.

**Drive real events.** `execCommand('insertParagraph')` is a path no keyboard reaches — Enter,
Backspace and Tab are all handled by the editor's own listeners. Swapping the sweep to real
`KeyboardEvent`s found, on its first run, that undo could not undo typing in a paginated
layout.

**Fixtures.** `tests/large-scroll-4000.md` is uniform; `tests/large-scroll-mixed.md` has images, long code fences, tables, headings and wrapping paragraphs. The second exists because uniform rows cannot exercise the height mapping that virtualized scrolling depends on.

Four real `.epub` files sit in `tests/` and the book suites read them directly —
`tests/epub-zip.mjs` is just enough ZIP to do that without a dependency. They are real books
on purpose: the converter that shipped looked perfectly reasonable against a hand-written
fixture, and it was only counting images and headings in a real one that showed it dropping
every single one.

| Book | Shape | Why it is here |
|---|---|---|
| `Matter` | 42 documents, flat at the archive root, NCX pointing every entry at one file | Asset paths that work under any base; a TOC that has to be repaired by title |
| `Xeelee Sequence` | 460 documents, assets nested under `OEBPS/`, 40,656 blocks | Per-document asset resolution; scale for windowing and the scrubber |
| `Dune`, `Nemesis Games` | untried | Spare shapes for when something book-specific is suspected |

`TypoZen_Template_Test.html` is **generated**, not edited. `tests/build-test-template.mjs` inlines the shipping `js/modules/*` (in load order) and `css/typozen.css` into the page shell, and both runners regenerate it first. It is gitignored. Before this existed the jsdom suites had silently pinned themselves to an Aug-1 snapshot missing `htmlToMarkdown`, `walkTable` and `set_column_mode` entirely — 27 suites reporting green against code that no longer shipped.

A GUI smoke test (`RUN_TAB_E2E=1`, pywinauto) drives the window through the WPF shell. It cannot see inside WebView2, so it verifies launch, tabs and window chrome only.

**`package.json` and `node_modules/` live at the repo root, not in `tests/`**, even though only
the tests use them. Node resolves `node_modules` by walking *up* from the importing file, so
`tests/*.mjs` finds a root install without anything being configured; a manifest at the root is
also where every tool looks for one. Three packages, all test-only: `jsdom` for the model tier,
`puppeteer` (which brings its own Chrome) for the browser tier, and `puppeteer-core` for the
application tier, which attaches to the DevTools port `TypoZen.exe --debug` opens rather than
launching a browser of its own. Nothing in the shipped application depends on any of it — the
editor is vanilla JS with no build step.

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
- If `switchTab` or another function evaluated in isolation gains a dependency, stub it in the suite that evaluates it — and re-run that suite. This has broken twice. `paste-html-selftest` extracts `htmlToMarkdown` alone by brace matching, so a helper it calls has to live **inside** that function; moving one out sent every case to the empty string.
- **Assert on what renders, not on what was set.** An attribute being present, a `src` being rewritten and a TOC entry mapping to a block index were all true while the screen was wrong. Prefer `naturalWidth`, rendered ratios, column tops and position-after-click.
- **Pick what you edit by what it is, not by where it sits.** `blockEls()[25]` is a paragraph in one layout, a blank line in another and a table row in a third, because the mounted window does not start in the same place every time — measured in 1-col Pages: index 24 a table, 25 empty, 26 a paragraph. Selecting five characters inside a table cell goes through the table serialiser, which reported "+1 instead of −4" and read exactly like a caret bug. That was the whole of `editing-sweep-app`'s intermittency, together with each step inheriting the selection and mounted window the previous one left.

**A gesture that needs a clean starting state gets its own suite.** Typing over a two-block selection failed about a third of the time as the last step of the sweep and is 5/5 from a freshly entered layout. Both facts are about the test. A check that passes two thirds of the time tells you nothing either way, so it is measured where the answer is trustworthy — `multi-block-edit-app`, three trials per layout — rather than left to flicker inside a longer run.

**Drive the real entry point.** Dispatched `KeyboardEvent`s, a real `.click()`, a real `DataTransfer`, `postMsg('open_file_path:')`, and the harness's own keyboard for typing. Calling the handler underneath tests a path no user reaches: three separate defects hid there, and it has since produced a false *positive* too — `execCommand('insertText')` over a selection spanning two blocks leaves the later blocks' text in place, which reads as data loss, while a real keystroke through the browser's input pipeline is clean.
- **Two quantities derived from the same mistake will agree.** The check that was supposed to catch page drift compared the page stride against the column pitch, both computed from the same number — so it passed while the text ran off the edge of the window. Assert against something the code did not produce: rendered geometry, bytes on the wire, the position after a click.
- **Scope a grep to what it means.** A check that the sidebar does not slide on hover searched the whole stylesheet for `translateX` and failed the day a tooltip needed centring.

**Anchoring**

Use the anchor that already exists rather than deriving a new one:

- an edit → the **caret** (undo restores the caret of the state being undone, i.e. the edit site, not the restored state's own caret)
- a page turn → the **reading position**, carried across a column switch rather than re-measured, because a switch lands you at a page *start* and re-measuring decays one page per switch
- a mode switch in a scrolling view → caret if visible, else the top-left line

**Never move the view by hand**

- **Never call `editor.focus()`.** `#editor` is the whole contenteditable document, so focusing it scrolls its top edge into view — i.e. to line 1 — before the caller has placed the caret. Use `focusEditorNoScroll()`. This is what sent undo to the top of the document.
- **A deferred load decides at request time, not at completion.** `loadMarkdownContent` seeds a fresh history at the end of the load; on the progressive path that end arrives across `requestAnimationFrame` batches, by which time `undo()` has already cleared `isRestoring` — so the seed wiped the stack undo was halfway through using and typing could no longer be undone. Capture the flag when the work is asked for.
- **`setCaretAtOffset` must handle an empty element.** Its fallback was guarded by `childNodes.length > 0`, which excludes precisely the case with no text to walk: the caret stayed wherever it was and typing into a blank line went nowhere.
- **Never assign `mainContainer.scrollTop` to show a block.** Under virtualization the remount rebuilds the spacers, the document height collapses for a frame and the browser clamps the scroll back to 0 — the caret moves and the view does not. Use `restoreStickyDocumentLine(line)` when scrolling or `goToPageHoldingBlock(block)` when paginated. This pattern has been found and removed three times (outline, search, column switch); if a fourth appears, `grep "scrollTop ="` before adding another.

**Pagination**

- Pagination is a real layout, not a scroll gesture: `.page-mode` puts the document into CSS multi-column and a page turn is a horizontal scroll. Don't reintroduce "scroll by ~90% of the viewport".
- Pagination and virtualization are mutually exclusive — the browser can only break content it has laid out — so entering page mode remounts the document. That cost is deliberate. Page windowing is what makes it affordable on a novel; see the Architecture section.
- Page geometry is uniform *within the laid-out range*: local page N is at `N × pageWidth`. Global page numbers come from `PageChunks`, and mixing the two prints a page number from one coordinate system beside a total from the other.
- **`break-before: column`, never `page-break-before: always`.** The legacy spelling is an alias for `break-before: page`, a paged-media break that a multi-column layout ignores completely. Written second it wins, and every chapter runs on mid-column while the marker attribute a test counts is present on all of them.
- **The last page is not always at `N × pageWidth`.** A document ending part way into its final page leaves a maximum `scrollLeft` short of that offset, so the map would name a position the browser will never hold. `PageMap.pages` clamps to what is reachable.
- **Never pin the pane to a whole number of pixels.** `width: 100%` resolves against a
  parent that is very often fractional — 911.36px and 1848.32px, measured in the running app
  — and flooring that for the page stride loses a third of a pixel per page: invisible on
  page 2, 148px of drift by page 411, with the previous column showing down the margin. The
  fix is a **fractional stride** read from `getBoundingClientRect()`, not `clientWidth`
  (which rounds). Pinning the pane instead fixes the arithmetic and breaks something worse:
  a pixel width does not follow its container, so a resize or a sidebar collapse leaves the
  column at its old size and the text runs off the window. Drift only accumulates when pages
  are stepped by addition, and every seek here is `index * stride` from the page number — so
  a fractional stride costs one rounding, once, and never grows.
- **Do not mutate layout inside a `ResizeObserver` callback.** `PageGeometry.relayout()`
  writes height, column-width and column-gap and hides the container's overflow; doing that
  in the observer's own callback is exactly what "ResizeObserver loop completed with
  undelivered notifications" reports. Idempotent writes do not help — the first pass after
  any real change still mutates. Defer to the next frame.
- **A fragmented element's `getBoundingClientRect()` is the union of its fragments.** A paragraph running from one column into the next reports a box spanning both. Use `getClientRects()` when asking where something is on a page — a check built on the bounding box reads a correctly broken chapter as prose sitting above a heading.

**Books**

- **Resolve a book's URLs against the document the block came from**, never against one shared assets base. Half the test books work either way, which is what makes the bug survive.
- **The reader's chosen size wins.** A book sized in `rem` is rooted at the application and the font-size control cannot reach it; a book asking for `0.88em` renders smaller than the theme. Both are corrected when the stylesheet is applied.
- **A mode implies its layout.** Reader is pages only, and setting the mode without the pagination it implies produced reader + scroll — a state the resolver cannot produce and, because Reader locks the scroll selector, one the toolbar cannot leave. Go through `resolveViewState`, or apply what it would have.
- Some books are broken in ways no reader can fix by following the file: one test book's in-text links point at `#filepos` anchors while its actual anchors are `calibre_pb_*`. Where the titles are recoverable, match by title — gated on the href having failed, so sound books keep their exact targets.

**General**

- Prefer one concern per change: small diffs, easy to revert.
- Don't re-couple progressive paint to a character threshold, and don't lower the virtualization floor without a product decision.
- Where something genuinely isn't covered, say so plainly rather than implying coverage that doesn't exist.

This README is the single source of truth for how TypoZen works. Completed design records are kept under `docs/archive/` for history; they are **not** maintained, and where they disagree with this file, this file wins.

---

## Outstanding work

Kept here rather than in a tracker so it stays next to the code it concerns. Ordered by what
a user would notice first.

### Next

- **Retire ZenSeek's own reader (Phase 7)** for types TypoZen already covers (md/txt/epub),
  once Phase 6 feels solid day to day. Docx/xlsx still use ZenSeek's built-in reader.

### Phase 6 — open from ZenSeek (done)

Double-click a search hit in ZenSeek (or Preview) launches **TypoZen** for
`.md` / `.markdown` / `.txt` / `.log` / `.csv` / `.epub`:

```text
TypoZen.exe --reader --search "query" --match-index 0 --line 42 "C:\path\doc.md"
```

| Flag | Meaning |
|------|---------|
| `--reader` | Open in Reader mode (pagination; books already do this) |
| `--search` | Query to find and highlight |
| `--match-index` | Which match (0-based), from ZenSeek's inline match list |
| `--line` | Fallback 0-based line if search is empty |
| path | Document to open |

A second TypoZen process hands the same payload to the running window over the named pipe
(`path` + `#tz1` option fields). After load, the host sends `external_find:` /
`external_goto_line:` so the page jumps and highlights.

TypoZen.exe is resolved as a sibling of the ZenSeek folder (`../TypoZen/TypoZen.exe`).
If it is missing, or the file is `.docx`/`.xlsx`, ZenSeek keeps its built-in reader.

### The module split, reviewed

`js/modules/*` replaced a 12,719-line monolith in a session that is not recorded here.
Reviewed mechanically rather than read end to end, which is both cheaper and better evidence:

- **331 functions in the monolith, 0 missing** from the modules.
- **26 function bodies changed** by the split, against 305 moved unaltered. That is the whole
  review surface, and most of those 26 are covered by suites that run against real books and
  real page geometry.
- **No function is defined in two modules**, and **no top-level binding is declared twice** —
  both now asserted by `modules-selftest`, because classic scripts share one scope and the
  first is a silent overwrite while the second is a runtime error on load.

`sanitizeBookHtml` was read line by line, being the one function where a regression is a
security problem rather than a bug. The split **strengthened** it — `template`,
`foreignObject`, SVG animation elements, `data:text/html` URLs and remote `<use>` were all
added — and none of that was asserted anywhere, so it is now. Doing that found a real defect:
the remote-`<use>` guard compared `el.tagName === 'USE'`, and an SVG element's `tagName`
keeps the case it was written in, so it had never once fired.

### Known gaps

- **Links that are broken in the file itself.** `Matter`'s in-text links point at `#filepos`
  anchors while its actual anchors are `calibre_pb_*`. When the fragment misses, TypoZen falls
  back to the link's **title text** against the TOC/outline (including when the *file* part of
  the href resolved but the fragment did not — that path used to land on the file start and
  skip the title). A mid-chapter cross-reference with no usable title still has nothing to
  match on and does nothing. No reader can invent anchors the publisher never wrote.
- **Two-column numbering: map = spreads, glass = leaf pages.** `PageMap` always counts
  spreads (one horizontal step). Foot numbers and the scrubber bubble convert through
  `pageDisplayFromSpread` only — never seek or store leaf page numbers.
- **Reading position is remembered twice, deliberately.** The path-keyed store
  (`book_positions.txt`) answers "reopen this file where I left it"; each tab also carries
  its own `ResumeBlock`, persisted as `resume=` in the session, which answers "come back to
  *this tab* where I left it". They differ when the same file is open twice, and only the
  tab can answer for an untitled buffer. What is still missing: a position is a block index,
  so it survives editing above it only as well as the block numbering does.
- **Custom table size uses `#tableModal`.** The Notepad-style grid picker is the default path
  (`Ctrl+T`); **Custom size…** opens the number-field dialog. Both share `insertMarkdownTable`.
- **Word Wrap is ignored on a page, and in books.** It is a source-editing setting: with it
  off, `body.nowrap` sets `white-space: pre` so lines run long and the pane scrolls sideways.
  A paginated layout has no sideways left to give — the horizontal axis *is* the page axis —
  so an unwrapped paragraph became one line thousands of pixels wide that started in its own
  column and ran across the next four, painting five pages of text on top of each other.
  Reported as *"the epubs are corrupt"*: the files were intact, `"wordWrap": false` had been
  sitting in `window_state.json` the whole time. `css/typozen.css` now overrides it for
  `#editor.page-mode` and `#editor.reader-mode`. The View menu still shows the setting's real
  state while reading, where it has no effect — the tick is honest about the preference, not
  about the current page.
- **The scrubber is pages-only.** A scrolling layout keeps the native scrollbar, which is
  correct there — virtualization gives it the full document extent — but it does mean the two
  layouts offer different controls.
- **Pagination typing cost (~66 ms/keystroke) is inherent.** Multi-column `contenteditable`
  re-fragments on every mutation. The pixel page height already removed the worse 200 ms
  path (`height: 100%`). There is no cheap JS fix without leaving real multi-column layout
  while editing; write in Preview+Scroll, read in Pages.

### Test coverage that is thinner than it looks

Said plainly, because implying coverage that does not exist is how this project shipped
broken behaviour behind a green suite:

- **The editing sweep is a survey, not a regression suite.** It now covers typing, selection
  replace, Enter, Backspace-join, list continuation, Tab indent, undo/redo, a selection
  spanning two blocks typed over with real keystrokes, Find and Replace/Replace All through
  the bar, and editing inside a table cell. It does not cover drag-and-drop, or editing
  outside the mounted window -- see the list-indent gap above.
- **The shell seam is covered thinly, not fully.** `shell-seam-app` drives the real menu bar
  through UI Automation and asserts the effect in the page. It does not click tabs: driving a
  click onto a title-bar tab through UIA proved unreliable, and tab *switching* is covered
  through the shell's own messages elsewhere. Dialogs are only checked for absence.
- **Every suite ran with default settings until Word Wrap broke every book.** Forty-nine
  suites, none of which had ever set `body.nowrap` — so a saved View setting that made the
  reader unusable was invisible to all of them, for as long as the reader has existed.
  `page-fit-browser` now runs its geometry checks with Word Wrap off as well as on. The
  other persisted settings (chrome auto-hide, status bar, zoom, session bodies) are still
  only ever exercised at their defaults.
- **Measure the ink, not the box.** `page-fit-browser` asserted that no *element* ran past
  the pane and passed while text ran 1,898px past it: a block's box is the column width
  whatever the text inside does. It now measures line boxes via `Range.getClientRects()`
  as well. Same family of mistake as the stride-versus-pitch check it was written to
  replace — a measurement that cannot see the thing it is named after.
- **Nothing tests theme rendering.** Contrast ratios and font loading are checked as data
  (`fonts-selftest`, theme JSON validation), never as pixels.
- **`Dune` and `Nemesis Games` have never been opened by a test.** They are there so a
  book-specific suspicion has somewhere to go.
- **The GUI smoke test is opt-in and rarely run.** `RUN_TAB_E2E=1`.

### Housekeeping the application does

Both caches are gitignored and rebuilt on demand; neither is safe to assume present.

| Directory | Holds | Swept by |
|---|---|---|
| `typozen_load/` | Document bodies and book payloads staged for the page to fetch | `PruneLoadStageDir` — files older than 5 minutes, everything on exit |
| `typozen_books/` | Extracted epub assets, one folder per book, keyed by a stable hash | `PruneOldBooks(keep: 8)` |

`PruneLoadStageDir` swept only `body_*.md` until it was corrected: a book payload is the
largest file the application writes, and 176 of them had reached **939 MB** before anyone
looked in the folder.

### Performance, measured

Re-measured after page windowing landed, because the previous figures were taken before it
and were wrong by an order of magnitude in the place that mattered most.

On the 4,582-line mixed fixture, median of 8–10 samples, layout forced before each reading:

| | 1-col Scroll | 1-col Pages | 2-col Pages |
|---|---|---|---|
| Typing, per keystroke | 1 ms | 4 ms | 3 ms (worst 8) |
| Serialising the whole document (205 KB) | <1 ms | 1 ms | — |
| Indenting a list item | 29 ms | 21 ms | — |
| Search across 2,100 matches | 5 ms | 20 ms | — |
| Page turn | — | 3 ms | 3 ms |

**Typing in Pages was 66 ms and is now 3–4 ms.** Page windowing is why: only one 800-block
range is in the multi-column flow, so a keystroke re-fragments that rather than 3,767 blocks.
The old figure was described here as inherent to real pagination. It was inherent to laying
out the whole document.

Indenting a list item reloads the document — `mutateDocumentMarkdown` mutates the model and
reloads from the result — and costs 21–29 ms for it. Slower than an ordinary keystroke, and
the price of that path being correct off screen rather than only on it.

Books: Matter (4,376 blocks) opens in 363 ms with its payload cached. Leaving a book tab is
257 ms and returning is ~1.2 s.

### Startup, and where it goes

1,151 ms from process start to the document being on screen, from the app's own marks
(`TYPOZEN_PERF=1`, `perf.log`):

| | |
|---|---|
| Main entered | 10 ms |
| WebView2 environment requested | 49 ms |
| XAML parsed (`XamlReader.Load`, 47 KB) | 366 ms |
| Window loaded | 419 ms |
| WebView2 environment ready | 487 ms |
| WebView2 controller ready | 889 ms |
| Template navigated and page ready | ~1,090 ms |
| **Document on screen** | **1,151 ms** |

It was 1,344 ms. The environment is created at the top of the constructor rather than at
`window.Loaded`: it needs a cache directory and the command line, both known then, so it
overlaps the XAML parse instead of queueing behind it. The controller that follows needs a
window handle and cannot move.

**The rest is not worth chasing, and the arithmetic that said otherwise was wrong.** The
366 ms before `window Loaded` looks like XML parsing and mostly is not. Parsing the same
file three times in one process:

```
parse 1: 216 ms     parse 2: 20 ms     parse 3: 20 ms
```

Roughly 196 ms of it is one-time WPF type loading and JIT, which a compiled `.baml` pays
too — it instantiates the same types. Compiling the XAML would save something like the 20 ms
of real parse work, not the 360 ms a first reading suggests, and it would cost the property
that the shell and its menus can be edited without recompiling. Measured before building it,
which is the only reason that is known.

What remains: ~470 ms spawning the WebView2 browser process, and ~260 ms navigating the
template and booting the page. Neither has an obvious lever.

---

## Supported Markdown (practical)

**Yes:** headings, bold/italic/strike, inline code, fenced code, links, images (stored beside the document after save), blockquotes, bullet/ordered/task lists with basic indent, tables, thematic breaks (`---`, `- - -`, and friends).

**Limits — not full CommonMark or Typora:** advanced nested-list edge cases, math, Mermaid and similar extensions are not first-class features.

---

*Built with zen and focus for writers, developers, and Markdown enthusiasts.*
