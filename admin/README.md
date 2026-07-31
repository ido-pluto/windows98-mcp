# Windows 98 MCP Admin

This Windows x64 Tauri desktop companion shares the fixed local broker pipe `\\.\pipe\win98-mcp`. It persists only the chosen port (default `9898`) in the shared host runtime file `%LOCALAPPDATA%\win98-mcp\runtime.json`, so the npm MCP adapter and the app always select the same listener.

It starts the bundled Node broker sidecar, waits up to five seconds for the Windows 98 guest (which always dials the host), shows status/capabilities, displays a Win98 message box, streams a command, transfers files/directories, and previews/saves screenshots through native Windows dialogs.

## Guest setup

Edit the shipped `WIN98CTL.INI` directly:

```ini
host=192.168.60.1
port=9898
```

Start `WIN98CTL.EXE`; it retries every two seconds. Set the same port in the admin app. The host never dials the guest.

## Build and portable release

Prerequisites are Node 22+, Rust stable with MSVC, and the Tauri 2 Windows prerequisites.

```powershell
Set-Location admin
npm install
npm run tauri:build
```

Before a release, build the Node SEA sidecar as `src-tauri/resources/broker-sidecar/windows98-mcp-broker.exe`. It must accept `broker --port <port> --pipe \\.\pipe\win98-mcp`. Create the unsigned portable x64 ZIP with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-portable.ps1 -Version 0.1.0
```

This writes `out\windows98-mcp-admin-<version>-windows-x64.zip` and a SHA-256 file. The ZIP contains the admin EXE, `broker-sidecar\windows98-mcp-broker.exe`, and `README.TXT`; it does not create an installer or require signing.

For development, set `WIN98_MCP_BROKER_SIDECAR` to the sidecar EXE before `npm run tauri:dev`.

## Fixed pipe contract

The v2 broker receives newline JSON with `kind`, `id`, `sessionId`, `sessionLabel`, `method`, and `params`, and responds with the matching `id`, `ok`, and `result` or `error`. There is no hello secret or local authentication. The app calls `vm_status`, `show_message`, shell, transfer, and `screen_capture` methods.

The root host implements this unauthenticated v2 contract and `show_message`.
The admin app is deliberately excluded from the npm package.
