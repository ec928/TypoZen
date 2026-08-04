# TypoZen Improvement Plan — Ordered PRs

> **ARCHIVED (2026-07-30).** Superseded by `README.md`, which is the single source of
> truth for how TypoZen works. Kept for history; no longer maintained. Where this file and
> the README disagree, the README is correct.

**Product:** TypoZen (WPF + WebView2 Markdown / WYSIWYG editor)  
**Location:** `TypoZen/`  
**Based on:** Code review (2026-07-28) + session work (undo, paste, headings, selection mapping)  
**Goal:** Correctness and maintainability first, then Typora-class features — so each change is reviewable and less likely to re-break prior work.

**Note (2026-07-30):** Document model + virtualized Preview + progressive M-band cleanup are tracked as **complete** in  
`docs/ENDGAME_DOC_MODEL_VIRTUALIZATION_PLAN.md`. This PR plan remains useful for older correctness packages and future features (e.g. nested lists). Prefer the endgame plan for size-band / virt / sticky mode-switch contracts.

---

## What is a PR?

**PR = Pull Request** (also called a **merge request** on GitLab).

In plain terms:

1. You do work on a **branch** (a named line of history), not directly on `main`.
2. You open a **PR** = a packaged proposal: “here are my commits; please review and merge them into the main branch.”
3. Reviewers (or you, later) check the diff, tests, and behavior, then **merge**.

Even if you work alone, treating each chunk of work as a PR-sized unit is useful:

| Benefit | Why |
|--------|-----|
| Small diffs | Easier to review and revert |
| Clear intent | One theme per PR (“fix paste undo,” not “everything”) |
| Safe rollback | Bad PR can be reverted without undoing unrelated work |
| Testable | Each PR can have its own pass criteria |

You do **not** need GitHub for the idea — a local branch + merge is the same workflow. Hosted PRs just add UI and discussion.

**Suggested PR size for TypoZen:** one concern, ideally &lt; ~400 lines of meaningful change, with a short “how to verify” checklist.

---

## Principles for this plan

1. **Correctness before features** — bad serialize/undo will poison every later feature.
2. **Tests with production logic** — stop reimplementing helpers only in `tests/`.
3. **One host path for edits** — menu, toolbar, and keyboard must hit the same JS handlers.
4. **Document intentional limits** — nested lists, math, etc. are product choices until scheduled.

---

## Dependency graph (ordered)

```text
PR1  Extract pure MD helpers + wire tests
  │
  ├─► PR2  Serialize fidelity + round-trip corpus
  │     │
  │     ├─► PR3  History: caret/scroll + safer restore
  │     │
  │     └─► PR4  Paste / clipboard single pipeline
  │
  ├─► PR5  Find/replace index alignment
  │
  ├─► PR6  Host protocol + prefs JSON + UTF-8
  │
  └─► PR7  WebView2 security hardening

PR8  Block engine polish (lists backspace, arrows, mode caret)
  │  (can start after PR2; best after PR3–4)
  │
PR9  README limits + CI runs tests
  │  (can parallel after PR1)
  │
PR10 Feature: nested lists OR image paste  (pick one first)
PR11 Feature: the other of nested lists / images
PR12 Optional: module split (history/find) + larger refactors
```

**Merge order (recommended):**  
`1 → 2 → 3 → 4 → 5` then `6` / `7` / `8` / `9` in parallel as capacity allows → features `10–11` → cleanup `12`.

---

## PR details

### PR1 — Extract pure Markdown helpers + fix test drift ✅ DONE

**Branch name:** `pr1-extract-md-helpers`  
**Why first:** All later correctness work and tests need one source of truth.

**Scope**
- Extract pure functions from `TypoZen_Template.html` into a loadable module, e.g.:
  - `TypoZen/js/markdown-core.js` (or embed + also ship as file for Node)
  - Include: `stripBlockPrefix`, `transformRawForFormat`, `plainRangeToRawOffsets`, split/format helpers used by headings
- Load that script from the template (or inject at build).
- Change `tests/editor-logic.test.js` to **`require` / import production code**, not a copy.
- Implement real H4–H6 assertions against production `transformRawForFormat`.
- Add `npm test` or document `node tests/editor-logic.test.js`; call from `Build_TypoZen.ps1` (fail build on test fail).

**Out of scope:** Behavior changes beyond making tests run production code.

**Verify**
- [ ] `node tests/editor-logic.test.js` passes  
- [ ] App still builds; bold/heading/checklist still work  
- [ ] No duplicate logic in test file for production transforms  

**Risk:** Low if extraction is mechanical.

---

### PR2 — Serialize fidelity + Markdown round-trip corpus ✅ DONE

**Branch name:** `pr2-serialize-roundtrip`  
**Depends on:** PR1  

**Scope**
- Before every serialize boundary, flush active block DOM → `data-raw`:
  - `getMarkdownContent()`
  - mode toggle
  - `HistoryManager._capture()`
  - save / export request
