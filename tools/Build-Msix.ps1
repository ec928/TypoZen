# Build-Msix.ps1 - pack the proven bin/ staging build as an MSIX.
#
# WHY THIS AND NOT THE SDK-STYLE MSIX TOOLING: TypoZen targets .NET Framework 4.7.2 and is
# compiled through a PowerShell CodeDOM provider, not MSBuild, so <WindowsPackageType>MSIX
# and single-project packaging are unavailable - both need SDK-style .NET 5+ projects.
# MakeAppx over a loose folder is the supported route for exactly this shape of app, and
# TypoZen is already a loose-file portable build, which is what MakeAppx wants as input.
#
# Source is bin/, NOT the project root: the pipeline proves a build in bin/ before it goes
# anywhere, and a package is somewhere. See the publish pipeline notes in README.
#
#   .\tools\Build-Msix.ps1              # stage + pack -> dist-msix\TypoZen.msix
#   .\tools\Build-Msix.ps1 -Register    # stage + register loose for testing (no signing)
#
# -Register is the development loop. It installs the staged folder as a real packaged app -
# same identity, same AppData redirection, same read-only install directory - without
# needing a certificate. Developer Mode must be on.

param(
    [switch]$Register,
    [string]$Version = $null
)

$ErrorActionPreference = 'Stop'
$root    = Split-Path $PSScriptRoot -Parent
$bin     = Join-Path $root 'bin'
$stage   = Join-Path $root 'dist-msix\stage'
$outDir  = Join-Path $root 'dist-msix'

if (-not (Test-Path (Join-Path $bin 'TypoZen.exe'))) {
    throw "No proven build in bin/. Run Build_TypoZen.ps1 first, then publish to bin/."
}

# Version comes from the binary that is actually being packaged, so the manifest can never
# disagree with the app it contains.
if (-not $Version) {
    $src = Get-Content (Join-Path $root 'TypoZen_App.cs') -Raw
    if ($src -match 'AppVersion\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"') { $Version = $Matches[1] }
    else { throw "Could not read AppVersion from TypoZen_App.cs" }
}
# MSIX versions are four-part and the REVISION must be 0 for Store submission.
$pkgVersion = "$Version.0"
Write-Host "Packaging TypoZen $pkgVersion" -ForegroundColor Cyan

# ---- Stage -----------------------------------------------------------------------------
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# Everything the app needs, and nothing it writes. debug.log and the stamped runtime
# template are per-run artifacts; typozen_books is a cache that now lives in LocalAppData.
$skip = @('debug.log', 'TypoZen_Template.runtime.html', 'TypoZen_Template_Test.html', 'TypoZen.pdb')
Get-ChildItem $bin -Force | Where-Object {
    -not ($_.PSIsContainer -and $_.Name -in @('typozen_books', 'typozen_load'))
} | ForEach-Object {
    if ($_.PSIsContainer) {
        Copy-Item $_.FullName -Destination $stage -Recurse -Force
    } elseif ($_.Name -notin $skip) {
        Copy-Item $_.FullName -Destination $stage -Force
    }
}

# ---- Store assets ----------------------------------------------------------------------
# Drawn at each target size rather than rescaled from the .ico: the mark carries a stroked
# arc and a text shadow, both of which smear when a 44px tile is resampled from 256px.
#
# Only the FUNCTION is taken from Generate_Icon.ps1. Dot-sourcing it would run the script,
# and the script's job is to rewrite TypoZen.ico - a tracked file that has no business
# changing because a package was built.
Add-Type -AssemblyName System.Drawing
$iconSrc = Get-Content (Join-Path $root 'Generate_Icon.ps1') -Raw
$cut = $iconSrc.IndexOf('# Generate 4 standard icon resolutions')
if ($cut -lt 0) { throw "Generate_Icon.ps1 no longer has its generation marker; check before packaging." }
Invoke-Expression $iconSrc.Substring(0, $cut)
$assets = Join-Path $stage 'Assets'
New-Item -ItemType Directory -Path $assets -Force | Out-Null

