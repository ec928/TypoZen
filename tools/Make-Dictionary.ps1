<#
.SYNOPSIS
    Build TypoZen's dictionary.tsv and thesaurus.tsv from a WordNet database you have.

.DESCRIPTION
    TypoZen ships dictionary.tsv and thesaurus.tsv beside the exe (Open English
    WordNet, 2025+ edition). This rebuilds them from a WordNet download of your own.
    Nothing here reaches the network -- you do the download; this only reads local files.

    It writes two files from the same pass, because WordNet is a thesaurus as well as a
    dictionary and it would be silly to read 90 MB twice. A synset is a set of words that
    mean the same thing -- "causal_agent, cause, causal_agency" is one -- so the gloss
    gives the definition and the other members of the set give the synonyms.

    The source is the Open English WordNet, the maintained successor to Princeton
    WordNet: CC BY 4.0, plain text, about 152,000 entries, and a single download. Use the
    WNDB-format zip of the "plus" edition, which keeps the curated proper nouns --
    english-wordnet-2025-plus.zip from the 2025-edition release at
    https://github.com/globalwordnet/english-wordnet/releases -- and unpack it. The files
    this needs are data.noun, data.verb, data.adj and data.adv, in its oewn2025-plus
    folder. Princeton's own WordNet 3.1 / 3.0 "dict" folder also still works as input.

    Nothing here reaches the network. You do the download; this only reads local files.

.PARAMETER Source
    Folder holding the WordNet data.* files. Defaults to .\dict under the current
    directory.

.PARAMETER Out
    Where to write dictionary.tsv. Defaults to the TypoZen folder itself, beside
    TypoZen.exe, so the result is visible where you ran the script rather than buried in
    an AppData cache. TypoZen also reads from its cache folder, and prefers that copy, so
    a file placed there still overrides this one.

.PARAMETER MaxSenses
    How many senses to keep per word; 0 (the default) keeps them all. WordNet gives "run"
    over fifty. The popover shows the most common three and offers the rest behind
    "More", and keeping every sense costs about 1 MB over keeping three.

.NOTES
    Output format. One word per line, sorted by word (ordinal, ignoring case) so TypoZen can look it up
    on disk instead of loading it. dictionary.tsv separates senses with " | " (a gloss
    can contain "; " but never "|"); thesaurus.tsv separates synonym groups with "; ".
    Irregular forms from WordNet's *.exc lists ("ran", "mice", "went") that are not
    words in their own right are written as "ran<TAB>@run": TypoZen follows the arrow.

.PARAMETER Counts
    Princeton WordNet's cntlist.rev: how often each sense was tagged in a real corpus.
    This is what puts "move fast on foot" before "a score in baseball" for "run", and it
    is the only source of that: Open English WordNet ships every count as 0. Its sense
    keys are Princeton's, so the two line up (34,579 of 37,387 counted senses match
    OEWN 2025+). Found in the "dict" folder of Princeton's WordNet 3.1 download,
    https://wordnet.princeton.edu/download/current-version -- same licence as the rest of
    the Princeton data. Without it, senses fall back to WordNet's own order per part of
    speech, nouns first, which still gets "bank" right and still gets "run" wrong.

.EXAMPLE
    .\tools\Make-Dictionary.ps1 -Source C:\wordnet\dict -Counts C:\wordnet3.1\dict\cntlist.rev
#>
[CmdletBinding()]
param(
    [string]$Source = ".\dict",
    # Beside TypoZen.exe (the script lives in .\tools), not in an AppData cache folder:
    # output you cannot find is output you cannot check or replace.
    [string]$Out = (Join-Path (Split-Path $PSScriptRoot -Parent) "dictionary.tsv"),
    [string]$ThesaurusOut = (Join-Path (Split-Path $PSScriptRoot -Parent) "thesaurus.tsv"),
    [int]$MaxSenses = 0,
    [string]$Counts = ""
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

# word -> synonym groups, one group per sense, most common sense first.
$syn = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)

# Pass 1 reads every synset. Nothing is chosen yet: the data files are in lexicographer-file
# order (noun.act before noun.object), not by how common a sense is, so keeping the first
# three met gave "run" three nouns starting with baseball, and "bank" a flight manoeuvre.
# synset id ("n:00186329") -> gloss, and -> its member words
$glossOf = [System.Collections.Generic.Dictionary[string, string]]::new()
$members = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new()
# word -> its synsets in file order, for any word the sense index does not cover
$fileOrder = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)

