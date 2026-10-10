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
_Synced with the live listing (Submission 8, 0.10.10) on 2026-09-30; the Short description,
Description and Features below were rewritten in Partner Center and this file now matches --
except the Description's privacy paragraph, reworded after that (Ed, 2026-09-30) because
"makes absolutely zero network requests" is untrue once an extension is installed. Ed put
that paragraph into Partner Center on 2026-09-30._

Read ePubs in a real two-page spread, or have them read to you. Read and annotate PDFs. Write Markdown and watch it become the page as you type. One quiet window, 25 themes, text-to-speech built in, an offline dictionary/thesaurus, and nothing sent anywhere.

---

## Description

_Limit 10,000 characters. Headings are plain lines: the Store shows no formatting._

A calm place to write, and a beautiful place to read. TypoZen is a distraction-free WYSIWYG Markdown editor, a paginated ePub reader, and a full PDF reader—all built into a single, quiet window. Write your notes in the morning and read a novel in the evening, without ever changing apps, breaking your focus, or sending a single byte of data to the cloud.

Writing that stays out of your way
Type Markdown and watch it format instantly—headings, tables, task lists, and code fences render as you write. Need to edit raw markup or code? Flip seamlessly to Source mode, a genuine code editor powered by CodeMirror 6, capable of opening megabyte-sized files and hundreds of thousands of lines without a stutter. Features like Focus mode (dimming all but the current sentence), Typewriter scroll, and auto-hide chrome ensure absolute immersion.

Reading worth sitting down for
Open an ePub and TypoZen transforms into a premium reader with a genuine two-page spread. It respects the publisher's original typography while smoothly scaling to your preferred font size. PDFs open with their native outlines, text search, and full annotation support. You can even fill out forms, extract images, or read scanned pages using local text recognition.

Listen and research, completely offline
Select any text to look up its definition and synonyms using the built-in, completely offline dictionary featuring over 150,000 definitions. Sit back and use Read Aloud to hear your books or PDFs spoken in your local Windows voices. Every word, search, and definition stays strictly on your hard drive.

Private by construction, not by promise
TypoZen operates entirely offline. It features no accounts, no telemetry, no forced sync, and makes absolutely zero background network requests. The application only connects to the internet if you explicitly choose to download an optional extension.

Choose from 25 hand-crafted themes—from low-glare dark modes to warm, paper-like light modes. TypoZen bundles premium typefaces including Inter, Literata, Merriweather, and Source Sans 3, JetBrains Mono so your documents look perfect on any machine.

Free, open-source, and yours to keep.

---

## What's new in this version

_Limit 1,500 characters. These notes are the 0.15.1 package; 0.14.13 is the version live on the Store (0.14.14 was prepared but not submitted). GitHub v0.15.1, the installer, and the installed app are the same version._

- New: the Breeze narrator, an optional second narrator from File > Extensions. It designs voices from a description, clones one from a short recording, and performs sounds such as laughter.
- Narrator Manager (was Narrator Settings) is redesigned, and Narration Monitor shows exactly what each line was given, run by run, with Copy all and Clear.
- Character voices pick the right speaker far more often: actions beside a line, Mr and Mrs Bennet as two people, and British single quotes. When unsure, the narrator reads the line.
- Directing a line is simpler and more predictable: put [[how to say it]] just before the quote. "She whispered" now colours only her line, not the narration around it.
- Help > User Guide opens the full guide in a tab, and Help > Narration has been rewritten.
- Read Aloud with a narrator carries on to the end of the document. Clear Stored Data remembers your choices.

---

## Submission checklist -- ONE submission, everything in it (Ed, 2026-09-29)

Every item is changed or confirmed before Submit; nothing is left for a second pass.

| # | Where in Partner Center | What |
| --- | --- | --- |
| 1 | Product identity | "TypoZen: ePub & PDF Reader, Markdown Editor" reserved |
| 2 | Packages | the newest MSIX (0.15.1.0); every other package removed from the submission |
| 3 | Store listing: Product name | the new name selected |
| 4 | Store listing: Description, What's new, Features, Short descriptions, Search terms | this file, as it stands. What's new is the 0.15.1 text above. Description, Features, Short descriptions and Search terms were last synced on 2026-09-30 |
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
19. Images, videos and web pages open read-only in their own tabs, so nothing is edited by accident
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

In the order of the 0.10 screenshots, `dist-storeart\1.png` to `8.png` (Ed, 2026-09-29);
the first is the one shown in search.

Each caption says what its shot shows (Ed, 2026-09-29), not the feature list.

1. An ePub in a true two-page spread, in ZenMode: every control hidden until you reach for it.
2. A PDF as a two-page spread, with its own outline in the sidebar. Select any word to read aloud from there.
3. The Themes menu: 25 built-in themes in dark, light and mono, or build your own with Customise Theme.
4. Read aloud in Windows voices or optional neural voices. The paragraph being read is highlighted.
5. Select any word for the offline dictionary: its meaning, synonyms, how often it appears, and a button to hear it said.
6. Select text to format it, highlight it, add a link or search the web. The document's outline is in the sidebar.
7. Markdown shown as it will look, here in two columns, with a table being edited from its own toolbar.
8. Source view: a code editor built on CodeMirror 6, highlighting code in your theme's colours.

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
