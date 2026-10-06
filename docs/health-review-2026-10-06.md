# Health review 2026-10-06 (performance focus)

Snapshot of `0986376` (Release 0.14.11), read from the GitHub copy in a cloud session.
Nothing was run on Windows; the app was not launched. Timings below are Node 22 on a
Linux server running the same algorithms against the repo's own fixtures
(`tests/large-scroll-mixed.md`, 205,844 chars), so treat them as relative: a typical
laptop will be 2-3x slower. Like the other files in this folder it describes the tree on
that date, not the current one.

**Status (2026-10-06, after 0.14.11):**

| Item | State |
|---|---|
| 1. Replace All after `İ` | Fixed. `find-virt-selftest`, `find-replace-browser`. |
| 2. Replace All quadratic | Fixed: one pass. 1 MB, 71k matches: 39 s -> 8 ms. |
| 3. Source caret rebuilds the model | Line count/caret line now from CodeMirror. **Not done:** taking `fromMarkdown` out of `getMarkdownContent`, and the per-keystroke rebuild in Source's `input` handler -- the model is the save authority; deferred until large Source files feel slow, and then by rebuilding lazily (dirty flag) rather than incrementally. |
| 4. Stats + outline | Outline rebuilt only when a heading changes (stats pass and block changes); lines no longer counted twice. 1 MB pass: 18 -> 6-7 ms. **Not done:** per-block running counts, line prefix sum, skipping the outline while the sidebar is hidden. |
| 5. Scroll invalidates content cache | Fixed. |
| 6. Autosave bridge pull | Deferred: autosave is off by default. |
| 7. Dictionary index at launch | Deferred: measure a cold start first. |
| Minor: ordinal `StartsWith` | Done (70 literal calls). |
| Minor: `\b` / `\f` in host pulls | Fixed: uses the shared `JsonUnescape`. |
| Minor: `javascript:` hidden by tabs | Fixed in `sanitizeBookHtml`; plus a Content-Security-Policy on the page (no inline script or handlers; `csp-wiring-browser`). |

**Overall:** the code is in good shape for performance. The big structural costs
(virtualization, page windowing, the bridge pull for books, dictionary on disk, spelling off
the UI thread, undo byte budget, chrome-watch timer stopping) have already been found,
measured and fixed, and the comments say why. What remains are a few hot paths that still
do whole-document work per keystroke or per caret move, one quadratic loop, and one
correctness bug in find/replace that can corrupt text.

## Findings, most important first

### 1. Replace All can corrupt text after certain characters (correctness)

`findAllIndices` (`js/modules/02-layout.js:6397`) lowercases the haystack and query when
Match Case is off, then uses offsets from the **lowercased** string against the
**original**. `toLowerCase()` can change length: `'İ'` (U+0130, Turkish capital dotted I)
becomes two code units. Every match after such a character is shifted.

```
'İstanbul cat cat'  -> lowercased length 17, original 16
indexOf('cat') = 10 in the lowercased copy -> original.slice(10, 13) = "at "
```

Replace All (`replaceAllMatches`, line ~7270) and Replace both splice by those offsets, so
"cat"->"dog" after an İ writes `cdog…` and damages the surrounding text. Highlights and
navigation are also off by one. Rare in English prose, but it silently alters the document.

**Fix:** search case-insensitively without changing length, e.g. a `RegExp` built from the
escaped query with the `iu` flags (`lastIndex` loop), or fold case per character with a
length-preserving map. Add a test with `İ` before the match.

### 2. Replace All is quadratic (performance)

`js/modules/02-layout.js:7284`:

```js
for (let i = matches.length - 1; i >= 0; i--)
    next = next.slice(0, m.start) + rep + next.slice(m.end);
```

Each iteration copies the whole document. Measured on the 206 KB fixture, 234 matches:
**213 ms** against **1 ms** for a single pass (`parts.push(hay.slice(last, m.start), rep)` …
`parts.join('')`); output identical. It scales with matches × document size, so replacing
a common word in a 1 MB file freezes the page for seconds.

