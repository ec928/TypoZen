# Microsoft Store listing copy

Paste-ready text for Partner Center → Store listings. Every number here is verified
against the shipping build; see the note at the foot before changing any of them.

---

## Short description

_Shown in search results and at the top of the listing. Limit 1,000 characters._

A calm place to write, and a beautiful place to read. TypoZen is a WYSIWYG Markdown editor and a paginated ePub reader in one window — with true two-page spreads, an offline dictionary and thesaurus, 25 themes, and not a single network request.

---

## Description

_Limit 10,000 characters._

**Two apps that finally live in one window.**

TypoZen is a Markdown editor that gets out of your way, and an ePub reader good enough to finish a novel in. Write in the morning, read in the evening, in the same window, in the same theme, with the same fonts.

**Writing that stays out of the way**

Type Markdown and watch it become the thing it describes — headings, lists, tables, task lists, code fences, emphasis — or flip to raw Source and back without losing your place on the page. Focus mode dims everything but the sentence you are in. Typewriter scrolling keeps that line where your eyes already are. The toolbars slide away when you stop needing them.

Big files stay quick. TypoZen only builds the part of the document you can actually see, so a 200,000-character manuscript scrolls like a short note — and Find still searches every word of it, not just the visible page.

**Reading worth sitting down for**

Open an ePub and TypoZen becomes a reader: paginated, chaptered, with a genuine two-page spread. Books keep the publisher's own typesetting rather than a lossy conversion, so the images, footnotes and links are all still there — and the text is re-sized to the theme you chose, not to whatever device the publisher had in mind.

A scrubber spans the whole book with your bookmarks marked along it. The status bar names the chapter you are in; click it to jump to the start. Close the book whenever you like — it reopens exactly where you stopped.

**A dictionary that works on a plane**

Select any word for definitions, synonyms and how often it appears in what you are reading. Over 150,000 definitions and over 110,000 synonym sets, all on your disk. No lookup ever leaves your computer.

**Everything else you opened by accident**

PDFs, web pages, images, video and audio open read-only in their own tabs, so the wrong double-click never costs you your place. They cannot be edited and cannot be saved over.

**Made to look like yours**

25 hand-picked themes in dark, light and monospace, plus a theme editor to build your own. Four typefaces ship inside the app — Inter, Literata, Merriweather and Source Sans 3 — so pages render identically on every machine and nothing is fetched from a font server. Margins, line spacing, justification and hyphenation are all yours to set.

**Private by construction, not by promise**

TypoZen makes no network requests. There is no account, no sign-in, no sync, no analytics, no advertising and no crash reporting. Your documents, your reading positions and your searches stay on your machine, and Privacy Mode stops the app writing any of it down. Everything it does remember can be cleared from one menu.

**Details that add up**

Bookmarks that survive edits and are named from their own text. Highlights and notes. Spelling underlined as you type, with a document-wide check when you want it. Live word count, character count and reading time. Tabs, with the whole session restored the next time you open the app. Atomic saves, and a warning if a file changed underneath you. Export to self-contained HTML, or print to PDF.

Free, open source, and yours to keep.

---

## Product features

_Up to 20 bullets, 200 characters each._

1. WYSIWYG Markdown editing — type Markdown, see the result, switch to raw Source and back without losing your place
2. Paginated ePub reader with true two-page spreads, chapter navigation and a scrubber across the whole book
3. Books keep the publisher's own layout — images, footnotes and links intact, re-sized to your theme
4. Reading position, bookmarks and open tabs restored exactly where you left them
5. Offline dictionary and thesaurus — over 150,000 definitions, no lookup ever leaves your computer
6. Handles very large documents smoothly by rendering only what is on screen
7. Find and Replace across the entire document, including the parts not currently displayed
8. Focus mode, typewriter scrolling and auto-hiding chrome for distraction-free writing
9. Spelling underlined as you type, plus a document-wide check with replacements and a personal dictionary
10. Bookmarks that survive edits, named automatically from the text they mark
11. Highlights and notes, listed in order of where they appear rather than when you made them
12. PDF, HTML, images, video and audio open read-only in their own tabs — never edited, never saved over
13. 25 built-in themes in dark, light and monospace, plus a theme editor for your own
14. Four typefaces bundled in the app — Inter, Literata, Merriweather and Source Sans 3
15. Control over margins, line spacing, justification and hyphenation
16. Live word count, character count, line position and estimated reading time
17. Tabs, with the full session restored on the next launch
18. Atomic saves, plus a prompt if the file changed on disk while you were working
19. Export to self-contained HTML, or print to PDF
20. No network requests, no account, no telemetry — with a Privacy Mode that records nothing

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

