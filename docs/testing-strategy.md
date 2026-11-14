# TypoZen Testing Strategy

TypoZen’s tests are organized into **three outcome-focused tiers** so routine iteration stays fast, releases are guarded by randomized gesture/invariant sweeps rather than happy-path scripts alone, and real-app E2E runs stay scoped to what changed.

---

## Tier 1 — Fast Core (< 45 s, internal builds & every change)

Two fast entry points:

- **`node tests/version-smoke.mjs`** (~13 s, 20 s hard budget):
  Runs automatically from `Build_TypoZen_NoTest.ps1`, `Build-Installer.ps1`, and `tools/hooks/pre-commit` (when `AppVersion` changes). Verifies the compiled `.exe` version, `real-files-roundtrip-browser.mjs`, `real-files-properties-browser.mjs` (`PROPERTIES_QUICK=1`), `key-smoke-browser.mjs`, and `core-smoke-app.mjs` on a hidden desktop.
- **`node tests/run-gate.mjs --tier fast`** (~60 s):
  Runs the high-signal headless core in parallel without the multi-minute fuzzers:
  - `parse-check.mjs` & `modules-selftest.mjs` (syntax + no cross-module function shadowing)
  - `real-files-roundtrip-browser.mjs` & `source-roundtrip-browser.mjs` (corpus & Source-mode serialization integrity)
  - `keyboard-editing-preview-browser.mjs` & `keyboard-editing-large-browser.mjs`
  - `edit-keeps-source-browser.mjs`, `format-keeps-source-browser.mjs`, `clipboard-roundtrip-browser.mjs`, `callout-edit-browser.mjs`, `undo-selftest.mjs`

**When to run:** Every internal release (`0.x.y`) and after any editor/parser/formatter change.

---

## Tier 2 — Release Gate & Invariant Attack Sweeps (~5–6 min, GitHub / Store releases)

- **`.\tests\run-tests.ps1`** (or `.\Build_TypoZen.ps1`):
  Runs all headless suites, including the randomized property/attack sweeps:
  - **`selection-attack.mjs`**: Randomized `Shift+click` / drag selections from any block type to any block type across **all three layouts** (`scroll1`, `scroll2`, `pages`), pressing real keys (`Delete`, `Backspace`, `Enter`, `Shift+Enter`, typing, `Ctrl+X/C/V`, `Ctrl+B`, `Ctrl+I`), and applying the bullet, numbered, quote and heading formats as the toolbar does, and asserting:
    1. No lost or duplicated tokens
    2. Lines outside the selection stay byte-identical (the lines of a table the selection touches are excused; a numbered list below an Enter may count on)
    3. `Ctrl+Z` restores the exact document in the expected step count
    4. The next typed character lands at the cut
    5. A word left in a table is still in its column
    6. Bold and italic do not change the words shown

    It runs for 50 seconds with **a new seed each run** (printed; `TZ_SEED=<n>` or the second argument repeats one), about 90 cases of several thousand possible. A pass means those cases passed. It counts words, so it cannot judge markup: when it is changed or a new action is added, read what it saved for a sample of cases.
  - **`key-fuzz.mjs`**: Not random: each of 10 key sequences at the start and end of 25 words, one per block kind (500 fixed cases).
  - **`long-edit-sweep.mjs`**: Eight edits at five positions in each layout of a 900-line file (`SWEEP_LINES=3000` for scrolling Preview's own window).
  - **`controls-browser.mjs`**: Presses every visible toolbar/menu control across UI states.

**Rule for new bugs:** Prefer adding the missing gesture, block kind, or invariant to `selection-attack.mjs` (or the core editing suites) rather than creating another isolated one-off `*-selftest.mjs` file.

---

## Tier 3 — Real App Shell & MSIX Packaging (scoped by subsystem)

- **Subsystem-scoped `*-app.mjs`:**
  Instead of running all 80 `*-app.mjs` suites blindly, filter to the subsystem touched:
  ```powershell
  $env:RUN_APP_E2E='1'; node tests/run-gate.mjs --app-filter edit
  $env:RUN_APP_E2E='1'; node tests/run-gate.mjs --app-filter pdf
  ```
- **Store MSIX verification (mandatory before Microsoft Store upload):**
  ```powershell
  .\tools\Test-Packaged.ps1 -Remove
  ```
  Registers the built `dist-msix\TypoZen.msix` and runs `packaged-smoke-app.mjs` inside its real Windows AppContainer.