**Fix:** build the result in one pass from the match list (same result, linear).

### 3. Source mode rebuilds the document model on every caret move (performance)

Every `selectionchange` in Source (each keystroke, each arrow key) runs, unthrottled:

`04b-format.js:1623` selectionchange → `updateCaretLineStatus()` (`:1545`) →
`getCaretLineNumber()` with no argument (`:930`) → `getTotalLineCount()` (`:872`), whose
model shortcut is skipped in Source → `getMarkdownContent()` → in Source,
`DocumentModel.fromMarkdown(v)` (`06-render-epub.js:2741`).

So a "what line am I on" read re-splits the whole text into blocks, allocates a new
block object per line, and throws away `blockHeights`, then splits the whole text again
to count lines and again up to the caret. The same handler then also calls
`updateStats(false)`, and `updateCaretLineStatus` calls `updateStats()` (invalidating the
content cache) whenever the line changes.

Measured cost of just the line-status part: **1.4 ms** at 206 KB, **8.1 ms** at 1 MB, per
caret move, before CodeMirror's own `doc.toString()` for the new text. Source is where
large non-Markdown files open, so this is the editing path most likely to feel sluggish on
big files.

There is also a side effect: a read function mutating the model is the kind of
coupling `docs/architecture.md` warns against.

**Fix:** in Source, count lines from CodeMirror's own document (`view.state.doc.lines` and
`doc.lineAt(pos).number`, both O(log n)) instead of serializing. Keep `fromMarkdown` on the
paths that actually change mode or save, not in `getMarkdownContent`'s read path.

### 4. Preview stats + outline do whole-document work per edit and per caret move

`updateStatsNow` (`07-stats-host.js:88`) runs at most every 150-700 ms while typing or moving
the caret. In Preview it:

- joins every block into one string (`DocumentModel.toMarkdown()`) when the cache was
  invalidated, which every edit and every line change does (see 5);
- scans every character for the word count;
- splits the whole text again in `getTotalLineCount(content)` although `lines` was just
  counted;
- walks every block before the caret in `modelBlockStartLine` (`04b-format.js:910`, O(n)
  per call);
- compares the whole text with `lastSavedContent` for the dirty flag;
- then 250 ms later (`:224`) rebuilds the **entire sidebar outline DOM**
  (`updateOutline`, `:493`): regex over every block and a fresh element per heading, even
  for a caret move that changed nothing, and even when the sidebar is hidden.

Measured for the stats pass alone (without the outline DOM): **1.8 ms** at 206 KB / 4,583
blocks, **10.9 ms** at 1 MB / 22,915 blocks. It is debounced, so it is a background tax
rather than a freeze, but on a slow laptop and a large file it is a frame dropped
roughly every half second while typing.

**Fixes, cheapest first:**
- Reuse `lines` from `updateStatsNow` instead of splitting again in `getTotalLineCount`.
- Rebuild the outline only when a heading block changed (compare a signature of
  heading indices + text), not on every stats pass; skip the DOM when the outline pane is
  not visible and update only `_chapterEntries`.
- Keep a prefix sum of lines per block, spliced like `blockHeights`, so
  `modelBlockStartLine` is O(1)/O(log n).
