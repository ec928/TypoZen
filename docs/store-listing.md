# Microsoft Store listing copy

Paste-ready text for Partner Center → Store listings. Every number here is verified
against the shipping build; see the note at the foot before changing any of them.

---

## Product name

**TypoZen: ePub & PDF Reader, Markdown Editor** (chosen 2026-09-29; replaces "ePub Reader &
Markdown Editor - TypoZen"). A reserved name in Partner Center; the package's own
DisplayName stays "TypoZen".

---

## Short description

_Shown in search results and at the top of the listing. Limit 1,000 characters._

A calm place to write, and a beautiful place to read. TypoZen is a WYSIWYG Markdown editor, a paginated ePub reader and a PDF reader in one window — with true two-page spreads, read aloud in your Windows voices, an offline dictionary and thesaurus, 25 themes, and no network request of its own.

---

## Description

_Limit 10,000 characters._

**A reader and an editor that finally live in one window.**

TypoZen is an ePub reader good enough to finish a novel in, a PDF reader you can annotate, and a Markdown editor that gets out of your way. Write in the morning, read in the evening, in the same window, in the same theme, with the same fonts.

**Writing that stays out of the way**

Type Markdown and watch it become the thing it describes — headings, lists, tables, task lists, code fences, emphasis — or flip to raw Source, a proper code editor with highlighting that opens files of megabytes at once, and back without losing your place on the page. Focus mode dims everything but the sentence you are in. Typewriter scrolling keeps that line where your eyes already are. ZenMode hides the whole interface — toolbars, tabs, even the window buttons — until you reach for it.

Big files stay quick. TypoZen only builds the part of the document you can actually see, so a 200,000-character manuscript scrolls like a short note — and Find still searches every word of it, not just the visible page.

**Reading worth sitting down for**

Open an ePub and TypoZen becomes a reader: paginated, chaptered, with a genuine two-page spread. Books keep the publisher's own typesetting rather than a lossy conversion, so the images, footnotes and links are all still there — and the text is re-sized to the theme you chose, not to whatever device the publisher had in mind.

A scrubber spans the whole book with your bookmarks marked along it. The status bar names the chapter you are in; click it to jump to the start. Close the book whenever you like — it reopens exactly where you stopped.

**Or just listen**

Select a passage and press Read aloud, or press it with nothing selected to hear the page you are on. TypoZen speaks in the voices already installed in Windows, at the speed you choose — and the words stay on your computer.

**A dictionary that works on a plane**

Select any word for its most common meanings first, its synonyms, and how often it appears in what you are reading — and press the speaker to hear it said. Over 150,000 definitions and over 110,000 synonym sets, all on your disk. No lookup ever leaves your computer.

**PDFs, properly**

PDFs open in a full reader: single pages or two-page spreads, Find and search across every page, the outline, read aloud, bookmarks and highlights. Annotate, fill in forms and save; the text of scanned pages is read on your computer, so it can be searched and selected too.

**Everything else you opened by accident**

Web pages, images, video and audio open read-only in their own tabs, so the wrong double-click never costs you your place.

**Made to look like yours**

25 hand-picked themes in dark, light and monospace, plus a theme editor to build your own. Four typefaces ship inside the app — Inter, Literata, Merriweather and Source Sans 3 — so pages render identically on every machine and nothing is fetched from a font server. Margins, line spacing, justification and hyphenation are all yours to set.

**Private by construction, not by promise**

TypoZen makes no network requests unless you choose to download an optional extension. There is no account, no sign-in, no sync, no analytics, no advertising and no crash reporting. Your documents, your reading positions and your searches stay on your machine, and Privacy Mode stops the app writing any of it down. Everything it does remember can be cleared from one menu.

**Details that add up**

Bookmarks that survive edits and are named from their own text. Highlights and notes. Spelling underlined as you type, and corrections for any word you select. Live word count, character count and reading time. Tabs, with the whole session restored the next time you open the app. Atomic saves, and a warning if a file changed underneath you. Export to self-contained HTML, or print to PDF.

Free, open source, and yours to keep.

---

## What's new in this version

_Limit 1,500 characters. For the 0.10 submission (the Store was on 0.9.6)._

- Each kind of document keeps its own look: ePubs, documents and code each remember their own theme, text size, spacing and margins, and PDFs their own theme.
- ZenMode hides the whole interface, window buttons included, until you move to the top of the window.
- Spelling underlines long paragraphs far faster: each word is checked once, not every paragraph again.
- Switching tabs is much faster, and dragging a tab past the end of a full strip scrolls it.
- TypoZen appears under Open with for code files and PDFs.
- Two-page spreads keep your place when you change the theme or text size.
- Preview keeps the indentation of code files.

---

## Submission checklist -- ONE submission, everything in it (Ed, 2026-09-29)

Every item is changed or confirmed before Submit; nothing is left for a second pass.

| # | Where in Partner Center | What |
| --- | --- | --- |
| 1 | Product identity | "TypoZen: ePub & PDF Reader, Markdown Editor" reserved |
| 2 | Packages | the newest MSIX, version above 0.9.6.0; the 0.9.6 package removed from the submission |
| 3 | Store listing: Product name | the new name selected |
| 4 | Store listing: Description, What's new, Features, Short descriptions, Search terms | this file, as it stands |
| 5 | Store listing: Screenshots | Ed's six, in the order of the captions, with the captions |
| 6 | Store listing: artwork | the redrawn 16:9 hero from `dist-storeart\` (no text); Poster and Box art are for games -- remove them if uploaded |
| 7 | Properties: Category | Books & reference (see Category below) -- confirm, do not assume |
| 8 | Submission options: Restricted capabilities | the runFullTrust text below, unchanged |
| 9 | Before Submit | packaged smoke test passed on the exact MSIX uploaded |

---

## Product features

_Up to 20 bullets, 200 characters each._

1. WYSIWYG Markdown editing — type Markdown and see the result as you write; switch to raw Source and back without losing your place
2. Source is a real code editor, built on CodeMirror 6: highlighting for Markdown, HTML, XML, CSS, JSON, JavaScript and C#
3. Opens large files instantly — megabytes of text, with lines hundreds of thousands of characters long
4. Paginated ePub reader with true two-page spreads, chapter navigation and a reading scrubber
5. Books keep the publisher's typography, embedded fonts and footnotes; the page, its margins and colours stay yours
6. A PDF reader: single pages or two-page spreads, Find, bookmarks and highlights
7. Annotate PDFs, fill in forms and save; the text of scanned pages is read on your computer
8. Read aloud in any Windows voice, or in optional neural voices, with the passage highlighted as it is read
9. Spelling: every misspelling on screen underlined in Preview and Source (not in code); select any word for corrections
10. Offline dictionary and thesaurus — over 150,000 definitions; no lookup ever leaves your computer
11. Search the whole document from a sidebar, with every match highlighted — even in very long files
12. Highlights, notes and bookmarks that survive edits
13. Tabs for every open document; drag to reorder them, and each remembers its view and position
14. Reading positions, open tabs and layout restored exactly where you left them
15. Focus mode, typewriter scrolling and ZenMode, which hides the whole interface until you reach for it
16. 25 built-in themes plus your own; selections, search and highlights take their colours from the theme
17. Bundled typefaces — Inter, Literata, Merriweather and Source Sans 3 — with no network requests
18. Private by design: no telemetry, nothing sent anywhere, and a Privacy Mode that stores no history
19. Images, videos and web pages open in their own tabs, read-only, so nothing is edited by accident
20. Export to HTML, print or save as PDF; text saved as UTF-8 with its line endings preserved

---

## Category

**Books & reference.** Not Productivity.

The listing was moved to Productivity (second category Utilities + tools) on advice given
here, against the author's own first choice of ebooks. Measured on 2026-09-17 on
`apps.microsoft.com`, signed out, GB market: a search for **`epub`** returns page after page
of readers, every one of them in Books & reference, and **TypoZen is not among them**.
`markdown editor` does not return it in the top rows either. `typozen` returns it first, so
the listing is live and indexed -- it is reachable by name and unreachable by subject.

Low install and rating counts also weigh on ranking and cannot be separated out from here,
but the category is free to change and matches where the competition sits. Put it back to
Books & reference, then re-run those three searches a few days after it publishes rather
than assuming the change worked.

---

## Search terms

_Up to 7 terms, 30 characters each, 21 words total. Do not repeat the app name._

- epub reader
- pdf reader
- markdown editor
- ebook reader
- distraction free writing
- offline dictionary
- text editor

(2026-09-29: "pdf reader" in, "wysiwyg" out -- PDF is in the product name now, and wysiwyg
is a word people rarely search for.)

---

## Screenshot captions

_Up to 200 characters each. One screenshot minimum; 1366×768 or larger._

In the order of the 0.10 screenshots, `dist-storeart\1.png` to `7.png` (Ed, 2026-09-29);
the first is the one shown in search.

1. Read ePubs in a true two-page spread, with the publisher's own typesetting intact.
2. A full PDF reader: two-page spreads, the outline, search, highlights and notes, and forms you can fill in and save.
3. 25 built-in themes in dark, light and mono, or build your own — and books take on the theme you choose.
4. Have any page read aloud in the voices installed in Windows, or in optional neural voices, with the passage highlighted as it is read.
5. Select any word for its definitions and synonyms from the offline dictionary — nothing leaves your computer.
6. Write in Markdown and see the result as you type: headings, lists and tables edit in place.
7. Source is a real code editor, built on CodeMirror 6, with highlighting in your theme's colours.

---

## Restricted capabilities  (Submission options -- REQUIRED)

_Not "Notes for certification": that heading on the Submission Options page is a link to
the separate Additional Testing Information page, not a box. The required box is this one,
and it asks a narrower question -- why the capability is needed and how it is used._

**Hard limit: 500 characters.** The box silently stops accepting input; it does not warn.
The text below is exactly 500, which the box accepts. Anything longer gets truncated mid-sentence, which reads worse to a
reviewer than a short answer does.

TypoZen is a Win32 desktop app packaged as MSIX (Desktop Bridge). It cannot run without runFullTrust: it is .NET/WPF hosting WebView2, not a sandboxed UWP app.

Used for ordinary document editing: opening and saving files at paths the user picks in standard Windows dialogs, which AppContainer forbids, and reading bundled fonts and dictionary.

The only capability declared. No data collection, no sign-in. Network use only while the user installs an optional extension from File > Extensions.

---

## Additional Testing Information  (optional)

No account, sign-in or purchase is needed; all functionality is available immediately.

To exercise the main paths: open any .md or .txt file to edit it, and any .epub to read it. For the paginated two-page spread, use the two buttons at the right of the toolbar -- click "Scroll" so it reads "Pages", then click "1-Col" so it reads "2-Col". Two columns require pagination, so that order matters. PDFs open in their own reader; images and web pages open read-only in their own tabs.

Privacy policy: https://github.com/ec928/TypoZen/blob/master/PRIVACY.md

---

## Additional information fields

| Field | Value |
| --- | --- |
| Copyright and trademark info | (c) 2026 Ed C. TypoZen is open source under the MIT licence. |
| Developed by | Zen Development -- matches PublisherDisplayName in the manifest |
| Additional license terms | Leave empty. Only for AMENDMENTS to the Standard Application License Terms; MIT governs the source on GitHub, the Standard Terms govern the Store binary, and the two do not conflict. |
| Short title / Voice title | Leave empty -- Xbox One only |

---

## Short description (Supplemental fields)

_Optional, recommended 270 characters or fewer. Deliberately NOT the opening line of the
Description above, which is already on the same page._

Read ePubs in a real two-page spread, or have them read to you. Read and annotate PDFs. Write Markdown and watch it become the page as you type. One quiet window, 25 themes, an offline dictionary, and nothing sent anywhere.

Leave **Short title** and **Voice title** empty -- both are Xbox-only (installation screens
and Kinect voice). Leave the three **Xbox images** empty for the same reason: Xbox is
unchecked as a device family, and a full-trust Win32 app cannot run there.

---

## Store artwork

Generated by `tools/Build-StoreArt.ps1` into `dist-storeart\`.

| Slot | File | Notes |
| --- | --- | --- |
| 16:9 Super hero art | `SuperHeroArt-1920x1080.png` | Top of the listing. **No text of any kind**, no app UI (Microsoft: "must not include the product's title or other text"). Redrawn 2026-09-29: the earlier one set a paragraph of prose beside the mark |
| 2:3 Poster art, 1:1 Box art | `PosterArt-720x1080.png`, `BoxArt-1080x1080.png` | **Games only** ("This does not apply to apps", Microsoft Learn, checked 2026-09-29). Not uploaded for TypoZen |
| 1:1 App tile icon (300x300) | -- | Optional; without it the Store uses the package's own icon |

Screenshots (Microsoft Learn, checked 2026-09-29): PNG, Desktop **1366x768 or larger, landscape
or portrait**, 4K supported, up to 10, each under 50 MB. Keep what matters in the top two
thirds: captions can overlay the bottom third. `tools\Capture-StoreShot.bat` takes them.

---

## Copyright and trademark info

© 2026 Ed C. TypoZen is open source under the MIT licence.

---

## A note on the numbers

Verified against the shipping build on 6 September 2026:

| Claim | Source |
| --- | --- |
| "over 150,000 definitions" | `dictionary.tsv` — 152,459 words with definitions (Open English WordNet 2025+, from 2026-09-19; was 147,478 from WordNet 3.1). The file has 156,217 lines: the other 3,758 are irregular forms (`ran` → `@run`), which point at a definition rather than holding one, and are not counted |
| "read aloud … in the voices installed in Windows" | `TypoZen_TTS.cs` — SAPI 5 and Windows.Media voices; no voice is bundled or downloaded |
| "over 110,000 synonym sets" | `thesaurus.tsv` — 114,022 entries (was 110,543) |
| "25 themes" | `TypoZen_Themes.json` — 25 entries |
| "200,000-character manuscript" | `tests/large-scroll-mixed.md` — 214,626 bytes |
| "no network requests" | no HttpClient/WebRequest/socket in the host; no fetch/XHR/sendBeacon in the page |

The About dialog once said "Over 150,000 offline definitions" and "40,000+ block
documents". The first overstated the dictionary by about 2,500 entries at the time (it is
true since the Open English WordNet data, 152,459 entries); the second is a
design aspiration from `docs/developer-editor-analysis.md` rather than a measured figure
— the largest document under test is 3,767 blocks. Neither claim is repeated here.
