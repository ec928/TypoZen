# Close-AppWindow.ps1
#
# Ask one process's main window to close, as a user would, by posting WM_CLOSE to it.
# Used by tests/app-harness.mjs closeGracefully(): app.close() kills, which is the crash
# path, so anything TypoZen does on exit (the Closed handler) would never be measured.
#
# Run it ON the desktop the window lives on. EnumWindows only sees the calling thread's
# desktop, so for a hidden-desktop launch the harness starts this script through
# Start-OnHiddenDesktop.ps1.
#
# Why not Process.CloseMainWindow: on the hidden desktop it picked the process's
# UAC_InputIndicatorOverlayWnd -- visible, unowned, untitled, and ahead of the real window
# in z-order -- returned True, and the app never closed (measured 2026-09-25). Here the
# target is the visible, unowned, titled WPF window (class HwndWrapper[...]).
#
# -LogPath records every window seen and what was posted, for diagnosis.
#
# ASCII only. Windows PowerShell 5.1 reads a BOM-less file as ANSI, and one smart quote
# or em dash anywhere in here makes the whole script fail to parse.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int] $ProcessId,
    [string] $LogPath = ''
)

$signature = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AppWindow {
    delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);

    public static List<IntPtr> TopLevel(uint pid) {
        var found = new List<IntPtr>();
        EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) found.Add(h); return true; }, IntPtr.Zero);
        return found;
    }
    public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
    public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
}
'@
if (-not ('AppWindow' -as [type])) { Add-Type -TypeDefinition $signature }

function Log([string] $line) { if ($LogPath) { Add-Content -LiteralPath $LogPath -Value $line -Encoding ASCII } }

$target = [IntPtr]::Zero
foreach ($h in [AppWindow]::TopLevel([uint32]$ProcessId)) {
    $visible = [AppWindow]::IsWindowVisible($h)
    $owned = [AppWindow]::GetWindow($h, 4) -ne [IntPtr]::Zero    # GW_OWNER
    $title = [AppWindow]::Text($h)
    $class = [AppWindow]::Class($h)
    Log "hwnd=$h visible=$visible owned=$owned class=$class title=$title"
    if ($target -eq [IntPtr]::Zero -and $visible -and -not $owned -and $title -and
        $class.StartsWith('HwndWrapper[')) { $target = $h }
}

if ($target -eq [IntPtr]::Zero) { Log 'no visible titled WPF window; nothing posted'; exit 1 }
$ok = [AppWindow]::PostMessage($target, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE
Log "posted WM_CLOSE to $target ok=$ok"
