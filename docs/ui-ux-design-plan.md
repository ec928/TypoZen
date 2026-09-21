# UI/UX Streamlining Plan: Popover vs. Toolbar

## Goal
Reduce UI clutter and optimize ergonomic flow by strictly separating *block-level* document structure from *inline* text formatting.

## Core Philosophy
1. **The Static Top Toolbar:** Reserved purely for *block-level* structure (Headings, Quotes, Lists, Tables) and document-level actions. These are actions that apply to the current paragraph (the blinking caret) or the whole document.
2. **The Contextual Popover:** The exclusive home for *inline, selection-based* manipulation. If an action transforms a specific string of highlighted text, it belongs here.

## 1. Top Toolbar Changes
**Action:** Remove the following inline formatting buttons from the top toolbar:
- Bold (`B`)
- Italic (`I`)
- Strikethrough (`ab`)
- Inline Code (`</>`)
- Insert Link (`chain icon`)

*Rationale:* These actions are fundamentally tied to a text selection. Forcing the user to select text and then drag their mouse to the top of the screen to format it is a legacy pattern. Power users who want to format while typing will continue to use standard hotkeys (`Ctrl+B`, `Ctrl+K`, etc.).

*Exceptions:* **Insert Table** stays in the top toolbar. Tables are block-level structural elements. Forcing a user to highlight a random word just to summon the popover to insert a table is a UX anti-pattern.

## 2. Contextual Popover Enhancements
**Action:** Expand the popover to absorb the removed formatting tools, organized logically to keep the primary row clean and unintrusive.

**Primary Row (Reading & Utilities):**
- Dictionary / Define
- Search in Document
- Read Aloud (TTS)
- *Proposed New:* **Search Web** (Launch default browser to search the selected term)

**Overflow Menu (Writing & Formatting):**
To keep the popover compact, editing actions will live in the expanded overflow (`...`) menu.
- **Bold** (Moved from top bar)
- **Italic** (Moved from top bar)
- **Strikethrough** (Moved from top bar)
- **Inline Code** (Moved from top bar)
- **Highlight** (Existing)
- **Add Link** (Existing)
- *Proposed New:* **Copy As Markdown / HTML** (Power-user clipboard tools to solve rich-text paste headaches)

*Note:* If the vertical overflow list becomes too long, we can transition it into a secondary horizontal icon row in the future (a "Sleek Pill" design). For now, a clean vertical list with descriptive icons is sufficient.

## Implementation Steps
1. **XAML Cleanup:** Edit `TypoZen.xaml` to remove the 5 inline formatting `<Button>` elements from the main `<ToolBar>`.
2. **HTML Expansion:** Edit `TypoZen_Template.html` to add the new buttons (Bold, Italic, Strikethrough, Code, Search Web) into the `#selPopOverflow` div.
3. **JS Wiring:** Wire the new HTML buttons in `03-shell.js` and `02-layout.js` to trigger the existing formatting commands (`applyFormatting('bold')`, etc.).
4. **New Features:** Implement the "Search Web" logic (passing the selected text to C# via WebView2 to open the default system browser).
5. **Polishing:** Update tooltips, icons, and keyboard shortcut documentation to reflect the new layout.
