[CmdletBinding()]
param(
    [string]$Destination,
    [string]$InstallerPath,
    [switch]$Install
)

$arguments = @{ Install = $Install }
if ($Destination) { $arguments.Destination = $Destination }
if ($InstallerPath) { $arguments.InstallerPath = $InstallerPath }
& (Join-Path $PSScriptRoot "bootstrap-openwatcom.ps1") @arguments
if ($LASTEXITCODE) { exit $LASTEXITCODE }
