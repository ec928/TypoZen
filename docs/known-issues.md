# Known issues

Baseline inventory of **user-visible** residual risk for the current tree.

- **Open defects and planned work are in `docs/backlog.md`** -- the one list of what is
  still to do. This file keeps product limits (not to be "fixed"), product notes, and the
  history of fixed defects so a regression is recognised.
- Suite-only failures belong in the harness, not here. See `docs/for-agents.md`.
- This file is the living record. The health reviews are archived snapshots of older
  trees (`docs/archive/`) and do not describe current state, whatever their own text says.

## Product limits (not defects — do not “fix” by inventing precision)

### A windowed Markdown file's page total is an estimate until it has been laid out — and says so

This limit is a paginated Markdown document under page windowing. A book does not use it.
A book's footer is the unit on screen and the page within that unit, counted from the
layout: "Chapter 4 of 48" and "Page 2 of 23". There is no `~` and no Go to page.

`PageChunks` measures only the ranges the reader has visited and infers the rest from
pages-per-block. So the total on a long Markdown file moves as it is read. Three rules
keep that honest rather than misleading:

- **It is marked.** The indicator reads `43 / ~264` and the Go To prompt says the total is
  an estimate, until every range has been measured. The page you are *on* is always exact.
- **It converges, in both directions.** Unmeasured ranges follow the refined pages-per-block
  as measurements come in, up or down. Making that a ratchet — "never take away a page the
  reader has been shown" — was tried and reverted: an estimate that cannot fall never
  converges, so every range the reader had not visited stayed at the seed (800 × 0.06 = 48
  pages) while the measured ones read 20, the total sat at more than double the document,
  and a column switch could not correct it. A figure that is honestly wrong both ways and
  settles beats one that is wrong in a flattering direction forever.
- **The end is exact.** Dragging the scrubber fully right seeks the last *block*, not the
  last estimated page — the end of a document is knowable without any estimate.

**User expectation:** on that Markdown file, the page you are on is right; the total is
marked `~` while it is still being learned, and is exact once the file has been read
through. Mark sidebar **p N** uses the same map and can lag until its range is real.

---

### What a book's own files can still get wrong

Measured across a 148-book library on 2026-09-27. None of it loses text.

- **A rule scoped under a container the block split removed.** Every top-level element is
  mounted in its own `.block`, and a wrapper `div` with many children is split into its
  children. `p + p`, `h2 + p` and a leading `:first-child` are translated across blocks
  (0.7.13); `div.poem p + p` is not, because the `div` may no longer be there and guessing
  would style the wrong text. Seen in one book (*Gods of Risk*, its poems).
- **A broken font file in the book itself.** *Alien: Covenant*'s `00007.ttf` (Univers
  italic) is refused by Chromium as invalid font data once unscrambled; its ten siblings
  load. That style falls back, as it would in any reader.

Not present in that library and not handled: DRM, fixed-layout (pre-paginated) books,
right-to-left or vertical text, EPUB 3 footnote markup, MathML, audio and video.

---

## Product notes (not defects)

### Spelling is not the bundled dictionary

`dictionary.tsv` / `thesaurus.tsv` are WordNet **Look up**. Preview spelling is
WPF’s dictionaries (English, French, German, Spanish). Source uses Chromium.
Books, PDFs and Reader are not checked.

---

## Fixed / mitigated (kept briefly so regressions are recognized)

### Delete across lines lost the formatting of the two partial lines — **fixed** (0.20.6)

The joined line was built from what the reader sees, so bold, italic, code and links on
the first line before the cut and the last line after it were dropped -- a link lost its
address. `Start **bold words** one` … `End and [a link](…) two`, selected from inside
the bold to before the link, saved as `Start bond a link two`. Every cross-line Delete,
Backspace, cut and paste-over did it, in short files too. The lines are now joined as
Markdown and checked: if the result does not read exactly as the two kept parts, the old
join is used. The first line keeps its heading, list or quote marker, as in Source; a
selection from the start of a line keeps the last line whole. Tables and code blocks still
join as text. Guarded by `keyboard-editing-cases.mjs` (preview).

