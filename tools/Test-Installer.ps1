# Test-Installer.ps1 -- prove the installer installs and uninstalls cleanly.
#
#   .\tools\Test-Installer.ps1        after .\tools\Build-Installer.ps1
#
# Installs silently into a scratch folder, hash-compares every installed file against
# dist\, checks that the optional tasks stayed off, then uninstalls and checks the
# machine is as it was. Takes about 15 seconds.
#
# THE START MENU SHORTCUT IS NOT OPTIONAL AND CANNOT BE REDIRECTED.
# [Icons] writes to {autoprograms}, which is the real per-user Start Menu no matter what
# /DIR says, and setup silently overwrites whatever is already there. /NOICONS does not
# prevent it -- that switch only ticks the "don't create a Start Menu folder" box on the
# wizard page this script's installer disables. A test run therefore clobbers the
# developer's own TypoZen shortcut and the uninstall then deletes it. Found the hard way
# on 2026-09-15: the shortcut had to be rebuilt by hand from the sibling apps' pattern.
# Hence the backup and restore below. Do not remove it.
#
# ASCII only. Windows PowerShell 5.1 reads a BOM-less file as ANSI.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$appCs = Join-Path $root 'TypoZen_App.cs'
$m = [regex]::Match((Get-Content $appCs -Raw), 'AppVersion\s*=\s*"([0-9.]+)"')
if (-not $m.Success) { throw "Could not read AppVersion from TypoZen_App.cs" }
$version = $m.Groups[1].Value

$setup = Join-Path $root "dist-installer\TypoZen-Setup-$version.exe"
if (-not (Test-Path $setup)) { throw "$setup not found. Run .\tools\Build-Installer.ps1 first." }

$scratch = Join-Path $env:TEMP ("TypoZenInstallerTest_" + [Guid]::NewGuid().ToString('N').Substring(0,8))
$target  = Join-Path $scratch 'install'
$log     = Join-Path $scratch 'setup.log'
New-Item -ItemType Directory -Path $scratch -Force | Out-Null

# --- preserve the developer's own Start Menu shortcut (see the note above) -----------
$smLnk  = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\TypoZen.lnk'
$smSave = Join-Path $scratch 'TypoZen.lnk.bak'
$hadLnk = Test-Path $smLnk
if ($hadLnk) { Copy-Item $smLnk $smSave -Force }

# --- snapshot what the optional tasks would touch, BEFORE installing ------------------
# Asking "does a desktop TypoZen.lnk exist" after the install proves nothing: the
# developer already has one, pointing at their own build, so the check passed no matter
# what setup did. Record the prior state and assert nothing changed instead.
function Snapshot {
    $dk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'TypoZen.lnk'
    [pscustomobject]@{
        DesktopLnk = if (Test-Path $dk) { (Get-Item $dk).LastWriteTimeUtc.Ticks } else { 0 }
        MdProgid   = Test-Path 'HKCU:\Software\Classes\TypoZen.Document'
        EpubProgid = Test-Path 'HKCU:\Software\Classes\TypoZen.Book'
        MdOpenWith = $null -ne (Get-ItemProperty 'HKCU:\Software\Classes\.md\OpenWithProgids' -Name 'TypoZen.Document' -ErrorAction SilentlyContinue)
    }
}
$before = Snapshot

$fail = 0
function Check($label, $ok, $detail) {
    $mark = if ($ok) { 'ok  ' } else { 'FAIL'; }
    if (-not $ok) { $script:fail++ }
    Write-Host ("  {0}  {1,-22} {2}" -f $mark, $label, $detail) -ForegroundColor $(if ($ok) { 'DarkGray' } else { 'Red' })
}

try {
    Write-Host ""
    Write-Host "Testing TypoZen-Setup-$version.exe" -ForegroundColor Cyan

    $p = Start-Process -FilePath $setup -Wait -PassThru -ArgumentList @(
        '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/TASKS=""',
        "/DIR=`"$target`"", "/LOG=`"$log`"")
    Check 'setup exit code' ($p.ExitCode -eq 0) $p.ExitCode

    # every installed file byte-identical to the payload that was proven in dist\
    $dist = Join-Path $root 'dist'
    $skip = @('debug.log','perf.log','TypoZen_Template.runtime.html','TypoZen_Template_Test.html','TypoZen.pdb')
    $expected = Get-ChildItem $dist -Recurse -File |
        Where-Object { $skip -notcontains $_.Name } |
        ForEach-Object { $_.FullName.Substring($dist.Length + 1) }

    $bad = @()
    foreach ($rel in $expected) {
        $there = Join-Path $target $rel
        if (-not (Test-Path $there)) { $bad += "$rel (missing)"; continue }
        if ((Get-FileHash (Join-Path $dist $rel) -Algorithm SHA256).Hash -ne
            (Get-FileHash $there -Algorithm SHA256).Hash) { $bad += "$rel (differs)" }
    }
    Check 'payload' ($bad.Count -eq 0) "$($expected.Count) files$(if ($bad.Count) { ' -- ' + ($bad -join ', ') })"

    # a stale artefact or a debug symbol reaching an install is a shipping bug
    $extra = Get-ChildItem $target -Recurse -File |
        ForEach-Object { $_.FullName.Substring($target.Length + 1) } |
        Where-Object { $expected -notcontains $_ -and $_ -notlike 'unins*' }
    Check 'no extra files' ($extra.Count -eq 0) $(if ($extra.Count) { $extra -join ', ' } else { 'uninstaller only' })

    # /TASKS="" asked for none of the optional work -- nothing may have MOVED
    $after = Snapshot
    Check 'desktop icon'  ($after.DesktopLnk -eq $before.DesktopLnk) 'unchanged'
    Check '.md progid'    ($after.MdProgid   -eq $before.MdProgid)   'unchanged'
    Check '.epub progid'  ($after.EpubProgid -eq $before.EpubProgid) 'unchanged'
    Check '.md open-with' ($after.MdOpenWith -eq $before.MdOpenWith) 'unchanged'

    # the entry Windows shows in Settings -> Apps
    $key = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
        Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'TypoZen*' }
    if ($key) {
        $v = Get-ItemProperty $key.PSPath
        Check 'uninstall entry' ($v.DisplayVersion -eq $version) "$($v.DisplayName) / $($v.Publisher)"
    } else { Check 'uninstall entry' $false 'not registered' }

    # and it must come back off
    $unins = Get-ChildItem $target -Filter 'unins*.exe' | Select-Object -First 1
    $u = Start-Process -FilePath $unins.FullName -Wait -PassThru -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'
    Start-Sleep -Milliseconds 1500
    Check 'uninstall exit code' ($u.ExitCode -eq 0) $u.ExitCode
    Check 'files removed' (-not (Test-Path $target)) $(if (Test-Path $target) { (Get-ChildItem $target -Recurse -File).Name -join ', ' } else { 'clean' })
    $still = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
        Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'TypoZen*' }
    Check 'registry removed' (-not $still) 'clean'
}
finally {
    if ($hadLnk) {
        Copy-Item $smSave $smLnk -Force
        Write-Host "  restored the Start Menu shortcut" -ForegroundColor DarkGray
    }
    Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($fail) { Write-Host "$fail check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host "Installer verified." -ForegroundColor Green
Write-Host ""
