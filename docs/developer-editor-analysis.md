# A developer editor for TypoZen — options analysis

**Status: analysis only.** Nothing here is built or started. The purpose is to make the
choice legible, not to pre-empt it.

The request was: syntax highlighting for XAML / JSON / C# and similar, possibly some help
with alignment, and a decision on whether that needs a new mode or whether Preview can be
adapted.

The short version: **Preview can be adapted for code *fences* almost immediately, and
cannot be adapted for code *files* at all.** Those are two different features that sound
like one, and most of the cost sits in a place people do not expect — the tokenisers, not
the colouring.

---

## 1. Where the app stands today

TypoZen has three surfaces, and which one a document gets is decided by its type:

| Surface | What it is | Gets | Styling of content |
|---|---|---|---|
| **Source** | a `<textarea>` | `.txt` `.log` `.csv` | **none possible** |
| **Preview** | `contenteditable` block model | `.md` | full, but constrained (§2) |
| **Reader** | read-only, carries publisher HTML | `.epub` | full, unconstrained |

A `.cs` / `.xaml` / `.json` file today lands on the Source path — the Notepad-class route,
documented at `js/modules/05-model.js:27`. That matters more than it looks: a `<textarea>`
holds a single text node and **cannot carry per-token styling under any circumstances**.
No amount of CSS reaches inside it. Any highlighting for whole code files therefore
requires replacing that surface, not decorating it.

## 2. The two constraints that shape every option

**(a) The `data-raw` invariant.** A `.block` in Preview is a projection of one model row,
and its content round-trips into `data-raw` on every edit. Anything injected as a real
element becomes part of the user's file the moment something serialises. This is not
theoretical — it is why search matches and bookmark highlights are painted with the **CSS
Custom Highlight API** instead of `<mark>`, and why the bookmark gutter ribbon is a
`::before` pseudo-element hit-tested by coordinate.

So in Preview, syntax colouring **cannot** wrap tokens in `<span>`s. It has to paint them.

**(b) Source is a textarea.** See above. Zero styling.

## 3. What the Highlight API can and cannot do

This decides more than anything else in the analysis, so it is worth being exact.
`::highlight()` is **not a box** — it paints over existing text runs. The properties it
honours are:

- `color`
- `background-color`
- `text-decoration` and its longhands
- `text-shadow`
- `-webkit-text-stroke`

It ignores `font-weight`, `font-style`, `padding`, `border`, `border-radius`, `margin`.

**Consequence: colour-only syntax highlighting.** No bold keywords, no italic comments,
anywhere the Highlight API is the mechanism. That is a real aesthetic ceiling and it should
be seen before anything is built, not after.

The upside is proven and large: this app already paints **2,135 simultaneous ranges** for a
search of "scroll" with no DOM nodes created and no reflow. The painter is not going to be
the bottleneck.

## 4. The options

### Option 1 — Code fences in Preview, via the Highlight API

