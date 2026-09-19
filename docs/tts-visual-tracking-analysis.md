# TTS Visual Tracking and Page Turning - Analysis and Recommendation

## Understanding the Current Implementation

Currently, TypoZen's TTS feature (`09-speech.js`) gathers all the text that needs to be read and merges it into a single, massive string. This text extraction happens in several ways depending on context:
- Pulling from the selected text (`window.getSelection()`)
- Slicing `DocumentModel.blocks` from the current caret's model index to the end of the document
- Concatenating `.block` elements directly from the DOM.

Once gathered, `startReading(text)` splits this giant string by double-newlines and aggregates them into chunks of up to 30,000 characters. These chunks are sequentially posted to the C# WinRT/SAPI host (`TypoZen_TTS.cs`). 

**The Challenge:** 
By extracting the text eagerly and grouping it into arbitrary chunks, the connection between the spoken text and the underlying Document Model (and its DOM elements) is severed. The TTS system has no idea which structural block is actively being read by the native C# synthesizer. Furthermore, WinRT and SAPI chunking doesn't easily emit word-by-word progress boundaries back to JS (in fact, SAPI's `SpeakProgress` was explicitly disabled for stability reasons in `TypoZen_TTS.cs`). 

## Recommended Approach

To achieve visual tracking and auto-pagination, we need to transition from **Text-Based Chunking** to **Model-Aware Chunking**.

### 1. Model-Aware Chunking
Instead of concatenating text into a giant string, the `speakSelection()` logic should assemble a queue of objects containing both the text and its corresponding block index.
```javascript
// Instead of:
// _ttsChunks = ["Chunk 1 text...", "Chunk 2 text..."];

// Use:
// _ttsChunks = [
//   { idx: 12, text: "First paragraph..." },
//   { idx: 13, text: "Second paragraph..." }
// ];
```

### 2. Synchronized Playback Loop
When `playNextChunk()` is triggered (either initially or via the `nativeTTSFinished` callback from C#), the JS application knows exactly which `idx` is about to be spoken.

At this point, we bridge the TTS with your existing layout and focus mechanics:
1. **Pagination / Scrolling:** 
   - Check `isPaginatedLayout()`.
   - If true, use TypoZen's existing `goToPageHoldingBlock(chunk.idx)`. This ensures that if the block is on the next page, the page automatically flips *before* the audio starts.
   - If false (scroll mode), find the DOM element and call `el.scrollIntoView({ block: 'center', behavior: 'smooth' })`.
2. **Visual Highlighting:** 
   - Wait for the DOM element to be available (if it was just virtualized by a page turn).
   - Apply a specific visual class to the element, e.g., `.tts-active`.
   - Apply a mode class to the `#editor` container, e.g., `.tts-reading-mode`.
3. **Play:** Send the `chunk.text` to C#. 

### 3. Visuals inspired by Focus Mode
You mentioned wanting to leverage existing Focus Mode code without reusing it directly. Focus Mode currently works by dimming unfocused blocks when `.focus-mode` is on `#editor`, and highlighting `.focused`.

You can mirror this beautifully with CSS:
```css
/* Dim other blocks while TTS is running */
#editor.tts-reading-mode .block:not(.tts-active) {
    opacity: 0.5;
    transition: opacity 0.3s;
}

/* Highlight the block currently being read */
#editor.tts-reading-mode .block.tts-active {
    opacity: 1;
    border-left: 2px solid var(--accent); /* Similar to focus mode */
    background-color: var(--mark-focus-bg);
}
```

### Summary of Changes Required
1. Modify **`js/modules/09-speech.js`**: Update text gathering to build an array of `{idx, text}`. Update `playNextChunk` to handle `goToPageHoldingBlock` and apply the `.tts-active` class to the current `idx`.
2. Add **CSS rules**: Introduce `.tts-reading-mode` and `.tts-active` to visually track the block.
3. No changes should be strictly necessary in **`TypoZen_TTS.cs`** unless you want word-level granularity (which would require re-evaluating `SpeakProgress` or WinRT Speech Marks), but block-level granularity works perfectly for reading paragraphs/blocks and turning pages.
