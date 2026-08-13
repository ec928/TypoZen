# 🧘 TypoZen — WYSIWYG Markdown & Text Editor

**TypoZen** is a standalone hybrid Markdown and plain-text editor for Windows. It pairs a **WPF** shell with **WebView2** (Chromium) for a block-based live preview and a raw Source mode — native OS integration with a modern rendering engine.

Works well with **`.md`**, **`.txt`**, and related text files.

---

## Highlights

### Dual-mode editing
- **Live Preview** — block-based WYSIWYG (headings, lists, tasks, tables, code fences, emphasis)
- **Source Mode** — raw Markdown/text in a growing textarea (one scrollbar with the outer pane, never nested)
- Switch with the **Mode** control on the toolbar (Source / Preview / Reader); the lit segment is the **current** mode
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

### Reading PDFs, web, images, and media
Open these **read-only** on a Chromium surface (same tab strip). No document scrubber on these
tabs — that control belongs to paginated engine/book reading.

| Type | Behaviour |
|------|-----------|
| **PDF** | Chromium PDF viewer |
| **HTML** (`.html` / `.htm` / `.xhtml`) | **Rendered as a page** (default). Relative CSS/images resolve from the file’s folder |
| **CSS / XML / XAML / JSON** (and `.txt` / logs) | Normal **editor** document in **Source** — editable text, not a second “markup viewer” |
| **Images** | Fit-to-pane shell; **right‑click → Magnify** (Edge) for zoom/pan |
| **Video / audio** | Browser controls; missing codecs (often **HEVC / HVC1**) show a clear error (audio-only black frame is explained too) |

Format tools and Source/Preview are locked; the file is never marked dirty and never saved over.
**Print / Export PDF** (`Ctrl+P`) prints the surface you are looking at (native tab → native
WebView; document tab → editor). **Privacy Mode** (File menu) already applies — see
[Session & privacy](#session--privacy). Details: `docs/native-reader-plan.md`.

### Reading epubs
Open a `.epub` and TypoZen becomes a reader: **Reader mode, paginated, read-only**, with the
book's own table of contents in the outline.

- A book's blocks carry the **publisher's own HTML**, not a Markdown conversion. Converting
  *Blindsight* to Markdown dropped 6/6 images, 162/162 links, 170/170 list items and 210/210
  footnote references, and broke 16 of 17 headings. Carrying the HTML has no conversion step
  and therefore nothing to lose.
- The book's stylesheets are applied, scoped to the editor, with four corrections: `rem`
  becomes `em` (a book sized in `rem` is rooted at the application and the reader's font-size
  control cannot touch it), the book's own `page-break-before: always` becomes
  `break-before: column` (a paged-media break is ignored by a multi-column layout),
  `text-align: justify` becomes `text-align: var(--tz-align, left)` so **View → Justified**
  owns it (see Writing tools), and `preserveAspectRatio="none"` is stripped from cover
  wrappers.
- **Body text renders at the size the theme asks for.** Publishers size against a device
  default they cannot see — *Xeelee* asks for `0.88em` on its body classes, *Matter* for
  `1.33333em`. The correction divides the **declarations in the book's own stylesheet** by the
  measured factor and leaves `#editor` at exactly `--fs`, so text the publisher left unstyled
  is right without anything being done to it, `0.88em ÷ 0.88` is `1em` and right too, and a
  `1.5em` heading becomes `1.7em` — still half again the body, which is the proportion the
  publisher was expressing. Scaling the *container* instead, which is what this did first,
  is exact only for text wearing the class and wrong in the other direction for everything
  else: about one *Xeelee* paragraph in ten. Now 96.9% of its characters and 99.2% of
  *Matter*'s land on the theme size exactly.
- The factor is measured from the element that **directly owns each text node**, weighted by
  characters, and refined as more of the book mounts. Each of those was a bug in turn:
  measuring the block's first child read a container that inherits the theme size and hands
  it back, so *Matter* was declared correct while 99.2% of its text painted a third too
  large; counting elements rather than characters lets a drop cap outvote a chapter; and
  locking the factor on first sight took it from whatever range happened to be mounted, which
  on a resumed book is usually front matter — two launches of the same book measured 0.66 and
  0.74 for a factor that should be 0.75.
- **A plate gets the page it sits on.** A cover, frontispiece or part title — a picture with
  no text beside it — is sized to the page box, not to `vh`. `vh` is the *window*, which
  includes the tab strip, toolbar and status bar, so the old bound stopped a cover a quarter
  of a page short and shrank *Matter*'s below its own resolution (a 510×680 file painted at
  391×521). Covers are small files (294×500 to 510×739), so filling the page upscales the
  smaller ones — presence over sharpness, chosen deliberately, because a cover is furniture
  you glance at rather than text you read. A picture under 400px natural is not a plate: the
  *Matter* "About the Author" portrait is 230×233 and alone in its block, and filling a page
  with it at 3× was not an improvement.
