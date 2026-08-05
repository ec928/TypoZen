# Phase 5 — open EPUB defects (handover)

State at `bf32da0`. 46 suites green, `epub-open-app` 29/29 — and the book still renders
wrong in three ways. Every green assertion here is structural; none of them looks at a
rendered pixel, which is why they pass. Fixing the tests is part of each fix below, not a
separate task.

Reported against the build of 2026-08-05, on `Xeelee Sequence` and `Matter`:

| | Xeelee | Matter |
|---|---|---|
| cover / images | **broken-image placeholder** | renders, but **squashed** |
| chapter page breaks | **none** | **none** |
| TOC links | worked | **don't jump** |
| outline | worked | worked |

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

**Fix.** Resolution needs a per-document base. `bookBlocksFromDocs` already walks the docs
and returns `docStarts`; have it also record each block's owning doc href, and resolve
`assetsBase + dirname(docHref) + href` (normalising `..` segments). A parallel
`_bookDocBase[blockIndex]` mirrors the existing `_bookDocStarts` shape.

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

**Fix.** Chromium does not honour `preserve-aspect-ratio` from CSS, so this has to be done
in the markup: in `sanitizeBookHtml` (or alongside the href rewrite in `rewriteBookUrls`),
drop `preserveAspectRatio="none"` so the default `xMidYMid meet` applies. With a `viewBox`
present, `width:auto; height:auto; max-width:100%; max-height:68vh` then sizes it on its
intrinsic ratio.

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

**Prime suspect: a scope mismatch.** `let _bookDocStarts = {}` is declared at
`js/typozen.js:8997`, but the mount sites that *read* it sit at 8957, 9156 and 10945, and
the assignment is at 10902. Check that all four are the same binding and not a local
shadowing an outer one (or an assignment landing on an implicit global). Verify first by
counting `[data-chapter-start]` elements in the mounted DOM against the expected doc count
for the current page window — if the count is 0, it's the binding; if it's right, the
problem is the multicol break itself.

**Second suspect, if the attribute is present.** Page windowing lays out one `PageChunks`
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
node tests/run-all.mjs
```

Books are in `tests/`: Xeelee (460 spine docs, nested assets), Matter (42 docs, flat),
plus Dune and Nemesis Games as untried third and fourth cases.
