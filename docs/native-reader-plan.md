# Native Reader — Chromium-backed files (implementation plan)

**Status:** v1 implemented (host dual WebView + classify + open/session/save guards).  
**Product home:** read-only **reading**, same family as Reader mode and epub — not a third product called “Viewer,” and not the editable Preview/Source path.

This plan covers **all** formats Chromium will paint for us in v1: **PDF, images, and media** under one tab kind and one surface. Do not ship PDF-only plumbing that hard-codes `.pdf` into every branch.

---

## 1. Why a plan

Medium host work (tab kind, dual surface, chrome policy, open/session/save rules) across many call sites that already special-case epub. Wrong abstraction = rewrite when images/video land. One design, one open path, format only chooses **how to navigate**.

Not justified: a full design-doc consensus loop. This document is the PR guide.

---

## 2. Product model (three document families)

| Family | Examples | Surface | Modes | Dirty / save |
|--------|----------|---------|-------|----------------|
| **Editable engine** | `.md`, `.txt`, … | Editor WebView + template | Source / Preview / Reader | Normal |
| **Book (engine, read-only)** | `.epub` | Editor WebView + book HTML | **Reader locked** | Never |
| **Native (Chromium, read-only)** | PDF, image, audio/video | **Native Reader WebView** | **Reader locked** (chrome only; no engine mode) | Never |

`.txt` stays **editable engine** (default **Preview** if we change that policy — separate micro-change). Chromium’s plain-text view is not used for notes.

User-facing language: still **Reader** / reading. Internally: `DocKind = Engine | Book | Native`.

---

## 3. Formats in scope (v1)

Classify by extension (and optional content-type later). One table in host code.

### PDF
| Ext | Role |
|-----|------|
| `.pdf` | `NativeRole.Pdf` |

Navigate to mapped URL; Chromium PDF viewer (search/zoom/pages inside the surface).

### Images
| Ext | Role |
|-----|------|
| `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` `.ico` `.svg` `.avif` `.jfif` | `NativeRole.Image` |

**Navigate strategy:** themed fit-to-pane HTML shell (`NavigateToString` + centered `<img>`). Direct Chromium image-URL navigation was tried and reverted — slow open, weak right-click-only magnify.

### Media
| Ext | Role |
|-----|------|
| **Video:** `.mp4` `.webm` `.ogv` `.mov` (best-effort; codec = Edge) | `NativeRole.Video` |
| **Audio:** `.mp3` `.wav` `.ogg` `.m4a` `.flac` (best-effort) | `NativeRole.Audio` |

**Navigate strategy:** minimal HTML shell:

```html
<video src="…" controls controlslist="nodownload" …>
<!-- or --><audio src="…" controls controlslist="nodownload" …>
```

Browser **default controls** (play, seek, volume, fullscreen where offered). No custom player UI in v1.

**Out of scope v1:** Office (`.docx` …), arbitrary binary, “open unknown as hex,” editable PDF, PDF.js, host page-number scrubber for PDF, marks on PDF.

**HTML:** `.html` / `.htm` as native navigate **or** open-as-text — **defer** to a follow-up (script trust). Not required for “images and media.”

---

## 4. Architecture

```
┌──────────────────────────────────────────────┐
│ WPF chrome (tabs, menus, status)             │
├──────────────────────────────────────────────┤
│  Editor WebView  — engine docs + epub        │  always keeps TypoZen_Template
│  Native WebView  — PDF / image / media       │  same bounds; one visible
└──────────────────────────────────────────────┘
```

- **Do not** `Navigate` the editor WebView away from the template (destroys multi-tab engine state).
- Lazy-create **Native WebView** on first native open (same `CoreWebView2Environment` / user data dir as editor).
- Active tab kind toggles **visibility** (+ focus + zoom target).

### Serving files

Virtual host (preferred over raw `file://`):

- Map folder (or Privacy-staged copy) → e.g. `https://localview/<escaped-name>`
- PDF: navigate directly to that URL  
- Image: `NavigateToString` fit shell referencing `https://localview/<file>`.  
- Media: `NavigateToString` shell with `<video controls>` / `<audio controls>`.

Reuse patterns from `localbooks` / `docfolder` mapping; clear or re-point mapping when the active native tab’s directory changes.

### Privacy Mode

Same idea as books: if Privacy Mode is on, copy into opaque temp under `%TEMP%`, map that, delete on close / next-launch sweep. Path displayed to the user remains the real path where possible; bytes served may be the staged copy.

---

## 5. Host / tab model

### `DocTab` additions

```text
Kind: Engine | Book | Native   // Book may remain derived from .epub if simpler
NativeRole: None | Pdf | Image | Video | Audio
Content: empty for Native (and Book)
IsDirty: always false for Native / Book
```

Helpers (names illustrative):

- `IsBookTab(tab)` — existing  
- `IsNativeTab(tab)` — Kind/Native or extension table  
- `IsReadOnlyTab(tab)` — book **or** native (never dirty, save refused)  
- `ClassifyPath(path) → OpenDisposition` — Engine / Book / Native(+role) / Unsupported  

