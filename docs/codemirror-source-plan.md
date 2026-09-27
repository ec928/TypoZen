# Source mode on CodeMirror 6 — implementation plan

**Status: planned, not started (2026-09-27).** Ed chose CodeMirror 6 over colouring the
existing mirror: the best quality with no slowdown, accepting more work and more risk.
The alternative that was turned down, and why, is in `pdf-and-audit-plan.md` (audit 1.3).

Survey figures below were counted in this tree on 2026-09-27 and will drift; re-count at
the start of Phase 1 rather than trusting them.

## 1. What changes for the reader

- **Markdown in Source is highlighted, in the theme's own colours.** Headings larger and
  bold, `**bold**` bold, `*italic*` italic, markers (`#`, `**`, `>`, list bullets, link
  brackets) dimmed, code in the mono font, links in the link colour. **Every colour means
  what it means in Preview** -- a heading in Source is the colour a heading is in Preview.
  No colour is introduced that Preview does not already use.
- **Everything Source does today keeps working the same way:** list continuation on Enter,
  list Tab / Shift+Tab, undo shared with Preview, find and search highlights, spellcheck,
  pasting images and HTML, dropping files, word wrap, typewriter and focus modes, the
  selection popup, Read Aloud and Read from here, the status bar line, and landing on the
  same line when switching modes.
- **Plain files** (`.txt`, `.log`, `.csv`) open in the same surface with no highlighting.
- **Code blocks in Markdown, and CSS, XML, XAML, HTML and JSON files, are coloured by the
  lexers Preview already uses for code blocks** (`08-code.js`), so code looks the same in
  both views and nothing is added to the bundle (decisions 2 and 3). Colour only: TypoZen
  is still not a code editor (`for-agents.md`).
- **Not added:** line numbers, a code-folding gutter, bracket auto-closing, autocomplete,
  CodeMirror's own search panel, and multiple cursors. Each would be a new behaviour, and
  several take shortcuts TypoZen already uses.

## 2. Licences — verified

Every package was checked against the npm registry on 2026-09-27. All are **MIT**, and
nothing in the tree is GPL, LGPL or otherwise copyleft.

| Package | Version | Licence | Why it is needed |
|---|---|---|---|
| `@codemirror/state` | 6.7.6 | MIT | document, selection, transactions |
| `@codemirror/view` | 6.43.13 | MIT | the editing surface |
| `@codemirror/commands` | 6.11.1 | MIT | cursor and selection key commands |
| `@codemirror/language` | 6.12.4 | MIT | highlighting framework |
| `@codemirror/lang-markdown` | 6.5.2 | MIT | the Markdown language |
| `@lezer/markdown` | 1.7.2 | MIT | Markdown parser |
| `@lezer/common`, `@lezer/highlight`, `@lezer/lr` | 1.5.3, 1.2.4, 1.4.10 | MIT | parser runtime |
| `style-mod`, `w3c-keyname`, `crelt`, `@marijn/find-cluster-break` | 4.1.4, 2.2.8, 1.0.7, 1.0.4 | MIT | small helpers of `view` / `state` |
| `@codemirror/lang-html`, `lang-css`, `lang-javascript`, `@codemirror/autocomplete`, `@codemirror/lint`, `@lezer/html`, `@lezer/css`, `@lezer/javascript` | current | MIT | pulled in by `lang-markdown` for HTML inside Markdown; possibly bundled, see Phase 0 |
| `esbuild` | 0.28.2 | MIT | **build tool only, never shipped** |

**Obligations.** MIT requires the copyright and permission notice to ship with the code.
Phase 0 adds a CodeMirror section to `THIRD-PARTY-NOTICES.txt` with the text copied from
each package's own `LICENSE` file, not retyped. It also checks that file against the
registry's `license` field, because a registry field is a claim, not the licence. The
bundle keeps the licence comments (esbuild `--legal-comments=eof`).

**No network.** CodeMirror makes no requests. The About box, the README and the Store
listing keep saying that TypoZen goes online only to install an extension.

## 3. Why this is not the parked code-editor attempt again

`developer-editor-analysis.md` records a code editor built on Preview that **corrupted
real files**. It is the right thing to ask about, because CodeMirror 6 also edits through a
`contenteditable` element.

