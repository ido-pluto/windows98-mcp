#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { parseCliArgs } from "./cli-options.js";
import {
  brokerIsReachable,
  connectBroker,
  loadBrokerConfig,
  startBroker,
  type Broker,
  type BrokerConfig
} from "./host/index.js";
import { startStdioMcp } from "./mcp/index.js";
import { BrokerClient } from "./mcp/broker-client.js";
import { ClientTransferRunner } from "./mcp/client-transfers.js";
import { brokerTimeout, findToolDefinition, toolCatalog, validateToolParams } from "./mcp/server.js";
import { TRANSFER_METHODS } from "./host/transfers.js";
import type { BrokerResponse, ToolResult } from "./shared/types.js";
import { EXPECTED_GUEST_BUILD_ID } from "./shared/build-info.js";
import { PACKAGE_VERSION } from "./shared/package-info.js";
import { SimulatedGuest, writeSimulatorFixture } from "./simulator/index.js";
import { collectDiagnostics } from "./workflows/diagnostics.js";
import { runSmokeTest } from "./workflows/smoke-test.js";

const cli = parseCliArgs(process.argv.slice(2));
const command = cli.command;

void main();

async function main(): Promise<void> {
  try {
    switch (command) {
      case "broker":
        await runBroker();
        break;
      case "stdio":
        await runStdio();
        break;
      case "doctor":
        await runDoctor();
        break;
      case "simulator":
        await runSimulator();
        break;
      case "smoke-test":
        await runSmoke();
        break;
      case "diagnostics":
        await runDiagnostics();
        break;
      case "client-transfer":
        await runClientTransfer();
        break;
      case "tools":
        runTools();
        break;
      case "call":
        await runCall();
        break;
      case "rpc":
        await runRpc();
        break;
      case "version":
        process.stdout.write(`${PACKAGE_VERSION}\n`);
        break;
      case "help":
        printHelp();
        break;
      default:
        throw new Error(`UNKNOWN_COMMAND:${command}`);
    }
  } catch (error) {
    process.stderr.write(
      `[win98-mcp] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

async function runBroker(): Promise<void> {
  const config = await loadCliConfig();
  const broker = await startBroker(config);
  process.stderr.write(
    `[win98-mcp] broker listening for guest on ${config.bindHost}:${config.guestPort} and adapters on ${config.pipePath}\n`
  );
  await waitForShutdown(broker);
}

async function runStdio(): Promise<void> {
  const config = await loadCliConfig();
  const brokerHost = cli.brokerHost ?? "127.0.0.1";
  const brokerPort = cli.brokerPort ?? config.adapterPort;
  if (isLocalBrokerHost(brokerHost)) {
    try {
      await ensureBroker(config);
    } catch (error) {
      process.stderr.write(
        `[win98-mcp] broker auto-start failed; tools will report unavailable: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  }
  let brokerMonitor: NodeJS.Timeout | undefined;
  if (isLocalBrokerHost(brokerHost)) {
    brokerMonitor = setInterval(() => {
      void ensureBroker(config).catch((error) => {
        process.stderr.write(`[win98-mcp] local broker recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, 2_000);
    brokerMonitor.unref();
  }
  await startStdioMcp({
    host: brokerHost,
    port: brokerPort,
    requestTimeoutMs: 11 * 60 * 1000,
    onClose: () => { if (brokerMonitor) clearInterval(brokerMonitor); }
  });
}

async function runDoctor(): Promise<void> {
  const config = await loadCliConfig();
  await ensureBroker(config);
  const client = await connectBroker({
    pipePath: config.pipePath,
    sessionLabel: `doctor:${process.pid}`,
    requestTimeoutMs: 10_000
  });
  try {
    const [status, capabilities] = await Promise.all([
      client.call("vm_status", {}, 10_000),
      client.call("vm_capabilities", {}, 10_000)
    ]);
    const result = {
      ok: status.result.ok && capabilities.result.ok,
      broker: {
        pipePath: config.pipePath,
        guestListener: `${config.bindHost}:${config.guestPort}`
      },
      status: status.result,
      capabilities: capabilities.result,
      copyRequired:
        status.result.connection.state !== "online"
          ? "WIN98CTL.INI (verify host and port first)"
          : status.result.connection.guestBuildId !== EXPECTED_GUEST_BUILD_ID &&
              status.result.connection.guestBuildId !== "simulator-1"
            ? "WIN98CTL.EXE and package"
            : "nothing",
      nextStep:
        status.result.connection.state === "online"
          ? "Run win98-mcp smoke-test."
          : "Copy the staged VM drop, run RUNTEST.BAT in Windows 98, and retry doctor."
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  } finally {
    client.close();
  }
}

async function runSimulator(): Promise<void> {
  const config = await loadCliConfig();
  await ensureBroker(config);
  const rootDirectory = path.join(config.stateDir, "simulator-root");
  await writeSimulatorFixture(rootDirectory);
  const simulator = new SimulatedGuest({
    host: "127.0.0.1",
    port: config.guestPort,
    rootDirectory
  });
  simulator.on("connected", () => {
    process.stderr.write("[win98-mcp] simulated Windows 98 guest connected\n");
  });
  simulator.on("protocolError", (error) => {
    process.stderr.write(`[win98-mcp] simulator protocol error: ${String(error)}\n`);
  });
  await simulator.start();
  await waitForSignals(async () => simulator.stop());
}

async function runSmoke(): Promise<void> {
  const config = await loadCliConfig();
  await ensureBroker(config);
  const report = await runSmokeTest(config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 2;
}

async function runDiagnostics(): Promise<void> {
  const config = await loadCliConfig();
  const requested = cli.commandArgs[0];
  const outputDirectory =
    requested ?? path.join(config.stateDir, `diagnostics-${Date.now()}`);
  const result = await collectDiagnostics(config, outputDirectory);
  process.stdout.write(`${result}\n`);
}

/**
 * Used by the packaged desktop app. The sidecar runs on the desktop client's
 * machine, so paths in the request are always local even when the broker is
 * reached over TCP on another computer.
 */
async function runClientTransfer(): Promise<void> {
  if (!cli.transferRequest) throw new Error("CLI_VALUE_REQUIRED:--transfer-request");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cli.transferRequest) as unknown;
  } catch {
    throw new Error("CLI_INVALID:--transfer-request");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("method" in parsed) ||
    typeof parsed.method !== "string" ||
    !("params" in parsed) ||
    !parsed.params ||
    typeof parsed.params !== "object" ||
    Array.isArray(parsed.params)
  ) {
    throw new Error("CLI_INVALID:--transfer-request");
  }
  const config = await loadCliConfig();
  const client = new BrokerClient({
    host: cli.brokerHost ?? "127.0.0.1",
    port: cli.brokerPort ?? config.adapterPort,
    sessionLabel: `admin-client-transfer:${process.pid}`,
    requestTimeoutMs: 11 * 60 * 1_000
  });
  const transfer = new ClientTransferRunner(client, (progress) => {
    process.stdout.write(`${JSON.stringify({ kind: "transfer_progress", progress })}\n`);
  });
  try {
    const data = await transfer.execute(parsed.method, parsed.params as Record<string, unknown>);
    await client.request("vm_unlock", {}, { timeoutMs: 30_000 });
    process.stdout.write(`${JSON.stringify({ kind: "transfer_result", ok: true, data })}\n`);
  } catch (error) {
    await transfer.abort().catch(() => undefined);
    await client.request("vm_unlock", { force: true }, { timeoutMs: 30_000 }).catch(() => undefined);
    process.stdout.write(`${JSON.stringify({ kind: "transfer_result", ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 2;
  } finally {
    await client.close();
  }
}

function runTools(): void {
  process.stdout.write(`${JSON.stringify({ tools: toolCatalog() }, null, 2)}\n`);
}

async function runCall(): Promise<void> {
  const method = cli.commandArgs[0];
  if (!method || cli.commandArgs.length !== 1) {
    writeCliResult(cliError("CLI_USAGE", "Usage: windows98-mcp call <method> --params <JSON>"));
    process.exitCode = 2;
    return;
  }
  let validated: Record<string, unknown>;
  try { validated = validateOperation(method, await readOperationParams()); }
  catch (error) { writeCliResult(cliException(error)); process.exitCode = 2; return; }
  if (cli.imageOut && method !== "screen_capture" && method !== "window_capture") {
    writeCliResult(cliError("CLI_IMAGE_UNAVAILABLE", "--image-out is supported only by screen_capture and window_capture."));
    process.exitCode = 2;
    return;
  }
  if (isStatefulOneShot(method, validated)) { writeCliResult(cliError("CLI_STATEFUL_OPERATION", `${method} requires a persistent session; use windows98-mcp rpc.`)); process.exitCode = 2; return; }
  let client: BrokerClient;
  try { client = await createCliClient("cli-call"); }
  catch (error) { writeCliResult(cliError("CLI_BROKER_UNAVAILABLE", errorMessage(error))); process.exitCode = 2; return; }
  try {
    const response = await executeCliOperation(client, method, validated);
    if (cli.imageOut && response.image) {
      await writeFile(cli.imageOut, Buffer.from(response.image.data, "base64"));
    }
    writeCliResult(response.result, response.image);
    if (!response.result.ok) process.exitCode = 2;
  } catch (error) {
    writeCliResult(cliError("CLI_OPERATION_FAILED", errorMessage(error)));
    process.exitCode = 2;
  } finally {
    await client.close({ cleanup: true });
  }
}

async function runRpc(): Promise<void> {
  let activeId: string | number | null = null;
  const client = await createCliClient("cli-rpc", (progress) => {
    writeRpc({ kind: "progress", id: activeId, source: "broker", progress });
  });
  const transfers = new ClientTransferRunner(client, (progress) => {
    writeRpc({ kind: "progress", id: activeId, source: "client", progress });
  });
  try {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      let request: unknown;
      try { request = JSON.parse(line) as unknown; }
      catch { writeRpc({ kind: "response", id: null, result: cliError("CLI_INVALID_JSON", "Each rpc line must be JSON.") }); continue; }
      if (!isCliRpcRequest(request)) {
        writeRpc({ kind: "response", id: null, result: cliError("CLI_INVALID_REQUEST", "rpc requests require id, method, and params object.") });
        continue;
      }
      activeId = request.id;
      try {
        const params = validateOperation(request.method, request.params);
        const response = await executeCliOperation(client, request.method, params, transfers);
        writeRpc({ kind: "response", id: request.id, result: response.result, ...(response.image ? { image: response.image } : {}) });
      } catch (error) {
        writeRpc({ kind: "response", id: request.id, result: cliException(error) });
      } finally { activeId = null; }
    }
  } finally {
    await client.close({ cleanup: true });
  }
}

async function createCliClient(
  label: string,
  onProgress?: (progress: unknown) => void
): Promise<BrokerClient> {
  const config = await loadCliConfig();
  const host = cli.brokerHost ?? "127.0.0.1";
  if (isLocalBrokerHost(host)) await ensureBroker(config);
  return new BrokerClient({
    host,
    port: cli.brokerPort ?? config.adapterPort,
    sessionLabel: `${label}:${process.pid}`,
    requestTimeoutMs: 11 * 60 * 1_000,
    ...(onProgress ? { onProgress } : {})
  });
}

async function readOperationParams(): Promise<Record<string, unknown>> {
  if (cli.params !== undefined && cli.paramsFile !== undefined) throw new Error("CLI_INVALID:--params and --params-file are mutually exclusive");
  const text = cli.paramsFile ? await readFile(cli.paramsFile, "utf8") : cli.params ?? "{}";
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new Error("CLI_INVALID_PARAMS: parameters must be a JSON object");
  }
}

function validateOperation(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (!findToolDefinition(method)) {
    throw new Error(`CLI_UNKNOWN_METHOD:${method}`);
  }
  const validated = validateToolParams(method, params);
  if (!validated.ok) throw new Error(`CLI_INVALID_PARAMS:${validated.message}`);
  return validated.params;
}

async function executeCliOperation(
  client: BrokerClient,
  method: string,
  params: Record<string, unknown>,
  transfers?: ClientTransferRunner
): Promise<BrokerResponse> {
  if (!findToolDefinition(method)) throw new Error(`CLI_UNKNOWN_METHOD:${method}`);
  if (TRANSFER_METHODS.has(method)) {
    const runner = transfers ?? new ClientTransferRunner(client, (progress) => {
      process.stderr.write(`[win98-mcp] transfer ${JSON.stringify(progress)}\n`);
    });
    const data = await runner.execute(method, params);
    const status = await client.request("vm_status");
    if (!status.result.ok) {
      return status;
    }
    return {
      ...status,
      id: "cli-transfer",
      result: { ...status.result, ok: true, code: "OK", message: `${method} completed.`, data }
    };
  }
  const timeoutMs = brokerTimeout(method, params);
  return await client.request(method, params, timeoutMs === undefined ? {} : { timeoutMs });
}

function isStatefulOneShot(method: string, params: Record<string, unknown>): boolean {
  if (["vm_lock", "vm_wait", "shell_start", "shell_read", "shell_write", "shell_terminate", "shell_close", "mouse_down"].includes(method)) return true;
  if (method === "keyboard_key" || method === "keyboard_keycode") return params["action"] === "down";
  if (method === "input_batch" && Array.isArray(params["actions"])) {
    return params["actions"].some((action) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) return false;
      const record = action as Record<string, unknown>;
      return record["type"] === "mouse_down" ||
        ((record["type"] === "keyboard_key" || record["type"] === "keyboard_keycode") && record["action"] === "down");
    });
  }
  return false;
}

function cliError(code: string, message: string): ToolResult {
  return { ok: false, code, message, requestId: "", connection: { state: "offline", epoch: 0 }, lease: { held: false, heldByCaller: false }, retryable: false };
}

function cliException(error: unknown): ToolResult {
  const message = errorMessage(error);
  return cliError(message.startsWith("CLI_INVALID_PARAMS:") ? "CLI_INVALID_PARAMS" : message.startsWith("CLI_UNKNOWN_METHOD:") ? "CLI_UNKNOWN_METHOD" : "CLI_OPERATION_FAILED", message);
}

function writeCliResult(result: ToolResult, image?: BrokerResponse["image"]): void {
  process.stdout.write(`${JSON.stringify({ result, ...(image ? { image } : {}) })}\n`);
}

function writeRpc(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCliRpcRequest(value: unknown): value is { id: string | number; method: string; params: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (typeof record["id"] === "string" || typeof record["id"] === "number") && typeof record["method"] === "string" && !!record["params"] && typeof record["params"] === "object" && !Array.isArray(record["params"]);
}

async function ensureBroker(config: BrokerConfig): Promise<void> {
  if (await brokerIsReachable(config.pipePath)) return;
  const entry = process.argv[1];
  if (!entry) throw new Error("CLI_ENTRYPOINT_UNKNOWN");
  const child = spawn(
    process.execPath,
    [...process.execArgv, entry, "broker", ...cli.configArgs],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env,
      windowsHide: true
    }
  );
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await brokerIsReachable(config.pipePath, 200)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("BROKER_START_TIMEOUT");
}

async function loadCliConfig(): Promise<BrokerConfig> {
  return await loadBrokerConfig({
    ...(cli.configPath ? { configPath: cli.configPath } : {}),
    overrides: cli.overrides
  });
}

async function waitForShutdown(broker: Broker): Promise<void> {
  await waitForSignals(async () => broker.stop());
}

async function waitForSignals(cleanup: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void cleanup().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function printHelp(): void {
  process.stdout.write(`Windows 98 Remote-Control MCP

Usage: windows98-mcp [command] [options]

With no command, the stdio MCP adapter starts for npx-based MCP clients.

  broker              Run the long-lived host broker
  stdio               Run the Codex stdio MCP adapter
  doctor              Check broker, guest, and negotiated capabilities
  simulator           Run the deterministic simulated Windows 98 guest
  smoke-test          Exercise the connected guest safely
  diagnostics [dir]   Collect sanitized diagnostics
  client-transfer     Internal desktop-client transfer runner
  tools               Print every MCP-compatible CLI operation and JSON schema
  call <method>       Run one operation: --params '<JSON>' or --params-file file.json
  rpc                 Run a persistent JSON-lines control session on stdin/stdout

CLI control options:
  --params <JSON>     JSON object for call (default: {})
  --params-file <file> Read the call JSON object from a UTF-8 file
  --image-out <file>  Save screen_capture/window_capture image data to a file

Network and configuration options:
  --port <port>       Guest listener port (default: 9898)
  --broker-host <ip>  Broker control host for MCP (default: 127.0.0.1)
  --broker-port <port> Broker control port for MCP (default: 9899)
  --upstream <ip:port> Transparently relay a connected guest to a normal upstream broker
  --config <file>     Load a broker JSON configuration file
  --state-dir <dir>   Store logs and artifacts in this directory

Examples:
  npx windows98-mcp
  npx windows98-mcp --port 9898
  npx windows98-mcp --broker-host 100.79.57.62 --broker-port 9899
  npx windows98-mcp broker --port 9898 --upstream 192.168.1.50:9898
  npx windows98-mcp call mouse_click --params '{"x":120,"y":80}'
  npx windows98-mcp call file_push --params '{"host_path":"C:\\work\\a.txt","guest_path":"C:\\MCPTEST\\a.txt"}'
  npx windows98-mcp call screen_capture --params '{}' --image-out screen.png
  echo {"id":"1","method":"vm_status","params":{}} | npx windows98-mcp rpc

Use "tools" for every method and its exact JSON schema. call is one-shot and
cleans up automatically; use rpc for terminals, held input, and workflows.
`);
}

function isLocalBrokerHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
