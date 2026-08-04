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
import { ClientTransferRunner } from "./client-transfers.js";
import { TRANSFER_METHODS } from "../host/transfers.js";

export const MCP_SERVER_INSTRUCTIONS = `PARALLEL OPERATION AND CLEANUP:
1. Parallel mode is the default. Several MCP/admin sessions may submit work at once; the broker sends guest operations through one FIFO queue because Windows 98 executes one request at a time.
2. Queuing prevents protocol races, not UI collisions: mouse, keyboard, clipboard, focus, and screen state are shared. Coordinate or interactive input must be coordinated between agents.
3. vm_unlock is still required after terminal, transfer, held-input, or other operational work. In parallel mode it cleans up only this session's tracked resources.
4. vm_status, vm_capabilities, and agent_diagnostics are read-only. vm_lock/vm_wait become meaningful only if an operator enables Exclusive lock agents in the Admin app or broker configuration.
5. If exclusive locking is enabled and a call returns VM_BUSY, use its FIFO ticket with vm_wait (maximum ten minutes).
6. Never leave keys or mouse buttons held. Use keyboard_release_all and mouse_release_all after interrupted low-level input.
7. MCP disconnect automatically aborts that session's tracked work. In exclusive mode it also releases the lease after guest cleanup.

Coordinates are zero-based physical pixels on the primary Windows 98 display. Take a fresh screen_capture before coordinate-based input when screen state may have changed. shell_read is cursor-based streaming; full-screen DOS/TUI programs are unsupported.`;

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface ToolDefinition {
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
const qemuVmId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const qemuProfile = z.enum(["win98", "winxp", "win10", "generic"]);
const qemuAcceleration = z.enum(["auto", "tcg", "whpx", "kvm", "hvf"]);
const qemuOverrides = z.strictObject({
  disk: z.strictObject({ enabled: z.boolean().optional(), interface: z.string().min(1).max(32).optional() }).optional(),
  network: z.strictObject({ mode: z.enum(["user", "disabled", "custom"]).optional(), args: z.array(z.string().min(1).max(4096)).max(128).optional() }).optional()
}).optional();
/** Replace or disable any named QEMU profile component (audio, display, firmware, boot, devices, etc.). */
const qemuProfileOverrides = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  z.union([z.literal(false), z.array(z.string().min(1).max(4096)).min(1).max(256)])
).optional();

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
    name: "qemu_doctor",
    description: "Check the local QEMU host, configured binary, managed VM root, accelerator policy, and stable guest-to-host TCP route.",
    inputSchema: z.strictObject({ qemu_binary: z.string().min(1).optional(), profile: qemuProfile.optional(), acceleration: qemuAcceleration.optional() }),
    annotations: readOnly
  },
  { name: "qemu_vm_list", description: "List broker-managed QEMU VMs and their lifecycle state.", inputSchema: empty, annotations: readOnly },
  { name: "qemu_vm_select", description: "Record the managed QEMU VM selected in this MCP/Admin session's QEMU panel. In-guest MCP control remains the agent's outbound TCP connection.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: mutating },
  { name: "qemu_vm_unselect", description: "Clear this session's managed QEMU VM selection.", inputSchema: empty, annotations: mutating },
  { name: "qemu_vm_status", description: "Read one managed QEMU VM's process, QMP, and guest TCP transport state.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: readOnly },
  {
    name: "qemu_vm_command_preview", description: "Preview the exact managed QEMU command without changing VM state.",
    inputSchema: z.strictObject({ vm_id: qemuVmId.optional(), name: z.string().min(1).max(128).optional(), profile: qemuProfile.optional(), acceleration: qemuAcceleration.optional(), qemu_binary: z.string().min(1).optional(), architecture: z.string().min(1).max(64).optional(), machine: z.string().min(1).max(128).optional(), memory: z.string().min(1).max(32).optional(), cpus: z.number().int().min(1).max(128).optional(), extra_args: z.array(z.string().min(1).max(4096)).max(256).optional(), overrides: qemuOverrides, profile_overrides: qemuProfileOverrides }), annotations: readOnly
  },
  {
    name: "qemu_vm_create", description: "Import a broker-local disk into a new managed qcow2 QEMU VM. disk_path currently belongs to the broker host; remote-media upload is not available yet.",
    inputSchema: z.strictObject({ vm_id: qemuVmId.optional(), name: z.string().min(1).max(128), disk_path: hostPath.optional(), profile: qemuProfile.default("win98"), acceleration: qemuAcceleration.default("auto"), qemu_binary: z.string().min(1).optional(), architecture: z.string().min(1).max(64).optional(), machine: z.string().min(1).max(128).optional(), memory: z.string().min(1).max(32).optional(), cpus: z.number().int().min(1).max(128).optional(), extra_args: z.array(z.string().min(1).max(4096)).max(256).default([]), overrides: qemuOverrides, profile_overrides: qemuProfileOverrides }), annotations: destructive
  },
  { name: "qemu_vm_update", description: "Update a stopped managed QEMU VM definition, including accelerator policy and any profile component.", inputSchema: z.strictObject({ vm_id: qemuVmId, name: z.string().min(1).max(128).optional(), profile: qemuProfile.optional(), acceleration: qemuAcceleration.optional(), qemu_binary: z.string().min(1).optional(), architecture: z.string().min(1).max(64).optional(), machine: z.string().min(1).max(128).optional(), memory: z.string().min(1).max(32).optional(), cpus: z.number().int().min(1).max(128).optional(), extra_args: z.array(z.string().min(1).max(4096)).max(256).optional(), overrides: qemuOverrides, profile_overrides: qemuProfileOverrides }), annotations: destructive },
  { name: "qemu_vm_start", description: "Start a managed QEMU VM with QMP and the profile's guest TCP network.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: mutating },
  { name: "qemu_vm_shutdown", description: "Request graceful guest shutdown, wait 40 seconds, then stop only this QEMU process if needed.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: destructive },
  { name: "qemu_vm_restart", description: "Gracefully stop then restart a managed QEMU VM.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: destructive },
  { name: "qemu_vm_force_stop", description: "Immediately stop a managed QEMU VM when graceful shutdown is not possible.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: destructive },
  { name: "qemu_vm_delete", description: "Move a managed QEMU VM to recoverable broker trash; only the newest three entries are retained.", inputSchema: z.strictObject({ vm_id: qemuVmId, force: z.boolean().default(false) }), annotations: destructive },
  { name: "qemu_vm_trash_list", description: "List recoverable deleted managed VMs.", inputSchema: empty, annotations: readOnly },
  { name: "qemu_vm_restore", description: "Restore a managed VM from broker trash.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: destructive },
  { name: "qemu_vm_trash_empty", description: "Permanently delete every retained QEMU trash entry.", inputSchema: empty, annotations: destructive },
  { name: "qemu_vm_metrics", description: "Read managed QEMU process and QMP metrics.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: readOnly },
  { name: "qemu_media_push", description: "Copy a broker-local .iso image into this VM's managed media directory. source_path is resolved on the broker host; remote media upload is not available yet.", inputSchema: z.strictObject({ vm_id: qemuVmId, source_path: hostPath, media_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).optional() }), annotations: destructive },
  { name: "qemu_media_list", description: "List ISO images stored in this managed VM's media directory and report which ISO is configured as mounted.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: readOnly },
  { name: "qemu_media_mount", description: "Mount a managed ISO now when the VM is running and persist it for future starts.", inputSchema: z.strictObject({ vm_id: qemuVmId, media_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) }), annotations: mutating },
  { name: "qemu_media_eject", description: "Eject the managed CD-ROM now when running and persist an empty drive for future starts.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: mutating },
  { name: "qemu_media_delete", description: "Delete an unmounted managed ISO. force=true ejects it first when it is mounted.", inputSchema: z.strictObject({ vm_id: qemuVmId, media_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/), force: z.boolean().default(false) }), annotations: destructive },
  { name: "qemu_media_set_boot", description: "Set persistent QEMU boot order to disk, cdrom, or network. The VM must be stopped.", inputSchema: z.strictObject({ vm_id: qemuVmId, device: z.enum(["disk", "cdrom", "network"]) }), annotations: destructive },
  { name: "qemu_snapshot_list", description: "List stopped-VM qcow2 internal snapshots.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: readOnly },
  { name: "qemu_snapshot_create", description: "Create a named qcow2 internal disk snapshot while the VM is stopped.", inputSchema: z.strictObject({ vm_id: qemuVmId, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) }), annotations: destructive },
  { name: "qemu_snapshot_restore", description: "Restore a named qcow2 internal disk snapshot while the VM is stopped.", inputSchema: z.strictObject({ vm_id: qemuVmId, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) }), annotations: destructive },
  { name: "qemu_snapshot_delete", description: "Delete a named qcow2 internal disk snapshot while the VM is stopped.", inputSchema: z.strictObject({ vm_id: qemuVmId, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) }), annotations: destructive },
  { name: "qemu_screen_capture", description: "Capture the QEMU framebuffer before the Windows controller has started.", inputSchema: z.strictObject({ vm_id: qemuVmId }), annotations: readOnly },
  { name: "qemu_keyboard_key", description: "Send a QMP qcode key event before or after guest-agent startup.", inputSchema: z.strictObject({ vm_id: qemuVmId, key: z.string().min(1).max(64), action: keyAction.default("press") }), annotations: mutating },
  { name: "qemu_keyboard_type", description: "Type basic QEMU monitor-compatible text into the active QEMU display.", inputSchema: z.strictObject({ vm_id: qemuVmId, text: z.string().min(1).max(4096) }), annotations: mutating },
  { name: "qemu_mouse_move", description: "Send absolute QMP mouse coordinates to a running QEMU VM.", inputSchema: z.strictObject({ vm_id: qemuVmId, x: coordinate, y: coordinate }), annotations: mutating },
  { name: "qemu_mouse_click", description: "Move then click through QMP before the Windows controller is available.", inputSchema: z.strictObject({ vm_id: qemuVmId, x: coordinate, y: coordinate, button: mouseButton.default("left") }), annotations: mutating },
  { name: "qemu_qmp_execute", description: "Run an advanced QMP command against a managed VM's local broker-owned QMP endpoint.", inputSchema: z.strictObject({ vm_id: qemuVmId, command: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).default({}) }), annotations: mutating },
  { name: "qemu_hmp_command", description: "Run an advanced HMP command through QMP human-monitor-command.", inputSchema: z.strictObject({ vm_id: qemuVmId, command: z.string().min(1).max(4096) }), annotations: mutating },
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
    name: "fs_drives",
    description: "List available Windows drive roots for filesystem browsing.",
    inputSchema: empty,
    annotations: readOnly
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
    name: "agent_diagnostics",
    description: "Read the guest crash context and supervisor recovery status without acquiring the VM lease.",
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

export function findToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((definition) => definition.name === name);
}

/** Shared MCP/CLI validation so defaults and constraints never drift. */
export function validateToolParams(
  name: string,
  params: unknown
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
  const definition = findToolDefinition(name);
  if (!definition) return { ok: false, message: `Unknown operation: ${name}` };
  const parsed = definition.inputSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ") };
  }
  return { ok: true, params: parsed.data as Record<string, unknown> };
}

export function toolCatalog(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: withUnlockReminder(definition),
    inputSchema: z.toJSONSchema(definition.inputSchema)
  }));
}

export function createMcpServer(client: BrokerClient): McpServer {
  // A TCP broker can be on another computer. In that case transfer paths must
  // belong to this MCP process, not to the broker machine.
  const clientTransfers = client.host
    ? new ClientTransferRunner(client)
    : undefined;
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
      async (params) => {
        const transferParams = params as Record<string, unknown>;
        if (clientTransfers && TRANSFER_METHODS.has(definition.name)) {
          return await invokeClientTransfer(
            clientTransfers,
            definition.name,
            transferParams
          );
        }
        return await invokeBrokerTool(client, definition.name, transferParams);
      }
    );
  }

  return server;
}

async function invokeClientTransfer(
  transfers: ClientTransferRunner,
  method: string,
  params: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const progress = await transfers.execute(method, params);
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: true,
        code: "OK",
        message: `${method} completed from the MCP client's local filesystem. ${UNLOCK_REMINDER}`,
        data: { ...progress, unlockReminder: UNLOCK_REMINDER }
      }, null, 2) }]
    };
  } catch (error) {
    await transfers.abort().catch(() => undefined);
    return localErrorToMcp(error);
  }
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
    definition.name === "agent_diagnostics" ||
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
