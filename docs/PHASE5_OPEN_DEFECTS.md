# Phase 5 — open EPUB defects (handover)

State at `bf32da0`, plus the two fixes below. 46 suites green, `epub-open-app` 29/29 — and the book still renders
wrong in three ways. Every green assertion here is structural; none of them looks at a
rendered pixel, which is why they pass. Fixing the tests is part of each fix below, not a
separate task.

Reported against the build of 2026-08-05, on `Xeelee Sequence` and `Matter`:

| | Xeelee | Matter | status |
|---|---|---|---|
| cover / images | **broken-image placeholder** | renders, but **squashed** | fixed below, unverified on screen |
| chapter page breaks | **none** | **none** | open |
| TOC links | worked | **don't jump** | open |
| outline | worked | worked | — |

Sections 1 and 2 were fixed after this was written; the fixes are described in place and the
binary is rebuilt, but nobody has looked at a rendered cover yet. 3 and 4 are untouched.

---

## 1. Images resolve against the wrong base (Xeelee)

**Root cause — confirmed by reading both archives.** Image hrefs in a spine document are
relative to *that document*, not to the OPF directory or the extraction root.

```
Xeelee   opfDir "OEBPS/"   doc Text/cover_page.xhtml   href ../Images/cover02758.jpeg
Matter   opfDir ""         doc titlepage.xhtml         href cover.jpeg
```

`bookResolveUrl` resolves against a single `assetsBase`. Matter is flat at the archive
root, so every href is already correct relative to the base and it works **by accident**.
Xeelee's `../Images/…` resolved against the base escapes the document's directory and
404s — hence the placeholder. 460 spine docs, 38 image files, all under `OEBPS/Images/`.

**Fixed.** `bookBlocksFromDocs` now also returns `dirs` — the owning document's directory
per block — which `loadBookPayload` keeps in `_bookBlockDirs`. `bookResolveUrl(href, docDir)`
resolves against `assetsBase + docDir`, so `new URL` does the `../` walking.
`createPreviewBlockEl` takes the model index and sets `data-model-index` **before** the
render rather than after, since the rewrite runs inside the render and needs the index to
find the directory.

**Test.** The current image assertion checks the `src` was *rewritten*. It must instead
assert the resource actually loaded — `img.naturalWidth > 0`, and for SVG covers, fetch the
rewritten href and check the response is not a 404. Assert on **Xeelee**, whose paths are
nested; Matter's flat layout can't catch this class of bug.

## 2. Covers are squashed (Matter)

**Root cause — in the file.** Matter's titlepage is a Calibre-style SVG wrapper with the
aspect ratio explicitly switched off:

```
Matter   <svg width="100%" height="100%" viewBox="0 0 510 680" preserveAspectRatio="none">
Xeelee   <svg width="100%" height="100%" viewBox="0 0 500 739" preserveAspectRatio="xMidYMid meet">
```

`preserveAspectRatio="none"` tells the renderer to stretch to the box — so the 521px height
bound from the last commit is met by distorting a 510×680 cover. Xeelee carries `meet` and
would be fine, if its href resolved.

**Fixed.** Chromium will not take `preserve-aspect-ratio` from CSS, so `rewriteBookUrls`
strips `preserveAspectRatio="none"` from the markup and the `xMidYMid meet` default applies.
The svg rule also had `height: auto` but no `width`, leaving the markup's `width="100%"` to
hold the width while the height clamped — letterboxing at best. Both are `auto` now, so the
viewBox ratio drives the size and `max-height` takes the width down with it.

**Test.** Measure the rendered `getBoundingClientRect()` of the cover and assert
`width/height` is within a few percent of the `viewBox` ratio. That is the assertion that
would have caught this; "the element exists and is under 68vh" is what shipped.

## 3. Chapter page breaks never fire (both books)

The CSS rule and the attribute both exist:

```css
#editor.page-mode .block[data-chapter-start] { break-before: column; page-break-before: always; }
```

```js
if (_bookDocStarts[i]) el.setAttribute('data-chapter-start', '1');
```

`_bookDocStarts` is the right shape — `js/typozen.js:10902` builds a map keyed by block
index from `split.docStarts`, and Xeelee has 460 spine docs, so there is no shortage of
starts. So either the attribute isn't reaching the DOM or the break isn't being honoured.

**Ruled out: a scope mismatch.** The declaration and all four read/write sites sit at the
same indentation level in the same IIFE, so they are one binding. Start instead by counting
`[data-chapter-start]` elements in the mounted DOM against the doc count for the current
page window — that single number splits the remaining two causes.

**Prime suspect: page windowing.** Page windowing lays out one `PageChunks`
range at a time; a `break-before: column` on the first block of a chunk is a no-op, and a
chunk boundary falling mid-chapter can swallow a break. Worth confirming against a
non-windowed load of the same book.

**Cleanup while in there.** The four mount sites have the same line duplicated at two or
three indentation levels (`9156-9157`, `10945-10946`, `8957-8959`) — harmless, idempotent,
and left over from a bad edit script. Collapse them.

**Test.** Load a book in 2-Col Pages and assert the first block of each spine document
starts at the top of a column: its `getBoundingClientRect().top` equals the column top
within a line height. Do it for both books and both column counts.

## 4. Matter's TOC links don't jump

The **outline** works — that's `bookRepairTocByTitle` from `bf32da0` doing its job, matching
NCX titles to headings after href resolution collapsed to a single target. The **in-book
TOC document** is a different path: its anchors are real `<a href>` elements inside the
book's own HTML, handled by `bookGoToHref` / `buildBookAnchorIndex`.

Matter's in-text links point at `#filepos…` anchors while the documents actually contain
`calibre_pb_*` ids — dangling **in the source file**, so no reader can resolve them by href
alone. The outline repair proves the titles are recoverable, so the same fallback applies:
when `bookGoToHref` finds no anchor, fall back to matching the link's own text against the
heading index before giving up. Xeelee's hrefs resolve properly and must stay on the fast
path — gate the fallback on lookup failure, exactly as the outline repair is gated.

---

## The pattern in all four

Every one of these passed a test that asserted on structure — an attribute was set, a `src`
string was rewritten, a TOC entry mapped to a block index — while the thing the user looks
at was broken. The assertions that would have caught them all measure **rendered geometry
and loaded resources**: `naturalWidth`, bounding-rect ratios, column tops, scroll position
after a click. Prefer those in `epub-open-app.mjs` from here on, and assert on Xeelee as
well as Matter, since the two books fail in opposite directions.

## Remaining Phase 5 work after these

- Step 7 of `PHASE5_EPUB_PLAN.md`: reading position remembered per book.
- `PageChunks.size` (400) was tuned on a Markdown fixture, not a 1.4M-word novel.

## Reproduction

```bash
powershell -File tests/run-tests.ps1
```

Books are in `tests/`: Xeelee (460 spine docs, nested assets), Matter (42 docs, flat),
plus Dune and Nemesis Games as untried third and fourth cases.
