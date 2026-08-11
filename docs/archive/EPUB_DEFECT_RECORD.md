# EPUB defects, and why the tests missed them

Every defect a reader reported while Phase 5 was being finished, with its root cause and the
assertion that now covers it. Kept because the pattern is more useful than the individual
bugs: **all of them had a green structural assertion sitting over them.** An attribute *was*
set, a `src` *was* rewritten, a TOC entry *did* map to a block index — while the thing on
screen was wrong.

Two rounds. The first four came from opening a book for the first time; the second five from
reading one for an hour.

`epub-open-app` now runs its full pass on **both** test books — 68 assertions, from 29 on one.
That is half the story on its own: `Matter` is flat at the archive root and `Xeelee` is nested,
so they fail in opposite directions and neither alone catches both bugs.

---

# Round one — opening a book

| | Xeelee was | Matter was | now |
|---|---|---|---|
| cover / images | broken-image placeholder | rendered, but squashed | 3/3 load per book; cover ratio 0.0% off its viewBox on both |
| chapter page breaks | none | none | 10/10 and 13/13 start a column |
| TOC links | worked | didn't jump | Matter's "1. Factory" → block 143 |
| outline | worked | worked | unchanged |

---

## 1. Images resolved against the wrong base (Xeelee)

**Root cause — confirmed by reading both archives.** Image hrefs in a spine document are
relative to *that document*, not to the OPF directory or the extraction root.

```
Xeelee   opfDir "OEBPS/"   doc Text/cover_page.xhtml   href ../Images/cover02758.jpeg
Matter   opfDir ""         doc titlepage.xhtml         href cover.jpeg
```

`bookResolveUrl` resolved against a single `assetsBase`. Matter is flat at the archive root,
so every href was already correct relative to that base and it worked **by accident**.
Xeelee's `../Images/…` resolved a level too high and 404'd — the placeholder. 460 spine
docs, 38 image files, all under `OEBPS/Images/`.

**Fixed.** `bookBlocksFromDocs` also returns `dirs` — the owning document's directory per
block — which `loadBookPayload` keeps in `_bookBlockDirs`. `bookResolveUrl(href, docDir)`
resolves against `assetsBase + docDir`, so `new URL` does the `../` walking.
`createPreviewBlockEl` takes the model index and sets `data-model-index` **before** the
render rather than after, since the rewrite runs inside the render and needs the index to
find the directory.

**Test.** The old assertion rendered into a scratch block and checked the `src` started
`http`. It now navigates to the blocks that carry images, lets them mount, and asks the
browser whether the bytes arrived (`complete && naturalWidth > 0`). SVG covers report
nothing to the browser, so their href is fetched and the response checked. A rewritten
`src` that 404s is still a broken image.

## 2. Covers were squashed (Matter)

**Root cause — in the file.** Matter's titlepage is a Calibre-style SVG wrapper with the
aspect ratio explicitly switched off:

```
Matter   <svg width="100%" height="100%" viewBox="0 0 510 680" preserveAspectRatio="none">
Xeelee   <svg width="100%" height="100%" viewBox="0 0 500 739" preserveAspectRatio="xMidYMid meet">
```

`preserveAspectRatio="none"` tells the renderer to stretch to whatever box it is given — so
bounding the height distorted a 510×680 cover instead of scaling it.

**Fixed.** Chromium will not take `preserve-aspect-ratio` from CSS, so `rewriteBookUrls`
strips the attribute and the `xMidYMid meet` default applies. The svg rule also had
`height: auto` but no `width`, leaving the markup's `width="100%"` to hold the width while
the height clamped — letterboxing at best. Both are `auto` now, so the viewBox ratio drives
the size and `max-height` takes the width down with it.

**Test.** The cover's rendered `width/height` is compared against its `viewBox` ratio and
must be within 5%. Both books come out 0.0% off (Matter 0.750 = 510/680, Xeelee 0.677 =
500/739).

## 3. Chapter page breaks never fired (both books)

**Root cause — `break-before` computed to `page`, not `column`.** The rule carried a second
declaration:

