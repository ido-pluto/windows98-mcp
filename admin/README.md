# Windows 98 MCP Admin

This Tauri desktop companion is released for Windows x64, Windows ARM64, and macOS Apple Silicon. The VM guest listener defaults to `9898`; the broker's TCP control endpoint for MCP and admin clients defaults to `9899`. The Connection panel defaults to `127.0.0.1:9899` but can connect to any reachable broker host/IP and port, including a Tailscale address.

Choose the archive that matches the **host** computer: `windows-x64` is for ordinary Intel/AMD Windows PCs, `windows-arm64` is only for ARM Windows PCs, and `macos-arm64` is for Apple Silicon Macs. Windows needs the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) used by Tauri. The macOS archive is ad-hoc signed, not Developer-ID notarized; if Gatekeeper blocks its first launch after extraction, move the app to Applications and run `xattr -dr com.apple.quarantine "/Applications/Windows 98 MCP Admin.app"`, then open it normally.

It starts the bundled Node broker sidecar, waits up to five seconds for the Windows 98 guest (which always dials the host), shows status/capabilities, displays a Win98 message box, streams a command, transfers files/directories, and previews/saves screenshots through native Windows dialogs.

If the VM is powered off, the broker and connected MCP tools remain alive. VM
operations return retryable `VM_OFFLINE` until the guest reconnects; no Codex
or MCP restart is required.

Files selected in the desktop app always belong to the computer running that
app. This remains true when the app connects directly to a broker on another
machine: the bundled client sidecar transfers them over the TCP control
connection using 64 KiB CRC32 chunks, SHA-256 validation, progress reporting,
and resumable partial files. No proxy is required for a Mac admin app to move
files to or from a Windows-hosted broker.

## Agent sessions and locking

The **Connected agents** panel lists each MCP/admin control connection. Use
**Disconnect** to close another session; when that session owns the exclusive
lease, the broker performs the normal guest cleanup and releases the VM before
another agent can acquire it.

**Exclusive lock agents** is off by default. The broker accepts several clients
and sends their guest operations through a FIFO queue, so concurrent MCP/admin
work does not race the Windows 98 protocol. This does not create separate mice
or keyboards: simultaneous UI input can still collide. Enable the checkbox
when one agent must own all VM work; that opt-in mode provides `VM_BUSY` FIFO
tickets and `vm_wait` lease coordination.

## Upstream proxy

The Connection panel can enable an outbound proxy to a normal broker running
on another machine. Enter that machine's IP and its normal guest listener port
(default `9898`). The local broker keeps the VM connection, dials the remote
broker every two seconds, and transparently forwards the existing guest
protocol. The remote machine then uses its ordinary local admin app or
`npx windows98-mcp` MCP adapter. No extra proxy listener is opened locally.
While this mode is active, VM controls in the local admin app are disabled to
avoid competing with the remote broker.

## Guest setup

Edit the shipped `WIN98CTL.INI` directly:

```ini
# QEMU user networking: stable when the disk moves to another host.
host=10.0.2.2
port=9898
```

Start `WIN98CTL.EXE`; it retries every two seconds. The same x86 executable supports Windows 98 SE through Windows 10 (including WOW64). Set the same port in the admin app. The host never dials the guest.

For VMware, bridged networks, and physical Windows installations, replace
`10.0.2.2` with the broker computer's reachable IPv4 address. `127.0.0.1`
inside the guest is the guest itself, not the QEMU host. SMB/SMB1 and shared
folder setup are not used or required.

## Build and portable release

Prerequisites are Node 22+, Rust stable, and the Tauri 2 prerequisites for the native release platform.

```powershell
Set-Location admin
npm install
npm run tauri:build
```

Before a release, build the Node SEA sidecar as `src-tauri/resources/broker-sidecar/windows98-mcp-broker.exe`. It accepts `broker --port <guest-port> --adapter-port <control-port>`. Create the unsigned portable x64 ZIP with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-portable.ps1 -Version 0.1.0
```

This writes `out\windows98-mcp-admin-<version>-windows-x64.zip` and a SHA-256 file. The release workflow also creates Windows ARM64 and macOS Apple Silicon ZIPs. The ZIP contains the native admin app, its matching native broker sidecar, and `README.TXT`; it does not create an installer. macOS release bundles are ad-hoc signed so their integrity is valid after packaging, but they are not Developer-ID notarized.

For development, set `WIN98_MCP_BROKER_SIDECAR` to the sidecar EXE before `npm run tauri:dev`.

## Local broker endpoint contract

The v2 broker receives newline JSON with `kind`, `id`, `sessionId`, `sessionLabel`, `method`, and `params`, and responds with the matching `id`, `ok`, and `result` or `error`. There is no hello secret or local authentication. The app calls `vm_status`, `show_message`, shell, transfer, and `screen_capture` methods.

The root host implements this unauthenticated v2 contract and `show_message`.
The admin app is deliberately excluded from the npm package.
