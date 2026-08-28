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
    [string]$Arg = '',
    [switch]$Force
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

# Items this driver refuses to invoke.
#
# Learned the hard way: a stray click during an earlier version of this script landed on
# File > Save and wrote to the test fixture, which then travelled into a commit. A driver
# that can reach every menu can reach the destructive ones, and a test has no business
# saving, closing or deleting anything. Pass -Force to override deliberately.
$script:Dangerous = 'save|close|delete|remove|exit|quit|new|overwrite|export'

function Assert-Safe($name) {
    if ($Force) { return }
    if ($name -match $script:Dangerous) {
        Out-Json @{ error = "refusing to invoke '$name': looks destructive. Pass -Force if that is really wanted." }
        exit 2
    }
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
            $states = @()
            foreach ($c in $children) {
                if ($c.Current.Name) {
                    $names += $c.Current.Name
                    # Enabled state as well as the name. Without it a suite can only prove a
                    # menu item EXISTS, which passes just as happily when the item is dead --
                    # and "the menu is greyed" is exactly the kind of claim that needs seeing,
                    # not inferring.
                    $states += @{ name = $c.Current.Name; enabled = [bool]$c.Current.IsEnabled }
                }
            }
        }

        if ($ec) { $ec.Collapse() }
        Out-Json @{ menu = $Arg; items = $names; states = $states; count = $names.Count; attempts = $attempt }
    }

    'invoke' {
        # 'Top>Item', 'Top>Group>Item', or just 'Item' to search the whole tree.
        #
        # More than two levels because a WPF submenu does not exist until its parent is
        # expanded: View>Zoom>Zoom In could not be reached at all, and asking for 'Zoom In'
        # on its own answered "no item", which reads exactly like the command being gone.
        # Each level is expanded in turn, then searched among that level's children.
        $parts = $Arg -split '>'
        $items = Find-ByType $root 'MenuItem'
        if ($parts.Count -gt 2) {
            $node = $null
            foreach ($i in $items) { if ($i.Current.Name -eq $parts[0]) { $node = $i; break } }
            if (-not $node) { Out-Json @{ error = "no menu named '$($parts[0])'" }; break }
            for ($lvl = 1; $lvl -lt $parts.Count; $lvl++) {
                $ec = $null
                if ($node.TryGetCurrentPattern(
                        [System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {
                    $ec.Expand()
                }
                Start-Sleep -Milliseconds 400
                $next = $null
                foreach ($c in $node.FindAll($TS::Children,
                    (New-Object System.Windows.Automation.PropertyCondition(
                        $AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))) {
                    if ($c.Current.Name -eq $parts[$lvl]) { $next = $c; break }
                }
                if (-not $next) {
                    foreach ($c in $node.FindAll($TS::Descendants,
                        (New-Object System.Windows.Automation.PropertyCondition(
                            $AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))) {
                        if ($c.Current.Name -eq $parts[$lvl]) { $next = $c; break }
                    }
                }
                if (-not $next) { Out-Json @{ error = "no item '$($parts[$lvl])' under '$($parts[$lvl-1])'" }; break }
                $node = $next
            }
            if ($node -and $node.Current.Name -eq $parts[$parts.Count - 1]) {
                Assert-Safe $node.Current.Name
                $how = Click-Element $node
                Out-Json @{ invoked = $Arg; how = $how }
            }
            break
        }
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
            Assert-Safe $parts[1]
            $how = Click-Element $found
            Out-Json @{ invoked = $Arg; how = $how }
        } else {
            $found = $null
            foreach ($i in $items) { if ($i.Current.Name -eq $Arg) { $found = $i; break } }
            if (-not $found) { Out-Json @{ error = "no item '$Arg'" }; break }
            Assert-Safe $Arg
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

    'controls' {
        # Every toolbar control the shell is showing, with whether it can be pressed.
        #
        # "Greyed out" is a claim about the running window, and nothing could check it
        # from outside the process: the page suites see the WebView, not the chrome.
        # IsEnabled is what a screen reader reports and what a click will obey, so it is
        # the honest thing to assert against -- opacity is only how it looks.
        #
        # Toolbar band only (above the status bar, below the tab strip), so the File/Edit
        # menus and the caption buttons do not crowd the answer.
        $win = $root.Current.BoundingRectangle
        $out = @()
        foreach ($typeName in @('Button', 'MenuItem')) {
            foreach ($e in (Find-ByType $root $typeName)) {
                $r = $e.Current.BoundingRectangle
                if ($r.Width -le 0 -or $r.Height -le 0) { continue }
                if ($r.Y -gt ($win.Y + $win.Height - 60)) { continue }
                # AutomationId is x:Name from the XAML, so it is stable and ASCII. Name is
                # the button's Content, which for this toolbar is a private-use MDL2
                # glyph -- it does not survive the pipe to stdout, and one of them is a
                # literal quote that broke the JSON outright. Reported, but flattened.
                $id = $e.Current.AutomationId
                $n = $e.Current.Name
                if ($n) { $n = ($n -replace '[^\x20-\x7E]', '?') }
                if (-not $id -and -not $n) { continue }
                $out += @{
                    id      = $id
                    name    = $n
                    type    = $typeName
                    enabled = [bool]$e.Current.IsEnabled
                    x       = [int]$r.X
                    y       = [int]$r.Y
                }
            }
        }
        Out-Json @{ controls = $out; count = $out.Count }
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

    'maximize' {
        $wp = $null
        if ($root.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
            $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Maximized)
            Start-Sleep -Milliseconds 600
            $r = $root.Current.BoundingRectangle
            Out-Json @{ maximized = $true; w = [int]$r.Width; h = [int]$r.Height }
        } else { Out-Json @{ error = 'no window pattern' } }
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