- Chapters start a new page, images and internal links work, and the reading position is
  remembered per book across sessions.
- A book is never dirty, never saved over, and Save As refuses any path ending `.epub`.

### Position in a long document
In a paginated layout the foot of the page carries page numbers and a **scrubber that spans
the whole book**. It addresses pages rather than scroll offset, because the editor's own
scrollbar can only span what is currently laid out — about 28 pages of a 1400-page novel.

- **Click a page number** or press **`Ctrl+G`** to open a go-to-page prompt (leaf page number;
  in two-column mode that maps to the correct spread under the hood).
- **Turning pages** follows a fixed keyboard matrix (full detail in
  [docs/for-agents.md](docs/for-agents.md)). `PageUp` / `PageDown` and the wheel always turn
  the page in a paginated layout. **Without a live search**, arrows and `Space` turn the page
  only where nothing is editable — **Reader** and any **book** — because in **Preview** the
  arrows belong to the caret. **With search results**, Up/Down step hits everywhere except
  Source, and Left/Right turn the page (so you can page through a document while hunting a
  match without giving up hit navigation). Reader sets `#editor` to
  `contenteditable="false"`, which is the reliable “no caret” signal rather than a mode-name
  guess.
- The status bar shows the **current chapter** from the book TOC or document outline, updated
  as you read. **Click the chapter label** to jump to that chapter's start.
- **Bookmarks** — see below. Separately, jumping via search, outline, go-to-page, or chapter
  click leaves a **return breadcrumb** — **Return from Jump** (`Ctrl+Shift+J`) goes back to
  where you were reading. The breadcrumb is automatic rather than chosen, and session-local.

### Bookmarks
Named places that survive the exit, in a **Marks** tab beside Outline and Search.

Three ways to set one, because the single place marker this replaced went unused for
being two shortcuts and nothing on screen:

| Where | What |
|---|---|
| **The gutter** | Hover a paragraph and a hollow ribbon appears in the margin beside it; click to fill it, click again to remove. Drawn with `::before` and hit-tested by coordinate — a real element inside a `.block` would end up in `data-raw` and therefore in your document |
| **Marks pane** | **Mark this page**, which becomes **Remove this mark** |
| **Keyboard** | `Ctrl+Shift+M` toggles, `Ctrl+Shift+P` opens the pane |

- **Enter keeps your indentation in Source.** A textarea drops the caret to column zero, so every indented structure — a fence, a YAML block, a nested list — had to be re-indented by hand on every line. A list carries its marker too (`3.` becomes `4.`), and Enter on an empty bullet ends the list and removes the stray marker. Brackets and quotes are deliberately left alone: auto-closing them turns hostile the moment it guesses wrong, and prose is full of apostrophes
- **Look up and Find in document work in Source too.** They did not, and nobody had decided that: a textarea selection is not a DOM Selection, so the popover check for "is this inside the editor" failed and it never appeared. **Highlight stays out of Source** — it anchors to a block and Source has none, so it is hidden rather than shown-and-inert
- **Highlighting a selection opens the Marks pane on it.** A highlight is a faint wash over text you are already looking at, so pressing the button gave almost no evidence it had worked — and the list it joined was behind a collapsed sidebar and an unselected tab. Same move *Find in document* makes, through the same command the menu and `Ctrl+Shift+P` use

- **Ordered by position, never by when they were made.** You read forwards; a list in creation order has to be translated every time you look at it. The mark you are nearest is highlighted
- **Named from their own text**, so a new one is legible without being typed. Double-click to rename; empty the name to get the text back
- **Ticks on the scrubber** show every mark across the whole book — five marks over 604 pages is a shape you read at a glance
- **They survive the document being edited.** A mark stores the text it was set on as well as where it was: the index is a hint, the fingerprint is the truth, and they are resolved against each other on open. Insert a paragraph above a mark and it follows its own sentence rather than staying on a number. Searched outward from the hint, nearest first, bounded at 400 blocks — fingerprinting means parsing a block's HTML, and a 45,000-block omnibus would otherwise pay that half a million times per open
- **A mark whose text is gone is shown struck through**, not deleted. It is yours; dropping it silently on open is how a feature loses work
- Marks land on a block that renders something — a blank line is a block, and one marked there would have no fingerprint and so no anchor at all
- Stored in `bookmarks.txt` in the cache, keyed by path, last **64** documents; marks *within* a document are not capped. Your file never grows metadata because you read it, at the honest cost that marks do not travel with it

