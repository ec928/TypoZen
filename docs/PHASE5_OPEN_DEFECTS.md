# Phase 5 — the four EPUB defects, and why the tests missed them

All four are fixed. This is kept as the record of what was wrong and, more usefully, of why
a green suite said otherwise: every assertion here was **structural** — an attribute was
set, a `src` string was rewritten, a TOC entry mapped to a block index — while the thing on
screen was broken. The replacements measure rendered geometry and loaded bytes.

`epub-open-app` now runs its full pass on **both** books (54 assertions, was 29 on one), and
that alone is half the story: Matter is flat at the archive root and Xeelee is nested, so
they fail in opposite directions and neither book alone can catch both bugs.

Reported against the build of 2026-08-05, on `Xeelee Sequence` and `Matter`:

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

## A fifth control-character bug, caught by the new test

While writing the image check, `/<(img|image)\b/i` was written through a tool that turned
the `\b` into a literal backspace byte. The regex matched nothing, and the suite reported
"0 images" rather than failing — the same shape as the three before it. `parse-check.mjs`
only guarded the application sources; it now guards every `tests/*.mjs` as well. The tests
are sources too.

## What to keep doing

Assert on rendered geometry and loaded bytes, not on structure, and run the full pass on
both books. Three of these four were invisible to a correct-looking structural assertion,
and two of them were invisible to Matter specifically.

## Remaining Phase 5 work

- Step 7 of `PHASE5_EPUB_PLAN.md`: reading position remembered per book.
- `PageChunks.size` (400) was tuned on a Markdown fixture, not a 1.4M-word novel.

## Reproduction

```bash
powershell -File tests/run-tests.ps1
```

```bash
RUN_APP_E2E=1 node tests/epub-open-app.mjs
```

Books are in `tests/`: Xeelee (460 spine docs, nested assets), Matter (42 docs, flat), plus
Dune and Nemesis Games as untried third and fourth cases.
