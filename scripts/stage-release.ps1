[CmdletBinding()]
param(
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo "out\release" }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$exe = Join-Path $repo "guest\dist\WIN98CTL.EXE"
if (-not (Test-Path -LiteralPath $exe)) {
    throw "Missing $exe. Run scripts\build-guest.ps1 first."
}

$bundle = Join-Path $output "windows98-mcp-guest"
if (Test-Path -LiteralPath $bundle) {
    Remove-Item -LiteralPath $bundle -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $bundle | Out-Null

Copy-Item -LiteralPath $exe -Destination (Join-Path $bundle "WIN98CTL.EXE")
Copy-Item -LiteralPath (Join-Path $repo "guest\WIN98CTL.INI") -Destination (Join-Path $bundle "WIN98CTL.INI")
Copy-Item -LiteralPath (Join-Path $repo "guest\RUNTEST.BAT") -Destination (Join-Path $bundle "RUNTEST.BAT")
Copy-Item -LiteralPath (Join-Path $repo "guest\INSTALL.BAT") -Destination (Join-Path $bundle "INSTALL.BAT")
Copy-Item -LiteralPath (Join-Path $repo "guest\RELEASE.TXT") -Destination (Join-Path $bundle "README.TXT")
Copy-Item -LiteralPath (Join-Path $repo "guest\COMPATIBILITY.TXT") -Destination (Join-Path $bundle "COMPATIBILITY.TXT")

$checksums = Get-ChildItem -LiteralPath $bundle -File |
    Sort-Object Name |
    ForEach-Object {
        "{0} *{1}" -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(), $_.Name
    }
[IO.File]::WriteAllLines(
    (Join-Path $bundle "SHA256.TXT"),
    $checksums,
    [Text.Encoding]::ASCII
)

$archive = Join-Path $output "windows98-mcp-guest.zip"
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
Compress-Archive -Path (Join-Path $bundle "*") -DestinationPath $archive -CompressionLevel Optimal
$archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
"$archiveHash *windows98-mcp-guest.zip" |
    Set-Content -LiteralPath (Join-Path $output "windows98-mcp-guest.zip.sha256") -Encoding ASCII

Write-Host "Release guest bundle staged at $archive"
Write-Host "Edit WIN98CTL.INI directly before copying this unauthenticated guest package to an isolated VM network."
