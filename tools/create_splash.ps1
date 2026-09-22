# Reproducible CAD diagram for the native startup screen; no external assets.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap 620,360
$g = [Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([Drawing.ColorTranslator]::FromHtml('#0d1729'))
$grid = New-Object Drawing.Pen ([Drawing.ColorTranslator]::FromHtml('#20314a')),1
for ($x=320; $x -lt 620; $x+=24) { $g.DrawLine($grid,$x,0,$x,290) }
for ($y=0; $y -lt 300; $y+=24) { $g.DrawLine($grid,305,$y,620,$y) }
$cyan = New-Object Drawing.Pen ([Drawing.ColorTranslator]::FromHtml('#38bdf8')),2
$orange = New-Object Drawing.Pen ([Drawing.ColorTranslator]::FromHtml('#fb923c')),2
$white = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#e8f3ff'))
$muted = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#98b4d4'))
$title = New-Object Drawing.Font 'Segoe UI',25,([Drawing.FontStyle]::Bold)
$subtitle = New-Object Drawing.Font 'Segoe UI',11
$g.DrawString('НУМЕРАТОР',$title,$white,28,72)
$g.DrawString('СВАЙНОГО ПОЛЯ',$subtitle,$muted,32,122)
$g.DrawString("Группы. Порядок. Точность.",$subtitle,$muted,32,189)
$route = @([Drawing.PointF]::new(362,84),[Drawing.PointF]::new(434,84),[Drawing.PointF]::new(506,84),[Drawing.PointF]::new(506,144),[Drawing.PointF]::new(434,144),[Drawing.PointF]::new(362,144),[Drawing.PointF]::new(362,204),[Drawing.PointF]::new(434,204),[Drawing.PointF]::new(506,204))
$g.DrawLines($cyan,[Drawing.PointF[]]$route)
for ($i=0; $i -lt $route.Count; $i++) {
  $p=$route[$i]; $g.FillEllipse([Drawing.Brushes]::MidnightBlue,$p.X-8,$p.Y-8,16,16)
  $g.DrawEllipse($cyan,$p.X-8,$p.Y-8,16,16)
  $g.DrawString([string]($i+1),$subtitle,$white,$p.X+10,$p.Y-22)
}
$g.DrawEllipse($orange,492,190,28,28)
$g.DrawLine($cyan,340,258,550,258); $g.DrawLine($cyan,340,258,340,40)
$g.DrawString('X',$subtitle,$muted,556,247); $g.DrawString('Y',$subtitle,$muted,334,16)
$g.FillRectangle([Drawing.Brushes]::SteelBlue,32,295,556,2)
$bitmap.Save((Join-Path $PSScriptRoot 'splash.png'),[Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bitmap.Dispose(); $grid.Dispose(); $cyan.Dispose(); $orange.Dispose(); $white.Dispose(); $muted.Dispose(); $title.Dispose(); $subtitle.Dispose()
