import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  connectBroker,
  type BrokerClient,
  type BrokerConfig
} from "../host/index.js";
import { EXPECTED_GUEST_BUILD_ID } from "../shared/build-info.js";
import type { BrokerResponse } from "../shared/types.js";

const GUEST_TEST_ROOT = "C:\\MCPTEST";

export interface SmokeTestCheck {
  name: string;
  ok: boolean;
  code: string;
  message: string;
  durationMs: number;
}

export interface SmokeTestReport {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  checks: SmokeTestCheck[];
  recopy: "none" | "ini" | "exe";
  copyRequired: "nothing" | "WIN98CTL.INI" | "WIN98CTL.EXE and package";
  copyReason: string;
  guestBuildId?: string;
}

export async function runSmokeTest(
  config: BrokerConfig
): Promise<SmokeTestReport> {
  const startedAt = new Date().toISOString();
  const checks: SmokeTestCheck[] = [];
  const client = await connectBroker({
    pipePath: config.pipePath,
    sessionLabel: `smoke-test:${process.pid}`,
    requestTimeoutMs: 31 * 60 * 1_000
  });
  await mkdir(path.resolve("out"), { recursive: true });
  const temporaryHostRoot = await mkdtemp(
    path.resolve("out", `.smoke-host-${process.pid}-`)
  );
  let locked = false;
  let guestBuildId: string | undefined;
  let copy: Pick<
    SmokeTestReport,
    "recopy" | "copyRequired" | "copyReason"
  > = {
    recopy: "none",
    copyRequired: "nothing",
    copyReason: "No new VM files are required for another run."
  };

  const run = async (
    name: string,
    method: string,
    params: Record<string, unknown> = {},
    validate: (response: BrokerResponse) => boolean = (response) =>
      response.result.ok,
    timeoutMs = 90_000
  ): Promise<BrokerResponse | undefined> => {
    const started = Date.now();
    try {
      const response = await client.call(method, params, timeoutMs);
      const ok = validate(response);
      checks.push({
        name,
        ok,
        code: ok ? response.result.code : `VERIFY_${response.result.code}`,
        message: ok
          ? response.result.message
          : `Unexpected result: ${response.result.message}`,
        durationMs: Date.now() - started
      });
      return response;
    } catch (error) {
      checks.push({
        name,
        ok: false,
        code: "SMOKE_EXCEPTION",
        message: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started
      });
      return undefined;
    }
  };

  const verify = (
    name: string,
    ok: boolean,
    code: string,
    message: string
  ): void => {
    checks.push({
      name,
      ok,
      code: ok ? "OK" : code,
      message,
      durationMs: 0
    });
  };

  try {
    const status = await run("Broker and guest status", "vm_status");
    guestBuildId = status?.result.connection.guestBuildId;
    if (status?.result.connection.state !== "online") {
      verify(
        "Windows 98 guest online",
        false,
        "VM_OFFLINE",
        "No Windows 98 guest is online."
      );
      copy = {
        recopy: "ini",
        copyRequired: "WIN98CTL.INI",
        copyReason:
          "The guest is offline. Recheck/recopy the INI host address and port before replacing the EXE."
      };
    } else if (
      guestBuildId !== "simulator-1" &&
      guestBuildId !== EXPECTED_GUEST_BUILD_ID
    ) {
      verify(
        "Guest build identity",
        false,
        "GUEST_BUILD_MISMATCH",
        `Expected ${EXPECTED_GUEST_BUILD_ID}, received ${guestBuildId ?? "none"}.`
      );
      copy = {
        recopy: "exe",
        copyRequired: "WIN98CTL.EXE and package",
        copyReason: "The connected guest build does not match this host release."
      };
    } else {
      const lock = await run("Exclusive lease", "vm_lock");
      locked = lock?.result.ok === true;
      if (locked) {
        const capabilities = await run("Capabilities", "vm_capabilities");
        const capabilityData = asRecord(capabilities?.result.data);
        const screenWidth = numberValue(capabilityData?.["screenWidth"], 640);
        const screenHeight = numberValue(capabilityData?.["screenHeight"], 480);

        const screenshot = await run(
          "Screenshot PNG and metadata",
          "screen_capture",
          { include_cursor: true },
          (response) => {
            const data = asRecord(response.result.data);
            return (
              response.result.ok &&
              response.image?.mimeType === "image/png" &&
              response.image.data.length > 100 &&
              numberValue(data?.["width"], 0) > 0 &&
              numberValue(data?.["height"], 0) > 0 &&
              numberValue(data?.["colorDepth"], 0) > 0 &&
              asRecord(data?.["cursor"]) !== undefined
            );
          }
        );
        if (screenshot?.result.ok) {
          await run("Region screenshot", "screen_capture", {
            region: {
              x: 0,
              y: 0,
              width: Math.min(64, screenWidth),
              height: Math.min(64, screenHeight)
            },
            include_cursor: false
          });
        }

        await exerciseContention(client, config, run, () => {
          locked = false;
        });
        const relock = await run("Reacquire after FIFO test", "vm_lock");
        locked = relock?.result.ok === true;

        if (locked) {
          await exerciseInput(run, screenWidth, screenHeight);
          await exerciseClipboard(run);
          await exerciseShell(run, verify);
          await exerciseTransfers(run, temporaryHostRoot, verify);
          await exerciseNotepad(
            run,
            temporaryHostRoot,
            capabilityData?.["supportsMouseWheel"] === true,
            verify
          );
          await run("Process list", "process_list");
          await run("Recursive guest listing", "fs_list", {
            path: GUEST_TEST_ROOT,
            recursive: true
          });
        }
      }
    }
  } finally {
    if (locked) {
      const unlock = await run("Unlock", "vm_unlock", { force: false });
      if (!unlock?.result.ok) {
        await run("Forced recovery unlock", "vm_unlock", { force: true });
      }
    }
    client.close();
    await rm(temporaryHostRoot, { recursive: true, force: true });
  }

  const ok = checks.length > 0 && checks.every((item) => item.ok);
  if (!ok && copy.recopy === "none") {
    copy = {
      recopy: "none",
      copyRequired: "nothing",
      copyReason:
        "The current package connected correctly; diagnose the failed check before copying VM files again."
    };
  }
  return {
    ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
    ...copy,
    ...(guestBuildId ? { guestBuildId } : {})
  };
}

