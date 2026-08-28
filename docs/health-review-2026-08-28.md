# TypoZen health review — 2026-08-28

**Original (Claude).** Written at `1c104d3`. Unedited.

Combined review, corrections, and follow-up status: `docs/health-review-2026-08-28-combined.md`.

---

Written for whoever picks this up next, including me. Everything here was measured in
this tree at `1c104d3`, not inferred. Where a number appears, it came from running the
thing. Where something is unproven, it says so.

Reading order: **§1 is the one that matters**. §2–§5 are real but bounded. §6 is context
on what already landed today, so nobody re-does it.

---

## 1. The test suite — architecture, not tuning

This is the largest and most consequential problem in the project. It cost most of a day
today, produced three false bug reports, and hid one real stall.

### 1.1 What was measured

```
408 hardcoded sleeps across tests/*.mjs, totalling 609.75s of wall clock
```

Ten minutes of deliberate idling per full run, before any work happens. Worse, **330+ of
those sleeps sit inside `app.eval(async …)`** — that is, inside the page:

| suite | `await sleep()` calls inside evaluates |
|---|---|
| `marks-surfaces-app.mjs` | 45 |
| `book-position-app.mjs` | 40 |
| `epub-open-app.mjs` | 38 |
| `source-highlight-app.mjs` | 29 |
| `annotations-app.mjs` | 26 |
| `bookmark-state-app.mjs` | 24 |
| `page-scrubber-app.mjs` | 20 |
| `bookmark-pane-app.mjs` | 19 |
| `source-popover-app.mjs` | 17 |
| `page-count-truth-app.mjs` | 17 |
| `edit-integrity-app.mjs` | 15 |
| `search-highlight-app.mjs` | 10 |

`source-highlight-app.mjs` is mine, written today. Same fault. It is not exempt.

### 1.2 Fault A — parking inside the page (self-deadlock)

One `evaluate` is **one CDP call with one `protocolTimeout`**. A call shaped like

```js
await app.eval(async () => {
    goToModelBlock(deepIndex);
    await sleep(3000);          // <-- parked inside the page
    return measureEverything();
});
```

deadlocks against itself on a large document: the page cannot finish the work the call
started while the call is still parked in it, and the call cannot return until that work
finishes. It surfaces as `ProtocolError: Runtime.callFunctionOn timed out`, which names
nothing useful.

The previous response to this was to raise `protocolTimeout` to **600s**. That bought a
ten-minute wait for the identical failure and was reverted, leaving a comment in
`app-harness.mjs` blaming `goToModelBlock` for "not finishing".

**That diagnosis was wrong.** Measured today:

- `goToModelBlock` into the middle of the 45,486-block omnibus: **85–112 ms**
- the whole deep seek, profiled across `mountPageChunk` + `PageGeometry.relayout` +
  `updateStatsNow`: **~200 ms total**
- `getMarkdownContent(false)` over all **8.1 MB**: **8 ms**
- `modelBlockStartLine` at 60% depth: **56 ms**
- the `getClientRects` sweep over 840 rects: **3 ms**

Nothing is slow. The shape of the call was the fault.

**Fixed (partially).** `app-harness.mjs` now exports `evalPatiently(app, fn, arg, opts)`:
short attempt (3s), fast retry (250ms), total budget 25s, abandoned attempts caught so a
late puppeteer rejection cannot kill the process minutes later. An idle page answers
first time; a blocked page is *reported as blocked, with an attempt count, in 25 seconds*
rather than three minutes.

**Still to do:** every suite in the table above. The mechanical change is:

- move `await sleep(n)` out of the evaluate and into the runner;
- replace it with a poll on the condition that actually matters, not a duration;
- keep each evaluate to a single short question.

### 1.3 Fault B — waterfall suites

`epub-open-app.mjs` drives **one** app instance through: a markdown file → *Matter*
(17 evaluate stages) → *Xeelee* (17 stages). Every stage inherits the state the previous
one left. When stage 6 stalled, the twelve stages after it never ran, and the failure
reported nothing about which of the 34 stages was at fault — I had to insert numbered
markers and bisect.

Worse: **the remaining stall reproduces only in that full sequence.** Opened on its own
the omnibus loads in 10s; its whole navigation pass runs in 20s; every individual
operation is in the milliseconds. A modular suite would have localised this in minutes.

**To do:** each check starts from a known state and owns its instance where the fixture
is heavy. Precedent already exists in the tree — suites get a throwaway profile each for
exactly this reason (`TYPOZEN_PROFILE_DIR`); processes deserve the same when the fixture
is a 45,000-block book. I tried per-book isolation alone and it did **not** fix the stall,
so isolation is necessary but not sufficient; the in-page sleeps have to go too.

### 1.4 Fault C — sleeps as synchronisation

The project has already learned this once and written it down. `search-perf-app` slept
1200 ms against a `SIDEBAR_SEARCH_DEBOUNCE_MS` of 2000 and therefore **could never pass**
— it reported nothing about search for as long as it was written that way. The lesson is
recorded in `docs/for-agents.md` and was then not applied anywhere else. 408 fixed sleeps
remain.

