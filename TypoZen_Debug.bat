@echo off
REM Launch TypoZen with telemetry logging on.
REM
REM A normal run writes no debug.log. This passes --debug, which turns on the page's
REM telemetry channel and appends it to debug.log beside the executable -- the column and
REM pagination probes report through it, so use this while working on Phase 4.
REM
REM   TypoZen_Debug.bat                      open with an empty document
REM   TypoZen_Debug.bat "tests\band-1600.md" open a specific file
REM
REM The log is truncated on each launch so a session is not read against stale lines.

setlocal
set "HERE=%~dp0"
if exist "%HERE%debug.log" del "%HERE%debug.log"

echo Starting TypoZen with --debug
echo Log: %HERE%debug.log
start "" "%HERE%TypoZen.exe" --debug %*
endlocal
