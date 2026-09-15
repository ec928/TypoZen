# Build-Installer.ps1 -- compile the double-click installer from dist\.
#
#   .\tools\Build-Installer.ps1        -> dist-installer\TypoZen-Setup-<version>.exe
#
# The zip is not an install: it leaves the user to unzip it somewhere and find the exe,
# with no Start Menu entry and no way to remove it. This produces a normal Windows
# installer for the same payload. It does NOT remove the "Windows protected your PC"
# warning -- that needs a signing certificate, and the Store build is the only route
# that avoids it today.
#
# Requires Inno Setup 6:  winget install JRSoftware.InnoSetup
#
# ASCII only. Windows PowerShell 5.1 reads a BOM-less file as ANSI.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# --- the compiler -----------------------------------------------------------------
$candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
)
$iscc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    throw "Inno Setup 6 not found. Install it with:  winget install JRSoftware.InnoSetup"
}

# --- the version, from the one place that defines it -------------------------------
$appCs = Join-Path $root 'TypoZen_App.cs'
$m = [regex]::Match((Get-Content $appCs -Raw), 'AppVersion\s*=\s*"([0-9.]+)"')
if (-not $m.Success) { throw "Could not read AppVersion from TypoZen_App.cs" }
$version = $m.Groups[1].Value

# --- refuse to package a stale dist\ ------------------------------------------------
# Build-Portable.ps1 assembles dist\ from bin\, the staging copy that has been proven.
# Packaging whatever happens to be lying there is how a build nobody tested ships.
$distExe = Join-Path $root 'dist\TypoZen.exe'
if (-not (Test-Path $distExe)) {
    throw "dist\TypoZen.exe not found. Run .\tools\Build-Portable.ps1 first."
}
$distVersion = (Get-Item $distExe).VersionInfo.FileVersion
if ($distVersion -notlike "$version*") {
    throw "dist\ holds v$distVersion but the source says $version. Run .\tools\Build-Portable.ps1 first."
}

Write-Host ""
Write-Host "Building the installer for TypoZen $version" -ForegroundColor Cyan
Write-Host "  compiler: $iscc"
Write-Host "  payload : dist\ (v$distVersion)"

$iss = Join-Path $PSScriptRoot 'TypoZen.iss'
& $iscc "/DAppVersion=$version" $iss | Where-Object { $_ -match 'Error|Warning|Successful|Compile' }
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

$out = Join-Path $root ("dist-installer\TypoZen-Setup-$version.exe")
if (-not (Test-Path $out)) { throw "ISCC reported success but $out is missing" }
$mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
$sha = (Get-FileHash $out -Algorithm SHA256).Hash

Write-Host ""
Write-Host "  $out" -ForegroundColor Green
Write-Host "  $mb MB"
Write-Host "  SHA256 $sha"
Write-Host ""
Write-Host "Per-user install (no UAC prompt), into %LocalAppData%\Programs\TypoZen."
Write-Host "Unsigned: first run still shows SmartScreen. Settings are left behind on uninstall."
Write-Host ""
