[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$HostAddress,
    [string]$GuestAddress,
    [int]$Port = 9898,
    [string]$GuestId = "win98-vm",
    [string]$PskHex,
    [switch]$SkipBuild,
    [string]$WatcomRoot,
    [string]$WorkspaceRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
$hostConfigDirectory = Join-Path $workspace ".win98-mcp"
$hostConfigPath = Join-Path $hostConfigDirectory "config.json"
if (-not $PskHex) {
    if (Test-Path -LiteralPath $hostConfigPath) {
        $existing = Get-Content -Raw -LiteralPath $hostConfigPath | ConvertFrom-Json
        if ($existing.psk -match '^hex:([0-9a-fA-F]{64})$') {
            $PskHex = $Matches[1]
            Write-Host "Reusing the existing host PSK so restaging does not invalidate the current guest."
        }
    }
    if (-not $PskHex) {
        $random = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($random) } finally { $rng.Dispose() }
        $PskHex = -join ($random | ForEach-Object { $_.ToString("x2") })
        Write-Host "Generated one new PSK for both the guest package and host configuration."
    }
}
if ($PskHex -notmatch '^[0-9a-fA-F]{64}$') { throw "PskHex must contain exactly 64 hexadecimal characters." }
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535." }

if (-not $SkipBuild) {
    $args = @{}
    if ($WatcomRoot) { $args.WatcomRoot = $WatcomRoot }
    & (Join-Path $PSScriptRoot "build-guest.ps1") @args
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
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}
foreach ($name in @("RUNTEST.BAT","INSTALL.BAT","README.TXT")) {
    Write-AsciiCrlf (Join-Path $repo "guest\$name") (Join-Path $stage $name)
}
$ini = @"
[connection]
host=$HostAddress
port=$Port

[identity]
guest_id=$GuestId

[security]
psk_hex=$($PskHex.ToLowerInvariant())
"@
$ini = ($ini -replace "`r?`n", "`r`n")
if (-not $ini.EndsWith("`r`n")) { $ini += "`r`n" }
[IO.File]::WriteAllText((Join-Path $stage "WIN98CTL.INI"), $ini, [Text.Encoding]::ASCII)

$checksumLines = Get-ChildItem -LiteralPath $stage -File |
    Where-Object Name -ne "SHA256.TXT" |
    Sort-Object Name |
    ForEach-Object { "{0} *{1}" -f (Get-Sha256Hex $_.FullName), $_.Name }
[IO.File]::WriteAllLines((Join-Path $stage "SHA256.TXT"), $checksumLines, [Text.Encoding]::ASCII)

New-Item -ItemType Directory -Force -Path $hostConfigDirectory | Out-Null
$hostConfig = [ordered]@{
    bindHost = $HostAddress
    guestPort = $Port
    psk = "hex:$($PskHex.ToLowerInvariant())"
    stateDir = (Join-Path $hostConfigDirectory "state")
    hostAllowedRoots = @($workspace)
}
if ($GuestAddress) { $hostConfig["expectedGuestIp"] = $GuestAddress }
[IO.File]::WriteAllText(
    $hostConfigPath,
    ($hostConfig | ConvertTo-Json -Depth 4),
    (New-Object Text.UTF8Encoding($false))
)

Write-Host "VM drop staged at $stage"
Write-Host "Host broker config written to $hostConfigPath (ignored by Git)."
Write-Warning "out\vm-drop contains the plaintext PSK. Do not share or commit this folder."
Write-Host "Copy required: complete out\vm-drop package (EXE and INI were staged together)."
Write-Host "Copy the folder to Windows 98 and run RUNTEST.BAT."
