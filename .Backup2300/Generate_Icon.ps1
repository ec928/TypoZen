Add-Type -AssemblyName System.Drawing

function Draw-TypoZenBitmap {
    param([int]$size)

    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    # Calculate scale factor relative to 256
    $scale = $size / 256.0
    $margin = [int](12 * $scale)
    $rect = New-Object System.Drawing.Rectangle($margin, $margin, ($size - 2 * $margin), ($size - 2 * $margin))
    $radius = [int](52 * $scale)

    # Create Rounded Rectangle GraphicsPath
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    # Drop shadow
    $shadowOffset = [int](6 * $scale)
    $shadowRect = New-Object System.Drawing.Rectangle(($rect.X + $shadowOffset), ($rect.Y + $shadowOffset), $rect.Width, $rect.Height)
    $shadowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $shadowPath.AddArc($shadowRect.X, $shadowRect.Y, $d, $d, 180, 90)
    $shadowPath.AddArc($shadowRect.Right - $d, $shadowRect.Y, $d, $d, 270, 90)
    $shadowPath.AddArc($shadowRect.Right - $d, $shadowRect.Bottom - $d, $d, $d, 0, 90)
    $shadowPath.AddArc($shadowRect.X, $shadowRect.Bottom - $d, $d, $d, 90, 90)
    $shadowPath.CloseFigure()
    $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 0, 0, 0))
    $g.FillPath($shadowBrush, $shadowPath)
    $shadowBrush.Dispose()

    # Gradient Background (Deep Indigo to Obsidian Zen Dark)
    $color1 = [System.Drawing.Color]::FromArgb(255, 79, 70, 229)   # Indigo 600
    $color2 = [System.Drawing.Color]::FromArgb(255, 15, 23, 42)    # Slate 900
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $color1, $color2, 45.0)
    $g.FillPath($bgBrush, $path)

    # Subtle border highlight
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 255, 255, 255), [float](3 * $scale))
    $g.DrawPath($borderPen, $path)

    # Draw Zen Circle (Enso style open arc)
    $circleMargin = [int](38 * $scale)
    $circleRect = New-Object System.Drawing.Rectangle($circleMargin, $circleMargin, ($size - 2 * $circleMargin), ($size - 2 * $circleMargin))
    $penWidth = [float](10 * $scale)
    $circlePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 56, 189, 248), $penWidth) # Sky Blue glow
    $circlePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $circlePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($circlePen, $circleRect, 40, 290)

    # Draw Stylized "T" Typography inside the Zen circle
    $fontSize = [float](90 * $scale)
    $fontStyle = [System.Drawing.FontStyle]::Italic -bor [System.Drawing.FontStyle]::Bold
    $font = New-Object System.Drawing.Font("Georgia", $fontSize, $fontStyle)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

    # Text drop shadow for depth
    $textRectShadow = New-Object System.Drawing.RectangleF(($rect.X + 3*$scale), ($rect.Y + 4*$scale), $rect.Width, $rect.Height)
    $textShadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
    $g.DrawString("T", $font, $textShadowBrush, $textRectShadow, $sf)

    $textRect = New-Object System.Drawing.RectangleF($rect.X, ($rect.Y + 2*$scale), $rect.Width, $rect.Height)
    $g.DrawString("T", $font, $textBrush, $textRect, $sf)

    # Cleanup
    $bgBrush.Dispose()
    $borderPen.Dispose()
    $circlePen.Dispose()
    $font.Dispose()
    $textBrush.Dispose()
    $textShadowBrush.Dispose()
    $path.Dispose()
    $shadowPath.Dispose()
    $g.Dispose()

    return $bmp
}

# Generate 4 standard icon resolutions
$sizes = @(256, 48, 32, 16)
$bitmaps = @()
$pngStreams = @()

foreach ($s in $sizes) {
    $b = Draw-TypoZenBitmap -size $s
    $bitmaps += $b
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngStreams += $ms
}

# Write multi-resolution ICO file
$icoPath = Join-Path $PSScriptRoot "TypoZen.ico"
$fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICO Header
$bw.Write([UInt16]0) # Reserved
$bw.Write([UInt16]1) # Type (1 = Icon)
$bw.Write([UInt16]$sizes.Length) # Count

# Calculate offsets
$offset = 6 + (16 * $sizes.Length)

for ($i = 0; $i -lt $sizes.Length; $i++) {
    $s = $sizes[$i]
    $streamLen = [UInt32]$pngStreams[$i].Length

    $w = if ($s -eq 256) { 0 } else { [byte]$s }
    $h = if ($s -eq 256) { 0 } else { [byte]$s }

    $bw.Write([byte]$w)       # Width
    $bw.Write([byte]$h)       # Height
    $bw.Write([byte]0)       # ColorCount
    $bw.Write([byte]0)       # Reserved
    $bw.Write([UInt16]1)     # Planes
    $bw.Write([UInt16]32)    # BitCount
    $bw.Write([UInt32]$streamLen) # ImageSize
    $bw.Write([UInt32]$offset)    # ImageOffset

    $offset += $streamLen
}

# Write PNG data for each image
foreach ($ms in $pngStreams) {
    $bytes = $ms.ToArray()
    $bw.Write($bytes)
    $ms.Dispose()
}

$bw.Flush()
$bw.Close()
$fs.Close()

foreach ($b in $bitmaps) { $b.Dispose() }

Write-Host "Generated TypoZen.ico successfully at $icoPath"