### Annotations
Select text and the Mark button becomes **Highlight selection**. A highlight is a bookmark with a range, and a note is a highlight with text attached — which is why bookmarks were built first: the anchoring is the whole problem, and this reuses it unchanged.

- Painted with the **CSS Custom Highlight API**, the same mechanism search uses for its matches. Not a `<mark>` element: a `.block` round-trips into `data-raw`, so anything wrapped round the words would become part of your document
- **Named by the words it quotes.** Double-click the row to write a **note** — for a highlight that edits the note, not the quotation, since renaming it would be rewriting the book
- Highlighting the same range twice removes it, the same toggle the gutter and the button use
- Stored beside bookmarks, with the same fingerprint anchor, so a highlight follows its sentence when the document is edited above it

> **Set Place Marker / Go to Place Marker are gone.** They were a one-item bookmark list that forgot itself on exit. Note that neither was your *reading position*, which is automatic, written atomically as you read, and unaffected by any of this.

### Looking a word up
Select text and a popover appears beside it — **Highlight** and **Find in document**, and for a single word the lookup itself. Beside the sentence rather than in a panel you have to look away to, which is the point of it; it is also what makes highlighting discoverable without the Marks pane open.

**Nothing is bundled and nothing is downloaded.** A dictionary is a file you choose: `dictionary.tsv` (word, tab, definition) or `dictionary.json` (`{"word": "definition"}`), beside `TypoZen.exe` or in the cache folder. `tools\Make-Dictionary.ps1` builds one from a **WordNet** download — free, permissively licensed, ~150k entries, one file — so you supply the download and it does the parsing:

```powershell
.	ools\Make-Dictionary.ps1 -Source C:\wordnet\dict
```
 TSV first, because that is what a WordNet or Wiktionary export converts to in one line of script, and because a 40 MB JSON parse on startup would be felt. Lookups are answered by the **shell**, not the page: a dictionary worth having is tens of megabytes, and marshalling that across the bridge to sit in the document's memory would cost more than the feature.

- A reader selects the word as it appears on the page, which is inflected more often than not, so a miss retries the obvious stems — `walking` → `walk`, `bodies` → `body`
- With no dictionary installed it says so, and how to install one
- **Follow a synonym** to its own entry — each word is a control, and a back arrow appears once there is somewhere to return to. A synonym you cannot look up is a dead end, which is most of what a thesaurus is for
- **One button, one answer.** Press **Look up** and the popover gives the **definition**, the **synonyms** below it, and **how many times the word appears** in what you are reading — together, in that order. It is deliberately not automatic: a word is selected to *copy* it at least as often as to ask about it, and a definition that arrives uninvited sits on top of the text you were working with. Offered only for a single word, since a paragraph has no definition
- **Synonyms** come from the same WordNet pass — a synset is a set of words that mean the same thing — written to `thesaurus.tsv` alongside the dictionary
- **Occurrence count works with no dictionary at all** — "appears 2,135 times in this document" is often the question actually being asked, especially in a novel

### Themes & typography
**25 built-in themes** in `TypoZen_Themes.json`. Each entry is a **named, established palette** (Bg / text / accent) plus a font stack and base size. **Save as New** writes back into the same file with a `Custom` flag, so the count on disk is 25 plus whatever has been saved — worth knowing before sharing the file, since a personal theme travels with it. The Themes menu lays them out in four columns at runtime: **Dark**, **Light**, **Mono** (font stack ends in `monospace`), and **Custom Themes** (where the **Customize Theme…** option lives).

| Column | Themes |
|--------|--------|
| **Dark** | Ayu Mirage, Catppuccin Mocha, Everforest, GitHub Dark Classic, Gruvbox, Gruvbox Serif, Kanagawa, Material Oceanic, Material Palenight, One Dark, Rosé Pine, Solarized Dark, Tomorrow Night, VSCode Dark+ |
| **Light** | Ayu Light, Catppuccin Latte, Gruvbox Light, One Light, Rosé Pine Dawn, Solarized Light, VSCode Light+ |
| **Mono** | Dracula, Monokai, Nord, Tokyo Night |
| **Custom Themes** | Custom saved themes, plus **Customize Theme...** |

