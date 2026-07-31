This directory receives the Windows x64 Node SEA broker sidecar during a
release build.

Expected file:
  windows98-mcp-broker.exe

It accepts:
  windows98-mcp-broker.exe broker --port <1-65535>

Build it from the repository root:
  powershell -ExecutionPolicy Bypass -File .\scripts\build-broker-sidecar.ps1

The sidecar uses the same unauthenticated local JSON pipe protocol as the npm
MCP adapter. It is included only in the portable admin release ZIP, never in
the npm package.
