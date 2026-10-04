param([string]$Source, [int]$Width = 1024, [int]$MaxBytes = 190000)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$original = [System.Drawing.Image]::FromFile($Source)
try {
  $targetWidth = [Math]::Max(1, [int]([Math]::Min([Math]::Min($Width, $original.Width), $original.Width * 1536 / $original.Height)))
  $targetHeight = [Math]::Max(1, [int]($original.Height * $targetWidth / $original.Width))
  $bitmap = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.Clear([System.Drawing.Color]::White); $graphics.DrawImage($original, 0, 0, $targetWidth, $targetHeight) } finally { $graphics.Dispose() }
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    for ($quality = 75; $quality -ge 15; $quality -= 10) {
      $stream = New-Object System.IO.MemoryStream
      $parameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
      try {
        $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
        $bitmap.Save($stream, $codec, $parameters)
        if ($stream.Length -lt $MaxBytes) { [Convert]::ToBase64String($stream.ToArray()); break }
      } finally { $parameters.Dispose(); $stream.Dispose() }
    }
  } finally { $bitmap.Dispose() }
} finally { $original.Dispose() }