async function exerciseContention(
  owner: BrokerClient,
  config: BrokerConfig,
  run: (
    name: string,
    method: string,
    params?: Record<string, unknown>,
    validate?: (response: BrokerResponse) => boolean,
    timeoutMs?: number
  ) => Promise<BrokerResponse | undefined>,
  ownerReleased: () => void
): Promise<void> {
  const contender = await connectBroker({
    pipePath: config.pipePath,
    sessionLabel: `smoke-contender:${process.pid}`,
    requestTimeoutMs: 20_000
  });
  try {
    await timedExternalCheck(
      "Second client receives VM_BUSY",
      () => contender.call("vm_lock", {}, 10_000),
      (response) => !response.result.ok && response.result.code === "VM_BUSY",
      run
    );
    const waiting = contender.call("vm_wait", { wait_seconds: 5 }, 10_000);
    const unlock = await run("Owner unlocks for FIFO handoff", "vm_unlock", {
      force: false
    });
    if (unlock?.result.ok) {
      ownerReleased();
    }
    await timedExternalCheck(
      "FIFO waiter acquires lease",
      () => waiting,
      (response) =>
        response.result.ok && response.result.lease.heldByCaller === true,
      run
    );
    await timedExternalCheck(
      "FIFO waiter unlocks",
      () => contender.call("vm_unlock", { force: false }, 10_000),
      (response) => response.result.ok,
      run
    );
  } finally {
    contender.close();
  }

  const abandoned = await connectBroker({
    pipePath: config.pipePath,
    sessionLabel: `smoke-disconnect:${process.pid}`,
    requestTimeoutMs: 20_000
  });
  await timedExternalCheck(
    "Disconnect test client acquires",
    () => abandoned.call("vm_lock", {}, 10_000),
    (response) => response.result.ok,
    run
  );
  abandoned.close();
  await timedExternalCheck(
    "Disconnect cleanup allows reacquire",
    () => owner.call("vm_wait", { wait_seconds: 5 }, 10_000),
    (response) =>
      response.result.ok && response.result.lease.heldByCaller === true,
    run
  );
}