- Prefer **not** overwriting `data-raw` from HTML on every keystroke when the edit was plain typing into reveal/raw; document the rule.
- Harden `blockHtmlToMarkdown` for common cases (strong/em/code/link only; avoid destroying nested structure when possible).
- Add corpus file `tests/fixtures/roundtrip.md` (or `.json` cases):
  - headings, bold/italic/code, links, lists, checklist, fence, simple table, blank lines
- Test: `loadMarkdownContent(md)` → `getMarkdownContent()` equals normalized expected (define normalization: trailing newlines, etc.).

**Verify**
- [ ] Round-trip suite green  
- [ ] Type in preview, switch Source — no lost `**` / wrong markers  
- [ ] Save after typing without blur still has latest text  

**Risk:** Medium — touches hot path of every edit.

---

### PR3 — History: caret, scroll, safer restore ✅ DONE

**Branch name:** `pr3-history-caret`  
**Depends on:** PR2 (so snapshots capture correct content)

**Scope**
- Extend history record: `{ content, mode, caretBlockIndex, caretOffset, scrollTop }` (best-effort).
- On `restore`, reapply caret + scroll after `loadMarkdownContent`.
- Single restore flag strategy (document: page `isRestoring` vs `HistoryManager.isRestoring`; unify or name clearly).
- Avoid surprising `resetToCurrent` on mode switch if possible (optional: snapshot mode switch as one undo step instead of wiping stack).
- Keep `maxSize` 100; consider coalescing only for pure typing (already debounced).

**Verify**
- [ ] Bold word → Ctrl+Z → caret near that word, not always doc start  
- [ ] Undo after scroll does not jump to top (or only slightly)  
- [ ] 5 pastes → 5 undos still work (regression)  

**Risk:** Medium.

---

### PR4 — Clipboard single pipeline ✅ DONE

**Branch name:** `pr4-clipboard-pipeline`  
**Depends on:** PR2; ideally PR3 for undo pairing  

**Scope**
- Route **Edit → Paste** / host `cmd:paste` through the same path as `editor` `paste` event (plain text sanitize, multi-line blocks, `beginEdit`/`commitEdit`).
- Cut/copy: ensure host menu and shortcuts update `data-raw` consistently.
- Remove or gate bare `document.execCommand('paste')` for WYSIWYG.
- Source mode: keep native textarea paste but ensure one undo step per paste (already partially done).

**Verify**
- [ ] Toolbar/menu Paste of multi-line MD → correct blocks + one undo per paste  
- [ ] Paste rich HTML from browser → plain text only, no junk spans  
- [ ] Cut mid-block → Save has correct markdown  

**Risk:** Medium (clipboard is OS-sensitive on Windows).

---

### PR5 — Find / replace index alignment ✅ DONE

**Branch name:** `pr5-find-replace-align`  
**Depends on:** PR2  

**Scope**
- One search domain per mode:
  - Source: markdown string indices  
  - WYSIWYG: either always search raw markdown (recommended for replace fidelity) **or** map visible ↔ raw with tested mapper
- Fix replace-all / replace-one so highlights and edits cannot desync around `**`, headings, links.
- After replace, use same flush + history begin/commit as other edits.

**Verify**
- [ ] Find `hybrid` in doc with `**hybrid**` / headings  
- [ ] Replace one and replace all; Source and Preview both consistent  
- [ ] Undo restores pre-replace document  

**Risk:** Medium–high (easy to regress UX).

---

### PR6 — Host protocol, prefs JSON, UTF-8 ✅ DONE (JSON prefs + scratchpad.md)

**Branch name:** `pr6-host-protocol`  
**Depends on:** PR1 (stable); can parallel PR3–5 after PR2  

**Scope**
- Prefer structured messages (JSON) for commands; keep short cmds if needed for compat.
- Large document: avoid stuffing entire prefs `lastContent` every keystroke — throttle harder or store scratchpad via host file API only.
- Parse/write prefs and theme mutations with real JSON (`System.Text.Json` or `JavaScriptSerializer` / Newtonsoft if already available) — **no regex inject of `lastFilePath`**.
- Unify UTF-8: **no BOM** everywhere (or BOM everywhere; pick one and document).
- Avoid long UI-thread `Wait` on save without timeout messaging.

**Verify**
- [ ] Open 1MB+ markdown; edit; save; reopen  
- [ ] Prefs survive restart (theme, margin, mode, sidebar)  
- [ ] File encoding stable in VS Code / git  

**Risk:** Medium (host touch surface).

---

### PR7 — WebView2 security hardening ✅ DONE (nav guard, path allowlist, URL, export, DevTools)

**Branch name:** `pr7-webview-security`  
**Depends on:** none strictly; do before public distribute  

**Scope**
- `AreDevToolsEnabled = false` in Release (keep true in Debug).
- Narrow virtual host mapping if possible; block unexpected navigation (`NavigationStarting`).
- `parseInline`: allowlist `http:`, `https:`, `mailto:`; reject `javascript:`, etc.
- Validate `open_file_path` is under allowed roots (current folder / user-opened dir).
- Export HTML: static markup only (no `onclick="toggleTask..."`).

