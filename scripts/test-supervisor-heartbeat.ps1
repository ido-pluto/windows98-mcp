param(
    [Parameter(Mandatory = $true)]
    [string]$ProbeDirectory
)

$ErrorActionPreference = "Stop"
$probe = [IO.Path]::GetFullPath($ProbeDirectory)
$supervisorPath = Join-Path $probe "WIN98SUP.EXE"
$agentPath = Join-Path $probe "WIN98CTL.EXE"
$logPath = Join-Path $probe "MCPSUPERVISOR.LOG"
$statePath = Join-Path $probe "MCPSUPERVISOR.TXT"
$heartbeatPath = Join-Path $probe "MCPHEARTBEAT.TXT"

foreach ($path in @($logPath, $statePath, $heartbeatPath)) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

$supervisor = Start-Process -FilePath $supervisorPath -ArgumentList "--heartbeat-test" -WorkingDirectory $probe -WindowStyle Hidden -PassThru
try {
    $deadline = (Get-Date).AddSeconds(20)
    do {
        $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
        $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw } else { "" }
        $heartbeat = if (Test-Path -LiteralPath $heartbeatPath) { Get-Content -LiteralPath $heartbeatPath -Raw } else { "" }
        $passed = $log -match "heartbeat stale for child pid" -and
            $log -match "restart delay elapsed; starting WIN98CTL" -and
            $state -match "lastRestartReason=heartbeat_stale" -and
            $heartbeat -match "sequence=[1-9]"
        if ($passed) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    if (-not $passed) {
        throw "Heartbeat watchdog test did not terminate the stale child and restart a healthy child within 20 seconds."
    }
    Get-Content -LiteralPath $logPath
    Get-Content -LiteralPath $statePath
} finally {
    if ($supervisor -and -not $supervisor.HasExited) {
        Stop-Process -Id $supervisor.Id -Force
    }
    Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $agentPath
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
