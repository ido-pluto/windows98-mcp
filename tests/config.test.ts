import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBrokerConfig } from "../src/host/index.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("broker configuration", () => {
  it("accepts Windows PowerShell UTF-8 BOM JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    const configPath = path.join(root, "config.json");
    await writeFile(
      configPath,
      `\uFEFF${JSON.stringify({
        bindHost: "127.0.0.1",
        expectedGuestIp: "192.168.60.128",
        guestPort: 9898,
        psk: `hex:${"ab".repeat(32)}`,
        stateDir: path.join(root, "state"),
        hostAllowedRoots: [root]
      })}`,
      "utf8"
    );
    const config = await loadBrokerConfig({ configPath, cwd: root });
    expect(config.psk).toHaveLength(32);
    expect(config.expectedGuestIp).toBe("192.168.60.128");
    expect(config.hostAllowedRoots).toEqual([root]);
  });

  it("accepts the guest IP CLI environment override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    const config = await loadBrokerConfig({
      cwd: root,
      env: {
        WIN98_MCP_PSK: `hex:${"cd".repeat(32)}`,
        WIN98_MCP_GUEST_IP: "192.168.60.141"
      }
    });
    expect(config.expectedGuestIp).toBe("192.168.60.141");
  });

  it("rejects a non-IPv4 expected guest address", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    await expect(
      loadBrokerConfig({
        cwd: root,
        env: {
          WIN98_MCP_PSK: `hex:${"ef".repeat(32)}`,
          WIN98_MCP_GUEST_IP: "guest.local"
        }
      })
    ).rejects.toThrow(/CONFIG_INVALID:expectedGuestIp/u);
  });

  it("refuses a concrete public bind without an explicit override", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-config-"));
    roots.push(root);
    await expect(
      loadBrokerConfig({
        cwd: root,
        env: {
          WIN98_MCP_PSK: `hex:${"12".repeat(32)}`,
          WIN98_MCP_BIND_HOST: "203.0.113.10"
        }
      })
    ).rejects.toThrow(/PUBLIC_BIND_REFUSED/u);
  });
});