- markdown editor
- epub reader
- wysiwyg
- distraction free writing
- offline dictionary
- text editor
- ebook reader

---

## Screenshot captions

_Up to 200 characters each. One screenshot minimum; 1366×768 or larger._

1. Write in Markdown and see the result as you type — no split panes, no preview window to keep in sync.
2. Focus mode dims everything except the line you are writing.
3. Read ePubs in a true two-page spread, with the publisher's own typesetting intact.
4. Select any word for definitions and synonyms from the offline dictionary — nothing leaves your computer.
5. 25 built-in themes in dark, light and monospace, with four typefaces bundled in the app.
6. PDFs, images and web pages open read-only in their own tabs, so nothing gets edited by accident.

---

## Restricted capabilities  (Submission options -- REQUIRED)

_Not "Notes for certification": that heading on the Submission Options page is a link to
the separate Additional Testing Information page, not a box. The required box is this one,
and it asks a narrower question -- why the capability is needed and how it is used._

**Hard limit: 500 characters.** The box silently stops accepting input; it does not warn.
The text below is exactly 500, which the box accepts. Anything longer gets truncated mid-sentence, which reads worse to a
reviewer than a short answer does.

TypoZen is a Win32 desktop app packaged as MSIX (Desktop Bridge). A packaged desktop app cannot run without runFullTrust: it is .NET/WPF hosting WebView2, not a sandboxed UWP app.

Used for ordinary document editing: opening and saving files at paths the user picks in standard Windows dialogs (Markdown, text, ePub, PDF, images), which AppContainer forbids, and reading bundled fonts and dictionary from the install dir.

The only capability declared. No network use, no data collection, no sign-in.

---

## Additional Testing Information  (optional)

No account, sign-in or purchase is needed; all functionality is available immediately.

To exercise the main paths: open any .md or .txt file to edit it, and any .epub to read it. For the paginated two-page spread, use the two buttons at the right of the toolbar -- click "Scroll" so it reads "Pages", then click "1-Col" so it reads "2-Col". Two columns require pagination, so that order matters. PDFs, images and web pages open read-only in their own tabs.

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

Write Markdown and watch it become the page as you type. Read ePubs in a real two-page spread. One quiet window, 25 themes, an offline dictionary, and nothing sent anywhere.

Leave **Short title** and **Voice title** empty -- both are Xbox-only (installation screens
and Kinect voice). Leave the three **Xbox images** empty for the same reason: Xbox is
unchecked as a device family, and a full-trust Win32 app cannot run there.

---

## Store artwork

Generated by `tools/Build-StoreArt.ps1` into `dist-storeart\`.

| Slot | File | Notes |
| --- | --- | --- |
| 9:16 Poster art | `PosterArt-720x1080.png` | Main logo for Windows 10/11 customers |
| 1:1 Box art | `BoxArt-1080x1080.png` | Used across various Store layouts |
| 16:9 Super hero art | `SuperHeroArt-1920x1080.png` | Top of the listing. **No product title** -- the slot forbids it |
| Store display images (300/150/71) | -- | Leave empty; the package tiles cover these |

---

## Copyright and trademark info

© 2026 Ed C. TypoZen is open source under the MIT licence.

---

## A note on the numbers

Verified against the shipping build on 6 September 2026:

| Claim | Source |
| --- | --- |
| "over 150,000 definitions" | `dictionary.tsv` — 152,459 entries (Open English WordNet 2025+, from 2026-09-19; was 147,478 from WordNet 3.1) |
| "over 110,000 synonym sets" | `thesaurus.tsv` — 114,022 entries (was 110,543) |
| "25 themes" | `TypoZen_Themes.json` — 25 entries |
| "200,000-character manuscript" | `tests/large-scroll-mixed.md` — 214,626 bytes |
| "no network requests" | no HttpClient/WebRequest/socket in the host; no fetch/XHR/sendBeacon in the page |

The About dialog once said "Over 150,000 offline definitions" and "40,000+ block
documents". The first overstated the dictionary by about 2,500 entries at the time (it is
true since the Open English WordNet data, 152,459 entries); the second is a
design aspiration from `docs/developer-editor-analysis.md` rather than a measured figure
— the largest document under test is 3,767 blocks. Neither claim is repeated here.