async function timedExternalCheck(
  name: string,
  invoke: () => Promise<BrokerResponse>,
  validate: (response: BrokerResponse) => boolean,
  run: (
    name: string,
    method: string,
    params?: Record<string, unknown>,
    validate?: (response: BrokerResponse) => boolean
  ) => Promise<BrokerResponse | undefined>
): Promise<void> {
  const response = await invoke();
  await run(
    name,
    "vm_status",
    {},
    () => validate(response)
  );
}

async function exerciseInput(
  run: SmokeRunner,
  width: number,
  height: number
): Promise<void> {
  const x = Math.max(0, Math.min(width - 1, 100));
  const y = Math.max(0, Math.min(height - 1, 100));
  await run("Mouse exact move", "mouse_move", { x, y, duration_ms: 20 });
  await run("Mouse explicit down", "mouse_down", { x, y, button: "left" });
  await run("Mouse explicit up", "mouse_up", { button: "left" });
  await run("Mouse release cleanup", "mouse_release_all");
  await run("Named keyboard key", "keyboard_key", {
    key: "SHIFT",
    action: "press"
  });
  await run("Low-level keyboard key", "keyboard_keycode", {
    virtual_key: 16,
    action: "press"
  });
  await run("Keyboard hotkey", "keyboard_hotkey", { keys: ["CTRL", "ESC"] });
  await run("Escape Start menu", "keyboard_key", { key: "ESCAPE" });
  await run("Keyboard release cleanup", "keyboard_release_all");
  await run("Batched input", "input_batch", {
    actions: [
      { type: "mouse_move", x, y },
      { type: "delay", milliseconds: 20 },
      { type: "keyboard_key", key: "SHIFT", action: "press" }
    ],
    screenshot_after: true,
    stop_on_error: true
  });
}

async function exerciseClipboard(run: SmokeRunner): Promise<void> {
  await run("Clipboard write", "clipboard_set", { text: "WIN98_MCP_SMOKE" });
  await run(
    "Clipboard read and verify",
    "clipboard_get",
    { format: "text" },
    (response) =>
      response.result.ok &&
      asRecord(response.result.data)?.["text"] === "WIN98_MCP_SMOKE"
  );
}

async function exerciseShell(
  run: SmokeRunner,
  verify: (name: string, ok: boolean, code: string, message: string) => void
): Promise<void> {
  await run(
    "Command shell stdout",
    "shell_exec",
    {
      command: "ECHO WIN98_MCP_SMOKE",
      timeout_ms: 10_000,
      screenshot_on_error: true
    },
    (response) =>
      response.result.ok &&
      String(
        asRecord(response.result.data)?.["stdout"] ??
          asRecord(response.result.data)?.["combined"] ??
          ""
      ).includes("WIN98_MCP_SMOKE")
  );
  await run(
    "Command timeout screenshot",
    "shell_exec",
    {
      command: "ECHO WIN98_MCP_TIMEOUT",
      timeout_ms: 0,
      screenshot_on_error: true
    },
    (response) =>
      !response.result.ok &&
      response.result.code === "COMMAND_TIMEOUT" &&
      response.image?.mimeType === "image/png" &&
      response.image.data.length > 100
  );

  const started = await run("Interactive shell start", "shell_start", {
    command: "COMMAND.COM"
  });
  const sessionId = String(
    asRecord(started?.result.data)?.["sessionId"] ?? ""
  );
  if (!started?.result.ok || !sessionId) {
    return;
  }
  await run("Interactive shell write", "shell_write", {
    session_id: sessionId,
    text: "ECHO WIN98_MCP_INTERACTIVE\r\nEXIT\r\n",
    eof: true
  });
  let cursor = 0;
  let output = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = await run("Interactive shell read", "shell_read", {
      session_id: sessionId,
      after_cursor: cursor,
      max_bytes: 32 * 1024,
      wait_ms: 250
    });
    const data = asRecord(read?.result.data);
    cursor = numberValue(data?.["cursor"], cursor);
    output += String(data?.["stdout"] ?? data?.["combined"] ?? "");
    if (data?.["running"] === false) {
      break;
    }
  }
  verify(
    "Interactive output verification",
    output.includes("WIN98_MCP_INTERACTIVE"),
    "SHELL_OUTPUT_MISSING",
    "Interactive shell output contains the expected marker."
  );
  await run("Interactive shell close", "shell_close", {
    session_id: sessionId
  });
}

