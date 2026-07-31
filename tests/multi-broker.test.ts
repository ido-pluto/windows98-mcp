import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectBroker,
  defaultPipePath,
  startBroker,
  type Broker,
  type BrokerClient,
  type BrokerConfig
} from "../src/host/index.js";

const resources: Array<{ broker: Broker; root: string; client?: BrokerClient }> = [];

afterEach(async () => {
  for (const item of resources.splice(0)) {
    item.client?.close();
    await item.broker.stop();
    await rm(item.root, { recursive: true, force: true });
  }
});

describe("port-scoped broker instances", () => {
  it("runs independent local brokers for two guest listener ports", async () => {
    const first = await createBroker();
    const second = await createBroker(first.config.guestPort);
    expect(first.config.guestPort).not.toBe(second.config.guestPort);
    expect(first.config.pipePath).not.toBe(second.config.pipePath);

    first.client = await connectBroker({
      pipePath: first.config.pipePath,
      sessionLabel: "admin-port-one"
    });
    second.client = await connectBroker({
      pipePath: second.config.pipePath,
      sessionLabel: "admin-port-two"
    });

    const [one, two] = await Promise.all([
      first.client.call("vm_status"),
      second.client.call("vm_status")
    ]);
    expect(one.result.data).toMatchObject({
      broker: { guestPort: first.config.guestPort, pipePath: first.config.pipePath }
    });
    expect(two.result.data).toMatchObject({
      broker: { guestPort: second.config.guestPort, pipePath: second.config.pipePath }
    });
  });
});

async function createBroker(excludedPort?: number): Promise<{ broker: Broker; root: string; config: BrokerConfig; client?: BrokerClient }> {
  const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-multi-"));
  let guestPort = await freePort();
  while (guestPort === 9898 || guestPort === excludedPort) guestPort = await freePort();
  const config: BrokerConfig = {
    bindHost: "0.0.0.0",
    guestPort,
    pipePath: defaultPipePath(guestPort),
    stateDir: root,
    artifactDir: path.join(root, "artifacts"),
    logPath: path.join(root, "broker.jsonl"),
    leaseTtlMs: 30 * 60 * 1000,
    waitTicketTtlMs: 10 * 60 * 1000,
    requestTimeoutMs: 10_000,
    guestConnectTimeoutMs: 5_000,
    heartbeatTimeoutMs: 30_000,
    maxArtifactBytes: 8 * 1024 * 1024
  };
  const broker = await startBroker(config);
  const item = { broker, root, config };
  resources.push(item);
  return item;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("FREE_PORT_UNAVAILABLE");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
