# Backlog

Work agreed but not built, newest decisions first. Defects and product limits live in
`known-issues.md`; this file is what is still to do.

## 0. File associations (added 2026-09-28) — **done**, see Done

Capture both custom and hardcoded file extensions (e.g. `.md`, `.txt`, `.epub`, `.pdf`) for
proper file type handling and integration. *(Moved here from a Backlog section that had been
added to the README.)*

## 1. View settings per document type — **built** (0.9.9–0.9.29, 2026-09-28/29)

Built on branch `feature/per-type-view-settings`, merged to `master` on 2026-09-29. As built,
it goes further than the plan below: text size, Word Wrap and columns are per type as
well, ePub defaults to two columns, and Code's default theme is **Tokyo Night** (Ed,
2026-09-29: intentional; it replaces Monokai in the table below). The plan as agreed follows.

**Decided (Ed, 2026-09-28):** change nothing in the UI and add no menu items. The existing theme and View settings are saved **per document type** instead of once globally. They stay the user's to set; a change is saved to the type of the document on screen and persists.

### Customizable View Defaults
The following view settings are saved per document type and can be customized by the user:

| Type | Files | Theme | Line | Paragraph | Margins | Justified | Font Size | Word Wrap | Columns |
|---|---|---|---|---|---|---|---|---|---|
| **Code** | the code table in `js/modules/08-code.js` (HTML in Source, XML, XAML, CSS, JSON, JS/TS, C#, …) plus `.log` and `.csv` | Tokyo Night | Tight | Tight | Narrow | off | Normal | off | n/a |
| **Documents** | `.md`, `.txt`, untitled | Gruvbox | Normal | Normal | Narrow | off | Normal | on | n/a |
| **ePub** | `.epub` | Rosé Pine Dawn | Relaxed | Loose | Regular | off | Large | n/a | Inherits from ePub TypePrefs |
| **PDF** | `.pdf` | Catppuccin Latte | — | — | — | — | — | — | n/a |

These are the out-of-box defaults. PDF takes the theme only: PDF.js lays the page out itself.
Images, video and rendered HTML pages have no text layout of TypoZen's and are not a type.

### Hardcoded Interactions (Not customizable by user)
The following behaviors are hardcoded per media type for *newly opened* files and cannot be configured globally as defaults. While some can be toggled per-tab (and saved to the session), their initial state on open is fixed:

| Type | Default Mode | Default Layout | Default Columns | User can change Mode per-tab? | User can change Layout per-tab? | User can change Columns per-tab? |
|---|---|---|---|---|---|---|
| **Code** | Source | Scroll | 1-Col | Yes (to Preview/Reader) | No (Source is strictly Scroll) | No (Source is strictly 1-Col) |
| **Documents** | Preview | Scroll | 1-Col | Yes | Yes (in Preview/Reader) | Yes (in Preview/Reader) |
| **ePub** | Reader | Pagination | Inherits from ePub TypePrefs | No (forced by engine) | Yes (can toggle Scroll/Pagination) | Yes |
| **PDF** | PDF View | Scroll | 1-Col | No (forced by engine) | Yes (can toggle Scroll/Pagination) | Yes |

**How (sketch):**
- The host already owns all of these (theme, `_lineSpacing`, `_paraSpacing`, margin,
  justified, `_fontSize`, `_wordWrap`) and every tab switch and open goes through `ApplyTabToEditor` / `OpenBook` /
  `OpenPdf`, which know the kind. Store one set per type in `settings.json`; apply the
  tab's type set before its text loads, with the View menu ticks following; on a change,
  write it to the current type.
- **Upgrade:** an existing install's current global values become **Documents**; Code, ePub
  and PDF start from the defaults above. A fresh install gets the defaults for all four.
- Focus, Typewriter and Reveal stay global (not decided otherwise).

**Risks and tests:**
- The tab-switch path — it produced two defects on 2026-09-27. New real-app suite (hidden
  desktop): open `.md`, `.epub`, `.css`, `.pdf`; each shows its own theme and spacing; change
  one, switch away and back, restart — the change sticks to its type only.
- Books repaginate the first time they open in the new layout: `theme-anchor-browser` covers
  staying on the same paragraph.
- Source/Preview alignment within a type: `view-alignment-browser`.

Estimate: ~200–300 lines, nearly all host C#; one focused session.

## 2. Smaller items

Still open. Everything else agreed on 2026-09-28/29 is in Done below.


**Checked, not reproduced (2026-09-29):** page numbers shifting by one at 2-Col range
boundaries. Seen with 200-block ranges; at 400, stepping across a boundary and back gives the
same number for the same view and steps by exactly one. Re-open only if it shows up in use.


**Performance priorities (Ed, 2026-10-07):** **cold starts** are the main use case and come
first, then performance inside the app (opening, reading, typing, scrolling). **Warm starts
are dropped** -- not worth making faster. (The idea parked for them -- persisting each
book's text-size factor -- only ever helped a reopen, and since the chapter-pages branch would
skip one style read per book.)

**Cold start, measured 2026-10-07** (process-cold, disk cache warm, perf.log; median runs):
a document is on screen ~2.1 s after launch, the Xeelee omnibus ~3.6 s (4.7 s on a book's
first open). Before Main ~50 ms; WebView2 browser start ~840 ms + controller ~420 ms + page
~250 ms; window/XAML and the themes menu run alongside and are not on the critical path.
Book open (Xeelee, ~780 ms blocking): first chapter range laid out ~336 ms, the book split
into 45,486 blocks ~253 ms, text-size/position/styles ~210 ms. Not yet measured: a true
disk-cold start after a reboot (needs one launch with TYPOZEN_PERF set, then perf.log).

Options recorded, **no action (Ed, 2026-10-07):**
- **Keep each book's split blocks between launches -- built, measured, REJECTED and reverted
  (Ed, 2026-10-07).** The page posted its split to the host after a book's first open; later
  opens and tab switches were served the split instead of the chapters. Measured on Xeelee,
  same build, A/B: reopen in a fresh app ~920 -> ~685 ms, switch back to its tab ~1,210 ->
  ~1,065 ms. **The cost lands on the first open, which matters most:** saving the split froze
  the page for ~180 ms (JSON.stringify of 10 MB ~86 ms + postMsg ~94 ms) ~2.5 s after the
  book appeared -- the user can do nothing during it. Any optimisation that makes the first
  open worse, even after the book is shown, is not acceptable. Do not rebuild this unless
  the split can be saved with no measurable pause on the page (e.g. built by the host
  itself) -- and measure the first open's long tasks before calling it a gain. It also
  doubled the book cache on disk (~10 MB more for Xeelee).
- **Lay out only the chapter being opened** (part of the ~336 ms). Faster to the first page,
  but more total work: the rest of the range is laid out later, while reading (a stutter, or
  a page turn waiting on it), and page counts ("Page 6 of 33") depend on whole chapters being
  laid out -- estimates or a second layout meanwhile. Pagination has had the most bugs. Not
  recommended.
- **WebView2 start-up -- investigated, no gain.** --no-proxy-server, Edge's extra services
  off (SmartScreen, translate, autofill, optimization hints, media router, collections), both
  together, and a full-size real profile vs an empty one: all within run-to-run noise once
  run order was controlled (an apparent 150 ms first came from warm-up order). The ~1.3 s is
  Edge's own start. Nothing added.
- **Second layout of the first chapter on book open -- tried, no gain, reverted.** Skipping
  the ResizeObserver's echo relayout removed the call, but the first layout grew by the same
  amount: the browser does that layout before painting either way.

## Done (recorded so it is not re-raised)

- **0.14.12 (2026-10-06, released):** from the 2026-10-06 health review
  (`docs/health-review-2026-10-06.md`, which also lists what was deferred) and Ed's
  testing: Replace All corrupting text after `İ` and its quadratic splice; the table
  toolbar, dead since 0.13.15 (`anchor` undeclared); Highlight selection also bookmarking
  the paragraph at the top of the view; PDF read aloud reading the footer first, then
  skipping running headers and footers entirely (chapter headings still read); saving
  turning form feed / backspace into `f` / `b`; outline and status line re-reading the
  document on caret moves and scrolls; a Content-Security-Policy on the editor page.
  **Dropped:** the per-keystroke model rebuild in Source -- single-digit milliseconds at
  1 MB, not worth the risk (Ed).
- **After 0.14.12 (2026-10-06, local):** a missing picture requested once instead of three
  times (host answers `image_missing:`); closing the find bar releases focus at once.
  Flaky tests fixed: `pdf-ocr-app` (that focus), `book-position-app` (sampled a frame with
  nothing mounted yet, range -1, as "the front of the book"), and `packaged-smoke-app`'s
  seek check (compared text that does not change in a one-chunk book). The 0.14.12 Store
  package passed `packaged-smoke-app` 8/8 via `tools/Test-Packaged.ps1`.
- **Save All Images in PDF, fast method** (raised 2026-09-28, closed 2026-10-06). Tried on 17
  of pdf.js's image-encoding test PDFs (JPEG 2000, JBIG2, CCITT, CMYK and progressive JPEG,
  indexed, CalGray, 1-bit, soft masks). PdfPig handles most itself; JBIG2, progressive JPEG,
  soft-masked and some Flate pictures go to the viewer, as designed, and the time is the
  same either way at these sizes. Found and fixed instead: pictures the two readers size
  differently (a soft mask larger than its picture; a form-drawn picture) were handed to the
  viewer and **silently not saved** -- the viewer matched by size only. It now makes up the
  shortfall from the page's other pictures (`pdf-smask-size.pdf`, `pdf-pictures-direct-app`).
  All 17 now save every picture.

