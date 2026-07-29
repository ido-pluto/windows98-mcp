WIN98CTL - WINDOWS 98 GUEST AGENT
================================

IMPORTANT
---------
Use this only on an isolated host-only VM network. Traffic is authenticated
but is NOT encrypted. Do not expose TCP port 9898 to a public network.

FIRST TEST
----------
This package must identify itself as win98ctl-0.3.3 in SELFTEST.TXT. It was
rebuilt with official Open Watcom 1.9 only after the separate Windows 98
loader/API and C run-time probes both passed. SHA256.TXT identifies the exact
files in this package.

1. The staged WIN98CTL.INI already matches the host broker configuration.
   Do not edit only one side: a mismatched host, port, or PSK prevents login.
2. Start the broker on the host.
3. Run RUNTEST.BAT in Windows 98.
4. If the self-test passes, run WIN98CTL.EXE.
   A small status window remains open and provides the Close button.
5. Run the host smoke test.
6. Only after reconnect testing succeeds, run INSTALL.BAT to enable startup.

The agent retries the host connection every 2 seconds forever until it connects
or you close the agent. This fixed retry interval also applies when Winsock 2
initialization temporarily fails.

SECRET HANDLING AND ROTATION
----------------------------
This folder contains the plaintext PSK. Do not share, upload, or commit it.
To rotate the secret, rerun stage-vm with a new 64-digit -PskHex value, then
copy the newly generated WIN98CTL.INI to the VM and restart WIN98CTL.EXE. The
same command rewrites the ignored host configuration so both sides match.

FILES TO RETURN AFTER A FAILURE
-------------------------------
Copy SELFTEST.TXT and MCPAGENT.LOG back to the host. Screenshots and other
diagnostics can be collected by the host after the guest connects.
MCPAGENT.LOG is bounded to 256 KiB; the previous generation is MCPAGENT.OLD.

OPERATION NOTES
---------------
The agent requires the Winsock 2 components supplied with Windows 98 Second
Edition. An interrupted upload keeps destination.W98PART and
destination.W98META so the host can verify and resume it. Do not edit those
files. A compatible BASH.EXE command is launched directly; other shell commands
use COMMAND.COM /C. Mouse-wheel control is advertised only when Windows reports
a wheel-capable configuration.

CURRENT LIMITATIONS
-------------------
Interactive commands use redirected stdin/stdout pipes, not a full DOS screen.
Full-screen DOS/TUI applications, boot failures, BSODs, and exclusive graphics
screens cannot be controlled. Filenames and typed text use the active Windows
ANSI/keyboard code pages; unrepresentable UTF-8 input is rejected rather than
substituted. File transfers are limited to 2 GiB minus one byte.
