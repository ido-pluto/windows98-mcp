import type { BrokerConfigFile } from "./host/config.js";

export const CLI_COMMANDS = [
  "broker",
  "stdio",
  "doctor",
  "simulator",
  "smoke-test",
  "diagnostics",
  "help",
  "version"
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

export interface ParsedCliOptions {
  command: CliCommand;
  commandArgs: string[];
  configArgs: string[];
  configPath?: string;
  overrides: BrokerConfigFile;
  brokerHost?: string;
  brokerPort?: number;
}

const COMMANDS = new Set<string>(CLI_COMMANDS);

export function parseCliArgs(argv: string[]): ParsedCliOptions {
  let command: CliCommand | undefined;
  let configPath: string | undefined;
  const commandArgs: string[] = [];
  const configArgs: string[] = [];
  const overrides: BrokerConfigFile = {};
  let brokerHost: string | undefined;
  let brokerPort: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;

    if (token === "--help" || token === "-h") {
      command = "help";
      continue;
    }
    if (token === "--version" || token === "-V") {
      command = "version";
      continue;
    }

    const option = splitOption(token);
    if (option.name === "--port") {
      const value = option.value ?? requireValue(argv, ++index, option.name);
      const port = Number(value);
      if (!Number.isInteger(port)) throw new Error("CLI_INVALID:--port");
      overrides.guestPort = port;
      configArgs.push("--port", value);
      continue;
    }
    if (option.name === "--broker-host") {
      const value = option.value ?? requireValue(argv, ++index, option.name);
      if (!value.trim()) throw new Error("CLI_INVALID:--broker-host");
      brokerHost = value.trim();
      continue;
    }
    if (option.name === "--broker-port") {
      const value = option.value ?? requireValue(argv, ++index, option.name);
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CLI_INVALID:--broker-port");
      brokerPort = port;
      overrides.adapterPort = port;
      configArgs.push("--adapter-port", value);
      continue;
    }
    if (option.name === "--adapter-port") {
      const value = option.value ?? requireValue(argv, ++index, option.name);
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CLI_INVALID:--adapter-port");
      overrides.adapterPort = port;
      configArgs.push("--adapter-port", value);
      continue;
    }
    if (option.name === "--config") {
      const value = option.value ?? requireValue(argv, ++index, option.name);
      configPath = value;
      configArgs.push("--config", value);
      continue;
    }
    if (option.name === "--state-dir") {
      const value = option.value ?? requireValue(argv, ++index, option.name);
      overrides.stateDir = value;
      configArgs.push("--state-dir", value);
      continue;
    }
    if (option.name === "--upstream") {
      const value = option.value ?? requireValue(argv, ++index, option.name);
      const separator = value.lastIndexOf(":");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error("CLI_INVALID:--upstream (use host:port)");
      }
      const host = value.slice(0, separator).trim();
      const port = Number(value.slice(separator + 1));
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("CLI_INVALID:--upstream (use host:port)");
      }
      overrides.upstreamHost = host;
      overrides.upstreamPort = port;
      configArgs.push("--upstream", value);
      continue;
    }

    if (!command && COMMANDS.has(token)) {
      command = token as CliCommand;
      continue;
    }
    if (!command && token.startsWith("-")) {
      throw new Error(`CLI_UNKNOWN_OPTION:${token}`);
    }
    if (!command) {
      throw new Error(`UNKNOWN_COMMAND:${token}`);
    }
    commandArgs.push(token);
  }

  return {
    command: command ?? "stdio",
    commandArgs,
    configArgs,
    ...(configPath ? { configPath } : {}),
    overrides
    , ...(brokerHost ? { brokerHost } : {})
    , ...(brokerPort !== undefined ? { brokerPort } : {})
  };
}

function splitOption(token: string): { name: string; value?: string } {
  const separator = token.indexOf("=");
  if (separator < 0) return { name: token };
  return {
    name: token.slice(0, separator),
    value: token.slice(separator + 1)
  };
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`CLI_VALUE_REQUIRED:${option}`);
  }
  return value;
}
