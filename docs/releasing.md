# Releasing TypoZen

How a change becomes a release, and the things that have gone wrong doing it.

This file is **public**, like the rest of the repository. Keep account-specific detail —
dashboard URLs, local paths, machine names — in `docs/internal/` instead, which is
ignored by git. Anything here should be true and useful to a stranger.

`README.md` is the product's public face: what TypoZen is and how it behaves. This is the
operational counterpart, and the two should not overlap. If you are tempted to explain
build machinery in the README, it belongs here.

---

## 1. The loop

One version number, one gate, one deploy target. In order:

| Step | Command | Notes |
| --- | --- | --- |
| Bump | edit `AppVersion` in `TypoZen_App.cs` | the single authority; everything else derives from it |
| Build + gate | `.\Build_TypoZen.ps1` | runs the headless suites, compiles, stages assets to `bin/` |
| Portable | `.\tools\Build-Portable.ps1` | assembles `dist/` |
| Package | `.\tools\Build-Msix.ps1` | writes `dist-msix\TypoZen.msix`, unsigned |
| Deploy | copy `dist\*` over the run location | see `docs/internal/` for where that is |
| Zip | `Compress-Archive -Path dist\* …` | archive it; shipped zips are never deleted |
| Release | `gh release create vX.Y.Z <zip> --notes-file …` | |

**Do not skip the gate to save time.** It is 58 headless suites and takes seconds; it is
not what makes a release slow.

**`bin/` is staging, not disposable.** It exists so a build can be proven before it
reaches the run location. `obj/` is the disposable one.

### Version numbers

`AppVersion` is a three-part string (`"0.2.41"`). The Store requires the fourth part of a
package version to be `0`, which `Build-Msix.ps1` appends. A Store submission must have a
strictly higher version than the last one accepted.

---

## 2. What the build actually stages

`Build_TypoZen.ps1` copies `css/`, `js/`, `fonts/` and the template, themes, XAML and icon
into `bin/` alongside the exe. **All of these are read from disk at runtime**, so an exe
without them is not a build.

This list has been wrong twice, and both times the symptom was the same: a fix that
appeared to do nothing because it never reached the running app.

- `css/` was missing once, and a source-mode CSS fix was tested against a `bin/` that had
  never received it.
- `fonts/` was hand-populated, so `fonts/OFL.txt` — which the SIL Open Font Licence
  requires to travel with the faces — shipped nowhere for months.

If you add a runtime asset directory, add it to `$assetDirs`. Do not copy it by hand.

`TypoZen_Template.runtime.html` is **generated at startup** from the real template and
must not be shipped; a zip containing it is shipping a stale artefact.

---

## 3. Tests

Two tiers, and the distinction matters more than the count.

**The gate** — 58 suites, headless, invisible, seconds. Runs inside `Build_TypoZen.ps1`.
Everything that can be tested this way should be.

**The app tier** — `tests/*-app.mjs`, run with `RUN_APP_E2E=1`. These launch the real
executable and drive a **visible window on the developer's screen** for minutes. They are
not part of the gate and must not be run casually.

Risk-based, not exhaustive: run the app-tier suites that cover what you changed. Running
the native-reader suite because you edited a wheel handler wastes someone's machine for
twenty minutes and tells you nothing.

### Things that have made app-tier suites lie

- **`evalPatiently` can return null while the thing is plainly happening.** Prefer an
  explicit polling loop when a wait matters.
- **WPF submenus populate when opened**, so a menu read that lands early returns a partial
  list — an item simply missing, which reads as "disabled" and is neither. Ask again until
  the count stops growing.
- **A modal dialog blocks the harness.** `_e2eMode` suppresses some, not all.
- **Assert on the mechanism, not a proxy.** A suite that deletes a staged file and reopens
  a document proves nothing, because opening re-stages a fresh one and takes the ordinary
  path.
- **Control-verify anything load-bearing.** Break the fix, rebuild, watch the suite go
  red, restore. A test that passes against a broken build is worse than no test.

---

## 4. MSIX and the Store

The package is **unsigned**. It therefore cannot be installed by double-clicking, and
must not be offered alongside the portable zip: a user who downloads it gets a
certificate error and no app. Its only destination is the Store, which signs it on
submission. To test locally you need Developer Mode and `Build-Msix.ps1 -Register`.

