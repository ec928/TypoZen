@echo off
rem Double-click, then click into TypoZen and set the view up before the beep.
rem Screenshots go to dist-storeart\Screenshot-NN.png. See Capture-StoreShot.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Capture-StoreShot.ps1" %*
echo.
pause
