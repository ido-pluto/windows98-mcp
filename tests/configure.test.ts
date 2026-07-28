import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureInstallation } from "../src/workflows/configure.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("host and downloaded guest configuration", () => {
  it("writes matching configs without returning the PSK", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "windows98-mcp-configure-"));
    roots.push(root);
    const guestDirectory = path.join(root, "guest-download");
    await configureInstallation({
      workspaceRoot: root,
      guestDirectory,
      bindHost: "192.168.60.1",
      expectedGuestIp: "192.168.60.128"
    });
    await writeFile(path.join(guestDirectory, "WIN98CTL.EXE"), "MZ", "ascii");
    const second = await configureInstallation({
      workspaceRoot: root,
      guestDirectory,
      bindHost: "192.168.60.1",
      expectedGuestIp: "192.168.60.141"
    });

    expect(second).toMatchObject({
      ok: true,
      guestExeFound: true,
      pskReused: true
    });
    expect(JSON.stringify(second)).not.toMatch(/[0-9a-f]{64}/iu);

    const host = JSON.parse(
      await readFile(path.join(root, ".win98-mcp", "config.json"), "utf8")
    ) as { psk: string; expectedGuestIp: string };
    const guest = await readFile(path.join(guestDirectory, "WIN98CTL.INI"), "ascii");
    expect(host.expectedGuestIp).toBe("192.168.60.141");
    expect(guest).toContain(`psk_hex=${host.psk.slice("hex:".length)}`);
    expect(guest).toContain("host=192.168.60.1");
  });

  it("rejects public or non-IPv4 configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "windows98-mcp-configure-"));
    roots.push(root);
    await expect(
      configureInstallation({
        workspaceRoot: root,
        guestDirectory: "guest",
        bindHost: "0.0.0.0",
        expectedGuestIp: "192.168.60.128"
      })
    ).rejects.toThrow(/PUBLIC_BIND_REFUSED/u);
  });
});