**All set `FS` to 16** (base size for document and book normalisation). Palettes are reduced to three colours for the shell + page; they are not full syntax-highlight schemes.

Font stacks are TypoZen’s pairing: reading-oriented entries lean **Literata** / **Merriweather** / **Bookerly** (Gruvbox Light leads with Literata, Merriweather fallback); UI-oriented entries lean **Inter** / **Source Sans 3**; Mono uses **Cascadia Mono** / **Consolas** (on Windows).

**For epub / long reading** prefer serif + soft paper or low-glare dark over Mono/IDE themes:

| Situation | Themes |
|-----------|--------|
| Daytime novel | **Rosé Pine Dawn**, **Solarized Light**, **Gruvbox Light** |
| Night, still bookish | **Rosé Pine**, **Gruvbox Serif** |
| Night, soft green | **Everforest** |

Avoid the Mono column (Dracula, Nord, Tokyo Night, Monokai) for immersion; fine for code.

- **Fonts ship with the app** in `fonts/` (except system mono). No network font fetch. `local()` first so an installed copy wins. (WebView2 itself still does Microsoft traffic — see [Network behaviour](#network-behaviour).)
- **Deep recursive theming** — menus, toolbar, sidebar and status bar take the same brushes as the page.
- **Themes → Customize Theme…** — live preview, **Save as New** (built-ins never overwritten), Reset, Cancel.

Bundled OFL faces: Inter, Source Sans 3, Merriweather, Literata.

> **Bookerly is not.** It is Amazon's, drawn by Dalton Maag, and its copyright forbids redistribution without written permission. Two themes name it, and before it was bundled they silently rendered Georgia instead: an "install for me only" copy registers under HKCU and the WebView2 renderer sandbox does not enumerate per-user fonts, so `local('Bookerly')` found nothing. It is fine in a private build; remove `fonts/Bookerly*.ttf` and its `@font-face` block before distributing to anyone else.

> **Merriweather is 4.4 MB, and it is not the letterforms.** Its outlines are 144 KB, the smallest serif here. `GPOS` and `GDEF` account for 3.3 MB: it carries three variable axes (`wght`, `wdth`, `opsz`), so every kerning pair stores deltas for each axis combination. Inter has two axes and 150 KB of `GPOS`. Pinning `wdth` and `opsz` would recover most of it. `tests/fonts-selftest.mjs` checks that variable families declare their weight range, since a single declared weight pins the axis and makes the browser synthesise faux-bold.

> Earlier versions pulled these from Google Fonts via a `<link>` in `<head>`. That was a render-blocking network round trip on every cold start of a local editor, and because Google's CSS omits `local()`, it shadowed already-installed copies and re-downloaded them. Bundling removed both problems.

### Writing tools
- Find / Find & Replace (`Ctrl+F` / `Ctrl+H`) — searches the whole document model, so matches off-screen in a virtualized document are still found
- Search sidebar (`Alt+S`) with **match case** and **whole word** as two glyph buttons in the search row. They drive the Ctrl+F checkboxes rather than holding a second copy, so the two views of one search cannot disagree. Both options (and which sidebar tab you last used — Outline vs Search) are **remembered** across restarts
- **Recent searches** — the Search tab is a combo box: the last **8** committed queries (Enter, or a pick from the list) are kept **globally** (not per tab) in `settings.json`. Click the chevron or press ↓ on an empty box for the dropdown. Remove one with **×**, clear all from the menu footer or **File → Privacy → Clear Recent Searches**. **Alt+S** also restores the last text left in the Search box (selection still wins when you have one). Full **Clear Stored Data** still wipes history too
- **Search mode** (a live result list — sidebar need not stay open): **Up / Down** step previous / next match with eyes on the text; **Left / Right** turn the page when the layout is paginated. Without results, Up/Down are normal (caret in Preview, page turn in Reader). **F3** / **Shift+F3** also step next/prev. Same Up/Down behaviour the results list has always used
- Table insert (`Ctrl+T`)
- Reveal Markdown on focus (`F7`), Focus mode (`F8`), Typewriter scroll (`F9`), Fullscreen (`F11`)
- Editor margins: Narrow / Regular / Wide — real side padding, not column-width caps. Grouped in View with Line Spacing and Paragraph Spacing, because all three set the shape of the text block
- **Justified** (View) — **off by default, including for books.** Every test book asks for it — *Xeelee* on 96 rules, *Matter* on 7 — and those declarations are rewritten to read this switch rather than dropped, so they keep their selectors and the publisher's *centred* and *right-aligned* rules are untouched
- **Hyphenation follows justification**, because on a screen they are one decision. A browser justifies by stretching word spaces and nothing else, so justified-without-hyphens is what opens rivers of white down a narrow column; ragged-right-with-hyphens breaks words to close a gap that isn't there. Limits are `6 3 3` — six characters in the word, three either side of the break — against Chromium's default `5 2 2`, which will leave `a-` hanging at a column edge. `hyphens: auto` is **inert without a language**, so a book's own `<html lang>` is carried onto `#editor` and cleared when the book closes; hyphenating French by English rules is worse than not hyphenating, so a book that declares nothing inherits the page rather than being guessed at
- **Word Wrap** (View) — applies in **Source** and **scroll Preview** only. On **Pages**, **Reader**, or an **epub**, the menu item is **disabled** (no fake tick); the stored preference returns when wrap can apply again
- Sidebar (`Ctrl+\`): live outline (headings, or a book's own TOC) and the Search pane
- Zoom: `Ctrl++` / `Ctrl+-` / `Ctrl+0` or Ctrl+scroll
- **Notepad-style chrome** — document tabs in the **title bar** with min/max/close; File/Edit/View and format icons on the command row below
- **Auto-hide chrome** (View → Auto-hide) — tucks the command row, tab chips and status bar, keeping a slim caption for dragging and window controls. Pointer to the **top** (or bare Alt) restores the menu; pointer to the **bottom** reveals the scrubber alone so seeking does not flash the toolbar back
- The menu is **always discoverable** — there is no hide-the-menu toggle. When auto-hide is off it stays put; when on, reach the top of the window
- **Left-edge sidebar hover** (View → Side Panel Auto-hide) — **off by default**, and separate from chrome auto-hide: wanting a bare reading window is not the same as wanting the outline to follow the mouse. Switched on, and with the sidebar unpinned (closed by the toggle), moving the pointer to the extreme left temporarily opens Outline/Search; moving away closes it (stay band covers the full bar so Match case / Whole word stay usable). Opening with the toolbar, `Ctrl+\`, or Alt+S **pins** it until you close it again
- **Alt+F / E / V / T / H** open the matching top-level menu from the keyboard (including while the editor has focus); **Alt+S** is Search, not a menu letter

### Tabs
Full multi-document editing, with the tab strip living in the title bar.

- **New** with the `+` button or `Ctrl+N`; close with the tab's own button or `Ctrl+W`
- Cycle with `Ctrl+Tab` / `Ctrl+Shift+Tab`
- **Scroll arrows** appear only when the strip overflows, and the active tab is always scrolled into view
- **Per-tab unsaved indicator**, tracked independently of every other tab
- **Per-tab file fidelity** — each tab remembers its file's line-ending style (LF / CRLF) and whether it ended with a trailing newline, so saving one document never quietly rewrites the whole file's line endings
- **Per-tab column layout** — 1-Col or 2-Col belongs to the document, not the window: a novel wants a two-column spread and the notes file in the next tab does not. Recorded per tab and restored with the session. Source locks columns to 1, so the layout is only written down while the choice was actually available — glancing at raw Markdown does not forget a book's spread
- **Fail-closed switching** — if the editor's content cannot be synced back to the tab, the switch or new-tab operation is *refused* rather than proceeding and risking unsaved edits
- **Session restore** reopens your tabs on next launch (bodies only if you've enabled unsaved-document restore under File → Privacy)

### Lists
Bullet, ordered and task lists, with real nesting.

- **`Tab` / `Shift+Tab`** indent and outdent list lines — 2 spaces per level, maximum depth 6, spaces only (tabs are normalised on parse)
- Inside a table, `Tab` moves between cells instead and grows the table at the end
- **Backspace at column 0** walks a ladder: outdent one level → strip the marker (including ordered `1.` and task `- [ ]`) → merge with the previous block
- `Enter` continues the list at the same indent and kind; ordered numbering follows the previous item *at that level*
- **Headings are separated by space, not rules.** One hairline under `h1` only, mixed from the theme's own text colour rather than `--border` (which draws the sidebar edge and the scrollbar thumb — chrome furniture, and this lives inside the document). `h2` has none: solid-under-h1 plus dashed-under-h2 is the GitHub-markdown idiom, not a book one. Headings sit 1.25em from what precedes them and 0.3em from their own text, so a section reads as a section. No rule at all in Pages — `break-after: avoid` routinely puts a heading at the top of a column, which made the rule the second thing on the page and, across a two-column spread, two lines at different heights
- **Fenced code is syntax highlighted** — ` ```json `, ` ```xml `/` ```xaml `, and a C-family lexer covering ` ```cs `, ` ```js `, ` ```ts `, Java, Go, Rust and similar. A fence with no language, or one that is not recognised, is left plain rather than guessed at.
  Painted with the **CSS Custom Highlight API**, not by wrapping tokens in elements. That is not an implementation detail: a `<span>` inside a `.block` round-trips into `data-raw`, and Markdown's own DOM repair splits such spans into separate lines — which corrupted a real file when a whole-document code mode was attempted (see `docs/developer-editor-analysis.md`). Ranges are not DOM, so nothing can serialise, repair or split them. The trade is the API's property ceiling: colour only, no bold keywords or italic comments
- Formatting controls grey themselves out whenever the document cannot take an edit — Reader mode, and every epub. They were live-looking and inert there; Word Wrap had greyed itself and said why for a long time, and the nine controls beside it had not. Greyed rather than hidden, so switching modes never shuffles buttons under the pointer
- Formatting and toolbar list toggles preserve indent; un-listing clears it to level 0
- Indentation is a property of the raw Markdown (leading spaces), rendered with `margin-left` rather than nested `<ul>` DOM — so Source round-trips exactly

### Live statistics
The status bar updates continuously with word count, character count (both grouped — `40,772 words` is read, `40772` is counted; line numbers stay ungrouped, being coordinates the search gutter prints raw), estimated reading time (~200 wpm), total lines, **current line** (caret in Source/Preview — same document-line coordinate as Search result gutters after a jump), **current chapter** (click to jump to its start), zoom, and — when text is selected — **selected** word and character counts. Serialization is debounced so counters stay responsive on very large documents.

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
| **Privacy Mode** | **Off** | One switch: while on, **nothing that names a document, its contents, its position or its history is written**. Suppresses the tab session, reading positions, bookmarks and annotations, recent files, autosave, and the document-identifying half of `settings.json` (last file, last content, search history, last query). The three switches it subsumes are **disabled** in the menu rather than silently overridden. **Not** suppressed: window size, theme, margins, spacing — those describe the app, not the reader, and losing them every launch would cost you something for no privacy in return. **Forward-looking**: it stops new writes, it does not delete what is already stored — bookmarks and annotations are your work, and a toggle that destroyed them silently would be indefensible. Use **Clear Stored Data** for that |
| **Privacy Mode — books** | — | A book must be unzipped to be read, and extraction is keyed by a *readable* name (`Matter_-_Iain_M_Banks_68aa4804`), so the folder's existence alone says what you opened. Privacy Mode therefore **changes the destination** rather than sweeping afterwards: extraction goes to an opaquely-named directory under `%TEMP%`, deleted when the window closes and swept on a later launch if a crash prevented that. Books are served from their own virtual host (`localbooks`) so image URLs resolve from either root. The cost is re-extraction each session; within a session reopening stays fast |
| **Autosave** (File menu) | **Off** | Saves a dirty document ~2s after typing stops. Only for a tab that **already has a file** — an unattended save must never raise a Save As dialog, so an untitled buffer stays untitled and is covered by session restore instead. A book is never written. Goes through the same save path as `Ctrl+S`, so the atomic write, per-tab line-ending fidelity and the overwrite-loss guard all apply |
| **Remember unsaved documents between sessions** | **Off** | When on, dirty/untitled tab bodies are stored for restore. When off, nothing document-like is kept in the cache beyond what you explicitly save. |
| **Keep recent files list** | On | File → Open Recent |
| **Clear Recent Searches** | — | Drops the last-8 Search history and the restored Search-box text only |
| **Clear Stored Data** | — | Wipes TypoZen cache/session data only — **not** your documents. Includes recent Search queries, open tabs, recent files, match-case/whole-word, and web storage (on next launch). |

Also restored: window size and position, theme, margins, mode, line and paragraph spacing, justification, F7/F8/F9, zoom, scrubber/status-bar visibility, chrome auto-hide, side-panel auto-hide, open tab paths **and each tab's column layout** (bodies only if the option above is on), last eight Search queries, last Search-box text, match case / whole word, and which sidebar tab (Outline/Search) was active.

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

### Developer & Diagnostic Tools
TypoZen includes built-in tools to help diagnose layout and focus issues:

- **Developer Debug HUD (`Ctrl+Shift+D`)**: Toggle a real-time, on-screen HUD (also accessible via `Help -> Toggle Debug HUD`). It overlays current focus state, exact layout metrics (pagination, scroll position, page width), and search state. When toggled off, it has zero performance overhead.
- **Telemetry Logging (`TypoZen_Debug.bat`)**: Launching TypoZen via this script passes the `--debug` flag, which records high-volume layout telemetry (such as progressive rendering and column measurements) to a `debug.log` file in the application directory.

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
| `applyBookStyles()` | page | Scopes every rule to `#editor` and applies the four corrections listed under Highlights |
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
| Toggle Sidebar | `Ctrl+\` |
| Find | `Ctrl+F` |
| Go to page (paginated) | `Ctrl+G` |
| Search sidebar | `Alt+S` |
| Previous / next search result (when matches exist) | `Up` / `Down`, or `F3` / `Shift+F3` |
| Turn the page (any paginated mode) | `PageUp` / `PageDown`, or the wheel |
| Turn the page while search has matches | `Left` / `Right` (paginated); also `PageUp` / `PageDown` |
| Turn the page (Reader / book, no search hits) | Arrows, or `Space` / `Shift+Space` |
| Find & Replace | `Ctrl+H` |
| Bookmark this page (toggle) | `Ctrl+Shift+M` |
| Show bookmarks | `Ctrl+Shift+P` |
| Return from jump (search/outline/goto) | `Ctrl+Shift+J` |
| Insert table | `Ctrl+T` |
| Bold / Italic / Link | `Ctrl+B` / `Ctrl+I` / `Ctrl+K` |
| Strikethrough | `Ctrl+Shift+X` |
| Close tab | `Ctrl+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Open File / Edit / View / Themes / Help menu | `Alt+F` / `Alt+E` / `Alt+V` / `Alt+T` / `Alt+H` |
| Help (syntax & shortcuts) | `F1` |
| Reveal Markdown | `F7` |
| Focus mode | `F8` |
| Typewriter scroll | `F9` |
| Fullscreen | `F11` |

**Menus (no default shortcut):** Themes → Customize Theme… · View → Line/Paragraph Spacing, Editor Margins, Justified · View → Auto-hide, Side Panel Auto-hide · File → Privacy

Mode (Source / Preview / Reader) is the toolbar's Mode control and has no keyboard shortcut. `Ctrl+/` used to toggle Source and was removed: it duplicated one third of a three-state control, and a chord that cycles a state you cannot see is worse than the control that shows it.

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
|--------|-------|
| `TypoZen_App.cs` | `Program` (entry point, single-instance pipe, CLI), `TypoZenWindow` (the whole shell: tabs, session, menus, themes, file I/O, host↔page bridge), `ThemeInfo`, `ThemeCustomizeWindow` |
| `EpubReader.cs` | `EpubReader` — unzip, `container.xml` → OPF → spine, and the cached JSON payload. No HTML processing (see [Books](#books)) |
| `TypoZen_Launch.cs` | `LaunchRequest` — how a document was asked for: path plus ZenSeek's `--reader` / `--search` / `--line` / `--match-index` hints |

**Referenced assemblies.** Three DLLs sit beside the sources — `Microsoft.Web.WebView2.Core`, `Microsoft.Web.WebView2.WinForms` and `WebView2Loader`. The **WinForms** flavour only: the control is hosted in a `WindowsFormsHost`, nothing imports `Microsoft.Web.WebView2.Wpf`, and neither of the other two assemblies references it, so it is not shipped. The build fails with a named list if any is missing, and falls back to a sibling `Text Search` folder for the ones it cannot find. `TypoZen.ico` is passed as `/win32icon`. `TypoZen.csproj` describes the same build for MSBuild and Visual Studio — **keep it and `Build_TypoZen.ps1` in step**, since each carries its own copy of the reference list.

**Runtime assets** (edit without recompiling C#):

- `TypoZen.xaml` — shell and menus
- `TypoZen_Template.html` — page shell; loads CSS and the engine modules by reference
- `js/modules/` — editor engine (ordered classic scripts; see `js/modules/load-order.json`)
- `js/typozen.js` — **deprecated stub** that throws if loaded; do not edit
- `css/typozen.css` — editor styling
- `TypoZen_Themes.json` — themes
- `fonts/` — bundled typefaces

The engine is nine modules sharing one global scope (not ES modules), loaded in the order `js/modules/load-order.json` gives:

| Module | Concern |
|--------|---------|
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

**Not in source control, rebuilt on demand:** `TypoZen_Template.runtime.html` (stamped with `?v=` at launch so WebView2 cannot cache stale modules), `TypoZen_Template_Test.html` (the jsdom fixture, regenerated by `tests/build-test-template.mjs`), `obj/` (MSBuild intermediates), `TypoZen.pdb`, `typozen_load/` (staged document and book payloads, swept after 5 minutes), `typozen_books/` (extracted book assets), `debug.log`.

### Tests

```powershell
.\tests\run-tests.ps1                          # default gate — jsdom + browser suites
$env:RUN_APP_E2E = '1'; .\tests\run-tests.ps1  # + the suites driving the real TypoZen.exe
```

Tests are split into four tiers depending on what they need to observe:

| Tier | Naming | Runs by default | Sees |
|---|---|---|---|
| jsdom | `*-selftest.mjs`, `*-e2e.mjs` | yes | model, string and DOM-structure logic |
| browser | `*-browser.mjs` | yes | real layout, via headless Chrome |
| application | `*-app.mjs` | `RUN_APP_E2E=1` | the shipped `.exe` — WPF shell, real window |
| pending | `*-pending.mjs` | `RUN_PENDING_E2E=1` | behaviour not built yet |

- **jsdom** covers the document model, parse checks, and logic that doesn't depend on a layout engine.
- **Browser** suites load `TypoZen_Template.html` in headless Chrome to assert real layout, geometry, and search performance.
- **Application** suites use `puppeteer-core` to attach to `TypoZen.exe --debug` via the DevTools protocol, verifying WPF shell interactions and complex paginated layout behaviours.
- The bookmark, annotation and privacy suites (`marks-surfaces-app`, `annotations-app`, `privacy-app`) are written against one recurring failure shape rather than against their features: **two things deciding one answer**. They assert that *pressing a control does what the control said it would*, and — for anything that claims to suppress a write — they run a **control** first, so a green result means the suppression did something rather than that the trace was never written.
- `book-to-markdown-app.mjs` guards the transition that put a Markdown document into a book's column: **leaving a book leaves nothing behind**, and **a pane that cannot be measured is refused rather than invented**. It deliberately does *not* assert the rendering — `column-width` is a preferred width, so a single leaked column stretches to fill the pane and looks perfectly healthy; two earlier versions of that assertion passed with the bug present. The geometry checks are strictly more sensitive, because the leak has to happen before it can fragment anything.
- Some of them also drive the **chrome from outside the process** through `tests/shell-ui.ps1`, which reports menus, tab chips, dialogs and — via `-Command controls` — whether each toolbar control is actually enabled, over UI Automation as JSON. `format-availability-app.mjs` is the one that needs that last part: "greyed out" is a claim about the running window that no page-level suite can see. That is the only tier that can see what is actually painted: the page knows nothing about tabs, and the session file is written from the same model the model tests read, so both agreed with each other while the tab strip disagreed with both — see `tab-strip-paint-app.mjs`.

### Known issues and agent notes

Open defects and deliberate limitations: [docs/known-issues.md](docs/known-issues.md) —
reproduced and characterised only (not bare suite names).

**Agents / other tools:** read [docs/for-agents.md](docs/for-agents.md) first — keyboard
matrix, non-goals (no code editor revival, no inventing defects from suite noise), and
where truth lives. Parked developer-editor work: [docs/developer-editor-analysis.md](docs/developer-editor-analysis.md).

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
Get-Content "$env:LOCALAPPDATA\TypoZen_Cache\perf.log"
```

Marks are milliseconds from entry to `Main`; the log is appended, so delete it between runs. 

---

## Supported Markdown (practical)

**Yes:** headings, bold/italic/strike, inline code, fenced code, links, images (stored beside the document after save), blockquotes, bullet/ordered/task lists with basic indent, tables, thematic breaks (`---`, `- - -`, and friends).

**Limits — not full CommonMark or Typora:** advanced nested-list edge cases, math, Mermaid and similar extensions are not first-class features.

---

*Built with zen and focus for writers, developers, and Markdown enthusiasts.*
