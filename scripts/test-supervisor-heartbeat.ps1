param(
    [Parameter(Mandatory = $true)]
    [string]$ProbeDirectory
)

$ErrorActionPreference = "Stop"
$probe = [IO.Path]::GetFullPath($ProbeDirectory)
$agentSource = Join-Path $probe "WIN98CTL.EXE"
$supervisorSource = Join-Path $probe "WIN98SUP.EXE"
$iniSource = Join-Path $probe "WIN98CTL.INI"

function Stop-ScenarioProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AgentPath,
        $Supervisor
    )

    if ($Supervisor -and -not $Supervisor.HasExited) {
        Stop-Process -Id $Supervisor.Id -Force
        Wait-Process -Id $Supervisor.Id -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(5)
    do {
        $agents = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $AgentPath })
        foreach ($agent in $agents) {
            Stop-Process -Id $agent.ProcessId -Force -ErrorAction SilentlyContinue
        }
        if ($agents.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)

    throw "Probe WIN98CTL process did not exit: $AgentPath"
}

function Invoke-WatchdogTest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [AllowEmptyString()]
        [string]$Arguments,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Condition,
        [scriptblock]$Exercise,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    # A separate folder per scenario prevents the global agent mutex and logs
    # from a forcibly stopped predecessor affecting the next assertion.
    $scenario = Join-Path $probe $Name
    Remove-Item -LiteralPath $scenario -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $scenario | Out-Null
    $agentPath = Join-Path $scenario "WIN98CTL.EXE"
    $supervisorPath = Join-Path $scenario "WIN98SUP.EXE"
    $logPath = Join-Path $scenario "MCPSUPERVISOR.LOG"
    $statePath = Join-Path $scenario "MCPSUPERVISOR.TXT"
    $heartbeatPath = Join-Path $scenario "MCPHEARTBEAT.TXT"
    $crashPath = Join-Path $scenario "MCPCRASH.LOG"
    $agentLogPath = Join-Path $scenario "MCPAGENT.LOG"
    Copy-Item $agentSource, $supervisorSource, $iniSource -Destination $scenario

    $start = @{ FilePath = $supervisorPath; WorkingDirectory = $scenario; WindowStyle = "Hidden"; PassThru = $true }
    if ($Arguments) { $start.ArgumentList = $Arguments }
    $supervisor = Start-Process @start
    try {
        if ($Exercise) {
            & $Exercise $scenario $heartbeatPath
        }
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
        Stop-ScenarioProcesses -AgentPath $agentPath -Supervisor $supervisor
    }
}

# After startup grace has elapsed, expose an incomplete heartbeat file long
# enough for several supervisor polls.  The agent is healthy and will replace
# it on its normal two-second schedule, so a restart here would prove the
# supervisor was treating a torn file read as a stale child.
Invoke-WatchdogTest -Name "partial-heartbeat" -Arguments "" -FailureMessage "Supervisor restarted a healthy child after an incomplete heartbeat-file read." -Exercise {
    param($scenario, $heartbeatPath)
    Start-Sleep -Seconds 9
    [IO.File]::WriteAllText($heartbeatPath, "pid=", [Text.Encoding]::ASCII)
    Start-Sleep -Milliseconds 800
} -Condition {
    param($log, $state, $heartbeat, $crash, $agentLog)
    $agentLog -match "local heartbeat started" -and
        $log -notmatch "heartbeat stale for child pid" -and
        $heartbeat -match "sequence=[1-9]"
}

# Baseline: a child that never writes a heartbeat must be terminated and
# replaced with a healthy child.
Invoke-WatchdogTest -Name "heartbeat-withheld" -Arguments "--heartbeat-test" -FailureMessage "Heartbeat watchdog test did not terminate the stale child and restart a healthy child within 24 seconds." -Condition {
    param($log, $state, $heartbeat, $crash, $agentLog)
    $log -match "heartbeat stale for child pid" -and
        $log -match "restart delay elapsed; starting WIN98CTL" -and
        $state -match "lastRestartReason=heartbeat_stale" -and
        $heartbeat -match "sequence=[1-9]"
}

# Regression for the Win98 illegal-operation-dialog state: the first child
# intentionally remains alive after it signals the shared fault event. Its
# heartbeat must stop and the supervisor must terminate that owned child.
Invoke-WatchdogTest -Name "fault-signalled" -Arguments "--fault-signal-test" -FailureMessage "Fault-signalled watchdog test did not terminate the still-running child and restart a healthy child within 24 seconds." -Condition {
    param($log, $state, $heartbeat, $crash, $agentLog)
    $agentLog -match "fault signal test requested" -and
        $log -match "heartbeat stale for child pid" -and
        $log -match "restart delay elapsed; starting WIN98CTL" -and
        $state -match "lastRestartReason=heartbeat_stale" -and
        $heartbeat -match "sequence=[1-9]"
}

# Regression: the first child starts a heartbeat then faults in a separate
# worker. Its unhandled-exception filter must record the fault and the
# supervisor must launch a healthy replacement child.
Invoke-WatchdogTest -Name "worker-fault" -Arguments "--fault-test" -FailureMessage "Fault watchdog test did not record the worker fault and restart a healthy child within 24 seconds." -Condition {
    param($log, $state, $heartbeat, $crash, $agentLog)
    $crash -match "faultSignaled=true" -and
        $crash -match "pid=[1-9]" -and
        $agentLog -match "local heartbeat started" -and
        $log -match "restart delay elapsed; starting WIN98CTL" -and
        $heartbeat -match "sequence=[1-9]"
}
