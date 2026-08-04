import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_LEASE_TTL_MS, DEFAULT_WAIT_TICKET_TTL_MS } from "../shared/types.js";

export interface BrokerConfig {
  bindHost: "0.0.0.0";
  guestPort: number;
  /** TCP port for admin/MCP adapters, including adapters on another machine. */
  adapterPort: number;
  /** Whether the broker requires one lease owner; false uses the FIFO guest queue. */
  lockingEnabled: boolean;
  /** When set, this broker transparently relays its guest connection upstream. */
  upstreamHost?: string;
  upstreamPort?: number;
  pipePath: string;
  stateDir: string;
  artifactDir: string;
  logPath: string;
  leaseTtlMs: number;
  waitTicketTtlMs: number;
  requestTimeoutMs: number;
  guestConnectTimeoutMs: number;
  heartbeatTimeoutMs: number;
  maxArtifactBytes: number;
  /** Root directory for broker-owned managed QEMU VMs. */
  qemuRoot?: string;
  /** Optional default qemu-system binary. Individual VMs may override it. */
  qemuBinary?: string;
}

export interface BrokerConfigFile {
  guestPort?: number;
  adapterPort?: number;
  lockingEnabled?: boolean;
  upstreamHost?: string;
  upstreamPort?: number;
  /** Explicitly disable a persisted upstream target for this broker instance. */
  upstreamEnabled?: boolean;
  stateDir?: string;
  artifactDir?: string;
  logPath?: string;
  leaseTtlMs?: number;
  waitTicketTtlMs?: number;
  requestTimeoutMs?: number;
  guestConnectTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  maxArtifactBytes?: number;
  qemuRoot?: string;
  qemuBinary?: string;
}

export interface LoadBrokerConfigOptions {
  configPath?: string;
  overrides?: BrokerConfigFile;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface RuntimeSettings {
  port?: number;
  brokerPort?: number;
  upstreamHost?: string;
  upstreamPort?: number;
  upstreamEnabled?: boolean;
  lockingEnabled?: boolean;
}

const DEFAULT_PORT = 9898;
const DEFAULT_ADAPTER_PORT = 9899;

export function defaultPipePath(port = DEFAULT_PORT): string {
  const suffix = port === DEFAULT_PORT ? "" : `-${port}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\win98-mcp${suffix}`;
  }
  // Keep this independent of TMPDIR: the macOS Tauri client uses the same
  // public /tmp endpoint, while Node's os.tmpdir() is often per-user.
  return resolve("/tmp", `win98-mcp${suffix}.sock`);
}

