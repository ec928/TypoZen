# TypoZen Privacy Policy

_Last updated: 25 September 2026._

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
%LOCALAPPDATA%\TypoZen_Cache_Portable
```

(The Microsoft Store version uses a folder of its own, which Windows keeps inside the app's
package data.)

| File | What it holds |
| --- | --- |
| `settings.json` | Your preferences, including the last 8 search terms |
| `recent_files.json` | Paths of documents you have opened recently |
| `tabs_session.txt` | Which documents were open when you last closed the app |
| `book_positions.txt` | How far through each epub you have read |
| `bookmarks.txt` | Bookmarks you have placed |
| `typozen_user.lex` | Words you added to the spelling dictionary |
| `window_state.json` | Window size and position |
| `debug.log` | Diagnostic output: errors, and the steps of each read-aloud (voice, timings — never the text). Run with `--debug` it also records the editor's own diagnostics, which can include file paths. Kept to about 4 MB |
| `perf.log` | Start-up timings, written only when the `TYPOZEN_PERF` environment variable is set |

If you install the optional extensions in **File → Extensions**, they keep their files in
`extensions\` and `dictionaries\` in the same folder. Qwen narration adds, in
`extensions\QwenTTS\`:

| File | What it holds |
| --- | --- |
| `narration\` | Audio of text you have had narrated, kept so it plays at once next time |
| `cast\` | For each book you gave characters voices: the book's path, and which voice each character has |
| `voices\`, `narrator.json` | Voices you designed, with the descriptions you wrote, and the narrator's voice and style |
| `narration.log`, `install.log` | Timings and steps; no book text and no file paths |

Voices you design stay in that folder. A voice cannot be made again, so Narrator Settings
can **Export** one to a `.tzvoice` file wherever you choose, and **Import** it back. TypoZen
makes no copy of its own. (Versions 0.5.2 and earlier copied each voice to
`OneDrive\TypoZen\Narrator voices` when OneDrive was set up; those copies are left where
they are.)

Your documents themselves are saved wherever you choose to save them. TypoZen does not
copy them anywhere else.

Some of this data can identify you indirectly — a file path may contain your user name,
and recent files and search terms describe what you have been working on. That data
never leaves your computer, but it is on your computer, which is why the controls below
exist.

## Your controls

Under **File → Privacy**:

- **Privacy Mode** — stops TypoZen writing anything that names a document: no session, no
  reading positions, no bookmarks, no recent files, no autosave, no `debug.log`. Books are
  unpacked, and narration audio rendered, into a temporary folder deleted when TypoZen
  closes; a narrator cast you save is kept only until then. It is forward-looking: it
  prevents new writes but does not delete what is already stored.
- **Remember unsaved documents between sessions** — turn off to stop unsaved content being
  kept between runs.
- **Keep recent files list** — turn off to stop recording opened documents.
- **Clear Recent Searches** — erases the stored search terms.
- **Clear Stored Data…** — deletes the stored data described above, including the
  diagnostic logs and, if you choose, narration audio, logs and casts. Voices are kept;
  delete them one at a time in Narrator Settings. Extensions are removed in
  **File → Extensions**.

You can also simply delete that folder.

## Network activity

TypoZen makes no network requests of its own unless you install an extension. Fonts are bundled with the app rather than
fetched, the editor page is served from local disk, and the dictionary and thesaurus are
local files.

Three things can still cause network traffic, and you should know about all of them:

- **Extensions you install.** **File → Extensions** downloads only while an install you
  started is running, and nothing about you or your documents is sent. Kokoro voices come
  from cdn.jsdelivr.net and huggingface.co; the Wiktionary dictionary from this project's
  GitHub releases. Qwen narration fetches Python from github.com, its libraries from
  pypi.org and download.pytorch.org, and its models from huggingface.co, each at a pinned
  version. Once installed, the narrator runs with the network off and answers only
  programs on the same PC.
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