The difference is **who owns the text**. The parked attempt had TypoZen rebuild the
document from the DOM after each keystroke (`textContent`, `innerText`, splitting blocks),
and each of those steps changed bytes. CodeMirror owns its buffer (`state.doc`), the way
Scintilla does for Notepad++. The DOM is a picture CodeMirror draws from that buffer and
reconciles back into it with its own well-tested code. It is the "owns its buffer" model
that analysis says an editor needs.

That only holds if TypoZen keeps to one rule, which this plan makes a guarded invariant:

> **Nothing in TypoZen reads Source text from the DOM.** The only source of the text is
> `view.state.doc`, through the surface in section 5. A suite checks this (Phase 1).

## 4. What exists today

Source is `<textarea id="source-editor">` (`TypoZen_Template.html:186`), held in the global
`sourceEditor` (`01-core.js:81`).

| Where | References | What for |
|---|---|---|
| `02-layout.js` | 60 | find, search highlights (the mirror), selection for lookups, replace |
| `03-shell.js` | 42 | input / key / paste listeners, mode switching, Select All, commands, insert |
| `04b-format.js` | 37 | formatting on a Source selection, typewriter scroll, sticky line, caret line |
| `01-core.js` | 36 | show/hide, sizing, scroll-to-line, line-from-scroll |
| `04-lists.js` | 18 | undo caret capture and restore |
| `05-model.js` | 16 | loading content, inserting text, drag and drop |
| `07-stats-host.js` | 14 | selection word count, dirty flag, state for the host |
| `06-render-epub.js`, `09-speech.js` | 7 each | leaving a book, Read Aloud from Source |
| **Total** | **237** in 9 modules | |

**The textarea API they use:** `value` 47, `style` 27, `selectionStart` 26,
`selectionEnd` 14, `addEventListener` 13, `scrollTop` 11, `focus` 10, `setSelectionRange`
7, `setRangeText` 7, and a handful each of `clientHeight`, `scrollHeight`, `scrollLeft`,
`getBoundingClientRect`, `select`, `readOnly`, `dispatchEvent`.

**Outside the modules:**
- **The host's save path reads Source directly:** `FetchDocumentStateBlocking`
  (`TypoZen_App.cs:11451`) runs `sourceEditor.value`. This is the data-loss line: whatever
  replaces the textarea must answer it with the exact text.
- **Three CSS rules** (`#source-editor`, its `::selection`, and `body.nowrap`).
- **Three keyboard handlers recognise a field by tag name** (`02-layout.js:36`,
  `05-model.js:2475`, `10-pdf.js:440`: `tagName === 'TEXTAREA'`). CodeMirror's editable
  element is a `div`, so without a change **Preview's page keys would fire inside Source**:
  PageDown would turn pages instead of moving the caret, against the keyboard matrix.
- **Three places compare the focused element with `sourceEditor`** (`02-layout.js:640`,
  `05-model.js:2259`, and the drop handler). The focus will be CodeMirror's inner element,
  not the surface.
- **11 test files** drive the textarea: `core-smoke-app`, `edit-integrity-app`,
  `mode-switch-sticky-e2e`, `read-aloud-app`, `regression-selftest`, `select-all-app`,
  `smoke-browser`, `source-highlight-app`, `source-indent-app`, `source-popover-app`,
  `spell-selftest`.

**A mirror that exists only because a textarea cannot be styled:** the search-highlight
mirror, `02-layout.js` about 5790-6045 (`ensureSourceHighlightLayer`,
`syncSourceHighlightGeometry`, `syncSourceHighlightScroll`, `paintSourceHighlights`). Its
geometry-matching code is the most fragile in Source today: a 1px wrap mismatch "ghosts
the whole document", as a CSS comment puts it. On CodeMirror it is not used; it stays for
the textarea path. (An earlier draft also listed a caret-measuring mirror for the
selection popup. There is none: `showSelPop` places the popup at the mouse in Source, and
only its comment mentions a mirror.)

**Found during the survey, unrelated:** `03-shell.js:833` looks up
`getElementById('sourceEditor')`, an id that does not exist, so that focus call has
never done anything. It is fixed in passing in Phase 1.

**Undo:** Source has no undo of its own. `HistoryManager` (`04-lists.js:2344`) keeps
whole-document snapshots shared with Preview, and the host routes Ctrl+Z to it. That stays.

