# Decision: Source ↔ Preview, dual-source truth, and large-document performance

> **ARCHIVED (2026-07-30).** Superseded by `README.md`, which is the single source of
> truth for how TypoZen works. Kept for history; no longer maintained. Where this file and
> the README disagree, the README is correct.

**Status:** Accepted (design); **implementation advanced past original Phase 3**  
**Date:** 2026-07-30 · **Updated:** 2026-07-30 (Stage D)  
**Scope:** Preview/WYSIWYG architecture, Source → Preview cost, save/sync correctness  

**Supersession note:** Viewport virtualization and `DocumentModel` are **shipped** (Stages A–D).  
Authoritative thresholds, virt/progressive decision table, and sticky mode-switch contracts live in:

→ **`ENDGAME_DOC_MODEL_VIRTUALIZATION_PLAN.md`**

This document remains the home for **dual-source flush invariants (I1–I7)** and the original rationale. Sections that said “no virtualization yet” or “reject document model for now” are historical; see §5 and §8 for current status.

---

## 1. Context

TypoZen has two editing surfaces:

| Mode | What the user edits | What Save / host sync should use |
|------|---------------------|----------------------------------|
| **Source** | One markdown string (`sourceEditor`) | That string |
| **Preview** | Formatted DOM per line (`.block`) | Markdown for each line |

In Preview, each line historically keeps **two** representations:

1. **Screen** — rendered HTML/DOM (what you see: bold, bullets, …)  
2. **Hidden note** — `data-raw` (markdown with markers, e.g. `**bold**`)

Save and host pull prefer the hidden note (with occasional “guess” rules when screen and note disagree).

### 1.1 Two different problems that look related

| Problem | Nature | Failure mode |
|---------|--------|----------------|
| **Dual-source drift** | Correctness | Edit updates screen, not `data-raw` → Save/sync restores deleted text |
| **Source → Preview on large docs** | Scale / performance | Building thousands of blocks (DOM + raw + render) freezes the UI |

They share machinery (Preview blocks) but need different levers:

- Drift → **invariants and flush rules** (hardening)  
- Freeze → **when and how much dual-source we materialize** (performance)

### 1.2 What we already decided elsewhere

- Large / medium files **open in Source** for Notepad-class open speed (`SOURCE_FIRST_CHARS` / `LARGE_DOC_CHARS`).  
- Progressive **paint** of markdown HTML after blocks exist on **M-band** full mounts (block-count gate only).  
- Host sync/save fail-closed when dirty; history capped by size.  
- **Shipped since:** `DocumentModel` + virtualized Preview for L/XL (see endgame plan).

---

## 2. Decision (summary)

**We keep dual-source for Preview on normal (S/M) documents**, with these rules:

1. **`data-raw` is canonical** in Preview for mounted blocks. The DOM is a *projection* of raw, not a peer authority.  
2. **Every edit path must update `data-raw`** (or leave the block only after a flush). Length-based “guessing” is not architecture.  
3. **Large documents are Source-primary on open.** Source → Preview rebuilds from one markdown string into `DocumentModel`, then either progressive full mount (M) or **virtualized** mount (L/XL).  
4. **Document model:** shipped as `DocumentModel` (block raws + virt height map); not a ProseMirror-class rewrite.  
5. **Viewport virtualization:** shipped for L/XL; ordinary notes stay full WYSIWYG.

---

## 3. Goals and non-goals

### Goals

- **Correctness:** Save / tab sync / close never resurrect deleted text because of stale `data-raw`.  
- **Performance:** Source → Preview on large docs does not hang the app; first paint is usable.  
- **Hardening:** Fewer heuristic branches; explicit flushes before host-visible serialize.  
- **Continuity:** Small/medium markdown docs keep full WYSIWYG Preview editing.

### Non-goals (this decision)

