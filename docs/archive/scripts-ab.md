# Scripts: nine tags vs one concatenated runtime

A/B against the claim that stamping `typozen.runtime.js` (concat of
`js/modules` in `load-order.json` order) would cut template-navigation time.
Script: `node tests/scripts-ab.mjs` (opt-in; not a build gate).

Headless Chromium, cache disabled, 7 runs after one warmup. Engine is 9 files,
1 045 480 bytes. Metric: wall time from `goto` until the last module has
evaluated (`paintCodeFences` from `08-code.js`), and until `load`.

## Numbers (this machine, 2026-08-26)

| Variant | Nav → last module eval (median) | Nav → load (median) | JS requests |
|---|---|---|---|
| A  nine `<script src>` (shipping) | 86 ms | 88 ms | 9 |
| B  one concatenated `_ab-runtime.js` | 84 ms | 87 ms | 1 |

Δ (B−A): eval −2 ms, load −1 ms.

B’s first measured run was 161 ms (cold parse of the 1 MB file); the rest sat
on 80–90 ms, same band as A.

## Verdict

Concatenation is **not a startup win**. Nine local fetches are already cheap
(disk, not HTTP). You still parse the same megabyte. A stamp-time 1 MB write
next to the sources would cost OneDrive what the HTML stamp already refuses
to pay, for a 2 ms median that is noise.

Leave the nine tags. Edit a module and reload stays a file save, not a
generated artefact to keep in step.
