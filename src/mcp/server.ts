import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../shared/package-info.js";
import type { BrokerResponse, ToolResult } from "../shared/types.js";
import { UNLOCK_REMINDER } from "../shared/types.js";
import { BrokerClient, BrokerClientError } from "./broker-client.js";

export const MCP_SERVER_INSTRUCTIONS = `LOCKING AND CLEANUP ARE MANDATORY:
1. vm_status and vm_capabilities are the only calls that never acquire the VM lease.
2. The first VM-affecting call automatically locks the VM to this MCP session. Explicit vm_lock is optional.
3. After every operational result, including an error, assume the VM is still locked by this session.
4. Always call vm_unlock when the task is finished. Close active shell sessions and transfers first, or use vm_unlock(force=true) only when cleanup must be forced.
5. If a call returns VM_BUSY, use the returned queue information and vm_wait (maximum ten minutes); do not attempt parallel control.
6. Never leave keys or mouse buttons held. Use keyboard_release_all and mouse_release_all after interrupted low-level input.
7. MCP disconnect automatically aborts owned work and releases the lease after the guest confirms cleanup.

Coordinates are zero-based physical pixels on the primary Windows 98 display. Take a fresh screen_capture before coordinate-based input when screen state may have changed. shell_read is cursor-based streaming; full-screen DOS/TUI programs are unsupported.`;

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ObjectSchema | z.ZodType<Record<string, unknown>>;
  annotations: ToolAnnotations;
}

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const mutating: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

const destructive: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const empty = z.strictObject({});
const MAX_INPUT_RUNTIME_MS = 30 * 60 * 1_000;
const TOOL_TIMEOUT_MARGIN_MS = 30_000;
const SHELL_READ_MAX_BYTES = 128 * 1024;
const coordinate = z
  .number()
  .int()
  .min(0)
  .max(65_535)
  .describe("Zero-based physical screen coordinate.");
const duration = z.number().int().min(0).max(600_000);
const mouseButton = z.enum(["left", "right", "middle"]);
const keyAction = z.enum(["down", "up", "press"]);
const windowId = z
  .number()
  .int()
  .min(0)
  .max(0xffff_ffff)
  .describe("Window handle returned by window_list.");
const processId = z.number().int().min(0).max(0xffff_ffff);
const guestPath = z.string().min(1).max(260);
const hostPath = z.string().min(1);

const regionSchema = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: z.number().int().min(1).max(65_536),
  height: z.number().int().min(1).max(65_536)
});

const inputActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("mouse_move"),
    x: coordinate,
    y: coordinate,
    duration_ms: duration.optional()
  }),
  z.strictObject({
    type: z.literal("mouse_click"),
    x: coordinate.optional(),
    y: coordinate.optional(),
    button: mouseButton.optional(),
    click_count: z.number().int().min(1).max(3).optional(),
    interval_ms: z.number().int().min(0).max(10_000).optional()
  }),
  z.strictObject({
    type: z.literal("mouse_down"),
    button: mouseButton.optional(),
    x: coordinate.optional(),
    y: coordinate.optional()
  }),
  z.strictObject({
    type: z.literal("mouse_up"),
    button: mouseButton.optional(),
    x: coordinate.optional(),
    y: coordinate.optional()
  }),
  z.strictObject({
    type: z.literal("mouse_drag"),
    from_x: coordinate,
    from_y: coordinate,
    to_x: coordinate,
    to_y: coordinate,
    button: mouseButton.optional(),
    duration_ms: duration.optional(),
    steps: z.number().int().min(1).max(1_000).optional()
  }),
  z.strictObject({
    type: z.literal("mouse_scroll"),
    delta: z.number().int().min(-120_000).max(120_000),
    x: coordinate.optional(),
    y: coordinate.optional()
  }),
  z.strictObject({
    type: z.literal("keyboard_type"),
    text: z.string(),
    interval_ms: z.number().int().min(0).max(10_000).optional()
  }),
  z.strictObject({
    type: z.literal("keyboard_key"),
    key: z.string().min(1).max(64),
    action: keyAction.optional()
  }),
  z.strictObject({
    type: z.literal("keyboard_hotkey"),
    keys: z.array(z.string().min(1).max(64)).min(1).max(16)
  }),
  z
    .strictObject({
      type: z.literal("keyboard_keycode"),
      virtual_key: z.number().int().min(0).max(255).optional(),
      scan_code: z.number().int().min(0).max(255).optional(),
      action: keyAction.optional(),
      extended: z.boolean().optional()
    })
    .refine(
      (value) =>
        value.virtual_key !== undefined || value.scan_code !== undefined,
      "virtual_key or scan_code is required"
    ),
  z.strictObject({
    type: z.literal("delay"),
    milliseconds: duration
  }),
  z.strictObject({
    type: z.literal("clipboard_set"),
    text: z.string()
  }),
  z.strictObject({
    type: z.literal("window_focus"),
    window_id: windowId
  })
]).refine(hasCompleteOptionalPoint, {
  message: "x and y must be provided together",
  path: ["x"]
});

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "vm_status",
    description:
      "Inspect guest connection and lease state without acquiring the VM lease.",
    inputSchema: empty,
    annotations: readOnly
  },
  {
    name: "vm_capabilities",
    description:
      "Read the connected Windows 98 guest capabilities without acquiring the VM lease.",
    inputSchema: empty,
    annotations: readOnly
  },
  {
    name: "vm_lock",
    description:
      "Explicitly acquire the exclusive VM lease. Most operational tools acquire it automatically.",
    inputSchema: empty,
    annotations: { ...mutating, idempotentHint: true }
  },
  {
    name: "vm_wait",
    description:
      "Wait in the FIFO lease queue for at most ten minutes. Use after VM_BUSY.",
    inputSchema: z.strictObject({
      wait_seconds: z.number().int().min(1).max(600)
    }),
    annotations: mutating
  },
  {
    name: "vm_unlock",
    description:
      "Release this session's VM lease. Normal unlock refuses while terminals or transfers remain open.",
    inputSchema: z.strictObject({
      force: z.boolean().default(false)
    }),
    annotations: { ...mutating, idempotentHint: true }
  },
  {
    name: "show_message",
    description:
      "Display a Windows 98 message dialog titled Windows 98 Remote Control. Acquires the VM lease.",
    inputSchema: z.strictObject({
      message: z.string().min(1).max(8_192)
    }),
    annotations: mutating
  },
  {
    name: "screen_capture",
    description:
      "Capture the primary display or a pixel region as native MCP PNG image content. Acquires the VM lease.",
    inputSchema: z.strictObject({
      region: regionSchema.optional(),
      include_cursor: z.boolean().default(true)
    }),
    annotations: readOnly
  },
  {
    name: "mouse_move",
    description:
      "Move the mouse to an exact zero-based physical pixel coordinate.",
    inputSchema: z.strictObject({
      x: coordinate,
      y: coordinate,
      duration_ms: duration.default(0)
    }),
    annotations: { ...mutating, idempotentHint: true }
  },
  {
    name: "mouse_click",
    description:
      "Click at the supplied coordinates, or at the current pointer position when omitted.",
    inputSchema: z
      .strictObject({
        x: coordinate.optional(),
        y: coordinate.optional(),
        button: mouseButton.default("left"),
        click_count: z.number().int().min(1).max(3).default(1),
        interval_ms: z.number().int().min(0).max(10_000).default(100)
      })
      .refine(hasCompleteOptionalPoint, {
        message: "x and y must be provided together",
        path: ["x"]
      }),
    annotations: mutating
  },
  {
    name: "mouse_down",
    description:
      "Hold a mouse button down, optionally moving to coordinates first. Always release it later.",
    inputSchema: z
      .strictObject({
        button: mouseButton.default("left"),
        x: coordinate.optional(),
        y: coordinate.optional()
      })
      .refine(hasCompleteOptionalPoint, {
        message: "x and y must be provided together",
        path: ["x"]
      }),
    annotations: mutating
  },
  {
    name: "mouse_up",
    description:
      "Release a held mouse button, optionally moving to coordinates first.",
    inputSchema: z
      .strictObject({
        button: mouseButton.default("left"),
        x: coordinate.optional(),
        y: coordinate.optional()
      })
      .refine(hasCompleteOptionalPoint, {
        message: "x and y must be provided together",
        path: ["x"]
      }),
    annotations: { ...mutating, idempotentHint: true }
  },
  {
    name: "mouse_drag",
    description:
      "Drag between exact pixel coordinates while holding the selected mouse button.",
    inputSchema: z.strictObject({
      from_x: coordinate,
      from_y: coordinate,
      to_x: coordinate,
      to_y: coordinate,
      button: mouseButton.default("left"),
      duration_ms: duration.default(500),
      steps: z.number().int().min(1).max(1_000).default(20)
    }),
    annotations: mutating
  },
  {
    name: "mouse_scroll",
    description:
      "Send a mouse-wheel delta at optional coordinates. Requires guest wheel support.",
    inputSchema: z
      .strictObject({
        delta: z.number().int().min(-120_000).max(120_000),
        x: coordinate.optional(),
        y: coordinate.optional()
      })
      .refine(hasCompleteOptionalPoint, {
        message: "x and y must be provided together",
        path: ["x"]
      }),
    annotations: mutating
  },
  {
    name: "mouse_position",
    description: "Read the current mouse pointer position.",
    inputSchema: empty,
    annotations: readOnly
  },
  {
    name: "mouse_release_all",
    description: "Release every mouse button tracked as held by this session.",
    inputSchema: empty,
    annotations: { ...mutating, idempotentHint: true }
  },
  {
    name: "keyboard_type",
    description:
      "Type text with the active Windows 98 keyboard layout; fails rather than substituting unrepresentable characters.",
    inputSchema: z
      .strictObject({
        text: z.string(),
        interval_ms: z.number().int().min(0).max(10_000).default(10)
      })
      .refine(
        (value) =>
          estimateKeyboardRuntime(value.text, value.interval_ms) <=
          MAX_INPUT_RUNTIME_MS,
        {
          message: "estimated keyboard runtime must not exceed 30 minutes",
          path: ["interval_ms"]
        }
      ),
    annotations: mutating
  },
  {
    name: "keyboard_key",
    description:
      "Press, hold, or release a named key such as ENTER, CTRL, LEFT, or F1.",
    inputSchema: z.strictObject({
      key: z.string().min(1).max(64),
      action: keyAction.default("press")
    }),
    annotations: mutating
  },
  {
    name: "keyboard_hotkey",
    description:
      "Press named keys in order and release them in reverse order.",
    inputSchema: z.strictObject({
      keys: z.array(z.string().min(1).max(64)).min(1).max(16)
    }),
    annotations: mutating
  },
  {
    name: "keyboard_keycode",
    description:
      "Send a low-level Win32 virtual-key or scan-code input event.",
    inputSchema: z
      .strictObject({
        virtual_key: z.number().int().min(0).max(255).optional(),
        scan_code: z.number().int().min(0).max(255).optional(),
        action: keyAction.default("press"),
        extended: z.boolean().default(false)
      })
      .refine(
        (value) =>
          value.virtual_key !== undefined || value.scan_code !== undefined,
        "virtual_key or scan_code is required"
      ),
    annotations: mutating
  },
  {
    name: "keyboard_release_all",
    description: "Release every keyboard key tracked as held by this session.",
    inputSchema: empty,
    annotations: { ...mutating, idempotentHint: true }
  },
  {
    name: "input_batch",
    description:
      "Execute a validated mouse, keyboard, delay, clipboard, and focus sequence in one guest round trip.",
    inputSchema: z
      .strictObject({
        actions: z.array(inputActionSchema).min(1).max(1_000),
        screenshot_after: z.boolean().default(false),
        stop_on_error: z.boolean().default(true)
      })
      .refine(
        (value) => estimateInputBatchRuntime(value.actions) <= MAX_INPUT_RUNTIME_MS,
        {
          message: "estimated input batch runtime must not exceed 30 minutes",
          path: ["actions"]
        }
      ),
    annotations: mutating
  },
  {
    name: "clipboard_get",
    description: "Read text from the Windows 98 clipboard.",
    inputSchema: z.strictObject({
      format: z.literal("text").default("text")
    }),
    annotations: readOnly
  },
  {
    name: "clipboard_set",
    description: "Replace Windows 98 clipboard text.",
    inputSchema: z.strictObject({
      text: z.string()
    }),
    annotations: mutating
  },
  {
    name: "window_list",
    description:
      "List windows with handle, title, class, process, visibility, enabled state, and screen rectangle.",
    inputSchema: z.strictObject({
      visible_only: z.boolean().default(true)
    }),
    annotations: readOnly
  },
  {
    name: "window_focus",
    description: "Bring a window returned by window_list to the foreground.",
    inputSchema: z.strictObject({
      window_id: windowId
    }),
    annotations: mutating
  },
  {
    name: "window_close",
    description: "Request that a selected window close.",
    inputSchema: z.strictObject({
      window_id: windowId
    }),
    annotations: destructive
  },
  {
    name: "window_capture",
    description: "Capture a selected window as native MCP PNG image content.",
    inputSchema: z.strictObject({
      window_id: windowId
    }),
    annotations: readOnly
  },
  {
    name: "shell_exec",
    description:
      "Run a command to completion with captured ordered stdout+stderr output; error results may include a screenshot.",
    inputSchema: z.strictObject({
      command: z.string().min(1),
      cwd: guestPath.optional(),
      timeout_ms: z.number().int().min(1).max(30 * 60 * 1_000).optional(),
      screenshot_on_error: z.boolean().default(true)
    }),
    annotations: destructive
  },
  {
    name: "shell_start",
    description:
      "Start an interactive redirected-pipe shell session and return its session ID.",
    inputSchema: z.strictObject({
      command: z.string().min(1),
      cwd: guestPath.optional()
    }),
    annotations: destructive
  },
  {
    name: "shell_read",
    description:
      "Read bounded output after a cursor from an interactive shell, optionally long-polling.",
    inputSchema: z.strictObject({
      session_id: z.string().min(1),
      after_cursor: z.number().int().min(0).optional(),
      max_bytes: z.number().int().min(1).max(SHELL_READ_MAX_BYTES).optional(),
      wait_ms: z.number().int().min(0).max(60_000).optional()
    }),
    annotations: readOnly
  },
  {
    name: "shell_write",
    description:
      "Write UTF-8 text or base64 bytes to an interactive shell and optionally close stdin.",
    inputSchema: z
      .strictObject({
        session_id: z.string().min(1),
        text: z.string().optional(),
        base64: z.string().optional(),
        eof: z.boolean().default(false)
      })
      .refine(
        (value) =>
          value.text !== undefined ||
          value.base64 !== undefined ||
          value.eof,
        "text, base64, or eof=true is required"
      )
      .refine(
        (value) =>
          !(value.text !== undefined && value.base64 !== undefined),
        "text and base64 are mutually exclusive"
      ),
    annotations: mutating
  },
  {
    name: "shell_terminate",
    description: "Terminate a running interactive shell session.",
    inputSchema: z.strictObject({
      session_id: z.string().min(1)
    }),
    annotations: destructive
  },
  {
    name: "shell_close",
    description:
      "Release broker resources for a completed interactive shell session.",
    inputSchema: z.strictObject({
      session_id: z.string().min(1)
    }),
    annotations: { ...mutating, idempotentHint: true }
  },
  {
    name: "process_list",
    description: "List Windows 98 processes.",
    inputSchema: empty,
    annotations: readOnly
  },
  {
    name: "process_wait",
    description: "Wait for a process to exit for a bounded period.",
    inputSchema: z.strictObject({
      process_id: processId,
      timeout_ms: z.number().int().min(0).max(30 * 60 * 1_000).optional()
    }),
    annotations: readOnly
  },
  {
    name: "process_kill",
    description: "Terminate a process and, by default, its discovered child tree.",
    inputSchema: z.strictObject({
      process_id: processId,
      tree: z.boolean().default(true)
    }),
    annotations: destructive
  },
  {
    name: "fs_stat",
    description: "Read metadata for a guest filesystem path.",
    inputSchema: z.strictObject({
      path: guestPath
    }),
    annotations: readOnly
  },
  {
    name: "fs_list",
    description: "List a guest directory, optionally recursively.",
    inputSchema: z.strictObject({
      path: guestPath,
      recursive: z.boolean().default(false)
    }),
    annotations: readOnly
  },
  {
    name: "fs_mkdir",
    description: "Create a guest directory.",
    inputSchema: z.strictObject({
      path: guestPath,
      recursive: z.boolean().default(true)
    }),
    annotations: { ...mutating, idempotentHint: true }
  },
  {
    name: "fs_move",
    description: "Move or rename a guest file or directory.",
    inputSchema: z.strictObject({
      source: guestPath,
      destination: guestPath,
      overwrite: z.boolean().default(false)
    }),
    annotations: destructive
  },
  {
    name: "fs_delete",
    description: "Delete a guest file or directory.",
    inputSchema: z.strictObject({
      path: guestPath,
      recursive: z.boolean().default(false)
    }),
    annotations: destructive
  },
  {
    name: "file_push",
    description:
      "Copy a host file into the guest through a verified temporary-file commit.",
    inputSchema: z.strictObject({
      host_path: hostPath,
      guest_path: guestPath,
      overwrite: z.boolean().default(false)
    }),
    annotations: destructive
  },
  {
    name: "file_pull",
    description:
      "Copy a guest file to an allowed host path through a verified temporary-file commit.",
    inputSchema: z.strictObject({
      guest_path: guestPath,
      host_path: hostPath,
      overwrite: z.boolean().default(false)
    }),
    annotations: destructive
  },
  {
    name: "directory_push",
    description:
      "Merge-copy a host directory into the guest without deleting unrelated guest files.",
    inputSchema: z.strictObject({
      host_path: hostPath,
      guest_path: guestPath,
      overwrite: z.boolean().default(false)
    }),
    annotations: destructive
  },
  {
    name: "directory_pull",
    description:
      "Merge-copy a guest directory to an allowed host path without deleting unrelated host files.",
    inputSchema: z.strictObject({
      guest_path: guestPath,
      host_path: hostPath,
      overwrite: z.boolean().default(false)
    }),
    annotations: destructive
  },
  {
    name: "system_info",
    description:
      "Read detailed guest operating-system, code-page, display, and build information.",
    inputSchema: empty,
    annotations: readOnly
  },
  {
    name: "system_reboot",
    description:
      "Reboot Windows 98. This disconnects the guest and requires configured autostart for recovery.",
    inputSchema: z.strictObject({
      force: z.boolean().default(false),
      delay_seconds: z.number().int().min(0).max(300).default(0)
    }),
    annotations: destructive
  },
  {
    name: "system_shutdown",
    description:
      "Shut down Windows 98. The guest cannot reconnect until the VM is started externally.",
    inputSchema: z.strictObject({
      force: z.boolean().default(false),
      delay_seconds: z.number().int().min(0).max(300).default(0)
    }),
    annotations: destructive
  }
];

