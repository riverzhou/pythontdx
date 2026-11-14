# Self-signed Authenticode signing for Windows release artifacts.
#
# This proves the files have not changed since signing. It does NOT remove
# SmartScreen "unknown publisher" warnings.
#
# Usage: npm.cmd run sign:win
#        (build:win / build:win:setup / build:win:portable call it automatically)
$ErrorActionPreference = 'Stop'

# scripts/build/ 距仓库根两层：scripts/build -> scripts -> repo
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
$version = node -p "require('./package.json').version"
$release = Join-Path $root "release\$version"
if (-not (Test-Path $release)) {
  throw "release directory not found: $release. Run build:win first."
}

$subject = 'CN=pythontdx Self-Signed (integrity only)'
# PowerShell 7 不支持 Get-ChildItem 的 -CodeSigningCert 动态参数；按 EKU 过滤。
$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object {
    $_.Subject -eq $subject -and
    $_.HasPrivateKey -and
    ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')
  } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1
if (-not $cert) {
  Write-Host 'No self-signed certificate found; creating a 10-year code signing certificate...'
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -CertStoreLocation Cert:\CurrentUser\My `
    -KeyExportPolicy Exportable `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(10)
}

$cerPath = Join-Path $release 'pythontdx-selfsigned.cer'
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
Write-Host "Public certificate: $cerPath"
Write-Host "Certificate thumbprint: $($cert.Thumbprint)"

$candidates = @()
$candidates += Get-ChildItem $release -Filter '*.exe' -File -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName }
$candidates += Join-Path $release 'win-unpacked\pythontdx.exe'
$candidates += Join-Path $release 'win-unpacked\resources\tdx-bridge\tdx-bridge.exe'
$candidates += Join-Path $release "pythontdx-$version-win-x64\pythontdx.exe"
$candidates += Join-Path $release "pythontdx-$version-win-x64\resources\tdx-bridge\tdx-bridge.exe"

$signed = 0
foreach ($item in $candidates | Where-Object { Test-Path $_ } | Select-Object -Unique) {
  $file = (Resolve-Path $item).Path
  $signature = Set-AuthenticodeSignature `
    -FilePath $file `
    -Certificate $cert `
    -HashAlgorithm SHA256
  if ($signature.Status -in @('HashMismatch', 'NotSigned')) {
    throw "Signing failed: $file ($($signature.Status) $($signature.StatusMessage))"
  }
  $signed += 1
  Write-Host ("Signed: {0}  [{1}]" -f (Split-Path $file -Leaf), $signature.Status)
}

if ($signed -eq 0) {
  throw 'No signable exe found. Run build:win first.'
}
Write-Host "Done: $signed file(s) signed (self-signed, integrity only; SmartScreen still warns)."
