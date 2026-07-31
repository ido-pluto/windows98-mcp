[CmdletBinding()]
param(
  [string]$Version = "0.1.0",
  [ValidateSet("x64", "arm64")][string]$Architecture = "x64",
  [string]$SidecarPath
)

$ErrorActionPreference = "Stop"
$adminRoot = (Resolve-Path "$PSScriptRoot\..").Path
$SidecarPath = if ($SidecarPath) { $SidecarPath } else { Join-Path $adminRoot "src-tauri\resources\broker-sidecar\windows98-mcp-broker.exe" }
$tauriRoot = Join-Path $adminRoot "src-tauri"
$releaseExe = Join-Path $tauriRoot "target\release\windows98-mcp-admin.exe"

if (-not (Test-Path -LiteralPath $SidecarPath -PathType Leaf)) {
  throw "Broker sidecar not found: $SidecarPath. Build the Node SEA sidecar before packaging the portable admin bundle."
}

Push-Location $adminRoot
try { npm run tauri:build -- --no-bundle } finally { Pop-Location }

if (-not (Test-Path -LiteralPath $releaseExe -PathType Leaf)) { throw "Tauri build did not produce: $releaseExe" }

$portableName = "windows98-mcp-admin-$Version-windows-$Architecture"
$outputRoot = Join-Path $adminRoot "out"
$portableRoot = Join-Path $outputRoot $portableName
$zipPath = Join-Path $outputRoot "$portableName.zip"
Remove-Item -LiteralPath $portableRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$portableRoot\broker-sidecar" -Force | Out-Null
Copy-Item -LiteralPath $releaseExe -Destination "$portableRoot\Windows 98 MCP Admin.exe"
Copy-Item -LiteralPath $SidecarPath -Destination "$portableRoot\broker-sidecar\windows98-mcp-broker.exe"
Copy-Item -LiteralPath "$adminRoot\README.md" -Destination "$portableRoot\README.TXT"
Compress-Archive -LiteralPath $portableRoot -DestinationPath $zipPath
$sha = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($zipPath)
try { $digest = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
finally { $stream.Dispose(); $sha.Dispose() }
[IO.File]::WriteAllText("$zipPath.sha256", "$digest  $(Split-Path -Leaf $zipPath)", [Text.Encoding]::ASCII)
Write-Output "Portable bundle: $zipPath"
