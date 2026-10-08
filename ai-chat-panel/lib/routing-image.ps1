param([string]$Source, [int]$Width = 1024, [int]$MaxBytes = 190000)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$original = [System.Drawing.Image]::FromFile($Source)
try {
  $targetWidth = [Math]::Max(1, [int]([Math]::Min([Math]::Min($Width, $original.Width), $original.Width * 1536 / $original.Height)))
  $targetHeight = [Math]::Max(1, [int]($original.Height * $targetWidth / $original.Width))
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  while ($true) {
    $bitmap = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try { $graphics.Clear([System.Drawing.Color]::White); $graphics.DrawImage($original, 0, 0, $targetWidth, $targetHeight) } finally { $graphics.Dispose() }
      for ($quality = 75; $quality -ge 15; $quality -= 10) {
        $stream = New-Object System.IO.MemoryStream
        $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
        try {
          $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
          $bitmap.Save($stream, $codec, $parameters)
          if ($stream.Length -lt $MaxBytes) { [Convert]::ToBase64String($stream.ToArray()); return }
        } finally { $parameters.Dispose(); $stream.Dispose() }
      }
    } finally { $bitmap.Dispose() }
    # Only shrink further when even the lowest JPEG quality cannot fit.
    if ($targetWidth -eq 1 -and $targetHeight -eq 1) { break }
    $previousHeight = $targetHeight
    $targetWidth = [Math]::Max(1, [int][Math]::Floor($targetWidth * 0.75))
    $targetHeight = [Math]::Max(1, [int]($original.Height * $targetWidth / $original.Width))
    if ($targetWidth -eq 1) { $targetHeight = [Math]::Max(1, [int][Math]::Floor($previousHeight * 0.75)) }
  }
} finally { $original.Dispose() }
