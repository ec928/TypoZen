# TTS Visual Tracking & Auto-Pagination - Implementation Plan

This document outlines the architectural changes necessary to add block-level visual tracking and automatic page-turning to TypoZen's TTS feature.

## 1. The Strategy: Model-Aware Chunking

Currently, `09-speech.js` concatenates all text from the caret to the end of the document into one large string, chunks it arbitrarily by 30,000 characters, and sends it to C#. This severs the connection between the spoken text and the DOM/DocumentModel.

We will refactor this to build an array of chunks where each chunk corresponds to a single model block, holding both the text and its index.

## 2. Proposed Changes: `js/modules/09-speech.js`

### Rewriting `speakSelection()`
Instead of yielding a single `textToRead` string, `speakSelection` will construct a `_ttsChunks` array of objects: `{ idx: number, text: string }`.

- **If there is a manual selection**: Treat the selected text as a single chunk (no pagination).
- **If no selection (DocumentModel available)**: Slice `DocumentModel.blocks` starting from the caret's `idx`. Build chunks using the `raw` text of each block.
- **If no selection (EPUB / DOM Fallback)**: Iterate over `.block` DOM elements starting from the caret, building chunks with their `.innerText`.

### Rewriting `playNextChunk()`
When retrieving the next chunk to play:
1. Extract the `idx` and `text`.
2. **Page Turning**: Check `if (isPaginatedLayout())` and call `goToPageHoldingBlock(idx)`. This ensures that if the block is on the next page, the view automatically flips before the audio begins. (For scrolling views, use `scrollIntoView`).
3. **Visual Anchor**: Use `requestAnimationFrame` or a micro-timeout to ensure the layout has updated, then query the DOM for `[data-model-index="idx"]`. Apply the `.tts-active` class to this block.
4. **Trigger Audio**: Post the `text` payload to the native C# host.

### Rewriting `stopReading()` / `nativeTTSFinished()`
- Clear the `.tts-active` class from the current block when a chunk finishes.
- Remove the overarching `.tts-reading-mode` class from `#editor` when playback fully stops.

## 3. Proposed Changes: `css/typozen.css`

To provide visual feedback without simply duplicating Focus Mode, we will introduce a "Reading Guide" aesthetic.

```css
/* Activate reading mode styling on the editor */
#editor.tts-reading-mode .block:not(.tts-active) {
    opacity: 0.7; /* A softer dimming than focus mode */
    transition: opacity 0.3s ease-in-out;
}

/* Highlight the specific block being read */
#editor.tts-reading-mode .block.tts-active {
    opacity: 1;
    border-left: 2px solid var(--accent); /* Subtle reading guide anchor */
    background-color: var(--mark-focus-bg, rgba(232, 163, 61, 0.15));
    transition: background-color 0.2s;
}
```

## 4. Why this approach?
1. **No C# Changes Required:** This entirely bypasses the need to fight with `System.Speech` bugs (like the `SpeakProgress` uncatchable exception) or parse SSML marks in WinRT. 
2. **Perfect Pagination:** By hooking into `goToPageHoldingBlock(idx)`, the page will snap perfectly in sync with the audio chunks.
3. **Seamless UX:** The subtle left border and gentle dimming guide the eye precisely to the active paragraph without plunging the entire app into a stark editing mode.
