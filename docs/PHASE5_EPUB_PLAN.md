# Phase 5 — epub

## The decision

**A block's `raw` carries the book's own HTML. There is no HTML→Markdown conversion.**

`DocumentModel` is already "one canonical raw string per block, rendered to a preview".
Nothing in that says the raw must be Markdown. Giving the model a *document kind* —
`markdown` or `epub` — means an epub block renders its own HTML fragment under the book's
own stylesheet, and every other part of the application carries on working on blocks
exactly as it does today.

### Why not convert to Markdown

It was the obvious plan and the measurements killed it. Both existing converters were run
against real books:

| | in *Blindsight* | TypoZen `EpubExtractor.cs` |
|---|---|---|
| images | 6 | **0** |
| links | 162 | **0** |
| list items | 170 | **0** |
| footnote refs | 210 | **0** |
| headings | 17 | 17, of which **16 broken** (`##` then text on the next line) |

Broken headings means no outline and no chapter navigation, which is most of what a reader
is. ZenSeek's converter is better — it extracts the zip so images resolve, and scans the
book's CSS for `text-align` classes to emit `[CENTER]`/`[RIGHT]` markers — but it is still
regex over HTML, and inventing non-Markdown markers to approximate CSS is the tell that the
target format cannot hold the content.

Markdown cannot express what a typeset book uses: small caps, drop caps, poetry
indentation, epigraph alignment, figure captions, footnote structure. Any conversion is a
lossy step whose losses have to be chased one at a time forever. Carrying the HTML has no
such step, so there is nothing to chase.

### Why not render the epub's XHTML directly

The other obvious plan, and how a from-scratch reader would work. It bypasses
`DocumentModel`, and with it search, the outline, pagination and the page windowing just
built — all of which operate on blocks and are already tested. Rebuilding those against raw
XHTML is most of the application, done twice.

### What the block model buys, unchanged

- **Search** — blocks have text; the sidebar, highlighting and navigation work as they are
- **Outline** — headings are blocks
- **Pagination and page windowing** — a block is a block; a 500-page novel gets the same
  400-block ranges as a large Markdown file
- **Themes and typography** — the reader's font and colours still apply, over the book's
  structural CSS
- **Read-only by construction** — an epub document has no Markdown to edit, so no path
  writes text back over the book. That is the shape of the thing rather than a guard.

## Target architecture

```
  .epub  ──▶  EpubReader.cs                    (host, C#)
                 │  unzip to a per-book cache dir
                 │  container.xml → OPF → manifest + spine (reading order)
                 │  nav.xhtml / toc.ncx → chapter list
                 │  metadata: title, author
                 ▼
              document payload                 (host → page)
                 │  { kind:'epub', css:[...], blocks:[html...], toc:[...], meta:{...} }
                 ▼
              DocumentModel                    (page, JS)
                 │  kind = 'epub'
                 │  blocks[i].raw = an HTML fragment, not Markdown
                 ▼
              existing everything               search · outline · pagination ·
                                                windowing · themes · tabs
```

### What a block is

One top-level child of `<body>` per spine document: a paragraph, heading, figure, list,
table, blockquote. This matches the Markdown model's granularity (one paragraph-ish unit
per block) so pagination breaks in the same places a reader expects, and it keeps
`PageChunks` ranges meaningful.

### Styling

The book's stylesheets are injected once, scoped to the editor, and the block HTML is
rendered underneath them. Class-based bold, italic, alignment, small caps and drop caps
resolve because the browser resolves them — no CSS parsing on our side at all. This is
where both existing converters spend effort they do not need to.

Reader typography (theme font, size, colours, margins) is applied over the top, so a book
still looks like TypoZen rather than like 2003.

## Work, in order, each step verifiable on its own

1. **Books are never written over.** *(done)*
   `.epub` forces Save As, defaulting to a `.md` beside it, and a save that would still land
   on `.epub` is refused. This was a live data-loss bug: `ConfirmOverwriteLoss` re-reads the
   old file through `ReadTextFileDetect`, which for an `.epub` runs the extractor — so it
   compared extracted text against extracted text, found nothing lost, and destroyed the
   book silently.

2. **`DocumentModel.kind`, and an HTML render path.**
   `renderBlockPreview` renders the fragment when the kind is `epub`; `blockText(i)` gives
   the visible text of a block regardless of kind. Pure model work, unit-testable.

3. **The three places that assume Markdown.**
   - outline heading detection (`/^#{1,6}\s/` → `<h1>`..`<h6>` when kind is epub)
   - the search haystack (block *text*, never markup — searching a book must not match
     `class` or `href`)
   - editing entry points refuse on an epub document

4. **`EpubReader.cs`** replacing `EpubExtractor.cs`: unzip to cache, spine in order, split
   each document into top-level blocks, collect CSS, TOC and metadata. The container/OPF
   parsing in the current file is correct and standard — that part is kept.

5. **Images and internal links.** `src` and `href` rewritten to the cache; internal links
   navigate within the book; external links are refused or handed to the shell.

6. **TOC → outline**, so chapter navigation is the book's own structure rather than
   whatever headings happen to be in the text.

7. **Reading position per book**, remembered across sessions. *Done.* Where the reader is
   is reported from scrolling rather than from the jump anchor -- someone who simply reads
   for an hour never sets an anchor -- debounced, and only when the block changes. The host
   keeps it in `book_positions.txt` keyed by path, newest first, capped at 64, and appends
   `|at=<block>` to the load message so the book opens where it was left.
   `book-position-app.mjs` proves it across two real launches of the exe, because surviving
   the process is the entire claim.

## Tests, per step

Written against real books in `C:\Users\chan_\OneDrive\Books`, not synthetic fixtures — the
whole reason the current extractor looks adequate in isolation is that nobody ran it against
*Blindsight* and counted.

- `epub-model-selftest.mjs` — kind, block text, HTML rendering; no DOM, pure logic
- `epub-reader-browser.mjs` — a real book loads; block count, headings, images, no markup in
  the search haystack, outline matches the book's TOC
- `epub-reader-app.mjs` — the same through `TypoZen.exe`: pagination, windowing, search,
  column switching over a real novel
- an assertion that opening a book and saving cannot produce a byte-changed `.epub`

## Known risks

- **Sanitisation.** Book HTML goes into the page. Scripts must be stripped and the epub
  document must not be `contenteditable`.
- **Block granularity.** A chapter that is one enormous `<div>` yields one enormous block,
  which would defeat pagination. Needs a descend-until-reasonable rule, with a real book
  that does this used as the test case.
- **Serialising for export.** `getMarkdownContent` on an epub document has to mean "convert
  for export", which is the one place the JS converter is still the right tool.
- **`PageChunks` sizing.** 400 blocks per range was tuned on a Markdown fixture; a novel's
  blocks are larger and fewer, so the range size wants re-measuring rather than assuming.
