# windows98-mcp

[![CI](https://github.com/ido-pluto/windows98-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ido-pluto/windows98-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/windows98-mcp)](https://www.npmjs.com/package/windows98-mcp)
[![license](https://img.shields.io/npm/l/windows98-mcp)](./LICENSE)

Control a real Windows 98 VM or Windows 10 machine through explicit Model Context Protocol (MCP)
tools. Agents can capture screens, use exact mouse and keyboard input, run and
stream commands, manage windows and processes, use the clipboard, and transfer
files and directories without ordinary Computer Use.

The same broker can manage local QEMU VMs: create/import qcow2 machines,
control lifecycle and snapshots, inspect QMP, and capture/input the framebuffer
before the Windows controller starts.

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
port. Parallel operation is the default: the broker accepts several agents and
uses a FIFO queue to send one operation at a time to the single-threaded guest.
The default port uses the shared endpoint; other ports are isolated broker
instances.

The transport intentionally has **no authentication or authorization**. Keep
it only on an isolated disposable VM network. The framing, sequence numbers,
CRC32, and SHA-256 values remain to detect corrupted or malformed data; they
do not provide security.

## Quick start

1. Download and extract the guest ZIP on the host.
2. Edit `WIN98CTL.INI` directly. Set `host` to the host-only adapter IPv4
   address visible from Windows 98 and choose a TCP `port` (default `9898`).
3. Run `INSTALL.BAT` from the extracted folder or mounted ISO. It copies the
   package to `C:\WIN98MCP` and registers `WIN98SUP.EXE` for login. Restart
   Windows; the supervisor owns `WIN98CTL.EXE`. The agent writes a local,
PID-bound heartbeat every two seconds from a dedicated thread, and the
supervisor restarts its child only if that heartbeat is stale for eight seconds,
   and is the program installed to the current user's login Run key.
   Run `C:\WIN98MCP\UNINSTALL.BAT` to stop both processes and remove
   their current-user startup registration; it leaves logs and files in place.
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

The MCP stdio server remains available if the VM is powered off or its guest
agent disconnects. After a previously connected VM goes offline, guest tools
return retryable `VM_OFFLINE` results immediately; start the VM again and the
same Codex task resumes normal control when the guest reconnects. The adapter
also resumes short broker connection losses using its original session ID.
Interrupted tool calls are replayed automatically in order and may report
`recovery.replayed`; this is at-least-once behavior, so a lost acknowledgement
can duplicate a click, command, or write.

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

### Chained broker proxy

The admin app can proxy **upward** to another normal broker. The Windows VM
continues to connect to the local host, then the local broker connects outward
to the remote broker using that remote broker's ordinary guest port. No extra
proxy listener is opened locally:

```text
WIN98CTL.EXE -> local admin/broker -> remote admin/broker
```

Start the remote broker or remote admin app on its chosen port. In the local
admin app, enable **Proxy upward to remote broker**, enter the remote IP and
port, and Apply. The local broker retries every two seconds. Once proxied, use
MCP or the admin app on the remote machine for VM control; the local app keeps
the transparent bridge exclusive so it cannot issue competing guest frames.

## CLI

```text
windows98-mcp [command] [options]

broker              Run the long-lived singleton broker
stdio               Run the stdio MCP adapter (the default)
doctor              Check the broker, guest, and capabilities
simulator           Run the deterministic simulated Windows 98 guest
smoke-test          Exercise a connected guest inside C:\MCPTEST
diagnostics [dir]   Collect sanitized diagnostics

--port <port>       VM guest listener port (default: 9898)
--broker-host <ip>  Broker control host for MCP (default: 127.0.0.1)
--broker-port <port> Broker control port for MCP (default: 9899)
--upstream <ip:port> Relay the connected VM to an upstream normal broker
--state-dir <dir>   Override local broker state storage
```

`--port` must match `WIN98CTL.INI`. The broker exposes MCP/admin control on
TCP port `9899` by default; use `--broker-host` and `--broker-port` to attach
an MCP session to a broker on another host, for example over Tailscale.

When MCP uses a TCP broker endpoint, `file_push`, `file_pull`,
`directory_push`, and `directory_pull` operate on the filesystem of the
machine running `npx windows98-mcp`—for example, the Mac client—not on the
remote Windows broker. The transfer itself is sent through the broker-control
connection in 64 KiB CRC32-checked chunks, with SHA-256 verification and
resumable partial files.

### CLI control without MCP

Agents that only have terminal access can invoke the same operations directly:

```powershell
# Inspect all operations and their exact JSON parameter schemas.
npx windows98-mcp tools

# Run one self-contained operation. Output is one JSON result on stdout.
npx windows98-mcp call mouse_click --params '{"x":120,"y":80}'
npx windows98-mcp call screen_capture --params '{}' --image-out screen.png
```

For terminal sessions, held input, or a multi-step workflow, keep one session
open with JSON Lines:

```text
{"id":"1","method":"shell_start","params":{"command":"COMMAND.COM"}}
{"id":"2","method":"shell_write","params":{"session_id":"1","text":"dir\r\n"}}
{"id":"3","method":"shell_read","params":{"session_id":"1","after_cursor":0,"wait_ms":500}}
```

Pipe those lines into `npx windows98-mcp rpc`; each response has the same ID.
`call` cleans up its temporary session automatically, while `rpc` cleans up
when stdin closes. Files and directories use the CLI computer's filesystem,
even when its broker is remote.

### Managed QEMU VMs

Use `qemu_doctor` to check the QEMU executable, `qemu_vm_create` to import a
broker-local disk, and `qemu_vm_start` to run it. `--qemu-root` changes the
managed VM directory; `--qemu-binary` sets the default executable. Profiles
are `win98`, `winxp`, `win10`, and `generic`; per-VM binary paths, structured
device/network overrides, and extra arguments remain available through the
QEMU schemas shown by `npx windows98-mcp tools`.

Every built-in profile explicitly starts with
`kernel-irqchip=off,hpet=off,usb=off`. These compatibility flags are required
by our Windows 98 profile on Windows, Linux, and macOS: removing them can
cause a Windows 98 blue screen. The generated Windows 98 machine is
`-M pc,accel=<auto-plan>,hpet=off,kernel-irqchip=off,usb=off`.

`acceleration: "auto"` always includes emulation fallback: Windows x64 uses
`whpx:tcg`, Linux x64 uses `kvm:tcg`, Intel macOS uses `hvf:tcg`, and x86
guests on ARM hosts use `tcg`. QEMU tries the accelerators from left to right,
so a missing or unusable hardware accelerator falls back to TCG instead of
preventing a VM from starting. Use `qemu_doctor` to inspect the selected plan,
or set `acceleration` to `tcg`, `whpx`, `kvm`, `hvf`, or `auto` explicitly.

The `win98` profile is tuned for an unpatched Windows 98 SE guest: a Pentium
II CPU, one vCPU, 256 MiB RAM, i440fx chipset, Cirrus VGA, local-time RTC,
HPET disabled, IDE qcow2 disk, and an RTL8139 network adapter. Do not raise
memory above 512 MiB without applying the relevant Windows 98 VCache
workarounds.

`profile_overrides` replaces **any** named profile component, not only disk or
network. Give a component an ordered argument array to replace it, or `false`
to remove it. Built-in groups include `display`, `machine`, `memory`, `cpu`,
`audio`, `firmware`, `boot`, `devices`, `platform`, `disk`, and `network`; custom names are
also accepted and appended before broker-owned QMP setup.

```powershell
# Replace the Win98 profile's audio and display configuration, and add USB.
npx windows98-mcp call qemu_vm_update --params '{"vm_id":"win98","profile_overrides":{"audio":["-audiodev","sdl,id=snd0","-device","ac97,audiodev=snd0"],"display":["-display","sdl"],"usb":["-usb"]}}'
```

```powershell
npx windows98-mcp call qemu_doctor --params '{}'
npx windows98-mcp call qemu_vm_create --params '{"name":"Win98","disk_path":"C:\\VMs\\win98.qcow2","profile":"win98"}'
npx windows98-mcp call qemu_vm_start --params '{"vm_id":"win98"}'
npx windows98-mcp call qemu_screen_capture --params '{"vm_id":"win98"}' --image-out qemu.png
npx windows98-mcp call qemu_vm_force_stop --params '{"vm_id":"win98"}'
npx windows98-mcp call qemu_snapshot_create --params '{"vm_id":"win98","name":"clean-install"}'
```

`qemu_screen_capture`, `qemu_keyboard_*`, and `qemu_mouse_*` work through QMP
before `WIN98CTL.EXE` is online. Deleted managed VMs go to broker trash; the
newest three are recoverable with `qemu_vm_restore`. Each broker manages at
most four live VMs; delete a VM before creating a fifth.

Managed ISO media is kept beneath each VM's `media/` directory. Import an ISO
from a path on the **broker host**, mount or eject it while QEMU is running,
and set CD-ROM boot order while the VM is stopped. These operations are exposed
identically through MCP, `call`, and `rpc`:

```powershell
npx windows98-mcp call qemu_media_push --params '{"vm_id":"win98","source_path":"C:\\ISO\\win98-mcp-guest.iso","media_id":"guest-tools"}'
npx windows98-mcp call qemu_media_mount --params '{"vm_id":"win98","media_id":"guest-tools"}'
npx windows98-mcp call qemu_media_list --params '{"vm_id":"win98"}'
# Stop first, then make the mounted CD bootable on the next start.
npx windows98-mcp call qemu_media_set_boot --params '{"vm_id":"win98","device":"cdrom"}'
npx windows98-mcp call qemu_media_eject --params '{"vm_id":"win98"}'
```

`qemu_media_push` intentionally does not interpret a path from a remote MCP or
CLI client. Copy the ISO to the broker host first; remote resumable media upload
is a separate future transport feature. Likewise, `disk_path` is currently
resolved on the broker host, not uploaded from a remote MCP/CLI client.

#### QEMU prerequisites and portable guest networking

Install QEMU on the machine that runs the broker; `qemu_doctor` reports the
resolved executable and accelerator plan before a VM is created. The managed
profile uses QEMU user networking. In that network the host is always
`10.0.2.2` **from inside the guest**, so a QEMU Windows image can retain this
guest configuration when moved to a different host:

```ini
[connection]
host=10.0.2.2
port=9898
```

`127.0.0.1` is not correct here: it is the Windows guest itself. Start the
broker listener on the same port (9898 by default) and allow that private
listener port through the host firewall. For VMware, bridged networking, or a
physical Windows installation, replace `10.0.2.2` with the broker host's
reachable IPv4 address.

- **Windows:** Install a current QEMU build and enable **Windows Hypervisor
  Platform** in Windows Features (or with
  `DISM /Online /Enable-Feature /FeatureName:HypervisorPlatform /All`). WHPX
  requires that Windows feature; on systems where it is unavailable, the
  default plan automatically uses TCG. QEMU documents the supported Windows
  versions and ARM64 requirements in its [WHPX documentation](https://www.qemu.org/docs/master/system/whpx.html).
- **Linux:** Install the distribution's QEMU package. Hardware acceleration
  additionally requires KVM support (`/dev/kvm`) and permission to use it,
  commonly membership of the `kvm` group. If KVM is absent or unavailable,
  `auto` uses TCG.
- **macOS:** Install QEMU (for example, `brew install qemu`). Intel Macs use
  Hypervisor.framework through HVF when available. Apple Silicon hosts run an
  i386/x86 Windows 98 guest with TCG emulation, so it is compatible but slower.

SMB, SMB1, shared-folder setup, and Windows' **SMB 1.0/CIFS File Sharing
Support** feature are not used by this release and must not be enabled for
windows98-mcp. The prior SMB mailbox transport was removed; guest control is
outbound TCP only.

#### CLI operational reference

All commands below use the exact MCP method name and JSON schema shown by
`npx windows98-mcp tools`. Use `call <method> --params '<JSON>'` for a single
operation, or send the same method/params through `rpc` for a persistent
workflow.

| Group | Methods |
| --- | --- |
| Status, recovery, lease | `vm_status`, `vm_capabilities`, `agent_diagnostics`, `vm_lock`, `vm_wait`, `vm_unlock` |
| Message and screen | `show_message`, `screen_capture`, `window_capture` |
| Mouse | `mouse_move`, `mouse_click`, `mouse_down`, `mouse_up`, `mouse_drag`, `mouse_scroll`, `mouse_position`, `mouse_release_all` |
| Keyboard | `keyboard_type`, `keyboard_key`, `keyboard_hotkey`, `keyboard_keycode`, `keyboard_release_all`, `input_batch` |
| Clipboard and windows | `clipboard_get`, `clipboard_set`, `window_list`, `window_focus`, `window_close` |
| Shell and terminal | `shell_exec`, `shell_start`, `shell_read`, `shell_write`, `shell_terminate`, `shell_close` |
| Processes | `process_list`, `process_wait`, `process_kill` |
| Filesystem | `fs_drives`, `fs_stat`, `fs_list`, `fs_mkdir`, `fs_move`, `fs_delete` |
| Transfers | `file_push`, `file_pull`, `directory_push`, `directory_pull` |
| System | `system_info`, `system_reboot`, `system_shutdown` |

Common one-shot calls:

```powershell
npx windows98-mcp call vm_status --params '{}'
npx windows98-mcp call mouse_move --params '{"x":320,"y":200,"duration_ms":150}'
npx windows98-mcp call keyboard_hotkey --params '{"keys":["CTRL","S"]}'
npx windows98-mcp call shell_exec --params '{"command":"dir C:\\","timeout_ms":30000}'
npx windows98-mcp call fs_list --params '{"path":"C:\\MCPTEST","recursive":false}'
npx windows98-mcp call file_push --params '{"host_path":"C:\\work\\input.txt","guest_path":"C:\\MCPTEST\\input.txt"}'
npx windows98-mcp call directory_pull --params '{"guest_path":"C:\\MCPTEST","host_path":"C:\\work\\mcp-test"}'
```

Persistent RPC rules:

- Every input line must contain `id`, `method`, and an object `params`.
- Responses use `{"kind":"response","id":...,"result":...}`. Transfers
  additionally emit `{"kind":"progress",...}` lines.
- Use RPC for `shell_start`/`shell_read`/`shell_write`/`shell_close`,
  `mouse_down`, and low-level keyboard `action:"down"`; `call` deliberately
  rejects these stateful operations to prevent stranded input or terminals.
- End with `vm_unlock`; closing stdin also performs forced cleanup.

Target a remote broker without a proxy:

```powershell
npx windows98-mcp call vm_status --params '{}' --broker-host 100.79.57.62 --broker-port 9899
```

## MCP tools

The tool groups are:

- Lease and status: `vm_status`, `vm_capabilities`, `vm_lock`, `vm_wait`,
  `vm_unlock`.
- Screen and input: screenshot, mouse, keyboard, and input batch tools.
- Desktop: clipboard and window control.
- Commands: one-shot shell execution and cursor-based interactive terminals.
- Message: `show_message` displays a Windows 98 popup.
- Recovery: `agent_diagnostics` reports the guest's persisted crash context and supervisor state.
- System and files: processes, filesystem primitives, resumable file transfer,
  and merging directory transfer.

Parallel operation is the default. Multiple agents may submit work, while the
broker's FIFO guest queue serializes protocol requests. This is safe for
independent shell, file, and inspection work, but it cannot make Windows have
separate mice, keyboards, focus, clipboard, or screens: agents must coordinate
interactive UI work themselves. `vm_unlock` always cleans up the calling
session's terminals, transfers, and held input.

Enable **Exclusive lock agents** in the Admin app only when one agent must own
all VM work. In that opt-in mode, the first VM-affecting call acquires the
lease; `VM_BUSY` responses include a FIFO ticket for `vm_wait`, and inactivity
expires the lease after 30 minutes. Disconnect cleanup releases held keys,
buttons, terminals, and transfers in either mode.

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
