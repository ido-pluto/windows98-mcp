[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $OutputPath) {
    $OutputPath = Join-Path $repo "admin\src-tauri\resources\broker-sidecar\windows98-mcp-broker.exe"
}
Push-Location $repo
try {
    npm run build
    & node (Join-Path $repo "scripts\build-broker-sidecar.mjs") $OutputPath
    if ($LASTEXITCODE -ne 0) { throw "Broker sidecar build failed" }
} finally {
    Pop-Location
}
