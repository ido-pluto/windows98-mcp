# Windows 98 MCP operating rules

- Use the `win98` MCP tools for Windows 98 guest work. Do not use host Computer
  Use to operate the VM unless the user explicitly requests the hypervisor
  fallback.
- `vm_status` and `vm_capabilities` do not acquire the lease. The first other
  VM tool call does.
- Always finish a VM workflow with `vm_unlock`. Use a `finally`-style cleanup
  mindset even after tool errors.
- Close terminal sessions and transfers before normal unlock. Use
  `vm_unlock(force=true)` only to recover an interrupted workflow.
- If the VM is busy, use the returned FIFO ticket with `vm_wait`; do not attempt
  parallel mouse, keyboard, shell, or filesystem control.
- Take a current screenshot before coordinate-based input when the UI may have
  changed. Release held keys and mouse buttons after interrupted low-level
  input.
- Run `node dist/src/cli.js doctor` before live debugging and
  `node dist/src/cli.js smoke-test` after copying a new guest build.
- The guest connection is deliberately unauthenticated for this isolated test
  environment. Keep it on a private VMware host-only network and never expose
  its TCP listener beyond that network.

## Verification

- Host: `npm run typecheck`, `npm test`, `npm run build`, and
  `npm audit --audit-level=moderate`.
- Guest: `powershell -File scripts/build-guest.ps1 -Clean`.
- VM package: `powershell -File scripts/stage-vm.ps1 -HostAddress <host-only-IP> -Port 9898`.