### A key after PageDown or the wheel went nowhere in a long file — **fixed** (0.20.6)

PageUp/PageDown scroll and leave the caret where it was. Once its line left the window
the caret was lost: a letter, Delete or Enter did nothing, and in 2-Col the caret was put
back into the wrong line (the 26th of the page window instead of line 26) by the restore
0.20.1 added for menus. An editing or arrow key now puts the caret back on its line,
bringing it into view, and then acts. Guarded by `keyboard-editing-cases.mjs` (large).

### Holding Shift+Down past the window lost the selection — **fixed** (0.20.6)

Rebuilding the window dropped a selection with one end outside it. It is now drawn to the
window's edge and kept whole (copy, cut and Delete use the whole), and Shift+Down goes on
extending it. Shown by a probe on a 3000-line file of mixed blocks; no suite case
reproduced it in 0.20.5, so none guards it.

### A paste ending in a blank line lost it — **fixed** (0.20.6)

Pasting text that ended in two line breaks kept one: whole lines cut with the blank line
under them came back without it.

### Delete from inside a line into a table lost the line's marks — **fixed** (0.20.8)

When one end of a cross-line delete is a table or code block, the join falls back to text.
The fallback also stripped the ordinary line's bold, italic, code and links: `Start
**bold words** one` deleted from inside the bold into a table saved as `Start boc d`. The
ordinary end now keeps its Markdown (`Start **bo**c d`); the table's remaining words still
join as text, as before. Guarded by `keyboard-editing-cases.mjs` (preview).

### A delete into or out of a table flattened the table into the line — **changed** (0.20.9)

A delete that ended (or started) inside a table joined the rest of the table into the line
as words. Ed's decision (2026-11-14): "like normal apps" (Word, Google Docs) -- nothing is
merged across a table edge. The line keeps its text up to the cut, with its marks; the
table stays a table; rows wholly inside the selection go; the row where the selection ends
keeps its shape with its selected cells emptied (the header stays, emptied, while the table
survives); from inside a table out, the rows before the start stay. A code block the same:
the block stays and only its selected code goes. Typing over such a selection is Delete,
then the letter (it was left to the browser, which deleted the lines and left the table).
Guarded by `keyboard-editing-cases.mjs` (preview).

### Part of a line copied as plain words, so a cut pasted back lost its marks — **changed** (0.20.7)

Copy and cut put a line that is only partly selected on the clipboard as the words shown,
while whole lines went as Markdown. Pasting a mid-line cut back lost the bold or link at
its ends; a cut from inside bold pasted back made the rest of the line bold. Ed's decision
(2026-11-14): part of a line copies as the Markdown of that part (`**ld words** and
[a link](…) he`), one rule for whole and partial lines. Pasted into another app, a partial
line now shows its `**` as whole lines always did. A one-line paste keeps its own marks
instead of taking the caret's, and marks either side of a join merge (`**os**` +
`**car**` is `**oscar**`). Tables and code blocks still copy their words. Guarded by
`keyboard-editing-cases.mjs` (preview).

### Shift+PageDown and Shift+PageUp did not select — **changed** (0.20.7)

PageUp/PageDown scroll and leave the caret; Shift was ignored. Ed's decision (2026-11-14):
they select a page, as in Notepad. The view scrolls a page and the selection's end moves
to what is then under the point it was at; at the end of the document it selects to the
end. PageDown alone still only scrolls. Guarded by `keyboard-editing-cases.mjs` (preview,
large).

### Not a bug: Shift+click inside one paragraph in headless Chrome

In headless Chrome a Shift+click in the same paragraph as the caret moves the caret instead
of selecting. In the app it selects (checked on the installed 0.20.9, 2026-11-14). Tests
that need a selection inside one paragraph use Shift+arrows.

### Not supported: Shift+click on a link

Chromium handles a Shift+click on a link itself (open in a new window) rather than
extending the selection. Not changed.

### Shift+click after scrolling a long file selected only the lines on screen — **fixed** (0.20.5)

Only part of a long file is in the page. Once the caret's line scrolled (or paged) out of
it, the browser moved the selection out of the text, and a Shift+click extended from there:
Delete took "Line " from the clicked line and left the rest, cut removed nothing and pasting
back added 52 lines, Ctrl+C copied the 50 lines above the click, and in 2-Col and Pages Delete
removed from the first line in the page window instead of from the caret. The caret is
remembered by line number, and a Shift+click whose anchor line is gone selects from there:
Delete, Backspace, typing, cut, copy and paste act on the whole range, Shift+arrows extend
it, and a click, a drag or Ctrl+A end it. Same in 0.20.1. Guarded by
`keyboard-editing-cases.mjs` (large).

Two fixes went with it. A long file's progressive repaint dropped a caret already placed in
a line it redrew to the start of that line, so after Delete over such a range the next key
landed there. A multi-line plain-text paste lost a space at either end (`Line ` pasted back
as `Line2000`); it keeps them, as a one-line paste does.

### A paste of several lines into a table cell broke the table — **fixed** (0.20.4)

The lines were split into blocks, cutting the table at the caret: `| ap |  |X` / `Y| ple |`,
or extra header rows when the caret was in the header. A cell holds one line, so the pasted
lines now go into the cell separated by spaces; a `|` in them is escaped, as in a one-line
paste. Pasting rows as new table rows is not supported. Wrong since at least 0.19.0.
Guarded by `keyboard-editing-cases.mjs`.

### A paste of several lines at the start of a bold-first line wrote "****" — **fixed** (0.20.3)

`**The Focus:** text`, `## **Big** head`, `- **Task:** two`, `> **q** text`: the caret sat
inside the bold, so cutting the rest of the line left an empty bold behind. It saved as
`****`, and a heading, list or quote marker then went onto the pasted line instead of
staying on its own. Wrong since at least 0.19.0. Empty formatting is dropped before the
split. Guarded by `keyboard-editing-cases.mjs`.

