# windows98-mcp

[![CI](https://github.com/ido-pluto/windows98-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ido-pluto/windows98-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/windows98-mcp)](https://www.npmjs.com/package/windows98-mcp)
[![license](https://img.shields.io/npm/l/windows98-mcp)](./LICENSE)

Control a real Windows 98 VM or Windows 10 machine through explicit Model Context Protocol (MCP)
tools. Agents can capture screens, use exact mouse and keyboard input, run and
stream commands, manage windows and processes, use the clipboard, and transfer
files and directories without ordinary Computer Use.

**[Download the Windows 98 guest](https://github.com/ido-pluto/windows98-mcp/releases/latest/download/windows98-mcp-guest.zip)** ·
**[Windows x64 admin](https://github.com/ido-pluto/windows98-mcp/releases/latest/download/windows98-mcp-admin-windows-x64.zip)** ·
**[Windows ARM64 admin](https://github.com/ido-pluto/windows98-mcp/releases/latest/download/windows98-mcp-admin-windows-arm64.zip)** ·
**[macOS Apple Silicon admin](https://github.com/ido-pluto/windows98-mcp/releases/latest/download/windows98-mcp-admin-macos-arm64.zip)** ·
[All releases](https://github.com/ido-pluto/windows98-mcp/releases/latest) ·
[npm package](https://www.npmjs.com/package/windows98-mcp)

Download the admin archive for the **host** computer: Windows x64 is Intel/AMD,
Windows ARM64 is only for ARM Windows PCs, and macOS ARM64 is for Apple Silicon
Macs. Windows needs the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). The macOS portable app is ad-hoc signed rather than Developer-ID notarized; if Gatekeeper blocks its first launch, move it to Applications and run `xattr -dr com.apple.quarantine "/Applications/Windows 98 MCP Admin.app"`.

## How it works

`WIN98CTL.EXE` is a C89 x86 guest agent that runs on Windows 98 SE through
Windows 10 (x86 or WOW64). It opens and maintains an
outbound TCP connection to a singleton broker on the host. MCP clients and the
Windows admin app both use the same broker through a local endpoint selected by
port, so the exclusive lease prevents control collisions. The default port
uses the shared endpoint; other ports are isolated broker instances.

The transport intentionally has **no authentication or authorization**. Keep
it only on an isolated disposable VM network. The framing, sequence numbers,
CRC32, and SHA-256 values remain to detect corrupted or malformed data; they
do not provide security.

## Quick start

1. Download and extract the guest ZIP on the host.
2. Edit `WIN98CTL.INI` directly. Set `host` to the host-only adapter IPv4
   address visible from Windows 98 and choose a TCP `port` (default `9898`).
3. Copy the complete folder to `C:\WIN98CTL` on Windows 98 or Windows 10. Run `RUNTEST.BAT`,
   then start `WIN98CTL.EXE` and leave its small status window open.
4. Download and run the Windows admin app. Set the same port in its connection
   panel. It starts the broker and shows guest status.
5. Configure Codex to run the published MCP:

   ```toml
   [mcp_servers.win98]
   command = "npx"
   args = ["-y", "windows98-mcp@latest"]
   startup_timeout_sec = 20
   tool_timeout_sec = 1860
   required = false
   ```

The guest retries its outbound connection every two seconds. Guest-dependent
MCP calls wait up to five seconds for it to reconnect, then return
`GUEST_CONNECT_TIMEOUT`. Status and capability calls return immediately.

The verified development host-only setup uses host `192.168.60.1` and guest
`192.168.60.128`; edit the guest INI for your own adapter address.

## Windows admin app

The portable Windows x64/ARM64 and macOS Apple Silicon Tauri app is a small
operator/test console for the same broker used by MCP. It provides:

- Guest connection status and capabilities.
- A Windows 98 message popup.
- Streaming command output with terminate/close controls.
- File and directory push/pull with progress.
- Screenshot preview and native save.

Changing its port restarts that app's local broker after active terminal and
transfer work is closed. The default port (`9898`) uses the shared MCP broker
endpoint. Every non-default port gets its own local broker endpoint, so two
admin windows can control two guests concurrently: assign each guest a distinct
port in its INI, then set each admin window to its matching port. For headless
MCP access to a non-default guest, use `npx windows98-mcp --port <port>`.

## CLI

```text
windows98-mcp [command] [options]

broker              Run the long-lived singleton broker
stdio               Run the stdio MCP adapter (the default)
doctor              Check the broker, guest, and capabilities
simulator           Run the deterministic simulated Windows 98 guest
smoke-test          Exercise a connected guest inside C:\MCPTEST
diagnostics [dir]   Collect sanitized diagnostics

--port <port>       Override the runtime listener port (default: 9898)
--state-dir <dir>   Override local broker state storage
```

The Tauri app normally owns the port setting. `--port` is available for
headless use and must match `WIN98CTL.INI`; it also selects the matching
port-scoped local broker endpoint.

## MCP tools

The tool groups are:

- Lease and status: `vm_status`, `vm_capabilities`, `vm_lock`, `vm_wait`,
  `vm_unlock`.
- Screen and input: screenshot, mouse, keyboard, and input batch tools.
- Desktop: clipboard and window control.
- Commands: one-shot shell execution and cursor-based interactive terminals.
- Message: `show_message` displays a Windows 98 popup.
- System and files: processes, filesystem primitives, resumable file transfer,
  and merging directory transfer.

The first VM-affecting tool atomically acquires the lease. Every operational
result reminds callers to release it with `vm_unlock`. Inactive leases expire
after 30 minutes; disconnect cleanup releases held keys, buttons, terminals,
and transfers.

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate

# Build the real Windows 98 guest with pinned Open Watcom 1.9
powershell -File scripts/bootstrap-openwatcom.ps1 -Install
powershell -File scripts/build-guest.ps1 -Clean
powershell -File scripts/stage-release.ps1
```

The guest build audits the PE32 GUI subsystem and permits imports only from
Windows 98 system DLLs. The admin app has its own Tauri build instructions in
`admin/README.md`.

## Limitations

Windows 98 has no ConPTY, so terminals use redirected pipes rather than a true
full-screen console. DOS/TUI screens, boot failures, BSODs, kernel hangs, and
exclusive graphics surfaces remain outside the guest agent. File transfers are
limited to 2 GiB minus one byte, and unrepresentable ANSI/keyboard characters
are rejected instead of silently substituted.

## License

[MIT](./LICENSE)
