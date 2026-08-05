WIN98CTL - WINDOWS 98 THROUGH WINDOWS 10 GUEST AGENT
====================================================

SETUP
-----
1. Edit WIN98CTL.INI. For a QEMU VM using the managed default user network,
   keep host=10.0.2.2; it is QEMU's stable host gateway and remains valid when
   the disk is moved to another computer. For VMware, bridged networking, or
   a physical Windows machine, set host to the broker computer's reachable
   IPv4 address. Set the matching listener port (9898 by default).
2. Run INSTALL.BAT from this folder or the mounted release CD. It copies the
   complete package to C:\WIN98MCP and registers WIN98SUP for login.
3. Restart Windows. WIN98SUP starts WIN98CTL and restarts it after an
   unexpected exit. RUNTEST.BAT in C:\WIN98MCP remains available for tests.
4. Start the host broker or Windows admin app on the same port.
5. Run the host smoke test.

UNINSTALL
---------
Run UNINSTALL.BAT to stop the agent and supervisor and remove their current
user startup entries. It deliberately keeps this folder and its logs.

The agent retries the outbound host connection every two seconds forever. It
also writes a local PID-bound heartbeat every two seconds from a separate
thread. If an unhandled application exception reaches Windows, the agent first
writes MCPCRASH.LOG and stops that heartbeat; this remains true even when the
Windows illegal-operation dialog leaves another agent thread alive. The
supervisor checks the heartbeat every 250 ms and restarts only its owned child
when the heartbeat is missing or older than eight seconds. Network or broker
outages do not trigger this watchdog. The supervisor tolerates a transient
in-progress heartbeat-file write and uses the last complete record. Use the supervisor window's Exit
supervisor button for an intentional stop.

IMPORTANT
---------
This release deliberately has no authentication or encryption. It is suitable
only for a disposable, isolated VM network. Do not expose the listener port to
an untrusted or public network.

FILES TO RETURN AFTER A FAILURE
-------------------------------
Copy SELFTEST.TXT, MCPAGENT.LOG, MCPCRASH.LOG, MCPSUPERVISOR.LOG and
MCPSUPERVISOR.TXT back to the host. MCPAGENT.LOG is bounded to 256 KiB; the
prior generation is MCPAGENT.OLD. MCPCRASH.LOG records the exception, process
ID, fault signal, and last in-flight request when the agent faults. The
supervisor state records heartbeat age, sequence, and restart reason. For a
one-time watchdog recovery check, run
WIN98SUP.EXE --heartbeat-test. It launches one child that withholds heartbeat,
terminates it after eight seconds, then returns to a normal supervised agent.

OPERATION NOTES
---------------
WIN98CTL.EXE is one 32-bit ANSI Win32 executable built for Windows 98 Second
Edition APIs. It runs unchanged on Windows 98 SE and on Windows 10 (32-bit or
64-bit Windows 10 through WOW64). RUNTEST.BAT writes the detected operating
system and confirms that compatibility target in SELFTEST.TXT.

The agent requires the Winsock 2 components supplied with Windows 98 Second
Edition; Windows 10 already includes Winsock 2. Interrupted uploads keep
destination.W98PART and destination.W98META so a host can verify and resume
them. Compatible BASH.EXE commands run directly; other shell commands use the
machine's COMSPEC command processor (COMMAND.COM on Windows 98 and normally
cmd.exe on Windows 10). The host can send show_message to display a dialog
titled "Windows 98 Remote Control".

QEMU TCP NETWORKING
-------------------
QEMU-managed VMs use ordinary outbound TCP only. With the default QEMU user
network, host=10.0.2.2 reaches the broker on the physical host regardless of
that host's actual LAN, Wi-Fi, VPN, or adapter address. Do not use 127.0.0.1:
inside Windows it means this guest, not the QEMU host. SMB, SMB1, mailbox
files, shared folders, and desktop network-share shortcuts are not used.

CURRENT LIMITATIONS
-------------------
Interactive commands use redirected stdin/stdout pipes, not a full DOS screen.
Full-screen DOS/TUI applications, boot failures, BSODs, and exclusive graphics
screens cannot be controlled. Filenames and typed text use active Windows ANSI
and keyboard code pages. Transfers are limited to 2 GiB minus one byte.

On Windows 10, the agent controls the interactive desktop and applications at
the same integrity level. The UAC secure desktop, sign-in/lock screen, and an
elevated application cannot be automated by a non-elevated agent; start the
agent elevated in the same interactive session when elevated applications must
be controlled.
