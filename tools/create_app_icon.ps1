# Windows-only, reproducible multi-resolution icon. Geometry matches app_icon.svg.
param([string]$OutputPath = (Join-Path $PSScriptRoot 'app_icon.ico'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = [Drawing.Bitmap]::new(256,256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.Color]::Transparent)
$tile = [Drawing.Drawing2D.GraphicsPath]::new()
$tile.AddArc(8,8,96,96,180,90)
$tile.AddArc(152,8,96,96,270,90)
$tile.AddArc(152,152,96,96,0,90)
$tile.AddArc(8,152,96,96,90,90)
$tile.CloseFigure()
$navy = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#102d4f'))
$graphics.FillPath($navy,$tile)
$pile = [Drawing.Drawing2D.GraphicsPath]::new()
$pile.AddPolygon([Drawing.PointF[]]@([Drawing.PointF]::new(64,78),[Drawing.PointF]::new(100,78),[Drawing.PointF]::new(100,188),[Drawing.PointF]::new(82,216),[Drawing.PointF]::new(64,188)))
$graphics.FillPath([Drawing.Brushes]::White,$pile)
$graphics.FillEllipse([Drawing.Brushes]::White,54,58,56,34)
$orange = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#ffad32'),18)
$orange.StartCap = [Drawing.Drawing2D.LineCap]::Round
$orange.EndCap = [Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine($orange,159,66,143,186)
$graphics.DrawLine($orange,204,66,188,186)
$graphics.DrawLine($orange,134,105,216,105)
$graphics.DrawLine($orange,128,151,210,151)
$sizes = @(16,24,32,48,64,128,256)
$frames = @()
foreach ($size in $sizes) {
    $frame = [Drawing.Bitmap]::new($size,$size)
    $g = [Drawing.Graphics]::FromImage($frame)
    $g.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($bitmap,0,0,$size,$size)
    $memory = [IO.MemoryStream]::new()
    $frame.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
    $frames += ,$memory.ToArray()
    $memory.Dispose(); $g.Dispose(); $frame.Dispose()
}
$writer = [IO.BinaryWriter]::new([IO.File]::Create($OutputPath))
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i=0; $i -lt $sizes.Count; $i++) {
        $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
} finally { $writer.Dispose() }
$previewDir = Join-Path $PSScriptRoot 'out'
[IO.Directory]::CreateDirectory($previewDir) | Out-Null
$bitmap.Save((Join-Path $previewDir 'app_icon_preview.png'),[Drawing.Imaging.ImageFormat]::Png)
$preview = [Drawing.Bitmap]::new(600,172)
$g = [Drawing.Graphics]::FromImage($preview)
$g.Clear([Drawing.Color]::White)
$g.FillRectangle([Drawing.Brushes]::DarkSlateGray,0,86,600,86)
$x=20
foreach ($size in @(16,24,32,48,64)) {
    $frame = [IO.MemoryStream]::new([byte[]]$frames[[Array]::IndexOf($sizes,$size)])
    $img = [Drawing.Image]::FromStream($frame)
    $g.DrawImageUnscaled($img,$x,([int](43-$size/2)))
    $g.DrawImageUnscaled($img,$x,([int](129-$size/2)))
    $x += 110
    $img.Dispose(); $frame.Dispose()
}
$preview.Save((Join-Path $previewDir 'app_icon_sizes.png'),[Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $preview.Dispose()
$orange.Dispose(); $pile.Dispose(); $navy.Dispose(); $tile.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
Write-Output "Created $OutputPath (16, 24, 32, 48, 64, 128, 256 px)"