foreach ($f in $files) {
    Write-Host ("  " + (Split-Path $f -Leaf)) -ForegroundColor Gray
    # Offsets are byte positions within one file, so they only identify a synset together
    # with the file it came from. Letters as in a sense key's ss_type.
    $pos = @{ 'data.noun' = 'n'; 'data.verb' = 'v'; 'data.adj' = 'a'; 'data.adv' = 'r' }[(Split-Path $f -Leaf)]
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
        $id = $pos + ':' + $head[0]
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

            # Keys go in now so the files keep first-seen word order; senses come later.
            if (-not $map.ContainsKey($w)) {
                $map[$w] = [System.Collections.Generic.List[string]]::new()
                $fileOrder[$w] = [System.Collections.Generic.List[string]]::new()
            }
            [void]$fileOrder[$w].Add($id)
            [void]$words.Add($w)
        }
        $glossOf[$id] = $gloss
        $members[$id] = $words
        if ($words.Count -gt 1) {
            foreach ($w in $words) {
                if (-not $syn.ContainsKey($w)) { $syn[$w] = [System.Collections.Generic.List[string]]::new() }
            }
        }
    }
}

# Pass 2 ranks each word's senses: most often tagged first (Princeton's counts), then
# WordNet's own sense number, then nouns before verbs before adjectives before adverbs --
# the order the old single pass produced, kept for words nobody counted. One sort key per
# (word, sense), all sorted at once: 200,000 small sorts in PowerShell would take minutes.
$tagCount = [System.Collections.Generic.Dictionary[string, int]]::new([System.StringComparer]::OrdinalIgnoreCase)
if ($Counts) {
    if (-not (Test-Path $Counts)) { Write-Host "[ERROR] No such file: $Counts" -ForegroundColor Red; exit 1 }
    # sense_key sense_number tag_cnt
    foreach ($line in [System.IO.File]::ReadLines($Counts)) {
        $p = $line.Split(' ')
        if ($p.Count -ge 3) { $tagCount[$p[0]] = [int]$p[2] }
    }
    Write-Host ("  " + $tagCount.Keys.Count + " sense counts from " + $Counts) -ForegroundColor Gray
} else {
    Write-Host "  No -Counts: senses in WordNet order per part of speech, nouns first" -ForegroundColor Yellow
}

$indexSense = Join-Path $Source 'index.sense'
$sortKeys = [System.Collections.Generic.List[string]]::new()
$sortIds = [System.Collections.Generic.List[string]]::new()
if (Test-Path $indexSense) {
    # sense_key synset_offset sense_number tag_cnt, e.g. "run%2:38:00:: 01986994 1 0"
    $posLetter = @{ '1' = 'n'; '2' = 'v'; '3' = 'a'; '4' = 'r'; '5' = 'a' }  # 5 = adjective satellite
    $posRank = @{ 'n' = 0; 'v' = 1; 'a' = 2; 'r' = 3 }
    foreach ($line in [System.IO.File]::ReadLines($indexSense)) {
        $p = $line.Split(' ')
        if ($p.Count -lt 3) { continue }
        $pct = $p[0].IndexOf('%')
        if ($pct -le 0) { continue }
        $letter = $posLetter[$p[0].Substring($pct + 1, 1)]
        if (-not $letter) { continue }
        # OEWN escapes punctuation in keys ("-apos-hood" is 'hood, ".22--caliber" is
        # .22-caliber); Princeton's keys are plain and pass through unchanged.
        $lemma = $p[0].Substring(0, $pct)
        if ($lemma.Contains('-')) {
            $lemma = $lemma.Replace('-apos-', "'").Replace('-sol-', '/').Replace('-plus-', '+').
                Replace('-excl-', '!').Replace('-comma-', ',').Replace('-colon-', ':').Replace('--', '-')
        }
        $lemma = $lemma.Replace('_', ' ').ToLowerInvariant()
        $count = 0
        [void]$tagCount.TryGetValue($p[0], [ref]$count)
        $sortKeys.Add($lemma + "`t" + (999999 - $count).ToString('D6') + $posRank[$letter] + ([int]$p[2]).ToString('D4'))
        $sortIds.Add($letter + ':' + $p[1])
    }
} else {
    Write-Host "  No index.sense in $Source -- keeping file order" -ForegroundColor Yellow
}
$keyArr = $sortKeys.ToArray(); $idArr = $sortIds.ToArray()
[Array]::Sort($keyArr, $idArr, [System.StringComparer]::Ordinal)

function Add-Sense([string]$w, [string]$id) {
    $gl = $null
    if (-not $glossOf.TryGetValue($id, [ref]$gl)) { return }
    $list = $map[$w]
    if (($MaxSenses -le 0 -or $list.Count -lt $MaxSenses) -and -not $list.Contains($gl)) { [void]$list.Add($gl) }

    # Every other member of the synset is a synonym of this word. A one-word synset has
    # none, which is most of them.
    $g = $null
    if (-not $syn.TryGetValue($w, [ref]$g)) { return }
    if ($MaxSenses -gt 0 -and $g.Count -ge $MaxSenses) { return }
    $others = @($members[$id] | Where-Object { $_ -ne $w })
    if ($others.Count -gt 0) {
        $joined = ($others -join ', ')
        if (-not $g.Contains($joined)) { [void]$g.Add($joined) }
    }
}