- Preserve non-UTF-8 on save (separate: warn + UTF-8).  
- Perfect live Preview editing of multi‑MB files at 60 fps.  
- Pixel-perfect parity with CommonMark edge cases during progressive paint.  
- Shared dual-source with Source mode (Source stays single-string).

---

## 4. Architecture

### 4.1 Modes and truth

```
┌─────────────────────────────────────────────────────────────┐
│  SOURCE MODE                                                │
│  Truth: sourceEditor.value (one string)                     │
│  Save / sync: that string                                   │
│  No data-raw dual store                                     │
└─────────────────────────────────────────────────────────────┘
                          │
          toggle / load   │  split on lines → blocks
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  PREVIEW MODE (normal size)                                 │
│  Canonical: data-raw per .block                             │
│  Projection: DOM via renderBlockPreview(raw)                │
│  Edit: update DOM → must update data-raw (same turn)        │
│  Save / sync: getMarkdownContent via getBlockRaw / flush    │
└─────────────────────────────────────────────────────────────┘
                          │
          large docs      │  same rebuild, progressive
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  PREVIEW MODE (M-band)                                      │
│  Truth: DocumentModel + data-raw on full mount              │
│  Progressive paint: rAF batches of renderBlockPreview       │
│  Optional windowed create when block count is high          │
└─────────────────────────────────────────────────────────────┘
                          │
          L/XL            │  shouldVirtualize()
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  PREVIEW MODE (virtualized)                                 │
│  Truth: DocumentModel.blocks (full doc)                     │
│  DOM: viewport±overscan only + height spacers               │
│  Find / outline / format: model indices, not DOM ordinals   │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Size bands (operational definitions)

**Current code thresholds** (authoritative in `TypoZen_Template.html` / endgame plan):

| Band | Trigger (approx) | Open default | Preview strategy |
|------|------------------|--------------|------------------|
| **S** | &lt; ~800 blocks | Either mode | Full dual-source; **immediate** paint |
| **M** | ~800–1999 blocks (and not virt by chars) | Source-first if ≥ ~16 KB chars | Full dual-source; **progressive** paint; windowed create ≥ ~1500 blocks |
| **L/XL** | ≥ ~2000 blocks **or** ≥ ~120 KB | Source-first when large enough | **Virtualized** Preview (viewport±overscan); model owns off-screen text |

`LARGE_DOC_CHARS` / `SOURCE_FIRST_CHARS` (~16 KB) control **Source-first open only** — they do **not** force progressive paint.

### 4.3 Canonical rules (invariants)

These are **must-hold** properties. Violations are bugs, not “edge cases.”

**I1 — Mode exclusivity**  
In Source mode, the textarea string is the only authority. Preview DOM/`data-raw` may be empty or stale until the next Preview rebuild.

**I2 — Raw canonical in Preview**  
After any completed edit in Preview, each affected block’s `data-raw` equals the markdown that Save would write for that line (via the same helper as host sync).

**I3 — Flush before leave**  
Before: host `getDocumentState*` / Save pull, tab switch, Source toggle, or blur of the active block — the **active** block is flushed DOM → `data-raw` (unless already Source mode).

**I4 — No length-guess as authority**  
Do not decide truth by “screen longer than raw ⇒ trust screen” or “screen shorter ⇒ trust raw.”  
If both sides exist and disagree after flush, prefer **re-serialize from the edit path’s known post-state** (or re-read via `getBlockRaw` after flush), not a length heuristic.

**I5 — Host serialize path**  
Host-facing serialize uses `getBlockRaw` (image-count / focus-aware) after flush of the active block—not bare `getAttribute('data-raw')` alone.

**I6 — Large Source → Preview**  
Rebuild from one markdown string: for each line, set `data-raw` to that line **first**, then paint. Never leave long-lived blocks whose raw is from a previous document (bump paint generation on every full load).

**I7 — Progressive paint races**  
A newer load/generation cancels older paint. Editing a block mid-paint must either:  
- update that block’s raw and skip later paint for that index, or  
- defer user edits until the generation completes (acceptable for XL).

### 4.4 Save / sync contract

```
User edit (Preview)
    → update DOM
    → update data-raw (same edit transaction)
    → invalidate _contentCache

