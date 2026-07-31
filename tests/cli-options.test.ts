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

  it("rejects removed guest filtering/configuration options", () => {
    expect(() => parseCliArgs(["--ip", "192.168.60.128"])).toThrow("CLI_UNKNOWN_OPTION:--ip");
    expect(() => parseCliArgs(["configure"])).toThrow("UNKNOWN_COMMAND:configure");
  });
});
