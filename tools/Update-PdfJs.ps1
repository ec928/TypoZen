# Update-PdfJs.ps1 -- copy the parts of pdfjs-dist that TypoZen ships into js\vendor\pdfjs.
#
#   npm install --save-dev --save-exact pdfjs-dist@<version>
#   .\tools\Update-PdfJs.ps1
#
# Only what the reader uses: the library and its worker, the viewer component and its CSS
# and icons, and the data the library loads for some PDFs (character maps, standard
# fonts, image decoders, colour profiles). Source maps and the legacy build stay out.
# PDF.js is Apache-2.0; its LICENSE ships beside it.
#
# ASCII only. Windows PowerShell 5.1 reads a BOM-less file as ANSI.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'node_modules\pdfjs-dist'
$dst = Join-Path $root 'js\vendor\pdfjs'
if (-not (Test-Path $src)) { throw "pdfjs-dist is not installed - run: npm install --save-dev --save-exact pdfjs-dist@<version>" }

$version = (Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json).version
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null

foreach ($f in 'build\pdf.min.mjs', 'build\pdf.worker.min.mjs', 'web\pdf_viewer.mjs', 'web\pdf_viewer.css', 'LICENSE') {
    Copy-Item (Join-Path $src $f) $dst
}
foreach ($d in 'web\images', 'cmaps', 'standard_fonts', 'wasm', 'iccs') {
    Copy-Item (Join-Path $src $d) (Join-Path $dst (Split-Path $d -Leaf)) -Recurse
}
# The viewer module ends with a sourceMappingURL to a map that is not shipped; harmless,
# but DevTools reports a 404 for it on every open.
$viewer = Join-Path $dst 'pdf_viewer.mjs'
$text = [IO.File]::ReadAllText($viewer)
[IO.File]::WriteAllText($viewer, ($text -replace '//# sourceMappingURL=\S+\s*$', ''), (New-Object Text.UTF8Encoding($false)))
Set-Content -Path (Join-Path $dst 'VERSION') -Value $version -Encoding ascii

$size = (Get-ChildItem $dst -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("pdfjs-dist " + $version + " -> js\vendor\pdfjs  (" + [math]::Round($size / 1MB, 1) + " MB)")