**Verify**
- [ ] Normal editing/themes/files still work  
- [ ] Malicious `[x](javascript:alert(1))` does not execute  
- [ ] Export opens cleanly in browser  

**Risk:** Low–medium.

---

### PR8 — Block engine polish ✅ DONE

**Branch name:** `pr8-block-polish`  
**Depends on:** PR2; better after PR3–4  

**Scope**
- 2-stage Backspace: strip `1. ` / `23. ` ordered prefixes (same as headings/bullets).
- Arrow Up/Down: less magic-pixel; prefer caret offset / line logic.
- Mode toggle: restore approximate caret line (even if not full history quality).
- Spellcheck: disable inside `pre`/`code` if feasible; optional ignore for product name later.

**Verify**
- [ ] Ordered list: Backspace at start strips number once, second merges  
- [ ] Multi-line navigation does not skip blocks at large font sizes  
- [ ] Preview ↔ Source keeps rough place in doc  

**Risk:** Medium.

---

### PR9 — Docs + CI hygiene ✅ DONE

**Branch name:** `pr9-docs-ci`  
**Depends on:** PR1 for CI tests  

**Scope**
- README section: **Supported Markdown** vs **Not yet** (nested lists, math, Mermaid, side-by-side, multi-tab, etc.).
- `Build_TypoZen.ps1`: run unit tests; fail on failure.
- Short `CONTRIBUTING.md` or README blurb: branch naming, how to test, PR checklist.

**Verify**
- [ ] Fresh clone/build instructions work  
- [ ] CI/local build fails if tests fail  

**Risk:** Low.

---

### PR10 — Feature A: Nested lists ✅ DONE (basic Tab/Shift+Tab indent + render padding)

**Branch name:** `pr10-feature-nested-lists`  
**Depends on:** PR2, PR4 at minimum  

**Option A — Nested lists**
- Model indent levels in block raw (`  - item`) and render nested `<ul>/<ol>`.
- Tab / Shift+Tab indent in list context.
- Enter continues nest level; Backspace outdents.

**Option B — Images**
- Paste/drop image → save beside doc or to assets folder → insert `![](path)`.
- Resolve relative paths for preview.
- Basic drag resize later (optional follow-up).

**Verify:** feature-specific checklist + round-trip tests extended.

**Risk:** High (architecture stretch). **Do only one feature per PR.**

---

### PR11 — Feature B: Image paste/drop ✅ DONE

**Depends on:** PR10 settled and stable.

- Paste/drop image → `assets/typozen-img-*.{png,jpg,…}` next to the document (or cache if untitled)
- Inserts `![image](assets/…)` 
- Preview via `https://workspace/` virtual host

---

### PR12 — Optional structure cleanup (light ✅ CONTRIBUTING + core module already)

**Branch name:** `pr12-module-split`  
**Depends on:** PR1–9 stable  

**Scope**
- Split template script into `history.js`, `find.js`, `blocks.js`, `bridge.js` if still monolithic.
- Reduce empty `catch {}`; log to host in Debug.
- Consider SDK-style csproj / package WebView2 properly (longer-term).

**Risk:** High churn; schedule when not mid-feature.

---

## Suggested milestone map

| Milestone | PRs | Outcome |
|-----------|-----|---------|
| **M1 — Trust the document** | 1–4 | What you see is what saves; undo/paste trustworthy |
| **M2 — Host & safety** | 5–7, 9 | Find/replace, prefs, security, docs/CI |
| **M3 — Engine polish** | 8 | Lists/caret/mode feel pro |
| **M4 — Typora parity slices** | 10–11 | One big feature at a time |
| **M5 — Maintainability** | 12 | Easier future PRs |

---

## Out of scope (for now)

- Full collaborative editing  
- Math / Mermaid / YAML front matter (unless prioritized after M4)  
- Multi-tab / multi-window  
- Port away from WebView2  
- Complete Typora clone  

---

## How to use this plan alone (no GitHub required)

```text
git checkout -b pr1-extract-md-helpers
# ... work, test ...
git commit -m "PR1: extract markdown helpers and wire tests"
git checkout main
git merge pr1-extract-md-helpers
# repeat for pr2, pr3, ...
```

Or use GitHub/GitLab PRs for the same branch names.

---

## After approval

1. Save a copy into the repo, e.g. `TypoZen/docs/PR_PLAN.md` (or `TypoZen/PR_PLAN.md`).  
2. Start **PR1** only; do not combine with features.  
3. Each PR closes with the verify checklist ticked.

---

## Quick glossary

| Term | Meaning |
|------|---------|
| **PR** | Pull Request — proposal to merge a branch of work |
| **Branch** | Parallel line of commits for one change set |
| **Merge** | Apply that branch onto main |
| **Regression** | Old bug that comes back after a change |
| **Round-trip** | Markdown → editor → Markdown should match |
| **Corpus** | Fixed set of example documents used as tests |
