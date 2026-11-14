# Build the Windows "green" zip from release/<version>/win-unpacked.
# ASCII only: Windows PowerShell 5.1 reads UTF-8 without BOM as ANSI.
$ErrorActionPreference = 'Stop'

# scripts/build/ 距仓库根两层：scripts/build -> scripts -> repo
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$version = (node -p "require('./package.json').version").Trim()
if (-not $version) { throw 'cannot read package.json version' }

$release = Join-Path $root "release/$version"
$source = Join-Path $release 'win-unpacked'
if (-not (Test-Path $source)) { throw "missing $source; run electron-builder --win first" }

$green = Join-Path $release "pythontdx-$version-win-x64"
$zip = Join-Path $release "pythontdx-$version-win-x64.zip"

if (Test-Path $green) { Remove-Item $green -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
if (Test-Path "$zip.sha256") { Remove-Item "$zip.sha256" -Force }

Copy-Item $source $green -Recurse

$cert = Join-Path $release 'pythontdx-selfsigned.cer'
if (Test-Path $cert) {
  Copy-Item $cert (Join-Path $green 'pythontdx-selfsigned.cer')
}

Compress-Archive -Path $green -DestinationPath $zip -CompressionLevel Optimal

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $names = $archive.Entries | ForEach-Object FullName
  if (-not ($names -match '(^|[\\/])pythontdx\.exe$')) { throw 'pythontdx.exe missing in zip' }
  if (-not ($names -match '(^|[\\/])tdx-bridge\.exe$')) { throw 'tdx-bridge.exe missing in zip' }
  Write-Host "zip entries: $($names.Count)"
} finally {
  $archive.Dispose()
}

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $zip -Leaf)" | Out-File -FilePath "$zip.sha256" -Encoding ascii

$item = Get-Item $zip
Write-Host "zip: $($item.FullName)"
Write-Host "bytes: $($item.Length)"
Write-Host "sha256: $hash"
