$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path bin | Out-Null

$files = @(
    'TypoZen.exe',
    'TypoZen.xaml',
    'TypoZen.ico',
    'TypoZen_Template.html',
    'TypoZen_Themes.json',
    'WebView2Loader.dll',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'dictionary.tsv',
    'thesaurus.tsv',
    'README.md',
    'LICENSE',
    'WORDNET-LICENSE.txt'
)

foreach ($f in $files) {
    if (Test-Path $f) {
        Copy-Item $f -Destination bin\ -Force
    } else {
        Write-Warning "File not found: $f"
    }
}

$dirs = @('css', 'js')
foreach ($d in $dirs) {
    if (Test-Path $d) {
        Copy-Item $d -Destination bin\ -Recurse -Force
    } else {
        Write-Warning "Directory not found: $d"
    }
}

# Fonts: OFL faces only. Bookerly is Amazon's and must not ship.
$fontDst = Join-Path 'bin' 'fonts'
New-Item -ItemType Directory -Force -Path $fontDst | Out-Null
$fontAllow = @(
    'Inter.ttf', 'Inter-Italic.ttf',
    'Literata.ttf', 'Literata-Italic.ttf', 'Literata-Bold.ttf', 'Literata-BoldItalic.ttf',
    'Merriweather.ttf', 'Merriweather-Italic.ttf',
    'SourceSans3.ttf', 'SourceSans3-Italic.ttf'
)
foreach ($f in $fontAllow) {
    $src = Join-Path 'fonts' $f
    if (Test-Path $src) {
        Copy-Item $src -Destination $fontDst -Force
    } else {
        Write-Warning "Font not found: $src"
    }
}
$bookerly = @(Get-ChildItem (Join-Path $fontDst 'Bookerly*.ttf') -ErrorAction SilentlyContinue)
if ($bookerly.Count -gt 0) {
    Write-Error "Bookerly must not ship. Remove $($bookerly.Name -join ', ') from bin/fonts before distributing."
    exit 1
}

Write-Host "Portable build created in bin/"