async function exerciseTransfers(
  run: SmokeRunner,
  hostRoot: string,
  verify: (name: string, ok: boolean, code: string, message: string) => void
): Promise<void> {
  await run("Guest test directory", "fs_mkdir", {
    path: GUEST_TEST_ROOT,
    recursive: true
  });
  const sourceFile = path.join(hostRoot, "roundtrip.bin");
  const pulledFile = path.join(hostRoot, "roundtrip-pulled.bin");
  const bytes = Buffer.alloc(96 * 1024 + 37);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 17) & 0xff;
  }
  await writeFile(sourceFile, bytes);
  await run("Binary file push", "file_push", {
    host_path: sourceFile,
    guest_path: `${GUEST_TEST_ROOT}\\ROUNDTRP.BIN`,
    overwrite: true
  });
  await run("Binary file pull", "file_pull", {
    guest_path: `${GUEST_TEST_ROOT}\\ROUNDTRP.BIN`,
    host_path: pulledFile,
    overwrite: true
  });
  const pulled = await readFile(pulledFile).catch(() => Buffer.alloc(0));
  verify(
    "Binary SHA-256 round trip",
    sha256(bytes) === sha256(pulled),
    "TRANSFER_HASH_MISMATCH",
    "Host and returned binary hashes match."
  );

  const sourceDirectory = path.join(hostRoot, "tree-source");
  const pulledDirectory = path.join(hostRoot, "tree-pulled");
  await mkdir(path.join(sourceDirectory, "nested", "empty"), {
    recursive: true
  });
  await writeFile(
    path.join(sourceDirectory, "nested", "payload.txt"),
    "WIN98 DIRECTORY ROUND TRIP\r\n",
    "ascii"
  );
  await run("Directory push", "directory_push", {
    host_path: sourceDirectory,
    guest_path: `${GUEST_TEST_ROOT}\\TREE`,
    overwrite: true
  });
  await run("Directory pull", "directory_pull", {
    guest_path: `${GUEST_TEST_ROOT}\\TREE`,
    host_path: pulledDirectory,
    overwrite: true
  });
  const directoryPayload = await readFile(
    path.join(pulledDirectory, "nested", "payload.txt"),
    "ascii"
  ).catch(() => "");
  verify(
    "Directory content round trip",
    directoryPayload === "WIN98 DIRECTORY ROUND TRIP\r\n",
    "DIRECTORY_CONTENT_MISMATCH",
    "Nested directory content matches."
  );
}