$sizes = @{
    'Square44x44Logo.png'   = 44
    'Square150x150Logo.png' = 150
    'StoreLogo.png'         = 50
    'Square71x71Logo.png'   = 71
    'Square310x310Logo.png' = 310
}
foreach ($name in $sizes.Keys) {
    $bmp = Draw-TypoZenBitmap -size $sizes[$name]
    $bmp.Save((Join-Path $assets $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
# Wide tile: the square mark centred on a transparent 310x150 canvas.
$wide = New-Object System.Drawing.Bitmap(310, 150, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$wg = [System.Drawing.Graphics]::FromImage($wide)
$wg.Clear([System.Drawing.Color]::Transparent)
$mark = Draw-TypoZenBitmap -size 150
$wg.DrawImage($mark, [int]((310 - 150) / 2), 0, 150, 150)
$mark.Dispose(); $wg.Dispose()
$wide.Save((Join-Path $assets 'Wide310x150Logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$wide.Dispose()
Write-Host "  Assets drawn ($($sizes.Count + 1) tiles)."

# ---- Manifest --------------------------------------------------------------------------
# Identity Name and Publisher are ISSUED by the Store, not chosen. These are TypoZen's,
# from Partner Center > Product Identity (Store ID 9NGKCK27GTS1, package family
# ZenDevelopment.TypoZen_e6avwemwk7mrj). Publisher is the CN of the certificate the Store
# signs with, which is why it is a GUID rather than a name -- and why a locally signed
# test build needs a certificate whose subject is exactly this string. Changing either of
# these breaks the package family: an installed copy would be treated as a different app
# rather than an update.
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  IgnorableNamespaces="uap rescap desktop">

  <Identity Name="ZenDevelopment.TypoZen" Publisher="CN=7A78FE91-82F4-4B93-8556-7AD161523819" Version="$pkgVersion" ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>TypoZen</DisplayName>
    <PublisherDisplayName>Zen Development</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-gb" />
  </Resources>

  <Applications>
    <Application Id="TypoZen" Executable="TypoZen.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="TypoZen"
        Description="Paginated ePub reader and WYSIWYG Markdown editor."
        BackgroundColor="transparent"
        Square150x150Logo="Assets\Square150x150Logo.png"
        Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png"
                         Square71x71Logo="Assets\Square71x71Logo.png"
                         Square310x310Logo="Assets\Square310x310Logo.png" />
        <uap:SplashScreen Image="Assets\Square310x310Logo.png" />
      </uap:VisualElements>
      <Extensions>
        <uap:Extension Category="windows.fileTypeAssociation">
          <uap:FileTypeAssociation Name="typozen.documents">
            <uap:DisplayName>TypoZen Document</uap:DisplayName>
            <uap:Logo>Assets\Square44x44Logo.png</uap:Logo>
            <uap:SupportedFileTypes>
              <uap:FileType>.md</uap:FileType>
              <uap:FileType>.markdown</uap:FileType>
              <uap:FileType>.txt</uap:FileType>
              <uap:FileType>.epub</uap:FileType>
            </uap:SupportedFileTypes>
          </uap:FileTypeAssociation>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>

  <Capabilities>
    <!-- The only one needed. A full-trust desktop app is NOT sandboxed for file access:
         it reads and writes arbitrary paths as the user, so remembered documents reopen
         exactly as they do unpackaged. broadFileSystemAccess is an AppContainer concern
         and does not apply here. -->
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@
$manifestPath = Join-Path $stage 'AppxManifest.xml'
[System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  Manifest written."

# ---- Register or pack ------------------------------------------------------------------
if ($Register) {
    Write-Host "`nRegistering the staged folder as a packaged app..." -ForegroundColor Yellow
    Add-AppxPackage -Register $manifestPath -ForceUpdateFromAnyVersion
    Write-Host "Registered. Launch it from the Start Menu as 'TypoZen'." -ForegroundColor Green
    Write-Host "Remove with: Get-AppxPackage *TypoZen* | Remove-AppxPackage" -ForegroundColor Gray
    return
}

$makeappx = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter makeappx.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe not found. Install the Windows 10/11 SDK." }

$msix = Join-Path $outDir 'TypoZen.msix'
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx.FullName pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }

Write-Host "`nPackage: $msix" -ForegroundColor Green
Write-Host ("  {0:N1} MB" -f ((Get-Item $msix).Length / 1MB)) -ForegroundColor Gray
Write-Host "`nUnsigned. The Store signs on submission; to install locally, sign it with a" -ForegroundColor Gray
Write-Host "trusted certificate whose subject matches Publisher above, or use -Register." -ForegroundColor Gray
