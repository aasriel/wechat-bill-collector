# Convert the UTF-8 sample bill to GBK (same encoding as real WeChat exports).
# ASCII-only on purpose: PowerShell 5.1 parses BOM-less .ps1 files as ANSI/GBK,
# so any non-ASCII literal here would be misread.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File make-sample.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'sample\_source_utf8.csv'
$dst = Join-Path $root 'sample\wechat-bill-sample-gbk.csv'

try { $gbk = [System.Text.Encoding]::GetEncoding(936) }
catch { $gbk = [System.Text.CodePagesEncodingProvider]::Instance.GetEncoding(936) }

$text = [System.IO.File]::ReadAllText($src, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllBytes($dst, $gbk.GetBytes($text))

$bytes = [System.IO.File]::ReadAllBytes($dst)
$first = $bytes[0..15]
Write-Output ('ENC=' + $gbk.WebName)
Write-Output ('FIRST16=' + (($first | ForEach-Object { [int]$_ }) -join ','))
Write-Output ('SIZE=' + $bytes.Length)
