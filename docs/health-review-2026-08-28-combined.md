# TypoZen health review — 2026-08-28 (combined)

**Combined review (Grok)** of Claude's original at `docs/health-review-2026-08-28.md`,
plus the follow-up pass. `AppVersion` **0.2.15**. Numbers that appear were counted or
read in this tree. Where something is unproven, it says so.

Reading order: **§1 is the one that matters** (the shipped app). §2 is Claude's
test diagnosis, kept because it is real, with corrections on the numbers. §3 is
what not to spend time on. **§0 is current status** of the follow-up pass.

---

## 0. Follow-up pass (same day)

Tactical app fixes landed. Native reader (PDF / HTML / PNG) was checked by
hand in the real window and is fine — no suite added. Session restore showing
Welcome on a real file tab was found in the running app (not by the suites)
and fixed. Default-gate tests were sped up by polling instead of fixed sleeps
(`settle.mjs`, `launchApp` settleMs as a timeout cap, `smoke-browser` /
clipboard / hyphenation / edit-integrity). `docs/for-agents.md` now tells
other agents not to run `RUN_APP_E2E` as a ritual and not to add `sleep(n)`.

**Owner decision:** leave the remaining optional items. Splitting the
monoliths, rewriting hundreds of test sleeps, and extracting the in-process
tab harness from the exe are lots of work for no real gain. The harness is
already gated on `--debug`. Same for a unique second-instance profile and
Privacy-copy of native files unless those product questions are reopened.

| Item | Status |
|---|---|
| §1.1 Uncaught errors → HUD + `debug.log` | **Done.** `window.onerror` / `unhandledrejection` → `addDebugLog` + telemetry. Host `DispatcherUnhandledException` (handled, one MessageBox) and `AppDomain.UnhandledException` → profile `debug.log` even without `--debug`. |
| §1.2 Gate `TYPOZEN_TAB_E2E` | **Done.** Requires `Program.DebugLogEnabled`. `tests/tabs-content-e2e.py` now launches with `--debug`. |
| §1.3 Close during script pull | **Done.** First Close while `_scriptBlockDepth > 0` cancels and does not spend the force-quit click. Second click still force-exits. |
| §1.4 Autosave / session persist / Privacy TEMP | **Done.** Failures log to profile `debug.log` and show a one-shot dialog. Privacy Mode does not turn on if TEMP cannot be created. |
| §1.5 Dictionary off the UI thread | **Done.** Parse starts in the window ctor on a background thread; first lookup waits if needed. |
| §1.6 Authority-path empty catches | **Done (log, not a census).** `fromMarkdown`, copy (and preventDefault on whole-document), input sync, `flushActiveBlockToRaw`, `mountVirtWindow`, history restore, export per-block. `getMarkdownContent` no longer walks the window under virt/page-windowing. |
| §1.7 Source-search overlay size guard | **Done.** Skip the full-document mirror above 400k chars (`SRC_HL_MAX_CHARS`). |
| §1.8 Native reader | **Verified by hand** (PDF, HTML, PNG). No suite this pass. |
| §1.9 Second-instance unique profile | **Deferred.** Design choice (when to unique-profile, how sessions merge). Mutex fail-open commented. |
| §1.10 `NewWindowRequested` / `open_doc` | **Done.** Same `Uri.TryCreate` allowlist as `open_external`. Failed in-document file open shows `NotifyLink`. |
| Session restore shows Welcome on a real file | **Detected in use; fixed.** Chip/stats were the restored `.md`; editor + outline were the onload Welcome until you switched tabs and back. Host posted `load_content` from inside the `ready` handler (same trap as `open_doc` / Explorer open, which were already deferred) and then recorded the tab as already on the page, so clicking the same chip did nothing. Page no longer paints Welcome when hosted; host applies the restored tab on a fresh dispatcher turn. App suites use throwaway profiles, so they never restore a lived-in session and did not catch this. |
| Default-gate / harness waits | **Done (the useful slice).** `settled()` samples at 50ms; `launchApp({ settleMs })` is a timeout, not a mandatory pause; view pinning uses `settled` instead of 1.2s/1.8s sleeps. `smoke-browser`, clipboard, hyphenation, edit-integrity converted. Four of those ran in 39s combined. Remaining `*-app` folklore sleeps left in place. |
| Split monoliths / rewrite 408 sleeps / extract `TYPOZEN_TAB_E2E` | **Not doing — owner.** Lots of work, no real gain. Harness stays in the exe; it is gated on `--debug`. See §3. |

