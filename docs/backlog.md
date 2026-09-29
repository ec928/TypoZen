# Backlog

Work agreed but not built, newest decisions first. Defects and product limits live in
`known-issues.md`; this file is what is still to do.

## 0. File associations (added 2026-09-28)

Capture both custom and hardcoded file extensions (e.g. `.md`, `.txt`, `.epub`, `.pdf`) for
proper file type handling and integration. *(Moved here from a Backlog section that had been
added to the README.)*

## 1. View settings per document type — **built** (0.9.9–0.9.29, 2026-09-28/29)

Built on branch `feature/per-type-view-settings` (not yet merged to `master`). As built,
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

**To follow up (Ed, 2026-09-28):** the spell-check queue, spelling speed on long paragraphs,
tab-drag auto-scroll, and the `big-file-app` deadline clean-up; Store screenshots one day
(needs Ed's screenshots); IME (CJK) in Source, low priority. The rest below are open questions or Ed's calls.

- **`perf.log` under Privacy Mode** — fixed in `TypoZen_App.cs` (PerfMark returns when
  `DebugLogSuppressed`), not yet built or released. Ships with the next build.
- **Large documents: a Source/Preview switch can land a few lines off.** Preview's
  virtualised window remounts after the restore (~100 px). Small documents are exact.
- **Preview drops the indentation of code files** (leading spaces collapse; Source shows
  them). Changing it changes how Preview draws all text — Ed's call.
- **Visible-window UI suites** (`disk-conflict`, `format-availability`, `native-surface`,
  `scratch-help`, `select-all`, `shell-seam`, `tab-strip-paint`) not run since 0.9.3 — they
  need Ed away from the machine.
- **`docs/store-listing.md` is out of date**: the live listing's description and 20
  features were rewritten for 0.9.6 in Partner Center (2026-09-28); copy them back here.
- **Store product name** ("ePub Reader & Markdown Editor - TypoZen") does not mention PDFs —
  branding, Ed's call.
- **Save All Images in PDF: the fast method often does not work** (Ed, 2026-09-28). In
  several PDFs the direct extraction (PdfPig, reading pictures straight from the file,
  0.8.2) fails and TypoZen falls back to the very slow method. To do: collect the PDFs it
  fails on, find which image encodings or structures PdfPig does not handle, and fix or
  widen the fast path; measure both methods on each file. Debug logging only with Ed's
  permission.
- **Spell-check queue.** The checker has its own thread (0.9.6), but requests still queue:
  after fast scrolling it keeps checking pages already left, and a word's suggestions wait
  behind them (seconds). Drop queued checks that are no longer on screen; let
  `spell_suggest:` go first.
- **Spelling speed on long paragraphs.** The Windows checker's cost grows faster than the
  text, so long paragraphs underline slowly (slow, no longer frozen). Option discussed:
  check new words rather than whole paragraphs.
- **Store screenshots** (6, Desktop) predate the Source editor, the PDF reader and the
  themes. Needs new screenshots from Ed.
- **IME (CJK) composition in Source** — untested since the move to CodeMirror. Only matters
  for CJK input.
- **Tab dragging** does not auto-scroll the strip when dragged past its edge.
- **`big-file-app` deadline clean-up** (ending a frozen app by its profile folder) has not
  yet been exercised by a real failure.
- **Release notes:** v0.9.6's notes cover only the freeze fix; the CodeMirror work is written
  up in v0.9.4 (kept for that reason). Option: fold 0.9.4 and 0.9.5's notes into 0.9.6.
  Ed to decide.

## Done (recorded so it is not re-raised)

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
  kept. v0.9.4 stays up.
- **Store 0.9.6.0** submitted with the updated description and features (2026-09-28).