### Open path (`LoadFileFromPath`)

```
if !exists → error
disposition = ClassifyPath(path)
if Book → OpenBook (unchanged)
if Native → OpenNative(path, role)
if Engine → existing text load
```

Open dialog filter (v1):

```text
Documents|*.md;*.txt;*.markdown;*.epub
PDF|*.pdf
Images|*.png;*.jpg;…
Media|*.mp4;*.webm;*.mp3;…
All|*.*
```

(or one combined “Supported” line + All). Drag-drop and CLI use the same classifier.

### `OpenNative`

1. Sync leave current tab (fail-closed if dirty engine).  
2. Reuse empty untitled or create tab; set path, Kind=Native, role, Content="", dirty=false.  
3. `ShowNativeSurface()`; map host; navigate PDF or shell.  
4. Lock chrome (see §6); status = filename + role label (“PDF” / “Image” / “Video”…).  
5. Recent list + session (path + kind).

### Tab switch

- Engine/Book → hide native WebView, show editor, existing `ApplyTabToEditor` / `OpenBook`.  
- Native → hide editor WebView (or leave loaded underneath), show native, re-navigate if path changed / first show.  
- Switching **away** from native does not tear down editor state.

### Save

Extend epub rules: refuse write to native paths; Save As not “overwrite this pdf.” Dirty list skips native.

---

## 6. Chrome policy (Reader-like)

When active tab is **native** (or book):

| Control | Behaviour |
|---------|-----------|
| Mode Source / Preview | Locked (Reader selected/lit) |
| Format toolbar | Greyed (existing book/reader path) |
| Word Wrap | Disabled (like pages/book) |
| Find (model) / Search sidebar model | No-op or hide focus; Chromium PDF find stays inside native surface if user uses in-viewer UI |
| Outline | Empty / not driven |
| Page scrubber | Hidden (not our `PageMap`) |
| Columns / Pages toggles | Locked or no-op |
| Zoom | Apply `ZoomFactor` to **visible** WebView |
| Print | Native WebView when native tab active (`ExportPdf`); editor WebView otherwise |
| F1 / About | Still work (editor host messages or WPF) |

Do **not** invent a Mode segment “Viewer.” Product = reading.

---

## 7. Session restore

Persist per tab: `path`, and enough to re-classify (`kind` or extension). On restore:

- Native → `OpenNative` without treating as text  
- Do not put PDF bytes into `Content` or session body store  

Same cap (`MaxSessionTabs`) and privacy rules as today.

---

## 8. Implementation slices (still one design)

Order is delivery risk, not separate architectures:

| Slice | Deliverable | v1 |
|-------|-------------|-----|
| **A — Skeleton** | `ClassifyNativeRole`, `IsNativeTab` / `IsReadOnlyTab`, open filter, refuse save, never dirty | done |
| **B — Surface** | Second WebView, show/hide, `localview` mapping, shared `OpenNative` | done |
| **C — PDF** | Direct navigate; tab switch md ↔ pdf | done |
| **D — Image shell** | Themed fit-to-pane HTML (Chromium image chrome reverted) | done |
| **E — Media shell** | `<video controls>` / `<audio controls>` | done |
| **F — Chrome** | Mode lock, format grey, zoom target | done. Scrubber is engine/book UI on the editor WebView — not shown while the native surface is up (no extra hide step). |
| **G — Session + Privacy** | Restore native tabs by path+kind | session done. App **Privacy Mode** already exists (README); no separate native “opaque extract” path — files are served in place via `localview`, not unpacked like epubs. |
| **H — Docs** | README, for-agents, About, F1 | done |

Slices C–E should land close together so the classifier and shells aren’t PDF-shaped.

**Tests (app E2E where possible):**

- Open PDF → native visible, editor not navigated away  
- Switch to md tab → editor back with content intact  
- Open png / mp4 → shell + controls  
- Save on native → refused  
- Session restore path  

Fixture files: tiny PDF, 1×1 png, short silent mp4/webm if we can keep repo light (or generate in test temp).

---

## 9. Explicit non-goals (v1)

- PDF page scrubber / bookmarks / TypoZen find-in-PDF  
- Editing or annotating native files  
- Transcoding / codec packs  
- `.html` as trusted app pages  
- Replacing epub path with Chromium  
- Single-WebView navigate away from template  

---

## 10. Complexity vs value

| | |
|--|--|
| **Cost** | Mostly `TypoZen_App.cs` + small shell HTML/CSS + docs; little JS engine change |
| **Risk** | Tab switch / focus / zoom dual WebView; mapping races |
| **Value** | One reading window for notes, books, PDFs, pictures, clips |

Plan is justified; **implement A→H as one feature branch**, not “PDF forever then maybe images.”

---

## 11. Agent notes

- `.txt` / `.md` never use native path.  
- Epub stays `OpenBook`.  
- Native = read-only family with books for chrome and save policy.  
- Video/audio: **`controls` attribute** = Chromium default UI.  
- When implementing, update this file’s status and link from `docs/for-agents.md` / README.
