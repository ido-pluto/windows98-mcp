WIN98CTL - WINDOWS 98 GUEST AGENT
================================

SETUP
-----
1. Edit WIN98CTL.INI. Set host to the host computer's address as visible from
   this VM and set the matching listener port (9898 by default).
2. Copy this complete folder to Windows 98.
3. Run RUNTEST.BAT, then WIN98CTL.EXE.
4. Start the host broker or Windows admin app on the same port.
5. Run the host smoke test. Run INSTALL.BAT only after it succeeds.

The agent retries the outbound host connection every two seconds forever until
you close its small status window. The same retry applies if Winsock 2 is not
yet available.

IMPORTANT
---------
This release deliberately has no authentication or encryption. It is suitable
only for a disposable, isolated VM network. Do not expose the listener port to
an untrusted or public network.

FILES TO RETURN AFTER A FAILURE
-------------------------------
Copy SELFTEST.TXT and MCPAGENT.LOG back to the host. MCPAGENT.LOG is bounded to
256 KiB; the prior generation is MCPAGENT.OLD.

OPERATION NOTES
---------------
The agent requires the Winsock 2 components supplied with Windows 98 Second
Edition. Interrupted uploads keep destination.W98PART and destination.W98META
so a host can verify and resume them. Compatible BASH.EXE commands run directly;
other shell commands use COMMAND.COM /C. The host can send show_message to
display a Windows 98 dialog titled "Windows 98 Remote Control".

CURRENT LIMITATIONS
-------------------
Interactive commands use redirected stdin/stdout pipes, not a full DOS screen.
Full-screen DOS/TUI applications, boot failures, BSODs, and exclusive graphics
screens cannot be controlled. Filenames and typed text use active Windows ANSI
and keyboard code pages. Transfers are limited to 2 GiB minus one byte.
