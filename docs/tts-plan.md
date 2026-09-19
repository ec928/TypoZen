# Voice Playback (TTS) UX Proposal for TypoZen

Given TypoZen's philosophy of being a "calm place to write, and a beautiful place to read," the voice playback UI needs to be **discoverable but invisible when not in use**. It shouldn't add permanent clutter to your minimalist toolbar.

Here is a 3-part UX strategy for integrating Text-to-Speech into TypoZen.

---

## 1. Triggering Playback ("Quick Play")

You want to offer two intuitive ways to start reading: one for specific snippets, and one for continuous reading.

### A. The Selection Popover (Targeted Reading)
TypoZen already has a brilliant, contextual popover that appears when text is selected (currently housing *Highlight*, *Find*, and *Look up*).
*   **The Change:** Add a **Play icon (▶️ Read)** to this popover. 
*   **The Logic:** If a user highlights a paragraph and clicks Play, the engine reads *only* that selection and then stops.

### B. The Toolbar (Continuous Reading)
For reading a whole document or book, users need a global button.
*   **The Change:** Add a **Read Aloud (🔊)** icon to the main toolbar.
*   **Placement:** Place it on the right side of the toolbar, immediately to the left of the Mode controls (`{}` / 👁 / 📖). Reading is a "viewing/consumption" action, so it belongs with the view modes rather than the text formatting (B, I, etc.).
*   **The Logic:**
    *   **In Preview/Source:** Start reading from the current **caret (cursor) position** down to the end of the document.
    *   **In Reader (ePub) / PDF:** Start reading from the top of the **currently visible page**.

---

## 2. The Active Reading State (Controls & Tracking)

Once reading starts, the user needs to be able to pause, skip, and stop without hunting for the original play button. 

### A. The Floating Mini-Player
When playback begins, slide down a small, pill-shaped overlay from the top-center of the document pane (just below the toolbar). This is a familiar pattern (used by Edge and Firefox) that keeps controls central without permanently shifting the layout.

**Layout of the Mini-Player:**
`[ ⏮ Prev ] [ ⏸ Pause ] [ ⏭ Next ]   |   [ ⚙ Settings ] [ ✖ Stop ]`

*   **Prev/Next:** Skips to the previous or next block/paragraph.
*   **Stop (✖):** Stops reading and hides the floating player entirely.

### B. Visual Word Tracking
Since you are already using the **CSS Custom Highlight API** for search matches and annotations, reuse this superpower for reading!
*   **Block Highlight:** Apply a very faint wash (e.g., 10% opacity of your theme's accent color) to the entire paragraph currently being read.
*   **Word Highlight:** Apply a stronger highlight (or underline) to the exact word being spoken. 
*   **Auto-scroll:** As the active paragraph nears the bottom third of the window, smoothly scroll the document down.

---

## 3. Configuration (Voice, Speed, Pitch)

Settings should be accessible exactly when the user needs them—while listening.

### A. The Settings Popover
Clicking the `⚙ Settings` button on the floating mini-player should open a small, clean popover attached to the button.

**Contents:**
1.  **Voice (Dropdown):** Lists the available offline voices (filtered for `localService === true`). 
2.  **Speed (Slider):** A horizontal slider ranging from `0.5x` to `2.0x` (default `1.0x`).
3.  **Pitch (Slider - Optional):** *UX Tip:* Modern neural "Natural" voices actually sound distorted and robotic if you alter their pitch. I highly recommend **hiding or omitting the Pitch slider** if a Natural voice is selected, keeping the UI simpler. 

### B. Persistence
These settings should be saved to your `settings.json` in the `%LocalAppData%\TypoZen_Cache\` directory. When a user switches tabs or reopens the app, their preferred voice and reading speed should instantly apply.
