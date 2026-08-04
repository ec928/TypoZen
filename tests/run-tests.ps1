# Run TypoZen automated regression suite (no GUI required)
#
# A suite counts as failed only when node exits non-zero. stderr is captured to a
# temp file rather than merged into the success stream: in PowerShell 5.1, 2>&1 on a
# native command wraps every stderr line in a NativeCommandError, which combined with
# $ErrorActionPreference = "Stop" aborted the whole run on the first suite that wrote
# a diagnostic to stderr while exiting 0.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..
Write-Host "Running TypoZen self-tests..." -ForegroundColor Cyan

# The jsdom suites boot from TypoZen_Template_Test.html. Regenerate it from the shipping
# TypoZen_Template.html + css/typozen.css + js/typozen.js first, or they test a snapshot.
& node ".\tests\build-test-template.mjs"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Could not regenerate TypoZen_Template_Test.html - aborting." -ForegroundColor Red
    exit 1
}

$failedSuites = @()
$errFile = [System.IO.Path]::GetTempFileName()

# *-pending.mjs assert behaviour that is genuinely not built yet, so they are opt-in via
# RUN_PENDING_E2E=1 and announced as skipped rather than dropped silently. Everything
# else runs, including the *-browser.mjs suites that drive headless Chrome: they are slow
# but they are the only ones that can see layout, and excluding them is exactly how
# 2-column mode shipped broken behind a green suite.
$allSuites = @(Get-ChildItem ".\tests\*.mjs" | Sort-Object Name)
# app-harness.mjs is a helper, not a suite.
$allSuites = @($allSuites | Where-Object { $_.Name -ne "app-harness.mjs" })

# *-app.mjs launch TypoZen.exe and drive it over the DevTools port --debug opens. They
# need a desktop session and take ~40s, so they are opt-in via RUN_APP_E2E=1 -- but they
# are the only suites that can see the real shell, and they must be run before claiming
# any column or pagination behaviour is fixed. The browser suites passed for a fortnight
# while the application was broken.
$appSuites = @($allSuites | Where-Object { $_.Name -like "*-app.mjs" })
$pendingSuites = @($allSuites | Where-Object { $_.Name -like "*-pending.mjs" })
$suites = @($allSuites | Where-Object { $_.Name -notlike "*-pending.mjs" -and $_.Name -notlike "*-app.mjs" })
if ($env:RUN_PENDING_E2E -eq "1") { $suites += $pendingSuites }
if ($env:RUN_APP_E2E -eq "1") { $suites += $appSuites }

foreach ($suite in $suites) {
    # Redirect inside cmd, not PowerShell: PS 5.1 turns a native command's stderr into
    # ErrorRecords even when redirecting to a file, which litters the captured output
    # with NativeCommandError noise for suites that exit 0.
    $stdout = & cmd /c "node `"$($suite.FullName)`" 2>`"$errFile`""
    if ($LASTEXITCODE -ne 0) {
        $failedSuites += $suite.Name
        Write-Host ("  FAIL " + $suite.Name) -ForegroundColor Red
        $stdout | ForEach-Object { Write-Host ("      " + $_) }
        Get-Content $errFile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("      " + $_) -ForegroundColor Red }
    }
    else {
        Write-Host ("  PASS " + $suite.Name) -ForegroundColor Green
    }
}

Remove-Item $errFile -Force -ErrorAction SilentlyContinue

if ($env:RUN_PENDING_E2E -ne "1" -and $pendingSuites.Count -gt 0) {
    Write-Host ""
    Write-Host ("  SKIPPED, not built yet (set RUN_PENDING_E2E=1): " + (($pendingSuites | ForEach-Object { $_.Name }) -join ", ")) -ForegroundColor Yellow
}
if ($env:RUN_APP_E2E -ne "1" -and $appSuites.Count -gt 0) {
    Write-Host ""
    Write-Host ("  SKIPPED, drives the real .exe (set RUN_APP_E2E=1): " + (($appSuites | ForEach-Object { $_.Name }) -join ", ")) -ForegroundColor Yellow
    Write-Host "  Run these before claiming any column or pagination fix works." -ForegroundColor Yellow
}

if ($failedSuites.Count -gt 0) {
    Write-Host ("FAILED: " + ($failedSuites -join ", ")) -ForegroundColor Red
    exit 1
}
Write-Host "All self-tests passed." -ForegroundColor Green

Write-Host ""
Write-Host "Optional: tab content E2E (launches TypoZen.exe) -- set RUN_TAB_E2E=1" -ForegroundColor Gray
if ($env:RUN_TAB_E2E -eq "1") {
    python ".\tests\tabs-content-e2e.py"
    exit $LASTEXITCODE
}
exit 0