async function exerciseNotepad(
  run: SmokeRunner,
  hostRoot: string,
  supportsMouseWheel: boolean,
  verify: (name: string, ok: boolean, code: string, message: string) => void
): Promise<void> {
  const marker = `WIN98 MCP NOTEPAD ${randomUUID()}`;
  await run("Launch Notepad", "shell_exec", {
    command: `START NOTEPAD.EXE ${GUEST_TEST_ROOT}\\NOTE.TXT`,
    timeout_ms: 10_000,
    screenshot_on_error: true
  });
  let notepad: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 20 && !notepad; attempt += 1) {
    const windows = await run("Find Notepad window", "window_list", {
      visible_only: true
    });
    const list = asRecord(windows?.result.data)?.["windows"];
    if (Array.isArray(list)) {
      notepad = list
        .map(asRecord)
        .find((window) =>
          /notepad|note\.txt/iu.test(String(window?.["title"] ?? ""))
        );
    }
    if (!notepad) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!notepad) {
    verify(
      "Notepad automation",
      false,
      "NOTEPAD_WINDOW_NOT_FOUND",
      "Notepad did not expose a visible top-level window."
    );
    return;
  }
  const windowId = numberValue(
    notepad["windowId"] ?? notepad["window_id"] ?? notepad["id"],
    0
  );
  await run("Focus Notepad", "window_focus", { window_id: windowId });
  await run("Capture Notepad", "window_capture", { window_id: windowId });
  const rect = asRecord(notepad["rect"]);
  const clickX = numberValue(rect?.["x"], 20) + 60;
  const clickY = numberValue(rect?.["y"], 20) + 80;
  await run("Notepad mouse single click", "mouse_click", {
    x: clickX,
    y: clickY,
    click_count: 1
  });
  await run("Notepad mouse double click", "mouse_click", {
    x: clickX,
    y: clickY,
    click_count: 2,
    interval_ms: 100
  });
  await run("Notepad mouse right click", "mouse_click", {
    x: clickX,
    y: clickY,
    button: "right"
  });
  await run("Dismiss Notepad context menu", "keyboard_key", {
    key: "ESCAPE",
    action: "press"
  });
  await run("Notepad mouse drag", "mouse_drag", {
    from_x: clickX,
    from_y: clickY,
    to_x: clickX + 20,
    to_y: clickY + 10,
    duration_ms: 100,
    steps: 5
  });
  if (supportsMouseWheel) {
    await run("Notepad mouse wheel", "mouse_scroll", {
      delta: -120,
      x: clickX,
      y: clickY
    });
  }
  await run("Type in Notepad", "keyboard_type", {
    text: "temporary text",
    interval_ms: 5
  });
  await run("Move to start of Notepad text", "keyboard_hotkey", {
    keys: ["CTRL", "HOME"]
  });
  await run("Select Notepad text", "keyboard_hotkey", {
    keys: ["CTRL", "SHIFT", "END"]
  });
  await run("Set Notepad clipboard", "clipboard_set", { text: marker });
  await run("Paste Notepad text", "keyboard_hotkey", {
    keys: ["CTRL", "V"]
  });
  await run("Save Notepad through File menu", "input_batch", {
    actions: [
      { type: "delay", milliseconds: 600 },
      { type: "keyboard_hotkey", keys: ["ALT", "F"] },
      { type: "delay", milliseconds: 300 },
      { type: "keyboard_key", key: "S", action: "press" },
      { type: "delay", milliseconds: 1500 }
    ],
    stop_on_error: true
  });

  // Windows 98 Notepad can recreate its top-level window when an initially
  // missing document is first saved. Refresh the HWND instead of assuming the
  // pre-save handle remains valid.
  const refreshedWindows = await run("Refresh Notepad window", "window_list", {
    visible_only: true
  });
  const refreshedList = asRecord(refreshedWindows?.result.data)?.["windows"];
  const refreshedNotepad = Array.isArray(refreshedList)
    ? refreshedList
        .map(asRecord)
        .find((window) =>
          /notepad|note\.txt/iu.test(String(window?.["title"] ?? ""))
        )
    : undefined;
  const closeWindowId = numberValue(
    refreshedNotepad?.["windowId"] ??
      refreshedNotepad?.["window_id"] ??
      refreshedNotepad?.["id"],
    0
  );
  if (closeWindowId) {
    await run("Close Notepad", "window_close", {
      window_id: closeWindowId
    });
  } else {
    verify(
      "Close Notepad",
      false,
      "NOTEPAD_WINDOW_NOT_FOUND_AFTER_SAVE",
      "Notepad did not expose a current top-level window after saving."
    );
  }
  await run("Wait for Notepad close", "input_batch", {
    actions: [{ type: "delay", milliseconds: 300 }]
  });

  const notePull = path.join(hostRoot, "notepad-note.txt");
  await run("Pull Notepad file", "file_pull", {
    guest_path: `${GUEST_TEST_ROOT}\\NOTE.TXT`,
    host_path: notePull,
    overwrite: true
  });
  const note = await readFile(notePull, "ascii").catch(() => "");
  verify(
    "Notepad saved content",
    note.trim() === marker,
    "NOTEPAD_CONTENT_MISMATCH",
    "Notepad saved the text entered through mouse/keyboard control."
  );
}

type SmokeRunner = (
  name: string,
  method: string,
  params?: Record<string, unknown>,
  validate?: (response: BrokerResponse) => boolean,
  timeoutMs?: number
) => Promise<BrokerResponse | undefined>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
