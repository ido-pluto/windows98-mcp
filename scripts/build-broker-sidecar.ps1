[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $OutputPath) {
    $OutputPath = Join-Path $repo "admin\src-tauri\resources\broker-sidecar\windows98-mcp-broker.exe"
}
$work = Join-Path $repo "out\broker-sidecar-build"
$output = [IO.Path]::GetFullPath($OutputPath)

if ($env:OS -ne "Windows_NT") {
    throw "The broker sidecar must be built on Windows so it can be embedded in node.exe."
}

Push-Location $repo
try {
    npm run build
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $work, (Split-Path -Parent $output) | Out-Null

    # SEA starts CommonJS, so bundle the tested broker and its dependencies as
    # one CommonJS payload instead of shipping node_modules beside the app.
    & npx --yes esbuild@0.25.12 .\dist\src\cli.js --bundle --platform=node --format=cjs --target=node22 --outfile="$work\broker.cjs"
    if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }

    $seaConfig = @{ main = "broker.cjs"; output = "broker.blob"; disableExperimentalSEAWarning = $true } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $work "sea-config.json"), $seaConfig, [Text.UTF8Encoding]::new($false))
    Push-Location $work
    try {
        & node --experimental-sea-config sea-config.json
        if ($LASTEXITCODE -ne 0) { throw "Node SEA blob generation failed" }
    } finally { Pop-Location }

    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    Copy-Item -LiteralPath $nodeExe -Destination $output -Force
    & npx --yes postject@1.0.0-alpha.6 $output NODE_SEA_BLOB "$work\broker.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
    if ($LASTEXITCODE -ne 0) { throw "postject SEA injection failed" }
} finally {
    Pop-Location
}

Write-Host "Broker sidecar built: $output"
