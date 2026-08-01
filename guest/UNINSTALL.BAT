@ECHO OFF
ECHO Removing Windows 98 MCP startup registration and stopping the supervisor...
WIN98SUP.EXE --uninstall
IF ERRORLEVEL 1 GOTO FAILED
ECHO Windows 98 MCP startup registration was removed for the current user.
ECHO Program files and logs were kept. Delete this folder manually if desired.
GOTO END
:FAILED
ECHO Uninstall failed. Ensure WIN98SUP.EXE is in this folder and try again.
:END
PAUSE
