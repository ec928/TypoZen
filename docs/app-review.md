# TypoZen app review (0.2.7)

Review of the current tree as of 2026-08-26, with a follow-up pass that landed the
fixes below. Characterised against source, not suite folklore. `known-issues.md`
listed no open defect-class items; several of the same *projection-for-document*
family were still live and are now closed.

**Verdict:** a serious Windows prose editor/reader, not a toy. Pagination, epub fidelity, privacy, fail-closed tabs, and the test gate are above typical indie quality.

The two clusters from the first pass are closed in this tree (see Results). Left for later: splitting `TypoZen_App.cs` / `02-layout.js`, dictionary load off the UI thread, named-pipe token, git-tracking of binaries.

## Results (fix pass)

| # | Item | Status |
|---|---|---|
| 1 | Select All + Cut / Delete | **Fixed.** `selectionIsWholeEditor` + `replaceWholeDocumentFromModel`. |
| 2 | Export as HTML dumps the window | **Fixed.** `generateExportHtml` renders every `DocumentModel` block. |
| 3 | OpenBook skips fail-closed pull | **Fixed.** Same `SyncActiveTabFromEditor` gate as `OpenNative`. |
| 4 | Zip-slip prefix | **Fixed.** Trailing-separator check in `EpubReader.ExtractIfStale`. |
| 5 | Privacy staging next to the exe | **Fixed.** `https://localload/` under `CacheDir()` / privacy TEMP. Legacy `_appDir/typozen_load` swept at launch. |
| 6 | No navigation allowlist | **Fixed.** `NavigationStarting` + `NewWindowRequested` on both WebViews. |
| 7 | Resolver MAP missing book/native | **Fixed.** `localbooks`, `localview`, `localload` pinned to loopback. |
| 8 | Dictionary `bodies` → `body` | **Fixed.** `ies` → `y` stem. |
| 9 | Bookerly in portable zip | **Fixed.** `Build-Portable.ps1` allowlists OFL faces and fails if Bookerly is in `bin/fonts`. |
| 10 | Book sanitizer leaves `<style>` | **Fixed.** `style` on the kill list. |
| — | Replace on a book | **Fixed.** Replace controls hidden/disabled; `applyReplacedDocument` no-ops. |
| — | Page-total README ratchet | **Fixed.** README matches `known-issues.md`; `~` on 2-col / scrubber. |
| — | Print “paragraphs” | **Fixed.** Copy says “blocks”. |
| — | Stale Ctrl+/ comment | **Fixed.** |
| — | Split the two monoliths | **Deferred.** Mechanical extract, high regression cost; not this pass. |

---

## Bugs

### 1. Select All + Cut / Delete on a long document — **fixed**

Copy was fixed. Cut and Delete were not.

`Ctrl+A` selects `#editor` contents. Under virtualisation that is ~54 of 3767 blocks. Copy notices that and answers from `DocumentModel`. Cut only treats the gesture as multi-block if both ends resolve to a `.block`. `getAncestorBlock` stops at `#editor`, so Select All is **not** multi-block. The browser then:

- puts the **window** on the clipboard
- blanks the view
- leaves the model intact, so Save still writes the full file

Same hole for Backspace/Delete after Select All. `known-issues.md` already measured Cut; it is still in `js/modules/05-model.js` (~2701) and `js/modules/04-lists.js` (~412). `clipboard-roundtrip-browser.mjs` asserts Copy + save, not Cut.

**Fix:** if `selectionIsWholeVirtualDocument(range)`, `preventDefault`, write `DocumentModel.toMarkdown()` (omit HTML, as Copy does), then clear or delete via the model. Same treatment for host `cmd:cut`. Extend `clipboard-roundtrip-browser` with a virt premise (`mounted < model.blocks.length`) for Cut and Delete.

---

### 2. File → Export as HTML still dumps the window — **fixed**

Print refuses a partial DOM. Export does not.

```js
// js/modules/07-stats-host.js — generateExportHtml()
const content = editor.innerHTML;
```

On a long file this is the same silent 1% artefact print was refused for. Wired from `export_html` in `js/modules/03-shell.js`. No README claim covers this menu item.

**Fix:** reuse the print probe (`EditorDomPartialForPrint`) and refuse, or render from `DocumentModel` (markdown → HTML for `.md`; book blocks already hold HTML).

---

### 3. Opening an epub can drop unsaved editor work — **fixed**

Markdown and native opens fail-closed: they pull the current tab before retargeting. `OpenBook` does not.

`LoadFileFromPath` branches to `OpenBook` before any sync (`TypoZen_App.cs` ~10408). `OpenBook` then changes `_activeTabIndex` and navigates the WebView (~10658). The previous tab’s `Content` is whatever was last pulled. Dirty live markdown is gone from the DOM.