---

## Verdict

TypoZen is a serious Windows prose editor/reader, not a toy. The 0.2.7 → 0.2.8
data-loss and security cluster is closed: Select All cut/delete, HTML export,
OpenBook fail-closed, zip-slip, privacy staging for books, navigation allowlist,
resolver MAP, dictionary `ies` stem, book `<style>` kill, Bookerly stripped from
portable builds.

What is left that a **user** can hit is not a pile of defects. The silent-failure
paths, ungated test env var, and first-lookup hitch named here have been patched
in the follow-up pass (§0). There is **no confirmed product hang** when seeking
in a huge book; that entry in `known-issues.md` was a test/CDP artefact and has
been reclassified.

The test suite is expensive and shaped wrong in places. That is worth cleaning
when you next touch those suites. It is not why the app is or isn't healthy.

---

## 1. Genuine app issues

Ranked by what a user or a shipped binary can actually suffer. "Empty catch
census" is not on this list — see §3.

### 1.1 Uncaught errors have nowhere a human looks — do this first

Claude's §2. Confirmed, with two nuances.

| Claim | This tree |
|---|---|
| `window.onerror` | **wired** (was 0; now HUD + telemetry) |
| `unhandledrejection` | **wired** |
| `console.error` / `console.warn` in `js/modules` | **5** across 20,358 lines |
| Compact empty `catch (…) {}` in JS | **626** (Claude's ~580 was slightly low) |
| `catch {` in `TypoZen_App.cs` | **~250** empty/trivial (Claude's 243 is ballpark) |
| `catch {` in `EpubReader.cs` | **15** (Claude's 13 is close) |

`window.addDebugLog` exists in `03-shell.js` and feeds the Debug HUD
(`Ctrl+Shift+D`). It currently logs focus/blur. Uncaught exceptions never
reach it.

`window.showDebugTelemetry` *does* exist (~30 call sites: outline click,
`goToModelBlock`, `leaveBookViewForMarkdown`, …) and keeps an in-page ring.
It only posts to the host when `--debug` is on (`window.__tzDebugLog`).

**Nuance 1.** The three silent-failure examples Claude used as evidence
(`jumpToModelBlock` nested one scope too deep, `syncModeSurface` clearing
marks while `state.mode` still said `source`, source-search mirror holding a
stale width) are **already fixed** in this tree. Do not re-fix them. They
remain good evidence of the *class*: a compiled, gated feature that dies
quietly until a human notices the UI.

**Nuance 2.** Do **not** "fill in 626 empty catches." Most are optional APIs,
`focus()`, `clearTimeout`, decodeURI, Highlight API probes. The ones that
matter wrap **document-authority** work — see §1.6.

**To do (~15 lines, highest leverage in the tree):**

- `window.onerror` and `unhandledrejection` → `addDebugLog` (so the HUD
  shows them without `--debug`) and `showDebugTelemetry` (so `--debug`
  writes `debug.log`).
- Host: `DispatcherUnhandledException` / `AppDomain.UnhandledException`
  into the same log. There is currently **none**.

Do this before anything else in this document except correcting
`known-issues.md` (already done in this pass).

### 1.2 `TYPOZEN_TAB_E2E` can hijack a shipped launch

Claude's §3. Confirmed, and slightly worse than framed.

`RunTabContentE2EAsync` is **1,694 lines** (`TypoZen_App.cs:8583–10276`) —
13.2% of the 12,781-line host file — compiled into Release. There is no
`#if DEBUG`. Activation is a raw env var, **not** gated on
`Program.DebugLogEnabled` (the disk-prompt / Save As stubs *are*).

If that variable is left in a user environment, a normal double-click:

1. skips the single-instance mutex,
2. skips session restore,
3. runs the in-process tab harness against the directory named in the
   variable,
4. `_forceClose` and quits.

Ordinary users will not have it set. The disk stubs were gated for exactly
this class of "an env var in a shell steers a shipped build." Do the same
thing, same day: `if (!Program.DebugLogEnabled) return;` at
`ScheduleTabContentE2E`. Extracting 1.7k lines out of the binary is
later, and not a user-facing urgency.

### 1.3 Close while a script pull is in flight skips the dirty prompt

Not in Claude's list. Real.

```csharp
// TypoZen_App.cs ~1985
if (_forceClose || _closeClickCount >= 2 || _scriptBlockDepth > 0)
{
    e.Cancel = false;
    // persist last in-memory tab.Content, not the live editor
    return;
}
```

`ExecuteScriptBlocking` uses `Dispatcher.PushFrame`. While it is pumping
(save/tab-switch pull, up to 8 s / 2 s on close), `_scriptBlockDepth > 0`.
A Close in that window is treated as force-quit: **no unsaved prompt**,
and what gets persisted is the host buffer, not the keystrokes still in
the page.

The second-click force-exit is deliberate (a hung sync used to make the
window unclosable). The `_scriptBlockDepth` clause should not share that
path. Cancel the first close, or wait for the pull; only the second click
skips the prompt.

Claude's "11 PushFrame call sites" is **wrong**. There is **one**
`Dispatcher.PushFrame` and **eight** `ExecuteScriptBlocking` callers. The
re-entrancy guard (`_scriptBlockDepth` tested before the `try`) is
correct. The residual hazard is the message loop, not a broken counter.
Do not attempt to remove `PushFrame`.

### 1.4 Autosave and session persist fail silently

User-facing Save already fail-closes with a MessageBox
(`NotifyEditorSyncFailedForSave`). Two sibling paths do not:

- `AutosaveNow`: `try { SaveTabNow(tab, false); } catch { }` (`7824`).
  Autosave is on, the write failed, dirty flag stays, nothing said.
- `PersistTabSession`: the entire write is wrapped in `catch { }`
  (`3540`). Crash-restart can drop unsaved buffers with no toast.
  `WriteStateFileAtomic` itself is careful; the hole is the caller
  swallowing it.

`SaveWindowState` (`4151`) is the same shape, but that is geometry, not
user text — lower.

**To do:** if session persist or autosave throws, tell the user (or at
least write `debug.log` even without `--debug` for this class). Silent
session loss is worse than an extra dialog.

Related, rare: `EpubReader.BeginPrivateSession` (`EpubReader.cs:57–67`).
If creating the TEMP dir fails, `PrivateSessionRoot` is null and
extraction goes to the named cache. Privacy Mode's claim is broken with
no UI. Fail closed (refuse the book, or disable Privacy and say so),
don't fail open.

### 1.5 First dictionary lookup freezes the UI thread

Deferred in the 0.2.7 review; still true.

`dictionary.tsv` is **13.9 MB**, `thesaurus.tsv` **5.0 MB**. Both are
parsed with `File.ReadLines` inside `AnswerDefinition`, which runs
**synchronously on `WebMessageReceived`**. First "Look up" after launch
pays both loads on the UI thread before the popover can answer.

Not a correctness bug. It is the one feature that will feel broken on a
cold machine the first time someone uses it. Load off-thread (or at
idle after ready), keep the in-memory maps.

### 1.6 Empty catches on authority paths — not the census

Do not audit 626 catches. These few wrap the document:

| Where | What happens if it throws |
|---|---|
| `05-model.js` `DocumentModel.fromMarkdown(content)` on large Source load | Model stays on the previous document; Source shows the new file; search/save can answer the wrong one |
| `05-model.js` `onEditorCopy` outer `catch (err) {}` | `preventDefault` never runs; the browser copies the **mounted window**. This is how the 1% clipboard bug returns |
| `05-model.js` `onEditorInputSync` / `flushActiveBlockToRaw` | Preview looks edited; the model is not; host save can miss the last block |
| `06-render-epub.js` `getMarkdownContent` `catch (e2)` | Falls back to walking mounted `.block`s — the old wipe, as a last resort. A thrown error the host loss-guard can see is better than a successful 1% save |
| `07-stats-host.js` export per-block `catch (eB) {}` | That block is omitted from HTML export with no message |
| `04-lists.js` HistoryManager undo/redo restore | Failed restore looks like a no-op |

**To do:** log (telemetry / `addDebugLog`) and keep going — except
`getMarkdownContent`'s DOM fallback, which should **not** exist. Let it
throw; the host already refuses a suspicious shrink.

The main projection-vs-document holes (save, Select All copy/cut/delete,
print, HTML export, OpenBook fail-closed) are **already closed**. Do not
re-open them.

### 1.7 Source-mode search overlay copies the whole document into the DOM

Claude's §5, confirmed and slightly sharper.

`SRC_HL_MAX_MARKS = 8000` caps how many `<mark>` nodes are drawn (above
it, only the current hit). It does **not** cap document size. Painting
the overlay still HTML-escapes the **entire textarea** into a sibling
`innerHTML` so wrap stays aligned. One search in an 8 MB `.txt` is a
second full copy of the file in the DOM, only while search is active.

Typical Markdown: fine. A log or novel opened in Source + Ctrl+F: jank
or a memory spike. Cheap to guard: skip the mirror above some char
budget, or window it to the visible slice.

### 1.8 Native reader is unverified, not proven broken

Claude's §4 and the 0.2.7 audit's "PNG left `about:blank`" are easy to
over-read.

How it actually works: a second WebView; folder mapped to
`https://localview/`; PDF/HTML `Navigate` that URL; images/media
`NavigateToString` of a shell whose `<img>`/`<video>` src is
`localview`. `NavigateToString` **is** `about:blank` (or a data URL) at
the top level. A harness that reads `Source` will report blank on a
working PNG. The same harness did that on 0.2.7.

`tests/native-sample.pdf` and `tests/native-sample.png` exist and are
referenced from **zero** suites. `localview`: 7 hits in
`TypoZen_App.cs`, 0 in `tests/`.

Privacy Mode does **not** copy native files to TEMP (the native-reader
plan asked; the host never did). Books are extracted privately; a PDF
is served from its real folder. That is a product-claim gap, not a
crash.

**To do, in this order:**

1. Five minutes in the real window: open `tests/native-sample.pdf`,
   `tests/native-sample.png`, an `.html`, a video if you have one.
   Confirm the native surface is visible, the editor WebView is hidden,
   close does not strand state. That is the missing proof.
2. Then a small `localview-app.mjs` so it stays true: assert `<img>`
   decoded size / PDF URI, **not** `Source !== about:blank`.
3. Privacy-copy of native bytes only if Privacy Mode is meant to cover
   "I opened this PDF." Today it covers traces (session, recents,
   autosave, bookmarks), not the bytes on disk.

First native open hides the editor WebView *before* the native control
exists (`ShowNativeSurface` then fire-and-forget `EnsureNativeWebViewAsync`).
Brief blank pane. Polish, not a defect.

### 1.9 Cold-start second instance shares the profile

Claude's mutex fail-open is **true and overweighted**.

If creating the SID-scoped mutex throws, `createdNew = true` and the
process proceeds. Two instances. Uncommon after the ACL is in place;
a comment is enough ("prefer two windows over dropping an Explorer
open").

The designed path is more likely: mutex exists, pipe is not ready yet,
8 × 50 ms retries, then **start a second window on purpose**
(`TypoZen_App.cs:224–226`). Both use the same `CacheDir()` / WebView2
user-data folder. Two WebView2 processes on one profile is the actual
risk (lock, split session writes), not "two Notepads."

**To do:** if pipe handoff fails, do not `app.Run` on the same user-data
dir — unique profile, or keep retrying. Don't drop the file open.

### 1.10 Smaller, still real

- **`NewWindowRequested`** still `Process.Start`s a regex-matched URI
  (`7924–7935`, `7973–7984`). `open_external` already uses
  `Uri.TryCreate` + http/https/mailto only. Run the window request
  through the same allowlist.
- **`open_doc` deferred `LoadFileFromPath`** is `catch { }`. Clicking an
  in-document file link that fails to open is silent. The outer path
  does `Debug.WriteLine`. A `NotifyLink` would match the missing-file
  case.
- **`HandleHtmlModeSegmentClick`** is also `catch { }`. HTML Source ↔
  Reader is a user-facing mode switch; a failure should not be quiet.
- No file-size limit anywhere. Product choice (README: open by type,
  not size). The Source-search overlay (§1.7) is the place that choice
  currently hurts.

### 1.11 Docs that were lying about the product

`known-issues.md` listed "seeking into the middle of a very large book
does not finish" as the **one open defect-class item**. Isolated
measurement (Claude): `goToModelBlock` into the Xeelee omnibus is
**85–112 ms**; `getMarkdownContent` over 8.1 MB is **8 ms**. The stall
reproduced only as a Puppeteer `ProtocolError` inside a waterfall
suite. `docs/for-agents.md` already said it was not a product hang;
`known-issues.md` disagreed. That disagreement would have sent the next
agent hunting a ghost.

Reclassified in this pass. A red `epub-open-app` is still not evidence
the view hung for a reader.

---

## 2. Tests — Claude's diagnosis, corrected

Claude spent most of a day here and the technical core holds: **do not
park a sleep inside `app.eval`**. The headline numbers and the
"rewrite every suite" order do not.

### 2.1 What the 408 / 609.75s figure is

`sleep(\d+)` in `tests/*.mjs` matches **exactly 408 lines**. Summing
those literals is **609,750 ms**. That is a regex, not a measured run.

It includes comments, helper defaults, and default-gate browser suites.
It does not unroll loops, does not multiply Matter+Xeelee, and does not
include `launchApp({ settleMs: 6000 })`. "Ten minutes of idling per
full run, before any work" is therefore **not a wall-clock measurement**.

Most of those literals **never run on the default gate**.
`tests/run-tests.ps1` skips `*-app.mjs` unless `RUN_APP_E2E=1`.
Default-gate sleep literals are ~**55 s**, dominated by
`smoke-browser.mjs`.

### 2.2 "330+ sleeps inside `app.eval`" is overstated

The deadlock class is real: one CDP call, one `protocolTimeout`, a
sleep parked in the page, `ProtocolError: Runtime.callFunctionOn timed
out`. Raising `protocolTimeout` to 600s was tried and bought a
ten-minute wait for the same failure. **Do not raise it again.**

The per-suite table was not in-eval counts:

| Suite | Claude "inside eval" | Actual `sleep(\d+)` in `app.eval` (spot-check) |
|---|---:|---:|
| `marks-surfaces-app.mjs` | 45 | **18** |
| `book-position-app.mjs` | 40 | **9** |
| `epub-open-app.mjs` | 38 | **30** |
| `source-highlight-app.mjs` | 29 | **0** (already polls) |
| `bookmark-state-app.mjs` | 24 | **8** |

Runner-side `await sleep` is slow and flaky. It does not ProtocolError.
The rule to enforce is: **never `await sleep` inside `page.evaluate` /
`app.eval`**. A grep gate is enough. Poll on the runner
(`evalPatiently`, `settledApp` in `settle.mjs` — both already exist).

`evalPatiently` (3s try, 250ms retry, 25s budget) is in
`app-harness.mjs` and used from `epub-open-app` for cover + density.
That is the right shape. It does not need rolling out to 408 sites.

### 2.3 The waterfall, as of this tree

Claude described `epub-open-app` driving markdown → Matter → Xeelee in
**one** instance. **That is no longer true.** The suite now closes and
relaunches between Matter and Xeelee (`tests/epub-open-app.mjs:969–974`).
`docs/for-agents.md` still said "four books in one instance"; corrected
in this pass.

What remains:

- Each book still starts as markdown (`large-scroll-mixed.md`) then
  `open_file_path` the epub, in the same process.
- `openAndCheck` is still one long chain. Later stages still park
  `await sleep(800–3000)` inside one evaluate (e.g. suppression:
  `goToModelBlock` + 3 s in-page).
- After the polling fix, the remaining failure is
  `page never answered after 8 attempts over 25s (main thread busy)`
  on the density stage of the omnibus lap, rather than an opaque 180s
  `ProtocolError`. Isolated, the omnibus is fine.

Working theory (Claude's, still a theory): leftover in-page sleeps plus
the markdown→book sequence. Confirm rather than assume. **Do not**
raise `protocolTimeout`.

### 2.4 Suite debt, not product bugs (keep this)

All three red suites investigated that day were stale contracts:

- **`annotations-app`** — note edit commits from `blur`; Chromium does
  not dispatch blur to a background document. `bringToFront()` →
  `blurFired: 1`. Notes persist correctly. 25/25.
- **`privacy-app`** — looked for the extracted book in the application
  folder. Cache moved to the per-user state dir (`EpubReader.CacheRoot`)
  because extracting beside the exe makes the install writable, which
  it is not under MSIX. The privacy assertion had become vacuous; the
  **control** is what caught it. 21/21.
- **`epub-open-app`** — `fetch()` of SVG-wrapped covers against
  `localbooks` + `DenyCors`. Replaced with `Image()`. The cover was
  legible on screen the whole time.

Rule worth keeping: any assertion that something *did not happen* needs
a control proving the mechanism can happen at all.

### 2.5 Practical test work

The high-leverage slice **landed**: default-gate layout waits poll;
`launchApp` no longer sleeps a guessed 2.5–8s; agents are told not to
add more. Do **not** rewrite the remaining 408 / `*-app` sleeps — owner
call, lots of work for no real gain.

If you are already in a suite: never park `sleep` inside `app.eval`;
do not raise `protocolTimeout`. `epub-open-app` remaining stall is
harness-side. A portable-build smoke is release-tooling, not the app.

---

## 3. What is not worth it

| Item | Why drop or demote |
|---|---|
| Rewrite all 408 test sleeps | **Owner: no.** Regex artefact; deadlock is in-eval only. The useful slice (default gate + `launchApp` cap) already landed. |
| Split `TypoZen_App.cs` / `02-layout.js` | **Owner: no.** Mechanical extract, high regression cost, no user-facing gain. |
| Pull `RunTabContentE2EAsync` out of the exe | **Owner: no.** Already gated on `--debug`. Extracting 1.7k lines is lots of work for no real gain. |
| Fill in ~600 empty JS catches / ~250 C# ones | Most are `focus()` / temp-file / COM. Authority paths only (§1.6) |
| "11 PushFrame sites" / remove `PushFrame` | One site. Guard is correct. Close-during-sync is the actual bug |
| Mutex fail-open as a project | Comment it. The 400 ms pipe-miss second window is the real two-instance path |
| Raise `protocolTimeout` | Tried at 600s. Does not work |
| Treat PNG `about:blank` as a product bug | `NavigateToString` origin. Untested ≠ broken |
| Re-fix outline jump / mode-surface marks / mirror width | Already fixed. Leftover extra indent on `jumpToModelBlock` is cosmetic |
| Re-gate `TYPOZEN_DISK_PROMPT` / `TYPOZEN_SAVE_AS_PATH` | Already gated on `Program.DebugLogEnabled` |
| Re-scope `Build_TypoZen.ps1` process kill | Already path-scoped + `CloseMainWindow()` |
| Named-pipe extra token | Same-user local editor; deferred in 0.2.7 for good reason |
| Git-tracking of `TypoZen.exe` / WebView2 DLLs | Hygiene; not a user issue |

---

## 4. Already fixed — do not redo

From Claude's original §6, plus the 0.2.7 → 0.2.8 cluster. Still the
authority on what has landed.

| Commit | What |
|---|---|
| `e7dc73b` | Source selection painted in the theme accent (superseded in value by `d04017f`) |
| `d04017f` | Source-mode search highlighting via a mirror layer; `source-highlight-app.mjs` |
| `d2729ec` | Three real bugs in that feature: Alt+S left marks, keyboard nav didn't move the ring, pane resize slid every mark |
| `684bb94` | Pipe/mutex scoped to the user's SID with ACLs; `open_external` via `Uri.TryCreate`; build script no longer hard-kills the editor |
| `f30f7e1` | The three suite-debt fixes in §2.4 |
| `1c104d3` | `evalPatiently`; `epub-open-app` cover stage driven from the runner |
| `e52482f` | Restore `$tpl` in the portable build (Claude's §5 release-tooling find) |
| 0.2.8 pass | Cut/Delete/Export from the model; OpenBook fail-closed; zip-slip; privacy staging; navigation allowlist; resolver MAP; `ies` stem; `<style>` kill; Bookerly stripped |
| this pass | Session restore no longer leaves Welcome in the editor on a restored file tab (detected in the running app; `load_content` deferred off the `ready` handler; hosted page does not paint Welcome before the host speaks) |
| this pass | Test waits: `settled()` / `untilPage()`; `launchApp` settleMs is a timeout cap; smoke/clipboard/hyphenation/edit-integrity no longer sleep for a guessed duration. `for-agents.md` forbids ritual `RUN_APP_E2E` and new `sleep(n)` |

Two of those were **silent data-loss risks in shipped code**:

- `Build_TypoZen.ps1` used `Stop-Process -Force` on *every* TypoZen on
  the machine — including the instance running from
  `OneDrive\Apps\TypoZen`, which holds no lock on the build output.
  `TerminateProcess`, no `WM_CLOSE`, no save prompt. Now scoped by
  `MainModule.FileName` and asks with `CloseMainWindow()` first.
- `TrySaveAsStub` was consulted in `SaveTabNow` — the *general* Save As
  path — and returned true whenever `TYPOZEN_DISK_PROMPT` was set. In a
  shipped build with that variable in the environment, File → Save As,
  saving an untitled document, and Export Book As would each return
  false with no dialog and no message.

**Correction on the record (Claude):** an external audit (Antigravity)
reported the pipe/mutex finding and it was initially called wrong,
because the working tree had already applied its own fix.
`git log -S"PipeSecurity"` returned nothing, which was the check that
settled it. Verify findings against history, not the file on disk, when
another agent has touched the tree.

---

## 5. Suggested order

App first. Tests when you are already in that file. Items 1–7 and 1.10
landed in the follow-up pass (§0).

1. ~~**§1.1 error visibility**~~ **done.**
2. ~~**§1.2 gate `TYPOZEN_TAB_E2E`**~~ **done.** Do not extract 1.7k lines — owner.
3. ~~**§1.3 Close during `_scriptBlockDepth`**~~ **done.**
4. ~~**§1.4** autosave / `PersistTabSession` / Privacy TEMP~~ **done.**
5. ~~**§1.5** dictionary off the UI thread~~ **done.**
6. ~~**§1.6** authority-path logs + virt-safe `getMarkdownContent` fallback~~ **done.**
7. ~~**§1.7** Source-search overlay size guard~~ **done.**
8. ~~**§1.8** Native reader~~ checked by hand. A `localview-app.mjs` is
   optional keep-true, not a fix. Privacy-copy of native bytes only if
   that product question is reopened.
9. **§1.9** second-instance unique profile — owner left it; ask before
   doing.
10. ~~**Default-gate / harness waits**~~ **done.** Do not rewrite the
    remaining `*-app` sleeps, split the monoliths, or extract the
    in-process harness. Owner: lots of work for no real gain.

---

## 6. Standing rules worth keeping

From Claude, still right, plus two.

- Never sleep for a duration in a test; poll for the state the
  assertion depends on. **Never park that sleep inside `app.eval`.**
- One evaluate, one short question.
- Any assertion that something *did not happen* needs a control proving
  it can.
- A red suite is more often a stale contract than a defect — three for
  three that day — but verify that per suite rather than assuming it.
- Never raise `protocolTimeout` to make a stall go away. It has been
  tried at 600s.
- When another agent has edited the tree, check `git log -S`, not the
  working file.
- **The DOM is a projection; the document is `DocumentModel`.** Before
  adding any path that serialises, exports, prints, copies, cuts or
  persists, ask which of the two it is reading. A fallback that writes
  the window is worse than a thrown error.
- **Do not invent product defects from suite names.** `known-issues.md`
  is for reproduced user-visible failures and deliberate limits.
  `epub-open-app` red is not "jumping in a huge book hangs."
