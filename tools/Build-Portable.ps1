$ErrorActionPreference = 'Stop'

# Output goes to dist/, NOT bin/.
#
# bin/ is the publish staging copy -- see the publish pipeline -- and building the portable
# zip into it meant the copy steps below overwrote the staging area on the way past. dist/ is
# emptied and rebuilt each run, so the checks at the end are looking at what is about to ship
# rather than at whatever happens to be lying about in a staging folder.

$dist = 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

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
        Copy-Item $f -Destination "$dist\" -Force
    } else {
        Write-Warning "File not found: $f"
    }
}

$dirs = @('css', 'js')
foreach ($d in $dirs) {
    if (Test-Path $d) {
        Copy-Item $d -Destination "$dist\" -Recurse -Force
    } else {
        Write-Warning "Directory not found: $d"
    }
}

# Fonts: OFL faces only, and now that is all there is in fonts/.
$fontDst = Join-Path $dist 'fonts'
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

# Defined here rather than inherited: the block that used to strip the Bookerly
# @font-face rule set $tpl on its way past, and when that block went with the font the
# variable went too -- leaving this check bound to $null and the whole script failing
# before it ever reported anything.
$tpl = Join-Path $dist 'TypoZen_Template.html'

# '@font-face {', not '@font-face': a comment mentioning the at-rule in prose would otherwise
# be counted and warn on a correct build.
if ((Select-String -Path $tpl -Pattern '@font-face {' -SimpleMatch | Measure-Object).Count -ne 10) {
    Write-Warning "Expected 10 @font-face rules; check the template."
}

Write-Host "Portable build created in $dist/"
