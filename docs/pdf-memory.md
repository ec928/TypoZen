# PDF memory after the shared worker

Measured 2026-11-18 on this machine, against the project tree's `TypoZen.exe`
(it loads `js/` from beside itself). That build was installed afterwards: the
Start Menu exe matched it. The version string stayed 0.20.23. This work did
not bump it. Commit `4659f0d`. Published in 0.20.24.

The sections through "Not tried" are what one renderer does when it is kept.
The last section is the bound.

The 2026-11-14 encyclopedia numbers are in `known-issues.md` ("Memory still grew
after the worker was shared") and `backlog.md`. That file was not on this
machine, so it was not opened again. The probes below use a generated PDF.

## What still grows

Twelve pages, each a unique solid 1200×1600 DeviceRGB image. OCR off. Open,
scroll until about ten pages are drawn, close by opening a markdown file,
forced GC, repeat. Each drawn canvas is 820×1150 (CSS 656×920 at
`devicePixelRatio` 1.25). A pixel read from the first canvas is a page grey,
not black.

GPU-process private bytes, four round trips, several runs:

| Run | Start | After each close |
|---|---|---|
| Page canvas as PDF.js shows it | 102 MB | 185, 253, 315, 378 |
| `contain: none` on that canvas | 103 MB | 186, 254, 315, 375 |
| Canvas zeroed while still shown, then removed | 96 MB | 183, 251, 310, 373 |
| Same canvas elements handed out again | 103 MB | 183, 247, 303, 362 |

About 60–80 MB a round trip. Four trips did not level off. Closing the PDF did
not return it. The GPU process working set stayed around 80–95 MB, so a tool
that shows working set can look flat while private bytes climb. One shared
worker the whole time.

Renderer private bytes on close moved around (about 160, then 105, 130, 99 in
one run) rather than adding 60 MB a round. Total working set did not march
37 MB a round on this file. The 2026-11-14 figure (renderer working set, the
encyclopedia, eight trips, 405 → 759 MB) is a different counter and a different
PDF.

Two pages, no scroll: one canvas each, 820×1150. GPU private 102 → 117 → 129.
About 6–7 MB a page. `ImageBitmap.close` ran once per image (2, then 4). After
close, no canvas was left in the document.

With the ten-page scroll, `close` also ran once per image (12, then 26, 40, 54
across four trips) and the canvas count in the document was 0 after each
close. The bitmaps are closed. The private bytes stay.

## What the viewer does

PDF.js 6.3.289 paints the page off the document from `ImageBitmap`s, then
inserts the canvas. On a four-page file every page draw was off the document
(4 off, 0 on). The context is `{ alpha: false, willReadFrequently: true }`
because `enableHWA` is left false.

`PDFPageView.reset` removes the canvas wrapper first. `_resetCanvas` then sets
`width` and `height` to 0. Teardown calls `destroy()` on each page, then looks
for canvases still inside `#pdfView` and zeros those. The second pass finds
none. `releaseDocument` clears the loading task's worker reference when it is
the session worker, then `destroy()`s the task, so the document gets
`Terminate` and the session worker stays.

`js/vendor/pdfjs/typozen-pdf.worker.mjs` forces `willReadFrequently` on the
worker's `OffscreenCanvas`. On the image PDF, GPU working set had been climbing
about 35 MB a round trip; with the hook it stayed around 86–95 MB. GPU private
bytes still climbed, on every run above, with the hook loaded. The comment in
that file says close gives the bitmap back. The private-byte counter did not
come down.

Both files are uncommitted: `10-pdf.js` (worker URL and `releaseDocument`) and
the untracked worker wrapper. `Update-PdfJs.ps1` does not know the wrapper.

## Attempts that left the climb as it was

Each of these was taken back out after the measurement, except the worker
wrapper and `releaseDocument`, which are still in the tree.

- A `getContext` hook on the page canvas forcing `willReadFrequently`. PDF.js
  already asks for that. GPU private still climbed.
- `isImageDecoderSupported: false`.
- `disableFontFace: true`. Also changes how text is drawn. Not kept.
- Destroying the shared worker on every close. Private bytes still climbed,
  and every close then started a new worker. The null-out in
  `releaseDocument` puts back the one-worker behaviour from 0.20.12.
- An extra `commonObjs` / page-object clear on top of `destroy()`.
- `--disable-accelerated-2d-canvas` on the WebView. Reverted in
  `TypoZen_App.cs`. The climb was still there.
- `contain: none` on the page canvas, computed style `none`. Same climb as
  `contain: content`. The rule in `pdf_viewer.css` is unchanged.
- Zeroing the page canvas, and the detail canvas, while it was still in the
  document, inside `PDFPageView.reset`, before PDF.js removed the wrapper.
  Pages still painted. Same climb.
- Copying the painted canvas onto a fresh one before PDF.js inserted it. The
  first version read `ui.PDFPageView` where the module is `S.ui`, threw while
  loading the viewer, and the PDF never opened (`PDFPageView` is exported; the
  binding was wrong). That was removed before a memory run. An earlier copy
  done outside the viewer, on a canvas painted off the document, raised
  renderer private and did not remove a GPU climb that path did not have.
- Pooling canvas elements (`document.createElement`, `remove`, `replaceWith`)
  so PDF.js resized the same elements. The probe created 11 canvases on the
  first open and no further ones. GPU private still went 183, 247, 303, 362.
  The pool is not in the tree. It also would have handed a used canvas to
  every `createElement('canvas')` in the page, not only PDF.js.

A Chromium memory-infra trace was started after two opens. `requestMemoryDump`
returned ids and no trace events arrived. A second collection that reads the
trace stream was not run.

## What levels off, outside this viewer

Same machine, same WebView, an `overflow: auto` box. Two 820×1150 canvases,
resized and painted again, shown, removed. GPU private:

| Construction | Private bytes across repeats |
|---|---|
| `fillRect` on the same two elements, four times | 103, 133, 142, 142, 142 |
| A new 1200×1600 `ImageBitmap` drawn onto those elements | 103, 131, 141, 141 |
| That bitmap created in a worker, transferred, drawn, `close`d, four times | 102, 129, 137, 137, 137 |
| `putImageData` on the elements after the row above | stayed at 141–142 |
| `ImageBitmap` created on the page and `close`d, never shown | stayed at 115 |
| Same elements removed and put back, no new element | stayed flat |

New elements, thrown away each time, keep a smaller climb: about 8–15 MB of
GPU private per pair of canvases in `#pdfView` on the second pair, including
with `willReadFrequently: false`. Two JPEG `<img>`s were about 3 MB a pair
(96, 115, 118, 121, 124). A `fillRect` pair in `#main-container` was about
6 MB on the second pair.

PDF.js rendering off the document, then destroying the document and keeping
the worker, left GPU private flat. Rendering into a canvas already in the
document, then zeroing it, added about 40 MB a round. Painting off the
document, attaching the canvas, then zeroing it, did not add that GPU climb.
Putting those canvases into `.page` / `.canvasWrapper` inside `#pdfView` and
clearing the host without zeroing moved GPU private 96, 131, 147, 158
(slowing) and renderer private about 30–40 MB a round.

So a reused canvas, and a worker bitmap drawn onto one, level off. Opening
this PDF in the viewer does not, including when the canvas elements themselves
are reused and the bitmaps are closed.

## Not tried

- The 536-page encyclopedia.
- A text PDF through the same four-trip probe. The 2026-11-14 note did not
  separate text from scans either.
- `textLayerMode` and `annotationMode` turned off on the viewer probe.
- A memory-infra dump that actually returned allocator sizes.

The local probes that produced the tables above were not part of the suite,
and they are not in the tree.

## Bound: the PDF renderer is destroyed after five opens

Decided 2026-11-18. A count of five, not a GPU-private cap. Installed the same
day. `Program.AppVersion` was already `0.20.23` before this change.

PDFs open on their own WebView (`_pdfWebView`) that loads the same template as
the editor. The native WebView is a different control, used for images, media,
HTML, and for printing the original PDF. The editor WebView stays up for the
session. The PDF view and the editor share one environment and one GPU process.
Hiding the PDF view does not release its renderer. `RetirePdfSurface` removes the control and disposes it, which ends
that renderer. The GPU process stays because the editor view is still there.

`PdfRendererRefreshOpens` is 5. Every host `OpenPdf` counts, including the
same file opened again. Two things do not count: the PDF already on screen
(the early return in `OpenPdf`), and a theme redraw (`tzPdfThemeChanged`
reopens the URL inside the page and never calls `OpenPdf`).

Leaving a PDF when the count is already 5 disposes the renderer
(`LeavePdfSurface`, from `ShowEditorSurface` and `ShowNativeSurface`). Opening
another PDF while the fifth is still showing disposes it at the start of that
open, before the new open is counted. The count goes back to 0 inside
`RetirePdfSurface`. Opens 1–5 of a cycle share one renderer and stay fast.
The first open of a session also creates the view, so that one create is slow
once. Leaving the fifth destroys it. The sixth open creates the next view and
is open 1 of the next cycle. The eleventh open is the next create. The
renderer is not disposed while that PDF is still the one on screen.

Page number and unsaved annotation bytes are already stashed on the leave
path before the surface changes. The password is already dropped there.

The PDF page posts `ready_pdf:` because `window.__tzPdfSurface` is set before
navigation. The host handles that before the `ready` session restore, and
does not restore the session from the PDF page. `savePreferences` returns
immediately on that page so the shared `localStorage` key `typozen_prefs` is
not overwritten.

### Prototype, not the product

A minimal PDF.js page, browser already warm. Keeping the view and destroying
only the document: GPU private 63 MB, then 139, 203, 257. Disposing the PDF
view while a blank WebView kept the GPU process up: 63, then 143, 138, 138.
The PDF renderer exited each time (2 while open, 1 after). About 75 MB stayed
after the first PDF, and later disposes stayed there.

Warm reopen to a painted pixel: about 45–70 ms. A fresh view: about 2213 ms
of create and script load, about 2276 ms to first paint. That extra wait of
about 2.2 s is the minimal page. It is not the TypoZen template.

### Product measurement

Project exe, hidden desktop, the same 12-page file. Each open scrolled until
about ten page canvases existed. The painted mark is a flat gray image pixel.
The first canvas is often white (an off-screen page), so white was not
treated as painted and not treated as a failed open.

GPU-process private bytes, one renderer for opens 1–5:

| Open | GPU private | Renderers | Time to a gray pixel |
|---|---|---|---|
| 1 | 192 MB | 2 | session create, not timed the same way |
| 2 | 227 MB | 2 | 283 ms |
| 3 | 255 MB | 2 | 272 ms |
| 4 | 270 MB | 2 | 274 ms |
| 5 | 269 MB | 2 | 269 ms |

After leaving the fifth, the renderer count went from 2 to 1. GPU private
eased 276, 274, 262, 262, 258 MB over about 6 s. It did not return to the
open-1 192 MB. Open 6 created the renderer again (count 2), painted gray
200,200,200 in 537 ms, and GPU private was 251 MB. It did not take another
step on top of the fifth open.

Warm reopens on the live renderer were 269–283 ms. The sixth open, a new copy
of the full template with the environment already warm, was 537 ms. The extra
wait on this machine for this file was about 0.27 s. An earlier pass of the
same probe, with a shallower scroll, was the same shape: GPU private climbed
less (170 to 209), dropped to 181 after the fifth leave, and the sixth open
was 548 ms at 179 MB.

Inside this one renderer the climb was smaller than the earlier same-renderer
series (102, 185, 253, 315, 378) and had already slowed by opens 4 and 5.
After the dispose, about 60 MB stayed above the open-1 reading (258 versus
192), in the same range as the prototype's floor.

Find, Read Aloud, and annotations were not re-run on the second page. The
probe opened the file, left it, and opened it again, and a gray image pixel
painted. `core-smoke-app.mjs` passed on its own after the build (14 passed,
8 s). The version smoke inside `Build_TypoZen_NoTest.ps1` failed that same
check once, in 2.1 s, while the other checks in that run passed; the solo
rerun passed. `pdf-worker-app.mjs` opens seven PDFs and was not run. The
compile warned CS4014 because `OpenPdf` is now `async void` and the existing
`Dispatcher.BeginInvoke` for the recent-file write is not awaited. That call
still runs the same way.

A continuous scroll of one long book was not measured. The count does not cap
that. The encyclopedia file was not on this machine.
