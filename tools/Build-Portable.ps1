$ErrorActionPreference = 'Stop'

# Output goes to dist/, NOT bin/.
#
# bin/ is the publish staging copy of the private build -- see the publish pipeline --
# and it legitimately holds Bookerly, which a private build is allowed to use. Building
# the portable zip into bin/ meant two things at once, both bad: the copy steps below
# overwrote the staging area on the way past, and the Bookerly guard at the end then
# fired on the private build's own fonts, so a portable build could never finish and
# left bin/ half-overwritten when it stopped. dist/ is emptied and rebuilt each run, so
# the guard is checking what is about to ship rather than what happens to be lying about.
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

# Fonts: OFL faces only. Bookerly is Amazon's, drawn by Dalton Maag, and its copyright
# forbids redistribution -- fine in a private build, never in one handed to anyone else.
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

# The template names Bookerly in an @font-face block. Shipping that block without the
# files is a dead reference on every start; the two themes that ask for Bookerly fall
# through their stacks to Georgia / serif, which is the documented behaviour.
$tpl = Join-Path $dist 'TypoZen_Template.html'
if (Test-Path $tpl) {
    $lines = [System.IO.File]::ReadAllLines($tpl)
    $start = -1
    for ($i = 0; $i -lt $lines.Count - 1; $i++) {
        if ($lines[$i].Trim() -eq '/*' -and $lines[$i + 1] -match 'Bookerly') { $start = $i; break }
    }
    if ($start -ge 0) {
        $end = $start; $seen = 0
        while ($seen -lt 4 -and $end -lt $lines.Count - 1) {
            $end++
            if ($lines[$end].Trim() -eq '}' -and $lines[$end - 1] -match 'font-style') { $seen++ }
        }
        $note = "        /* Bookerly is NOT bundled in distributed builds: it is Amazon's, drawn by" + [Environment]::NewLine +
                "           Dalton Maag, and its copyright forbids redistribution. The two themes that" + [Environment]::NewLine +
                "           name it fall through their stacks to Georgia / serif. See README.md. */"
        $out = @()
        if ($start -gt 0) { $out += $lines[0..($start - 1)] }
        $out += $note
        if ($end + 1 -lt $lines.Count) { $out += $lines[($end + 1)..($lines.Count - 1)] }
        [System.IO.File]::WriteAllLines($tpl, $out)
        Write-Host "Stripped the Bookerly @font-face block from the portable template."
    }
}

# Last line of defence, over what is actually about to ship.
$bad = @(Get-ChildItem $dist -Recurse -Filter '*ookerly*' -ErrorAction SilentlyContinue)
if ($bad.Count -gt 0) {
    Write-Error "Bookerly must not ship. Found in dist: $($bad.Name -join ', ')"
    exit 1
}
# '@font-face {', not '@font-face': the head comment mentions the at-rule in prose, so
# the looser match counts eleven and warns on a correct build.
if ((Select-String -Path $tpl -Pattern '@font-face {' -SimpleMatch | Measure-Object).Count -ne 10) {
    Write-Warning "Expected 10 @font-face rules after stripping Bookerly; check the template."
}

Write-Host "Portable build created in $dist/"
