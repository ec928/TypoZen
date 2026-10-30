# Drive File > Open Recent for favourites-app.mjs. Clicks are posted to the window, so the real
# mouse is never moved. Writes JSON to -Out.
#
# ASCII only. Windows PowerShell 5.1 reads a BOM-less file as ANSI.

param(
    [Parameter(Mandatory = $true)][int]$AppPid,
    [Parameter(Mandatory = $true)][string]$Command,
    [string]$Arg = '',
    [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing

Add-Type -Name Win -Namespace FavNative -MemberDefinition @'
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUT { public uint cb; public uint t; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUT i);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
'@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$byPid = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $AppPid)

function Find-All($typeName) {
    $t = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::$typeName)
    # This app's own windows only (the main window and its popups). Searching the whole desktop
    # takes many seconds on a desktop with other windows open.
    $out = @()
    foreach ($top in $AE::RootElement.FindAll($TS::Children, $byPid)) {
        foreach ($e in $top.FindAll($TS::Descendants, $t)) { $out += $e }
    }
    return $out
}
function Find-Named($typeName, $part) {
    foreach ($e in (Find-All $typeName)) { if ($e.Current.Name -like "*$part*") { return $e } }
    return $null
}
# Windows refuses SetForegroundWindow from a background process unless its input is attached to
# the foreground thread. A WPF menu closes at once in a window that is not in front.
function Bring-Forward($win) {
    if ($win -eq [IntPtr]::Zero) { return }
    for ($i = 0; $i -lt 20; $i++) {
        $fg = [FavNative.Win]::GetForegroundWindow()
        if ($fg -eq $win) { return }
        $me = [FavNative.Win]::GetCurrentThreadId()
        $other = [FavNative.Win]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
        [void][FavNative.Win]::AttachThreadInput($me, $other, $true)
        [void][FavNative.Win]::BringWindowToTop($win)
        [void][FavNative.Win]::SetForegroundWindow($win)
        [void][FavNative.Win]::AttachThreadInput($me, $other, $false)
        Start-Sleep -Milliseconds 100
    }
    throw 'could not bring the window to the front'
}
# Rebuilt rows reach automation a moment after they exist.
function Wait-Named($typeName, $part) {
    for ($i = 0; $i -lt 30; $i++) {
        $e = Find-Named $typeName $part
        if ($e -and -not $e.Current.IsOffscreen) { return $e }
        Start-Sleep -Milliseconds 100
    }
    $seen = @(); foreach ($x in (Find-All $typeName)) { $seen += $x.Current.Name }
    throw ("nothing like $part among: " + ($seen -join ' | '))
}
function Expand($part) {
    $e = $null
    for ($i = 0; $i -lt 40 -and -not $e; $i++) {
        # Exact first: "File" must not find "Keep recent files list".
        foreach ($m in (Find-All 'MenuItem')) { if ($m.Current.Name -eq $part) { $e = $m; break } }
        if (-not $e) { $e = Find-Named 'MenuItem' $part }
        if (-not $e) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $e) { throw ($script:lastState + "; no menu item like $part among: " + ((Find-All 'MenuItem' | ForEach-Object { $_.Current.Name }) -join ' | ')) }
    # A popup closes at once in a window that is not active.
    $win = (Get-Process -Id $AppPid).MainWindowHandle
    Bring-Forward $win
    try { $e.SetFocus() } catch {}
    Start-Sleep -Milliseconds 100
    $pat = $e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    for ($try = 0; $try -lt 12; $try++) {
        Bring-Forward $win
        try { $e.SetFocus() } catch {}
        $pat.Expand()
        Start-Sleep -Milliseconds 300
        if ($pat.Current.ExpandCollapseState -eq 'Expanded') { break }
    }
    $script:lastState = "$part is " + $pat.Current.ExpandCollapseState
}
function Rows {
    $out = @()
    foreach ($e in (Find-All 'MenuItem')) { $out += $e.Current.Name }
    $stars = @()
    foreach ($e in (Find-All 'Button')) {
        if ($e.Current.Name -like '*favourites:*') { $stars += @{ name = $e.Current.Name; enabled = $e.Current.IsEnabled } }
    }
    return @{ rows = $out; stars = $stars }
}
function Post-Click($e) {
    $r = $e.Current.BoundingRectangle
    $p = New-Object FavNative.Win+POINT
    $p.X = [int]($r.Left + $r.Width / 2); $p.Y = [int]($r.Top + $r.Height / 2)
    $h = [FavNative.Win]::WindowFromPoint($p)
    [void][FavNative.Win]::ScreenToClient($h, [ref]$p)
    $l = [IntPtr](($p.Y -shl 16) -bor ($p.X -band 0xFFFF))
    [void][FavNative.Win]::PostMessage($h, 0x0200, [IntPtr]::Zero, $l)   # move
    Start-Sleep -Milliseconds 120
    [void][FavNative.Win]::PostMessage($h, 0x0201, [IntPtr]1, $l)        # down
    Start-Sleep -Milliseconds 60
    [void][FavNative.Win]::PostMessage($h, 0x0202, [IntPtr]::Zero, $l)   # up
    Start-Sleep -Milliseconds 300
}

# Another window taking focus between steps closes the menu; that says nothing about the feature.
function Menu-IsOpen {
    $k = Find-Named 'MenuItem' 'Keep recent'
    return ($k -and -not $k.Current.IsOffscreen)
}
function Open-Menu {
    Expand 'File'
    Expand 'Open Recent'
    # The rows, then their stars, reach automation in turn.
    for ($i = 0; $i -lt 60; $i++) {
        if ((Menu-IsOpen) -and ((Find-All 'Button') | Where-Object { $_.Current.Name -like '*favourites:*' })) { break }
        Start-Sleep -Milliseconds 100
    }
    Start-Sleep -Milliseconds 200
}
if ('invoke-star', 'real-click-star', 'invoke-menu-row', 'focus-row', 'key', 'shot' -contains $Command) {
    if (-not (Menu-IsOpen)) { Open-Menu }
}

$result = @{ ok = $true }
try {
    switch ($Command) {
        'open' {
            Open-Menu
            $result.menu = Rows
        }
        'open-privacy' {
            Expand 'File'
            Expand 'Privacy'
            $result.menu = Rows
        }
        'invoke-row' {
            $e = Wait-Named 'MenuItem' $Arg
            $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Start-Sleep -Milliseconds 500
            $result.menu = Rows
        }
        'dialog-click' {
            $b = $null
            for ($i = 0; $i -lt 30 -and -not $b; $i++) {
                foreach ($c in (Find-All 'Button')) { if ($c.Current.Name -eq $Arg) { $b = $c; break } }
                if (-not $b) { Start-Sleep -Milliseconds 100 }
            }
            if (-not $b) { throw "no button $Arg" }
            $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Start-Sleep -Milliseconds 500
        }
        'rows' { $result.menu = Rows }
        'invoke-star' {
            $b = Wait-Named 'Button' $Arg
            $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Start-Sleep -Milliseconds 300
            $result.menu = Rows
        }
        'real-click-star' {
            # Moves the real pointer, and puts it back. Only with FAV_REAL_MOUSE=1, and never if
            # anyone has touched the machine in the last 20 seconds.
            $li = New-Object FavNative.Win+LASTINPUT
            $li.cb = 8
            [void][FavNative.Win]::GetLastInputInfo([ref]$li)
            $idle = (([Environment]::TickCount -band 0xFFFFFFFFL) - $li.t) / 1000
            if ($idle -lt 20) { $result.notIdle = $true; break }
            $b = Wait-Named 'Button' $Arg
            $r = $b.Current.BoundingRectangle
            $was = New-Object FavNative.Win+POINT
            [void][FavNative.Win]::GetCursorPos([ref]$was)
            [void][FavNative.Win]::SetCursorPos([int]($r.Left + $r.Width / 2), [int]($r.Top + $r.Height / 2))
            Start-Sleep -Milliseconds 300
            [void][FavNative.Win]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 60
            [void][FavNative.Win]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 400
            [void][FavNative.Win]::SetCursorPos($was.X, $was.Y)
            # Rebuilt rows reach automation late: closed means still closed after two seconds.
            for ($i = 0; $i -lt 20; $i++) { if (Menu-IsOpen) { break }; Start-Sleep -Milliseconds 100 }
            $result.menu = Rows
        }
        'invoke-menu-row' {
            $e = Wait-Named 'MenuItem' $Arg
            $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Start-Sleep -Milliseconds 500
            $result.menu = Rows
        }
        'focus-row' {
            # Keyboard focus is what highlights a row for someone on the keyboard.
            $e = Wait-Named 'MenuItem' $Arg
            $e.SetFocus()
            Start-Sleep -Milliseconds 250
            $result.menu = Rows
        }
        'key' {
            $e = Find-Named 'MenuItem' 'Keep recent'
            $r = $e.Current.BoundingRectangle
            $p = New-Object FavNative.Win+POINT
            $p.X = [int]($r.Left + 20); $p.Y = [int]($r.Top + 5)
            $h = [FavNative.Win]::WindowFromPoint($p)
            $vk = if ($Arg -eq 'ENTER') { 0x0D } else { [int][char]$Arg.ToUpper() }
            [void][FavNative.Win]::PostMessage($h, 0x0100, [IntPtr]$vk, [IntPtr]1)
            [void][FavNative.Win]::PostMessage($h, 0x0101, [IntPtr]$vk, [IntPtr]([int64]0xC0000001 -band 0x7FFFFFFF))
            Start-Sleep -Milliseconds 300
            $result.menu = Rows
        }
        'shot' {
            # The window the rows are in, as WPF drew it.
            $e = Find-Named 'MenuItem' 'Keep recent'
            $r = $e.Current.BoundingRectangle
            $p = New-Object FavNative.Win+POINT
            $p.X = [int]($r.Left + 20); $p.Y = [int]($r.Top + 5)
            $h = [FavNative.Win]::WindowFromPoint($p)
            $w = New-Object FavNative.Win+RECT
            [void][FavNative.Win]::GetWindowRect($h, [ref]$w)
            $bmp = New-Object System.Drawing.Bitmap ($w.R - $w.L), ($w.B - $w.T)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $dc = $g.GetHdc()
            [void][FavNative.Win]::PrintWindow($h, $dc, 2)
            $g.ReleaseHdc($dc); $g.Dispose()
            $bmp.Save($Arg, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
        }
    }
} catch {
    $result.ok = $false
    $result.error = $_.Exception.Message
}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath ($Out + '.tmp') -Encoding UTF8
Move-Item -LiteralPath ($Out + '.tmp') -Destination $Out -Force