for ($i = 0; $i -lt $keyArr.Length; $i++) {
    $w = $keyArr[$i].Substring(0, $keyArr[$i].IndexOf("`t"))
    if ($map.ContainsKey($w)) { Add-Sense $w $idArr[$i] }
}
# Anything the index did not reach keeps file order, as before.
foreach ($w in @($map.Keys)) {
    if ($map[$w].Count -eq 0) { foreach ($id in $fileOrder[$w]) { Add-Sense $w $id } }
}
# A word whose synsets all had one member ends with no synonyms; no line for it.
foreach ($w in @($syn.Keys)) { if ($syn[$w].Count -eq 0) { [void]$syn.Remove($w) } }

# Irregular forms. TypoZen strips -s / -ed / -ing itself, but no rule gets from "ran" to
# "run" or "mice" to "mouse"; WordNet lists those in *.exc as "form base [base ...]".
# Only forms that are not words of their own get a line -- "better" is already in, and
# "axes" as the plural of "axe" must not shadow a real entry.
$redirect = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[string]]]::new(
    [System.StringComparer]::OrdinalIgnoreCase)
foreach ($exc in @('noun.exc', 'verb.exc', 'adj.exc', 'adv.exc')) {
    $excPath = Join-Path $Source $exc
    if (-not (Test-Path $excPath)) { continue }
    foreach ($line in [System.IO.File]::ReadLines($excPath)) {
        $p = $line.Trim().Split(' ')
        if ($p.Count -lt 2) { continue }
        $form = $p[0].Replace('_', ' ')
        if ($map.ContainsKey($form)) { continue }
        for ($j = 1; $j -lt $p.Count; $j++) {
            $base = $p[$j].Replace('_', ' ')
            if (-not $map.ContainsKey($base)) { continue }
            if (-not $redirect.ContainsKey($form)) { $redirect[$form] = [System.Collections.Generic.List[string]]::new() }
            if (-not $redirect[$form].Contains($base)) { [void]$redirect[$form].Add($base) }
        }
    }
}
Write-Host ("  " + $redirect.Keys.Count + " irregular forms point at their base word") -ForegroundColor Gray

# Sorted, because TypoZen looks words up on disk by binary search and checks the order
# as it indexes; an unsorted file still works, but is loaded into memory instead.
function Get-SortedKeys($dict) {
    $k = [string[]]@($dict.Keys)
    [Array]::Sort($k, [System.StringComparer]::OrdinalIgnoreCase)
    return , $k
}

# $map.Keys.Count, not $map.Count. PowerShell resolves a member on a Dictionary against
# its *keys* first, and "count" is a word in WordNet -- so $map.Count returned the
# definitions of "count" and the progress line read "Writing the act of counting; reciting
# numbers in ascending order ... words to". Harmless here, and exactly the kind of thing
# that is not harmless somewhere else.
Write-Host ("Writing " + $map.Keys.Count + " words to " + $Out) -ForegroundColor Cyan
$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

$all = [System.Collections.Generic.List[string]]::new([string[]]@($map.Keys))
foreach ($f in $redirect.Keys) { $all.Add($f) }
$allKeys = $all.ToArray()
[Array]::Sort($allKeys, [System.StringComparer]::OrdinalIgnoreCase)

# Streamed, not built in memory: 150,000 joined strings is a lot of garbage for no reason.
$sw = [System.IO.StreamWriter]::new($Out, $false, [System.Text.UTF8Encoding]::new($false))
try {
    foreach ($k in $allKeys) {
        if ($map.ContainsKey($k)) { $def = $map[$k] -join ' | ' }
        else { $def = '@' + ($redirect[$k] -join '|') }
        # Tabs and newlines would break the one-line-per-word format outright.
        $sw.WriteLine($k + "`t" + ($def -replace "[`t`r`n]", ' '))
    }
}
finally { $sw.Dispose() }

Write-Host ("Writing " + $syn.Keys.Count + " thesaurus entries to " + $ThesaurusOut) -ForegroundColor Cyan
$tdir = Split-Path $ThesaurusOut -Parent
if ($tdir -and -not (Test-Path $tdir)) { New-Item -ItemType Directory -Force $tdir | Out-Null }
$tw = [System.IO.StreamWriter]::new($ThesaurusOut, $false, [System.Text.UTF8Encoding]::new($false))
try {
    foreach ($k in (Get-SortedKeys $syn)) {
        $line = ($syn[$k] -join '; ') -replace "[`t`r`n]", ' '
        $tw.WriteLine($k + "`t" + $line)
    }
}
finally { $tw.Dispose() }

Write-Host "Done. Restart TypoZen, select a word, and press Define or Synonyms." -ForegroundColor Green
