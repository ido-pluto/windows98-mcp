import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-options.js";

describe("CLI options", () => {
  it("defaults npx invocation to the stdio MCP adapter", () => {
    expect(parseCliArgs([])).toMatchObject({ command: "stdio" });
  });

  it("accepts a port override after a command", () => {
    expect(parseCliArgs(["doctor", "--port", "9899"])).toMatchObject({
      command: "doctor",
      overrides: { guestPort: 9899 },
      configArgs: ["--port", "9899"]
    });
  });

  it("accepts a remote broker host and its TCP control port", () => {
    expect(parseCliArgs(["--broker-host", "100.79.57.62", "--broker-port", "9899"])).toMatchObject({
      command: "stdio",
      brokerHost: "100.79.57.62",
      brokerPort: 9899,
      overrides: { adapterPort: 9899 }
    });
  });

  it("accepts the desktop sidecar's local transfer request", () => {
    expect(parseCliArgs([
      "client-transfer",
      "--broker-host", "100.79.57.62",
      "--broker-port", "9899",
      "--transfer-request", '{"method":"file_push","params":{}}'
    ])).toMatchObject({
      command: "client-transfer",
      brokerHost: "100.79.57.62",
      brokerPort: 9899,
      transferRequest: '{"method":"file_push","params":{}}'
    });
  });

  it("rejects removed guest filtering/configuration options", () => {
    expect(() => parseCliArgs(["--ip", "192.168.60.128"])).toThrow("CLI_UNKNOWN_OPTION:--ip");
    expect(() => parseCliArgs(["configure"])).toThrow("UNKNOWN_COMMAND:configure");
  });
});
