# Known issues

Baseline inventory of **user-visible** residual risk for the current tree.

- **Open defect-class items:** none.
- Suite-only failures belong in the harness, not here. See `docs/for-agents.md`.
- This file is the living record. The health reviews are archived snapshots of older
  trees (`docs/archive/`) and do not describe current state, whatever their own text says.

## Product limits (not defects — do not “fix” by inventing precision)

### The page TOTAL is an estimate until the document has been laid out — and says so

`PageChunks` measures only the ranges the reader has visited and infers the rest from
pages-per-block. So the total moves as a long book is read. Three rules keep that honest
rather than misleading:

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

**User expectation:** the page you are on is right; the total is marked `~` while it is
still being learned, and is exact once the document has been read through. Mark sidebar
**p N** uses the same map and can lag until its range is real.

---

## Product notes (not defects)

### Spelling is not the bundled dictionary

`dictionary.tsv` / `thesaurus.tsv` are WordNet **Look up**. Preview spelling is
WPF’s dictionaries (English, French, German, Spanish). Source uses Chromium.
Books, PDFs and Reader are not checked.

---

## Fixed / mitigated (kept briefly so regressions are recognized)

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
white, greys) so the theme decides; coloured declarations stay. Inline `style=` colours in
a book's markup are not touched.

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

### Print produced a fraction of the document — **now refused**

Chromium prints the DOM, so `Ctrl+P` on a long document made a PDF of roughly what was on
screen, with nothing to indicate the rest was missing. Worse than a skipped paragraph: it is
an artefact you keep and may send on. **Now:** Print stops and explains, rather than mounting
the whole document (which is the work windowing exists to avoid). Fails open — an unanswered
probe prints, so a broken check cannot silently disable Print.

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

**Now:** the gutter is a single `::before` rail owned by bookmarks, four opacities, and
there is no block-body hover cue at all. Nothing in that lane uses `!important`.

---

## Preferences (not bugs)

- **View → Block Hover:** `off` / `gutter` (default). Controls the hover *preview* only —
  a bookmark that exists is always drawn, in Reader as well as Preview.
- Search and Marks jumps share **`flashMarkFocus`** (brief amber wash, `MARK_FLASH_MS`).

---

## The selection popover sits on the text it is about

**Fixed in v0.3.4** -- the single-row bar does it too, confirmed by
screenshots on 2026-09-20 against a build with no popover changes in it.

Selecting a word near the top of a document raises the bar *above* the selection, where it
covers the heading and the line that was selected. Selecting near the bottom of the window
puts it below, partly or entirely off screen. In between it frequently overlaps the
selected line itself.

The placement code is at the end of `showSelPop` in `js/modules/02-layout.js`. It asks
"does the bar fit above?" and near the top of a document the answer is yes -- there is
room, it is just room occupied by text the reader is looking at.

**The rule it should follow instead**, in Ed's words: near the top, the popover goes
**below** the selection; near the bottom, it goes **above**. That is a judgement about
where the selection sits in the window, not about where space happens to exist.

**What was tried and did not work** (2026-09-20, all reverted):

1. Choosing the side with more room. Still went above near the top, because there is more
   room above once you are a few lines down.
2. Correcting the coordinates after the fact by comparing `style.top` with
   `getBoundingClientRect()`, on the theory that a transformed ancestor had redefined what
   `position: fixed` means. It made placement worse, including putting the bar off the
   bottom of the window.
3. Rewriting the placement to verify the outcome (on screen, clear of the selection) after
   layout. This one was never seen running: the edit that introduced it was applied by text
   surgery, cut the wrong span of braces, and broke the page badly enough that no file would
   open. `node -e "new Function(...)"` parses such a file happily, and the 61 JS suites pass,
   so neither caught it -- `RUN_APP_E2E=1 node tests/core-smoke-app.mjs` takes 13 seconds and
   would have.

**Next time:** drive the app, put a real selection on screen, and read the actual rects
before changing the arithmetic. Every attempt above reasoned from screenshots instead.

### The redesign this is holding up

Fixing the placement and redesigning the bar are one job, not two: the design below is
two rows rather than one, which makes a bar that lands badly land worse, and the layout
cannot be judged while it is sitting on the words it describes. The design was built on
2026-09-20, seen by Ed, and reverted with the placement work. Nothing of it survives in
the tree, so it is written out here.

**Why it exists at all:** there is no way to say "read on from here". With a selection,
Read aloud reads *only the selection*; reading from the cursor onward needs the selection
cleared first. "Read from here" fills that gap, and the bar was too crowded to take a
sixth button in one row.

**The layout** -- three groups side by side, two rows each:

| left: what you do to it | middle: what you ask about it | right: what you hear |
| --- | --- | --- |
| Highlight | Look up | Read selection |
| Add Link | Find in document | Read from here |

- The **middle group sits under the pointer**, because Look up is the most asked-for and
  the nearest target is the fastest to hit.
- **"Read aloud" becomes "Read selection"** -- directly above "Read from here", two labels
  three words apart whose behaviours differ only in scope will be misclicked otherwise.
- **Each group collapses on its own**, so the bar reflows instead of leaving a hole: a book
  has no Add Link, Source has no Highlight, a phrase has no Look up. Do this in JS at the
  end of `showSelPop` (`g.hidden = no visible buttons`), not with a CSS `:has()` rule -- a
  selector that stops matching fails silently and you get the hole anyway.
- **Add Link must be hidden in a book** (`DocumentModel.kind === 'epub'`). It was offered
  there and did nothing when pressed; that part is a plain bug, independent of the redesign.
- **Icons on all six.** Three had none, and beside the three that did they looked unfinished.
  Drawn in the same line style as the read-aloud icon: an open book for Look up, a magnifier
  for Find in document, lines-with-a-play-marker for Read from here.

**"Read from here" is nearly free**, which is the good part: collapse the selection to its
start -- `range.collapse(true)` in the DOM, `setSelectionRange(at, at)` in Source -- then
call `speakSelection()`. Reading from the cursor to the end of the document is what that
function already does when nothing is selected, so the epub, Source and Pages paths all come
for free. Stop any current playback first. Clear the selection so the reading highlight is
not fighting it.

**Files it touches:** `#selPop .selpop-actions` in `TypoZen_Template.html`, the
`.selpop-group` rules in `css/typozen.css`, `showSelPop` in `js/modules/02-layout.js`, and
`initTTS` plus the `READ_ALOUD_HTML` label in `js/modules/09-speech.js`.

## If something still feels wrong

1. Reproduce once with Debug HUD (Ctrl+Shift+D): sticky line, find index, mode.
2. Prefer a new entry here over reopening a “fixed” section without evidence.
3. Page-number drift on first pass through a huge book is the product limit above, not a
   regression of mark resolve or search jump.