### A paste of several lines inside a code block broke the fence — **fixed** (0.20.3)

The lines were split into blocks, closing the fence at the caret and leaving
`` ``` line ``` `` behind. A multi-line paste in a fence now goes into the code at the caret.
Wrong since at least 0.19.0. Same test.

### After a cut or Backspace across lines the caret went to the start of the line — **fixed** (0.20.3)

The text was right; the caret was then moved to the line's start 20 ms later by the reload's
sticky-line restore, so the next letter or paste landed in the wrong place. The restore keeps
a live caret, and otherwise uses the cut point. Wrong since at least 0.19.0. Same test.

### Enter in the middle of a list item, or on an empty one — **fixed** (0.20.3)

`- one|two` gave `- one` and a plain `two`; it now gives `- two` (ordered lists number on,
a task starts unticked). Enter on an empty item kept adding bullets; it now ends the list,
as Source already did. Shift+Enter still gives a line without a marker. Same test.

### Clear search moved the caret to the start of the line — **fixed** (0.20.3)

New in 0.20.2: the notice's **Clear search** went through the sidebar's clear, which puts the
caret at the start of the reading line. It now goes back where it was. Guarded by
`search-mode-notice-browser.mjs`.

### Copy, then a click, then paste wrote nothing — **fixed** (0.20.2)

Selecting several lines and copying, then clicking somewhere else, left that selection
stored. Paste treated the click as a dead selection, deleted those lines, and wrote the
copy back over them, so the page looked unchanged and the caret jumped to the end of the
old selection. A caret in the editor drops that stored selection. The paste lands at the
caret, and the caret sits just after the pasted text. A whole-block copy still has no
extra blank line. Guarded by `clipboard-roundtrip-browser.mjs`.

### Cut with only a caret deleted the character before it — **fixed** (0.20.2)

Ctrl+X with nothing selected deleted the previous character and copied nothing. A caret
cut now does nothing. A real selection still cuts. Same test.

