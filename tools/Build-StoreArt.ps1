# Build-StoreArt.ps1 — the Store listing artwork Partner Center asks for.
#
#   .\tools\Build-StoreArt.ps1        -> dist-storeart\*.png
#
# These are OPTIONAL. Without them the Store falls back to the tile logos inside the
# package (Build-Msix.ps1 draws those). But 9:16 Poster art is the main logo shown to
# Windows 10/11 customers, and a 310px tile stretched into that slot looks like exactly
# what it is.
#
# Drawn rather than photographed, from two things the app already owns: TypoZen.ico and
# Literata, the serif the reading themes lead with. Colours are Gruvbox, the app's own
# default theme, so the listing and the first screenshot agree with each other.
#
# The icon tops out at 256x256, so it is placed at a size it can actually carry rather
# than blown up to fill the canvas. The type is vector and stays crisp at any size.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out  = Join-Path $root 'dist-storeart'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# Gruvbox, as TypoZen_Themes.json declares it.
$bg     = [System.Drawing.ColorTranslator]::FromHtml('#282828')
$text   = [System.Drawing.ColorTranslator]::FromHtml('#EBDBB2')
$accent = [System.Drawing.ColorTranslator]::FromHtml('#FABD2F')
$muted  = [System.Drawing.ColorTranslator]::FromHtml('#A89984')

# Literata, loaded privately so nothing has to be installed on the machine building this.
$fonts = New-Object System.Drawing.Text.PrivateFontCollection
$literata = Join-Path $root 'fonts\Literata.ttf'
$haveLiterata = Test-Path $literata
if ($haveLiterata) { $fonts.AddFontFile($literata) }
function Get-Family {
    if ($haveLiterata) { return $fonts.Families[0] }
    return (New-Object System.Drawing.FontFamily('Georgia'))
}

# The mark is DRAWN, not rescaled. TypoZen.ico tops out at 256x256 and stores that frame
# as PNG, which Icon.ToBitmap() will not open at all; and even when it opens, the mark
# carries a stroked arc and a text shadow that smear when resampled. Generate_Icon.ps1
# draws it vectorially at any size, so take that one function -- the same way
# Build-Msix.ps1 does, and for the same reason: dot-sourcing the script would run it, and
# its job is to rewrite TypoZen.ico, a tracked file with no business changing here.
$iconSrc = Get-Content (Join-Path $root 'Generate_Icon.ps1') -Raw
$cut = $iconSrc.IndexOf('# Generate 4 standard icon resolutions')
if ($cut -lt 0) { throw "Generate_Icon.ps1 no longer has its generation marker; check before drawing art." }
Invoke-Expression $iconSrc.Substring(0, $cut)

