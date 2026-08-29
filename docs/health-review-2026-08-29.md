# TypoZen health review — 2026-08-29

App-first review of the tree at **0.2.29**. Numbers counted or read here.
The 2026-08-28 combined review (`docs/health-review-2026-08-28-combined.md`)
is the record of that day’s pass; this document is current status.

Reading order: **verdict, then remaining user-visible items, then what
not to spend time on.**

---

## Verdict

The app is in good shape. The 0.2.7–0.2.8 data-loss/security cluster is
closed. The 0.2.15 silent-failure / env-var / fault-write pass is closed
and, for the dispatcher fault, **runtime-proved**. The 0.2.18–0.2.25
native-tab pass closed a real class of “the shell acted on the document
you were not looking at.” Seeking a huge book is not a hang; `epub-open-app`
is 93/0.

There is **no open defect-class pile** from the 0.2.15–0.2.26 punch-list.
A new-tab scratch used to inject real markdown ("Untitled Document" /
"Start typing here...") and put the CSS hint on `.block::before` (the
10px bookmark gutter), which laid the sentence out one glyph per line,
let innerText capture it on tab switch, and corrupted the buffer. Fixed
in 0.2.27: empty scratch, hint on `#editor-wrapper`, never serialized.

F1 / Help → Syntax & Shortcuts was advertised on that hint and in the
menu, and did nothing while the editor had focus (F7/F8/F9 were bound;
F1 was not; `Window.KeyDown` never runs inside the WebView). Fixed in
0.2.28. That was a fundamentals miss the 0.2.26 “good shape” verdict
did not catch — the keep-true is now `scratch-help-app`, not a review
sentence.

Spelling shipped in 0.2.29. `dictionary.tsv` is Look up (WordNet lemmas),
not a spell list. Preview uses WPF’s built-in dictionaries; Source uses
Chromium `spellcheck`. Guarded by `spell-selftest` and `spell-app`.

---

## What landed since 0.2.15 (do not redo)

| Area | Status |
|---|---|
| Uncaught errors → HUD + `debug.log` | Done |
| `TYPOZEN_TAB_E2E` / disk stubs gated on `--debug` | Done |
| Close during script pull | Done |
| Autosave / persist fail-closed; Privacy TEMP | Done |
| Dispatcher fault stops automatic writes | Done and **proved** (`fault-autosave-app` 8/0) |
| Dictionary off the UI thread | Done |
| Source-search overlay size guard (`SRC_HL_MAX_CHARS` 400k) | Done |
| `NewWindowRequested` / `open_external` via `TryShellExternalUri` | Done |
| `open_doc` fail shows `NotifyLink` | Done |
| Session restore Welcome on a real file | Done |
| Native tab is a second surface (zoom, menus, Print, chrome `cmd:` / `fmt:`) | Done; guarded by `native-surface-app.mjs` (Ctrl+B on PDF does not dirty the hidden document) |
| Empty new tab is empty; F1 opens Syntax & Shortcuts | Done (0.2.27 empty scratch, 0.2.28 F1). Guarded by `scratch-hint-selftest` and `scratch-help-app` |
| Spelling (Preview underlines + replacements; not WordNet) | Done (0.2.29). Guarded by `spell-selftest` and `spell-app` |
| Image/audio zoom greyed (shown at own size) | Done (0.2.25) |
| `epub-open-app` Matter + Xeelee | 93/0. Harness no longer stacks CDP evaluates |
| Print of a windowed document | Refuses rather than printing 1% |

**Owner still-not (do not start):** monolith split; rewrite remaining
`*-app` sleeps; extract the in-process tab harness; unique second-instance
profile; search-indexing the omnibus; Privacy-copy of native files;
census of empty catches; another “is seeking Xeelee a hang” pass.

---

## Remaining — ranked by whether a user can hit it

### 0. F1 / Help → Syntax & Shortcuts did nothing — **fixed (0.2.28)**

Advertised on the empty-tab hint and in Help. Page JS bound F7/F8/F9 only.
`Window.KeyDown` has F1, but that event does not run while the editor has
focus. `cmd:help_syntax` now opens (does not toggle) from page JS and from
the host key filter. `scratch-help-app` sends a real `{F1}`.