### A paste at the start of a heading, quote, or list ate the marker — **fixed** (0.20.2)

A multi-line paste at the start of `## Heading`, `> Quote`, `- item`, or `- [ ] task`
glued the marker onto the first pasted line. The marker stays on the original line.
Pasting into the middle of a list item still keeps the first half. Same test.

### Search mode gave no sign it was on — **fixed** (0.20.2)

Once a search has matches, Up and Down step through them even when the sidebar and the
Find bar are both closed. A notice stays at the top of the page until **Clear search**.
On a paginated layout it also says Left and Right turn the page. In Source it only says
search mode is on, because the arrows still move the caret. Escape in the document does
not clear it. Guarded by `search-mode-notice-browser.mjs`.

### File > Save took the caret — **fixed** (0.20.1)

Alt+F, S (and any menu) moved keyboard focus to the menu. Chromium then dropped the
selection, so after Save the caret was gone until a click. Closing the menu puts focus
back on the editor and restores the caret, in Preview and Source. A paste with no live
caret uses that same memory. Find keeps the cursor when it was the thing opened. A live
caret is not moved. Guarded by `focus-return-browser.mjs`.

### File > Save gave no sign the file was written — **fixed** (0.20.1)

Saving a document that was already clean left the status chip on Saved, so the keypress
looked like it had done nothing. File > Save and Ctrl+S now say so: "Saved just now" on
the status bar for a couple of seconds, or "Saved · filename" on the page when that bar
is hidden (Zen Mode, or the status bar switched off). The Saved / Unsaved chip is left
alone. Autosave does not say it. Guarded by `save-note-browser.mjs` for the page note.

### A book's stylesheet could move the page — **fixed** (0.7.10–0.7.11)

Zones of Thought's `body { margin: 0 1.5em 0 1em }` landed on `#editor`, the element that
is the page, and pushed the right column of every spread off the window whatever View >
Margins said. It was a class, not a book: 36 of 148 library books put layout on the page
this way, and 49 had rules that escaped the book into the application (rules inside
`@media` were never scoped). Book CSS is now parsed by the browser and rewritten through
an allowlist (`applyBookStyles`): the page takes text properties only; elements inside the
book take text properties and bounded box properties; the app's `.block` boxes take
nothing. Inline `style=""` goes through the same allowlist. Guarded by
`book-css-browser` (a hostile stylesheet).

### No book's embedded fonts ever loaded — **fixed** (0.7.13)

Three faults in a row. The book host was mapped `DenyCors`, and a font is always fetched
in CORS mode, so none of the 18 library books with `@font-face` got their fonts (images are
not CORS requests, which is why nothing else looked wrong). Fonts EPUB obfuscates
(`META-INF/encryption.xml`, IDPF and Adobe schemes) were served still scrambled
(`RestoreObfuscatedFonts`, on extraction). And a stylesheet's `url()`s were resolved
against the OPF folder instead of the stylesheet's own, so `Styles/x.css` asking for
`../Fonts/a.ttf` looked outside the book (`cssDirs` in the payload).

### Sibling rules and tables in books — **fixed** (0.7.13)

Each top-level element sits alone in a `.block`, so Blindsight's `p + p` indent and The
Churn's `h2 + p` never matched, and `p:first-child` matched every paragraph. Sibling rules
between top-level elements are translated across blocks, a leading `:first-child` means a
chapter's first element, and positions are never claimed for a top-level element. A book
table is capped at its column and its cells may break anywhere (a Zones of Thought table
was 337px in a 290px column). Guarded by `book-css-browser`.

### PDF selection painted twice, and on line breaks — **fixed** (0.7.12)

PDF.js's own selection painter stacked with the theme's, and the theme's rule painted the
text layer's line breaks, a dashed column at the page's left edge.

### A PDF tab forgot its columns and Pages — **fixed** (0.7.11)

The PDF viewer held its layout in page memory, shared by every PDF tab and lost on
restart. `DocTab.Scroll` beside `Columns`, saved in the session and sent with `load_pdf`.
Guarded by `pdf-layout-restore-app`.

