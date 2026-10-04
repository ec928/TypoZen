<#
.SYNOPSIS
    Proves a refactor step only MOVED C# code: nothing added, removed or edited.

.DESCRIPTION
    Rule 2 of docs/architecture.md, Part 3. Run before committing each split step.

    Compares every compiled *.cs file at a git baseline (default HEAD) with the working tree,
    as a multiset of lines (trimmed, blank lines ignored). File boundaries, line order and
    indentation may change; the content may not.

    Differences allowed, because splitting a file needs them:
      - `partial` added to a type declaration (the word is ignored in the comparison)
      - `using ...;` lines, `namespace ...` lines and lone `{` / `}` braces, in either direction
      - a new type declaration line for a type the baseline already declares
        (the header of a new partial part, e.g. `public partial class TypoZenWindow`)
    Anything else -- a changed comment, a renamed variable, a dropped line -- fails.

    Also fails when TypoZen.csproj and the .cs files on disk disagree (rule 3): a file that
    exists but is not <Compile>d silently drops out of the build.

.PARAMETER Ref
    Git baseline to compare with. Default HEAD (the last commit before the step).

.PARAMETER MaxShow
    How many offending lines to list per direction.

.EXAMPLE
    .\tools\Verify-PureMove.ps1
    .\tools\Verify-PureMove.ps1 -Ref refactor-a
