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

$dirs = @('css', 'fonts', 'js')
foreach ($d in $dirs) {
    if (Test-Path $d) {
        Copy-Item $d -Destination bin\ -Recurse -Force
    } else {
        Write-Warning "Directory not found: $d"
    }
}

Write-Host "Portable build created in bin/"