export function createMcpServer(client: BrokerClient): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS
    }
  );

  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        description: withUnlockReminder(definition),
        inputSchema: definition.inputSchema,
        annotations: {
          title: humanTitle(definition.name),
          ...definition.annotations
        }
      },
      async (params) =>
        await invokeBrokerTool(
          client,
          definition.name,
          params as Record<string, unknown>
        )
    );
  }

  return server;
}

async function invokeBrokerTool(
  client: BrokerClient,
  method: string,
  params: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const timeoutMs = brokerTimeout(method, params);
    const response = await client.request(
      method,
      params,
      timeoutMs === undefined ? {} : { timeoutMs }
    );
    return brokerResponseToMcp(response);
  } catch (error) {
    return localErrorToMcp(error);
  }
}

export function brokerResponseToMcp(
  response: BrokerResponse
): CallToolResult {
  const result = response.result;
  const content: CallToolResult["content"] = [
    {
      type: "text",
      text: JSON.stringify(result, null, 2)
    }
  ];
  if (response.image) {
    content.push({
      type: "image",
      mimeType: response.image.mimeType,
      data: response.image.data
    });
  }
  return {
    content,
    structuredContent: {
      ...result,
      imageIncluded: response.image !== undefined
    },
    isError: !result.ok
  };
}