### Keyboard shortcuts did nothing while typing — **fixed** (0.5.7)

Ctrl+S, Ctrl+Shift+S, Ctrl+N, Ctrl+O, Ctrl+P and F11 were handled only by `Window.KeyDown`,
which never sees a key while the editor has focus: the WebView's HWND belongs to the browser
process, so the key goes to the page and nowhere else. Save therefore worked only after
clicking outside the text. The page now forwards them (`save_shortcut`, `shortcut:*`) and the
host runs them on the next dispatcher turn -- called inside the WebView's message callback,
saving read nothing from the editor and silently wrote nothing. Ctrl+Shift+D also sat on the
`else` of the Ctrl check, so it could not run at all. Guarded by `save-shortcut-app` (app
tier). A host-side key filter does **not** fix this; that was tried and measured to do nothing.

### Menus offered what the tab could not do — **fixed** (0.5.7)

On a book or in Reader, Undo/Redo/Cut/Paste/Spelling were live and Insert Table stayed bright
(the lock list named `tableMenu`, which does not exist; the button is `btnTable`). On a book,
PDF, image or media tab, Save and Save As are disabled by design (books and media tabs are
read-only in TypoZen; Export as HTML is also disabled on PDF, image and media tabs).

### Book links unreadable on dark themes — **fixed** (0.5.6)

Dune's stylesheet sets its contents links `color: blue` (`#0000FF`): about 1.7:1 on a dark
theme. Links in the editor now take the theme accent. A book link has no `href` when shown
(06-render-epub.js moves it to `data-book-href`), so a rule on `a[href]` matched none of them
-- 0.5.5 shipped that and changed nothing.

### Backspace at the top of a later page did not join the line above — **fixed** (0.17.1)

Two-page Preview shows one range of a long file. Backspace at the start of that range
looked for the previous line on the page, found none, and did nothing. The line above
is in the document. Backspace now joins onto it and shows that line. Delete at the end
of a range pulls the next line up the same way. The first line of the file and the last
line still have nothing to join. Guarded by `page-line-join-browser.mjs`.

### Delete at the end of a long file added a space — **fixed** (0.17.2)

In scrolling Preview, a file of 2,000 lines or more is mounted as a window, with a spacer
after the last line. Delete at the end of the last line has nothing to pull up, so it went to
the browser, which merged a space in from the spacer: the file was saved with it. The last
line now ignores Delete. Guarded by `virt-delete-end-browser.mjs`; the wider class (editing
a long file in every layout and position) by `long-edit-sweep.mjs`, run on demand.

### A link and `_italic_` in one paragraph broke the link, and an edit saved it — **fixed** (0.17.10)

Preview's emphasis rules ran over the link HTML it had just made, so the underscore of
`target="_blank"` opened an `_italic_` (or `__bold__`) later in the same paragraph, and a `_`
or `*` inside a URL could do the same. The paragraph showed `blank">` before the link text,
and typing anything in it saved the damage to the file:
`See [blank">the docs](https://x.y/z) and _soft text.` -- or, with `_` and `*` in the URL,
an `<em>` tag inside it. `*italic*` alone was safe. Links and pictures are now set aside while
emphasis runs, as code spans already were. Files edited in Preview before this could still
carry the damage: look for `blank">` in link text. Guarded by `link-emphasis-browser.mjs`.

### Pasting at the end of a long file in two-page Preview overwrote the start — **fixed** (0.17.1)

A page window is one range. After a multi-line paste, the blocks on screen were numbered
0, 1, 2. The paste's undo snapshot then wrote that page into the start of the file, and
the later lines of the paste landed in the middle. A page window's indices are left
alone; `shiftMountedModelIndices` is what moves them. A missing index no longer rebuilds
the model from the mounted range. Guarded by `page-paste-end-browser.mjs`.

### Several lines pasted inside a line — **fixed** (0.16.32)

