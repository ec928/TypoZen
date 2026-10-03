# TypoZen Architecture & Refactor Plan

This document outlines the high-level architecture of TypoZen, its target file structure (where data and binaries live), and the active refactoring plan to dismantle the C# monolith (`TypoZen_App.cs`) into a manageable, agent-friendly file structure.

## 1. Target File Structure & Caches

TypoZen stores application binaries and user caches separately to ensure clean updates and safe uninstalls.

### Application Data & Caches
All user preferences, application state, and WebView2 cached data are stored securely in the user's Local AppData directory:
*   **Path:** `%LocalAppData%\TypoZen_Cache` (e.g., `C:\Users\<User>\AppData\Local\TypoZen_Cache`)
*   **Contents:**
    *   `EBWebView/`: The Microsoft Edge WebView2 runtime profile and cache storage.
    *   `window_state.json`: Persists window bounds, maximization state, and column layout preferences across sessions.
    *   `recent_files.json` / Type preferences: Tracks recently opened files and file-type-specific view overrides (e.g., margins, font sizes for PDFs vs. Markdown).

### Installation / Program Files
Depending on how the user installs the app, the compiled binaries and UI assets live in one of the following locations:
*   **MSIX (Microsoft Store):** Managed securely by Windows in `C:\Program Files\WindowsApps\...\`
*   **Standalone Installer:** Typically defaults to `%LocalAppData%\Programs\TypoZen\` or `C:\Program Files\TypoZen\`.
*   **Portable Zip:** Wherever the user extracts it.

At runtime, the executable (`TypoZen.exe`) expects to find its frontend assets in adjacent directories (`css/`, `js/`, `fonts/`, `TypoZen_Template.html`, `TypoZen_Themes.json`).

---

## 2. Source Code Organization

The current repository layout follows a hybrid Native-Web structure:

*   **`TypoZen_App.cs`** - The monolithic C# backend (currently ~18,600 lines) handling WPF windowing, WebView2 initialization, File I/O, IPC bridging, and Native UI events.
*   **`js/modules/`** - Frontend logic, broken into distinct domains:
    *   `01-core.js` & `01a-source.js` - Initialization and CodeMirror 6 (Source mode) logic.
    *   `02-layout.js` - Pagination and column logic.
    *   `07-stats-host.js` - UI Outlining, word counting, read-time estimates.
    *   `09-speech.js` - Kokoro/WebGPU TTS integrations.
    *   `10-pdf.js` - PDF.js wrapper logic.
*   **`css/typozen.css`** - Global stylesheet.
*   **`tests/`** - JavaScript-based regression suites using Puppeteer/Headless Chrome.
*   **`tools/`** - Build and release pipeline scripts (`Build-Portable.ps1`, `Build-Msix.ps1`).

---

## 3. The Refactor Implementation Plan (Monolith Split)

### Rationale
`TypoZen_App.cs` is nearly 19,000 lines long. This is a severe architectural anti-pattern that slows down IDE performance, complicates git merges, and drastically reduces the efficiency and reliability of Agentic AI development. 

### Approach: Safe Partial Classes
To avoid breaking the build or introducing runtime regressions, we will use **Partial Classes**. This allows us to physically split the file into smaller logical pieces (`TypoZen_App.WebView.cs`, `TypoZen_App.Files.cs`, etc.) without altering namespaces, access modifiers, or internal logic.

### Progress Tracker

*   [ ] **Phase 1: Extract Static Utilities & Data Models**
    *   [ ] Create `TypoZen_Models.cs`
    *   [ ] Move `enum` definitions, simple data structs, and pure helper classes out of the main file.
    *   [ ] Create `TypoZen_Utils.cs` for pure static helper functions (e.g., regex checks, string sanitization).

*   [ ] **Phase 2: Split by Domain (Partial Classes)**
    *   [ ] Add `partial` to `public class MainWindow` (or equivalent main class).
    *   [ ] Extract `TypoZen_App.Themes.cs` (Theme parsing, color management, window chrome updates).
    *   [ ] Extract `TypoZen_App.WebView.cs` (WebView2 lifecycle, `CoreWebView2_WebMessageReceived`, bridging).
    *   [ ] Extract `TypoZen_App.Files.cs` (File I/O, saving, loading, recent files list).

*   [ ] **Phase 3: IPC Modernization (Optional/Later)**
    *   [ ] Replace the massive string-matching `if-else` blocks in `CoreWebView2_WebMessageReceived` with a structured JSON dispatcher schema.

*   [ ] **Phase 4: Frontend Performance (JS)**
    *   [ ] Refactor `07-stats-host.js` -> `updateOutline()` to use `sourceEditor.view.state.doc.iterLines()` instead of allocating array copies via `sourceEditor.value.split()`.
