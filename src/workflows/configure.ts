import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { isPrivateOrLoopbackBind } from "../host/config.js";

const RELEASE_URL =
  "https://github.com/ido-pluto/windows98-mcp/releases/latest/download/windows98-mcp-guest.zip";

export interface ConfigureInstallationOptions {
  workspaceRoot: string;
  guestDirectory: string;
  configPath?: string;
  bindHost?: string;
  expectedGuestIp?: string;
  guestPort?: number;
  stateDir?: string;
  hostAllowedRoots?: string[];
}

export interface ConfigureInstallationResult {
  ok: true;
  configPath: string;
  guestIniPath: string;
  guestExeFound: boolean;
  guestDownloadUrl: string;
  pskReused: boolean;
  nextStep: string;
}

export async function configureInstallation(
  options: ConfigureInstallationOptions
): Promise<ConfigureInstallationResult> {
  const workspace = path.resolve(options.workspaceRoot);
  const bindHost = requiredIpv4(options.bindHost, "--bind");
  const expectedGuestIp = requiredIpv4(options.expectedGuestIp, "--ip");
  if (!isPrivateOrLoopbackBind(bindHost)) {
    throw new Error("PUBLIC_BIND_REFUSED: use the host-only adapter address");
  }
  const guestPort = options.guestPort ?? 9898;
  if (!Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) {
    throw new Error("CONFIG_INVALID:guestPort");
  }

  const configPath = path.resolve(
    workspace,
    options.configPath ?? path.join(".win98-mcp", "config.json")
  );
  const guestDirectory = path.resolve(workspace, options.guestDirectory);
  const guestIniPath = path.join(guestDirectory, "WIN98CTL.INI");
  const existingPsk = await readExistingPsk(configPath);
  const pskHex = existingPsk ?? randomBytes(32).toString("hex");
  const stateDir = path.resolve(
    workspace,
    options.stateDir ?? path.join(path.dirname(configPath), "state")
  );
  const hostAllowedRoots = (options.hostAllowedRoots ?? [workspace]).map((root) =>
    path.resolve(workspace, root)
  );

  const hostConfig = {
    bindHost,
    expectedGuestIp,
    guestPort,
    psk: `hex:${pskHex}`,
    stateDir,
    hostAllowedRoots
  };
  const guestIni = [
    "[connection]",
    `host=${bindHost}`,
    `port=${guestPort}`,
    "",
    "[identity]",
    "guest_id=win98-vm",
    "",
    "[security]",
    `psk_hex=${pskHex}`,
    ""
  ].join("\r\n");

  await Promise.all([
    mkdir(path.dirname(configPath), { recursive: true }),
    mkdir(guestDirectory, { recursive: true })
  ]);
  await Promise.all([
    writeFile(configPath, `${JSON.stringify(hostConfig, null, 2)}\n`, "utf8"),
    writeFile(guestIniPath, guestIni, "ascii")
  ]);

  const guestExeFound = await exists(path.join(guestDirectory, "WIN98CTL.EXE"));
  return {
    ok: true,
    configPath,
    guestIniPath,
    guestExeFound,
    guestDownloadUrl: RELEASE_URL,
    pskReused: existingPsk !== undefined,
    nextStep: guestExeFound
      ? "Copy this complete guest directory to Windows 98 and run RUNTEST.BAT."
      : "Download and extract the latest Windows 98 guest release into this directory, then run configure again."
  };
}

async function readExistingPsk(configPath: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as { psk?: unknown };
  if (
    typeof parsed.psk !== "string" ||
    !/^hex:[0-9a-f]{64}$/iu.test(parsed.psk)
  ) {
    throw new Error("CONFIG_INVALID: existing config has no reusable 32-byte PSK");
  }
  return parsed.psk.slice("hex:".length).toLowerCase();
}

function requiredIpv4(value: string | undefined, option: string): string {
  if (!value) throw new Error(`CLI_VALUE_REQUIRED:${option}`);
  const normalized = value.trim();
  if (isIP(normalized) !== 4) throw new Error(`CLI_INVALID:${option}`);
  return normalized;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
