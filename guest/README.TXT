WIN98CTL - WINDOWS 98 THROUGH WINDOWS 10 GUEST AGENT
====================================================

SETUP
-----
1. Edit WIN98CTL.INI. Set host to the host computer's address as visible from
   this VM and set the matching listener port (9898 by default).
2. Copy this complete folder to the Windows 98 or Windows 10 machine to control.
3. Run RUNTEST.BAT, then WIN98SUP.EXE. It starts WIN98CTL.EXE and restarts it
   after an unexpected exit.
4. Start the host broker or Windows admin app on the same port.
5. Run the host smoke test. Run INSTALL.BAT only after it succeeds.

UNINSTALL
---------
Run UNINSTALL.BAT to stop the agent and supervisor and remove their current
user startup entries. It deliberately keeps this folder and its logs.

The agent retries the outbound host connection every two seconds forever. The
supervisor checks every 250 ms for a confirmed WIN98CTL illegal-operation
dialog while the agent is still alive, closes it, then restarts the agent after
two seconds. If that confirmed dialog does not end the child within five
seconds, the supervisor terminates the child before restarting it. Use the
supervisor window's Exit supervisor button for an intentional stop.

IMPORTANT
---------
This release deliberately has no authentication or encryption. It is suitable
only for a disposable, isolated VM network. Do not expose the listener port to
an untrusted or public network.

FILES TO RETURN AFTER A FAILURE
-------------------------------
Copy SELFTEST.TXT, MCPAGENT.LOG, MCPCRASH.LOG and MCPSUPERVISOR.LOG back to the
host. MCPAGENT.LOG is bounded to 256 KiB; the prior generation is MCPAGENT.OLD.
MCPCRASH.LOG records the exception and last in-flight request when the agent
faults. MCPSUPERVISOR.LOG records restart and confirmed fault-dialog cleanup.
For a one-time recovery check only, run WIN98SUP.EXE --fault-test. It launches
one intentionally crashing child, then returns to a normal supervised agent.

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
