# TypoZen Privacy Policy

_Last updated: 6 September 2026 — applies to TypoZen 0.2.37 and later._

**Short version: TypoZen sends nothing anywhere. Everything it remembers stays on your
computer, and you can delete all of it from inside the app.**

TypoZen is a Markdown editor and epub reader that runs entirely on your machine. There
is no account to create, no sign-in, no sync service, no analytics, no advertising, and
no crash reporting. The developer receives no data about you or your documents — not
your files, not your file names, not usage statistics, not even a count of installations
beyond what the Microsoft Store reports to any publisher.

## What TypoZen stores, and where

TypoZen keeps its settings and reading state in a folder on your own computer:

```
%LOCALAPPDATA%\TypoZen_Cache
```

| File | What it holds |
| --- | --- |
| `settings.json` | Your preferences, including the last 8 search terms |
| `recent_files.json` | Paths of documents you have opened recently |
| `tabs_session.txt` | Which documents were open when you last closed the app |
| `book_positions.txt` | How far through each epub you have read |
| `bookmarks.txt` | Bookmarks you have placed |
| `user_words.txt` | Words you added to the spelling dictionary |
| `window_state.json` | Window size and position |
| `debug.log`, `perf.log` | Diagnostic output, written only when you run with `--debug` |

Your documents themselves are saved wherever you choose to save them. TypoZen does not
copy them anywhere else.

Some of this data can identify you indirectly — a file path may contain your user name,
and recent files and search terms describe what you have been working on. That data
never leaves your computer, but it is on your computer, which is why the controls below
exist.

## Your controls

Under **File → Privacy**:

- **Privacy Mode** — stops TypoZen writing anything that names a document: no session, no
  reading positions, no bookmarks, no recent files, no autosave. It is forward-looking:
  it prevents new writes but does not delete what is already stored.
- **Remember unsaved documents between sessions** — turn off to stop unsaved content being
  kept between runs.
- **Keep recent files list** — turn off to stop recording opened documents.
- **Clear Recent Searches** — erases the stored search terms.
- **Clear Stored Data…** — deletes the stored data described above.

You can also simply delete the `%LOCALAPPDATA%\TypoZen_Cache` folder.

## Network activity

TypoZen makes no network requests of its own. Fonts are bundled with the app rather than
fetched, the editor page is served from local disk, and the dictionary and thesaurus are
local files.

Two things can still cause network traffic, and you should know about both:

- **Documents you open.** If a document references a remote image (`![](https://…)`), that
  image is fetched when the document is displayed. That is the document's request, made
  because you opened it — not something TypoZen initiates on its own. Links you click are
  opened in your own browser.
- **Microsoft Edge WebView2.** TypoZen displays its editor using WebView2, a Microsoft
  component that is part of Windows. WebView2 may contact Microsoft for its own updating
  and diagnostics, independently of TypoZen and outside the app's control. That traffic is
  governed by [Microsoft's privacy statement](https://privacy.microsoft.com/privacystatement).

## Children

TypoZen collects nothing from anyone, including children.

## Changes

If this policy changes, the updated version will be published at this address and the date
above will change.

## Contact

Questions: <https://github.com/ec928/TypoZen/issues/new/choose>