**Cost per keystroke today:** each Source `input` rebuilds the document model from the
whole text (`DocumentModel.fromMarkdown(sourceEditor.value)`, `03-shell.js:334`). This
plan does not change that. It is the baseline the new surface is measured against, not
something to fix here.

## 5. Design

### 5.1 One seam: the Source surface

A new module, `js/modules/01a-source.js`, loaded before `01-core.js`, creates the
CodeMirror view and returns an object that **behaves like the textarea for exactly the
members listed in section 4**. `01-core.js:81` then reads:

    const sourceEditor = createSourceSurface(document.getElementById('source-editor'));

Most of the 237 references keep working unchanged, so the swap is small and reviewable.
Phase 2 then moves the fragile paths (the mirrors, scroll-to-line) onto CodeMirror's own
calls one at a time.

The surface's rules, each covered by a unit test:

| Member | Behaviour |
|---|---|
| `value` (get) | `state.doc.toString()`, **cached per document version**, so the dozen reads per keystroke cost one copy, as a textarea's does |
| `value` (set) | replaces only the changed middle (common prefix and suffix kept), so selection, scroll and decorations survive; marked programmatic; **does not fire `input`**, same as a textarea |
| `selectionStart`, `selectionEnd`, `setSelectionRange`, `select` | the main selection; CodeMirror offsets are UTF-16 code units, the same as a textarea's |
| `setRangeText(text, s, e, mode)` | one transaction; `select` / `end` / `start` / `preserve` as the DOM defines them |
| `scrollTop`, `scrollLeft`, `scrollHeight`, `clientHeight` | read from and written to CodeMirror's scroller |
| `addEventListener` | `input` from user transactions only; `select` when the selection changes; `scroll` from the scroller; key, mouse, paste, drag events from CodeMirror's root element |
| `dispatchEvent(new Event('input'))` | runs the `input` listeners (`02-layout.js:3042` relies on it) |
| `style.display`, `getBoundingClientRect`, `parentElement` | the wrapper element |
| `readOnly` | CodeMirror's editable state, through a compartment |
| `contains(node)` | new; replaces the `=== sourceEditor` identity checks |

**Line endings.** A textarea turns `\r\n` and lone `\r` into `\n`, and CodeMirror's
default does the same, so the text handed to the host is unchanged. A round-trip corpus
proves it (section 7), including CRLF, a BOM, tabs, trailing spaces, NUL, lone
surrogates, a 100,000-character line, and emoji ZWJ sequences.

### 5.2 Keys

