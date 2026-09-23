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
    'WORDNET-LICENSE.txt',
    'TypoZen.pdb'
)

foreach ($f in $files) {
    if (Test-Path $f) {
        Copy-Item $f -Destination "$dist\" -Force
    } else {
        Write-Warning "File not found: $f"
    }
}

# fonts/ rides here with css/ and js/. It used to be an explicit allowlist of ten
# filenames, which silently dropped anything new -- which is how the .ttf files
# shipped for months with no OFL.txt beside them, and the OFL requires that text
# to travel with the faces.
$dirs = @('css', 'js', 'fonts')
foreach ($d in $dirs) {
    if (Test-Path $d) {
        Copy-Item $d -Destination "$dist\" -Recurse -Force
    } else {
        Write-Warning "Directory not found: $d"
    }
}

$toolsDst = Join-Path $dist 'tools'
New-Item -ItemType Directory -Force -Path $toolsDst | Out-Null
$makeDict = Join-Path 'tools' 'Make-Dictionary.ps1'
if (Test-Path $makeDict) {
    Copy-Item $makeDict -Destination $toolsDst -Force
} else {
    Write-Warning "tools/Make-Dictionary.ps1 not found"
}

# The narration sidecar and the narrator's voice-print. Inert without the narration
# extension's Python environment, which is set up by hand; with it, the app runs this copy.
$narrSrc = Join-Path 'tools' 'qwen-narrator'
if (Test-Path $narrSrc) {
    $narrDst = Join-Path $toolsDst 'qwen-narrator'
    New-Item -ItemType Directory -Force -Path $narrDst | Out-Null
    Get-ChildItem $narrSrc -File | Where-Object { $_.Extension -in '.py', '.npy' } | Copy-Item -Destination $narrDst -Force
} else {
    Write-Warning "tools/qwen-narrator not found"
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
