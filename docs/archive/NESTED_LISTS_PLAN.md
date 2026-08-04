# Nested lists — implementation plan

> **ARCHIVED — COMPLETE (2026-07-30).**
> This plan is delivered. Current list behaviour is documented in `README.md`, which is the
> single source of truth; this file is kept for history and is no longer maintained.
>
> **Verified against the code and test suite:**
>
> | Definition of done | Evidence |
> |---|---|
> | Nested bullets/tasks/ordered via Tab; Shift+Tab outdents | ✅ `Tab indent bullet`, `Shift+Tab outdent`, `double indent`, `Tab indented first/second bullet` |
> | Backspace: outdent → strip marker → merge | ✅ `caret at start of nested list`, `outdent to level 0`, `indent level 0` |
> | Toolbar doesn't destroy indent | ✅ `indent level is preserved`, `italic on "  - nested"` |
> | Phase 1 pure helpers | ✅ all five present: `parseListLine`, `formatListLine`, `getListIndentLevel`, `indentListLine`, `isListLine` (`indentListLine bullet +1`, `indentListLine ol -1`) |
> | Render indent via margin-left, not nested DOM | ✅ as specified in Phase 2a |
> | Multi-line selection indent | ✅ `applyListIndentToSelection in template` |
>
> **Implemented but without direct automated coverage** — confirm by hand if it matters:
> Enter continuing a nested item at the same level; Source ↔ Preview preserving leading
> spaces; undo collapsing an indent to one step; `Tab` on a non-list line being a safe no-op.

**Original status:** Future product work (not Stage D). Indent-aware list format must keep working under virt via **model indices**, not mounted DOM ordinals.

## Goal

**Tab / Shift+Tab** on list lines changes Markdown indent (2 spaces per level), preview shows nesting, Source round-trips. Undo is one step per indent action.

## Non-goals (this pass)

- Nested HTML (`<ul><ul>…`) as the source of truth
- Real nested DOM editing like Word
- Renumbering entire ordered trees
- Mixed indent styles (tabs vs spaces) — **spaces only, 2 per level**
- Indenting non-list lines (paragraphs, headings, code, tables)
- Images, multi-tabs, paste host work

---

## Why this area is fragile

Architecture today: **one block ≈ one Markdown line**, `data-raw` is truth, preview is disposable HTML.

| Surface | Today | Nesting impact |
|---------|--------|----------------|
| **Render** | `^[-*+]`, `^\d+\.`, checklist — **no leading spaces** | Indented `  - x` falls through to plain `<p>` or wrong type |
| **Enter** | Continues `1.` / `-` / task **without indent** | Nested item → Enter drops back to level 0 |
| **Backspace strip** | Headings / `>` / bullets only; **no `1.`**, **no indent** | Nested/numbered behave wrong at col 0 |
| **Toolbar list/ol/checklist** | `stripBlockPrefix` + rewrite — **drops indent** | Format can flatten nesting |
| **blockHtmlToMarkdown** | DOM → MD | Must not invent fake nesting from `<ul>` structure |
| **contenteditable** | Whole editor is one `contenteditable`; blocks are divs | Tab may move focus out of editor if not `preventDefault` |

So nesting is **not** a one-key handler. It’s **indent in `data-raw` + every list path that assumes “prefix at column 0”.**

---

## Strategy

1. **Treat list identity as pure string rules** (indent + marker + body).
2. **Patch all list touchpoints to use those rules** before shipping Tab.
3. **Extract a small in-file “list module”** only if helpers grow past ~3 call sites.
4. **Full rebuild** of list behavior only if patching still corrupts Enter/Backspace/format after the pure layer exists.

**Path:** pure helpers → harden render/Enter/Backspace/format → then Tab.

---

## Phase 0 — Baseline (no code change)

Manual checklist on **current** app before/while shipping:

1. `- a` Enter → next `- `
2. `1. a` Enter → `2. `
3. `- [ ] a` Enter → next task
4. Backspace at start of `- item` → strip then merge
5. Backspace at start of `1. item` → document actual behavior
6. Toolbar bullet / ordered / checklist toggle
7. Source ↔ Preview on a 5-line list

---

## Phase 1 — Pure list helpers

| Helper | Contract |
|--------|----------|
| `parseListLine(raw)` | `{ indent, marker, kind: 'ul'\|'ol'\|'task'\|null, checked?, body, raw }` or null |
| `formatListLine(...)` | Rebuild one MD line |
| `getListIndentLevel(raw)` | `floor(leadingSpaces / 2)`, tabs → 2 spaces |
| `indentListLine(raw, delta)` | ±1 level, clamp **0..6**; no-op if not list |
| `isListLine(raw)` | boolean |

**Rules:** spaces only (tabs → spaces when parsing); max depth 6; never touch code/table/heading lines.

---

## Phase 2 — Indent-aware list paths

### 2a — Render
Optional leading spaces; visual nest via `padding-left` / `margin-left` from level (not nested DOM lists).

### 2b — Enter continue
Copy indent + kind; OL number = prev + 1 at that indent only.

### 2c — Backspace at column 0
1. List and indent > 0 → outdent one level  
2. Else list with marker → strip marker (include `N.` and task)  
3. Else → merge with previous block  

### 2d — Toolbar list / ol / checklist
Preserve indent when already a list; un-list clears indent to 0.

### 2e — `stripBlockPrefix`
Strip optional indent + marker for list cases.

---

## Phase 3 — Tab / Shift+Tab

| Key | When | Action |
|-----|------|--------|
| **Tab** | List line(s) in WYSIWYG | indent +1, one undo step |
| **Shift+Tab** | Same | indent -1 |
| **Tab** | Non-list | preventDefault + no-op inside editor |
| **Source** | Selected list lines | same 2-space rule |

---

## Phase 4 — Hardening if needed

Collapse into `ListEngine` API only if regressions persist after 1–3.

---

## Definition of done

- [ ] Nested bullets/tasks/ordered via Tab; Shift+Tab outdents
- [ ] Enter on nested item continues at same level
- [ ] Backspace: outdent → strip marker (incl. ordered) → merge
- [ ] Source ↔ Preview preserves leading spaces
- [ ] Toolbar doesn’t destroy indent unexpectedly (un-list clears indent)
- [ ] Undo undoes last indent/outdent as one step
- [ ] Non-list Tab doesn’t trash the document

---

## Implementation sequence

| Step | Work | Ship gate |
|------|------|-----------|
| 0 | Baseline manual list tests | Know current breaks |
| 1 | Pure helpers | String cases pass |
| 2a | Render indent-aware + CSS | Source nested line looks nested |
| 2b | Enter preserves indent | Nested continue works |
| 2c | Backspace outdent → strip → merge | Ordered strip included |
| 2d–2e | Toolbar + stripBlockPrefix | Format safe |
| 3 | Tab / Shift+Tab + Source | User-visible nested lists |
| 4 | Only if regressions | ListEngine consolidation |

**Tab alone is not the project. Making the list line model correct is the project; Tab is the last 10%.**