A multi-line paste in Preview never split the line at the caret: a whole line pasted at the
start of another ran into it (`unoalpha`), and one pasted mid-line came out in the wrong order.
Plain text that began with a line break lost it to a trim added in 0.2.36. Guarded by
two cases in `keyboard-editing-cases.mjs`.

### Windows-1252 notes opened as damaged UTF-8 — **fixed** (0.16.31)

From 0.14.3, a file with fewer than ten non-ASCII bytes that were not UTF-8 -- "café", Word's
curly apostrophes -- opened with U+FFFD in their place, and saving wrote that over the original.
Damaged UTF-8 now needs real UTF-8 in the file; a file still read that way asks before the save
that would write U+FFFD. Guarded by the encoding block of the `TYPOZEN_TAB_E2E` self-test.

### Pasting into a line — **fixed** (0.5.5)

A paste lost its own leading and trailing spaces, and `**bold**` pasted into bold text saved as
unnestable `**a **b** c**`, showing stray asterisks. Guarded by `paste-inline-browser`.

### A book opened on the other tab's page — **fixed** (0.2.49–0.2.51)

One symptom, three causes, each hidden behind the one before, which is why it survived
several rounds of fixes that were each correct as far as they went:

1. **Scroll offset (0.2.49).** `loadBookPayload` never reset `editor.scrollLeft`, and the
   page number is `scrollLeft / stride`, so a book with no remembered position opened on
   the previous book's page *number*, whatever either book's length.
2. **Pending resume (0.2.50).** The jump to a remembered block retries for up to ~5s and
   jumps again 700ms later; nothing cancelled it when another document arrived. A tab
   switch under a second landed the next book on the previous book's block.
3. **Stale reading anchor (0.2.51).** `_readingAnchor` was never cleared. A book opened at
   a remembered block overwrote it, so only a book on page 1 kept the previous book's —
   and the next remount (`set_column_mode`) moved it there. Showed as Hilldiggers on its
   cover coming back at Prador Moon's exact line.

`cancelResumeAt()` (which also calls `forgetReadingAnchor()`) runs beside
`cancelPositionReport()` on every document-replacing host message. Confirmed in the app by
the reader who reported it. Guarded by `tab-position-browser` (~12s, headless), which fails
all three cases on 0.2.48 and the third on 0.2.50.

The generation stamp on `book_position` reports (`doc_gen`, 0.2.48) was added for a
suspected misattributed report and never shown to matter; it is kept because it closes a
real, if unobserved, window. When measuring anything here in two-column mode, read the
`.page-num` spans individually: the indicator's `textContent` runs pages 9 and 10 together
as `910`, and that produced two false reproductions.

### Book text unreadable on dark themes — **fixed** (0.2.49)

Hilldiggers' stylesheet sets `color: black` on its paragraph classes. `applyBookStyles` now
drops neutral `color` / `background-color` / bare-colour `background` declarations (black,
white, greys) so the theme decides; coloured declarations stay. Inline `style=` in a book's
markup now goes through the same rules (0.7.11).

### Source search highlighting jumped to the wrong place — **fixed** (0.2.30)

The mirror that paints hits on a `<textarea>` scrolled by hard-line-index /
line-count × scrollHeight. Wrapped paragraphs are many visual rows, so Search
landed far from the match. It now paints first, then scrolls so the current
`<mark>` is in the textarea viewport. Wrap width follows `clientWidth` (not the
scrollbar box). `source-highlight-app` asserts a late jump is on screen.

### F1 / Help → Syntax & Shortcuts did nothing — **fixed** (0.2.28)

The empty-tab hint and the Help menu advertised F1. Only F7/F8/F9 were bound in
the page. `Window.KeyDown` has F1, but that event never runs while the editor
WebView has focus, and disabled Chromium accelerator keys can swallow F1
(browser Help) before page JS. The key looked dead.

**Now:** page JS binds F1 next to F7/F8/F9; the host key filter posts
`cmd:help_syntax` the same way it posts Ctrl+Z. The overlay **opens** (does not
toggle, so a page+host double-fire cannot close it). CSS `.open` wins over
`[hidden]`. `scratch-help-app` presses a real `{F1}` into the window.

