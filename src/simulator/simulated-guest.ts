import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  type Hash
} from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { PNG } from "pngjs";
import {
  FrameDecoder,
  decodeJson,
  encodeFrame,
  encodeJson,
  verifyFrameMac
} from "../shared/protocol.js";
import {
  FrameType,
  type GuestCapabilities,
  type GuestRequest,
  type GuestResponse,
  type MouseButton
} from "../shared/types.js";

export interface SimulatedGuestOptions {
  host: string;
  port: number;
  psk: Buffer;
  rootDirectory: string;
  reconnect?: boolean;
  width?: number;
  height?: number;
}

interface SimulatedShell {
  id: string;
  processId: number;
  output: Buffer;
  cursor: number;
  running: boolean;
  exitCode: number | null;
  stdin: Buffer[];
}

interface SimulatedWindow {
  windowId: number;
  title: string;
  className: string;
  processId: number;
  visible: boolean;
  enabled: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

interface SimulatedWriteTransfer {
  id: string;
  finalPath: string;
  tempPath: string;
  file: FileHandle;
  expectedSize: number;
  expectedSha256: string;
  overwrite: boolean;
  offset: number;
  hash: Hash;
  prefixSha256: string;
}

const TRANSFER_CHUNK_BYTES = 64 * 1024;
const MAX_WIN98_FILE_BYTES = 2_147_483_647;
const CRC32_TABLE = makeCrc32Table();

export class SimulatedGuest extends EventEmitter {
  private readonly options: Required<
    Pick<SimulatedGuestOptions, "reconnect" | "width" | "height">
  > &
    SimulatedGuestOptions;
  private socket: net.Socket | undefined;
  private decoder = new FrameDecoder();
  private sessionKey: Buffer | undefined;
  private guestNonce: Buffer | undefined;
  private hostSequence = 0n;
  private guestSequence = 1n;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private clipboard = "";
  private mouse = { x: 10, y: 10, buttons: new Set<MouseButton>() };
  private pressedKeys = new Set<string>();
  private readonly inputEvents: Array<Record<string, unknown>> = [];
  private readonly shells = new Map<string, SimulatedShell>();
  private nextShellId = 1;
  private nextProcessId = 1_000;
  private readonly writeTransfers = new Map<string, SimulatedWriteTransfer>();
  private nextTransferId = 1;
  private failWriteChunkOnceAtOffset: number | undefined;
  private readonly windows: SimulatedWindow[] = [
    {
      windowId: 100,
      title: "Windows 98 Simulator",
      className: "SIMULATED",
      processId: 1,
      visible: true,
      enabled: true,
      rect: { x: 20, y: 20, width: 420, height: 260 }
    },
    {
      windowId: 101,
      title: "Untitled - Notepad",
      className: "Notepad",
      processId: 2,
      visible: true,
      enabled: true,
      rect: { x: 60, y: 50, width: 500, height: 350 }
    }
  ];
  private focusedWindowId = 100;
  private notepadText = "";
  private notepadSelectAll = false;
  private notepadGuestPath = "C:\\MCPTEST\\NOTE.TXT";