### 1. Ctrl+B / I / K on a native tab formatted the hidden document — **fixed (0.2.26)**

`SendMsg` refused `"cmd:"` while `_nativeSurfaceVisible` but not `"fmt:"`
or `export_html`. The host key filter posted `fmt:bold` at the editor
behind a PDF. Menus looked dead; the chord was not.

**Now:** `IsEditorDocumentMessage` gates `cmd:`, `fmt:`, and `export_html`.
The key filter does not swallow those chords on a native tab (the PDF
viewer can have them). `native-surface-app` sends Ctrl+B through the
real window (`shell-ui keys`, not Puppeteer) and asserts the hidden
document is still clean.

### 2. Search on a very large book freezes the UI for a long time

`runFind` walks the whole haystack on the main thread. Matter is fine
(~1M chars, search covered). The Xeelee omnibus is 8.1 MB; the suite
skips find there because one CDP poll sitting behind that walk hits
`protocolTimeout`. A person typing “the” in the sidebar would see the
same freeze.

This is the same product choice as “open by type, not size.” It is not
a hang in the seek/windowing sense. Do **not** treat a red search suite
as evidence the view is wedged. Yielding or indexing search is a
feature, not a one-line fix. Leave it unless someone actually searches
omnibuses and complains.

### 3. Cold-start second instance can share the profile

Still true, still overweighted. Mutex ACL throw → prefer two windows
(commented). The designed path: mutex held, pipe not ready, 8×50 ms,
then a **second window on the same `CacheDir()`**. Two WebView2
processes on one user-data dir is the actual risk.

Owner left a unique profile as a product question. Ask before doing.
A comment is already there.

### 4. Privacy Mode does not copy native files

Books extract to a private cache. A PDF is served from its real folder.
If Privacy is meant to mean “nothing I opened is named on disk,” a PDF
path in recents is already suppressed; the bytes stay where they were.
If it is meant to mean “TypoZen never touches the original,” native
open already does not write it. Only reopen this if the *claim* is
wrong, not to invent a TEMP copy.

### 5. HTML Source ↔ Reader failure is quiet

`HandleHtmlModeSegmentClick` is still `catch { } return false`. A
failed open of the real page looks like a dead click. Rare. A
`NotifyLink` would match `open_doc`. Cheap if you are in that method;
not worth a dedicated pass.

### 6. Print of a long document is refused, and says so

Not a defect. Chromium prints the DOM; the DOM is a window. The dialog
tells you to save and print elsewhere. Fail-open if the probe does not
answer, so a broken script cannot disable Print. Leave it.

---

## Tests — only what changed the picture

- Default gate is still the gate. Do not ritual-run `RUN_APP_E2E`.
- `native-surface-app` is the keep-true for the native-tab pass. Run it
  when you touch `SendMsg`, zoom, or menu enablement.
- `fault-autosave-app` is the keep-true for automatic writes after a
  fault. `--debug` only; do not add a shipped throw.
- `epub-open-app` is green. Do not raise `protocolTimeout`. Do not stack
  in-flight evaluates.
- Remaining `*-app` folklore sleeps: owner said no rewrite.

---

## Do not spend time on

Unchanged from 2026-08-28 §3, plus the owner call of 2026-08-29:

- Split the monoliths; extract `RunTabContentE2EAsync`
- Rewrite remaining `*-app` folklore sleeps; census empty catches
- Remove `PushFrame`; raise `protocolTimeout`
- Treat PNG `about:blank` as broken
- Unique second-instance profile unless asked
- Search-indexing the omnibus; Privacy-copy of native files
- Git-tracking of `TypoZen.exe`
- Another “is seeking Xeelee a hang” investigation

The 2026-08-28 combined review’s §1.1–1.8 and 1.10 “to do” lists are
**done**. Do not re-open them from that document.

---

## Advise

Nothing further this week unless a user hits search-on-omnibus or the
second-instance pipe race. Item 1 is fixed. `known-issues.md` has no
open defect-class items.