`OpenNative` already does `SyncActiveTabFromEditor` + abort on failure (~10769). Books should use the same shape: do not add or retarget the book tab until the pull succeeds.

---

### 4. Epub extract zip-slip check is weaker than image load — **fixed**

```csharp
// EpubReader.cs ExtractIfStale
string dest = Path.GetFullPath(Path.Combine(dir, e.FullName.Replace('/', Path.DirectorySeparatorChar)));
if (!dest.StartsWith(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase)) continue;
```

`StartsWith` without a trailing separator lets `dir + "_evil\\…"` and `dir + ".js"` through. `image_data_req` already uses the trailing-separator form (`TypoZen_App.cs` ~4707). Blast radius is sibling files under `typozen_books`, which `localbooks` then serves.

**Fix:** copy the `image_data_req` prefix check (`rootPrefix` with a trailing `DirectorySeparatorChar`).

---

### 5. Privacy Mode still writes document bytes next to the exe — **fixed**

The contract (`TypoZen_App.cs` ~7142, README Session & privacy): while on, nothing that names a document or its contents hits disk. Extraction is redirected to `%TEMP%`. Staging is not.

Large markdown and every book payload still land in `_appDir/typozen_load/` (`TypoZen_App.cs` ~7348, ~10692). That folder is mapped as `https://localapp/…`. The template-stamp comment notes the app dir can be OneDrive-synced. Sweep is 5 minutes, on close or the next large open — not at launch — so a crash leaves the payload.

**Fix:** stage under `CacheDir()` / the privacy TEMP root, and sweep `typozen_load` at startup.

---

### 6. Neither WebView has a navigation allowlist — **fixed**

There is no `NavigationStarting` or `NewWindowRequested`. Link clicks in `#editor` are intercepted in JS (`04b-format.js` ~1775) and `open_external` is scheme-restricted. That is not an allowlist. A book sanitizer miss, `window.location`, or native HTML can leave `https://localapp/…`. After that, `WebMessageReceived` still accepts `open_doc:`, `save_prefs:`, `image_paste:`.

`docs/archive/PR_PLAN.md` marked this done (PR7). The current tree does not have it.

**Fix:** allow only `localapp` / `docfolder` / `localbooks` (editor) and `localview` / `about:blank` / `data:` (native). Cancel the rest; treat `NewWindowRequested` the same way.

---

### 7. Book and native hosts are not DNS-pinned — **fixed**

`--host-resolver-rules` maps `localapp` and `docfolder` because unmapped virtual hosts cost ~2 s NXDOMAIN per navigation (`TypoZen_App.cs` ~4109, comment ~4150). `localbooks` and `localview` were added later and never pinned. Opening an epub or PDF can reintroduce the delay already measured.

**Fix:** `MAP localapp, docfolder, localbooks, localview 127.0.0.1`.

---

### 8. Dictionary does not stem `bodies` → `body` — **fixed**

README claims `walking` → `walk`, `bodies` → `body`. `dictionary.tsv` has `body`, not `bodies`. `WordStems` (`TypoZen_App.cs` ~2535) only strips `s` / `es` / `ed` / `ing` / `ly`, so `bodies` becomes `bodie` and `bodi`.

**Fix:** add `ies` → `y` (and ideally ingest WordNet’s `.exc` files in `tools/Make-Dictionary.ps1`). The script comments still say the dictionary is not bundled; it is.

---

### 9. Bookerly ships in the redistribution path — **fixed**

README is explicit: Bookerly is Amazon’s; strip `fonts/Bookerly*.ttf` and the `@font-face` block before distributing. `tools/Build-Portable.ps1` copies all of `fonts/`. The four Bookerly files are git-tracked.

**Fix:** allowlist Inter / Literata / Merriweather / Source Sans 3 in the portable script, and fail if Bookerly would land in `bin/`. Keep Bookerly only in a private local override.

---

### 10. Book HTML sanitizer leaves `<style>` — **fixed**

`sanitizeBookHtml` (`js/modules/06-render-epub.js` ~1291) kills `script`, `iframe`, handlers, `javascript:`. It does not kill `<style>`. Publisher CSS is already applied scoped via `#book-styles`. A chapter `<style>` assigned with `innerHTML` is document-global (find bar, overlays, chrome).

**Fix:** add `style` to the kill list; keep styles on the scoped pipeline only.

---

## Suggestions

