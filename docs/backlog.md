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

- **Visible-window UI suites** (`disk-conflict`, `format-availability`, `native-surface`,
  `scratch-help`, `select-all`, `shell-seam`, `tab-strip-paint`) not run since 0.9.3 — they
  need Ed away from the machine.
- **Store product name** ("ePub Reader & Markdown Editor - TypoZen") does not mention PDFs.
  Agreed to change with the next Store submission; the wording is Ed's.

**Later (Ed, 2026-09-29):**

- **Save All Images in PDF: the fast method often does not work** (Ed, 2026-09-28). In
  several PDFs the direct extraction (PdfPig, reading pictures straight from the file,
  0.8.2) fails and TypoZen falls back to the very slow method. To do: collect the PDFs it
  fails on, find which image encodings or structures PdfPig does not handle, and fix or
  widen the fast path; measure both methods on each file. Debug logging only with Ed's
  permission.
- **Store screenshots** (6, Desktop) predate the Source editor, the PDF reader and the
  themes. Needs new screenshots from Ed.

## Done (recorded so it is not re-raised)

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






