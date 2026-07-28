[CmdletBinding()]
param(
    [string]$Destination,
    [string]$InstallerPath,
    [switch]$Install
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $Destination) { $Destination = Join-Path $repo ".toolchains" }
$expectedSha256 = "040c910aba304fdb5f39b8fe508cd3c772b1da1f91a58179fa0895e0b2bf190b"
$assetName = "open-watcom-c-win32-1.9.exe"
$downloadUrl = "https://openwatcom.org/ftp/install/$assetName"

$Destination = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
if (-not $InstallerPath) {
    $InstallerPath = Join-Path $Destination $assetName
    if (-not (Test-Path -LiteralPath $InstallerPath)) {
        Write-Host "Downloading the pinned official Open Watcom 1.9 installer..."
        Invoke-WebRequest -Uri $downloadUrl -OutFile $InstallerPath
    }
}
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstallerPath).Hash.ToLowerInvariant()
if ($actual -ne $expectedSha256) {
    throw "Open Watcom installer hash mismatch. Expected $expectedSha256, got $actual."
}
Write-Host "Verified $InstallerPath"

if ($Install) {
    $watcomRoot = Join-Path $Destination "WATCOM19"
    $sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
    if (-not $sevenZip) {
        throw "7z.exe is required for the headless workspace-local install. Install 7-Zip or extract $InstallerPath into $watcomRoot."
    }
    New-Item -ItemType Directory -Force -Path $watcomRoot | Out-Null
    & $sevenZip.Source x $InstallerPath "-o$watcomRoot" -y | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Open Watcom extraction failed with code $LASTEXITCODE." }
    $setup = @"
@ECHO OFF
SET WATCOM=$watcomRoot
SET PATH=%WATCOM%\BINNT;%PATH%
SET EDPATH=%WATCOM%\EDDAT
SET INCLUDE=%WATCOM%\H;%WATCOM%\H\NT
"@
    [IO.File]::WriteAllText((Join-Path $watcomRoot "owsetenv.bat"), $setup, [Text.Encoding]::ASCII)
    Write-Host "Installed workspace-local Open Watcom at $watcomRoot"
}