```css
#editor.page-mode .block[data-chapter-start] {
    break-before: column;
    page-break-before: always;   /* the bug */
}
```

`page-break-before: always` is a legacy alias for `break-before: page`. It came second, so
it won — and a *page* break is a paged-media break that a multi-column layout ignores
entirely. Every chapter ran on mid-column while the attribute the test counted was present
on all of them. It had been added "for safety".

**Fixed** by deleting the legacy line. 13 of 13 chapter starts in Matter and 10 of 10 in
Xeelee now begin a column.

**Test.** Counting marked blocks is exactly what passed while this was broken. The check is
now geometric, and stated as what a page break means: **nothing else in that column sits
above it.** Two weaker versions were tried first and both were wrong — measuring the offset
from the container's top failed a title block whose first child's 75px margin collapses
outward, so the block starts 75px into its column while reporting `margin-top: 0`. Grouping
mounted blocks by column and comparing tops has no such hole.

**Cleanup done.** The four mount sites had that line duplicated at two or three indentation
levels — harmless and idempotent, left over from a bad edit script. Collapsed.

## 4. Matter's TOC links didn't jump

The **outline** worked — `bookRepairTocByTitle` matching NCX titles to headings after href
resolution collapsed. The **in-book contents page** is a different path: real `<a href>`
elements in the book's own HTML, handled by `bookGoToHref`.

Matter's contents page links to `#filepos3742` and the book contains **no filepos anchor at
all** — 70 anchors, every one `calibre_pb_*`. Dangling in the source file, so no reader can
follow them by href.

**Fixed.** `bookGoToHref(href, linkText)` falls back to a title index when, and only when,
the href has resolved to nothing. The index is the outline's own targets first — already
repaired — then the book's headings, so a link lands exactly where clicking the outline
lands. Xeelee's hrefs resolve and never reach the fallback.

**Test.** A real `.click()` on an anchor on the book's own contents page, choosing one whose
title maps more than 20 blocks away, then checking the reader moved. Two measurement bugs
had to be fixed first: `firstVisibleIdx()` answers "the first mounted block" in a
horizontally scrolling multicol, because every block intersects the viewport vertically, and
it also cannot tell apart two blocks inside one 400-block window. Position now comes from
`topLeftModelIndexTwoCol()` or `_readingAnchor`.

---

# Round two — reading a book

Reported after an hour with the omnibus open. All fixed.

| Reported | Root cause |
|---|---|
| "the scroll bar doesn't allow you to move quickly to the ends of the book" | The editor's scrollbar measures the DOM, and only one range is laid out |
| "why is the font still smaller than the theme font?" | The book asks for `0.88em` on every paragraph |
| "why am I in reader mode, 1-col and unable to select pagination mode?" | The loader set the mode without the layout it implies |

## 5. The scrollbar could not reach either end

Not a compromise, a consequence: page windowing lays out one 800-block range, so the scroll
extent covers about 28 pages of a 1400-page novel. No amount of scrollbar tuning fixes that —
the control was measuring the wrong thing.

**Fixed** with a position control that addresses **pages**, the coordinate the paginated model
is built on and the only one that describes the whole document however little of it is mounted.
`PageMap.goto()` already mounts the range a page falls in, so seeking is the same operation as
turning a page.

Two things it had to learn. It seeks on **release**, not on every input event, because a drag
would otherwise mount a range per pixel of travel — a bubble names the page under the thumb
meanwhile. And pages beyond the laid-out ranges are estimates, so arriving somewhere
re-measures and the total moves: the first version of drag-to-end landed on page 5,210 of a
suddenly 5,355-page book. It now settles onto whatever the last page turns out to be once it
is standing on it.

**Test.** `page-scrubber-app` drags the control through its own events — not by calling
`PageMap.goto()`, which would pass with the control unwired — and asserts the far end is
block 40,654 of 40,656.

## 6. Body text ignored the theme's size

