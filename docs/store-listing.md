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

Select any word for definitions, synonyms and how often it appears in what you are reading. Nearly 150,000 definitions and over 110,000 synonym sets, all on your disk. No lookup ever leaves your computer.

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
5. Offline dictionary and thesaurus — nearly 150,000 definitions, no lookup ever leaves your computer
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

## Notes for certification

_Partner Center → Submission options → "Notes for certification". Pre-empts the
`runFullTrust` package warning, which every MSIX-packaged Win32 app raises._

TypoZen is a Win32 desktop application packaged as MSIX (Desktop Bridge), so it declares `runFullTrust`. This is required because the app is a document editor: it opens and saves files at arbitrary paths chosen by the user through standard file dialogs, and reads its own assets (fonts, dictionary, themes) from the install directory. It declares no other restricted capabilities.

The app makes no network requests of its own and collects no data. Everything it stores is local, under %LOCALAPPDATA%\TypoZen_Cache, and can be cleared from File → Privacy.

To exercise the main paths: open any .md or .txt file to edit it, and any .epub to read it. For the paginated two-page spread, use the two toolbar buttons on the right of the toolbar: click "Scroll" so it reads "Pages", then click "1-Col" so it reads "2-Col" (two columns require pagination, so that order matters). PDFs, images and web pages open read-only in their own tabs. No account or sign-in is needed and there is nothing to purchase.

Source code and issue tracker: https://github.com/ec928/TypoZen
Privacy policy: https://github.com/ec928/TypoZen/blob/master/PRIVACY.md

---

## Copyright and trademark info

© 2026 Ed C. TypoZen is open source under the MIT licence.

---

## A note on the numbers

Verified against the shipping build on 6 September 2026:

| Claim | Source |
| --- | --- |
| "nearly 150,000 definitions" | `dictionary.tsv` — 147,478 entries |
| "over 110,000 synonym sets" | `thesaurus.tsv` — 110,543 entries |
| "25 themes" | `TypoZen_Themes.json` — 25 entries |
| "200,000-character manuscript" | `tests/large-scroll-mixed.md` — 214,626 bytes |
| "no network requests" | no HttpClient/WebRequest/socket in the host; no fetch/XHR/sendBeacon in the page |

The About dialog currently says "Over 150,000 offline definitions" and "40,000+ block
documents". The first overstates the dictionary by about 2,500 entries; the second is a
design aspiration from `docs/developer-editor-analysis.md` rather than a measured figure
— the largest document under test is 3,767 blocks. Neither claim is repeated here.
