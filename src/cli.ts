#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
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
  try {
    await ensureBroker(config);
  } catch (error) {
    process.stderr.write(
      `[win98-mcp] broker auto-start failed; tools will report unavailable: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
  }
  await startStdioMcp({
    pipePath: config.pipePath,
    requestTimeoutMs: 11 * 60 * 1000
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

Network and configuration options:
  --port <port>       Guest listener port (default: 9898)
  --upstream <ip:port> Transparently relay a connected guest to a normal upstream broker
  --config <file>     Load a broker JSON configuration file
  --state-dir <dir>   Store logs and artifacts in this directory

Examples:
  npx windows98-mcp
  npx windows98-mcp --port 9898
  npx windows98-mcp broker --port 9898 --upstream 192.168.1.50:9898
`);
}