- Keep running word/char/line counts per block (adjusted when a block's raw changes),
  so a stats pass doesn't need to join the document.
- For the dirty flag, a document version counter that remembers its value at save time
  avoids comparing the whole text.

### 5. Scrolling a virtualized document invalidates the content cache

`onVirtScroll` (`05-model.js:907`) calls `updateCaretLineStatus()` on every animation
frame, which calls `updateStats()` with the default `invalidateContent = true` whenever the
reported line changes, which it does constantly while scrolling. So scrolling a large
document re-joins and re-scans the whole document about every 700 ms, plus an outline
rebuild, although nothing was edited.

**Fix:** `updateStats(false)` from `updateCaretLineStatus` (only the caret moved). One-word
change; check that `Ln` still updates while scrolling.

### 6. Autosave pulls the whole document across the bridge after each pause

When autosave is on (off by default), `AutosaveNow` (`TypoZen_App.cs:11389`) fires 2 s
after the last stats message (`ArmAutosave` at `:7654`, re-armed by every stats message,
including caret moves). For a dirty document it calls `SyncActiveTabFromEditor` →
`FetchDocumentStateBlocking` (`:12082`), whose fast path returns the **whole document as
one `ExecuteScriptAsync` result** inside a nested `PushFrame`. The comment at `:12176`
measures that bridge at ~6 s for 1 MB. While a pull is running `_scriptBlockDepth > 0`, so
tab switches, Save and other pulls are refused or fall back.

For ordinary notes this is invisible. For a large file with autosave on, it is a
multi-second pull after every pause in typing.

**Options:** have the page push the text with `chrome.webview.postMessage` (one string
message is much cheaper than a JSON-encoded script result), or let the page send
changed blocks only. At minimum, skip autosave above a size threshold or move it to a
longer idle period for large documents.

### 7. Dictionary index read at every launch

`StartLexiconLoad` (`TypoZen_App.cs:3647`) starts `LoadLexicons` on a worker thread at
start-up, which reads the full 15.6 MB `dictionary.tsv` and 5.3 MB `thesaurus.tsv` once
to build the sparse index. It doesn't block the UI, but on a cold start on a hard disk it
competes for I/O with WebView2's own start-up reads.

**Options:** build the index on first lookup (a lookup already waits for the load), or
after the first document is ready (`ready` message), or save the ~2,400-entry index
beside the cache keyed by file size + mtime.

## Minor

- **Culture-sensitive `StartsWith` in the message dispatcher.** About 25
  `msg.StartsWith("…")` calls without `StringComparison.Ordinal` run in
  `CoreWebView2_WebMessageReceived` before reaching `stats:` (69 in the file). The cost is
  negligible, but culture comparison also ignores some zero-width characters, so
  `Ordinal` is both faster and stricter. Mechanical change.
- **`DecodeJsStringResult`** (`TypoZen_App.cs:3440`) decodes `\b` and `\f` as the
  letters `b` and `f`. Only matters if a document contains backspace or form-feed
  characters, but it changes them on a host pull. Add the two cases.
- **Book HTML hardening.** `sanitizeBookHtml` (`06-render-epub.js:2032`) is solid
  (removes `on*` attributes, script and frame elements), but its `javascript:` check is a
  regex, and browsers ignore tabs and newlines inside a scheme: `java\tscript:` gets past it
  and still parses as `javascript:`. Today that is harmless, because every link click in
  the editor is intercepted with `preventDefault`. As defence in depth, check
  `new URL(val, base).protocol` instead of a regex, and consider a Content-Security-Policy
  `<meta>` in `TypoZen_Template.html` (`script-src` limited to `localapp` + `'self'`), so
  a book or a pasted HTML fragment can never run inline script in a page that can
  message the host.

## Checked and fine

- Spelling: off the UI thread, Background priority, droppable (`SpellCheck.cs`).
- Dictionary lookups: on-disk sparse index, ~2,400 strings in memory (`Lexicon.cs`).
- Undo: full snapshots, but with a step cap by document size and a 24 MB budget
  (`04-lists.js:2448`).
- Virtual scroll: rAF-coalesced, height map spliced not discarded.
- Find highlighting: CSS Custom Highlight API, no DOM wrapping.
- Book pull on tab switch skipped; large bodies staged to `typozen_load/` rather than
  sent inline; chrome auto-hide timer stops when not needed; prefs save gated to real
  edits; disk-change check uses a stamp before reading the file.
- `TypoZen_App.cs` at 18.7k lines is a maintainability matter, already planned in
  `docs/architecture.md` Part 3; it doesn't affect run-time performance.

## Suggested order

1. Items 1 and 2 together (same function family, small, one is data-corrupting). Add tests.
2. Item 5 (one-word change).
3. Item 3 (Source line status from CodeMirror's doc).
4. Item 4, outline signature first, then the line prefix sum.
5. Items 6 and 7 when autosave or cold start comes up next.
