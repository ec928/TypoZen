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
| Installer | `.\tools\Build-Installer.ps1` | writes `dist-installer\TypoZen-Setup-X.Y.Z.exe` |
| Verify it | `.\tools\Test-Installer.ps1` | ~15s; installs, hash-checks, uninstalls |
| Deploy | run the setup exe silently | see **Deploying a build** below |
| Zip | `Compress-Archive -Path dist\* …` | archive it; shipped zips are never deleted |
| Release | `gh release create vX.Y.Z <zip> <setup.exe> --notes-file …` | |

**Do not skip the gate to save time.** It is 58 headless suites and takes seconds; it is
not what makes a release slow.

**`bin/` is staging, not disposable.** It exists so a build can be proven before it
reaches the run location. `obj/` is the disposable one.

### The installer

`tools/TypoZen.iss` builds an ordinary Windows installer from the same `dist/` payload as
the zip, for users who want a Start Menu entry and an uninstall entry. It is **per-user**
(`PrivilegesRequired=lowest`), installs to `%LocalAppData%\Programs\TypoZen`, and
raises no UAC prompt — which also means it works on a locked-down machine, where a
machine-wide installer does not.

It is **unsigned like everything else here**, so it does not reduce the two warnings a
downloader clicks through; it only improves what they have afterwards. Unlike the MSIX it
*is* safe to publish beside the zip: an unsigned installer runs after a SmartScreen
override, whereas an unsigned MSIX cannot be installed at all.

`AppId` in the `.iss` is a fixed GUID. **Never change it** — it is how Windows
recognises an upgrade rather than a second copy.

**`Test-Installer.ps1` backs up the Start Menu shortcut, and that is not paranoia.**
`[Icons]` writes to `{autoprograms}`, the real per-user Start Menu, no matter what `/DIR`
says on the command line, and it silently overwrites what is already there. `/NOICONS`
does not prevent it: that switch only ticks a checkbox on the wizard page this installer
disables. A silent test install therefore clobbers the developer's own TypoZen shortcut,
and the uninstall that follows deletes it. That happened on 2026-09-15, and the shortcut
had to be rebuilt by hand from the sibling apps' pattern.

The same run first reported the optional tasks as correctly skipped while it was in fact
reading a desktop shortcut that had been there since July — the check could not have
failed. Assertions about shortcuts and file associations must compare against a snapshot
taken *before* the install, and be control-verified with the tasks switched on.

### Deploying a build

**Deploy by running the real installer silently, not by copying files over the installed
folder:**

```
.	ools\Build-Portable.ps1
.	ools\Build-Installer.ps1
dist-installer\TypoZen-Setup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="assocmd,assocepub"
```

A locally built exe carries no Mark of the Web, so nothing prompts and no window appears.
It costs about 25 seconds more than a file copy and keeps Windows' own record honest:
files, registry, file associations, shortcuts and the Settings -> Apps entry all end up
describing the build that is actually installed. Copying files over the top updates the
app but leaves the installed version, so Settings reports a version nobody is running.

Pass `/TASKS` explicitly. Inno remembers wizard selections for a repeat install, but what
it does with them in silent mode is unverified here -- state the tasks rather than find
out.

**Check which executable the tester's shortcut actually launches before asking anyone to
test anything.** Several copies of this app can exist at once -- the compile output in the
project root, the staging copy, and the installed one -- and running the installer
repoints the Start Menu and desktop shortcuts at the installed copy without saying so. A
bug was once reproduced twice against a build that did not contain the fix under test,
because the shortcut had silently moved. Neither party noticed.

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

- Root-level files that ship -- the licences, the dictionary and thesaurus, the WebView2
  DLLs -- were not staged at all. `bin/` held hand-copied ones from an earlier publish and
  kept them, so a corrected licence sat in source while staging served the stale copy.
  That one mattered beyond tidiness: `Build-Msix.ps1` packs `bin/` while the zip is built
  from the project root, so the Store package and the portable zip could ship different
  bytes of the same file.

If you add a runtime asset directory add it to `$assetDirs`, and a root-level file that
ships to `$assetFiles`. Do not copy either by hand.

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
- **Seeding state at launch is not the same as exercising the control.** `privacy-app.mjs`
  writes `window_state.json` and launches with Privacy Mode already set. It proves the
  flags are honoured, and it passed for months while *toggling* the mode mid-session broke
  document loading in both directions. Nothing tested the switch a reader actually flips.
- **`TogglePattern.Toggle()` on a checkable WPF menu item does not raise `Click`.** It
  flips `IsChecked` directly, so a handler wired to `Click` never runs: the menu shows the
  new state while the application is still in the old one. That is a state no user can
  produce, and a test built on it verifies nothing. Only a real click exercises the path.
- **Measure the element the product actually renders into.** Book text lands in `#editor`,
  not `#editor-wrapper`. A probe on the wrong element reported zero characters for every
  book, which reads exactly like a failure and would pass silently if the assertion were
  inverted.
- **Run a control before believing a negative.** A bespoke launcher used to chase one bug
  turned out not to open books at all, so every "book did not load" reading from it was
  meaningless. One run against a known-good path exposed that in seconds.
- **Prefer the harness over a hand-rolled launcher.** It resets a throwaway profile,
  attaches over the debug port and waits properly. Reproducing those steps by hand is how
  the two faults above were introduced.

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

2. **Identity and profile move together**, so the two always agree about which install a
   profile belongs to, and a folder name says which copy wrote it.

   This rule was first written on a claim that turned out to be false: that a packaged
   `Windows.FullTrustApplication` is *not* redirected and writes to the real
   `%LOCALAPPDATA%`, so both copies shared one profile. Registering 0.2.44 and running it
   showed the packaged process redirected into
   `%LOCALAPPDATA%\Packages\<family>\LocalCache\Local\` — read off the `--user-data-dir`
   of its own WebView2 children — so a packaged copy never saw the portable profile.
   What genuinely *was* shared is the single-instance mutex and the open-file pipe: named
   kernel objects, not redirected, and the collision that was actually reported.

   The first-run migration below therefore only ever does real work for the **portable**
   build, the only one that can read the old shared folder. A packaged first run finds
   nothing and starts clean, which is what the registered test run did.

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