Host Save / Sync / Close
    → flush active block
    → getMarkdownContent(false) using getBlockRaw per block
    → tab.Content = result
    → write file / keep buffer
```

Source mode skips block flush; uses `sourceEditor.value` only.

---

## 5. Options considered

| Option | Verdict | Why |
|--------|---------|-----|
| **A. Dual-source, raw canonical, drop guessing** | **Accept** (core) | Hardens without rewrite |
| **B. Source-primary large docs + progressive Preview rebuild** | **Accept** (M-band) | Matches open path; freeze win for mid-size full DOM |
| **C. Full viewport virtualization** | **Accept (shipped)** | L/XL Preview editing; Stage C/D complete |
| **D. Lightweight document model (`DocumentModel`)** | **Accept (shipped)** | Block raws + virt heights; not ProseMirror |
| **E. Ban Preview above N** | **Reject as default** | Virt + progressive enough |
| Keep dual peer + length heuristics | **Reject** | Proven delete/save failure mode |

---

## 6. Guessing rule (explicit follow-up)

**Today (historical):** if focused screen text is longer than `data-raw`, trust the screen (caught missed typing). There was no symmetric rule for shorter screen text (deletions) → silent undelete on save.

**Decision:**

1. **Short term:** Keep any remaining “longer screen” fallback only as a **safety net** until edit-path coverage is complete and tests pass.  
2. **Target:** Remove guessing entirely once:  
   - all edit paths update `data-raw`, and  
   - flush-before-serialize is universal, and  
   - regression tests cover delete / type / image-delete / multi-block.  
3. Optional **debug assert** (dev/e2e): after flush, `data-raw` vs `getBlockRaw` mismatch → log/fail test, not silent repair.

---

## 7. Source → Preview (implementation direction)

When implementing (separate PR/pass):

1. **Input:** single markdown string (Source value or host buffer).  
2. **Parse:** line/block split (existing code/table fence grouping).  
3. **Create:** DocumentFragment of `.block` with `data-raw` set; light placeholder text OK.  
4. **Append once** (or windowed append if create itself freezes).  
5. **Paint:** `requestAnimationFrame` batches of `renderBlockPreview`.  
6. **History:** seed from the **string**, not a second DOM walk mid-paint.  
7. **UI:** for L/XL, status or outline “Rendering preview…” until generation completes; optional edit lock for XL only.  
8. **Toggle back to Source:** serialize with I3–I5, then single string in textarea (no dual store).

### 7.1 Performance budget (aspirational)

| Event | Target feel |
|-------|-------------|
| Open large file | Instant Source (already) |
| Source → Preview (M) | Interactive first content; progressive paint may trail |
| Source → Preview (L/XL) | No multi-second hard freeze; virt viewport mount |
| Preview → Source | Instant string assign; sticky line preserved |
| Mode toggle sticky | Same hard line in status **and** on screen |

Budgets are goals for measurement, not hard CI gates until harnessed.

---

## 8. Phased plan

### Phase 0 — Done / baseline (reference)

- Large open → Source / plain  
- Progressive paint for lists after load  
- Host save uses `getBlockRaw`-oriented serialize  
- Fail-closed dirty leave; history byte/step caps  

### Phase 1 — Dual-source hardening (can ship without big perf work)

- [x] Shared `flushActiveBlockToRaw` / `serializeBlockDomToRaw`  
- [x] Flush before mode → Source and host `getDocumentState*` / `prepareDocumentStateForHost`  
- [x] Input / compositionend / focusout keep `data-raw` current  
- [x] Remove "screen longer than raw" length heuristic; focused → DOM, unfocused → raw  
- [x] Self-test markers: `tests/dual-source-selftest.mjs`  

### Phase 2 — Source → Preview performance (this decision’s perf track)

- [x] `splitMarkdownToBlockRaws` string phase (fences/tables) before DOM  
- [x] Progressive paint (rAF batches); skip `data-tz-dirty` blocks  
- [x] Windowed create when ≥1500 blocks (`PROGRESSIVE_CREATE_BATCH_BLOCKS`)  
- [x] Progressive gated by **block count only** (not `LARGE_DOC_CHARS`)  
- [ ] Optional: measure freeze time on ~600 KB fixtures in harness  

### Phase 3 — Document model + virtualization (shipped; see endgame plan)

- [x] `DocumentModel` as canonical block list + `toMarkdown` for save/sync  
- [x] Virtualized Preview for L/XL (`VIRT_MIN_BLOCKS` / `VIRT_MIN_CHARS`)  
- [x] Per-block height map + outline/find/format under virt  
- [x] Sticky Source ↔ Preview document line (status + viewport)  
- [ ] Optional: manual large-file scroll dogfood in the real app  

---

## 9. Test plan (minimum)

| # | Scenario | Expect |
|---|----------|--------|
| T1 | Preview: type in line, Save, reopen | Typed text on disk |
| T2 | Preview: delete word mid-line, Save, reopen | Deletion persists |
| T3 | Preview: delete image, Save, reopen | Image not restored |
| T4 | Preview: multi-block delete, Save | Matches screen |
| T5 | Source edit, switch Preview, switch Source | Content stable |
| T6 | Large Source → Preview | No hang; bullets render after paint |
| T7 | Large Preview → Source | Full string, no missing lines |
| T8 | Dirty Preview, tab switch, sync fails | Stay on tab / no silent drop |
| T9 | Host pull during paint generation | Flush + consistent generation |

---

## 10. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Missed edit path still skips `data-raw` | Shared commit helper; tests T1–T4; temporary guess only for longer-screen typing |
| Progressive paint + user edit race | Generation id; skip paint on dirty block; XL edit lock |
| Windowed create breaks code/table multi-line blocks | Keep fence grouping in the string phase before create |
| Users expect instant full Preview on 2 MB md | Status “Rendering…”; Source remains fast path |
| Over-serializing with `getBlockRaw` on every keystroke | Keep debounced stats; flush only on host/save/mode leave |

---

## 11. Consequences

**We will:**

- Document and enforce raw-canonical Preview on mounted dual-source blocks.  
- Keep progressive paint for **M-band** full mounts; virt for **L/XL**.  
- Treat large-file Source as first-class; Preview rebuilds from one string into the model.  
- Use model indices for multi-select/format under virt.

**We will not:**

- Claim dual-source is gone on S/M full mounts.  
- Gate progressive paint on Source-first 16 KB chars.  
- Rely on length heuristics as the long-term correctness model.

---

## 12. Open questions

| # | Question | Status |
|---|----------|--------|
| 1 | Progressive create vs paint floors | **Resolved:** 800 paint / 1500 windowed create / 2000 virt (block-based) |
| 2 | XL Preview read-only until paint | **N/A for virt** (viewport mount); optional product call only if progressive XL returns |
| 3 | Outline/find during paint | **Resolved for virt:** model-based outline + find; progressive paint still uses generation id |

Remaining optional: real-app large scroll dogfood; nested lists (`NESTED_LISTS_PLAN.md`).

---

## 13. Approval

| Role | Name | Date |
|------|------|------|
| Author | TypoZen design discussion (session) | 2026-07-30 |
| Status | **Accepted for implementation sequencing** | 2026-07-30 |

**Next implementation step when ready:** Phase 1 (flush + kill guessing under tests), then Phase 2 (Source → Preview progressive rebuild). Do not start Phase 3 unless Phase 2 fails measured budgets.
