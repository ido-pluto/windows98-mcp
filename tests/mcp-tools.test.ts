import { describe, expect, it } from "vitest";
import {
  brokerTimeout,
  MCP_SERVER_INSTRUCTIONS,
  TOOL_DEFINITIONS,
  toolCatalog,
  validateToolParams
} from "../src/mcp/index.js";

describe("MCP tool surface", () => {
  it("advertises the explicit mouse and keyboard controls", () => {
    const names = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
    expect([...names]).toEqual(
      expect.arrayContaining([
          "screen_capture",
          "mouse_move",
          "mouse_click",
          "mouse_down",
          "mouse_up",
          "mouse_drag",
          "mouse_scroll",
          "mouse_position",
          "mouse_release_all",
          "keyboard_type",
          "keyboard_key",
          "keyboard_hotkey",
          "keyboard_keycode",
          "keyboard_release_all",
          "input_batch",
          "show_message"
        ])
    );
  });

  it("validates the Windows 98 message popup request", () => {
    const schema = requireTool("show_message").inputSchema;
    expect(schema.safeParse({ message: "Connection test" }).success).toBe(true);
    expect(schema.safeParse({ message: "" }).success).toBe(false);
  });

  it("exposes non-locking crash and supervisor diagnostics", () => {
    const diagnostics = requireTool("agent_diagnostics");
    expect(diagnostics.annotations?.readOnlyHint).toBe(true);
    expect(diagnostics.inputSchema.safeParse({}).success).toBe(true);
  });

  it("shares the complete MCP schema catalog with non-MCP clients", () => {
    expect(toolCatalog().map((tool) => tool.name)).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(validateToolParams("mouse_click", { x: 10, y: 20 })).toMatchObject({
      ok: true,
      params: { button: "left", click_count: 1, interval_ms: 100 }
    });
    expect(validateToolParams("mouse_click", { x: 10 })).toMatchObject({ ok: false });
    expect(validateToolParams("not_a_tool", {})).toMatchObject({ ok: false });
  });

  it("front-loads lease cleanup instructions", () => {
    expect(MCP_SERVER_INSTRUCTIONS.slice(0, 512)).toMatch(/vm_unlock/u);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/disconnect/iu);
  });

  it("marks consequential process, file, and system actions as destructive", () => {
    for (const name of [
      "process_kill",
      "fs_delete",
      "system_reboot",
      "system_shutdown"
    ]) {
      const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      expect(tool?.annotations?.destructiveHint, name).toBe(true);
    }
  });

  it("requires optional mouse coordinates as a complete x/y pair", () => {
    for (const name of [
      "mouse_click",
      "mouse_down",
      "mouse_up",
      "mouse_scroll"
    ]) {
      const schema = requireTool(name).inputSchema;
      const base = name === "mouse_scroll" ? { delta: 120 } : {};
      expect(schema.safeParse({ ...base, x: 10 }).success, name).toBe(false);
      expect(schema.safeParse({ ...base, y: 10 }).success, name).toBe(false);
      expect(
        schema.safeParse({ ...base, x: 10, y: 20 }).success,
        name
      ).toBe(true);
      expect(schema.safeParse(base).success, name).toBe(true);
    }

    const batch = requireTool("input_batch").inputSchema;
    expect(
      batch.safeParse({
        actions: [{ type: "mouse_click", x: 10 }]
      }).success
    ).toBe(false);
  });

  it("bounds shell output and estimated keyboard/input batch duration", () => {
    const shellRead = requireTool("shell_read").inputSchema;
    expect(
      shellRead.safeParse({
        session_id: "terminal-1",
        max_bytes: 128 * 1024
      }).success
    ).toBe(true);
    expect(
      shellRead.safeParse({
        session_id: "terminal-1",
        max_bytes: 128 * 1024 + 1
      }).success
    ).toBe(false);

    const keyboardType = requireTool("keyboard_type").inputSchema;
    expect(
      keyboardType.safeParse({
        text: "x".repeat(180),
        interval_ms: 10_000
      }).success
    ).toBe(true);
    expect(
      keyboardType.safeParse({
        text: "x".repeat(181),
        interval_ms: 10_000
      }).success
    ).toBe(false);

    const batch = requireTool("input_batch").inputSchema;
    expect(
      batch.safeParse({
        actions: [
          { type: "delay", milliseconds: 600_000 },
          { type: "delay", milliseconds: 600_000 },
          { type: "delay", milliseconds: 600_000 }
        ]
      }).success
    ).toBe(true);
    expect(
      batch.safeParse({
        actions: [
          { type: "delay", milliseconds: 600_000 },
          { type: "delay", milliseconds: 600_000 },
          { type: "delay", milliseconds: 600_000 },
          { type: "mouse_drag", from_x: 0, from_y: 0, to_x: 1, to_y: 1 }
        ]
      }).success
    ).toBe(false);
  });

  it("extends adapter timeouts to cover estimated input duration", () => {
    expect(
      brokerTimeout("mouse_move", { duration_ms: 600_000 })
    ).toBe(630_000);
    expect(
      brokerTimeout("mouse_click", {
        click_count: 3,
        interval_ms: 10_000
      })
    ).toBe(50_000);
    expect(
      brokerTimeout("keyboard_type", {
        text: "abc",
        interval_ms: 1_000
      })
    ).toBe(33_000);
    expect(
      brokerTimeout("input_batch", {
        actions: [
          { type: "delay", milliseconds: 20_000 },
          {
            type: "mouse_drag",
            from_x: 0,
            from_y: 0,
            to_x: 1,
            to_y: 1,
            duration_ms: 5_000
          }
        ]
      })
    ).toBe(55_000);
  });
});

function requireTool(name: string) {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing tool ${name}`);
  }
  return tool;
}