function New-Art {
    param([int]$W, [int]$H, [string]$Name)

    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear($bg)

    # A very soft vertical lift, so a large flat field does not read as dead space.
    $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
    $top = [System.Drawing.Color]::FromArgb(255, 50, 48, 47)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $top, $bg, 90.0)
    $g.FillRectangle($grad, $rect)
    $grad.Dispose()

    # Drawn at the exact size it is placed at, so nothing is ever resampled.
    $iconSize = [int]($W * 0.34)
    $ix = [int](($W - $iconSize) / 2)
    $iy = [int]($H * 0.24)
    $mark = Draw-TypoZenBitmap -size $iconSize
    $g.DrawImage($mark, $ix, $iy, $iconSize, $iconSize)
    $mark.Dispose()

    $fam = Get-Family
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center

    # Wordmark.
    $nameSize = [single]($W * 0.115)
    $fName = New-Object System.Drawing.Font($fam, $nameSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $bName = New-Object System.Drawing.SolidBrush($text)
    $nameY = $iy + $iconSize + [int]($H * 0.055)
    $g.DrawString('TypoZen', $fName, $bName, [single]($W / 2), [single]$nameY, $sf)

    # Accent rule. 1.45x the em box put it straight through the descender of the "p" --
    # Literata's descenders are deep, and DrawString's Y is the TOP of the em box, so the
    # gap has to clear the whole line box and then some.
    $ruleW = [int]($W * 0.20)
    $ruleY = $nameY + [int]($nameSize * 1.80)
    $bRule = New-Object System.Drawing.SolidBrush($accent)
    $g.FillRectangle($bRule, [int](($W - $ruleW) / 2), $ruleY, $ruleW, [Math]::Max(3, [int]($H * 0.004)))

    # What it is, in the fewest words that are still true.
    $tagSize = [single]($W * 0.038)
    $fTag = New-Object System.Drawing.Font($fam, $tagSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $bTag = New-Object System.Drawing.SolidBrush($muted)
    $tagY = $ruleY + [int]($H * 0.035)
    $g.DrawString('Markdown editor and ePub reader', $fTag, $bTag, [single]($W / 2), [single]$tagY, $sf)

    $path = Join-Path $out $Name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    $fName.Dispose(); $fTag.Dispose(); $bName.Dispose(); $bTag.Dispose(); $bRule.Dispose()
    $sf.Dispose(); $g.Dispose(); $bmp.Dispose()

    $kb = [int]((Get-Item $path).Length / 1KB)
    Write-Host ("  {0,-28} {1}x{2}  {3} KB" -f $Name, $W, $H, $kb)
}

function New-Hero {
    param([int]$W, [int]$H, [string]$Name)

    # 16:9 Super hero art, which runs across the top of the listing.
    #
    # NO WORDMARK. Partner Center is explicit: "Must not include the product's title."
    # So this cannot be the poster composition widened -- it shows the product instead of
    # naming it, which for a typography app means showing type. Real Literata at low alpha,
    # because a fake page drawn as grey bars would be a picture of a wireframe.
    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear($bg)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
    $top = [System.Drawing.Color]::FromArgb(255, 52, 50, 48)
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $top, $bg, 60.0)
    $g.FillRectangle($grad, $rect)
    $grad.Dispose()

    $fam = Get-Family
    $markSize = [int]($H * 0.34)

    # A column of prose, set the way the app sets it, fading as it falls back.
    $bodySize = [single]($H * 0.038)
    $fBody = New-Object System.Drawing.Font($fam, $bodySize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $lines = @(
        'the sand was a low dune crest, and the wind',
        'came off it carrying the smell of the deep',
        'desert. He read the page again, slowly, the',
        'way a thing is read when there is nothing',
        'else to do with the evening but read it, and',
        'the margin held the line where he had left',
        'off the night before.'
    )
    $x = [int]($W * 0.34)
    $lead = [int]($bodySize * 1.65)
    # Centred on the canvas rather than started at a guessed offset: seven lines at this
    # leading left the bottom third of a 1080 frame empty when y was pinned to 0.20.
    $y = [int]((($H - ($lines.Count * $lead)) / 2))
    for ($i = 0; $i -lt $lines.Count; $i++) {
        # Falls away down the column, so the eye lands on the mark and not on the words.
        $a = [int](150 - ($i * 17))
        if ($a -lt 26) { $a = 26 }
        $c = [System.Drawing.Color]::FromArgb($a, $text.R, $text.G, $text.B)
        $b = New-Object System.Drawing.SolidBrush($c)
        $g.DrawString($lines[$i], $fBody, $b, [single]$x, [single]($y + ($i * $lead)))
        $b.Dispose()
    }
    $fBody.Dispose()

    # The mark, left, drawn at the size it sits at.
    $mark = Draw-TypoZenBitmap -size $markSize
    $g.DrawImage($mark, [int]($W * 0.13), [int](($H - $markSize) / 2), $markSize, $markSize)
    $mark.Dispose()

    # One amber rule, the gutter the reading themes draw their bookmark rail in.
    # Between the mark and the column, not through the mark. At 0.295 it crossed the icon,
    # which spans 0.13W to 0.13W + 0.34H and so reaches past it on a 16:9 frame.
    $bRule = New-Object System.Drawing.SolidBrush($accent)
    $ruleX = [int]($W * 0.13) + $markSize + [int]($W * 0.010)
    $g.FillRectangle($bRule, $ruleX, [int]($H * 0.20), [Math]::Max(3, [int]($W * 0.0022)), [int]($H * 0.60))
    $bRule.Dispose()

    $path = Join-Path $out $Name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $kb = [int]((Get-Item $path).Length / 1KB)
    Write-Host ("  {0,-28} {1}x{2}  {3} KB" -f $Name, $W, $H, $kb)
}

Write-Host "`nStore listing artwork" -ForegroundColor Cyan
if (-not $haveLiterata) { Write-Warning "fonts\Literata.ttf not found - falling back to Georgia." }

New-Art -W 720  -H 1080 -Name 'PosterArt-720x1080.png'
New-Art -W 1080 -H 1080 -Name 'BoxArt-1080x1080.png'
New-Hero -W 1920 -H 1080 -Name 'SuperHeroArt-1920x1080.png'

$fonts.Dispose()

Write-Host "`nWritten to dist-storeart\" -ForegroundColor Green
Write-Host "  9:16 Poster art -> PosterArt-720x1080.png"
Write-Host "  1:1 Box art     -> BoxArt-1080x1080.png"
Write-Host "  16:9 Super hero -> SuperHeroArt-1920x1080.png  (no title, by requirement)"
Write-Host "Both optional: without them the Store uses the package tile logos.`n"