  constructor(options: SimulatedGuestOptions) {
    super();
    this.options = {
      reconnect: options.reconnect ?? true,
      width: options.width ?? 640,
      height: options.height ?? 480,
      ...options
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await mkdir(this.options.rootDirectory, { recursive: true });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    await this.cleanupTransfers();
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = undefined;
    this.cleanupInput();
  }

  snapshotInputEvents(): Array<Record<string, unknown>> {
    return structuredClone(this.inputEvents);
  }

  injectWriteChunkFailureOnce(offset: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > MAX_WIN98_FILE_BYTES
    ) {
      throw new Error("SIMULATOR_FAILURE_OFFSET_INVALID");
    }
    this.failWriteChunkOnceAtOffset = offset;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.decoder = new FrameDecoder();
    this.sessionKey = undefined;
    this.hostSequence = 0n;
    this.guestSequence = 1n;
    const socket = net.createConnection({
      host: this.options.host,
      port: this.options.port
    });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("connect", () => this.sendHello());
    socket.on("data", (chunk) =>
      this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    socket.on("error", (error) => this.emit("connectionError", error));
    socket.on("close", () => {
      this.cleanupInput();
      void this.cleanupTransfers();
      this.emit("disconnected");
      if (!this.stopped && this.options.reconnect) {
        this.reconnectTimer = setTimeout(() => void this.connect(), 250);
      }
    });
  }

  private sendHello(): void {
    this.guestNonce = randomBytes(32);
    const payload = encodeJson({
      kind: "guest_hello",
      guestNonce: this.guestNonce.toString("base64"),
      guestId: "simulated-win98",
      guestBuildId: "simulator-1"
    });
    this.writeFrame(FrameType.Hello, payload, 0n, false);
  }

  private onData(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        if (!this.sessionKey) {
          this.handleHandshakeFrame(frame.header.type, frame.payload);
          continue;
        }
        if (
          !verifyFrameMac(frame, this.sessionKey, "host-to-guest") ||
          frame.header.sequence !== this.hostSequence + 1n
        ) {
          throw new Error("SIMULATOR_FRAME_AUTHENTICATION_FAILED");
        }
        this.hostSequence = frame.header.sequence;
        switch (frame.header.type) {
          case FrameType.Authenticated:
            this.emit("authenticated");
            break;
          case FrameType.Request:
            void this.handleRequest(decodeJson<GuestRequest>(frame.payload));
            break;
          case FrameType.Cancel:
            this.handleCancel(decodeJson<{ requestId: string }>(frame.payload));
            break;
          case FrameType.Ping:
            this.sendSigned(FrameType.Pong, frame.payload);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      this.emit("protocolError", error);
      this.socket?.destroy();
    }
  }

  private handleHandshakeFrame(type: FrameType, payload: Buffer): void {
    if (type !== FrameType.Challenge || !this.guestNonce) {
      throw new Error("SIMULATOR_HANDSHAKE_ORDER_INVALID");
    }
    const challenge = decodeJson<{
      kind: "challenge";
      hostNonce: string;
      proof: string;
    }>(payload);
    const hostNonce = Buffer.from(challenge.hostNonce, "base64");
    this.sessionKey = createHmac("sha256", this.options.psk)
      .update("session-key\0", "ascii")
      .update(this.guestNonce)
      .update(hostNonce)
      .digest();
    const expectedHostProof = createHmac("sha256", this.sessionKey)
      .update("host-proof\0", "ascii")
      .digest();
    const receivedHostProof = Buffer.from(challenge.proof, "base64");
    if (
      receivedHostProof.length !== expectedHostProof.length ||
      !timingSafeEqual(receivedHostProof, expectedHostProof)
    ) {
      throw new Error("SIMULATOR_HOST_PROOF_INVALID");
    }
    const proof = createHmac("sha256", this.sessionKey)
      .update("guest-proof\0", "ascii")
      .digest("base64");
    this.writeFrame(
      FrameType.Authenticate,
      encodeJson({
        kind: "authenticate",
        proof,
        capabilities: this.capabilities()
      }),
      0n,
      false
    );
  }

  private capabilities(): GuestCapabilities {
    return {
      guestId: "simulated-win98",
      guestBuildId: "simulator-1",
      protocolVersion: 1,
      osName: "Microsoft Windows 98 Second Edition",
      osVersion: "4.10.2222 A",
      ansiCodePage: 1252,
      oemCodePage: 437,
      screenWidth: this.options.width,
      screenHeight: this.options.height,
      colorDepth: 24,
      supportsLongFileNames: true,
      supportsMouseWheel: true,
      maxPath: 260,
      maxFileBytes: 2_147_483_647,
      commands: [
        "screen_capture",
        "mouse",
        "keyboard",
        "clipboard",
        "windows",
        "shell",
        "processes",
        "filesystem",
        "system"
      ]
    };
  }

  private async handleRequest(request: GuestRequest): Promise<void> {
    let response: GuestResponse;
    try {
      const data = await this.dispatch(request.method, request.params);
      response = {
        kind: "response",
        requestId: request.requestId,
        ok: true,
        code: "OK",
        message: `${request.method} completed`,
        data
      };
    } catch (error) {
      const simulated = error instanceof SimulatedError ? error : undefined;
      response = {
        kind: "response",
        requestId: request.requestId,
        ok: false,
        code: simulated?.code ?? "SIMULATOR_OPERATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        ...(simulated?.data !== undefined ? { data: simulated.data } : {})
      };
    }
    this.sendSigned(FrameType.Response, encodeJson(response));
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (method === "session_abort") {
      this.cleanupInput();
      this.shells.clear();
      await this.cleanupTransfers();
      return { sanitized: true };
    }
    if (method === "screen_capture" || method === "window_capture") {
      return this.captureScreen();
    }
    if (method === "mouse_position") {
      return { x: this.mouse.x, y: this.mouse.y };
    }
    if (method.startsWith("mouse_")) {
      return this.handleMouse(method, params);
    }
    if (method.startsWith("keyboard_")) {
      return this.handleKeyboard(method, params);
    }
    if (method === "input_batch") {
      return this.handleInputBatch(params);
    }
    if (method === "clipboard_get") return { text: this.clipboard, format: "text" };
    if (method === "clipboard_set") {
      this.clipboard = String(params.text ?? "");
      return { length: this.clipboard.length };
    }
    if (method === "window_list") {
      return {
        windows: this.windows
          .filter(
            (window) => params.visible_only !== true || window.visible
          )
          .map((window) => ({
            ...window,
            focused: window.windowId === this.focusedWindowId
          }))
      };
    }
    if (method === "window_focus") return this.focusWindow(params);
    if (method === "window_close") return this.closeWindow(params);
    if (method === "shell_exec") return this.shellExec(params);
    if (method === "shell_start") return this.shellStart(params);
    if (method === "shell_read") return this.shellRead(params);
    if (method === "shell_write") return this.shellWrite(params);
    if (method === "shell_terminate" || method === "shell_close") {
      return this.shellStop(params);
    }
    if (method === "process_list")
      return {
        processes: [
          {
            processId: 1,
            parentProcessId: 0,
            executable: "SIMULATOR.EXE"
          },
          {
            processId: 2,
            parentProcessId: 1,
            executable: "NOTEPAD.EXE"
          },
          ...[...this.shells.values()].map((shell) => ({
            processId: shell.processId,
            parentProcessId: 1,
            executable: "COMMAND.COM",
            running: shell.running
          }))
        ]
      };
    if (method === "process_wait") return { processId: Number(params.process_id), exited: true, exitCode: 0 };
    if (method === "process_kill") return { processId: Number(params.process_id), killed: true };
    if (method.startsWith("fs_")) return this.handleFilesystem(method, params);
    if (method === "file_write_begin") return this.fileWriteBegin(params);
    if (method === "file_write_chunk") return this.fileWriteChunk(params);
    if (method === "file_write_commit") return this.fileWriteCommit(params);
    if (method === "file_write_abort") return this.fileWriteAbort(params);
    if (method === "file_read_chunk") return this.fileReadChunk(params);
    if (method === "system_info") return { capabilities: this.capabilities() };
    if (method === "system_reboot" || method === "system_shutdown")
      return { accepted: true, simulated: true };
    throw new SimulatedError("METHOD_NOT_SUPPORTED", method);
  }

  private captureScreen(): Record<string, unknown> {
    const png = new PNG({ width: this.options.width, height: this.options.height });
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const offset = (png.width * y + x) << 2;
        png.data[offset] = x % 256;
        png.data[offset + 1] = y % 256;
        png.data[offset + 2] = (x + y) % 256;
        png.data[offset + 3] = 255;
      }
    }
    return {
      width: png.width,
      height: png.height,
      colorDepth: 24,
      cursor: { x: this.mouse.x, y: this.mouse.y },
      mimeType: "image/png",
      imageBase64: PNG.sync.write(png).toString("base64")
    };
  }