**Rule to enforce:** never sleep for a duration; poll for the state the assertion depends
on. A sleep that has been re-tuned once will be re-tuned again.

### 1.5 Fault D — assertions that had stopped meaning anything

All three red suites investigated today were suite debt. None had a defect behind it.

- **`annotations-app`** — drove a note edit that commits from a `blur` handler, with the
  app in the background. Chromium does not dispatch focus/blur to a document that lacks
  focus; `activeElement` still moves, so the page looks correct and no event is ever
  delivered. Measured: `hasFocus()` false → `blurFired: 0`, mark untouched; after
  `bringToFront()` → `blurFired: 1`, note committed. **Notes persist correctly.** Fixed;
  25/25.
- **`privacy-app`** — looked for the extracted book in the *application folder*. The cache
  moved to the per-user state dir deliberately (`EpubReader.CacheRoot`), because
  extracting beside the exe makes the install directory writable-by-requirement, which it
  is not under MSIX; the host now actively sweeps any legacy copy. Only the **control**
  caught it. The privacy assertion itself — "nothing named appears" — had become
  **vacuous**, passing because nothing is written there by anyone. Fixed; 21/21.
- **`epub-open-app`** — verified SVG-wrapped covers with `fetch()`, but `MapBookHost` maps
  `localbooks` with `DenyCors`, so a fetch from the `localapp` origin is refused *by
  design*. Every such cover was reported broken while sitting legible on screen. Replaced
  with an `Image()` load, which is how an `<image>` element gets its bytes anyway;
  verified it keeps its teeth (real URL loads 510×680, absent file still errors).

**Generalisation worth acting on:** `privacy-app` was the only suite with a control, and
the control is the only reason its vacuity was ever visible. Any suite asserting that
something *did not happen* needs a control proving the mechanism can happen at all.

### 1.6 The one genuine open item

**`epub-open-app` still fails on the Xeelee omnibus.** After the polling fix it now gets
through the cover checks it had never reached, and fails in 25s with
`page never answered after 8 attempts over 25s (main thread busy)` instead of an opaque
180s `ProtocolError`. Full run is 4m18 rather than timing out around 7m.

The page genuinely becomes unresponsive, but **only in the full suite sequence** — it did
not reproduce in any isolated replication, including per-book process isolation, the exact
open sequence, and driving to the front of the book then seeking to 60%. My working theory
is that it is an artifact of the accumulated waterfall (§1.3), and that the restructure
will dissolve it. That is a theory, not a finding.

**Do not** raise `protocolTimeout` again. It has been tried at 600s and it does not work.

---

## 2. Silent failure is the default (highest-value non-test item)

```
~580 empty catch blocks in js/modules/*.js
 243 empty catches in TypoZen_App.cs, 13 in EpubReader.cs
   0 window.onerror handlers
   0 unhandledrejection handlers
   5 console.error/warn calls across ~20,000 lines of JS
```

An exception in the page has nowhere to go. It is swallowed by an empty catch, or it dies
in a console nobody sees — DevTools only opens under `--debug`.

This is not theoretical. Three separate failures with exactly this shape occurred in one
day: `jumpToModelBlock`/`goToHeadingAnchor` nested one scope too deep (compiled, gate
passed, feature silently dead — caught only by calling it from a test);
`syncModeSurface` clearing marks while `state.mode` still said `source`; a mirror layer
holding a stale width. Each was found by a human noticing something looked wrong, which is
the most expensive detector available.

**The infrastructure already exists and is unused.** `window.addDebugLog` lives in
`03-shell.js`; the host has a `--debug` log gated on `Program.DebugLogEnabled`. Nothing
routes uncaught errors into either.

**To do (small, high leverage):** wire `window.onerror` and `unhandledrejection` into
`addDebugLog`, and forward to the host log when `--debug` is on. Roughly fifteen lines. It
converts an entire class of invisible failure into something readable after the fact. Do
this before anything else in this document except §1.

---

## 3. Test-only code compiled into the shipped binary

`RunTabContentE2EAsync` is **1,713 lines** — about 13% of `TypoZen_App.cs` — compiled into
the shipped 342 KB executable and activated at runtime by the `TYPOZEN_TAB_E2E`
environment variable, which also disables session restore.

This is the same class of problem as the disk-prompt stubs (`TYPOZEN_DISK_PROMPT` /
`TYPOZEN_SAVE_AS_PATH`), which were gated behind `Program.DebugLogEnabled` earlier today
precisely because an environment variable left in a shell would otherwise steer a shipped
build. That one was ~30 lines. This one is 1,713 and is still ungated.

**To do:** gate the `TYPOZEN_TAB_E2E` entry point on `Program.DebugLogEnabled` for
consistency. Longer term, consider whether an in-process harness of that size belongs in
the product binary at all.

---

