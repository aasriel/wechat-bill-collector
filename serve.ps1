# Minimal dependency-free static server: powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1
# Then open http://localhost:8432/
# ASCII-only on purpose (PowerShell 5.1 reads BOM-less .ps1 as ANSI/GBK).
$ErrorActionPreference = 'Stop'
$root = (Get-Item $PSScriptRoot).FullName
$prefix = 'http://localhost:8432/'

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host ("Serving {0} at {1}  (Ctrl+C to stop)" -f $root, $prefix)

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.csv'  = 'text/csv'
  '.webmanifest' = 'application/manifest+json'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $file = [System.IO.Path]::GetFullPath((Join-Path $root ($path -replace '/', '\')))
    if ($file.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path $file -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
      if ($types.ContainsKey($ext)) { $ctx.Response.ContentType = $types[$ext] } else { $ctx.Response.ContentType = 'application/octet-stream' }
      $ctx.Response.ContentLength64 = $bytes.Length
      # no-cache: always serve the freshest files (GitHub Pages has its own caching policy)
      $ctx.Response.Headers[[System.Net.HttpResponseHeader]::CacheControl] = 'no-store'
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch {}
  }
  try { $ctx.Response.Close() } catch {}
}
