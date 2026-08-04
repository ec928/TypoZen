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

$failedSuites = @()
$errFile = [System.IO.Path]::GetTempFileName()

# *-browser.mjs drive headless Chrome via puppeteer. They are slow and they assert
# against Phase 4 column behaviour that is still being built, so they are opt-in rather
# than part of the default gate. They are announced below, never silently skipped.
$allSuites = @(Get-ChildItem ".\tests\*.mjs" | Sort-Object Name)
$browserSuites = @($allSuites | Where-Object { $_.Name -like "*-browser.mjs" })
$suites = @($allSuites | Where-Object { $_.Name -notlike "*-browser.mjs" })
if ($env:RUN_BROWSER_E2E -eq "1") { $suites = $allSuites }

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

if ($env:RUN_BROWSER_E2E -ne "1" -and $browserSuites.Count -gt 0) {
    Write-Host ""
    Write-Host ("  SKIPPED (set RUN_BROWSER_E2E=1): " + (($browserSuites | ForEach-Object { $_.Name }) -join ", ")) -ForegroundColor Yellow
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
