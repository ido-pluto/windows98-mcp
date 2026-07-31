[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$HostAddress,
    [int]$Port = 9898,
    [switch]$SkipBuild,
    [string]$WatcomRoot,
    [string]$WorkspaceRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535." }

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
if (-not $SkipBuild) {
    $buildArgs = @{}
    if ($WatcomRoot) { $buildArgs.WatcomRoot = $WatcomRoot }
    & (Join-Path $PSScriptRoot "build-guest.ps1") @buildArgs
}

$exe = Join-Path $repo "guest\dist\WIN98CTL.EXE"
if (-not (Test-Path -LiteralPath $exe)) { throw "Missing $exe. Build the guest first." }

$stage = Join-Path $workspace "out\vm-drop"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -Force -LiteralPath $exe -Destination (Join-Path $stage "WIN98CTL.EXE")

function Write-AsciiCrlf([string]$Source, [string]$Destination) {
    $text = [IO.File]::ReadAllText($Source)
    $text = $text -replace "`r?`n", "`r`n"
    if (-not $text.EndsWith("`r`n")) { $text += "`r`n" }
    [IO.File]::WriteAllText($Destination, $text, [Text.Encoding]::ASCII)
}

function Get-Sha256Hex([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

foreach ($name in @("RUNTEST.BAT", "INSTALL.BAT", "README.TXT", "COMPATIBILITY.TXT")) {
    Write-AsciiCrlf (Join-Path $repo "guest\$name") (Join-Path $stage $name)
}

$ini = "[connection]`r`nhost=$HostAddress`r`nport=$Port`r`n"
[IO.File]::WriteAllText((Join-Path $stage "WIN98CTL.INI"), $ini, [Text.Encoding]::ASCII)

$checksumLines = Get-ChildItem -LiteralPath $stage -File |
    Where-Object Name -ne "SHA256.TXT" |
    Sort-Object Name |
    ForEach-Object { "{0} *{1}" -f (Get-Sha256Hex $_.FullName), $_.Name }
[IO.File]::WriteAllLines((Join-Path $stage "SHA256.TXT"), $checksumLines, [Text.Encoding]::ASCII)

Write-Host "VM drop staged at $stage"
Write-Host "Copy required: complete out\\vm-drop package (EXE and INI were staged together)."
Write-Host "The only required edit is WIN98CTL.INI: host=$HostAddress and port=$Port."
Write-Host "Copy the folder to Windows 98 and run RUNTEST.BAT."
