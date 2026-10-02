# Future Improvements & Architectural Learnings

This document has been re-written after a failed integration attempt by the previous agent. TypoZen has been completely reverted to Claude's stable version 0.12.2. All experimental code, CSS hacks, and JIT Hyphenator scripts have been purged.

The following is a clean hand-off list for future, more reliable AIs to implement. These are isolated, safe improvements that were validated as worthwhile but lost during the rollback.

## 1. Kokoro TTS Web Worker Offloading (High Priority - WITH CRITICAL WARNING)
*   **The Problem:** Currently, when the Kokoro TTS engine generates audio, the massive WebGPU ONNX math operations (`_kokoroEngine.generate`) run directly on the main UI thread in `09-speech.js`. This causes severe UI stuttering and frame drops if the user tries to scroll or interact while the narrator is speaking.
*   **The Solution:** Move the Kokoro engine instantiation and generation logic into a dedicated Web Worker (`kokoro-worker.js`).
*   **⚠️ CRITICAL WARNING:** The previous AI attempted this and completely broke Kokoro. The ONNX/WebGPU runtime in `engine.js` likely expects the main `window` context or requires specific worker initialization (e.g., `navigator.gpu` availability or `env.wasmPaths` adjustments). You **MUST** thoroughly test audio generation after moving it to a worker, as it silently failed previously.

## 2. Asterisk / Scene-Break Image Centering (CSS Polish)
*   **The Problem:** Some EPUB publishers (e.g., Freda) use tiny SVG or image asterisks for scene breaks, but apply aggressive inline or stylesheet rules (`width: 100%`). Because TypoZen's `#editor` scales images to fit the screen height, these tiny asterisks get blown up to massive, blurry 90vh tall graphics.
*   **The Solution:** In `css/typozen.css`, locate the `#editor .block img` and `#editor .block svg` rules. Add `!important` to the width, height, and margin properties (e.g., `max-width: 100% !important; margin: 0 auto !important; height: auto !important; display: block !important`) to override the publisher and force scene breaks to their intrinsic size, cleanly centered.

## 3. Double-Faded Inactive Tabs (C# Polish)
*   **The Problem:** In `TypoZen_App.cs` (around lines 14635 and 14695), inactive document tabs are extremely hard to read on dark themes. They are being assigned the theme's muted text brush (`_tabTextMuted`), but the code *also* manually applies an `Opacity = 0.72` drop on top of it.
*   **The Solution:** Remove the hardcoded `0.72` opacity drop. Allow the inactive tabs to rely solely on the theme's intended muted brush so they remain legible.

## 4. "Invisible" Disabled Buttons (C# Polish)
*   **The Problem:** When buttons (like the Column or Scroll locks) are disabled in C#, WPF naturally grays them out. However, `TypoZen_App.cs` (around line 6461) manually stacks a `LockedOpacity = 0.30` on top, making them nearly invisible on high-resolution displays.
*   **The Solution:** Bump `LockedOpacity` to `0.50` so that disabled controls remain readable.

## 5. Scrubber UI Refinement (CSS Polish)
*   **The Problem:** The reading scrubber thumb feels slightly too large and dominant on the screen.
*   **The Solution:** In `css/typozen.css` (around line 1174, `#page-scrubber-range::-webkit-slider-thumb`), shrink the thumb `width` and `height` from `11px` to `9px` (adjusting `margin-top` to `-3px`). Set its default `opacity` to `0.75`, and add a `:hover` rule that pops it back to `opacity: 1.0`.

## Final Architectural Warning for Future Agents
**DO NOT ATTEMPT TO INJECT SOFT-HYPHENS FOR MULTI-COLUMN JUSTIFICATION.**
The previous agent attempted to achieve TeX-quality justification by injecting thousands of `\u00AD` characters into the DOM while applying `text-align: justify` in a CSS `column-width` container. This is algorithmically incompatible with Chromium's Knuth-Plass layout balancer. It forces the engine into an O(N^2) evaluation loop during page turns, completely freezing the app. Leave TypoZen's native `--tz-align` system exactly as Claude designed it.