### Submission gotchas, all learned the hard way

- **Restricted capabilities is a hard 500-character box** that stops accepting input
  silently, mid-word, with no warning. Paste-ready text of exactly 500 is in
  `docs/store-listing.md`.
- **"Notes for certification" on the Submission Options page is a link, not a box.** It
  points at the separate Additional Testing Information page.
- `runFullTrust` raises a validation warning on every packaged desktop app. Expected;
  answer it rather than removing the capability.
- **Store logos are optional** — the Store falls back to the tile logos inside the
  package. But 9:16 Poster art is the main logo on Windows 10/11, and a stretched 310px
  tile looks like one. `tools\Build-StoreArt.ps1` draws the three listing images.
- **16:9 Super hero art must not contain the product's title.** It is a requirement, not
  a style note.
- Xbox images, Short title and Voice title are Xbox-only. Skip them for a desktop app.
- **Do not upload a new package while a submission is in certification.** Fixes go into
  the next submission.

Listing copy, field limits and the certification answers live in
[store-listing.md](store-listing.md).

---

## 5. Install identity — read before touching it

A packaged copy and a portable copy are **different installs of the same app on one
machine**, and they must not recognise each other.

Both the single-instance mutex and the file-open pipe were once keyed to the user's SID
alone. The result: launching the Store copy while the portable one was running handed its
command line down the pipe to the portable instance and exited, so the Store icon
appeared to do nothing while another install's window came forward.

The identity is resolved at runtime, not compiled in:

```
GetCurrentPackageFamilyName()  ->  APPMODEL_ERROR_NO_PACKAGE  ->  "_Portable"
                               ->  a family name              ->  "_" + name
```

That one value suffixes the mutex name, the pipe name and the profile folder
(`TypoZen_Cache…`). Every failure path resolves to portable, deliberately: an install
that cannot name a package is treated as a folder someone unzipped.

**Two rules follow.**

1. **The discriminator must be non-empty on both sides.** A first attempt gave one only
   to the packaged build. Against a package already published without one, an unpackaged
   build computing the empty string matches it byte for byte and the collision survives
   untouched. Whichever side can still move is the side that must carry it.

2. **Identity and profile move together.** A packaged `Windows.FullTrustApplication` is
   *not* redirected — it writes to the real `%LOCALAPPDATA%`. Splitting the identity
   alone lets two instances run at once over one profile, and the state files are written
   whole. They are written atomically, so nothing corrupts; they are still
   last-writer-wins, so the copy that closes second silently reverts the other's settings,
   session and reading positions. That is worse than the bug being fixed.

Because the profile folder moves, **the first run after a split migrates the shared
profile into the new one** — named files only, not the WebView2 store or the book
extraction cache. An update that silently empties someone's app is not an acceptable cost
of a correctness fix.

`TYPOZEN_PKG_FAMILY` is a test seam of the same shape as `TYPOZEN_PROFILE_DIR`, honoured
only when the real API has already reported no package, so it can never mask a genuine
identity. Without it none of the packaged behaviour is observable outside a registered
MSIX.

---

## 6. Licences that must ship

| Component | Licence | File |
| --- | --- | --- |
| TypoZen | MIT | `LICENSE` |
| Inter, Literata, Merriweather, Source Sans 3 | SIL OFL 1.1 | `fonts/OFL.txt` |
| Dictionary and thesaurus data | WordNet | `WORDNET-LICENSE.txt` |

The OFL permits bundling **and selling** these faces with software, on the condition that
the notice and licence travel with them — which is why `fonts/OFL.txt` is in every build
and not only in the repository. Copyright lines in it are reproduced from each font
file's own `name` table rather than typed.

---

## 7. Claims in the product must be true

The About dialog once said "over 150,000 offline definitions" when the file held 147,478,
and "40,000+ block documents" — a figure that came from a design aspiration in a planning
document, not a measurement.

Both were found by checking About against the build before reusing its wording for the
Store listing. Any number stated in About, the README or a listing should be verifiable
from the tree in one command. `docs/store-listing.md` records where each of its figures
comes from.