| Priority | What | Why |
|---|---|---|
| High | Close Cut/Delete/Export the way Copy/Print were closed | Last “DOM is the document” write paths |
| High | Split `TypoZen_App.cs` (~11k) along existing seams: WebView bridge, tabs/fail-closed open, native reader, session/privacy, in-process E2E (~1.7k lines of `TYPOZEN_TAB_E2E` inside the shipping `Window`) | The OpenBook miss happened because book open is a sibling of native open, not the same function |
| High | Split `02-layout.js` (~6k): find, marks, page-window | Header still says it is lines 499–3027 of the old monolith |
| Medium | Load `dictionary.tsv` / `thesaurus.tsv` (~19 MB) off the UI thread | First lookup runs inside `WebMessageReceived` |
| Medium | Disable Replace for books | `applyReplacedDocument` remounts an epub and can report “Replaced N” without rewriting publisher HTML |
| Medium | Print refusal: themed overlay, say “blocks on screen”, not WinForms “paragraphs” | Help/About already use `openTzOverlay` |
| Medium | README still says page totals **only grow** | Code and `known-issues.md` reverted that ratchet; 2-column / scrubber hide `~` in a tooltip |
| Medium | README “Phase 6 under Outstanding work” | Phase 6 (ZenSeek `--reader --search`) is done. Phase 7 — strip ZenSeek’s reader — is the leftover product goal |
| Low | Drop the stale “Mode can change from Ctrl+/” comment (`03-shell.js` ~1719) | Removing the shortcut was deliberate; Mode stays on the toolbar |
| Low | Narrow virtual hosts (`DenyCors`; map `localbooks` to the current book, not the whole cache) | Shrinks sanitizer-miss blast radius |
| Low | Don’t git-track `TypoZen.exe` / WebView2 DLLs | Tracked files mix sources and binaries |

Mode having no keyboard shortcut is a **product choice**, not a gap. Do not revive Source-only `Ctrl+/`. If a shortcut is wanted later, cycle all three states and show the new mode on the toolbar.

Markdown support limits (no math, no Mermaid, nested-list edges) are documented and fine for this product.

---

## What is already in good shape

- **DocumentModel as authority**, flush-before-leave, no length heuristics, model indices under virt, height-map splice rather than discard.
- **Atomic save**, overwrite-loss prompt, never write engine text over `.epub` / native.
- **Copy of Select All** from the model; **Print refuses** a windowed layout rather than emitting a fake PDF.
- **Epub as HTML**, not a Markdown conversion; URL rewrite per spine document; plate vs thumbnail; body-size correction.
- **Privacy Mode** as one switch that disables the toggles it subsumes (staging aside).
- **Link policy:** only `http` / `https` / `mailto` to the shell; paths open as documents.
- **Test culture:** jsdom gates the build; browser suites exist because layout lied; `*-app.mjs` is opt-in and uses throwaway profiles. That is why so many past defects are characterised rather than rumoured.

Not treated as defects (product truth):

- Page total marked `~` until laid out (the estimate itself).
- Print refusing large windowed docs.
- Gutenberg gutter = bookmarks only.
- Fence highlight via CSS Custom Highlight API only (not a code editor).
- Parked developer-editor / code-kind work (`docs/developer-editor-analysis.md`).

---

## Suggested order of work

1. Select All Cut/Delete + HTML export (same invariant, user-visible data).
2. `OpenBook` fail-closed sync (data loss).
3. Zip-slip prefix + Privacy staging + navigation allowlist + resolver MAP (security / privacy).
4. Strip Bookerly from portable builds.
5. Dictionary `ies` stem + `<style>` kill + README ratchet / Outstanding-work lines.
6. Only then split the two monoliths — as a mechanical extract, not a rewrite.

---

## Scope of this review

Read: `TypoZen_App.cs`, `EpubReader.cs`, `TypoZen_Launch.cs`, `TypoZen.csproj`, `TypoZen.xaml`, `tools/Build-Portable.ps1`, `Build_TypoZen.ps1`, `js/modules/*`, `css/typozen.css`, `TypoZen_Template.html`, `README.md`, `docs/known-issues.md`, `docs/for-agents.md`, `docs/native-reader-plan.md`, `docs/developer-editor-analysis.md`, `docs/archive/Overall Goals for TypoZen.txt`, `docs/archive/PR_PLAN.md`.

**Verification (fix pass):** default jsdom + browser gate (`tests/run-tests.ps1`) — 53 suites, all passed, including `clipboard-roundtrip-browser` (Select All copy + cut + export on a virtualised document) and `epub-model-selftest` (`<style>` stripped). `TypoZen.exe` rebuilt with `Build_TypoZen_NoTest.ps1`. `privacy-app.mjs` passed (21/21), including “nothing named appears in the application folder” with a book open.