function localErrorToMcp(error: unknown): CallToolResult {
  const isBrokerError = error instanceof BrokerClientError;
  const result: ToolResult = {
    ok: false,
    code: isBrokerError ? error.code : "MCP_ADAPTER_ERROR",
    message: error instanceof Error ? error.message : String(error),
    requestId: "",
    connection: {
      state: "offline",
      epoch: 0
    },
    lease: {
      held: false,
      heldByCaller: false
    },
    retryable: isBrokerError ? error.retryable : false,
    remediation:
      "Confirm the broker is running and WIN98_MCP_PIPE points to its named pipe. If this session may still own a broker-side lease, reconnect and call vm_unlock."
  };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: { ...result, imageIncluded: false },
    isError: true
  };
}

export function brokerTimeout(
  method: string,
  params: Record<string, unknown>
): number | undefined {
  if (method === "vm_wait") {
    return numericTimeout(params["wait_seconds"], 1_000, 30_000);
  }
  if (method === "shell_exec" || method === "process_wait") {
    return numericTimeout(params["timeout_ms"], 1, 30_000);
  }
  if (method === "shell_read") {
    return numericTimeout(params["wait_ms"], 1, 30_000);
  }
  const inputRuntime = estimateToolInputRuntime(method, params);
  if (inputRuntime !== undefined) {
    return inputRuntime + TOOL_TIMEOUT_MARGIN_MS;
  }
  return undefined;
}