  private handleMouse(
    method: string,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const applyPosition = (x: unknown, y: unknown): void => {
      if (x === undefined || y === undefined) return;
      const nextX = Number(x);
      const nextY = Number(y);
      if (
        !Number.isInteger(nextX) ||
        !Number.isInteger(nextY) ||
        nextX < 0 ||
        nextY < 0 ||
        nextX >= this.options.width ||
        nextY >= this.options.height
      ) {
        throw new SimulatedError("COORDINATE_OUT_OF_BOUNDS", `${nextX},${nextY}`);
      }
      this.mouse.x = nextX;
      this.mouse.y = nextY;
    };
    if (method === "mouse_drag") {
      applyPosition(params.to_x, params.to_y);
    } else {
      applyPosition(params.x, params.y);
    }
    const button = String(params.button ?? "left") as MouseButton;
    if (method === "mouse_down") this.mouse.buttons.add(button);
    if (method === "mouse_up") this.mouse.buttons.delete(button);
    if (method === "mouse_release_all") this.mouse.buttons.clear();
    this.inputEvents.push({ method, ...params, x: this.mouse.x, y: this.mouse.y });
    return {
      x: this.mouse.x,
      y: this.mouse.y,
      buttonsDown: [...this.mouse.buttons]
    };
  }

  private async handleKeyboard(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const key = String(params.key ?? params.virtual_key ?? params.scan_code ?? "");
    const action = String(params.action ?? "press");
    if (method === "keyboard_release_all") {
      this.pressedKeys.clear();
    } else if (method === "keyboard_hotkey") {
      this.pressedKeys.clear();
      const keys = Array.isArray(params.keys)
        ? params.keys.map((item) => String(item).toUpperCase())
        : [];
      if (this.focusedWindowId === 101 && keys.includes("CTRL")) {
        if (keys.includes("A")) {
          this.notepadSelectAll = true;
        } else if (keys.includes("V")) {
          this.notepadText = this.notepadSelectAll
            ? this.clipboard
            : `${this.notepadText}${this.clipboard}`;
          this.notepadSelectAll = false;
        } else if (keys.includes("S")) {
          const destination = this.resolveGuestPath(this.notepadGuestPath);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, this.notepadText, "ascii");
        }
      }
    } else if (method === "keyboard_type" && this.focusedWindowId === 101) {
      const text = String(params.text ?? "");
      this.notepadText = this.notepadSelectAll
        ? text
        : `${this.notepadText}${text}`;
      this.notepadSelectAll = false;
    } else if (action === "down") {
      this.pressedKeys.add(key);
    } else if (action === "up") {
      this.pressedKeys.delete(key);
    }
    this.inputEvents.push({ method, ...params });
    return { keysDown: [...this.pressedKeys] };
  }

  private async handleInputBatch(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(params.actions)) {
      throw new SimulatedError(
        "INVALID_ARGUMENT",
        "actions must be an array"
      );
    }
    const stopOnError = params.stop_on_error !== false;
    let completed = 0;
    const errors: Array<{ index: number; code: string; message: string }> = [];
    for (let index = 0; index < params.actions.length; index += 1) {
      const action = params.actions[index];
      try {
        if (!action || typeof action !== "object" || Array.isArray(action)) {
          throw new SimulatedError(
            "INVALID_ARGUMENT",
            `Batch action ${index} must be an object`
          );
        }
        const record = action as Record<string, unknown>;
        const actionType = requiredString(record, "type");
        if (actionType === "delay") {
          const milliseconds = requiredInteger(
            record,
            "milliseconds",
            0,
            10 * 60 * 1_000
          );
          await new Promise<void>((resolve) =>
            setTimeout(resolve, milliseconds)
          );
          this.inputEvents.push({ method: "delay", milliseconds });
        } else if (actionType.startsWith("mouse_")) {
          this.handleMouse(actionType, record);
        } else if (actionType.startsWith("keyboard_")) {
          await this.handleKeyboard(actionType, record);
        } else if (actionType === "clipboard_set") {
          this.clipboard = String(record.text ?? "");
          this.inputEvents.push({
            method: "clipboard_set",
            text: this.clipboard
          });
        } else if (actionType === "window_focus") {
          this.focusWindow(record);
        } else {
          throw new SimulatedError(
            "METHOD_NOT_SUPPORTED",
            `Batch action ${actionType} is not supported`
          );
        }
        completed += 1;
      } catch (error) {
        this.cleanupInput();
        const failure = {
          index,
          code:
            error instanceof SimulatedError
              ? error.code
              : "SIMULATOR_OPERATION_FAILED",
          message: error instanceof Error ? error.message : String(error)
        };
        if (stopOnError) throw error;
        errors.push(failure);
      }
    }
    if (params.screenshot_after === true) {
      return {
        ...this.captureScreen(),
        completed,
        failed: errors.length,
        errors
      };
    }
    return { completed, failed: errors.length, errors };
  }

  private focusWindow(
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const windowId = requiredInteger(params, "window_id", 1, 0xffffffff);
    const window = this.windows.find(
      (candidate) => candidate.windowId === windowId && candidate.visible
    );
    if (!window) {
      throw new SimulatedError(
        "WINDOW_NOT_FOUND",
        `Window ${windowId} is not available`
      );
    }
    if (!window.enabled) {
      throw new SimulatedError(
        "WINDOW_DISABLED",
        `Window ${windowId} is disabled`
      );
    }
    this.focusedWindowId = windowId;
    this.inputEvents.push({ method: "window_focus", window_id: windowId });
    return { windowId, accepted: true, focused: true };
  }

  private closeWindow(
    params: Record<string, unknown>
  ): Record<string, unknown> {
    const windowId = requiredInteger(params, "window_id", 1, 0xffffffff);
    const window = this.windows.find(
      (candidate) => candidate.windowId === windowId && candidate.visible
    );
    if (!window) {
      throw new SimulatedError(
        "WINDOW_NOT_FOUND",
        `Window ${windowId} is not available`
      );
    }
    window.visible = false;
    if (this.focusedWindowId === windowId) this.focusedWindowId = 100;
    return { windowId, accepted: true, closed: true };
  }

  private shellExec(params: Record<string, unknown>): Record<string, unknown> {
    const command = String(params.command ?? "");
    const failed = /(?:^|\s)(?:fail|false)(?:\s|$)/i.test(command);
    const notepad = command.match(
      /(?:^|\s)START\s+NOTEPAD(?:\.EXE)?\s+(.+?)\s*$/iu
    );
    if (notepad?.[1]) {
      const requestedPath = notepad[1].trim().replace(/^"|"$/gu, "");
      this.notepadGuestPath = requestedPath;
      this.notepadText = "";
      this.notepadSelectAll = false;
      const window = this.windows.find((candidate) => candidate.windowId === 101);
      if (window) {
        window.visible = true;
        window.title = `${path.win32.basename(requestedPath)} - Notepad`;
      }
    }
    const result: Record<string, unknown> = {
      command,
      stdout: failed ? "" : `simulated: ${command}\r\n`,
      stderr: failed ? `simulated failure: ${command}\r\n` : "",
      exitCode: failed ? 1 : 0,
      durationMs: 1,
      encoding: "cp437"
    };
    if (failed) {
      if (params.screenshot_on_error !== false) {
        Object.assign(result, this.captureScreen());
      }
      throw new SimulatedError(
        "COMMAND_FAILED",
        `Command exited with code 1: ${command}`,
        result
      );
    }
    return result;
  }

  private shellStart(params: Record<string, unknown>): Record<string, unknown> {
    const id = `sim-shell-${this.nextShellId++}`;
    const processId = this.nextProcessId++;
    const command = String(params.command ?? "");
    this.shells.set(id, {
      id,
      processId,
      output: Buffer.from(`simulated terminal: ${command}\r\n`, "utf8"),
      cursor: 0,
      running: true,
      exitCode: null,
      stdin: []
    });
    return { sessionId: id, processId, running: true };
  }

  private shellRead(params: Record<string, unknown>): Record<string, unknown> {
    const shell = this.requireShell(String(params.session_id ?? ""));
    const after = Number(params.after_cursor ?? 0);
    const maxBytes = Math.min(Number(params.max_bytes ?? 65_536), 65_536);
    const chunk = shell.output.subarray(after, after + maxBytes);
    return {
      sessionId: shell.id,
      processId: shell.processId,
      cursor: after + chunk.length,
      stdout: chunk.toString("utf8"),
      running: shell.running,
      exitCode: shell.exitCode
    };
  }

  private shellWrite(params: Record<string, unknown>): Record<string, unknown> {
    const shell = this.requireShell(String(params.session_id ?? ""));
    const data = params.base64
      ? Buffer.from(String(params.base64), "base64")
      : Buffer.from(String(params.text ?? ""), "utf8");
    shell.stdin.push(data);
    shell.output = Buffer.concat([shell.output, data]);
    if (params.eof === true) {
      shell.running = false;
      shell.exitCode = 0;
    }
    return {
      sessionId: shell.id,
      processId: shell.processId,
      acceptedBytes: data.length
    };
  }

  private shellStop(params: Record<string, unknown>): Record<string, unknown> {
    const shell = this.requireShell(String(params.session_id ?? ""));
    shell.running = false;
    shell.exitCode = methodExitCode(params);
    return {
      sessionId: shell.id,
      processId: shell.processId,
      running: false,
      exitCode: shell.exitCode
    };
  }

  private requireShell(id: string): SimulatedShell {
    const shell = this.shells.get(id);
    if (!shell) throw new SimulatedError("SHELL_NOT_FOUND", id);
    return shell;
  }

  private async handleFilesystem(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const guestPath = this.resolveGuestPath(String(params.path ?? params.source ?? ""));
    if (method === "fs_stat") {
      const info = await stat(guestPath);
      return { path: String(params.path), isDirectory: info.isDirectory(), size: info.size };
    }
    if (method === "fs_list") {
      const entries = (await readdir(guestPath, { withFileTypes: true })).sort(
        (left, right) =>
          left.name.localeCompare(right.name, "en", { sensitivity: "base" })
      );
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile()
        }))
      };
    }
    if (method === "fs_mkdir") {
      await mkdir(guestPath, { recursive: params.recursive !== false });
      return { created: true };
    }
    if (method === "fs_delete") {
      await rm(guestPath, {
        recursive: params.recursive === true,
        force: false
      });
      return { deleted: true };
    }
    if (method === "fs_move") {
      const destination = this.resolveGuestPath(String(params.destination ?? ""));
      await rename(guestPath, destination);
      return { moved: true };
    }
    throw new SimulatedError("METHOD_NOT_SUPPORTED", method);
  }

  private async fileWriteBegin(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const guestPath = requiredString(params, "path");
    const expectedSize = requiredInteger(
      params,
      "size",
      0,
      MAX_WIN98_FILE_BYTES
    );
    const expectedSha256 = requiredSha256(params, "sha256");
    const overwrite = params.overwrite === true;
    const finalPath = this.resolveGuestPath(guestPath);
    const parent = path.dirname(finalPath);
    await mkdir(parent, { recursive: true });
    try {
      const existing = await stat(finalPath);
      if (existing.isDirectory()) {
        throw new SimulatedError(
          "DESTINATION_IS_DIRECTORY",
          "Destination is a directory"
        );
      }
      if (!overwrite) {
        throw new SimulatedError("ALREADY_EXISTS", "Destination exists");
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    for (const candidate of [...this.writeTransfers.values()]) {
      if (candidate.finalPath !== finalPath) continue;
      if (
        candidate.expectedSize === expectedSize &&
        candidate.expectedSha256 === expectedSha256 &&
        candidate.overwrite === overwrite &&
        (await this.verifyWritePartial(candidate))
      ) {
        return {
          transferId: candidate.id,
          resumeOffset: candidate.offset
        };
      }
      await this.discardWriteTransfer(candidate);
    }

    const id = `sim-transfer-${this.nextTransferId++}`;
    const tempPath = path.join(
      parent,
      `.${path.basename(finalPath)}.${id}.tmp`
    );
    await rm(tempPath, { force: true });
    const file = await open(tempPath, "wx+");
    const emptyHash = createHash("sha256");
    this.writeTransfers.set(id, {
      id,
      finalPath,
      tempPath,
      file,
      expectedSize,
      expectedSha256,
      overwrite,
      offset: 0,
      hash: emptyHash,
      prefixSha256: emptyHash.copy().digest("hex")
    });
    return { transferId: id, resumeOffset: 0 };
  }

  private async fileWriteChunk(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const transfer = this.requireWriteTransfer(params);
    const offset = requiredInteger(
      params,
      "offset",
      0,
      MAX_WIN98_FILE_BYTES
    );
    if (offset !== transfer.offset) {
      throw new SimulatedError(
        "OFFSET_MISMATCH",
        `Expected offset ${transfer.offset}, received ${offset}`
      );
    }
    if (this.failWriteChunkOnceAtOffset === offset) {
      this.failWriteChunkOnceAtOffset = undefined;
      throw new SimulatedError(
        "TRANSIENT_TRANSFER_FAILURE",
        `Injected transient failure at offset ${offset}`
      );
    }
    const data = strictBase64(params, "dataBase64");
    if (data.length > TRANSFER_CHUNK_BYTES) {
      throw new SimulatedError(
        "CHUNK_TOO_LARGE",
        `Decoded chunk exceeds ${TRANSFER_CHUNK_BYTES} bytes`
      );
    }
    if (transfer.offset + data.length > transfer.expectedSize) {
      throw new SimulatedError(
        "SIZE_MISMATCH",
        "Chunk exceeds the declared file size"
      );
    }
    const expectedCrc32 = requiredInteger(params, "crc32", 0, 0xffffffff);
    const actualCrc32 = crc32(data);
    if (actualCrc32 !== expectedCrc32) {
      throw new SimulatedError(
        "CRC_MISMATCH",
        `Expected CRC32 ${expectedCrc32}, calculated ${actualCrc32}`
      );
    }
    const written = await transfer.file.write(
      data,
      0,
      data.length,
      transfer.offset
    );
    if (written.bytesWritten !== data.length) {
      throw new SimulatedError("TRANSFER_WRITE_FAILED", "Short write");
    }
    transfer.hash.update(data);
    transfer.offset += data.length;
    transfer.prefixSha256 = transfer.hash.copy().digest("hex");
    return { nextOffset: transfer.offset };
  }

  private async fileWriteCommit(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const transfer = this.requireWriteTransfer(params);
    let closed = false;
    try {
      if (transfer.offset !== transfer.expectedSize) {
        throw new SimulatedError(
          "SIZE_MISMATCH",
          `Expected ${transfer.expectedSize} bytes, received ${transfer.offset}`
        );
      }
      const declaredSha256 = requiredSha256(params, "sha256");
      const actualSha256 = transfer.hash.digest("hex");
      if (
        actualSha256 !== transfer.expectedSha256 ||
        actualSha256 !== declaredSha256
      ) {
        throw new SimulatedError(
          "SHA256_MISMATCH",
          "Transferred file hash did not match"
        );
      }
      await transfer.file.sync();
      await transfer.file.close();
      closed = true;
      if (!transfer.overwrite) {
        try {
          await stat(transfer.finalPath);
          throw new SimulatedError("ALREADY_EXISTS", "Destination exists");
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await rename(transfer.tempPath, transfer.finalPath);
      this.writeTransfers.delete(transfer.id);
      return {
        size: transfer.offset,
        sha256: actualSha256,
        committed: true
      };
    } catch (error) {
      this.writeTransfers.delete(transfer.id);
      if (!closed) await transfer.file.close().catch(() => undefined);
      await rm(transfer.tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async fileWriteAbort(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const transfer = this.requireWriteTransfer(params);
    this.writeTransfers.delete(transfer.id);
    await transfer.file.close().catch(() => undefined);
    await rm(transfer.tempPath, { force: true });
    return { aborted: true };
  }

  private async fileReadChunk(
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const guestPath = requiredString(params, "path");
    const offset = requiredInteger(
      params,
      "offset",
      0,
      MAX_WIN98_FILE_BYTES
    );
    const length = requiredInteger(
      params,
      "length",
      1,
      TRANSFER_CHUNK_BYTES
    );
    const guestFile = this.resolveGuestPath(guestPath);
    const file = await open(guestFile, "r");
    try {
      const before = await file.stat();
      if (!before.isFile()) {
        throw new SimulatedError("PATH_NOT_FILE", "Path is not a file");
      }
      if (before.size > MAX_WIN98_FILE_BYTES) {
        throw new SimulatedError(
          "FILE_TOO_LARGE",
          "File exceeds the Windows 98 transfer limit"
        );
      }
      if (offset > before.size) {
        throw new SimulatedError(
          "OFFSET_MISMATCH",
          `Offset ${offset} exceeds file size ${before.size}`
        );
      }
      const buffer = Buffer.alloc(Math.min(length, before.size - offset));
      const read =
        buffer.length === 0
          ? { bytesRead: 0 }
          : await file.read(buffer, 0, buffer.length, offset);
      const data = buffer.subarray(0, read.bytesRead);
      const nextOffset = offset + data.length;
      const eof = nextOffset === before.size;
      let sha256: string | undefined;
      if (eof) {
        sha256 = await hashFile(file, before.size);
        const after = await file.stat();
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        ) {
          throw new SimulatedError(
            "FILE_CHANGED_DURING_TRANSFER",
            "File changed while hashing"
          );
        }
      }
      return {
        dataBase64: data.toString("base64"),
        offset,
        nextOffset,
        eof,
        size: before.size,
        crc32: crc32(data),
        ...(sha256 ? { sha256 } : {})
      };
    } finally {
      await file.close();
    }
  }

  private requireWriteTransfer(
    params: Record<string, unknown>
  ): SimulatedWriteTransfer {
    const id = requiredString(params, "transferId");
    const transfer = this.writeTransfers.get(id);
    if (!transfer) {
      throw new SimulatedError(
        "TRANSFER_NOT_FOUND",
        "Transfer is not active"
      );
    }
    return transfer;
  }

  private async cleanupTransfers(): Promise<void> {
    const transfers = [...this.writeTransfers.values()];
    this.writeTransfers.clear();
    await Promise.allSettled(
      transfers.map(async (transfer) => this.discardWriteTransfer(transfer))
    );
  }

  private async verifyWritePartial(
    transfer: SimulatedWriteTransfer
  ): Promise<boolean> {
    try {
      const info = await transfer.file.stat();
      if (!info.isFile() || info.size !== transfer.offset) return false;
      const actual = await hashFile(transfer.file, transfer.offset);
      return actual === transfer.prefixSha256;
    } catch {
      return false;
    }
  }

  private async discardWriteTransfer(
    transfer: SimulatedWriteTransfer
  ): Promise<void> {
    this.writeTransfers.delete(transfer.id);
    await transfer.file.close().catch(() => undefined);
    await rm(transfer.tempPath, { force: true }).catch(() => undefined);
  }

  private resolveGuestPath(guestPath: string): string {
    const normalized = guestPath
      .replace(/^[A-Za-z]:/, "")
      .replaceAll("\\", "/")
      .replace(/^\/+/, "");
    const resolved = path.resolve(this.options.rootDirectory, normalized);
    const root = path.resolve(this.options.rootDirectory);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new SimulatedError("PATH_OUTSIDE_ALLOWED_ROOT", guestPath);
    }
    return resolved;
  }

  private handleCancel(request: { requestId: string }): void {
    this.emit("cancelled", request.requestId);
  }

  private cleanupInput(): void {
    this.mouse.buttons.clear();
    this.pressedKeys.clear();
  }

  private sendSigned(type: FrameType, payload: Buffer): void {
    if (!this.sessionKey) throw new Error("SIMULATOR_NOT_AUTHENTICATED");
    this.writeFrame(type, payload, this.guestSequence++, true);
  }

  private writeFrame(
    type: FrameType,
    payload: Buffer,
    sequence: bigint,
    signed: boolean
  ): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(
      encodeFrame(
        { type, flags: 0, streamId: 0, sequence },
        payload,
        signed ? this.sessionKey : undefined,
        "guest-to-host"
      )
    );
  }
}

class SimulatedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

function methodExitCode(params: Record<string, unknown>): number {
  return params.force === false ? 0 : -1;
}

function requiredString(
  params: Record<string, unknown>,
  key: string
): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SimulatedError("INVALID_ARGUMENT", `${key} is required`);
  }
  return value;
}

function requiredInteger(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number {
  const value = params[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new SimulatedError(
      "INVALID_ARGUMENT",
      `${key} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return value;
}

function requiredSha256(
  params: Record<string, unknown>,
  key: string
): string {
  const value = requiredString(params, key).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new SimulatedError(
      "INVALID_ARGUMENT",
      `${key} must be a SHA-256 hex digest`
    );
  }
  return value;
}

function strictBase64(
  params: Record<string, unknown>,
  key: string
): Buffer {
  const value = params[key];
  if (typeof value !== "string") {
    throw new SimulatedError("INVALID_ARGUMENT", `${key} is required`);
  }
  const data = Buffer.from(value, "base64");
  if (
    data.toString("base64").replace(/=+$/u, "") !==
    value.replace(/=+$/u, "")
  ) {
    throw new SimulatedError("INVALID_BASE64", `${key} is invalid`);
  }
  return data;
}

async function hashFile(file: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const wanted = Math.min(buffer.length, size - offset);
    const read = await file.read(buffer, 0, wanted, offset);
    if (read.bytesRead <= 0) {
      throw new SimulatedError(
        "FILE_CHANGED_DURING_TRANSFER",
        "File became shorter while hashing"
      );
    }
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  return hash.digest("hex");
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function writeSimulatorFixture(
  rootDirectory: string
): Promise<void> {
  await mkdir(rootDirectory, { recursive: true });
  await writeFile(path.join(rootDirectory, "README.TXT"), "Windows 98 simulator\r\n");
  const content = await readFile(path.join(rootDirectory, "README.TXT"));
  if (content.length === 0) throw new Error("SIMULATOR_FIXTURE_WRITE_FAILED");
}
