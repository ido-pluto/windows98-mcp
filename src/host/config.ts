import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_LEASE_TTL_MS, DEFAULT_WAIT_TICKET_TTL_MS } from "../shared/types.js";

export interface BrokerConfig {
  bindHost: "0.0.0.0";
  guestPort: number;
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
}

export interface BrokerConfigFile {
  guestPort?: number;
  pipePath?: string;
  stateDir?: string;
  artifactDir?: string;
  logPath?: string;
  leaseTtlMs?: number;
  waitTicketTtlMs?: number;
  requestTimeoutMs?: number;
  guestConnectTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  maxArtifactBytes?: number;
}

export interface LoadBrokerConfigOptions {
  configPath?: string;
  overrides?: BrokerConfigFile;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface RuntimeSettings {
  port?: number;
}

const DEFAULT_PORT = 9898;

export function defaultPipePath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\win98-mcp";
  }
  return resolve(tmpdir(), "win98-mcp.sock");
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
  const stateDir = resolveConfiguredPath(
    merged.stateDir ?? env["WIN98_MCP_STATE_DIR"] ??
      resolve(env["LOCALAPPDATA"] ?? homedir(), "win98-mcp"),
    cwd
  );
  const config: BrokerConfig = {
    bindHost: "0.0.0.0",
    guestPort: integer(
      options.overrides?.guestPort ?? merged.guestPort ?? runtime.port ?? envNumber(env["WIN98_MCP_GUEST_PORT"]) ?? DEFAULT_PORT,
      "guestPort",
      1,
      65535
    ),
    pipePath: merged.pipePath ?? env["WIN98_MCP_PIPE"] ?? defaultPipePath(),
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
    )
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
    return typeof parsed.port === "number" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    void cwd;
    return {};
  }
}