## 4. Coverage gap — the native reader

```
localview: 7 references in TypoZen_App.cs, 0 references in tests/
```

An entire user-facing surface with nothing watching it. Every other surface has suites.

**To do:** a `localview-app.mjs` covering at minimum: the window opens, it renders the
document, navigation works, and it closes without stranding state.

---

## 5. Smaller, bounded items

**`ExecuteScriptBlocking` / `PushFrame` re-entrancy.** The guard is *correct* — I checked
it properly: `_scriptBlockDepth` is tested before the `try`, so the `finally` cannot
over-decrement, and nested calls return `null` immediately. The residual hazard is
inherent to `Dispatcher.PushFrame`: it pumps the message loop, so timers, input and web
messages run *inside* the call and can change state underneath it. 11 call sites. Short
timeouts mitigate. **To do:** note the hazard at the call sites; do not attempt to remove
`PushFrame` without a strong reason.

**`CoreWebView2_WebMessageReceived` is 740 lines** of dispatch, and is where the `open_doc`
deadlock happened. **To do:** split it, mostly so the "never call blocking work from in
here" rule has somewhere to live.

**Source-mode search overlay has no document-size guard.** The mirror holds a second copy
of the text and doubles Source-mode layout while a search is active. `SRC_HL_MAX_MARKS`
caps marks at 8,000 but nothing caps document size, and the app has no file-size limit
anywhere. Bounded (2× on an already-linear path, only during a search) but cheap to guard.

**Release tooling is the least-tested path in the project.** `tools/Build-Portable.ps1`
was broken outright — `$tpl` went null when the Bookerly-stripping block was deleted, and
`Select-String` threw before the script reported anything. It was found by cutting a
release, which is the worst moment to discover it. Nothing exercises the release tooling
except a human at release time. **To do:** a smoke check that runs the portable build and
asserts the output tree, on the gate.

**Mutex fail-open.** If creating the secured mutex throws, the catch sets
`createdNew = true` and proceeds. Worst case is two instances. Probably deliberate; worth
a comment either way.

---

## 6. Already fixed today — do not redo

| commit | what |
|---|---|
| `e7dc73b` | Source selection painted in the theme accent (superseded in value by `d04017f`) |
| `d04017f` | Source-mode search highlighting via a mirror layer; `source-highlight-app.mjs` |
| `d2729ec` | Three real bugs in that feature: Alt+S left marks, keyboard nav didn't move the ring, pane resize slid every mark |
| `684bb94` | Pipe/mutex scoped to the user's SID with ACLs; `open_external` via `Uri.TryCreate`; build script no longer hard-kills the editor |
| `f30f7e1` | The three suite-debt fixes in §1.5; recorded the omnibus stall in `known-issues.md` |
| `1c104d3` | `evalPatiently`; `epub-open-app` cover stage driven from the runner |

Two of those deserve emphasis because they were **silent data-loss risks in shipped code**:

- `Build_TypoZen.ps1` used `Stop-Process -Force` on *every* TypoZen on the machine —
  including the instance running from `OneDrive\Apps\TypoZen`, the real editor, which
  holds no lock on the build output. `TerminateProcess`, no `WM_CLOSE`, no save prompt. It
  ran about a dozen times in one session. Now scoped by `MainModule.FileName` and asks
  with `CloseMainWindow()` first.
- `TrySaveAsStub` was consulted in `SaveTabNow` — the *general* Save As path — and returned
  true whenever `TYPOZEN_DISK_PROMPT` was set. In a shipped build with that variable in the
  environment, File → Save As, saving an untitled document, and Export Book As would each
  return false with no dialog and no message.

**Correction on the record:** an external audit (Antigravity) reported the pipe/mutex
finding and I initially called it wrong, because I checked the working tree — where it had
already applied its own fix — instead of the committed history. `git log -S"PipeSecurity"`
returned nothing, which was the check that settled it. Verify findings against history,
not the file on disk, when another agent has touched the tree.

---

## 7. Suggested order

1. **§2 error visibility** — ~15 lines, makes everything after it cheaper to diagnose.
2. **§1.2/§1.4 sleeps → polling**, suite by suite, biggest first. Reclaims most of 610s
   and removes most flakiness.
3. **§1.3 break the waterfalls**, starting with `epub-open-app`. Expect §1.6 to resolve
   here; confirm rather than assume.
4. **§3 gate `TYPOZEN_TAB_E2E`.**
5. **§4 native reader suite.**
6. **§5** as capacity allows.

## 8. Standing rules worth keeping

- Never sleep for a duration in a test; poll for the state the assertion depends on.
- Never park a sleep inside `app.eval`. One evaluate, one short question.
- Any assertion that something *did not happen* needs a control proving it can.
- A red suite is more often a stale contract than a defect — three for three today — but
  verify that per suite rather than assuming it.
- Never raise `protocolTimeout` to make a stall go away. It has been tried at 600s.
- When another agent has edited the tree, check `git log -S`, not the working file.
