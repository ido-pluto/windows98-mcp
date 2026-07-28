import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";

describe("CLI options", () => {
  it("defaults npx invocation to the stdio MCP adapter", () => {
    expect(parseCliArgs([])).toMatchObject({ command: "stdio" });
  });

  it("maps --ip to an expected guest source IP", () => {
    expect(parseCliArgs(["--ip", "192.168.60.128"])).toMatchObject({
      command: "stdio",
      overrides: { expectedGuestIp: "192.168.60.128" },
      configArgs: ["--ip", "192.168.60.128"]
    });
  });

  it("accepts network options after a command", () => {
    expect(
      parseCliArgs([
        "doctor",
        "--bind=192.168.60.1",
        "--port",
        "9898",
        "--host-root",
        "C:\\MCP"
      ])
    ).toMatchObject({
      command: "doctor",
      overrides: {
        bindHost: "192.168.60.1",
        guestPort: 9898,
        hostAllowedRoots: ["C:\\MCP"]
      }
    });
  });

  it("preserves configure-specific guest directory arguments", () => {
    expect(
      parseCliArgs([
        "configure",
        "--bind",
        "192.168.60.1",
        "--ip",
        "192.168.60.128",
        "--guest-dir",
        "C:\\WIN98CTL"
      ])
    ).toMatchObject({
      command: "configure",
      overrides: {
        bindHost: "192.168.60.1",
        expectedGuestIp: "192.168.60.128"
      },
      commandArgs: ["--guest-dir", "C:\\WIN98CTL"]
    });
  });
});