### New-tab placeholder was real document text — **fixed** (0.2.27)

New Tab loaded `# Untitled Document` / `Start typing here...` as markdown.
The CSS hint lived on `.block::before`, which is the 10px bookmark gutter
(`width:10px`), so the sentence painted one glyph per line. Chromium
`innerText` includes `::before`, so a tab switch saved that string as the
file — including after the user had deleted it. Selection drags on that
rail also jumped from the start of the document.

**Now:** new documents are empty. The hint is an overlay on
`#editor-wrapper`, `pointer-events: none`, not in the block. `getBlockRaw`
does not prefer `innerText` over empty `data-raw`.

### Ctrl+B on a PDF formatted the hidden document — **fixed** (0.2.26)

`SendMsg` gated `cmd:` on a native tab but not `fmt:` / `export_html`. The
host key filter posted `fmt:bold` at the editor WebView sitting behind the
PDF, so a chord on a picture dirtied the markdown you were editing.

**Now:** those messages are refused while the native surface is showing;
the filter does not swallow the chord (the viewer can have it).
`native-surface-app` asserts Ctrl+B leaves the hidden document clean.

### Seeking into a very large book looked hung — **harness, not a hang**

`epub-open-app` stalled on the 45,486-block Xeelee omnibus. Isolated,
`goToModelBlock` into the middle is ~120 ms and windowing mounts 800 blocks.
The red run was stacked CDP evaluates (`evalPatiently` abandoning an in-flight
remount and sending another) plus Matter's throwaway-profile session leaking
into the Xeelee relaunch. Suite now passes both books (93/0). Do not raise
`protocolTimeout`.

### Search jumped to the wrong place when a match had no DOM range — **fixed**

Image-only path matches and other no-text-node hits used to fall back to `ranges[0]` and
scroll to the first mounted highlight (often the top of the document).

**Now:** `highlightModelMatchInMountedDom` only scrolls when `currentRange` names this
match. Image-only hits navigate via `ensureModelBlockVisible` / page map and never use
the text highlighter. Status Ln is pinned after jumps (`pinStatusLineAfterJump` + sticky
preferred when focus is outside the editor).

### Marks list active row wrong in 2-col — **fixed**

Active row used “last mark ≤ top-left block,” missing marks on the right of the spread.
**Now:** prefer marks visible on screen, then list-click pin, then last-before.

### Preview not editable after leaving a book — **fixed**

`leaveBookViewForMarkdown` set `contenteditable` while mode was still Reader, then
flipped mode without re-enabling edit. **Now:** mode first, then
`setEditorEditable(true)` for Preview; `applyViewState` re-syncs editability.

### Marks unresolved after reopen — **fixed** (re-verify if seen)

Load-order / fingerprint / hint handling for marks across book open and Marks tab.

### Tab after undo (list indent) — **mitigated**

Clear format freeze on undo/redo; list Tab prefers live selection.

---

### Select All copied the window, not the document — **fixed**

`Ctrl+A` selects the editor's *contents*, and under virtualisation those are a window: 54
blocks of 3767. `selectionToPlainText` walked the mounted blocks, so Select All + Copy put
**2,797 characters of a 205,842-character document** on the clipboard — one per cent,
silently. **Now:** a whole-editor selection over a partial DOM is answered from
`DocumentModel`. The `text/html` flavour is omitted in that case rather than fixed, so no
rich target can take the window while the plain text carries the document.

### Print produced a fraction of the document — **now prints whole**

Chromium prints the DOM, so `Ctrl+P` on a long document made a PDF of roughly what was on
screen, with nothing to indicate the rest was missing. Worse than a skipped paragraph: it is
an artefact you keep and may send on. It was then refused outright, which meant no novel and
no large Markdown file could be printed at all.