CodeMirror's default keymaps are **not** used whole. They bind Ctrl+F, Ctrl+Z, Ctrl+D,
Alt+arrows, Ctrl+/ and Ctrl+[ to things TypoZen or the host already own. Source gets:

- **CodeMirror's `standardKeymap` only:** caret and selection movement, Home/End,
  PageUp/PageDown, delete-by-character and by-word, and Select All. That matches the
  matrix's "Source: default textarea" row.
- **TypoZen's two existing key behaviours, ported as highest-precedence commands:** list
  Tab / Shift+Tab (`03-shell.js:375`) and Enter-continues-indent-and-marker
  (`03-shell.js:415`). Both keep their IME guard.
- **Nothing else.** A suite presses every host and page shortcut in Source and checks that
  the TypoZen action fires (Ctrl+B / I / K / S / F / H / Z / Y, F1, F3, F7-F9, Ctrl+Shift+D).

The three tag-name checks become `isTextField(t)`, which also recognises CodeMirror's
content element. `for-agents.md` critical rule 1 still holds: the page handler bails for a
real field, never merely because something is `contenteditable`.

### 5.3 Undo

- **CodeMirror's `history` extension is not loaded.** `HistoryManager` stays the one undo
  history across Preview and Source; its Source snapshot and restore go through the surface.
- **The host's Ctrl+Z path is unchanged.**
- **Undo from the browser's own menu:** `beforeinput` events of type `historyUndo` and
  `historyRedo` are routed to `HistoryManager` as well, so no second undo can appear.

### 5.4 Highlighting and theme

- **Parser:** `markdownLanguage` from `@codemirror/lang-markdown` (CommonMark plus GFM
  tables, strikethrough and task lists: the dialect Preview renders).
- **One `HighlightStyle` whose colours are CSS variables** (`--tx`, `--tx-muted`,
  `--accent`, `--mono-font`, and whatever Preview's heading and link rules use: read them
  from Preview's CSS in Phase 3, do not invent new ones). A theme change then needs no
  reconfiguration. User themes and the Customise Theme dialog work automatically because
  they already set those variables.
- **Font:** Source already uses the prose font (`--font`), so heading sizes and bold do
  not fight a monospace grid.

### 5.5 Search highlights, geometry and scroll

- **Find and search marks become a decoration field** fed from `findState.matches`, whose
  offsets are already offsets into Source's text. **The search-highlight mirror is deleted.**
- **The selection popup** positions itself with `view.coordsAtPos`. **The caret-measuring
  mirror is deleted.**
- **Line and scroll mapping** (`hardLineFromSourceScrollTop`, `scrollSourceToHardLine`,
  typewriter scroll, sticky line) use `lineBlockAtHeight` and `scrollIntoView` effects.
- **Word wrap** switches `EditorView.lineWrapping` through a compartment when
  `body.nowrap` changes.

### 5.6 Spelling, input methods, large files

- **Spellcheck:** `spellcheck="true"` and `lang` on the content element. Chromium
  underlines inside CodeMirror as it does in a textarea, and the right-click suggestions
  come from the same menu (`AreDefaultContextMenusEnabled` is already on).
- **IME:** CodeMirror handles composition itself. The Enter command keeps its
  `isComposing` guard.
- **Large files:** CodeMirror draws only the visible lines, so a multi-megabyte log is
  cheaper to show than in a textarea. The per-keystroke model rebuild (section 4) is
  unchanged either way.

### 5.7 Bundling and staging

- `package.json` gains the packages above as **exact-version** dev dependencies, next to
  `pdfjs-dist`.
- `tools/cm-entry.mjs` imports only what TypoZen uses. `tools/Update-CodeMirror.ps1`
  (modelled on `Update-PdfJs.ps1`) runs esbuild into
  `js/vendor/codemirror/codemirror.js`: one IIFE exposing `window.TzCM`, minified, with
  licence comments kept.
- It loads as a classic script ahead of the modules (`TypoZen_Template.html`,
  `load-order.json`). `js/` is staged whole by the build scripts, so no staging-list
  change is expected. Phase 0 proves it against `bin\`, `dist\`, the installer and the
  MSIX (`test-the-artefact-that-ships`).

## 6. Phases

Each phase ends in a build Ed can try. **A phase that misses its exit criteria stops and
is reported. It is not patched around.**

| Phase | Work | Exit criteria | Estimate |
|---|---|---|---|
| **0 — Baseline and spike** | Install the packages (needs Ed's OK for the download). Bundle. Write the notices. Add `source-latency-app`, measuring today's textarea: keystroke-to-paint on an 80 KB Markdown file and a 5 MB log, and time to switch into Source. Add the round-trip corpus suite. Load the bundle into the page with no other change and measure startup with the existing `tzMark` timings. | Bundle size measured. The estimate is **350-500 KB minified**, so Phase 0 records the real figure. If `lang-html` and the parsers it pulls in do not drop out of the bundle, set up the Markdown language without them. Startup cost measured. **Go / no-go for Ed** if the cost is over 15 ms at startup. | 1 day |
| **1 — The surface** | `01a-source.js`; `sourceEditor` becomes the surface; identity and tag checks; Tab, Enter, paste, drop and `beforeinput` undo ported; `03-shell.js:833` fixed; the DOM-read guard. No highlighting yet. | Default gate green. The 11 Source suites updated and green. Round-trip byte-identical, including through the host's save path. Latency no worse than the textarea's +10%. | 3 days |
| **2 — Native paths** | Search decorations; popup coordinates; line and scroll mapping; typewriter; wrap compartment. **Delete both mirrors** (named in the commit title). | `source-highlight-app`, `source-popover-app` and `mode-switch-sticky-e2e` green. Every search-marks case the mirror was patched for (wrap swap, sidebar open and close, edit while searching) passes. | 2 days |
| **3 — Highlighting** | `HighlightStyle` from theme variables; heading sizes; dimmed markers; fences and code files through `08-code.js`'s lexers (decisions 2 and 3); Ed reviews on his themes, including a light one (Gruvbox light was hard to read last time). | Ed signs off on the look. Latency still within the limit, now with parsing on. | 1-2 days |
| **4 — Hardening** | IME by hand (Japanese and Chinese input); spellcheck and suggestions; 5 MB log; `core-smoke-app`; the visible-window suites while Ed is away; `packaged-smoke-app` against the MSIX; README, `for-agents.md` (module map, keyboard matrix row) and `known-issues.md`. Remove the textarea fallback. | Full gate and app tier green; every item in section 1 performed by hand, with a list of what was and was not performed. | 2 days |
| **Total** | | | **9-10 working days** |

**Fallback while it is built.** Phases 1-3 keep the textarea path behind a debug-only
switch, so a Source problem found by Ed can be told apart from a pre-existing one in one
restart. Phase 4 deletes it. Git tag `baseline-before-codemirror` marks the start.

### Phase 0 results (2026-09-27)

- **Packages:** installed at the pinned versions; every bundled package's own `LICENSE` file
  read (all MIT, Marijn Haverbeke). Notices added to `THIRD-PARTY-NOTICES.txt`.
- **Bundle:** `js/vendor/codemirror/codemirror.js`, **290 KB**, about 95 KB compressed
  (under the 350-500 KB estimate). The HTML, CSS and JavaScript parsers do not end up in
  it. It is not loaded by the page yet.
- **Startup** (`tests/cm-ab.mjs`, 7 interleaved runs, headless, cache off): **+16 ms**
  median to the last module, **over the 15 ms line**. The bundle's evaluation took a
  median 23.5 ms and creating the empty editor 4.8 ms. A (as shipped) ranged 191-250 ms on
  its own, so the difference is about the size of the noise. **Accepted by Ed
  (2026-09-27)**, with a condition: if further performance costs turn up, CodeMirror
  becomes an option rather than the default. So the textarea path is kept working behind
  one switch (`createSourceSurface`) rather than deleted in Phase 4 -- whether it is then
  removed or offered as a setting is decided with Phase 4's numbers.
- **Round trip** (`tests/source-roundtrip-browser.mjs`): 72 checks pass on the textarea;
  that is the bar CodeMirror must meet. The host turns CRLF into LF before the page sees a
  file (`TypoZen_App.cs`, load path), so line endings never reach Source.
- **Latency baseline** (`tests/source-latency-app.mjs`, `source-latency-baseline.json`),
  textarea, this machine:

  | Case | Keystroke to frame (median / p90) | Handler | Switch into Source |
  |---|---|---|---|
  | Markdown, 74 KB | 7.1 / 7.9 ms | 2.3 ms | 718-1578 ms (median 1025) |
  | Plain log, 5 MB | **216.9 / 237 ms** | 86.6 ms | -- |

  Typing in a 5 MB log already lags about a fifth of a second a key. About 87 ms of it is
  TypoZen's handler (the model rebuild); the other ~130 ms is the textarea laying out
  5 MB. CodeMirror lays out only visible lines, so Phase 1 should cut the second part.
  That is a prediction to measure, not a result.

### Phase 1 results (2026-09-27)

- **Source runs on CodeMirror** through `js/modules/01a-source.js`; the textarea path is
  intact behind `?source=textarea` / `TYPOZEN_SOURCE_ENGINE=textarea` (`--debug` only).
- **Round trip:** 146 checks pass -- the whole corpus on both surfaces, each asserted to be
  the one that ran. The corpus caught one real bug on the way (CRLF offsets in `value =`).
- **Latency** (`source-latency-app`, same machine as the baseline):

  | Case | Textarea | CodeMirror |
  |---|---|---|
  | Markdown 74 KB, keystroke to frame | 7.1 ms | **7.1 ms** |
  | Switch into Source | 1025 ms | 1079 ms (within 10%; the cost is the mode switch, not the surface) |
  | Plain log 5 MB, keystroke to frame | 216.9 ms | **59 ms** |

  The log's handler also fell from 87 to 33 ms: `value` is cached per document version
  instead of copied out of a textarea on every read.
- **Search marks** are CodeMirror decorations in Preview's find colours; the mirror is not
  used on this path. Hidden Source holds no marks (a bug the suite found: marks survived
  leaving Source).
- **Found and fixed on the way, not part of CodeMirror:** F3 / Shift+F3 had no handler
  anywhere although `for-agents.md` documented them (`source-keys-app`).
- **App suites green on CodeMirror:** source-highlight (both surfaces), source-indent,
  source-popover, source-keys, read-aloud, core-smoke, edit-integrity, undo-steps. **Not
  run:** `select-all-app` and the other visible-window suites (need Ed away).

### Phase 2 results (2026-09-27, `d0415e8`)

- On CodeMirror, Source reads and sets its position by real line layout
  (`sourceEditor.topLine()`, `scrollToOffset`); lines 900, 2000 and 3500 read back exactly,
  and a mode switch keeps the line on screen both ways (`source-landing-browser`).
- Typewriter mode centres the caret's line on CodeMirror. **Fixed on both surfaces:** it
  used to move the caret to the start of its line on every caret move.
- The textarea's mirror is **kept**, for the textarea path (Ed's condition).

### Phase 3 results (2026-09-27)

- **Markdown** highlighted with `tzmd-*` classes styled from Preview's own rules
  (headings at Preview's sizes in the text colour, bold, italic, strikethrough, code on
  `--code-bg`, muted italic quotes, link text in the accent); every marker and a link's
  address in `--tx-muted`.
- **Code** -- fenced blocks, and files of a code type -- through `08-code.js`'s lexers as
  `tzcode-*` classes; each colour rule now lists Preview's `::highlight` and Source's class
  together. `css`, `html` and `htm` added to the shared language table, so Preview colours
  ```` ```css ```` and ```` ```html ```` blocks too.
- **The document's type** comes from the host before each load (`doc_ext:`), because the
  load only said "plain or not". Plain text gets no highlighting.
- **Latency** with parsing on: Markdown 74 KB **5.9 ms** a key (textarea 7.1); switch into
  Source 1019 ms (1025); 5 MB log 67.5 ms (217; plain, so no parsing -- the 59 of Phase 1 is
  the same case, run-to-run variation).
- `source-colours-browser`: 26 checks -- classes on the right text, colours resolving to
  Preview's variables, code files lexed, plain text untouched.

### The slow switch into Source (2026-09-27, `763f629`)

- **Cause** (found in a separate investigation Ed commissioned): `applyViewState` reached
  Source by toggling the mode cycle, Preview -> Reader -> Source. The Reader step makes the
  whole laid-out document non-editable (`setEditorEditable(false)`) and the next step makes
  it editable again -- about 1.2 s of the ~1.7 s a switch took on a 74 KB file.
- **Fix:** `mode_to_source` enters Source through the existing Reader -> Source branch of
  `toggle_mode`, skipping the Reader step. A first version of the fix copied that branch
  into a second command instead; the copy had already lost the position re-read after
  soft breaks expand (the "mid-document Preview -> top of Source" jump the original's
  comment records), so it was replaced before landing. One way into Source.
- **Result** (`source-latency-app`, 74 KB): switch into Source **25.7 ms** median (samples
  124, 25, 26 -- the first is the first-switch warm-up), was 1025 ms. Typing unchanged
  (7.1 ms a key).
- **Proposed, not applied:** reading each block's stored `data-raw` in `getMarkdownContent`
  instead of the live `getBlockRaw`, measured by its author at 10-15 ms on the same file.
  It is the save path, where reading the page's copy instead of the model has lost text six
  times (`for-agents.md`), and after the fix above the saving is small. It needs
  `page-integrity-app`, `edit-integrity-app`, `multi-block-edit-app`, `editing-sweep-app`,
  `no-false-dirty-app` and `clipboard-roundtrip-browser` green before it is worth taking.

### Phase 4 results (2026-09-27)

- **Removed:** the textarea, its search-highlight mirror (about 210 lines of JS, 90 of
  CSS), and the `?source=` / `TYPOZEN_SOURCE_ENGINE` switch -- Ed: "no need for a fall back
  if it works". A missing CodeMirror bundle fails loudly at load.
- **The jsdom test page inlines the bundle,** so every suite runs the surface that ships.
- **Spelling:** deferred by Ed; see below.
- **Not done:** the visible-window suites (need Ed away), `packaged-smoke-app` (needs
  Developer Mode), and IME input by hand.

### Seen by Ed on 0.8.4 (2026-09-27)

- **Search marks slid left while typing above them** with the find bar shut and a query
  live. Cosmetic (the matches were right; a tab switch repainted them) and older than
  CodeMirror -- the textarea's mirror did the same. **Fixed** in `51619d3`: the search
  re-runs after an edit instead of repainting the old offsets.
- **Spelling underlines come and go -- the risk in section 8, realised.** A misspelling's
  squiggle vanished while focus was in the find box and came back when Source was focused
  again; some words typed into Source were never underlined at all. Likely mechanism, not
  verified: Chromium's spellchecker only checks the focused editable element and hangs
  its markers on DOM text nodes, and CodeMirror replaces a line's nodes whenever it redraws
  the line -- so markers are dropped and only return when Chromium rechecks. A textarea's
  inner nodes are never replaced, which is why this did not happen before (also not
  verified on the textarea side). **Deferred by Ed (2026-09-27): resolve later, not in
  Phase 4.** Found meanwhile: Preview runs two checkers -- Chromium's (the editor has
  `spellcheck="true"`) and TypoZen's own, which covers only the paragraph holding the caret
  (`runSpellCheckNow`), so in practice what readers see is Chromium's. Recommended: Source uses TypoZen's
  own spelling, as Preview does (host Windows spell check, painted as decorations in
  Preview's `typozen-spell` style, suggestions in the selection popup) -- one spelling
  engine and one look in both views, and decorations do not vanish on redraw. It changes
  where suggestions appear in Source (the popup instead of the right-click menu), so it is
  Ed's decision.

## 7. Tests

**New:**
- `source-roundtrip-browser`: the corpus in 5.1, through load → surface → host save
  payload, compared byte for byte.
- `source-surface-selftest`: every row of the table in 5.1, including "setting `value`
  does not fire `input`" with a control proving that typing does.
- `source-latency-app`: keystroke-to-paint and mode switch, against Phase 0's textarea
  baseline.
- `source-keys-app`: every shortcut in 5.2 reaches TypoZen, not CodeMirror.
- `source-dom-read-selftest`: no module reads text from `.cm-content` or `.cm-line`, by
  scan, like the existing `assets-selftest`.

**Updated:** the 11 files listed in section 4. Each assertion is read against current
product truth before it is changed (`for-agents.md`: a red suite is more often a stale
contract).

## 8. Risks

| Risk | Likelihood | What contains it |
|---|---|---|
| Text differs from what the textarea gave (line endings, surrogates, BOM) → a saved file changes | low | round-trip corpus through the real save path; Phase 1 exit criterion |
| A CodeMirror key binding shadows a TypoZen shortcut | medium without 5.2 | minimal keymap; `source-keys-app` |
| Preview's page keys fire in Source | certain without the tag-check change | `isTextField`; `page-arrow-keys-app` |
| Two undo histories | medium | `history` not loaded; `beforeinput` routed; `undo-steps-app` |
| Spellcheck squiggles flicker or vanish as CodeMirror redraws lines | unknown | Phase 4 by hand; if it misbehaves, report it before building around it |
| Startup slower | low-medium | Phase 0 measurement and go / no-go |
| Typing slower on large files | low | CodeMirror renders only visible lines; `source-latency-app` against the baseline |
| Highlight colours that mean something different from Preview's | medium | colours only from Preview's variables; Ed's review in Phase 3 |
| Plan figures stale by the time work starts | certain over time | re-count at Phase 1 |

## 9. Decisions (Ed, 2026-09-27)

1. **The download for Phase 0: approved.** About 20 packages from npm, roughly 4-5 MB
   unpacked, plus esbuild's Windows binary (about 10 MB), into `node_modules` only. Only
   the bundled file ships: an estimated 100-150 KB added to the release zip.
2. **CSS, XML, XAML, HTML (and JSON) files: highlighted**, because it is free. Done with
   `08-code.js`'s lexers (`xml` for XML, XAML and HTML, `clike` for CSS, `json`), not with
   CodeMirror's language packages, so the bundle does not grow and the colours match
   Preview's code blocks. The file kind comes from the host, which already decides plain
   against Markdown.
3. **Code fences in Markdown: coloured**, with the same lexers and `::highlight` colours
   Preview uses, so a fence looks the same in both views.

2 and 3 are one piece of work (a view plugin that runs a lexer over the visible lines),
about half a day in Phase 3.

## 10. Not verified by this plan

- **Bundle size and startup cost:** estimates until Phase 0 measures them.
- **Spellcheck and IME behaviour inside CodeMirror in WebView2:** expected to work, not
  tried.
- **"No slowdown":** CodeMirror's design supports it, but it is a claim to measure against
  Phase 0's baseline, not an assumption.
