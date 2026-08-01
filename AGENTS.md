# Windows 98 MCP and CLI operating rules

## Choose an interface

- Prefer the `win98` MCP tools when they are available.
- If only terminal/CLI access is available, use `npx windows98-mcp tools` to
  inspect every operation and its exact JSON schema, then use either:

  ```text
  npx windows98-mcp call <method> --params '<JSON>'
  npx windows98-mcp rpc
  ```

- `call` is for one self-contained operation. It creates a temporary session
  and force-cleans it on exit. It intentionally rejects terminal operations,
  `mouse_down`, and keyboard-down operations; use `rpc` for those.
- `rpc` is a persistent JSON-lines session. Send one request per line as
  `{"id":"unique-id","method":"method_name","params":{...}}`; read matching
  JSON response lines. Keep it open for shell sessions, held input, input
  batches, and multi-step workflows. EOF force-cleans that RPC session.
- For a remote broker, add `--broker-host <ip> --broker-port <port>`. File and
  directory paths always belong to the machine running the CLI, not the remote
  broker host.

## Connection, recovery, and concurrency

- The guest dials the host every two seconds. The MCP/CLI process stays usable
  when the VM is powered off. Guest tools return retryable `VM_OFFLINE`; retry
  after the guest reconnects without recreating the Codex task or CLI session.
- The adapter resumes short broker connection losses automatically and may
  replay interrupted work at least once. A replay can duplicate clicks,
  commands, or writes; inspect `recovery.replayed` in the result.
- Parallel operation is the default. The broker FIFO-serializes guest protocol
  calls, but mouse, keyboard, focus, clipboard, and screen state remain shared.
  Coordinate interactive UI work with other agents.
- `vm_lock` and `vm_wait` matter only when an operator enables exclusive lock
  agents. In that mode, use the returned FIFO ticket after `VM_BUSY`.

## Safe workflow rules

- Take a current `screen_capture` before coordinate-based input when the UI may
  have changed. Release held keys/buttons after interrupted low-level input.
- In a persistent MCP or RPC workflow, explicitly close shell sessions and
  transfers, then call `vm_unlock`. Use `vm_unlock(force=true)` only to recover
  an interrupted workflow.
- Use `screen_capture`, `vm_status`, `vm_capabilities`, and
  `agent_diagnostics` for inspection. `agent_diagnostics` is safe while the VM
  is offline and reports guest/supervisor crash state when online.
- Run `node dist/src/cli.js doctor` before live debugging and
  `node dist/src/cli.js smoke-test` after copying a new guest build.
- The guest connection is deliberately unauthenticated for this isolated test
  environment. Keep it on a private VMware host-only network and never expose
  its TCP listener beyond that network.

## CLI examples

```powershell
# Status and screenshot
npx windows98-mcp call vm_status --params '{}'
npx windows98-mcp call screen_capture --params '{"include_cursor":true}' --image-out win98.png

# Exact input and a popup
npx windows98-mcp call mouse_click --params '{"x":120,"y":80,"button":"left"}'
npx windows98-mcp call keyboard_type --params '{"text":"Hello Windows 98"}'
npx windows98-mcp call show_message --params '{"message":"Control connection test"}'

# Persistent shell workflow: each line is sent to one running rpc process
{"id":"start","method":"shell_start","params":{"command":"COMMAND.COM"}}
{"id":"write","method":"shell_write","params":{"session_id":"<sessionId>","text":"dir\r\n"}}
{"id":"read","method":"shell_read","params":{"session_id":"<sessionId>","after_cursor":0,"wait_ms":500}}
{"id":"close","method":"shell_close","params":{"session_id":"<sessionId>"}}
{"id":"unlock","method":"vm_unlock","params":{"force":false}}
```

## Verification

- Host: `npm run typecheck`, `npm test`, `npm run build`, and
  `npm audit --audit-level=moderate`.
- Guest: `powershell -File scripts/build-guest.ps1 -Clean`.
- VM package: `powershell -File scripts/stage-vm.ps1 -HostAddress <host-only-IP> -Port 9898`.