#>
param(
    [string]$Ref = 'HEAD',
    [int]$MaxShow = 40
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    # git show must hand back UTF-8 intact, or every non-ASCII line looks "changed".
    $prevOut = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

    $excluded = '(^|[\\/])(obj|bin|node_modules|dist|dist-installer|dist-msix)[\\/]'

    # ---- baseline files ----
    $null = git rev-parse --verify --quiet "$Ref^{commit}"
    if ($LASTEXITCODE -ne 0) { throw "Not a git commit: $Ref" }
    $baseFiles = @(git ls-tree -r --name-only $Ref | Where-Object { $_ -like '*.cs' -and $_ -notmatch $excluded })

    # ---- working-tree files (tracked or not: a new split file is untracked until added) ----
    $workFiles = @(Get-ChildItem -Recurse -File -Filter *.cs |
        ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') } |
        Where-Object { $_ -notmatch $excluded })

    function Normalize([string]$line) {
        $t = $line.Trim()
        if ($t.Length -eq 0) { return $null }
        # `partial` is the one word a split adds to existing declarations.
        return ($t -replace '\bpartial\s+', '')
    }

    function Add-Lines($map, $origin, [string[]]$lines, [string]$file) {
        foreach ($l in $lines) {
            $n = Normalize $l
            if ($null -eq $n) { continue }
            if ($map.ContainsKey($n)) { $map[$n]++ } else { $map[$n] = 1 }
            if (-not $origin.ContainsKey($n)) { $origin[$n] = $file }
        }
    }

    # Ordinal (case-sensitive) maps: a PowerShell @{} ignores case, and let a one-letter
    # case edit pass as "unchanged" when this script was first tested.
    function New-Map { return ,(New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::Ordinal)) }
    $base = New-Map; $baseFrom = New-Map
    foreach ($f in $baseFiles) {
        $text = (git show "${Ref}:$f") -join "`n"
        if ($LASTEXITCODE -ne 0) { throw "git show failed for ${Ref}:$f" }
        Add-Lines $base $baseFrom ($text -split "`n") $f
    }
    $work = New-Map; $workFrom = New-Map
    foreach ($f in $workFiles) {
        $lines = [System.IO.File]::ReadAllLines((Join-Path $root $f), [System.Text.Encoding]::UTF8)
        Add-Lines $work $workFrom $lines $f
    }

    # Types the baseline declares: a new partial part may repeat their header.
    $declRx = '^(?:(?:public|internal|private|protected|static|sealed|abstract|unsafe|new)\s+)*(class|struct|interface|enum)\s+(\w+)'
    $baseTypes = @{}
    foreach ($k in @($base.Keys)) { if ($k -match $declRx) { $baseTypes[$Matches[2]] = $true } }

    function Is-Wrapper([string]$n) {
        return ($n -eq '{' -or $n -eq '}' -or $n -match '^using\s+[\w\.\s=]+;$' -or $n -match '^namespace\s+[\w\.]+\s*\{?$')
    }

    $added = New-Object System.Collections.Generic.List[string]
    $removed = New-Object System.Collections.Generic.List[string]
    $allowedAdded = 0; $allowedRemoved = 0

    foreach ($k in @($work.Keys)) {
        $extra = $work[$k] - $(if ($base.ContainsKey($k)) { $base[$k] } else { 0 })
        if ($extra -le 0) { continue }
        $okDecl = ($k -match $declRx) -and $baseTypes.ContainsKey($Matches[2])
        if ((Is-Wrapper $k) -or $okDecl) { $allowedAdded += $extra; continue }
        $added.Add(("+{0}  {1}   [{2}]" -f $extra, $k, $workFrom[$k]))
    }
    foreach ($k in @($base.Keys)) {
        $missing = $base[$k] - $(if ($work.ContainsKey($k)) { $work[$k] } else { 0 })
        if ($missing -le 0) { continue }
        if (Is-Wrapper $k) { $allowedRemoved += $missing; continue }
        $removed.Add(("-{0}  {1}   [{2}]" -f $missing, $k, $baseFrom[$k]))
    }

    # ---- csproj <Compile> list vs files on disk ----
    $projIssues = @()
    $proj = Join-Path $root 'TypoZen.csproj'
    $compiled = @([regex]::Matches([System.IO.File]::ReadAllText($proj), '<Compile\s+Include="([^"]+)"') |
        ForEach-Object { $_.Groups[1].Value.Replace('\', '/') })
    foreach ($f in $workFiles) { if ($compiled -notcontains $f) { $projIssues += "on disk, not in TypoZen.csproj: $f" } }
    foreach ($c in $compiled) { if ($workFiles -notcontains $c) { $projIssues += "in TypoZen.csproj, not on disk: $c" } }

    # ---- report ----
    $fileDelta = @($workFiles | Where-Object { $baseFiles -notcontains $_ }) | ForEach-Object { "new:  $_" }
    $fileDelta += @($baseFiles | Where-Object { $workFiles -notcontains $_ }) | ForEach-Object { "gone: $_" }

    Write-Host "Verify-PureMove: $Ref -> working tree   ($($baseFiles.Count) -> $($workFiles.Count) .cs files)"
    $fileDelta | Where-Object { $_ } | ForEach-Object { Write-Host "  $_" }
    Write-Host ("  wrapper lines allowed: +{0} / -{1}" -f $allowedAdded, $allowedRemoved)

    $ok = ($added.Count -eq 0 -and $removed.Count -eq 0 -and $projIssues.Count -eq 0)
    if ($removed.Count) {
        Write-Host "`nLINES LOST OR CHANGED ($($removed.Count)):" -ForegroundColor Red
        $removed | Sort-Object | Select-Object -First $MaxShow | ForEach-Object { Write-Host "  $_" }
    }
    if ($added.Count) {
        Write-Host "`nLINES ADDED OR CHANGED ($($added.Count)):" -ForegroundColor Red
        $added | Sort-Object | Select-Object -First $MaxShow | ForEach-Object { Write-Host "  $_" }
    }
    if ($projIssues.Count) {
        Write-Host "`nPROJECT FILE:" -ForegroundColor Red
        $projIssues | ForEach-Object { Write-Host "  $_" }
    }

    if ($ok) { Write-Host "`nPASS: pure move." -ForegroundColor Green; exit 0 }
    Write-Host "`nFAIL: not a pure move." -ForegroundColor Red
    exit 1
}
finally {
    if ($prevOut) { [Console]::OutputEncoding = $prevOut }
    Pop-Location
}