A publisher sizes against a device default it cannot see. `Xeelee` asks for 0.88 of base on
every paragraph and `Matter` asks for 1em, so the same 14px theme produced 12.32px in one book
and 14px in the other. Converting `rem` to `em` (round one) made the font-size control *reach*
the text; it did not make the text the chosen size.

**Fixed** by normalising the book's base while keeping its proportions — a heading it wants at
1.5 stays half again as large as its body. The correction is **measured**, not parsed: which
selector carries body text is a question about a specific book, so it takes the most common
computed size among the long paragraphs on screen. Expressed as a multiple of `--fs`, so
changing the theme still moves the book.

**Test.** Body text must render within 0.5px of the theme size, and follow it when `--fs`
changes. Both books, both assertions.

## 7. A book could open into a state it could not leave

Reader is pages only, and Reader locks the scroll selector. The loader set `state.mode` to
`reader` directly without applying the pagination that implies, so opening a book while the
previous document was scrolling landed in **reader + scroll** — a combination
`resolveViewState` cannot produce and the toolbar cannot escape. The only way out was a round
trip through Preview.

**Fixed** in the loader. **Test:** every book in `epub-open-app` is now opened *from* Preview +
Scroll, which is the path that stranded it, and the state on arrival is asserted to be
paginated and not locked out of leaving.

## Found on the way

Three defects that had nothing to do with epubs, surfaced by work that did:

- **Undo could not undo typing in a paginated layout.** Type, press Enter, Ctrl+Z: the Enter
  came back and the typed text never did. `loadMarkdownContent` seeds a fresh history at the
  end of the load, and on the progressive path that end arrives across `requestAnimationFrame`
  batches — long after `undo()` cleared `isRestoring`. The seed wiped the stack undo was
  halfway through using, and `undo()` then refused to continue because one frame is the floor.
  Found by the editing sweep the first time it pressed a real Enter key instead of calling
  `execCommand('insertParagraph')`.
- **The last page could not always be reached.** A document ending part way into its final page
  leaves a maximum `scrollLeft` short of that page's offset, so the map named a position the
  browser will never hold and a turn onto it parked half a page out. Exposed by reserving a
  strip at the foot of the page for the scrubber.
- **Typing into a blank line went nowhere.** `setCaretAtOffset`'s fallback was guarded by
  `childNodes.length > 0`, which excludes exactly the case with no text to walk.

## A fifth control-character bug, caught by the new test

While writing the image check, `/<(img|image)\b/i` was written through a tool that turned
the `\b` into a literal backspace byte. The regex matched nothing, and the suite reported
"0 images" rather than failing — the same shape as the three before it. `parse-check.mjs`
only guarded the application sources; it now guards every `tests/*.mjs` as well. The tests
are sources too.

## What to keep doing

Assert on rendered geometry and loaded bytes, not on structure. Drive the real entry point —
a dispatched `KeyboardEvent`, a real `.click()`, the control's own events — because calling
the handler underneath tests a path no user reaches. And run the full pass on both books:
most of these were invisible to a correct-looking structural assertion, and several were
invisible to one of the two books specifically.

Three of my own probes were wrong before the application was, which is its own lesson:
`firstVisibleIdx()` answers "the first mounted block" in a horizontally scrolling multicol;
`getBoundingClientRect()` on a paragraph spanning two columns returns the union of its
fragments; and a benchmark that measures around a `sleep()` reports the sleep.

## Remaining

Nothing from these two rounds. Phase 5 is complete; outstanding work for the project is
listed in [`../README.md`](../README.md#outstanding-work).

One thing genuinely unfixable stays on the record: `Matter`'s in-text links point at
`#filepos` anchors while its actual anchors are `calibre_pb_*`. They are dangling in the file
itself. The outline and the contents page are recovered by title; a mid-chapter cross-reference
has nothing to match on.

## Reproduction

```bash
powershell -File tests/run-tests.ps1
```

```bash
RUN_APP_E2E=1 node tests/epub-open-app.mjs
```

Books are in `tests/`: Xeelee (460 spine docs, nested assets), Matter (42 docs, flat), plus
Dune and Nemesis Games as untried third and fourth cases.
