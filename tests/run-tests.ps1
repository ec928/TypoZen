# Run TypoZen automated regression suite (no GUI required)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
Write-Host "Running TypoZen self-tests..." -ForegroundColor Cyan
$failedSuites = @()
foreach ($suite in (Get-ChildItem ".\tests\*.mjs" | Sort-Object Name)) {
    Write-Host ("  - " + $suite.Name) -ForegroundColor Gray
    node $suite.FullName
    if ($LASTEXITCODE -ne 0) { $failedSuites += $suite.Name }
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
