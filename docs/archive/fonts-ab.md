# Fonts: all `@font-face` vs only the active family

A/B against the claim that loading only the active theme’s fonts would cut startup.
Script: `node tests/fonts-ab.mjs` (opt-in; not a build gate; machine-local numbers).

Headless Chromium, cache disabled, 5 runs after one warmup. Default theme is
**Gruvbox** (`Source Sans 3`, then Inter). Heavy theme is **Gruvbox Serif**
(Merriweather, then Literata).

## Numbers (this machine, 2026-08-26)

| Variant | Nav → load (median) | applyTheme → `fonts.ready` | `.ttf` actually requested |
|---|---|---|---|
| A  all faces, Gruvbox | 76 ms | 61 ms | none |
| B  Source Sans 3 + Inter only, Gruvbox | 81 ms | 60 ms | none |
| C  all faces, Gruvbox Serif | 84 ms | 84 ms | Merriweather.ttf + Italic (9.16 MB) |
| D  Merriweather + Literata only, Gruvbox Serif | 80 ms | 84 ms | same two files, 9.16 MB |

Δ (B−A): nav +5 ms, fonts.ready −0.6 ms, bytes 0.
Δ (D−C): nav −4 ms, fonts.ready +0.2 ms, bytes 0.

That is noise. The thin set is not faster.

## What actually loaded

Chromium does not fetch a face until some used element’s computed family needs it.
`font-display: swap` is already set.

On **Gruvbox**, `document.fonts` reported Source Sans 3 (normal + italic) only.
Inter, Merriweather, Literata and Bookerly were never requested. `local('Source Sans 3')`
satisfied the stack, so even the bundled `.ttf` was not hit.

On **Gruvbox Serif**, the two 4.4 MB Merriweather files were read from disk
(~80 ms for 9 MB, which is SSD, not a network round trip). Literata came from
`local()`. Declaring the other families did not add requests.

## Verdict

Lazy-loading the active theme’s `@font-face` is **not a startup win**. The unused
faces are already free. The cost that is real is **using** Merriweather (9 MB on
disk when that theme is chosen) — subsetting `wdth`/`opsz` as the README already
notes, not toggling `@font-face` at theme change.
