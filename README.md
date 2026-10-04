# 🧘 TypoZen: ePub & PDF Reader, Markdown Editor
**Write in the morning, read in the evening, in the same quiet window.**

TypoZen is a beautifully simple, distraction-free app for Windows that combines a seamless Markdown editor with a proper ePub reader and a full PDF reader.

Whether you're drafting a new note or settling in with a good book, TypoZen gives you a calm, clean space to do it. It opens your `.md`, `.txt`, `.epub` and PDF files—as well as code, markup, images, and media—and remembers exactly where you left off in your documents and books.

**Privacy-first and completely free.** TypoZen asks nothing of the internet. There are no accounts, no sign-ins, and absolutely no tracking or telemetry. It just opens straight into your document. The one exception is an **extension** you choose to install from **File > Extensions**, which downloads while you watch and never afterwards — and if you install none, TypoZen makes no network request at all.

*(For the technically curious: Under the hood, TypoZen is a lightweight, native Windows app built with WPF and WebView2, offering both a live block-based preview and a Source mode built on CodeMirror 6 for Markdown and code.)*

---
## Get TypoZen
**[Install from the Microsoft Store](https://apps.microsoft.com/detail/9NGKCK27GTS1)** (Recommended)  
The easiest way. It installs cleanly, updates automatically, and gives no security warnings.

**[Run the installer](https://github.com/ec928/TypoZen/releases/latest)**  
Download `TypoZen-Setup-<version>.exe`. A standard Windows installer that doesn't require administrator privileges, making it perfect for locked-down work machines. You can optionally associate it with `.md` and `.epub` files.

**[Download the portable zip](https://github.com/ec928/TypoZen/releases/latest)**  
Just unzip and run. Nothing is installed, and it leaves no trace outside your user profile. Great for running straight from a USB stick.

*Note on versions:* The installer and portable versions are unsigned, so Windows may show a "Windows protected your PC" warning on the first run (click "More info" → "Run anyway"). They also won't update automatically. The Store copy can sit alongside either of the others and keeps its own settings, themes, bookmarks and reading positions; the installer and the portable zip are the same build, so those two share one set of settings and only one of them runs at a time.

*Requirements: Windows 10 version 1809 or later, 64-bit. Requires the WebView2 runtime, which is already present on current Windows.*

---
## Highlights

### Writing

- **Dual-mode editing:** Seamlessly switch between WYSIWYG Preview and Source. The two lay text out alike, so the line you are on stays where it is.
- **Source is a real code editor:** built on CodeMirror 6, with highlighting in your theme's colours for Markdown and for code and markup � HTML, XML, CSS, JSON, JavaScript, C# and more, plus features like structural code outline, line numbers, bracket matching, folding, and indent guides.
- **Live block editing:** Format Markdown and text on the fly, including headings, lists, tables, tasks, emphasis, and fenced code.
- **Deep immersion:** Engage Focus mode, Typewriter scroll, and ZenMode, which hides the whole UI until you reach for it, to eliminate distractions while you work.
- **Engineered for massive files:** Preview builds only the part of the document on screen, so a 200,000-character manuscript scrolls like a short note — and Find still searches every word of it. Source opens files of megabytes, with lines hundreds of thousands of characters long, at once.
- **Spelling as you type:** wavy underlines under every misspelled word on screen, in Preview and Source (not in code). Select any word for replacements, Ignore, or Add to dictionary.

### Reading & Research
- **A first-class .epub reader:** Paginated layout with a true two-page spread mode. Supports the publisher's native HTML, full TOC, reading scrubber, and per-tab session memory.
- **Read aloud:** Sit back and listen. Select a passage and press **Read aloud**, or press it with nothing selected to hear the page you're on, in any voice installed in Windows — or in a **Kokoro neural voice** or the **Qwen narrator**, if you install them. Choose the voice and speed in **File → Read Aloud**.
- **Built-in dictionary & thesaurus:** Over 150,000 offline definitions and over 110,000 synonym sets. Select any word for its most common meanings first — every other sense one click away — its synonyms, how often it appears in what you're reading, and a speaker button to hear it said in the voice you have chosen for reading aloud -- or, with the Qwen narrator chosen, in the quick voice on your computer closest to it (same country and gender), since the narrator takes too long to start for one word.
- **Document Search:** Dedicated search sidebar (`Alt+S`) with full match highlighting and navigation. Acts as a seamless reader for ZenSeek searches.
- **Marks & Annotations:** Highlight text, write notes, and drop bookmarks that intelligently survive document edits.
- **A full PDF reader:** single pages or two-page spreads, real selectable text, Find and Search across pages, the outline, read aloud, bookmarks and highlights, and your place remembered. Annotate, fill in forms and save; the text of scanned pages is read on your computer; save pages or pictures as images, and print.
- **Read everything else safely:** HTML, images, and media open read-only. Never dirty, never saved over. An HTML page's markup opens in Source from the Mode control.

### Look, Session & Privacy
- **Bundled premium typography:** Included fonts (Inter, Literata, Merriweather, Source Sans 3, JetBrains Mono) ensure perfect rendering without any network requests.
- **25 curated built-in themes:** Choose from dark, light, and mono themes, or use **Customise Theme...** to build and save your own palettes. Every state takes its colour from the theme, one colour per meaning: the accent for what is current (selection, the search match you are on, the paragraph being read aloud), a highlighter colour of the theme's own for marks, and faint washes of the text colour for hover and the cursor's paragraph.
- **Complete session restore:** Remembers your window layout, theme, tabs, margins, and exact reading positions. Drag tabs into any order; the order is kept.
- **Offline & Portable:** Zero telemetry, and nothing on the network unless you install an extension yourself. For complete peace of mind, **Privacy Mode** stops writing document history, positions, and recent files entirely.
- **Extensions, if you want them:** **File > Extensions** offers **Kokoro neural voices** for high-quality local read-aloud, a dictionary of 1.3 million words, and **Qwen narration** — an AI narrator that reads a book in character voices (experimental; needs an NVIDIA graphics card). All are optional downloads, all run entirely on your computer once installed, and removing one takes its menu away again.
---
## Architecture & Tech Stack
TypoZen is a hybrid native-web application designed for speed, local-first privacy, and an ultra-lightweight footprint.

- **Frontend & Engine:** A vanilla web stack running inside a Microsoft Edge **WebView2** control.
  - Markdown/Code editing is powered by **CodeMirror 6** for virtualized, massive-file performance.
  - The ePub reader is a bespoke, paginated HTML engine using native browser multi-column layouts.
  - PDF rendering is driven entirely client-side by Mozilla's **PDF.js**.
- **Backend (Host):** A monolithic **C# WPF** application (TypoZen_App.cs) that handles window management, deep OS integration, native file I/O, and fast inter-process communication (IPC) with the WebView2 control.
- **Data & Extraction (C#):** **PdfPig** is used natively for lightning-fast image extraction and offline document parsing without relying on the browser.
- **Extensions & AI:**
  - **Kokoro-JS:** Provides high-quality on-device neural Text-to-Speech (TTS) using ONNX models without internet connectivity.
  - **Qwen Narrator:** Uses local LLM integration for contextual, character-based story narration (requires NVIDIA GPU).
  - **Compromise.js:** A lightweight, offline Part-Of-Speech tagger used to resolve grammatical homographs for the speech engine.

### Supported Formats & Behaviors
TypoZen opens files intelligently based on their type. View settings are saved per document type and can be customized by the user.

| Media Type | Extensions | Default Mode | Default Layout (User Editable?) | Default Theme | Font Size / Spacing |
|---|---|---|---|---|---|
| **Code / Scripts** | .html, .css, .js, .cs, .json, .bat, .ps1, .log, .csv | Source | Scroll (Fixed) | Tokyo Night | Small / Tight |
| **Documents** | .md, .txt, untitled | Preview | Scroll (Yes) | Gruvbox | Normal / Normal |
| **E-books** | .epub | Reader | Pagination 2-Col (Yes) | Rosé Pine Dawn | Large / Relaxed |
| **PDFs** | .pdf | PDF View | Scroll 1-Col (Yes) | Catppuccin Latte | N/A |
| **Native Media** | .png, .jpg, .mp4, .mp3 | Read-only | N/A | N/A | N/A |

*Note: If you toggle a tab to Source or Preview mode, or change its column layout, TypoZen remembers that preference for that specific tab via session memory. Click the Mode buttons to reset it!*

- **Saving and Exporting:** Save text as UTF-8 (atomic write), export as standalone HTML, or Print / PDF. When installed, TypoZen appears under **Open with** in Explorer for Markdown, text, epub, code files and PDFs.
- **Smart linking:** Hover links for Open, Show in Folder, and Edit. Local files open in a tab, http links open in your browser, and #heading jumps seamlessly within the document.

---
## Writing & Editing

### Dual-mode editing
- **Live Preview** — block-based WYSIWYG (headings, lists, tasks, tables, code fences, emphasis)
- **Source Mode** - the raw Markdown/text, highlighted in your theme's colors. Code blocks and markup files (CSS, HTML, JSON, C#) are automatically syntax-highlighted. Built on CodeMirror 6 for massive-file performance.
- Switch with the **Mode** control on the toolbar (Source / Preview / Reader); the lit segment is the **current** mode
- **Sticky mode switching** — the line at the top of the screen stays at the top when you toggle, for both the status readout _and_ the scroll position. Source and Preview lay a line out alike (same margins, width and spacing), so text does not shift between them
- **Large code files** — a 2.2 MB HTML file with a 356 KB line opens in Source and reaches that line in a fraction of a second; code is not spell-checked
- Source uses the **active theme font** (pick a **(Mono)** theme if you want monospaced source and preview)
- **Reveal markdown on focus** can be enabled to automatically show markdown details while still in preview WYSIWYG mode

### Large documents
TypoZen opens Markdown of any size in Live Preview.
- **Virtualized Preview:** For massive files, TypoZen mounts only what is on-screen, keeping scrolling perfectly smooth without dropping your reading place.
- **Raw Performance:** `.txt`, `.log`, and `.csv` files open natively in Source mode for raw Notepad-class performance.

### Writing tools
- **Spelling:** The native Windows spell checker underlines misspellings in both Preview and Source modes (except inside code blocks). Right-click for replacements.
- **Find & Replace (`Ctrl+F` / `Ctrl+H`):** Searches the entire document model instantly, even virtualized off-screen sections.
- **Live Match Highlighting:** All search matches are highlighted concurrently in both Source and Preview modes.
- **Search Sidebar (`Alt+S`):** Dedicated sidebar with match-case and whole-word toggles. Remembers your last 8 searches across all sessions.
- **Search mode** (a live result list — sidebar need not stay open): **Up / Down** step previous / next match with eyes on the text; **Left / Right** turn the page when the layout is paginated. Without results, Up/Down are normal (caret in Preview, page turn in Reader). **F3** / **Shift+F3** also step next/prev. Same Up/Down behaviour the results list has always used
- **Links** — hover a link for **Open Link**, **Show in Folder** and **Edit Link**; select text and use **Add Link** in the selection popover to make one. Both open a dialog with the visible text and the target.
  - A link to a file, relative to the document that contains it (`[notes](other-file.md)`) opens as a tab. Resolution happens in the host, because only the host knows where the document lives.
  - `http`, `https` and `mailto` open in the default browser and carry a `↗`. **Only** those three schemes are handed to the shell: a link's address comes out of document content, and without that restriction a `file:` or custom-scheme link would be a way to make opening a note launch a program. Everything path-shaped is opened as a *document*, which reads a file and cannot run one.
  - `#heading` jumps within the document, through the same path an outline click uses. Slugs follow the usual Markdown convention — lower-cased, punctuation dropped, each remaining space becoming its own hyphen, so `## Look & feel` is `#look--feel` — and letters in any script are kept, so `## 日本語` is `#日本語`. An anchor that matches no heading does nothing rather than guessing.
  - A plain click still places the caret — this is an editor, and link text has to stay editable. `Ctrl+click` opens directly.
- Table insert
- **Tab types a tab**, in Preview and Source, as in Notepad; `Shift+Tab` takes one back. On a list item Tab nests the list instead, and in a table it moves between cells. A run of tabs wraps onto the next line like any other space, and a tab is saved as a tab
- **Spaces are kept as typed** in Preview as in Source -- a double space, a space at the start of a line, a space or tab at the end of one -- and each is its own step for Undo
- **A clicked picture is removed only by a deliberate `Delete`, `Backspace` or Cut.** Typing, Space, Tab, paste and bold/italic do nothing to it; `Enter` adds a line after it
- **Undo** puts the caret back where the change was and leaves the view (Source or Preview) as it is
- **Insert** switches between inserting and overwriting, in both views; the caret turns into a block while overwriting, and overwriting stops at the end of the line rather than running into the next
- Reveal Markdown on focus (`F7`), Focus mode (`F8`), Typewriter scroll (`F9`), Fullscreen (`F11`)
- Editor margins: Narrow / Regular / Wide — real side padding, not column-width caps. Grouped in View with Line Spacing and Paragraph Spacing, because all three set the shape of the text block
- **Block Hover** (View) — whether hovering a paragraph previews its bookmark in the gutter. **On** by default. Turning it off removes the preview only: bookmarks you have set are always drawn. There is deliberately no wash or edge under the pointer — hovering a paragraph does one thing, which is arm the gutter, so the gutter is the only thing that answers
- **Justified** (View) — **off by default, including for books.** Every test book asks for it — _Xeelee_ on 96 rules, _Matter_ on 7 — and those declarations are rewritten to read this switch rather than dropped, so they keep their selectors and the publisher's _centred_ and _right-aligned_ rules are untouched
- **Hyphenation follows justification**, because on a screen they are one decision. A browser justifies by stretching word spaces and nothing else, so justified-without-hyphens is what opens rivers of white down a narrow column; ragged-right-with-hyphens breaks words to close a gap that isn't there. Limits are `6 3 3` — six characters in the word, three either side of the break — against Chromium's default `5 2 2`, which will leave `a-` hanging at a column edge. `hyphens: auto` is **inert without a language**, so a book's own `<html lang>` is carried onto `#editor` and cleared when the book closes; hyphenating French by English rules is worse than not hyphenating, so a book that declares nothing inherits the page rather than being guessed at
- **Word Wrap** (View) — applies in **Source** and **scroll Preview** only. On **Pages**, **Reader**, or an **epub**, the menu item is **disabled** (no fake tick); the stored preference returns when wrap can apply again
- Sidebar (`Ctrl+\`): live outline (headings, or a book's own TOC) and the Search pane
- Zoom: `Ctrl++` / `Ctrl+-` / `Ctrl+0` or Ctrl+scroll
- **Notepad-style chrome** — document tabs in the **title bar** with min/max/close; File/Edit/View and format icons on the command row below
- **ZenMode** (View → ZenMode (autohide UI)) — hides everything but the page: the command row, the tabs, the window buttons and the status bar. Pointer to the **top** (or bare Alt) brings it all back, window buttons and dragging included; pointer to the **bottom** reveals the scrubber alone so seeking does not flash the toolbar back
- The menu is **always discoverable** — there is no hide-the-menu toggle. When auto-hide is off it stays put; when on, reach the top of the window
- **Left-edge sidebar hover** (View → Side Panel Auto-hide) — **off by default**, and separate from chrome auto-hide: wanting a bare reading window is not the same as wanting the outline to follow the mouse. Switched on, and with the sidebar unpinned (closed by the toggle), moving the pointer to the extreme left temporarily opens Outline/Search; moving away closes it (stay band covers the full bar so Match case / Whole word stay usable). Opening with the toolbar, `Ctrl+\`, or Alt+S **pins** it until you close it again
- **Alt+F / E / V / T / H** open the matching top-level menu from the keyboard (including while the editor has focus); **Alt+S** is Search, not a menu letter

### Lists
Bullet, ordered and task lists, with real nesting.

- **`Tab` / `Shift+Tab`** indent and outdent list lines — 2 spaces per level, maximum depth 6, spaces only (tabs are normalised on parse)
- Inside a table, `Tab` moves between cells instead and grows the table at the end
- **Backspace at column 0** walks a ladder: outdent one level → strip the marker (including ordered `1.` and task `- [ ]`) → merge with the previous block
- `Enter` continues the list at the same indent and kind; ordered numbering follows the previous item _at that level_
- **Headings are separated by space, not rules.** One hairline under `h1` only, mixed from the theme's own text colour rather than `--border` (which draws the sidebar edge and the scrollbar thumb — chrome furniture, and this lives inside the document). `h2` has none: solid-under-h1 plus dashed-under-h2 is the GitHub-markdown idiom, not a book one. Headings sit 1.25em from what precedes them and 0.3em from their own text, so a section reads as a section. No rule at all in Pages — `break-after: avoid` routinely puts a heading at the top of a column, which made the rule the second thing on the page and, across a two-column spread, two lines at different heights
- **Fenced code is syntax highlighted** — `json`, `xml`/`xaml`, and a C-family lexer covering `cs`, `js`, `ts`, Java, Go, Rust and similar. A fence with no language, or one that is not recognised, is left plain rather than guessed at. Painted with the **CSS Custom Highlight API**, not by wrapping tokens in elements. That is not an implementation detail: a `<span>` inside a `.block` round-trips into `data-raw`, and Markdown's own DOM repair splits such spans into separate lines — which corrupted a real file when a whole-document code mode was attempted (see `docs/developer-editor-analysis.md`). Ranges are not DOM, so nothing can serialise, repair or split them. The trade is the API's property ceiling: colour only, no bold keywords or italic comments
- Formatting controls grey themselves out whenever the document cannot take an edit — Reader mode, and every epub. They were live-looking and inert there; Word Wrap had greyed itself and said why for a long time, and the nine controls beside it had not. Greyed rather than hidden, so switching modes never shuffles buttons under the pointer
- Formatting and toolbar list toggles preserve indent; un-listing clears it to level 0
- Indentation is a property of the raw Markdown (leading spaces), rendered with `margin-left` rather than nested `<ul>` DOM — so Source round-trips exactly

### Spelling
**Spelling is checked by the Windows spell checker, the same way in Preview and Source**, with suggestions and a personal dictionary:

- **Every misspelling on screen is underlined** (wavy red), re-checked after a pause in typing, when you scroll, switch tabs or switch between Preview and Source — so the underlines do not come and go.
- **Code is not spell-checked**: HTML, XML, CSS, JavaScript, C# and the other code files, and fenced code blocks inside Markdown. Tags and identifiers are not words.
- **Select a word** — underlined or not, in any editable document including code — and if Windows thinks it is misspelled the popover offers replacements, **Ignore**, and **Add to dictionary** (persisted in the cache folder as `user_words.txt`, not in the document). A correctly spelled word shows no spelling row.
- Chromium's own spell checker is switched off in both views, so there is one dictionary and one look.
- **Checked word by word, each word once.** The checker is slow over long text (about 4–5 ms a character), so it is sent each new word rather than whole paragraphs: a long paragraph underlines in a fraction of the time, and a word it has seen before costs nothing. A word is judged on its own, without its sentence.

Preview uses **WPF’s built-in dictionaries** — English, French, German and Spanish, the same engine a WPF TextBox uses — in your Windows display language. Other languages will not underline until a dictionary for them is available.

*Not to be confused with the bundled dictionary:* `dictionary.tsv` is WordNet, used for **Look up** (definitions and synonyms) below. It is not a spell list — it does not know `teh` from `the`, and using it as one would underline every inflection.

### Live statistics
The status bar updates continuously with word count, character count (both grouped — `40,772 words` is read, `40772` is counted; line numbers stay ungrouped, being coordinates the search gutter prints raw), estimated reading time (~200 wpm), total lines, **current line** (caret in Source/Preview — same document-line coordinate as Search result gutters after a jump), **current chapter** (click to jump to its start), zoom, and — when text is selected — **selected** word and character counts. Serialization is debounced so counters stay responsive on very large documents.

### Supported Markdown (practical)
**Yes:** headings, bold/italic/strike, inline code, fenced code, links, images (stored beside the document after save), blockquotes, bullet/ordered/task lists with basic indent, tables, thematic breaks (`---`, `- - -`, and friends).

**Limits — not full CommonMark or Typora:** advanced nested-list edge cases, math, Mermaid and similar extensions are not first-class features.

---

## Reading & Research

### Reading epubs
Open a `.epub` and TypoZen becomes a reader: **Reader mode, paginated, read-only**, with the book's own table of contents in the outline.

- A book's blocks carry the **publisher's own HTML**, not a Markdown conversion. Converting _Blindsight_ to Markdown dropped 6/6 images, 162/162 links, 170/170 list items and 210/210 footnote references, and broke 16 of 17 headings. Carrying the HTML has no conversion step and therefore nothing to lose.
- **The book's stylesheets are applied through an allowlist**, as its HTML is: parsed by the browser, and only what is named gets through. The page itself takes the book's typography and nothing that sizes or places it, so **View → Margins**, the theme's paper and the pagination are always yours; elements inside the book take typography plus bounded layout (indents, spacing, borders, image sizes), and nothing that can take them out of their column. The same applies to inline `style=""`. On the way, `rem` becomes `em` (a book sized in `rem` is rooted at the application and the reader's font-size control cannot touch it), `page-break-before: always` becomes `break-before: column`, `text-align: justify` becomes `text-align: var(--tz-align, left)` so **View → Justified** owns it (see Writing tools), and `preserveAspectRatio="none"` is stripped from cover wrappers. Checked against a 148-book library with `tools/library-sweep.mjs`: nothing outside the page.
- **Each top-level element sits in its own block**, so rules the book wrote about neighbours are translated to match across blocks: _Blindsight_'s `p + p` indent and a heading's `h2 + p` apply, and a leading `:first-child` means a chapter's first element rather than every paragraph.
- **Embedded fonts load**, including fonts the book obfuscates (`META-INF/encryption.xml`, IDPF and Adobe schemes), and a book's tables fit their column.
- **Body text renders at the size the theme asks for.** Publishers size against a device default they cannot see — _Xeelee_ asks for `0.88em` on its body classes, _Matter_ for `1.33333em`. The correction divides the **declarations in the book's own stylesheet** by the measured factor and leaves `#editor` at exactly `--fs`, so text the publisher left unstyled is right without anything being done to it, `0.88em ÷ 0.88` is `1em` and right too, and a `1.5em` heading becomes `1.7em` — still half again the body, which is the proportion the publisher was expressing. Scaling the _container_ instead, which is what this did first, is exact only for text wearing the class and wrong in the other direction for everything else: about one _Xeelee_ paragraph in ten. Now 96.9% of its characters and 99.2% of _Matter_'s land on the theme size exactly.
- The factor is measured from the element that **directly owns each text node**, weighted by characters, and refined as more of the book mounts. Each of those was a bug in turn: measuring the block's first child read a container that inherits the theme size and hands it back, so _Matter_ was declared correct while 99.2% of its text painted a third too large; counting elements rather than characters lets a drop cap outvote a chapter; and locking the factor on first sight took it from whatever range happened to be mounted, which on a resumed book is usually front matter — two launches of the same book measured 0.66 and 0.74 for a factor that should be 0.75.
- **A plate gets the page it sits on.** A cover, frontispiece or part title — a picture with no text beside it — is sized to the page box, not to `vh`. `vh` is the _window_, which includes the tab strip, toolbar and status bar, so the old bound stopped a cover a quarter of a page short and shrank _Matter_'s below its own resolution (a 510×680 file painted at 391×521). Covers are small files (294×500 to 510×739), so filling the page upscales the smaller ones — presence over sharpness, chosen deliberately, because a cover is furniture you glance at rather than text you read. A picture under 400px natural is not a plate: the _Matter_ "About the Author" portrait is 230×233 and alone in its block, and filling a page with it at 3× was not an improvement.
- Chapters start a new page, images and internal links work, and the reading position is remembered per book across sessions.
- A book is never dirty, never saved over, and Save As refuses any path ending `.epub`.
- **Smart Pronunciation:** TypoZen includes `compromise.js`, a lightweight offline Part-Of-Speech tagger, to resolve grammatical homographs (like the verb "lives" vs the noun "lives") before they reach the text-to-speech engine. This ensures context-aware, accurate reading even on older local TTS models.

### Reading PDFs
A PDF opens in the reader itself, drawn by **PDF.js** (bundled, nothing downloaded). Its text is never edited; annotations and form entries can be added and saved (below).

- **Real text:** select and copy it; **Find** (`Ctrl+F`) and the **Search** sidebar work across every page, with hits listed by page.
- **The PDF's own outline** fills the sidebar; click an entry to turn to it. **Go to Page** works as it does for books.
- **The view buttons apply:** **2 Columns** shows a two-page spread; **Pages** shows one page at a time (wheel and arrow keys turn it), fitted to the window with no scroll bar, and the **scrubber** at the foot seeks through the PDF's pages. The corner page indicator shows the PDF's own page numbers (both pages of a spread); click it for Go to Page. Source and Preview do not apply to a PDF and are greyed. `Ctrl`+wheel zooms and redraws the page sharp; Reset Zoom (`Ctrl+0`) returns to the fit, and the status bar says so ("99% (fit)") while the page is fitted to the window.
- **Your place is remembered** and the PDF reopens on the page you left. Each PDF tab also keeps its own **2 Columns** and **Pages** setting, across restarts.
- **View → PDF Pages in Theme Colours** redraws pages in the theme's colours. It is off by default because it recolours pictures too.
- The status bar shows the PDF's word count and **Page N/M**.
- **Read Aloud and narration** read the PDF paragraph by paragraph from the one on screen (or the one you clicked in), highlighting each on the page. PDF text has no paragraphs of its own, so they are worked out from the layout: headings, list items and captions stand alone.
- **Select text** for the same popup as in a book: Look up, Read, Find in document, Highlight.
- **Bookmarks and highlights** are kept with the PDF and listed in the Marks pane with their page.
- **A password-protected PDF** asks for its password.
- **File → Save Pages as Images...** saves pages as PNG or JPEG at 150, 300 or 600 DPI (or your own figure): all pages, this page, or a range like `1-5, 8`. The DPI is written into each file, so a page opens at its paper size.
- **File → Save All Images in PDF...** saves every picture as its own file, at the size it is stored in the PDF, by one of three methods:
  - **Original files (PdfPig accelerated)**, the default, reads the pictures straight from the file: a JPEG or JPEG 2000 is saved as the very bytes the PDF holds, anything else as a lossless PNG of its stored samples (a 1-bit scan stays a 1-bit PNG).
  - **All as PNG (PdfPig accelerated)** does the same but converts JPEGs to lossless PNG too, for one format throughout.
  - **Images extracted via PDF.js (slowest)** takes each picture as the viewer's engine decodes it -- the method before 0.8.2.

  The first two read the PDF with [PdfPig](https://github.com/UglyToad/PdfPig) rather than asking the viewer, which only ever hands over decoded pixels -- measured on 20 pages of a picture book, 3.6 s against 17.4 s, and on 60 pages of a scanned book 1.9 s against 6.1 s with files a quarter the size. A picture they cannot hand over as it is (one with a transparency mask, a JBIG2 scan) is saved by the viewer's method in the same run, and the result says how many. Small icons are skipped and a picture repeated on many pages (a logo) is saved once, both optional; one subfolder per page if you like. Page text is never included.
- **Print** prints the original file through Edge's PDF printing, so the output is the PDF, not a screen capture. **File → Open in Default App** hands it to your usual PDF program.
- **Scanned pages are read.** A page that is only a picture of text has its words recognised by Windows' own text recognition, on your computer, in the languages Windows has installed: they can then be found, selected, looked up and read aloud like any other text. Pages scanned sideways or upside down are turned until they read. The words are kept for next time (in Privacy Mode only for the session), and Clear Stored Data can remove them. About half a second a page; a picture with no words stays a picture. Handwriting and poor scans read badly. **View → Read Text in Scanned PDF Pages** turns it off.
- **Annotate and fill in.** **Edit → Annotate PDF** offers Highlight (drag across text), Add Text, Draw and Add Picture; **Stop Annotating** goes back to reading. Each annotation has PDF.js's small toolbar when selected (delete; colour for a highlight), and **Undo/Redo** step through them. Form fields are filled in where they are. These go *into the PDF* when saved -- unlike TypoZen's own bookmarks and highlights from the selection popup, which TypoZen keeps.
- **Saving a changed PDF.** The tab shows `*` and **Save** asks where: it suggests `<name>-annotated.pdf` beside the original, so the original is only replaced if you choose it (the dialog asks first). The file is written whole and then swapped in. Later saves go straight back to the file you saved. Switching to another tab keeps unsaved changes, and closing the tab or TypoZen asks, as for a document. Autosave never writes a PDF.
- Not built: signatures, and page operations (delete, reorder, rotate, merge). Letter-spaced headings ("W E L C O M E") come out of a PDF as separate letters, so a voice spells them.

### Reading web, images, and media
Open these **read-only** on a Chromium surface (same tab strip). No document scrubber on these tabs — that control belongs to paginated engine/book reading.

| Type | Behaviour |
| --- | --- |
| **HTML** (`.html` / `.htm` / `.xhtml`) | **Source** = edit markup. **Reader** = real page (read-only). **Preview** is off for HTML — it is Markdown WYSIWYG, not an HTML editor |
| **CSS / XML / XAML / JSON** (and `.txt` / logs) | Normal **editor** document in **Source** |
| **Images** | Fit-to-pane shell; **right‑click → Magnify** (Edge) for zoom/pan |
| **Video / audio** | Browser controls; missing codecs (often **HEVC / HVC1**) show a clear error (audio-only black frame is explained too) |

**Menus that cannot apply are greyed, not left looking live.** A native tab is not a
document, so **Edit** greys out whole — every item in it acts on the editor —
and **View** loses only its document-shaped half: the Sidebar group, Focus Mode, Typewriter
Scrolling, Reveal Markdown on Focus, Font Appearance, Spacing & Margins, Bookmark Gutter
Hover and Justified. Scrubber, Status Bar, Auto-hide, Fullscreen and Reset View Settings
stay, because they are the window's and still mean something over a picture. They were all
still live once, and pressing Toggle Sidebar on a native tab collapsed the sidebar of the document
you were *not* looking at, silently, so you found it shut when you switched back. **Help**
opens over the native tab.

**Zoom applies where zooming does something.** HTML pages and video scale; a still
image is shown at its own size (use **right-click → Magnify**) and audio is a fixed
control, so **Zoom is greyed for images and audio** — in the menu, on the keyboard, and for
Ctrl+wheel alike, since greying a menu is not the same as disabling a feature.

Format tools and Source/Preview are locked; the file is never marked dirty and never saved over. **Print / Export PDF** (`Ctrl+P`) prints the surface you are looking at (native tab → native WebView; document tab → editor). **A long document prints whole.** TypoZen lays out long documents a piece at a time and the print engine can only take what is on the page, so before printing it builds a complete copy from the document itself — invisible on screen, with the same styling and the book's own typography and pictures — and prints that (Pride and Prejudice: 458 pages, built in about a tenth of a second). Only an omnibus beyond 20,000 blocks is refused, with the reason, rather than printed in part: a PDF with a piece of a document and nothing to say so is worse than no PDF. **Privacy Mode** (File menu) already applies — see [Session & privacy](#session--privacy). Details: `docs/archive/native-reader-plan.md`.

### Position in a long document
In a paginated layout the foot of the page carries page numbers and a **scrubber that spans the whole book**. It addresses pages rather than scroll offset, because the editor's own scrollbar can only span what is currently laid out — about 28 pages of a 1400-page novel.

- **Click a page number** or press **`Ctrl+G`** to open a go-to-page prompt (leaf page number; in two-column mode that maps to the correct spread under the hood).
- **The total is marked `~` while it is still being learned** — `43 / ~264`. Only ranges you have actually reached are measured; the rest are inferred, so the total is an estimate until the whole document has been laid out, and it says so rather than printing a guess as a fact. The page you are **on** is always exact: you are looking at it. Three rules keep the estimate honest — it **converges in both directions** as ranges are measured (a ratchet that only grew was tried and reverted: unvisited ranges froze at the seed and the total sat at double the document); measured ranges are exact; and **dragging the scrubber fully right goes to the end of the document**, which is the last block and needs no estimate at all
- **Turning pages** follows a fixed keyboard matrix (full detail in [docs/for-agents.md](docs/for-agents.md)). `PageUp` / `PageDown` and the wheel always turn the page in a paginated layout. **Without a live search**, arrows and `Space` turn the page only where nothing is editable — **Reader** and any **book** — because in **Preview** the arrows belong to the caret. **With search results**, Up/Down step hits everywhere except Source, and Left/Right turn the page (so you can page through a document while hunting a match without giving up hit navigation). Reader sets `#editor` to `contenteditable="false"`, which is the reliable “no caret” signal rather than a mode-name guess.
- The status bar shows the **current chapter** from the book TOC or document outline, updated as you read. **Click the chapter label** to jump to that chapter's start.
- **Bookmarks** — see below. Separately, jumping via search, outline, go-to-page, or chapter click leaves a **return breadcrumb** — **Return from Jump** (`Ctrl+Shift+J`) goes back to where you were reading. The breadcrumb is automatic rather than chosen, and session-local.

### Bookmarks
Named places that survive the exit, in a **Marks** tab beside Outline and Search.

Three ways to set one, because the single place marker this replaced went unused for being two shortcuts and nothing on screen:

| Where | What |
| --- | --- |
| **The gutter** | A 3px amber rail in the left margin, and hovering a paragraph previews what clicking will do: faint rail on an unmarked one (_click adds_), the existing rail dimmed on a marked one (_click removes_). One shape, one colour, four intensities — the gutter is a toggle button that explains itself. Drawn with `::before` and hit-tested by coordinate — a real element inside a `.block` would end up in `data-raw` and therefore in your document. **View → Block Hover** turns the preview off; a bookmark you have set is always drawn |
| **Marks pane** | **Mark this paragraph**, which becomes **Remove this mark** |
| **Keyboard** | `Ctrl+Shift+M` toggles, `Ctrl+Shift+P` opens the pane |

- **Enter keeps your indentation in Source.** A textarea drops the caret to column zero, so every indented structure — a fence, a YAML block, a nested list — had to be re-indented by hand on every line. A list carries its marker too (`3.` becomes `4.`), and Enter on an empty bullet ends the list and removes the stray marker. Brackets and quotes are deliberately left alone: auto-closing them turns hostile the moment it guesses wrong, and prose is full of apostrophes
- **Look up and Find in document work in Source too.** They did not, and nobody had decided that: a textarea selection is not a DOM Selection, so the popover check for "is this inside the editor" failed and it never appeared. **Highlight stays out of Source** — it anchors to a block and Source has none, so it is hidden rather than shown-and-inert
- **Highlighting a selection opens the Marks pane on it.** A highlight is a faint wash over text you are already looking at, so pressing the button gave almost no evidence it had worked — and the list it joined was behind a collapsed sidebar and an unselected tab. Same move _Find in document_ makes, through the same command the menu and `Ctrl+Shift+P` use

- **Ordered by position, never by when they were made.** You read forwards; a list in creation order has to be translated every time you look at it. The mark you are nearest is highlighted
- **Named from their own text**, so a new one is legible without being typed. Double-click to rename; empty the name to get the text back
- **Ticks on the scrubber** show every mark across the whole book — five marks over 604 pages is a shape you read at a glance
- **They survive the document being edited.** A mark stores the text it was set on as well as where it was: the index is a hint, the fingerprint is the truth, and they are resolved against each other once the document has settled. Insert a paragraph above a mark and it follows its own sentence rather than staying on a number. The match is whole-document, because an epub re-split can move a paragraph thousands of blocks and "your bookmark is gone" while the sentence is still in the book is the one answer a bookmark may never give. Affordable because one pass over the text builds an index for _every_ mark at once, and that index is cached per document — fingerprinting means parsing a block's HTML, and the 45,390-block Xeelee omnibus would otherwise pay for that again on every resolve
- **A mark whose text is gone is shown struck through**, not deleted. It is yours; dropping it silently on open is how a feature loses work
- Marks land on a block that renders something — a blank line is a block, and one marked there would have no fingerprint and so no anchor at all
- Stored in `bookmarks.txt` in the cache, keyed by path, last **64** documents; marks _within_ a document are not capped. Your file never grows metadata because you read it, at the honest cost that marks do not travel with it

### Annotations
Select text and the Mark button becomes **Highlight selection**. A highlight is a bookmark with a range, and a note is a highlight with text attached — which is why bookmarks were built first: the anchoring is the whole problem, and this reuses it unchanged.

- Painted with the **CSS Custom Highlight API**, the same mechanism search uses for its matches in Preview (Source search uses a mirror layer, for the reason given above). Not a `<mark>` element: a `.block` round-trips into `data-raw`, so anything wrapped round the words would become part of your document
- **Named by the words it quotes.** Double-click the row to write a **note** — for a highlight that edits the note, not the quotation, since renaming it would be rewriting the book
- Highlighting the same range twice removes it, the same toggle the gutter and the button use
- Stored beside bookmarks, with the same fingerprint anchor, so a highlight follows its sentence when the document is edited above it

> **Set Place Marker / Go to Place Marker are gone.** They were a one-item bookmark list that forgot itself on exit. Note that neither was your _reading position_, which is automatic, written atomically as you read, and unaffected by any of this.

## Extensions & Local AI

### Looking a word up
Select text and a popover appears beside it — **Highlight** and **Find in document**, and for a single word the lookup itself. Beside the sentence rather than in a panel you have to look away to, which is the point of it; it is also what makes highlighting discoverable without the Marks pane open.

**A dictionary and thesaurus are included, and nothing is downloaded.** `dictionary.tsv` and `thesaurus.tsv` ship beside `TypoZen.exe` — about 152,000 definitions and 114,000 synonym entries from the **Open English WordNet** (2025+ edition), the maintained successor to Princeton WordNet, freely licensed under CC BY 4.0. Lookups and synonyms work on first launch, with no setup and no network access. See [WORDNET-LICENSE.txt](WORDNET-LICENSE.txt) for the attribution both require.

**You can add other dictionaries.** Put each one in its own folder under `dictionaries\` in TypoZen's data folder (`%LocalAppData%\TypoZen_Cache_Portable\dictionaries\<Name>\`), holding a `dictionary.tsv` (word, tab, definition) or `dictionary.json` (`{"word": "definition"}`), and a `thesaurus.tsv` if it has synonyms. Once there is more than one, **File → Dictionary** appears and lists them all by folder name, with the built-in one first; the choice is remembered and takes effect at the next lookup. A chosen dictionary answers everything, synonyms included — a folder with no thesaurus has no synonyms rather than borrowing the built-in ones. **Open Dictionaries Folder** is at the bottom of that menu. A file sorted by word is read from disk; an unsorted one works but is loaded into memory, which for a large dictionary costs time at startup.

Most people will never need this, and that is fine. If you do want to rebuild from a WordNet download of your own, `tools\Make-Dictionary.ps1` does the parsing and writes both files beside `TypoZen.exe`:

```powershell
.\tools\Make-Dictionary.ps1 -Source C:\wordnet\dict -Counts C:\wordnet3.1\dict\cntlist.rev
```

`-Counts` is Princeton WordNet 3.1's sense frequency list. It is what puts the most common meaning first — "run" as in moving fast on foot, not a score in baseball. Open English WordNet carries no counts of its own, so without it senses come out in WordNet's order within each part of speech, nouns first.

TSV first, because that is what a WordNet or Wiktionary export converts to in one line of script, and because a 40 MB JSON parse on startup would be felt. Lookups are answered by the **shell**, not the page: a dictionary worth having is tens of megabytes, and marshalling that across the bridge to sit in the document's memory would cost more than the feature.

**The dictionary is read from disk, not loaded.** The bundled files are sorted by word, so at startup TypoZen notes every 64th word and where it sits in the file — about 50 ms and 200 KB — and a lookup reads the few lines around it, about 0.15 ms on an SSD. Holding the whole dictionary in memory cost 39 MB. A file of your own that is not sorted, or a `.json` one, is loaded into memory as before.

- **The most common meanings first, and the rest behind "more".** Every sense is kept; the popover shows three, most common first, and **+ N more meanings** shows the others. In `dictionary.tsv`, senses are separated by ` | `; a file of your own without that separator shows as one definition
- A reader selects the word as it appears on the page, which is inflected more often than not, so a miss retries the obvious stems — `walking` → `walk`, `bodies` → `body` (`ies` → `y`, plus `s` / `es` / `ed` / `ing` / `ly`)
- **Irregular forms** no rule can reduce — `ran`, `went`, `mice`, `thought` — come from WordNet's own lists and answer with their base word (about 3,800 of them)
- If the dictionary file is missing — moved or deleted — it says so, and how to rebuild it
- **Follow a synonym** to its own entry — each word is a control, and a back arrow appears once there is somewhere to return to. A synonym you cannot look up is a dead end, which is most of what a thesaurus is for
- **One button, one answer.** Press **Look up** and the popover gives the **definition**, the **synonyms** below it, and **how many times the word appears** in what you are reading — together, in that order. It is deliberately not automatic: a word is selected to _copy_ it at least as often as to ask about it, and a definition that arrives uninvited sits on top of the text you were working with. Offered only for a single word, since a paragraph has no definition
- **Synonyms** come from the same WordNet pass — a synset is a set of words that mean the same thing — written to `thesaurus.tsv` alongside the dictionary
- **Occurrence count works with no dictionary at all** — "appears 2,135 times in this document" is often the question actually being asked, especially in a novel
- **Hear the word** — the speaker beside the word in the popover says it aloud, in the voice chosen for Read aloud, whichever dictionary answered. It says the word as selected (`ran`), not the entry it was answered from (`run`)
- **"ran → run"** — when there is no entry for the selected word and the answer is for a shorter or base form, the title says so, so a nearby word's meaning is not read as this one's. Synonyms always belong to the word that was defined
- **Pronunciations** show under the word when the dictionary has them: a third column in `dictionary.tsv` (word, tab, senses, tab, pronunciation). The bundled WordNet has none, so this appears only with a dictionary of your own that includes them

### Reading aloud
**Read aloud** is the **A)))** button at the right of the toolbar, and **Read aloud** in the selection popover. With text selected it reads the selection. With nothing selected it starts at the **text cursor** — from the start of the word it is in — when the cursor is on the page you are looking at, and reads on from there: to the end of the page in a book in Pages, to the end of the document otherwise (in Source mode, the raw text). With no cursor on screen — a book just opened, or a cursor left on a page since turned away from — it starts at the top of what is on screen, or of the document. While it reads, both controls become **Stop** — the toolbar button shows a stop square on the highlight — and both return to Read aloud by themselves when the speech ends.

**The voices are Windows' own**, running on your machine. **File → Read Aloud → Windows Installed Voices** lists every voice installed in Windows — both kinds Windows has, the classic SAPI 5 voices and the newer Windows.Media ones — and **Configure Speed** sets the pace; the choice is remembered. TypoZen ships no voices and fetches none.

The list is **grouped by what each voice actually is**, read from the voice's own description rather than its name: **Natural** ones running on this computer, **Classic** older ones, and **Online** ones — which are kept in a submenu of their own and labelled, because unlike everything else here they are spoken by a web service, and what TypoZen reads aloud is sent to it. On a machine with only the voices Windows ships, there is nothing to group and the list appears plain.

- **A second of silence first.** HDMI, and some USB and Bluetooth outputs, go to sleep after a few seconds of quiet and swallow the start of the next sound while they wake — measured, a single spoken word could vanish entirely. Every play therefore begins with one second of silence. It is a second's wait every time, which is the cheaper mistake
- **Long passages start at once.** SAPI 5 voices speak straight to the audio device from the first audio they produce; they used to be rendered whole before a word was heard, which for a slow voice meant a 17-second wait on a long selection. Windows.Media voices are rendered first — they are fast — into a temporary file in `%TEMP%` that is replaced by the next one
- **Nothing is left hanging.** A voice that fails, or audio the player cannot open, ends the play and puts the controls back to Read aloud, rather than leaving them on Stop with nothing playing. Each play's steps — voice, length of text, time to first audio, end or failure — go to `debug.log` in the data folder, except in Privacy Mode; the text itself is never logged

**Neural voices, if you install them.** **File → Extensions** offers Kokoro, a voice model that runs on your graphics card and reads far more naturally than the Windows voices. It is a 186 MB download — the model, the runtime and fourteen voices — and once it is there, everything happens on your computer: the engine is loaded from the data folder, not a CDN, and the model is read from disk. Measured on a WebGPU card it generates about eleven seconds of speech per second of work, so it keeps well ahead of itself; without WebGPU it is slower than speech and TypoZen says so and stays with the Windows voices. The **Kokoro Voices** menu exists only while the extension is installed.

### Extensions
**File → Extensions** is the one place TypoZen uses the network, and only while an install is running. Nothing is downloaded unless you ask for it, nothing is contacted at launch, and an extension you have not installed leaves no menu behind.

| | Download | Where it goes |
|---|---|---|
| **Kokoro voices** | 186 MB (or 348 MB at full precision) | `extensions\Kokoro\` in the data folder |
| **Wiktionary dictionary** | 34 MB, 108 MB unpacked | `dictionaries\Wiktionary\` |
| **Qwen narration** (experimental) | about 13 GB; needs an NVIDIA graphics card with CUDA | `extensions\QwenTTS\` |

- **Install shows progress and can be cancelled.** Kokoro and Wiktionary files land in a staging folder and are moved into place only when every one has arrived, so a cancelled or failed install leaves nothing behind. A cancelled Qwen install keeps what it has downloaded and carries on from there next time
- **Qwen narration is experimental: download and use it at your own risk.** It has been tested on one PC (an RTX 4070 Ti) and asks before it downloads anything. It is a 1.7-billion-parameter speech model running on your own graphics card. Install fetches its own Python (checked against its SHA-256), its libraries and its models, each at a pinned version; afterwards it runs with the network off. On an RTX 4070 Ti it holds about 4.3 GB of the card's memory while loaded, about 6 GB while rendering, and gives the card back after 15 minutes unused. Voices are designed from a written description (the model's own two English speakers, Ryan and Aiden, are offered too), and a book's characters can have voices of their own (File → Read Aloud → Narrator Settings). **Note on Characters:** TypoZen automatically extracts a cast list from a document's dialogue tags. To prevent minor/unnamed characters from cluttering your cast list, a character must speak at least twice (i.e., have at least two quoted lines of dialogue) to appear in the settings. Remove keeps your voices, casts and settings. The narrator is not reliable with digits (it read "£86,000 - £117,800" as "minus", and dropped or invented digits), so TypoZen gives it numbers as words, British style: amounts, ranges ("to"), dates, times, percentages, years and plain numbers -- "£86,000 - £117,800" is spoken as "eighty-six thousand pounds to one hundred and seventeen thousand eight hundred pounds". Only what is spoken changes; the Windows and Kokoro voices do this themselves. Narrator Settings shows the **whole instruction** the narrator reads by, editable as it stands, with presets to start from (None -- the model unguided -- Standard, Warm, Brisk, Dramatic) and your own saved beside them; nothing hidden is added to it. The narrator reads the emotion of a scene from the text itself, and TypoZen adds cues taken from speech tags ("she snapped" adds "sharp and angry", in wording you can edit). The default is no instruction with cues on: an instruction telling the narrator to hold back ("understated", "without acting them out") was found to fight the cues, and none of the presets says that any more. **Try it** reads your own text, or text selected in the document, with the settings on screen, saved or not, prepared exactly as narration prepares it, and shows what the narrator was told for each piece; play, change a setting and play again, and Current and Previous let you switch between the two; **New take** renders either afresh, so a setting's effect can be told from one take's luck (narration always uses take 1). Voices are designed, imported, exported and deleted in Narrator Settings > **Manage voices...**, a window of its own because those changes happen at once (the Narrator window's Save and Cancel cover only what they can undo; closing it with unsaved changes asks). A designed voice cannot be made again, so it can be **Exported** to a `.tzvoice` file kept wherever you like, and **Imported** back on this PC or another; import checks it is a real voice first
- **The Wiktionary archive is checked against its SHA-256** before it is unpacked
- **Remove deletes the folder**, and the menu that extension added disappears with it
- **The speech engine is rewritten as it installs.** `kokoro-js` has two addresses baked in — a model host and one hardcoded URL for the voice files — that no setting covers. Both are rewritten to point at the local folder, and each must appear exactly once: if a future version of the library moves them, the install stops rather than leaving an engine that quietly calls out
- **All are optional in the real sense.** The built-in dictionary and the Windows voices are unaffected, and **File → Dictionary** switches between dictionaries once there is more than one

**More voices.** Any voice installed into Windows appears in Configure Voice with no change to TypoZen — commercial SAPI 5 voice packs, for example. Windows' Narrator "natural" voices are a special case: Windows makes them available to Narrator only, not to other apps. Third-party adapters exist that register them as ordinary SAPI 5 voices, and TypoZen lists whatever such an adapter registers; they are not part of TypoZen, depend on details of Windows that can change with an update, and some also offer online voices that send the text being read to a web service.

## Files & Export
- New / Open / Save / Save As — UTF-8 (BOM detected on load; saved without BOM)
- **Atomic document save** — write to a temp file, flush, then replace the target
- **Reload when the file changes on disk** — engine documents only (not books or PDF/images). A stamp of write-time, size and a cheap fingerprint is taken on load and after Save. Coming back to the window, switching to the tab, a watcher on the file's folder, or Save / Autosave, compares that stamp. If the tab is **clean**, it reloads quietly. If it is **dirty**, a prompt offers Reload (discard edits), Keep editing (the next Save overwrites disk), or Save As. Autosave will not overwrite an external edit: it shows the same prompt instead. OneDrive touching mtime without changing bytes is ignored; TypoZen's own atomic save is ignored for two seconds so the temp/`Replace` dance does not look like someone else's write. Untitled buffers have no path and are not watched.
- **Standalone HTML export** — self-contained, with the active theme's styles embedded
- **Select All copies the whole document**, not the part of it currently laid out. On a long file only a window of paragraphs exists in the page at a time, and copying what was on screen put one per cent of a 205,842-character document on the clipboard with nothing to say so
- Print / Export PDF (`Ctrl+P`) — Chromium print UI; a long document or book prints whole, from a complete copy built for the print (see [Reading PDFs, web, images, and media](#reading-pdfs-web-images-and-media))
- CLI and Explorer: `TypoZen.exe "C:\path\doc.md"`; ZenSeek uses `--reader --search "q" --match-index N path` (Phase 6 — done)

### Tabs
Full multi-document editing, with the tab strip living in the title bar.

- **New** with the `+` button or `Ctrl+N`; close with the tab's own button or `Ctrl+W`
- Cycle with `Ctrl+Tab` / `Ctrl+Shift+Tab`
- **Drag a tab** sideways to move it; a line shows where it will land. Dragging past either end of a full strip scrolls it. Dragging only reorders — the tab you are reading stays on screen — and the order is kept with the session
- **Scroll arrows** appear only when the strip overflows, and the active tab is always scrolled into view
- **Per-tab unsaved indicator**, tracked independently of every other tab
- **Per-tab file fidelity** — each tab remembers its file's line-ending style (LF / CRLF) and whether it ended with a trailing newline, so saving one document never quietly rewrites the whole file's line endings
- **Per-tab view** — 1-Col / 2-Col **and** Source / Preview belong to the document, not the window: a novel wants a two-column spread and the notes file in the next tab does not. Both are recorded per tab and restored with the session. Only a deliberate choice is written down — the toolbar column button, the Mode buttons, or the session file. What the page happens to be painting mid-load never is, because a book's first paint is one column until its layout arrives and storing that would forget the spread. Switching between them keeps the window's top-left corner where you put it and only widens or narrows the window to the right; each layout remembers its own size, and one that would run off the screen moves in only as far as it has to
- **Fail-closed switching** — if the editor's content cannot be synced back to the tab, the switch or new-tab operation is _refused_ rather than proceeding and risking unsaved edits
- **Session restore** reopens your tabs on next launch (bodies only if you've enabled unsaved-document restore under File → Privacy)




## Customization, Session & Privacy

### Themes & typography
**25 built-in themes** in `TypoZen_Themes.json`. Each entry is a **named, established palette** (Bg / text / accent) plus a font stack and base size. **Save as New** writes back into the same file with a `Custom` flag, so the count on disk is 25 plus whatever has been saved — worth knowing before sharing the file, since a personal theme travels with it. The Themes menu lays them out in four columns at runtime: **Dark**, **Light**, **Mono** (font stack ends in `monospace`), and **Custom Themes** (where the **Customise Theme…** option lives).

| Column | Themes |
| --- | --- |
| **Dark** | Ayu Mirage, Catppuccin Mocha, Everforest, GitHub Dark Classic, Gruvbox, Gruvbox Serif, Kanagawa, Material Oceanic, Material Palenight, One Dark, Rosé Pine, Solarized Dark, Tomorrow Night, VSCode Dark+ |
| **Light** | Ayu Light, Catppuccin Latte, Gruvbox Light, One Light, Rosé Pine Dawn, Solarized Light, VSCode Light+ |
| **Mono** | Dracula, Monokai, Nord, Tokyo Night |
| **Custom Themes** | Custom saved themes, plus **Customise Theme...** |

**All set `FS` to 16** (base size for document and book normalisation). Palettes are reduced to four colours for the shell + page -- background, text, accent (`Hi`) and highlighter (`Hi2`, marks and highlights) -- and are not full syntax-highlight schemes. The highlighter is chosen from each palette and kept clear of its accent; on dark themes it is never a yellow, which reads as brown as a see-through wash over a dark page.

Font stacks are TypoZen’s pairing: reading-oriented entries lean **Literata** / **Merriweather** (Gruvbox Light leads with Literata, Merriweather fallback); UI-oriented entries lean **Inter** / **Source Sans 3**; Mono uses **Cascadia Mono** / **Consolas** (on Windows).

**For epub / long reading** prefer serif + soft paper or low-glare dark over Mono/IDE themes:

| Situation | Themes |
| --- | --- |
| Daytime novel | **Rosé Pine Dawn**, **Solarized Light**, **Gruvbox Light** |
| Night, still bookish | **Rosé Pine**, **Gruvbox Serif** |
| Night, soft green | **Everforest** |

Avoid the Mono column (Dracula, Nord, Tokyo Night, Monokai) for immersion; fine for code.

- **Fonts ship with the app** in `fonts/` (except system mono). No network font fetch. `local()` first so an installed copy wins. (WebView2 itself still does Microsoft traffic — see [Network behaviour](#network-behaviour).)
- **Deep recursive theming** — menus, toolbar, sidebar and status bar take the same brushes as the page.
- **Themes → Customise Theme…** — background, text, accent and highlighter colours, font and size; live preview, **Save as New** (built-ins never overwritten), Reset, Cancel.

Bundled OFL faces: Inter, Source Sans 3, Merriweather, Literata. Every face that ships is openly licensed, so there is nothing to strip before handing a build to anyone.

> **Merriweather is 4.4 MB, and it is not the letterforms.** Its outlines are 144 KB, the smallest serif here. `GPOS` and `GDEF` account for 3.3 MB: it carries three variable axes (`wght`, `wdth`, `opsz`), so every kerning pair stores deltas for each axis combination. Inter has two axes and 150 KB of `GPOS`. Pinning `wdth` and `opsz` would recover most of it. `tests/fonts-selftest.mjs` checks that variable families declare their weight range, since a single declared weight pins the axis and makes the browser synthesise faux-bold.

> Earlier versions pulled these from Google Fonts via a `<link>` in `<head>`. That was a render-blocking network round trip on every cold start of a local editor, and because Google's CSS omits `local()`, it shadowed already-installed copies and re-downloaded them. Bundling removed both problems.

### Session & privacy
Preferences live under `%LocalAppData%\TypoZen_Cache_Portable\` (the Store version keeps a folder of its own), and so does everything else the app
writes: extracted books, staged payloads, `debug.log`, and any themes you save. **Nothing is
written beside the executable**, so TypoZen runs correctly from a read-only or protected location.

Themes are shipped and saved separately. `TypoZen_Themes.json` beside the app is the read-only
set that ships; **Save as New** writes your copy to `%LocalAppData%\TypoZen_Cache_Portable\`, which is
preferred on load once it exists. An update replaces the shipped file and cannot touch yours.

| Setting | Default | Meaning |
| --- | --- | --- |
| **Privacy Mode** | **Off** | One switch: while on, **nothing that names a document, its contents, its position or its history is written**. Suppresses the tab session, reading positions, bookmarks and annotations, recent files, autosave, `debug.log`, and the document-identifying half of `settings.json` (last file, last content, search history, last query). Qwen narration renders into a temporary folder deleted when the window closes, a narrator cast saved meanwhile is kept only until then, and nothing is written to `narration.log`. The three switches it subsumes are **disabled** in the menu rather than silently overridden. **Not** suppressed: window size, theme, margins, spacing — those describe the app, not the reader, and losing them every launch would cost you something for no privacy in return. **Forward-looking**: it stops new writes, it does not delete what is already stored — bookmarks and annotations are your work, and a toggle that destroyed them silently would be indefensible. Use **Clear Stored Data** for that |
| **Privacy Mode — books** | — | A book must be unzipped to be read, and extraction is keyed by a _readable_ name (`Matter_-_Iain_M_Banks_68aa4804`), so the folder's existence alone says what you opened. Privacy Mode therefore **changes the destination** rather than sweeping afterwards: extraction goes to an opaquely-named directory under `%TEMP%`, deleted when the window closes and swept on a later launch if a crash prevented that. Large document and book *payloads* staged for the page (`localload`) follow the same rule. Books are served from their own virtual host (`localbooks`) so image URLs resolve from either root. The cost is re-extraction each session; within a session reopening stays fast |
| **Autosave** (File menu) | **Off** | Saves a dirty document ~2s after typing stops. Only for a tab that **already has a file** — an unattended save must never raise a Save As dialog, so an untitled buffer stays untitled and is covered by session restore instead. A book is never written. Goes through the same save path as `Ctrl+S`, so the atomic write, per-tab line-ending fidelity and the overwrite-loss guard all apply. If the file changed on disk, Autosave does **not** overwrite it — it shows the disk-changed prompt instead |
| **Remember unsaved documents between sessions** | **Off** | When on, dirty/untitled tab bodies are stored for restore. When off, nothing document-like is kept in the cache beyond what you explicitly save. |
| **Keep recent files list** | On | File → Open Recent |
| **Clear Recent Searches** | — | Drops the last-8 Search history and the restored Search-box text only |
| **Clear Stored Data** | — | Wipes TypoZen cache/session data only — **not** your documents. Includes recent Search queries, open tabs, recent files, match-case/whole-word, view settings, and web storage (on next launch). |

Also restored: window size and position, theme, margins, mode, line and paragraph spacing, justification, F7/F8/F9, zoom, scrubber/status-bar visibility, chrome auto-hide, side-panel auto-hide, open tab paths **and each tab's column layout** (bodies only if the option above is on), last eight Search queries, last Search-box text, match case / whole word, and which sidebar tab (Outline/Search) was active.

### Network behaviour
**TypoZen itself requests nothing over the network**, with one exception you control: installing an extension (**File → Extensions**) downloads it while you watch, and nothing is fetched before or after. Fonts are bundled, the editor page is served from disk through a virtual host, and the page issues no outbound requests — an installed extension is served the same way, from the data folder through a virtual host, so the speech engine and its model are read from disk rather than a CDN. A document that references a remote image (`![](https://…)`) will still load it — that is the document's request, not the app's.

**Read aloud uses the voices installed in Windows**, which run locally. A voice added to Windows by third-party software may itself go online — some adapters register web-based voices that send the text being read to a server. That is the voice's request, not TypoZen's, and choosing a local voice avoids it.

**The WebView2 runtime is a different matter, and it is not fully silent.** The environment is created with Chromium's background services disabled:

```
--disable-background-networking  --disable-component-update
--disable-sync  --no-first-run  --no-default-browser-check
```

Even so, the browser process holds **two TLS connections to Microsoft-owned addresses** from startup, with no page having requested anything. Measured, not assumed — and several further flag combinations (`--disable-domain-reliability`, `--no-pings`, `--no-service-autorun`, `--disable-breakpad`, various `--disable-features`) did **not** remove them.

The endpoint is **not identified**. It does not appear in the Windows DNS cache (Chromium resolves independently) nor in `--log-net-log` output, so no claim is made here about which service it is. No document content is involved either way.

Removing it entirely requires something outside the app — a firewall rule on `msedgewebview2.exe`, which is the shared runtime binary and would also block remote images, or machine-level Edge policy. Neither is applied.

## Keyboard shortcuts
| Action | Shortcut |
| --- | --- |
| Sidebar (Outline/Search) | `Alt+\` |
| Find | `Ctrl+F` |
| New | `Ctrl+N` |
| Open | `Ctrl+O` |
| Save | `Ctrl+S` |
| Save As | `Ctrl+Shift+S` |
| Print / Export PDF | `Ctrl+P` |
| Fullscreen | `F11` |
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
| Bold / Italic / Link | `Ctrl+B` / `Ctrl+I` / `Ctrl+K` |
| Strikethrough | `Ctrl+Shift+X` |
| Close tab | `Ctrl+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Open File / Edit / View / Themes / Help menu | `Alt+F` / `Alt+E` / `Alt+V` / `Alt+T` / `Alt+H` |
| Help (syntax & shortcuts) | `F1` |
| Reveal Markdown | `F7` |
| Focus mode | `F8` |
| Typewriter scroll | `F9` |

**Menus (no default shortcut):** Themes → Customise Theme… · View → Line/Paragraph Spacing, Editor Margins, Justified · View → Block Hover · View → ZenMode (autohide UI), Side Panel Auto-hide · File → Privacy

Mode (Source / Preview / Reader) is the toolbar's Mode control and has no keyboard shortcut. `Ctrl+/` used to toggle Source and was removed: it duplicated one third of a three-state control, and a chord that cycles a state you cannot see is worse than the control that shows it.

---

## Licence
TypoZen is **MIT** (`LICENSE`). The bundled components carry their own terms, and all
of them permit commercial use and redistribution:

| Component | Licence | Text |
| --- | --- | --- |
| TypoZen itself | MIT | `LICENSE` |
| Inter, Literata, Merriweather, Source Sans 3, JetBrains Mono | SIL Open Font License 1.1 | `fonts/OFL.txt` |
| Dictionary and thesaurus data | Open English WordNet (CC BY 4.0), derived from Princeton WordNet | `WORDNET-LICENSE.txt` |
| PDF.js (the PDF viewer) | Apache 2.0, with its own component notices | `js/vendor/pdfjs/LICENSE` and beside it |
| PdfPig and the .NET libraries it needs | Apache 2.0; MIT | `THIRD-PARTY-NOTICES.txt` |
| CodeMirror 6 (Source mode's editor) | MIT | `THIRD-PARTY-NOTICES.txt` |
| Kokoro (Optional Extension) | Relies on its own license and terms | Fetched on install |
| Qwen (Optional Extension) | Relies on its own license and terms | Fetched on install |

**Privacy:** [PRIVACY.md](PRIVACY.md) — TypoZen sends nothing anywhere; everything it
remembers is in `%LOCALAPPDATA%\TypoZen_Cache_Portable` and can be cleared from **File → Privacy**.

The OFL allows these faces to be bundled, redistributed and sold with software, on
the condition that the notice and licence go with them — which is why `fonts/OFL.txt`
ships in every build rather than living only in this repository. The copyright lines
in it are reproduced from each font file's own `name` table.

---
_Built with zen and focus for writers, developers, and Markdown enthusiasts._