**Scope:** ` ```cs ` blocks inside Markdown documents. Nothing else.

No new mode, no new document kind, no routing changes. Tokenise the fence's `data-raw`, map
token offsets onto DOM ranges, register one `Highlight` per token class.

- **Cost:** moderate — a tokeniser per language plus offset→range mapping.
- **Ceiling:** colour only (§3). Does nothing for `.cs` files.
- **Risk:** low. It is exactly the pattern the codebase already uses twice.

### ~~Option 2 — A read-only `code` document kind~~ — **ruled out**

Rejected by the owner: *"I don't see any point in reading code if I can't modify it. No
value."* A viewer is off the table, which removes the cheapest route to full styling and
makes the remaining question purely about **editing surfaces**.

That rejection also invalidates a claim made earlier in this document. The colour-only
ceiling in §3 is a property of **the Highlight API**, not of Preview — and once editing is
the requirement, there is a way to have both. See Option 2b.

### Option 2b — A `code` document kind in Preview, one block per line

**Scope:** whole `.cs` / `.xaml` / `.json` files, **editable**, using the existing block
model with an identity parser: a block *is* a line, `data-raw` *is* that line verbatim, and
nothing is parsed as Markdown.

The `data-raw` invariant (§2a) is survivable here, and this is the key insight: the danger
was ever only that Markdown **serialisation reads `innerHTML`**. A code kind whose edit path
derives `data-raw` from **`textContent`** cannot be corrupted by markup, because
`textContent` strips it. So tokens *can* be real `<span>`s — which escapes the §3 ceiling
and gets bold keywords and italic comments back.

What comes free, because it is all block-based already:

- **virtualisation** and the per-block height map (a 20,000-line file is 20,000 blocks; the
  app already virtualises past ~2,000)
- **search**, with its sidebar, gutter line numbers and highlight painting
- **bookmarks and annotations** — marks anchor to blocks and would simply work
- **the outline**, which for code could list classes and methods rather than headings
- all 26 **themes**, spacing controls and the reading chrome

- **Cost:** moderate. New kind, an identity parser/serialiser, and suppressing every
  Markdown behaviour (list continuation, emphasis, heading detection) for this kind.
- **Risk:** the known one — typing inside `<span>`s in `contenteditable`. Browsers split
  spans and carry formatting onto the next character. The standard answer is to re-tokenise
  and re-render **the edited line only** on each keystroke, which is cheap for one line.
- **Cost it inherits:** a code file stops being Notepad-class. This codebase deliberately
  routes `.txt`/`.log`/`.csv` to a textarea for that reason.

### Option 4 — Alignment aids only, no highlighting

Auto-indent on newline, bracket/tag matching, tab-to-indent and shift-tab, indent-aware
paste. All of it lives in the Source keyboard path and touches no rendering.

- **Cost:** low.
- **Delivers:** the "help aligning" half of the request, independently of every decision above.

## 5. Performance

Not where people expect.

- **The painter is free.** No DOM nodes, no reflow, already proven at 2,135 ranges.
- **The tokeniser is the risk.** A whole-document re-lex on every keystroke would wreck a
  typing path that has been tuned hard — the app virtualises Preview at ~2000 blocks or
  ~120 KB precisely because full-document work at that size is visible.
- **The mitigation is standard and non-negotiable:** line-based lexing with a cached start
  state per line, re-lexing only from the edited line until the state converges. Anything
  else will feel fine on a 200-line file and unusable on a 5,000-line one.

## 6. Where the effort actually goes

Not the colours. **The tokenisers**, and they are not equal:

| Language | Difficulty | Note |
|---|---|---|
| **JSON** | trivial | tiny grammar, no ambiguity |
| **XAML / XML** | easy | attributes, entities, CDATA |
| **C-like fallback** | easy | generic keywords, strings, comments — covers a lot at low cost |
| **C#** | **hard** | verbatim strings, interpolated strings with nested braces and nested quotes, raw string literals, contextual keywords |

C# accurately is a real project on its own. A staged answer would ship JSON + XAML + a
generic C-like fallback and let C# be "good enough" until it needs to be right.

**No external libraries.** The app is dependency-free by design. Prism or highlight.js
would mean vendoring a bundle into the repo — a decision worth taking deliberately rather
than by accident, and one that cuts against how everything else here is built.

## 7. A staged path, if one is wanted

1. **Option 1** — fences. Smallest possible surface, proves the tokeniser and the paint
   pipeline together, and is useful on its own for anyone writing technical Markdown.
2. **Option 4** — alignment aids. Independent, cheap, immediately felt.
3. **Option 2 or 3** — decided by §8.

Stages 1 and 2 are worth doing on their own merits even if stage 3 never happens, which is
the main argument for this ordering.

## 8. The question that actually decides it

Read-only is out, so the choice is between **two editable surfaces**:

| | **2b — code kind in Preview** | **3a — overlay on Source** |
|---|---|---|
| Editable | yes | yes |
| Bold / italic tokens | yes (spans, via textContent serialisation) | yes (real DOM paint layer) |
| Bookmarks, annotations, outline, page mode | **free — all block-based** | none; Source has no blocks |
| Search | free, incl. sidebar gutter | works, via the existing source find path |
| Very large files | virtualised, ~20k blocks for 20k lines | **native textarea, Notepad-class** |
| IME, undo, accessibility | inherits `contenteditable`'s known problems | **free from the textarea** |
| New surface to maintain | no — reuses the block model | yes |
| Main risk | typing inside spans | keeping two layers metrically identical |

**The decider is not syntax highlighting — both do it.** It is:

> **Should a code file behave like a TypoZen document, or like a code window that happens to
> live in TypoZen?**

- **Like a TypoZen document** — bookmark a function, annotate a line, outline the methods,
  read it in Pages → **2b**. Everything in the left column is already built; the work is the
  identity parser and the lexers.
- **Like a code window** — open a 40,000-line generated XAML file and have it stay instant,
  with the OS text stack intact → **3a**.

Worth noting what is *not* in question: TypoZen already has a virtualised block model, a
theme system with 26 palettes, a per-block height map, and a proven zero-DOM highlight
mechanism. The infrastructure a code editor needs is mostly here. The missing pieces are
lexers and one surface decision.
