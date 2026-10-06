# Run TypoZen automated regression suite (no GUI required)
#
# A suite counts as failed only when node exits non-zero. stderr is captured to a
# temp file rather than merged into the success stream: in PowerShell 5.1, 2>&1 on a
# native command wraps every stderr line in a NativeCommandError, which combined with
# $ErrorActionPreference = "Stop" aborted the whole run on the first suite that wrote
# a diagnostic to stderr while exiting 0.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..
# tests\run-gate.mjs does the work -- discovery, the template regeneration, headless suites
# several at a time (TZ_GATE_JOBS, default 4), *-app.mjs one at a time with RUN_APP_E2E=1,
# *-pending.mjs with RUN_PENDING_E2E=1, the sandbox-crash retry. Build_TypoZen.ps1 uses
# the same runner, so the two can no longer disagree about what the gate is.
& node ".\tests\run-gate.mjs"
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Write-Host "Optional: tab content E2E (launches TypoZen.exe) -- set RUN_TAB_E2E=1" -ForegroundColor Gray
if ($env:RUN_TAB_E2E -eq "1") {
    python ".\tests\tabs-content-e2e.py"
    exit $LASTEXITCODE
}
exit 0