- **0.12.1 (2026-10-01, local baseline -- not released):** scrubber marks: chapter starts as hairlines and, in an omnibus, novel starts as taller marks; in paginated documents, section and subsection headings.
- **0.12.0 (2026-10-01, Ed's redesign, local baseline -- not released):** book page numbers
  by chapter ("Chapter 2 of 38 • Page 2 of 15", the book's name first in an omnibus), sections
  classified from structure and the book's own numbering, the scrubber by position in the
  text, the status bar per document type with the right-hand page rule, tab type symbols,
  the narrator marked and left-aligned, the book text size held per book, and the first page
  turn after opening no longer lost. Entries for each are under the chapter-pages branch
  below. Open: check Endurance's chapter numbering (numbers may restart per part) and what
  Vacuum Diagrams' numbered entries are, before scrubber chapter marks are built.

- **After 0.11.0, from Ed's testing (0.11.1-0.11.3, 2026-09-30):**
  - Source/Preview on a PDF closed the PDF behind an empty "Unsaved" document: PDFs moved
    into the main page and the native-tab lock no longer caught them. Locked now, and the
    click and the page's own mode commands are ignored on a PDF.
  - Tab on a clicked picture deleted it (typed over the selection), and so did a letter,
    Space or a paste. 0.11.4 put the typing after the picture instead -- on the picture's
    own Markdown line, easy to miss, with the tab marked Unsaved for no visible change (Ed).
    0.11.6: with a picture selected, typing, Space, Tab and paste do nothing; Delete,
    Backspace and Cut remove it; Enter adds a line after it (selectionHoldsPicture).
  - Preview lost spaces: Enter just before a space dropped it, a typed double space saved
    as one, and a single-line cut left its HTML unmarked so a pasted "quick " came back
    "quick". Spaces are now kept as typed (keepTypedSpaces, parseInline draws a leading
    space or a run of spaces as no-break spaces, and a one-line cut writes the clipboard as
    Copy does).
  - PDF in Pages mode: the page scrubber now works there, and the scroll bar that did
    nothing is hidden while the page is fitted (0.11.3). The corner page indicator numbers
    the PDF's own pages (it showed the hidden document's "1 | 2 / 2") and opens Go to Page;
    the status-bar click added in 0.11.3 was taken out again as redundant (Ed). A fitted
    spread was ~14 px taller than the view -- PDF.js's page frame is a 9 px border its
    page-fit does not budget for -- so one route to a page showed the frame and another
    cut it off; Pages mode now draws the page without the frame, and nothing scrolls
    (checked at 640-820 px high, 100/125/156% scaling). 0.11.5.
  - Undo (0.11.7): the caret went to the start of the line after any Ctrl+Z, so the next
    letter landed at column 0; it now returns to the end of what changed, as in Notepad.
    In Source, Ctrl+Z switched the view back to Preview (the mode the state was recorded
    in) and left focus on nothing, so typing went nowhere; undo now changes only the text.
    Ctrl+B on a selected picture wrapped its Markdown in ** for no visible change (and an
    Unsaved tab); inline formatting now does nothing on a picture alone.
  - Undo (0.11.8): a Tab or Space on an empty line, or at the end of a line, marked the
    tab Unsaved and Ctrl+Z did nothing (Ed). Undo history compared snapshots with spaces
    and tabs stripped from line ends, so the edit never counted as a change. The
    comparison now ignores only line-ending style and trailing newlines. The 0.11.7 check
    typed its tab mid-line, where the strip did not reach.
  - Store description (2026-09-30): the privacy paragraph no longer claims "zero network
    requests" (untrue once an extension is installed); Ed updated Partner Center.
  - 1-Col / 2-Col (0.11.9): switching moved the whole window, because each layout stored
    and centred its own position (Ed: "too jarring"). Both now share the top-left corner
    the user last put the window at, each keeping its own size, so a switch only widens or
    narrows the window to the right; the default 1-Col window starts where the centred
    2-Col one does. A layout that would run off the screen shifts in only as far as it
    must, and switching back returns to the user's corner. Measured on the real window.
  - Tab switch (0.11.11; Ed saw it change "one at a time"): switching to a book showed it in
    the previous tab's look, then changed font, margins, spacing, background and size one
    command at a time -- 4.6 s, six visible states, the book paginated about five times. The
    look settings had been added one by one and were sent after the document was on screen.
    Now one view profile travels with the document and is applied as it is laid out: the
    book appears once, final, at 0.56 s. Found on the way: opening a book from a Markdown
    tab and switching back showed an empty page whose model still held the book (and
    reported the book's HTML as the file's text); Ctrl+Tab from the editor waited out a
    400 ms script timeout and lost the reading position; the theme selector's own handler
    re-sent the theme; margins were saved by a round trip that could file them under the
    wrong type; font-size changes read the reader's place after re-breaking the lines.
    Guarded by tab-switch-look-app (8 of its first 9 checks failed on 0.11.10).
  - Book open (0.11.13; 0.11.12 withdrawn): spike metric Xeelee omnibus, cold start, page
    ready -- ~1.89 s -> ~1.1-1.2 s. The book's whole text (saved baseline, word count) was one
    0.7 s block in the load; it is now built in idle slices with the word count counted as it
    goes. Cold on the other five books unchanged within run-to-run spread (Alice checked
    three times after one outlier run). 0.11.12's per-book text-size factor, a narrowed
    tz-instant selector and resizing the window before a book is laid out were all tried and
    dropped: each made some cold open slower (Ed: no cold start may be slower than before).
    Still open: laying out the first 800-paragraph range (150-370 ms); the window widening
    after a one-column -> two-column switch lays the range out a second time.
  - Book open, one-column tab -> two-column book (0.11.15): the book was laid out in the
    one-column window and again when the window widened. The host now sends how much the
    window will change (the saved two-column rect minus the window, in WPF units, plus its
    DPI scale); the page holds the document area at that size while it lays the book out,
    then lets go when the window catches up -- one layout, at exactly the final width
    (959.04 = 959.04 measured). First try divided by the zoom only and was 25% out at 125%
    scaling. Cold, 0.11.14 -> 0.11.15, ready: Alice 1287 -> 1040, P&P 1045 -> 865, Dune
    1050 -> 960, Nemesis 1006 -> 891, Matter 874 -> 639 ms; Xeelee neutral within its spread.
    Warm reopens and Ctrl+Tab on 0.11.15 checked by Ed: fine. Released: GitHub v0.11.15, Store
    Submission 9 in certification (2026-09-30).
  - Pages after ZenMode (0.11.16; Ed): turning ZenMode on in the middle of the Xeelee
    omnibus left the page numbers wrong ("1 | 2 / ~5458" over mid-book text) and the start
    unreachable until a tab switch. A window resize retired the page map with
    PageChunks.invalidate(), which also forgot the range still on screen; navigation then
    worked from "nothing mounted" and the total fell to the seed estimate. Resizes (and the
    settle after a mode change) now use invalidateCounts(), which keeps the mounted range and
    what the book has taught the estimate. Guarded by page-resize-app (fails 2/5 on 0.11.15).
  - Page numbers (0.11.16, **reverted in 0.11.17**): a range's page count was estimated from
    its markup length plus 200 per paragraph instead of its paragraph count. Chosen on one
    book at one window size, averaged over the book rather than judged at the start where it
    is first seen; at Ed's window it was no better.
  - Book text size held still (chapter-pages branch; Ed: the same Dune contents page at two
    sizes). The correction divided every em/% font-size in the book's CSS and re-measured on
    every mount; nested sizes compound, so no divisor fit and it never settled (Dune 1.13 ->
    1.42 -> 1.60 in its first second, 1.80 mid-book, 2.03 on return), and each correction
    re-laid out a page already on screen. Now each paragraph box takes an em factor per book
    (per novel in an omnibus) -- linear, so publisher proportions are exact -- measured once
    from chapter text before layout and held. It also targets the reader's chosen size, not
    the theme's --fs: Matter's body had been 16px beside Dune's 18px. Body measured at 18px at
    2/50/90% of Dune, Matter, Xeelee and Alice, identical on return.
  - First PageDown after opening (same branch): a page turn now cancels any programmatic jump
    still settling (open, resume, column switch). The leftover open-anchor jump landed in the
    same frame as the turn and took it back.
  - Scrubber to the end (0.11.19; Ed): dragging to the end of the Gutenberg Alice
    (alices-adventures-in-wonderland3.epub) stopped at 162 / 180 every time; PageDown still
    reached the end. The drag went to the page holding the last block, and that book's last
    block is the whole licence, 11 pages long. It now lands on the last character of that
    block. Guarded by scrub-to-end-app (a real mouse drag; fails on 0.11.18). Other callers
    that jump to a block (outline, search, resume, speech) want its start and are unchanged.
  - Page numbers (0.11.18; Ed's design): on the Xeelee omnibus the last page read 6186, 6600,
    8262 and 8188 on different visits at one window size. Every range not laid out was
    re-estimated each time a new one was, so the whole book's numbers moved together. Books
    now take words per page from the first range laid out and hold it until the layout
    changes (ZenMode, font, window); unvisited ranges are their words / that rate. A/B on
    Xeelee, 2-Col, 1700x1037: total spread while moving 228 -> 7 pages, error at open 5.3% ->
    2.3%, page-number error mean 67 -> 38. Ed at his layout: "2 / ~5974" at open, "5976 /
    ~5976" at the end. Counting every range for exact numbers was measured (57 ranges, ~9 s
    of work, 122-213 ms blocks, +190 MB, again after every layout change) and declined.
  - Ctrl+Tab (0.11.14; Ed): fast Ctrl+Tab just after launch created a duplicate tab of a
    book or PDF, and Ctrl+Tab then stalled on it until the copy was closed. The duplicate
    was never reproduced by page-sent Ctrl+Tab (restored session, 40 ms presses); three holes
    that could produce it are closed: a switch's deferred open now loads exactly the tab it
    was for, only while that tab is still active, and never creates a tab; switches and
    opens mark themselves in progress BEFORE their blocking page pulls, whose nested message
    loop could run a queued Ctrl+Tab in the middle of them; an open re-checks for a tab with
    its path just before it would create one. Ed's retry with real keys: no duplicate.
- **Not a report:** a "~5 s jank opening a medium document" was listed here from a perf log
  read during the 2026-09-29 audit -- inferred by the assistant, never seen by Ed, and not
  reproducible on 0.11.0 (one 130 ms frame on a 106 KB file). Closed.

- **0.11.0 audit and real-app pass** (2026-09-30). All 67
  real-app suites were run; 6 failed at first, each checked against 0.10.12 and the Store's
  0.10.10 to tell regressions from drift:
  - **Print / Export PDF prints long documents whole** instead of refusing (novels, large
    Markdown) -- a whole copy built from the model, beside the live editor (known-issues.md).
  - **Book pictures with `srcset` were broken on scaled displays**: the 2x candidate
    resolved against the app, not the book (every Standard Ebooks picture at 156%).
  - **PDF: 2 Columns lost the page** (PDF.js 6.3 jumps to page 1 when spreads are switched
    on while scrolling at page width), surfaced by 0.10.12's new default window sizes.
  - **Opening a large document straight into 2-Col** built and painted the whole document
    before narrowing to one range (24 long frames, 1.3 s at 3,000 lines); it now mounts the
    one range (1 frame, 77 ms).
  - **Epub cover SVGs** get their natural size from the viewBox, so a clamped cover keeps
    its shape in scrolling layouts.
  - Test drift fixed, not app bugs: `big-file` (fixture shrank below a fixed 2,000,000; the
    host keeps a file's trailing newlines and restores them on save, by design),
    `epub-open` theme size (set `--fs` by hand, bypassing applySpacing), `core-smoke` (the
    smallest book now fits one range, so mounted text never changed; it now reads the text
    in view), `read-aloud` (pinned to a prose book; Alice's one-word first block ended the
    capture early), `epub-open` cover (measured the box, not the picture, which is
    letterboxed, never stretched).

- **Tab and the everyday keys** (0.10.17-0.10.18, 2026-09-30). Tab had never worked in
  ordinary text: Preview swallowed it outside lists, Source had no binding and lost focus,
  and a typed tab was saved as a space. It now types a tab in both views (Shift+Tab removes
  one; several Source lines indent together). Backspace/Delete over a blank line left the
  caret at the wrong end, so the next press deleted a letter. `keyboard-editing-browser`
  now presses every everyday key in Preview, Source, a large document and 2-Col (68 checks);
  `tab-key-browser` covers Tab. Known: Enter just before a space drops that space in
  Preview, which cannot show a line's leading space; Source keeps it.
- **Tabs wrap; Insert overwrites** (0.10.19, 2026-09-30). A run of typed tabs sat in
  Chromium's `white-space:pre` span, which cannot wrap: past the right edge more Tabs
  changed nothing on screen and the next word broke mid-word with its first letter hidden
  ("croll marker row 107"; the text itself was intact). Tabs now wrap like any whitespace.
  Insert toggles overwrite in Preview and Source, as in Notepad, with a block caret; it
  never overwrites the end of a line.

- **Edits keep the view steady** (0.10.14-0.10.16, 2026-09-29/30). Edits that reload the
  document -- undo/redo; bold, italic, strikethrough, code, heading, quote and list across
  several lines; Tab/Shift+Tab on list items; a delete, cut or paste across lines -- pinned
  the edited line 48 px from the top (Tab: the top of a large document). An edit on screen
  now stays exactly where it was; one off screen is brought into view. In 2-Col only the
  range holding the edit is laid out again (it was the whole document, ~5 s), and the page
  numbers stay right (they read 1-2 of ~36 for pages 3-4 after Ctrl+Y).
  `edit-view-anchor-browser` covers it -- but it calls the indent function, not the Tab key.
- **2-Col Enter and startup** (0.10.13, from the 2026-09-29 audit). Enter no longer rebuilds
  the outline on the keypress (deferred 250 ms); the compromise NLP library and the Kokoro
  voice preload load when the app is idle after startup instead of before the first paint.
- **Store screenshots** -- Ed's new screenshots and their captions
  went live with Submission 8 (0.10.10, 2026-09-29). `docs/store-listing.md` synced with
  the live text on 2026-09-30.

- **Store product name** "TypoZen: ePub & PDF Reader, Markdown Editor" -- live with
  Submission 8 (0.10.10, 2026-09-29).

- **Visible-window UI suites** — all seven run on 2026-09-29 (0.9.29 + spelling/2-Col
  fixes): 110 checks, none failed.

- **Spelling speed on long paragraphs** (2026-09-29). Measured first: the checker costs
  ~4-5 ms a character in any shape (3,000 characters 12 s whole, 11.4 s in pieces), so
  splitting paragraphs would not have helped. The page now sends each word once (per word,
  cached, `spellTokens` in `02-layout.js`): 3,000 characters' unique words took 3.5 s, and a
  word already seen costs nothing. Requests are ~1,500 characters so a dropped one is short.
  Known difference: a word is checked without its sentence, and "The"/"the" are asked
  separately.
- **Spell-check queue** — checks run at Background priority on the spelling thread, so
  suggestions go first; requests for pages scrolled away are dropped (`spell_drop:`).
- **`perf.log` under Privacy Mode** — PerfMark returns when `DebugLogSuppressed`.
- **Source/Preview switch in large documents** lands exactly (`view-alignment-browser`,
  line 1500).
- **Preview keeps code files' indentation** (`body.tz-code-doc`, pre-wrap).
- **`docs/store-listing.md`** synced with the live 0.9.6 listing.
- **IME (CJK) in Source and Preview** — `ime-compose-browser` commits a composed word once.
- **Tab dragging** auto-scrolls the strip past its edge (confirmed by Ed, 2026-09-29).
- **`big-file-app` deadline clean-up** ends the apps it launched by PID
  (`harness-kill-app`).
- **Release notes:** 0.9.4's notes folded into 0.9.6; 0.9.4 removed.
- **File associations** (section 0): "Open with" and types for all code extensions and
  `.pdf`, in the installer and the MSIX.

- **2-Col position after a theme change** (found 2026-09-29, `theme-anchor-browser` 2 of 14
  on 0.9.29). Not the dynamic gap itself: it moved the page breaks and exposed two anchor
  bugs in `applySpacing`. A second change in a row re-read the page the first had landed on,
  whose top can be an earlier paragraph's tail, so each change walked back a page; and a
  blank-line block opening a page made `firstVisibleTextPosition` give up and fall back to
  the next paragraph. Fixed in `03-shell.js` / `02-layout.js`; 14 of 14.

- **`docs/audit_report.md`** — its findings are all fixed (Ed, 2026-09-28).
- **Typewriter and Focus modes** are deliberate features and stay. Typewriter keeps the caret
  line centred and so blocks wheel scrolling by design (2026-09-28).
- **v0.9.5's GitHub release** was deleted (it carried the 2-Col freeze); tag and archived zip
  kept.
- **Store 0.9.6.0** submitted with the updated description and features (2026-09-28).






