# TypoZen health review — 2026-08-29

App-first review of the tree at **0.2.25**. Numbers counted or read here.
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

There is **no open defect-class pile**. What a user can still hit is
small, ranked below. The one I would fix next is a leftover of the
native-tab pass, not a new architecture project.

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
| Native tab is a second surface (zoom, menus, Print, chrome `cmd:`) | Done; guarded by `native-surface-app.mjs` |
| Image/audio zoom greyed (shown at own size) | Done (0.2.25) |
| `epub-open-app` Matter + Xeelee | 93/0. Harness no longer stacks CDP evaluates |
| Print of a windowed document | Refuses rather than printing 1% |

Owner still-not: monolith split, rewrite remaining `*-app` sleeps, extract
the in-process tab harness, unique second-instance profile.

---

## Remaining — ranked by whether a user can hit it

### 1. Ctrl+B / I / K on a native tab can still format the hidden document

**This is the one leftover I would actually fix.**

`SendMsg` refuses `"cmd:"` while `_nativeSurfaceVisible` (Toggle Sidebar,
Find, About). Menus in Edit/Help are greyed. That is the 0.2.20–0.2.22
work, and it is right.

It does **not** refuse `"fmt:"`. The host message filter and
`Window.KeyDown` still turn Ctrl+B / I / K / T / Shift+X into
`fmt:bold` etc. and `SendMsg` posts them to the editor WebView, which
is alive behind the PDF. `export_html` is the same shape (not `cmd:`).

So: looking at a PDF, Ctrl+B can bold a run in the markdown you were
editing and mark that tab dirty. You find it when you switch back,
possibly with a save prompt for an edit you did not mean.

Find (Ctrl+F) is `cmd:` so it is silently swallowed — not ideal, but it
does not mutate. Format chords mutate.

**Fix (small):** in `SendMsg`, refuse `fmt:` and `export_html` the same
way as `cmd:` while the native surface is showing. Optionally no-op the
preprocess filter when `_nativeSurfaceVisible` so the chord is not
swallowed either (PDF viewer can have it). Extend `native-surface-app`
with one keyboard assertion: after Ctrl+B on a PDF, the hidden
document is still clean.

Not a data-loss hole on the PDF itself. It is a silent edit of the
other tab.

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

Unchanged from 2026-08-28 §3: split the monoliths, extract
`RunTabContentE2EAsync`, census empty catches, remove `PushFrame`,
raise `protocolTimeout`, treat PNG `about:blank` as broken, unique
second-instance profile unless asked, git-tracking of `TypoZen.exe`.

The 2026-08-28 combined review’s §1.1–1.8 and 1.10 “to do” lists are
**done**. Do not re-open them from that document.

---

## Advise

1. **Fix item 1** (fmt/export leak on native tabs) when you next touch
   the shell, or now if you want one more genuine shipped-app patch. It
   is small, local, and the suite already exists to extend.
2. **Do not start** search-indexing, unique profiles, or Privacy-copy of
   PDFs without a user report or a product decision.
3. **Docs:** this file is the current health snapshot. The 08-28
   combined review stays as the record of that pass. `known-issues.md`
   still has no open defect-class items; item 1 here is not yet filed
   there because it is unfixed advice, not a reproduced-from-use bug.
   File it if you confirm Ctrl+B on a PDF dirties the other tab in the
   real window.

No need for a monolith cleanup, a 408-sleep rewrite, or another
“is seeking Xeelee a hang” investigation.
