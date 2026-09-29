# Capture-StoreShot.ps1 -- screenshot the TypoZen window for the Store, hands-off.
#
#   powershell -ExecutionPolicy Bypass -File tools\Capture-StoreShot.ps1            (5 s countdown)
#   powershell -ExecutionPolicy Bypass -File tools\Capture-StoreShot.ps1 -Delay 8
#
# Why a countdown and not a hotkey: any key combination with Alt in it (Alt+PrtScn,
# Win+Alt+PrtScn) brings ZenMode's UI back before the shot is taken. Start this, click into
# TypoZen, set the view up -- open a menu if the shot needs one -- and wait for the beep.
#
# It copies the window's area OF THE SCREEN, so an open menu or popup over the window is in
# the picture, which a window-only capture leaves out. The shot is the window's visible
# frame (DWM extended frame bounds, no invisible resize border), saved as the next free
# dist-storeart\Screenshot-NN.png. The Store wants 1366x768 or larger (768x1366 if portrait),
# up to 4K.

param(
    [int]$Delay = 5,
    [string]$Process = 'TypoZen'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShotNative {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
}
'@
# Per-monitor aware, so the rectangle and the capture are both in real pixels on a scaled display.
[void][ShotNative]::SetProcessDpiAwarenessContext([IntPtr](-4))

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'dist-storeart'
[void][IO.Directory]::CreateDirectory($out)

for ($i = $Delay; $i -gt 0; $i--) { Write-Host -NoNewline "$i.. "; Start-Sleep -Seconds 1 }
Write-Host ''

$p = Get-Process -Name $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Host "No $Process window found." -ForegroundColor Red; exit 1 }
if ([ShotNative]::IsIconic($p.MainWindowHandle)) { Write-Host "$Process is minimised." -ForegroundColor Red; exit 1 }
# This copies the screen, so whatever is in front is what gets saved. An open menu belongs to
# TypoZen too, so "in front" means any window of its process.
$fgPid = [uint32]0
[void][ShotNative]::GetWindowThreadProcessId([ShotNative]::GetForegroundWindow(), [ref]$fgPid)
if ($fgPid -ne $p.Id) {
    Write-Host "$Process was not in front at the beep, so nothing was saved. Click into it during the countdown." -ForegroundColor Yellow
    [Console]::Beep(330, 300)
    exit 1
}

$r = New-Object ShotNative+RECT
[void][ShotNative]::DwmGetWindowAttribute($p.MainWindowHandle, 9, [ref]$r, 16)   # DWMWA_EXTENDED_FRAME_BOUNDS
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Host "Could not read the window's bounds." -ForegroundColor Red; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
$g.Dispose()

$n = 1
while (Test-Path (Join-Path $out ('Screenshot-{0:D2}.png' -f $n))) { $n++ }
$file = Join-Path $out ('Screenshot-{0:D2}.png' -f $n)
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[Console]::Beep(880, 150)

# Partner Center, Desktop: "1366 x 768 pixels or larger", landscape OR portrait (so a tall
# window needs 768 x 1366), and 4K (3840 x 2160) is supported.
$landscape = ($w -ge $h)
$ok = if ($landscape) { $w -ge 1366 -and $h -ge 768 -and $w -le 3840 -and $h -le 2160 }
      else            { $w -ge 768 -and $h -ge 1366 -and $w -le 2160 -and $h -le 3840 }
Write-Host ("Saved {0}  {1}x{2} ({3})" -f (Split-Path -Leaf $file), $w, $h, $(if ($landscape) { 'landscape' } else { 'portrait' })) -ForegroundColor Green
if (-not $ok) { Write-Host 'Too small or too large for the Store (1366x768 landscape or 768x1366 portrait, up to 4K): resize the window and take it again.' -ForegroundColor Yellow }
elseif (-not $landscape) { Write-Host 'Portrait is accepted, but it will sit beside the landscape shots at a different shape.' -ForegroundColor Yellow }
