import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Broker, connectBroker, loadBrokerConfig, type BrokerConfig } from "../src/host/index.js";
import { SimulatedGuest } from "../src/simulator/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("upstream guest bridge", () => {
  it("forwards one VM connection to a normal upstream broker without changing guest frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "win98-upstream-"));
    roots.push(root);
    const localPort = await freePort();
    const upstreamPort = await freePort();
    const remoteConfig = await config(root, upstreamPort);
    const localConfig = await config(root, localPort, "127.0.0.1", upstreamPort);
    const remote = new Broker(remoteConfig);
    const local = new Broker(localConfig);
    const guest = new SimulatedGuest({ host: "127.0.0.1", port: localPort, rootDirectory: join(root, "guest") });
    try {
      await remote.start();
      await local.start();
      const connected = onceEvent(guest, "connected");
      await guest.start();
      await connected;
      const client = await connectBroker({ pipePath: remoteConfig.pipePath, sessionLabel: "upstream-test" });
      try {
        const online = await client.call("vm_status");
        expect(online.result.connection.state).toBe("online");
        const message = await client.call("show_message", { message: "through bridge" });
        expect(message.result.ok).toBe(true);
        const capture = await client.call("screen_capture");
        expect(capture.result.ok).toBe(true);
        expect(capture.image?.data.length).toBeGreaterThan(100);
        await client.call("vm_unlock", { force: true });
      } finally {
        client.close();
      }
    } finally {
      await guest.stop();
      await local.stop();
      await remote.stop();
    }
  });
});

async function config(root: string, port: number, upstreamHost?: string, upstreamPort?: number): Promise<BrokerConfig> {
  return loadBrokerConfig({
    cwd: root,
    env: { LOCALAPPDATA: root },
    overrides: {
      guestPort: port,
      stateDir: join(root, `state-${port}`),
      ...(upstreamHost && upstreamPort ? { upstreamHost, upstreamPort } : {})
    }
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("TEST_PORT_UNAVAILABLE");
  return address.port;
}

function onceEvent(target: { once(event: string, listener: () => void): unknown }, event: string): Promise<void> {
  return new Promise((resolve) => target.once(event, resolve));
}
