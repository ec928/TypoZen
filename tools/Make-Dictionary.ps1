<#
.SYNOPSIS
    Build TypoZen's dictionary.tsv from a WordNet database you already have.

.DESCRIPTION
    TypoZen bundles no dictionary and downloads nothing, so the definitions half of
    Define needs a file you supply. This turns WordNet's data files into the one-line-
    per-word TSV it reads, which is otherwise a fiddly bit of parsing to write yourself.

    WordNet is the obvious source: free under a permissive licence, plain text, about
    150,000 entries, and a single download. Get "WordNet 3.1 database files" (or 3.0)
    from https://wordnet.princeton.edu/download/current-version and unpack it. The files
    this needs are data.noun, data.verb, data.adj and data.adv, in the dict folder.

    Nothing here reaches the network. You do the download; this only reads local files.

.PARAMETER Source
    Folder holding the WordNet data.* files. Defaults to .\dict under the current
    directory.

.PARAMETER Out
    Where to write dictionary.tsv. Defaults to the TypoZen cache folder, which is one of
    the two places TypoZen looks (the other is beside TypoZen.exe).

.PARAMETER MaxSenses
    How many senses to keep per word. WordNet gives "run" over fifty; a popover beside a
    sentence is not the place for all of them, and the first few are the common ones.

.EXAMPLE
    .\tools\Make-Dictionary.ps1 -Source C:\wordnet\dict
#>
[CmdletBinding()]
param(
    [string]$Source = ".\dict",
    [string]$Out = (Join-Path $env:LOCALAPPDATA "TypoZen_Cache\dictionary.tsv"),
    [int]$MaxSenses = 3
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Source)) {
    Write-Host "[ERROR] No such folder: $Source" -ForegroundColor Red
    Write-Host "        Point -Source at WordNet's 'dict' folder (the one with data.noun in it)." -ForegroundColor Yellow
    Write-Host "        Download: https://wordnet.princeton.edu/download/current-version" -ForegroundColor Yellow
    exit 1
}

$files = @('data.noun', 'data.verb', 'data.adj', 'data.adv') |
    ForEach-Object { Join-Path $Source $_ } | Where-Object { Test-Path $_ }

if ($files.Count -eq 0) {
    Write-Host "[ERROR] Found no data.noun / data.verb / data.adj / data.adv in $Source" -ForegroundColor Red
    exit 1
}
Write-Host ("Reading " + $files.Count + " WordNet files from " + $Source) -ForegroundColor Cyan

# word -> ordered list of glosses. Ordinal, so "Run" and "run" are one entry: a reader
# selects a word as the sentence capitalised it, not as the lexicographer filed it.
$map = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)

foreach ($f in $files) {
    Write-Host ("  " + (Split-Path $f -Leaf)) -ForegroundColor Gray
    foreach ($line in [System.IO.File]::ReadLines($f)) {
        # The licence header is indented; every real record starts with an offset.
        if ($line.Length -eq 0 -or $line[0] -eq ' ') { continue }

        # synset_offset lex_filenum ss_type w_cnt (word lex_id)* ... | gloss
        $bar = $line.IndexOf(' | ')
        if ($bar -lt 0) { continue }
        $gloss = $line.Substring($bar + 3).Trim()
        if ($gloss.Length -eq 0) { continue }
        # Usage examples are quoted and follow the definition; the definition is enough
        # for a popover and the examples triple the file size.
        $semi = $gloss.IndexOf('; "')
        if ($semi -gt 0) { $gloss = $gloss.Substring(0, $semi).Trim() }

        $head = $line.Substring(0, $bar).Split(' ')
        if ($head.Count -lt 5) { continue }
        # w_cnt is two hex digits.
        $wc = 0
        if (-not [int]::TryParse($head[3], [System.Globalization.NumberStyles]::HexNumber,
                                 $null, [ref]$wc)) { continue }
        for ($i = 0; $i -lt $wc; $i++) {
            $idx = 4 + ($i * 2)
            if ($idx -ge $head.Count) { break }
            # Underscores are WordNet's spaces; "(a)" style markers are adjective syntax.
            $w = $head[$idx].Replace('_', ' ')
            $paren = $w.IndexOf('(')
            if ($paren -gt 0) { $w = $w.Substring(0, $paren) }
            if ($w.Length -eq 0) { continue }

            if (-not $map.ContainsKey($w)) {
                $map[$w] = [System.Collections.Generic.List[string]]::new()
            }
            $list = $map[$w]
            if ($list.Count -lt $MaxSenses -and -not $list.Contains($gloss)) {
                [void]$list.Add($gloss)
            }
        }
    }
}

Write-Host ("Writing " + $map.Count + " words to " + $Out) -ForegroundColor Cyan
$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

# Streamed, not built in memory: 150,000 joined strings is a lot of garbage for no reason.
$sw = [System.IO.StreamWriter]::new($Out, $false, [System.Text.UTF8Encoding]::new($false))
try {
    foreach ($kv in $map.GetEnumerator()) {
        # Tabs and newlines would break the one-line-per-word format outright.
        $def = ($kv.Value -join '; ') -replace "[`t`r`n]", ' '
        $sw.WriteLine($kv.Key + "`t" + $def)
    }
}
finally { $sw.Dispose() }

Write-Host "Done. Restart TypoZen, select a word, and press Define." -ForegroundColor Green
