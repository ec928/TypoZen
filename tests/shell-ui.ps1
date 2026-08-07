# Drive TypoZen's WPF chrome from outside the process, and report as JSON.
#
# The application suites reach into the *page* over the DevTools protocol. Nothing reached
# the shell: menus, the tab strip, dialogs. That is where the save-prompt, theme-menu and
# tab-switch defects all lived, so it is the least covered and most trafficked surface in
# the app. UI Automation can see all of it -- 105 elements, menus and tab titles included.
#
# One command per invocation, JSON on stdout, so a Node suite can drive the chrome and
# assert against the page in the same test.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\shell-ui.ps1 -Command menus
#   ... -Command menu -Arg File
#   ... -Command invoke -Arg 'Themes>Gruvbox Dark'
#   ... -Command tabs
#   ... -Command click-tab -Arg 2
#   ... -Command dialogs

param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string]$Arg = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

Add-Type -Name Win -Namespace Native -MemberDefinition @'
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-Root {
    $p = Get-Process TypoZen -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { throw 'TypoZen is not running' }
    [void][Native.Win]::SetForegroundWindow($p.MainWindowHandle)
    return $AE::FromHandle($p.MainWindowHandle)
}

function Find-ByType($root, $typeName) {
    $t = [System.Windows.Automation.ControlType]::$typeName
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $t)
    return $root.FindAll($TS::Descendants, $cond)
}

function Out-Json($obj) { $obj | ConvertTo-Json -Depth 5 -Compress }

# The tab strip lives in the title bar. Text elements up there also include the window's
# own title and various chrome labels, and some are zero-width or scrolled out of view --
# clicking the centre of one of those lands on nothing, which looks exactly like a tab
# switch that did not work.
function Get-TabElements($root) {
    $win = $root.Current.BoundingRectangle
    $texts = Find-ByType $root 'Text'
    $out = @()
    foreach ($t in $texts) {
        $r = $t.Current.BoundingRectangle
        if ($r.Width -lt 24 -or $r.Height -lt 8) { continue }
        if ($r.Y -gt ($win.Y + 60)) { continue }
        if ($r.X -lt $win.X -or ($r.X + $r.Width) -gt ($win.X + $win.Width)) { continue }
        $n = $t.Current.Name
        if (-not $n -or $n.Length -lt 2) { continue }
        if ($n -match '[\/]') { continue }
        if ($n -eq $root.Current.Name) { continue }
        $out += $t
    }
    return $out
}

function Click-Element($el) {
    # Invoke where the control supports it; fall back to a real click at its centre, which
    # is what a tab title needs -- a Text element exposes no Invoke pattern.
    $inv = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
        $inv.Invoke(); return 'invoke'
    }
    $r = $el.Current.BoundingRectangle
    if ($r.Width -le 0) { throw 'element has no clickable area' }
    $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
    [void][Native.Win]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 90
    [Native.Win]::mouse_event(0x0002, 0, 0, 0, 0)   # left down
    [Native.Win]::mouse_event(0x0004, 0, 0, 0, 0)   # left up
    return 'click'
}

$root = Get-Root

# Start from a closed menu bar, always.
#
# Menus are stateful and this script is one process per command: a menu left expanded by
# the previous invocation makes the next Expand() a no-op, and the command reports that the
# menu contains nothing. That is indistinguishable from the bug this suite exists to catch,
# so it is closed explicitly rather than hoped about.
try {
    foreach ($mi in (Find-ByType $root 'MenuItem')) {
        $e = $null
        if ($mi.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$e)) {
            if ($e.Current.ExpandCollapseState -ne
                [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $e.Collapse() }
        }
    }
    Start-Sleep -Milliseconds 150
} catch {}

