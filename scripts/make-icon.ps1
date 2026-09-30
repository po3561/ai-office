# 앱 아이콘(assets/ai-office.ico, .png)을 그린다. 한 번 실행해서 결과 파일을 저장소에 넣어 둔다.
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-Icon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $r = [int]($size * 0.28)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($size - $r, 0, $r, $r, 270, 90)
    $path.AddArc($size - $r, $size - $r, $r, $r, 0, 90); $path.AddArc(0, $size - $r, $r, $r, 90, 90); $path.CloseFigure()
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Point]::new(0, 0)), ([System.Drawing.Point]::new($size, $size)), ([System.Drawing.Color]::FromArgb(255, 112, 112, 230)), ([System.Drawing.Color]::FromArgb(255, 74, 74, 200))
    $g.FillPath($brush, $path)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single]($size * 0.075))
    $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $s = $size / 32.0
    $pts = @([System.Drawing.PointF]::new(9 * $s, 22 * $s), [System.Drawing.PointF]::new(9 * $s, 11.5 * $s), [System.Drawing.PointF]::new(16 * $s, 8 * $s), [System.Drawing.PointF]::new(23 * $s, 11.5 * $s), [System.Drawing.PointF]::new(23 * $s, 22 * $s))
    $g.DrawLines($pen, $pts)
    $g.DrawLines($pen, @([System.Drawing.PointF]::new(13 * $s, 22 * $s), [System.Drawing.PointF]::new(13 * $s, 16 * $s), [System.Drawing.PointF]::new(19 * $s, 16 * $s), [System.Drawing.PointF]::new(19 * $s, 22 * $s)))
    $g.Dispose()
    return $bmp
}

$sizes = 256, 64, 48, 32, 16
$pngs = foreach ($sz in $sizes) {
    $b = New-Icon $sz
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($sz -eq 256) { $b.Save((Join-Path $out 'ai-office.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
    $b.Dispose()
    , @($sz, $ms.ToArray())
}

# PNG 이미지를 담은 ICO 파일 만들기
$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
    $sz = $p[0]; $data = $p[1]
    $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $w.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$data.Length); $w.Write([uint32]$offset)
    $offset += $data.Length
}
foreach ($p in $pngs) { $w.Write($p[1]) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $out 'ai-office.ico'), $ico.ToArray())
Write-Host "아이콘을 만들었습니다: $out"
