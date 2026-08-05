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
$crashPath = Join-Path $probe "MCPCRASH.LOG"
$agentLogPath = Join-Path $probe "MCPAGENT.LOG"

function Clear-WatchdogArtifacts {
    foreach ($path in @($logPath, $statePath, $heartbeatPath, $crashPath, $agentLogPath)) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ProbeProcesses {
    param($Supervisor)
    if ($Supervisor -and -not $Supervisor.HasExited) {
        Stop-Process -Id $Supervisor.Id -Force
    }
    Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $agentPath
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-WatchdogTest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Arguments,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Condition,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    Clear-WatchdogArtifacts
    $supervisor = Start-Process -FilePath $supervisorPath -ArgumentList $Arguments -WorkingDirectory $probe -WindowStyle Hidden -PassThru
    try {
        $deadline = (Get-Date).AddSeconds(24)
        do {
            $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
            $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw } else { "" }
            $heartbeat = if (Test-Path -LiteralPath $heartbeatPath) { Get-Content -LiteralPath $heartbeatPath -Raw } else { "" }
            $crash = if (Test-Path -LiteralPath $crashPath) { Get-Content -LiteralPath $crashPath -Raw } else { "" }
            $agentLog = if (Test-Path -LiteralPath $agentLogPath) { Get-Content -LiteralPath $agentLogPath -Raw } else { "" }
            $passed = & $Condition $log $state $heartbeat $crash $agentLog
            if ($passed) { break }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)

        if (-not $passed) { throw $FailureMessage }
        Get-Content -LiteralPath $logPath
        Get-Content -LiteralPath $statePath
    } finally {
        Stop-ProbeProcesses $supervisor
    }
}

# Baseline: a child that never writes a heartbeat must be terminated and
# replaced with a healthy child.
Invoke-WatchdogTest -Arguments "--heartbeat-test" -FailureMessage "Heartbeat watchdog test did not terminate the stale child and restart a healthy child within 24 seconds." -Condition {
    param($log, $state, $heartbeat, $crash, $agentLog)
    $log -match "heartbeat stale for child pid" -and
        $log -match "restart delay elapsed; starting WIN98CTL" -and
        $state -match "lastRestartReason=heartbeat_stale" -and
        $heartbeat -match "sequence=[1-9]"
}

# Regression for the Win98 illegal-operation-dialog state: the first child
# intentionally remains alive after it signals the shared fault event.  Its
# heartbeat must stop and the supervisor must terminate that owned child.
Invoke-WatchdogTest -Arguments "--fault-signal-test" -FailureMessage "Fault-signalled watchdog test did not terminate the still-running child and restart a healthy child within 24 seconds." -Condition {
    param($log, $state, $heartbeat, $crash, $agentLog)
    $agentLog -match "fault signal test requested" -and
        $log -match "heartbeat stale for child pid" -and
        $log -match "restart delay elapsed; starting WIN98CTL" -and
        $state -match "lastRestartReason=heartbeat_stale" -and
        $heartbeat -match "sequence=[1-9]"
}

# Regression: the first child starts a heartbeat then faults in a separate
# worker. Its unhandled-exception filter must stop the heartbeat before the
# supervisor launches a healthy replacement child.
Invoke-WatchdogTest -Arguments "--fault-test" -FailureMessage "Fault watchdog test did not record the worker fault and restart a healthy child within 24 seconds." -Condition {
    param($log, $state, $heartbeat, $crash, $agentLog)
    $crash -match "faultSignaled=true" -and
        $crash -match "pid=[1-9]" -and
        $agentLog -match "local heartbeat started" -and
        $log -match "restart delay elapsed; starting WIN98CTL" -and
        $heartbeat -match "sequence=[1-9]"
}
