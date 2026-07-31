[CmdletBinding()]
param(
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo "out\release" }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null

& (Join-Path $PSScriptRoot "build-broker-sidecar.ps1")
& (Join-Path $repo "admin\scripts\package-portable.ps1") -Version "0.0.0"

$adminOut = Join-Path $repo "admin\out"
$archive = Get-ChildItem -LiteralPath $adminOut -Filter "windows98-mcp-admin-0.0.0-windows-x64.zip" -File | Select-Object -First 1
if (-not $archive) { throw "Portable admin archive was not created." }
$hash = "$($archive.FullName).sha256"
if (-not (Test-Path -LiteralPath $hash)) { throw "Portable admin SHA-256 file was not created." }

Copy-Item -LiteralPath $archive.FullName -Destination (Join-Path $output "windows98-mcp-admin-windows-x64.zip") -Force
Copy-Item -LiteralPath $hash -Destination (Join-Path $output "windows98-mcp-admin-windows-x64.zip.sha256") -Force
Write-Host "Release admin bundle staged at $output"
