[CmdletBinding()]
param(
    [string]$WatcomRoot = $env:WATCOM,
    [switch]$Clean,
    [switch]$AllowUnverifiedToolchain
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$guest = Join-Path $repo "guest"
if (-not $WatcomRoot) {
    $candidates = @(
        (Join-Path $repo ".toolchains\WATCOM19"),
        (Join-Path $repo ".toolchains\WATCOM"),
        "C:\WATCOM"
    )
    $WatcomRoot = $candidates | Where-Object {
        (Test-Path (Join-Path $_ "owsetenv.bat")) -or
        (Test-Path (Join-Path $_ "binnt64\wcc386.exe")) -or
        (Test-Path (Join-Path $_ "binnt\wcc386.exe"))
    } | Select-Object -First 1
}
if (-not $WatcomRoot) {
    throw "Open Watcom was not found. Run scripts\bootstrap-openwatcom.ps1 -Install or pass -WatcomRoot."
}
$WatcomRoot = [IO.Path]::GetFullPath($WatcomRoot)

$compiler = @(
    (Join-Path $WatcomRoot "binnt64\wcc386.exe"),
    (Join-Path $WatcomRoot "binnt\wcc386.exe")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) {
    throw "wcc386.exe was not found beneath $WatcomRoot."
}
$compilerVersion = (& $compiler 2>&1 | Select-Object -First 1 | Out-String).Trim()
if (-not $AllowUnverifiedToolchain -and $compilerVersion -notmatch "Version 1\.9") {
    throw "The Windows 98 build requires pinned Open Watcom 1.9. Found: $compilerVersion. Pass -AllowUnverifiedToolchain only for diagnostics."
}

$action = if ($Clean) { "clean all" } else { "all" }
$setupBatch = Join-Path $WatcomRoot "owsetenv.bat"
if (Test-Path -LiteralPath $setupBatch) {
    $command = 'call "{0}" >NUL && cd /d "{1}" && wmake -f Makefile {2}' -f $setupBatch, $guest, $action
} else {
    $command = 'set "WATCOM={0}" && set "PATH={0}\BINNT64;{0}\BINNT;%PATH%" && set "EDPATH={0}\EDDAT" && set "INCLUDE={0}\H;{0}\H\NT" && cd /d "{1}" && wmake -f Makefile {2}' -f $WatcomRoot, $guest, $action
}
& $env:ComSpec /d /c $command
if ($LASTEXITCODE -ne 0) { throw "Open Watcom build failed with exit code $LASTEXITCODE." }

$exe = Join-Path $guest "dist\WIN98CTL.EXE"
if (-not (Test-Path -LiteralPath $exe)) { throw "Build completed without producing $exe." }

# Open Watcom 1.9 writes zero as .reloc's VirtualSize while publishing a
# nonzero base-relocation data directory. Older Windows loaders tolerate this
# inconsistently, and strict PE parsers reject it. Normalize the section header
# to the actual directory size without changing the relocation data.
$bytes = [IO.File]::ReadAllBytes($exe)
if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw "Output is not a valid MZ/PE executable." }
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
if ([Text.Encoding]::ASCII.GetString($bytes, $peOffset, 4) -ne "PE`0`0") { throw "Output has no PE signature." }
$optional = $peOffset + 24
$optionalSize = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
$sectionCount = [BitConverter]::ToUInt16($bytes, $peOffset + 6)
$relocationSize = [BitConverter]::ToUInt32($bytes, $optional + 96 + (5 * 8) + 4)
$sectionTable = $optional + $optionalSize
$relocationFound = $false
for ($index = 0; $index -lt $sectionCount; ++$index) {
    $section = $sectionTable + ($index * 40)
    $sectionName = [Text.Encoding]::ASCII.GetString($bytes, $section, 8).Trim([char]0)
    if ($sectionName -eq ".reloc") {
        $relocationFound = $true
        $virtualSize = [BitConverter]::ToUInt32($bytes, $section + 8)
        if ($virtualSize -eq 0 -and $relocationSize -gt 0) {
            [BitConverter]::GetBytes($relocationSize).CopyTo($bytes, $section + 8)
            [IO.File]::WriteAllBytes($exe, $bytes)
        }
    }
}
if (-not $relocationFound -or $relocationSize -eq 0) {
    throw "Output has no usable base-relocation directory."
}

$subsystem = [BitConverter]::ToUInt16($bytes, $optional + 68)
if ($subsystem -ne 2) { throw "Expected Windows GUI subsystem (2), found $subsystem." }
$ascii = [Text.Encoding]::ASCII.GetString($bytes)
foreach ($forbidden in @("MSVCR70.DLL","MSVCR80.DLL","MSVCR90.DLL","UCRTBASE.DLL","SendInput")) {
    if ($ascii.IndexOf($forbidden, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "PE compatibility audit found forbidden dependency/API: $forbidden"
    }
}

$wdump = @(
    (Join-Path $WatcomRoot "binnt64\wdump.exe"),
    (Join-Path $WatcomRoot "binnt\wdump.exe")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $wdump) { throw "Open Watcom wdump.exe is required for the PE import audit." }
$dump = (& $wdump $exe 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "wdump failed while auditing $exe." }
$imports = [regex]::Matches($dump, 'DLL name\s*=\s*<([^>]+)>') |
    ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() } |
    Sort-Object -Unique
$allowedImports = @("ADVAPI32.DLL","GDI32.DLL","KERNEL32.DLL","USER32.DLL","WS2_32.DLL")
$unexpected = $imports | Where-Object { $_ -notin $allowedImports }
if ($unexpected) { throw "PE compatibility audit found unexpected DLL imports: $($unexpected -join ', ')" }
if ($imports.Count -eq 0) { throw "PE compatibility audit found no import table." }
if ("WS2_32.DLL" -notin $imports) { throw "Expected the Windows 98 guest to import Winsock 2 from WS2_32.DLL." }
if ($dump -notmatch 'subsystem major version number\s*=\s*0004H') {
    throw "Expected PE subsystem version 4.0 for the Windows 95/98 target."
}

Write-Host "Built $exe"
Write-Host "SHA-256 $((Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash)"
Write-Host "Compiler $compilerVersion"
Write-Host "Imported DLL allowlist passed: $($imports -join ', ')"
Write-Host "Copy required for a VM already using an older build: WIN98CTL.EXE (or restage and copy the complete package)."
