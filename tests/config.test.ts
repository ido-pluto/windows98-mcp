import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPipePath, loadBrokerConfig } from "../src/host/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("broker configuration", () => {
  it("accepts UTF-8 BOM JSON but always uses the all-interface v2 listener", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, `\uFEFF${JSON.stringify({ guestPort: 9999, stateDir: path.join(root, "state") })}`, "utf8");
    const config = await loadBrokerConfig({ configPath, cwd: root });
    expect(config.bindHost).toBe("0.0.0.0");
    expect(config.guestPort).toBe(9999);
    expect(config.guestConnectTimeoutMs).toBe(5_000);
  });

  it("defaults to port 9898 and a shared local pipe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    const config = await loadBrokerConfig({ cwd: root, env: { LOCALAPPDATA: root } });
    expect(config.guestPort).toBe(9898);
    expect(config.pipePath).toBe(defaultPipePath());
    expect(config.lockingEnabled).toBe(true);
  });

  it("accepts an explicit advisory parallel-mode setting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    const config = await loadBrokerConfig({
      cwd: root,
      env: { LOCALAPPDATA: root },
      overrides: { lockingEnabled: false }
    });
    expect(config.lockingEnabled).toBe(false);
  });

  it("isolates non-default brokers by port while preserving the default shared pipe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    const config = await loadBrokerConfig({
      cwd: root,
      overrides: { guestPort: 9999 }
    });
    expect(config.pipePath).toBe(defaultPipePath(9999));
    expect(config.pipePath).not.toBe(defaultPipePath(9898));
    expect(config.stateDir).toMatch(/port-9999$/u);
  });

  it("allows only a valid port override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    await expect(loadBrokerConfig({ cwd: root, overrides: { guestPort: 70_000 } })).rejects.toThrow("CONFIG_INVALID:guestPort");
  });
});
