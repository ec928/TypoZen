param([string]$Out)
# A tiny ePub for book-page-label-app.mjs: a front-matter section of three full-page pictures,
# then one text chapter. Built here so no third-party book is checked in.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem, System.Drawing
if (Test-Path $Out) { Remove-Item $Out -Force }
$zip = [System.IO.Compression.ZipFile]::Open($Out, 'Create')
function Add-Text($path, $text, $level) {
    $e = $zip.CreateEntry($path, $level)
    $w = New-Object IO.StreamWriter($e.Open(), (New-Object Text.UTF8Encoding($false)))
    $w.Write($text); $w.Close()
}
function Add-Png($path, $color) {
    $bmp = New-Object System.Drawing.Bitmap 600, 900
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear($color); $g.Dispose()
    $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    $e = $zip.CreateEntry($path, 'NoCompression'); $s = $e.Open(); $ms.Position = 0; $ms.CopyTo($s); $s.Close()
}
try {
    Add-Text 'mimetype' 'application/epub+zip' 'NoCompression'
    Add-Text 'META-INF/container.xml' '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' 'Optimal'
    foreach ($i in 1..3) { Add-Png "OEBPS/p$i.png" ([System.Drawing.Color]::FromArgb(40 * $i, 90, 160)) }
    $pic = { param($n) '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>p</title></head><body><div><img src="p' + $n + '.png" alt=""/></div></body></html>' }
    foreach ($i in 1..3) { Add-Text "OEBPS/front$i.xhtml" (& $pic $i) 'Optimal' }
    $paras = (1..60 | ForEach-Object { '<p>Paragraph ' + $_ + ' of the first chapter, long enough to fill a line or two of the page so that the chapter runs over several pages.</p>' }) -join ''
    Add-Text 'OEBPS/ch1.xhtml' ('<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><h1>Chapter One</h1>' + $paras + '</body></html>') 'Optimal'
    Add-Text 'OEBPS/toc.ncx' '<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="tz-pic-test"/></head><docTitle><text>Pictures</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Front Matter</text></navLabel><content src="front1.xhtml"/></navPoint><navPoint id="n2" playOrder="2"><navLabel><text>Chapter One</text></navLabel><content src="ch1.xhtml"/></navPoint></navMap></ncx>' 'Optimal'
    $opf = '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Pictures</dc:title><dc:identifier id="uid">tz-pic-test</dc:identifier><dc:language>en</dc:language></metadata><manifest>'
    $opf += '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    $opf += (1..3 | ForEach-Object { '<item id="f' + $_ + '" href="front' + $_ + '.xhtml" media-type="application/xhtml+xml"/><item id="i' + $_ + '" href="p' + $_ + '.png" media-type="image/png"/>' }) -join ''
    $opf += '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="f1"/><itemref idref="f2"/><itemref idref="f3"/><itemref idref="c1"/></spine></package>'
    Add-Text 'OEBPS/content.opf' $opf 'Optimal'
} finally { $zip.Dispose() }
"made $Out"