function numericTimeout(
  value: unknown,
  multiplier: number,
  margin: number
): number | undefined {
  return typeof value === "number" ? value * multiplier + margin : undefined;
}

function withUnlockReminder(definition: ToolDefinition): string {
  if (
    definition.name === "vm_status" ||
    definition.name === "vm_capabilities" ||
    definition.name === "vm_unlock"
  ) {
    return definition.description;
  }
  return `${definition.description} ${UNLOCK_REMINDER}`;
}

function humanTitle(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function hasCompleteOptionalPoint(value: object): boolean {
  const record = value as Record<string, unknown>;
  return (record["x"] === undefined) === (record["y"] === undefined);
}

function estimateToolInputRuntime(
  method: string,
  params: Record<string, unknown>
): number | undefined {
  if (method === "mouse_move") {
    return nonNegativeNumber(params["duration_ms"], 0);
  }
  if (method === "mouse_drag") {
    return nonNegativeNumber(params["duration_ms"], 500);
  }
  if (method === "mouse_click") {
    const clicks = nonNegativeNumber(params["click_count"], 1);
    const interval = nonNegativeNumber(params["interval_ms"], 100);
    return Math.max(0, clicks - 1) * interval;
  }
  if (method === "keyboard_type") {
    return estimateKeyboardRuntime(
      typeof params["text"] === "string" ? params["text"] : "",
      nonNegativeNumber(params["interval_ms"], 10)
    );
  }
  if (method === "input_batch") {
    return estimateInputBatchRuntime(
      Array.isArray(params["actions"]) ? params["actions"] : []
    );
  }
  return undefined;
}

function estimateKeyboardRuntime(text: string, intervalMs: number): number {
  return [...text].length * intervalMs;
}

function estimateInputBatchRuntime(actions: readonly unknown[]): number {
  let total = 0;
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      continue;
    }
    const record = action as Record<string, unknown>;
    const type = record["type"];
    if (type === "delay") {
      total += nonNegativeNumber(record["milliseconds"], 0);
    } else if (type === "mouse_move") {
      total += nonNegativeNumber(record["duration_ms"], 0);
    } else if (type === "mouse_drag") {
      total += nonNegativeNumber(record["duration_ms"], 500);
    } else if (type === "mouse_click") {
      const clicks = nonNegativeNumber(record["click_count"], 1);
      const interval = nonNegativeNumber(record["interval_ms"], 100);
      total += Math.max(0, clicks - 1) * interval;
    } else if (type === "keyboard_type") {
      total += estimateKeyboardRuntime(
        typeof record["text"] === "string" ? record["text"] : "",
        nonNegativeNumber(record["interval_ms"], 10)
      );
    }
    if (total > MAX_INPUT_RUNTIME_MS) {
      return total;
    }
  }
  return total;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}
