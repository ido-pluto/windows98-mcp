import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { DEFAULT_LEASE_TTL_MS, DEFAULT_WAIT_TICKET_TTL_MS } from "../shared/types.js";

export interface BrokerConfig {
  bindHost: string;
  expectedGuestIp?: string;
  guestPort: number;
  pipePath: string;
  psk: Buffer;
  stateDir: string;
  artifactDir: string;
  logPath: string;
  leaseTtlMs: number;
  waitTicketTtlMs: number;
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
  heartbeatTimeoutMs: number;
  maxArtifactBytes: number;
  allowInsecurePublicBind: boolean;
  hostAllowedRoots?: string[];
}

export interface BrokerConfigFile {
  bindHost?: string;
  expectedGuestIp?: string;
  guestPort?: number;
  pipePath?: string;
  psk?: string;
  stateDir?: string;
  artifactDir?: string;
  logPath?: string;
  leaseTtlMs?: number;
  waitTicketTtlMs?: number;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  maxArtifactBytes?: number;
  allowInsecurePublicBind?: boolean;
  hostAllowedRoots?: string[];
}

export interface LoadBrokerConfigOptions {
  configPath?: string;
  overrides?: BrokerConfigFile;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const DEFAULT_PORT = 9898;

export function defaultPipePath(cwd = process.cwd()): string {
  const suffix = createHash("sha256")
    .update(resolve(cwd).toLowerCase())
    .digest("hex")
    .slice(0, 16);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\win98-mcp-${suffix}`;
  }
  return resolve(tmpdir(), `win98-mcp-${suffix}.sock`);
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

  const merged: BrokerConfigFile = { ...file, ...options.overrides };
  const stateDir = resolveConfiguredPath(
    merged.stateDir ?? env["WIN98_MCP_STATE_DIR"] ??
      resolve(env["LOCALAPPDATA"] ?? homedir(), "win98-mcp"),
    cwd
  );
  const pskText = merged.psk ?? env["WIN98_MCP_PSK"];
  if (!pskText) {
    throw new Error(
      "PSK_REQUIRED: set WIN98_MCP_PSK or the psk field in the broker config"
    );
  }
  const psk = decodePsk(pskText);
  if (psk.length < 32) {
    throw new Error("PSK_TOO_SHORT: the decoded PSK must contain at least 32 bytes");
  }

  const config: BrokerConfig = {
    bindHost: merged.bindHost ?? env["WIN98_MCP_BIND_HOST"] ?? "127.0.0.1",
    ...optionalGuestIp(
      merged.expectedGuestIp ?? env["WIN98_MCP_GUEST_IP"]
    ),
    guestPort: integer(
      merged.guestPort ?? envNumber(env["WIN98_MCP_GUEST_PORT"]) ?? DEFAULT_PORT,
      "guestPort",
      1,
      65535
    ),
    pipePath: merged.pipePath ?? env["WIN98_MCP_PIPE"] ?? defaultPipePath(cwd),
    psk,
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
    handshakeTimeoutMs: integer(
      merged.handshakeTimeoutMs ?? 10_000,
      "handshakeTimeoutMs",
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
    allowInsecurePublicBind: merged.allowInsecurePublicBind ?? false,
    hostAllowedRoots: normalizeAllowedRoots(
      merged.hostAllowedRoots ??
        splitRoots(env["WIN98_MCP_HOST_ROOTS"]) ??
        [cwd],
      cwd
    )
  };

  if (!isPrivateOrLoopbackBind(config.bindHost) && !config.allowInsecurePublicBind) {
    throw new Error(
      "PUBLIC_BIND_REFUSED: traffic is authenticated but not encrypted; bind to a host-only address or set allowInsecurePublicBind explicitly"
    );
  }
  return config;
}

function optionalGuestIp(value: string | undefined): Pick<BrokerConfig, "expectedGuestIp"> {
  if (value === undefined) {
    return {};
  }
  const normalized = value.trim();
  if (isIP(normalized) !== 4) {
    throw new Error("CONFIG_INVALID:expectedGuestIp must be an IPv4 address");
  }
  return { expectedGuestIp: normalized };
}

export function publicConfig(config: BrokerConfig): Omit<BrokerConfig, "psk"> {
  const { psk: _psk, ...safe } = config;
  return safe;
}

export function deriveLocalAdapterToken(psk: Buffer): string {
  return createHmac("sha256", psk)
    .update("win98-mcp-local-adapter-v1\0", "ascii")
    .digest("hex");
}

function decodePsk(text: string): Buffer {
  if (text.startsWith("hex:")) {
    const value = text.slice(4);
    if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) {
      throw new Error("PSK_INVALID_HEX");
    }
    return Buffer.from(value, "hex");
  }
  if (text.startsWith("base64:")) {
    const value = text.slice(7);
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
      throw new Error("PSK_INVALID_BASE64");
    }
    return decoded;
  }
  return Buffer.from(text, "utf8");
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

export function isPrivateOrLoopbackBind(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  if (isIP(normalized) !== 4) return false;
  const octets = normalized.split(".").map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function splitRoots(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.split(delimiter).filter((item) => item.trim().length > 0);
}

function normalizeAllowedRoots(values: string[], cwd: string): string[] {
  if (values.length === 0) {
    throw new Error("CONFIG_INVALID:hostAllowedRoots");
  }
  return [...new Set(values.map((value) => resolveConfiguredPath(value, cwd)))];
}

export function configDirectory(config: BrokerConfig): string {
  return dirname(config.logPath);
}