export async function loadBrokerConfig(
  options: LoadBrokerConfigOptions = {}
): Promise<BrokerConfig> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = options.configPath ?? env["WIN98_MCP_CONFIG"];
  let file: BrokerConfigFile = {};
  if (configPath) {
    const absolute = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
    const json = await readFile(absolute, "utf8");
    file = JSON.parse(json.replace(/^\uFEFF/u, "")) as BrokerConfigFile;
  }
  const runtime = await loadRuntimeSettings(env, cwd);

  const merged: BrokerConfigFile = { ...file, ...options.overrides };
  const guestPort = integer(
    options.overrides?.guestPort ?? merged.guestPort ?? runtime.port ?? envNumber(env["WIN98_MCP_GUEST_PORT"]) ?? DEFAULT_PORT,
    "guestPort",
    1,
    65535
  );
  const adapterPort = integer(
    options.overrides?.adapterPort ?? merged.adapterPort ?? runtime.brokerPort ?? envNumber(env["WIN98_MCP_ADAPTER_PORT"]) ?? defaultAdapterPort(guestPort),
    "adapterPort",
    1,
    65535
  );
  const lockingEnabled = boolean(
    options.overrides?.lockingEnabled ?? merged.lockingEnabled ?? runtime.lockingEnabled ?? false,
    "lockingEnabled"
  );
  const defaultStateRoot = resolve(env["LOCALAPPDATA"] ?? homedir(), "win98-mcp");
  const upstreamEnabled = options.overrides?.upstreamEnabled ?? merged.upstreamEnabled ?? runtime.upstreamEnabled ?? true;
  const configuredUpstreamHost = upstreamEnabled ? options.overrides?.upstreamHost ?? merged.upstreamHost ?? runtime.upstreamHost : undefined;
  const upstreamHost = typeof configuredUpstreamHost === "string" && configuredUpstreamHost.trim()
    ? configuredUpstreamHost.trim()
    : undefined;
  const upstreamPort = upstreamHost
    ? integer(
      options.overrides?.upstreamPort ?? merged.upstreamPort ?? runtime.upstreamPort ?? DEFAULT_PORT,
      "upstreamPort",
      1,
      65535
    )
    : undefined;
  const upstream = upstreamHost !== undefined && upstreamPort !== undefined
    ? { upstreamHost, upstreamPort }
    : {};
  const stateDir = resolveConfiguredPath(
    merged.stateDir ?? env["WIN98_MCP_STATE_DIR"] ??
      (guestPort === DEFAULT_PORT
        ? defaultStateRoot
        : resolve(defaultStateRoot, `port-${guestPort}`)),
    cwd
  );
  const config: BrokerConfig = {
    bindHost: "0.0.0.0",
    guestPort,
    adapterPort,
    lockingEnabled,
    ...upstream,
    pipePath: defaultPipePath(guestPort),
    stateDir,
    artifactDir: resolveConfiguredPath(
      merged.artifactDir ?? resolve(stateDir, "artifacts"),
      cwd
    ),
    logPath: resolveConfiguredPath(
      merged.logPath ?? resolve(stateDir, "broker.jsonl"),
      cwd
    ),
    leaseTtlMs: integer(
      merged.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      "leaseTtlMs",
      1_000,
      24 * 60 * 60 * 1000
    ),
    waitTicketTtlMs: integer(
      merged.waitTicketTtlMs ?? DEFAULT_WAIT_TICKET_TTL_MS,
      "waitTicketTtlMs",
      1_000,
      60 * 60 * 1000
    ),
    requestTimeoutMs: integer(
      merged.requestTimeoutMs ?? 30_000,
      "requestTimeoutMs",
      100,
      60 * 60 * 1000
    ),
    guestConnectTimeoutMs: integer(
      merged.guestConnectTimeoutMs ?? 5_000,
      "guestConnectTimeoutMs",
      100,
      60_000
    ),
    heartbeatTimeoutMs: integer(
      merged.heartbeatTimeoutMs ?? 30_000,
      "heartbeatTimeoutMs",
      1_000,
      10 * 60 * 1000
    ),
    maxArtifactBytes: integer(
      merged.maxArtifactBytes ?? 32 * 1024 * 1024,
      "maxArtifactBytes",
      1024,
      512 * 1024 * 1024
    ),
    qemuRoot: resolveConfiguredPath(
      merged.qemuRoot ?? env["WIN98_MCP_QEMU_ROOT"] ?? resolve(stateDir, "qemu"),
      cwd
    ),
    ...(typeof (merged.qemuBinary ?? env["WIN98_MCP_QEMU_BINARY"]) === "string" && (merged.qemuBinary ?? env["WIN98_MCP_QEMU_BINARY"])?.trim()
      ? { qemuBinary: resolveConfiguredPath((merged.qemuBinary ?? env["WIN98_MCP_QEMU_BINARY"])!.trim(), cwd) }
      : {})
  };
  return config;
}

function resolveConfiguredPath(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`CONFIG_INVALID:${label}`);
  }
  return value;
}

function boolean(value: boolean, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`CONFIG_INVALID:${label}`);
  }
  return value;
}

function defaultAdapterPort(guestPort: number): number {
  return guestPort === DEFAULT_PORT || guestPort === 65_535
    ? DEFAULT_ADAPTER_PORT
    : guestPort + 1;
}

export function publicConfig(config: BrokerConfig): BrokerConfig { return { ...config }; }

export function configDirectory(config: BrokerConfig): string {
  return dirname(config.logPath);
}

/** Shared by the desktop admin app and headless MCP adapter. */
export function runtimeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env["LOCALAPPDATA"] ?? homedir(), "win98-mcp", "runtime.json");
}

async function loadRuntimeSettings(env: NodeJS.ProcessEnv, cwd: string): Promise<RuntimeSettings> {
  const path = runtimeSettingsPath(env);
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as RuntimeSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    void cwd;
    return {};
  }
}