**Now (0.11.0):** the host asks the page for a whole copy first (`tzPreparePrint`, 03-shell.js):
every block built from the model, beside the live editor and carrying the same id, so every
`#editor` rule and the book's own stylesheet apply unchanged. It is hidden on screen, and in
print the live editor is hidden instead; `afterprint` removes it. The live editor is never
touched, so nothing has to be remounted. Pictures in the copy are made eager and the host
waits up to 3 s for them. Measured: Pride and Prejudice (2,099 blocks) builds in ~100 ms and
prints 458 pages with its pictures; `large-scroll-mixed.md` prints 168 pages in Scroll and in
2-Col (`print-layout-browser`). Above 20,000 blocks (an omnibus) Print still refuses and says
why. Still fails open: an unanswered probe prints what is in the page.

**Cut / Delete after Select All, and Export as HTML, used the window too — now fixed.**
`getAncestorBlock` stops at `#editor`, so a `selectNodeContents(editor)` range was not
treated as multi-block. Cut fell through to the browser: clipboard got the window, the view
blanked, the model survived. Delete after Select All was the same hole. Export as HTML
dumped `editor.innerHTML`. **Now:** a whole-editor selection copies/cuts/deletes via
`DocumentModel`, and export renders every model block. Guarded by `clipboard-roundtrip-browser`.

---

### Turning a page silently skipped text — **fixed**

The worst defect found in this tree. Reading any long document in **Pages** mode, text was
lost at every 800-block range boundary, with nothing on screen to say a paragraph had gone.

A range's last page is usually partial, so its start offset (`index x stride`) lies past the
furthest the view can scroll. `PageGeometry.localCount()` treated that as "not a page you can
turn to" and dropped it — but `go()` had already been fixed to end that page at `maxScroll`
so its tail shows flush right. The page was reachable; nothing was ever allowed to ask for
it. The view stopped at the last whole boundary and everything from there to the end of the
range was never painted.

Measured on `tests/large-scroll-mixed.md`, 2-column, over 200 spreads: **16px lost 16 blocks
across three boundaries** (7, 1 and 8); 18px lost 8 across one. The default font size was the
worse case, so this was not an exotic configuration.

**Now:** the count is the content, and `localIndex()` answers from the scroll position — being
parked at `maxScroll` *is* the last page. That keeps the reader from being stranded on it,
which is what the dropped-page clamp had been guarding against. Guarded by
`page-coverage-app`, which walks spreads and asserts no gap in the blocks actually painted.

---

### Hover paint erased bookmarks — **fixed**

The hover cue and the bookmark were both drawn as an inset left `box-shadow`, and the
hover rule was written more specifically, so mousing over a bookmarked paragraph in
Preview swapped its amber edge for the accent one. In Reader the "hover off" rules used
`box-shadow: none !important` / `background-color: transparent !important`, which erased
the bookmark rail *and* the arrival wash on whichever paragraph the pointer rested over.

**Now:** the gutter holds one ribbon beside a marked paragraph's first line, owned by
bookmarks, and nothing appears on hover (0.7.4 removed the hover preview and its View menu
item: the gutter click it previewed had gone in f673fc2). Nothing in that lane uses
`!important`.

---

## Preferences (not bugs)

- Search and Marks jumps share **`flashMarkFocus`**: a brief wash in the theme's text colour
  (`--arrive-bg`), not the marks' colour.

---

### The selection popover sits on the text it is about - **fixed** (0.3.5)

Selecting a word near the top of a document raised the bar *above* the selection, covering the text. Selecting near the bottom put it below, off screen. It frequently overlapped the selected line itself.
This was caused by the native `host-zoom` CSS scaling not being canceled out correctly in the JavaScript absolute positioning logic, inverting the coordinate math.
The bar was also redesigned into a 3x2 grid with new icons, a "Read from here" button, and automatic layout flipping when it expands the dictionary body.

## If something still feels wrong

1. Reproduce once with Debug HUD (Ctrl+Shift+D): sticky line, find index, mode.
2. Prefer a new entry here over reopening a “fixed” section without evidence.
3. Page-number drift on first pass through a huge book is the product limit above, not a
   regression of mark resolve or search jump.
