<#
.SYNOPSIS
    Build TypoZen's dictionary.tsv and thesaurus.tsv from a WordNet database you have.

.DESCRIPTION
    TypoZen bundles no dictionary and downloads nothing, so Define needs a file you
    supply. This turns WordNet's data files into the one-line-per-word TSVs it reads,
    which is otherwise a fiddly bit of parsing to write yourself.

    It writes two files from the same pass, because WordNet is a thesaurus as well as a
    dictionary and it would be silly to read 90 MB twice. A synset is a set of words that
    mean the same thing -- "causal_agent, cause, causal_agency" is one -- so the gloss
    gives the definition and the other members of the set give the synonyms.

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
    [string]$ThesaurusOut = (Join-Path $env:LOCALAPPDATA "TypoZen_Cache\thesaurus.tsv"),
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

# word -> synonym groups, one group per sense, in the order WordNet files them.
$syn = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new(
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
        $words = [System.Collections.Generic.List[string]]::new()
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
            [void]$words.Add($w)
        }

        # Every other member of the synset is a synonym of each member. A one-word synset
        # has none, which is most of them, and writing an empty line for those would double
        # the file for nothing.
        if ($words.Count -gt 1) {
            foreach ($w in $words) {
                $others = @($words | Where-Object { $_ -ne $w })
                if ($others.Count -eq 0) { continue }
                if (-not $syn.ContainsKey($w)) {
                    $syn[$w] = [System.Collections.Generic.List[string]]::new()
                }
                $g = $syn[$w]
                if ($g.Count -lt $MaxSenses) {
                    $joined = ($others -join ', ')
                    if (-not $g.Contains($joined)) { [void]$g.Add($joined) }
                }
            }
        }
    }
}

# $map.Keys.Count, not $map.Count. PowerShell resolves a member on a Dictionary against
# its *keys* first, and "count" is a word in WordNet -- so $map.Count returned the
# definitions of "count" and the progress line read "Writing the act of counting; reciting
# numbers in ascending order ... words to". Harmless here, and exactly the kind of thing
# that is not harmless somewhere else.
Write-Host ("Writing " + $map.Keys.Count + " words to " + $Out) -ForegroundColor Cyan
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

Write-Host ("Writing " + $syn.Keys.Count + " thesaurus entries to " + $ThesaurusOut) -ForegroundColor Cyan
$tdir = Split-Path $ThesaurusOut -Parent
if ($tdir -and -not (Test-Path $tdir)) { New-Item -ItemType Directory -Force $tdir | Out-Null }
$tw = [System.IO.StreamWriter]::new($ThesaurusOut, $false, [System.Text.UTF8Encoding]::new($false))
try {
    foreach ($kv in $syn.GetEnumerator()) {
        $line = ($kv.Value -join '; ') -replace "[`t`r`n]", ' '
        $tw.WriteLine($kv.Key + "`t" + $line)
    }
}
finally { $tw.Dispose() }

Write-Host "Done. Restart TypoZen, select a word, and press Define or Synonyms." -ForegroundColor Green
