import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  connectBroker,
  publicConfig,
  type BrokerConfig
} from "../host/index.js";

export async function collectDiagnostics(
  config: BrokerConfig,
  outputDirectory: string
): Promise<string> {
  const target = path.resolve(outputDirectory);
  await mkdir(target, { recursive: true });
  let status: unknown;
  try {
    const client = await connectBroker({
      pipePath: config.pipePath,
      sessionLabel: `diagnostics:${process.pid}`,
      requestTimeoutMs: 5_000
    });
    try {
      status = (await client.call("vm_status", {}, 5_000)).result;
    } finally {
      client.close();
    }
  } catch (error) {
    status = {
      ok: false,
      code: "BROKER_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  let brokerLog = "";
  try {
    brokerLog = await readFile(config.logPath, "utf8");
    const lines = brokerLog.trimEnd().split(/\r?\n/u);
    brokerLog = lines.slice(-2_000).join("\n");
  } catch {
    brokerLog = "";
  }

  const manifest = {
    collectedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    config: publicConfig(config),
    status
  };
  await Promise.all([
    writeFile(
      path.join(target, "diagnostics.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    ),
    writeFile(path.join(target, "broker-tail.jsonl"), brokerLog, "utf8")
  ]);
  return target;
}
