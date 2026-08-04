# Plan: End-game document model + virtualized Preview

> **ARCHIVED (2026-07-30).** Superseded by `README.md`, which is the single source of
> truth for how TypoZen works. Kept for history; no longer maintained. Where this file and
> the README disagree, the README is correct.

**Status:** **Stage D complete** (code). Manual large-file dogfood optional.  
**Goal:** Single source of truth + viewport-only DOM for large docs  
**Testing posture:** Full self-test suite on every build (`tests/run-tests.ps1` / `Build_TypoZen.ps1`)

Related:

- `SOURCE_PREVIEW_DUAL_SOURCE_DECISION.md` — dual-source invariants; size bands superseded by thresholds below  
- `README.md` — product overview + architecture summary  

---

## Testing posture (authoritative)

| Phase | Testing |
|-------|---------|
| **A → B → C** | Done (smoke + dual-source / model selftests) |
| **After C** | Full regression suite on build; targeted virt + format fuzz tests |
| **Stage D** | Threshold / height / find / format-index / sticky mode-switch e2e selftests; optional real-app large scroll dogfood |

Key Stage D tests (non-exhaustive):

| Test | Covers |
|------|--------|
| `tests/virt-thresholds-selftest.mjs` | Threshold split; progressive M-band only; height map |
| `tests/virt-invariants.mjs` | Property map over full large doc; insert return; modelIndex bounds |
| `tests/find-virt-selftest.mjs` | Model haystack find under virt |
| `tests/virt-format-indices-selftest.mjs` | Multi-select/format uses model indices |
| `tests/mode-switch-line-selftest.mjs` | Sticky line helpers + poison capture |
| `tests/mode-switch-sticky-e2e.mjs` | Source↔Preview Ln N status **and** on-screen visibility |
| `tests/dual-source-selftest.mjs` | DocumentModel + flush contracts |

---

## 1. End state

```
DocumentModel (canonical)
  blocks: [{ id, raw }]
  toMarkdown() → Save / Source / host sync
  blockHeights[] → virt scroll mapping
        │
        ├─► Source: textarea bound to serialize / parse back into model
        └─► Preview by size band:
              S  full mount, immediate paint
              M  full mount, progressive paint (block count only)
              L/XL virtualized: viewport±overscan .block DOM
```

**Invariants**

1. Model is the only authority for document text on save.  
2. Save / sync never treat full DOM as truth without flush.  
3. Large-doc Preview DOM is O(window), not O(document).  
4. Off-screen text lives in the model until scrolled into view.  
5. **Ordinary notes are not virtualized** (see thresholds).  
6. Progressive paint is **M-band only** — never gated on Source-first 16 KB chars.  
7. Format multi-select uses **model indices**, not mounted DOM ordinals.  
8. Source ↔ Preview sticky line: same document hard line in status **and** viewport.

---

## 2. Stages

| Stage | Status |
|-------|--------|
| **A** DocumentModel + dual-write | **Done** |
| **B** Model owns Save | **Done** |
| **C** Virtualized Preview MVP | **Done** (viewport + spacers + scroll rebind) |
| **D** Cleanup + polish | **Done** (code); dogfood optional |

### Stage D checklist

| Item | Status |
|------|--------|
| Split `SOURCE_FIRST_CHARS` vs `VIRT_MIN_*` (no dual-use of 16KB) | **Done** |
| Raise virt floor (~120KB / 2000 blocks) so normal notes stay full WYSIWYG | **Done** |
| Per-block height estimates + measure-on-mount (prefix-sum spacers) | **Done** |
| Progressive paint uses its own block threshold (not virt) | **Done** |
| Progressive cleanup (no `LARGE_DOC_CHARS` gate; M-band only; virt first) | **Done** |
| Outline jump uses prefix heights + geometric snap under virt | **Done** |
| Find / replace off-screen under virt | **Done** (model haystack + scroll/mount + highlight) |
| Toolbar / caret multi-select under virt | **Done** (model indices; last-good from model) |
| Sticky Source ↔ Preview line (status + visible) | **Done** (e2e selftest) |
| Undo/caret under virt uses model indices + ensure visible | **Done** |
| Image block height estimate (pre-measure) | **Done** (~220px per `![]()`) |
| `insertBlockAfterIndex` returns actual index; `modelIndexOfEl` bounds-checks | **Done** |
| Property virt invariants harness (`virt-invariants.mjs`) | **Done** |
| Virt scroll reverse-jump (no global height backfill; anchor pin) | **Done** |
| Dogfood fixture `tests/large-scroll-4000.md` (numbered lines) | **Done** |
| Deep large-file scroll dogfood | **Optional** (manual; use large-scroll-4000.md) |

---

## 3. Thresholds (code)

Live constants in `TypoZen_Template.html`:

| Constant | Default | Role |
|----------|---------|------|
| `SOURCE_FIRST_CHARS` | 16 000 | Open in Source textarea first (Notepad path) |
| `LARGE_DOC_CHARS` | alias → Source-first | Prefs / stats / Source-first only — **not** progressive |
| `VIRT_MIN_CHARS` | 120 000 | Virt when markdown ≥ ~120 KB |
| `VIRT_MIN_BLOCKS` | 2 000 | Virt when block count ≥ 2 000 |
| `PROGRESSIVE_PAINT_BLOCKS` | 800 | M-band: full mount, deferred HTML paint |
| `PROGRESSIVE_CREATE_BATCH_BLOCKS` | 1 500 | M-band: rAF batch-create (still &lt; virt floor) |
| `overscan` | 40 | Extra blocks above/below viewport under virt |

### Decision table (Preview load)

| Condition | Path |
|-----------|------|
| blocks ≥ 2000 **or** chars ≥ 120 KB | **Virt** (viewport mount; progressive never runs) |
| 800 ≤ blocks &lt; 1500 | **Progressive** paint (full DOM) |
| 1500 ≤ blocks &lt; 2000 (and not virt by chars) | **Progressive + windowed create** |
| blocks &lt; 800 | **Immediate** full paint |
| chars ≥ 16 KB alone | **Does not** force progressive (Source-first only on open) |

**Design intent:** S immediate; M progressive by **block count only**; L/XL virt. Do not re-lower virt to 16 KB without a product decision.

---

## 4. Explicit non-goals (still)

- Perfect sub-pixel scroll with every image load  
- Nested-list AST  
- Collaborative editing  
- ProseMirror rewrite  

---

## 5. Success metrics

| Metric | Target | Status |
|--------|--------|--------|
| Delete then save | Deletion on disk | Dual-source hardening |
| Ordinary note (≪ 120 KB / &lt; 2000 blocks) | Full WYSIWYG, **not** virt | Thresholds + tests |
| 10k+ line Preview scroll | No multi-second freeze; DOM ≪ line count | Virt |
| Source ↔ Preview | Content stable; sticky line N | e2e |
| Fence/table scroll | Less drift than fixed 28px rows | Height map |
| Multi-select format under virt | Correct model rows; no wipe | format-index tests |
| Regression suite | Green on every build | `run-tests.ps1` |

---

## 6. Decision log

| Question | Answer |
|----------|--------|
| End-game? | Model + virtualized Preview for large docs |
| Race to C? | Done |
| Stage D code? | Done |
| Progressive vs virt? | Progressive = M only; virt first for L/XL |
| Next | Optional large-file dogfood; product features (nested lists, etc.) |

**Go:** maintain thresholds; do not re-couple progressive to `LARGE_DOC_CHARS` / 16 KB.
