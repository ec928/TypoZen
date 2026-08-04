# Contributing to TypoZen

> **ARCHIVED (2026-07-30).** Superseded by `README.md`, which is the single source of
> truth for how TypoZen works. Kept for history; no longer maintained. Where this file and
> the README disagree, the README is correct.

## Tests

```powershell
# Full suite (preferred)
.\tests\run-tests.ps1

# Or build (runs self-tests when the build script is configured to)
.\Build_TypoZen.ps1
```

Individual suites live under `tests/*.mjs` (and a few Python tab smokes). They exercise production logic extracted from or hooked into `TypoZen_Template.html` — **do not** reimplement editor helpers only in the test file when the production function can be asserted or extracted.

Notable areas:

| Area | Examples |
|------|----------|
| Dual-source / model | `dual-source-selftest.mjs` |
| Virt thresholds & progressive bands | `virt-thresholds-selftest.mjs` |
| Virt find / format | `find-virt-selftest.mjs`, `virt-format-indices-selftest.mjs` |
| Mode switch sticky line | `mode-switch-line-selftest.mjs`, `mode-switch-sticky-e2e.mjs` |
| Lists / multi-select / undo | `multiselect-bullet-livepath-selftest.mjs`, `bullet-undo-selftest.mjs`, `undo-selftest.mjs` |

## Architecture docs

- **`docs/ENDGAME_DOC_MODEL_VIRTUALIZATION_PLAN.md`** — authoritative for DocumentModel, virt, progressive M-band, sticky mode switch (Stage D complete).  
- **`docs/SOURCE_PREVIEW_DUAL_SOURCE_DECISION.md`** — dual-source flush invariants; size-band table updated for virt.  
- **`docs/PR_PLAN.md`** — older feature/correctness PR packaging (still useful for nested lists, etc.).

## PR-sized work

See `docs/PR_PLAN.md` for ordered work packages where still relevant. Prefer one concern per branch:

- Small, reviewable diffs  
- Automated tests when logic is pure or can be e2e’d in jsdom  
- Do not combine features with protocol/security refactors  
- Do not re-couple progressive paint to `LARGE_DOC_CHARS` / 16 KB (Source-first only)

## Branches (optional)

```text
pr1-extract-md-helpers
pr2-serialize-roundtrip
…
```

Merge to main when the PR checklist in the plan is satisfied.
