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

- **`book-position-app` is intermittent**: now and then the first frame of a resume is drawn
  before the range is recorded as mounted (range -1). The cover is never shown; passes on a
  re-run. A timing edge in the test's frame sampling or in the resume; not chased.
- **The live Store description says TypoZen "makes absolutely zero network requests".**
  Installing an extension (Kokoro or Qwen voices) downloads; the README says so correctly.
  Worth correcting in the next Store submission (docs/store-listing.md holds the live text).


**Checked, not reproduced (2026-09-29):** page numbers shifting by one at 2-Col range
boundaries. Seen with 200-block ranges; at 400, stepping across a boundary and back gives the
same number for the same view and steps by exactly one. Re-open only if it shows up in use.

**Later (Ed, 2026-09-29):**

- **Save All Images in PDF: the fast method often does not work** (Ed, 2026-09-28). In
  several PDFs the direct extraction (PdfPig, reading pictures straight from the file,
  0.8.2) fails and TypoZen falls back to the very slow method. To do: collect the PDFs it
  fails on, find which image encodings or structures PdfPig does not handle, and fix or
  widen the fast path; measure both methods on each file. Debug logging only with Ed's
  permission.

## Done (recorded so it is not re-raised)

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






