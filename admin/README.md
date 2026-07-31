# Windows 98 MCP Admin

This Tauri desktop companion is released for Windows x64, Windows ARM64, and macOS Apple Silicon. The default listener port (`9898`) shares the MCP broker endpoint (`\\.\pipe\win98-mcp` on Windows; `/tmp/win98-mcp.sock` on macOS). Non-default ports use a matching port-scoped local endpoint, so separate admin windows can run safely against separate guests.

Choose the archive that matches the **host** computer: `windows-x64` is for ordinary Intel/AMD Windows PCs, `windows-arm64` is only for ARM Windows PCs, and `macos-arm64` is for Apple Silicon Macs. Windows needs the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) used by Tauri. The macOS archive is ad-hoc signed, not Developer-ID notarized; if Gatekeeper blocks its first launch after extraction, move the app to Applications and run `xattr -dr com.apple.quarantine "/Applications/Windows 98 MCP Admin.app"`, then open it normally.

It starts the bundled Node broker sidecar, waits up to five seconds for the Windows 98 guest (which always dials the host), shows status/capabilities, displays a Win98 message box, streams a command, transfers files/directories, and previews/saves screenshots through native Windows dialogs.

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
host=192.168.60.1
port=9898
```

Start `WIN98CTL.EXE`; it retries every two seconds. The same x86 executable supports Windows 98 SE through Windows 10 (including WOW64). Set the same port in the admin app. The host never dials the guest.

## Build and portable release

Prerequisites are Node 22+, Rust stable, and the Tauri 2 prerequisites for the native release platform.

```powershell
Set-Location admin
npm install
npm run tauri:build
```

Before a release, build the Node SEA sidecar as `src-tauri/resources/broker-sidecar/windows98-mcp-broker.exe`. It accepts `broker --port <port>` and derives the default shared or port-scoped local endpoint automatically. Create the unsigned portable x64 ZIP with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-portable.ps1 -Version 0.1.0
```

This writes `out\windows98-mcp-admin-<version>-windows-x64.zip` and a SHA-256 file. The release workflow also creates Windows ARM64 and macOS Apple Silicon ZIPs. The ZIP contains the native admin app, its matching native broker sidecar, and `README.TXT`; it does not create an installer. macOS release bundles are ad-hoc signed so their integrity is valid after packaging, but they are not Developer-ID notarized.

For development, set `WIN98_MCP_BROKER_SIDECAR` to the sidecar EXE before `npm run tauri:dev`.

## Local broker endpoint contract

The v2 broker receives newline JSON with `kind`, `id`, `sessionId`, `sessionLabel`, `method`, and `params`, and responds with the matching `id`, `ok`, and `result` or `error`. There is no hello secret or local authentication. The app calls `vm_status`, `show_message`, shell, transfer, and `screen_capture` methods.

The root host implements this unauthenticated v2 contract and `show_message`.
The admin app is deliberately excluded from the npm package.