switch ($Command) {

    'menus' {
        $items = Find-ByType $root 'MenuItem'
        $names = @()
        foreach ($i in $items) { if ($i.Current.Name) { $names += $i.Current.Name } }
        Out-Json @{ menus = $names }
    }

    'menu' {
        # Expand one top-level menu and report what it contains. A menu that builds nothing,
        # or builds the same entry twice, is the shape the theme-menu bug had.
        $items = Find-ByType $root 'MenuItem'
        $target = $null
        foreach ($i in $items) { if ($i.Current.Name -eq $Arg) { $target = $i; break } }
        if (-not $target) { Out-Json @{ error = "no menu named '$Arg'" }; break }

        # Expanded and read up to three times. A WPF submenu is populated on open, and a
        # read that arrives first sees an empty one -- which is indistinguishable from the
        # menu genuinely building nothing, the very thing this is here to detect. Retrying
        # keeps the real failure detectable while not reporting it for a slow frame.
        $names = @()
        $ec = $null
        [void]$target.TryGetCurrentPattern(
            [System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)
        for ($attempt = 0; $attempt -lt 3 -and $names.Count -eq 0; $attempt++) {
            if ($ec) {
                if ($ec.Current.ExpandCollapseState -ne
                    [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $ec.Collapse(); Start-Sleep -Milliseconds 150 }
                $ec.Expand()
            } else { [void](Click-Element $target) }
            Start-Sleep -Milliseconds (350 + 250 * $attempt)

            $children = $target.FindAll($TS::Descendants,
                (New-Object System.Windows.Automation.PropertyCondition(
                    $AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))
            $names = @()
            foreach ($c in $children) { if ($c.Current.Name) { $names += $c.Current.Name } }
        }

        if ($ec) { $ec.Collapse() }
        Out-Json @{ menu = $Arg; items = $names; count = $names.Count; attempts = $attempt }
    }

    'invoke' {
        # 'Top>Item', or just 'Item' to search the whole tree.
        $parts = $Arg -split '>'
        $items = Find-ByType $root 'MenuItem'
        if ($parts.Count -eq 2) {
            $top = $null
            foreach ($i in $items) { if ($i.Current.Name -eq $parts[0]) { $top = $i; break } }
            if (-not $top) { Out-Json @{ error = "no menu named '$($parts[0])'" }; break }
            $ec = $null
            if ($top.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) { $ec.Expand() }
            Start-Sleep -Milliseconds 450
            $found = $null
            foreach ($c in $top.FindAll($TS::Descendants,
                (New-Object System.Windows.Automation.PropertyCondition(
                    $AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))) {
                if ($c.Current.Name -eq $parts[1]) { $found = $c; break }
            }
            if (-not $found) {
                if ($ec) { $ec.Collapse() }
                Out-Json @{ error = "no item '$($parts[1])' under '$($parts[0])'" }; break
            }
            $how = Click-Element $found
            Out-Json @{ invoked = $Arg; how = $how }
        } else {
            $found = $null
            foreach ($i in $items) { if ($i.Current.Name -eq $Arg) { $found = $i; break } }
            if (-not $found) { Out-Json @{ error = "no item '$Arg'" }; break }
            $how = Click-Element $found
            Out-Json @{ invoked = $Arg; how = $how }
        }
    }

    'tabs' {
        $out = @()
        foreach ($t in (Get-TabElements $root)) {
            $r = $t.Current.BoundingRectangle
            $out += @{ name = $t.Current.Name; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width }
        }
        Out-Json @{ tabs = $out; count = $out.Count }
    }

    'click-tab' {
        $cands = Get-TabElements $root
        $target = $null
        $asIndex = 0
        if ([int]::TryParse($Arg, [ref]$asIndex)) {
            if ($asIndex -ge 0 -and $asIndex -lt $cands.Count) { $target = $cands[$asIndex] }
        } else {
            foreach ($c in $cands) { if ($c.Current.Name -like "*$Arg*") { $target = $c; break } }
        }
        if (-not $target) { Out-Json @{ error = "no tab matching '$Arg'"; available = $cands.Count }; break }
        $name = $target.Current.Name
        $r = $target.Current.BoundingRectangle
        $how = Click-Element $target
        Out-Json @{ clicked = $name; how = $how; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width }
    }

    'status' {
        # The status bar, as the shell renders it. It carries the theme in use by name,
        # which is a far better handle than an index into a menu: the index and the menu
        # order are two different lists that only look alike.
        $win = $root.Current.BoundingRectangle
        $texts = Find-ByType $root 'Text'
        $out = @()
        foreach ($t in $texts) {
            $r = $t.Current.BoundingRectangle
            if ($r.Y -lt ($win.Y + $win.Height - 60)) { continue }
            $n = $t.Current.Name
            if ($n) { $out += $n }
        }
        Out-Json @{ status = $out }
    }

    'dialogs' {
        # Any modal window this process owns, by title. A dialog left open is why a hung
        # close used to look like a frozen application.
        $p = Get-Process TypoZen -ErrorAction SilentlyContinue | Select-Object -First 1
        $found = @()
        foreach ($w in $p.Threads) { }
        $desktop = $AE::RootElement
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            $AE::ProcessIdProperty, $p.Id)
        $wins = $desktop.FindAll($TS::Children, $cond)
        foreach ($w in $wins) {
            $found += @{ name = $w.Current.Name; modal = $w.Current.ControlType.ProgrammaticName }
        }
        Out-Json @{ windows = $found; count = $found.Count }
    }

    default { Out-Json @{ error = "unknown command '$Command'" } }
}
