import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectBroker,
  startBroker,
  type Broker,
  type BrokerConfig,
  type BrokerClient
} from "../src/host/index.js";
import { SimulatedGuest } from "../src/simulator/index.js";
import { BrokerClient as TcpBrokerClient } from "../src/mcp/broker-client.js";
import { ClientTransferRunner } from "../src/mcp/client-transfers.js";

interface Harness {
  broker: Broker;
  simulator: SimulatedGuest;
  config: BrokerConfig;
  root: string;
  clients: BrokerClient[];
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const client of harness.clients) client.close();
    await harness.simulator.stop();
    await harness.broker.stop();
    await rm(harness.root, { recursive: true, force: true });
  }
});

describe("broker with deterministic guest", () => {
  it("accepts local adapters without a credential on the fixed unauthenticated protocol", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "local-adapter");
    await expect(client.call("vm_status")).resolves.toMatchObject({
      result: { ok: true, code: "OK" }
    });
  });

  it("returns crash and supervisor diagnostics without acquiring the VM lease", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "diagnostics");
    const reply = await client.call("agent_diagnostics");
    expect(reply.result).toMatchObject({
      ok: true,
      data: {
        crashLogPath: "MCPCRASH.LOG",
        supervisorLogPath: "MCPSUPERVISOR.LOG"
      },
      lease: { held: false }
    });
  });

  it("connects, captures a screen, and enforces exclusive ownership", async () => {
    const harness = await createHarness();
    const owner = await createClient(harness, "owner");
    const contender = await createClient(harness, "contender");

    const status = await owner.call("vm_status");
    expect(status.result.ok).toBe(true);
    expect(status.result.connection.state).toBe("online");
    expect(status.result.lease.held).toBe(false);

    const capture = await owner.call("screen_capture", {
      include_cursor: true
    });
    expect(capture.result.ok).toBe(true);
    expect(capture.result.lease.heldByCaller).toBe(true);
    expect(capture.image?.mimeType).toBe("image/png");
    expect(Buffer.from(capture.image?.data ?? "", "base64").subarray(1, 4).toString()).toBe("PNG");

    const busy = await contender.call("mouse_position");
    expect(busy.result.ok).toBe(false);
    expect(busy.result.code).toBe("VM_BUSY");

    const unlock = await owner.call("vm_unlock", { force: true });
    expect(unlock.result.ok).toBe(true);

    const acquired = await contender.call("mouse_move", { x: 42, y: 24 });
    expect(acquired.result.ok).toBe(true);
    expect(acquired.result.lease.heldByCaller).toBe(true);
    const position = await contender.call("mouse_position");
    expect(position.result.data).toMatchObject({ x: 42, y: 24 });
    await contender.call("vm_unlock", { force: true });
  });

  it("lists adapters, disconnects another lease owner, and sanitizes before handoff", async () => {
    const harness = await createHarness();
    const owner = await createClient(harness, "disconnect-owner");
    const admin = await createClient(harness, "disconnect-admin");

    expect((await owner.call("mouse_position")).result.ok).toBe(true);
    const sessions = await admin.call("broker_sessions");
    expect(sessions.result.data).toMatchObject({
      lockingEnabled: true,
      sessions: expect.arrayContaining([
        expect.objectContaining({ sessionId: owner.sessionId, label: "disconnect-owner", holdsLease: true }),
        expect.objectContaining({ sessionId: admin.sessionId, current: true })
      ])
    });

    const disconnected = await admin.call("broker_disconnect_session", { session_id: owner.sessionId });
    expect(disconnected.result.ok).toBe(true);
    await waitFor(() => !owner.connected, 2_000);
    await waitFor(() => !harness.broker.lease.currentOwner, 2_000);

    expect((await admin.call("mouse_position")).result.ok).toBe(true);
    await admin.call("vm_unlock", { force: true });
  });

  it("allows advisory parallel operations only after exclusive owner releases", async () => {
    const harness = await createHarness();
    const first = await createClient(harness, "parallel-first");
    const second = await createClient(harness, "parallel-second");

    expect((await first.call("mouse_position")).result.ok).toBe(true);
    expect((await second.call("broker_set_locking", { enabled: false })).result).toMatchObject({
      ok: false,
      code: "VM_BUSY"
    });
    await first.call("vm_unlock", { force: true });

    expect((await second.call("broker_set_locking", { enabled: false })).result).toMatchObject({
      ok: true,
      data: { lockingEnabled: false }
    });
    expect((await first.call("mouse_position")).result.ok).toBe(true);
    expect((await second.call("mouse_position")).result.ok).toBe(true);
    const status = await second.call("vm_status");
    expect(status.result.data).toMatchObject({
      lease: { held: false, lockingEnabled: false }
    });
    expect((await first.call("vm_unlock")).result.code).toBe("LOCKING_DISABLED");
    expect((await second.call("broker_set_locking", { enabled: true })).result.ok).toBe(true);
  });

  it("round-trips clipboard, shell, filesystem, and input batch", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "features");
    try {
      expect(
        (await client.call("clipboard_set", { text: "hello 98" })).result.ok
      ).toBe(true);
      expect(
        (await client.call("clipboard_get", { format: "text" })).result.data
      ).toMatchObject({ text: "hello 98" });

      const shell = await client.call("shell_exec", {
        command: "ECHO TEST"
      });
      expect(shell.result.data).toMatchObject({
        exitCode: 0,
        stdout: expect.stringContaining("ECHO TEST")
      });
      const failedShell = await client.call("shell_exec", {
        command: "FAIL",
        screenshot_on_error: true
      });
      expect(failedShell.result).toMatchObject({
        ok: false,
        code: "COMMAND_FAILED",
        data: {
          exitCode: 1,
          stderr: expect.stringContaining("simulated failure")
        }
      });
      expect(failedShell.image?.mimeType).toBe("image/png");
      expect(
        Buffer.from(failedShell.image?.data ?? "", "base64")
          .subarray(1, 4)
          .toString()
      ).toBe("PNG");
      const terminal = await client.call("shell_start", {
        command: "COMMAND.COM"
      });
      expect(terminal.result.data).toMatchObject({
        sessionId: "sim-shell-1",
        processId: 1000,
        running: true
      });
      expect(
        (await client.call("process_list")).result.data
      ).toMatchObject({
        processes: expect.arrayContaining([
          expect.objectContaining({
            processId: 1000,
            executable: "COMMAND.COM",
            running: true
          })
        ])
      });
      await client.call("shell_close", { session_id: "sim-shell-1" });

      const windows = await client.call("window_list", {
        visible_only: true
      });
      expect(windows.result.data).toMatchObject({
        windows: expect.arrayContaining([
          expect.objectContaining({
            windowId: 101,
            title: "Untitled - Notepad",
            className: "Notepad",
            processId: 2
          })
        ])
      });

      const directory = await client.call("fs_mkdir", {
        path: "C:\\MCPTEST",
        recursive: true
      });
      expect(directory.result.ok).toBe(true);
      const listing = await client.call("fs_list", {
        path: "C:\\"
      });
      expect(listing.result.data).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ name: "MCPTEST", isDirectory: true })
        ])
      });

      const batch = await client.call("input_batch", {
        actions: [
          { type: "mouse_click", x: 10, y: 20 },
          { type: "keyboard_type", text: "hello" },
          { type: "keyboard_hotkey", keys: ["CTRL", "S"] }
        ]
      });
      expect(batch.result.ok).toBe(true);
    } finally {
      await client.call("vm_unlock", { force: true });
    }
  });

  it("applies batch clipboard/window actions and honors stop_on_error", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "batch-semantics");
    try {
      await client.call("clipboard_set", { text: "before" });
      const continued = await client.call("input_batch", {
        actions: [
          { type: "keyboard_key", key: "CTRL", action: "down" },
          { type: "window_focus", window_id: 999_999 },
          { type: "clipboard_set", text: "after" },
          { type: "window_focus", window_id: 101 }
        ],
        stop_on_error: false
      });
      expect(continued.result).toMatchObject({
        ok: true,
        data: {
          completed: 3,
          failed: 1,
          errors: [
            expect.objectContaining({
              index: 1,
              code: "WINDOW_NOT_FOUND"
            })
          ]
        }
      });
      expect(
        (await client.call("clipboard_get", { format: "text" })).result.data
      ).toMatchObject({ text: "after" });
      expect(
        (await client.call("window_list", { visible_only: true })).result.data
      ).toMatchObject({
        windows: expect.arrayContaining([
          expect.objectContaining({
            windowId: 101,
            title: "Untitled - Notepad",
            focused: true
          })
        ])
      });
      expect(
        (
          await client.call("keyboard_key", {
            key: "SHIFT",
            action: "down"
          })
        ).result.data
      ).toMatchObject({ keysDown: ["SHIFT"] });
      await client.call("keyboard_release_all");

      await client.call("clipboard_set", { text: "unchanged" });
      const stopped = await client.call("input_batch", {
        actions: [
          { type: "window_focus", window_id: 999_999 },
          { type: "clipboard_set", text: "must-not-run" }
        ],
        stop_on_error: true
      });
      expect(stopped.result).toMatchObject({
        ok: false,
        code: "WINDOW_NOT_FOUND"
      });
      expect(
        (await client.call("clipboard_get", { format: "text" })).result.data
      ).toMatchObject({ text: "unchanged" });

      expect(harness.simulator.snapshotInputEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "clipboard_set",
            text: "after"
          }),
          expect.objectContaining({
            method: "window_focus",
            window_id: 101
          })
        ])
      );
    } finally {
      await client.call("vm_unlock", { force: true });
    }
  });

  it("models Notepad typing, selection, paste, save, and close", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "notepad-model");
    const pulled = path.join(harness.root, "notepad-pulled.txt");
    const marker = "WIN98 MCP NOTEPAD SIMULATOR";
    try {
      expect(
        (
          await client.call("shell_exec", {
            command: "START NOTEPAD.EXE C:\\MCPTEST\\NOTE.TXT",
            screenshot_on_error: true
          })
        ).result.ok
      ).toBe(true);
      expect(
        (await client.call("window_focus", { window_id: 101 })).result.ok
      ).toBe(true);
      await client.call("keyboard_type", {
        text: "temporary text",
        interval_ms: 0
      });
      await client.call("keyboard_hotkey", { keys: ["CTRL", "A"] });
      await client.call("clipboard_set", { text: marker });
      await client.call("keyboard_hotkey", { keys: ["CTRL", "V"] });
      await client.call("keyboard_hotkey", { keys: ["CTRL", "S"] });
      await client.call("window_close", { window_id: 101 });

      const pull = await client.call("file_pull", {
        guest_path: "C:\\MCPTEST\\NOTE.TXT",
        host_path: pulled
      });
      expect(pull.result.ok).toBe(true);
      expect(await readFile(pulled, "ascii")).toBe(marker);
    } finally {
      await client.call("vm_unlock", { force: true });
    }
  });

  it("round-trips a multi-chunk binary file through broker transfers", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "binary-transfer");
    const source = path.join(harness.root, "host-source", "binary.dat");
    const destination = path.join(harness.root, "host-pull", "binary.dat");
    const contents = deterministicBytes(TRANSFER_TEST_BYTES);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, contents);

    try {
      const pushed = await client.call("file_push", {
        host_path: source,
        guest_path: "C:\\MCPTEST\\BINARY.DAT"
      });
      expect(pushed.result.ok).toBe(true);
      expect(pushed.result.data).toMatchObject({
        direction: "host-to-guest",
        files: 1,
        bytes: contents.length,
        chunks: 2
      });

      const pulled = await client.call("file_pull", {
        guest_path: "C:\\MCPTEST\\BINARY.DAT",
        host_path: destination
      });
      expect(pulled.result.ok).toBe(true);
      expect(pulled.result.data).toMatchObject({
        direction: "guest-to-host",
        files: 1,
        bytes: contents.length,
        chunks: 2
      });
      expect(await readFile(destination)).toEqual(contents);
    } finally {
      await client.call("vm_unlock", { force: true });
    }
  });

  it("runs verified transfers on the TCP client's local filesystem", async () => {
    const harness = await createHarness();
    const source = path.join(harness.root, "mac-client", "source.bin");
    const pulled = path.join(harness.root, "mac-client", "pulled.bin");
    const sourceDirectory = path.join(harness.root, "mac-client", "directory-source");
    const pulledDirectory = path.join(harness.root, "mac-client", "directory-pulled");
    const contents = deterministicBytes(64 * 1024 + 117);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, contents);
    await mkdir(path.join(sourceDirectory, "nested"), { recursive: true });
    await writeFile(path.join(sourceDirectory, "nested", "marker.txt"), "client-side directory transfer", "utf8");
    const tcpClient = new TcpBrokerClient({
      host: "127.0.0.1",
      port: harness.config.adapterPort,
      sessionLabel: "macos-tcp-client-transfer",
      requestTimeoutMs: 10_000
    });
    const transfer = new ClientTransferRunner(tcpClient);
    try {
      const pushed = await transfer.execute("file_push", {
        host_path: source,
        guest_path: "C:\\MCPTEST\\TCP-CLIENT.BIN"
      });
      expect(pushed).toMatchObject({ direction: "host-to-guest", bytes: contents.length, sha256: expect.any(String) });
      const downloaded = await transfer.execute("file_pull", {
        guest_path: "C:\\MCPTEST\\TCP-CLIENT.BIN",
        host_path: pulled
      });
      expect(downloaded).toMatchObject({ direction: "guest-to-host", bytes: contents.length, sha256: expect.any(String) });
      expect(await readFile(pulled)).toEqual(contents);
      const pushedDirectory = await transfer.execute("directory_push", {
        host_path: sourceDirectory,
        guest_path: "C:\\MCPTEST\\TCP-DIRECTORY"
      });
      expect(pushedDirectory).toMatchObject({ direction: "host-to-guest", files: 1, directories: 1 });
      const pulledDirectoryResult = await transfer.execute("directory_pull", {
        guest_path: "C:\\MCPTEST\\TCP-DIRECTORY",
        host_path: pulledDirectory
      });
      expect(pulledDirectoryResult).toMatchObject({ direction: "guest-to-host", files: 1, directories: 1 });
      expect(await readFile(path.join(pulledDirectory, "nested", "marker.txt"), "utf8")).toBe("client-side directory transfer");
      await tcpClient.request("vm_unlock", { force: false });
    } finally {
      await transfer.abort().catch(() => undefined);
      await tcpClient.request("vm_unlock", { force: true }).catch(() => undefined);
      await tcpClient.close();
    }
  });

  it("resumes a verified partial upload after a transient chunk failure", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "resumed-transfer");
    const source = path.join(harness.root, "resume-source.bin");
    const guestDirectory = path.join(harness.root, "guest", "MCPTEST");
    const guestFile = path.join(guestDirectory, "RESUME.BIN");
    const contents = deterministicBytes(2 * 64 * 1024 + 1_337);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(source, contents);
    harness.simulator.injectWriteChunkFailureOnce(64 * 1024);

    try {
      const interrupted = await client.call("file_push", {
        host_path: source,
        guest_path: "C:\\MCPTEST\\RESUME.BIN",
        overwrite: true
      });
      expect(interrupted.result).toMatchObject({
        ok: false,
        code: "TRANSIENT_TRANSFER_FAILURE"
      });
      await expect(stat(guestFile)).rejects.toMatchObject({ code: "ENOENT" });

      const resumeProbe = await client.call("file_write_begin", {
        path: "C:\\MCPTEST\\RESUME.BIN",
        size: contents.length,
        sha256,
        overwrite: true
      });
      expect(resumeProbe.result).toMatchObject({
        ok: true,
        data: { resumeOffset: 64 * 1024 }
      });

      const resumed = await client.call("file_push", {
        host_path: source,
        guest_path: "C:\\MCPTEST\\RESUME.BIN",
        overwrite: true
      });
      expect(resumed.result).toMatchObject({
        ok: true,
        data: {
          bytes: contents.length,
          chunks: 2,
          sha256
        }
      });
      const committed = await readFile(guestFile);
      expect(committed).toEqual(contents);
      expect(createHash("sha256").update(committed).digest("hex")).toBe(sha256);
      expect(await readdir(guestDirectory)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/\.tmp$/u)])
      );
    } finally {
      await client.call("vm_unlock", { force: true });
    }
  });

  it("removes resumable partials during forced session cleanup", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "resume-cleanup");
    const source = path.join(harness.root, "cleanup-source.bin");
    const guestDirectory = path.join(harness.root, "guest", "MCPTEST");
    const contents = deterministicBytes(64 * 1024 + 123);
    await writeFile(source, contents);
    harness.simulator.injectWriteChunkFailureOnce(64 * 1024);

    const interrupted = await client.call("file_push", {
      host_path: source,
      guest_path: "C:\\MCPTEST\\CLEANUP.BIN",
      overwrite: true
    });
    expect(interrupted.result.ok).toBe(false);
    expect(await readdir(guestDirectory)).toEqual(
      expect.arrayContaining([expect.stringMatching(/\.tmp$/u)])
    );
    expect((await client.call("vm_unlock", { force: true })).result.ok).toBe(
      true
    );
    expect(await readdir(guestDirectory)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\.tmp$/u)])
    );
  });

  it("round-trips nested files and empty directories through broker transfers", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "directory-transfer");
    const source = path.join(harness.root, "tree-source");
    const destination = path.join(harness.root, "tree-pull");
    const nestedBinary = deterministicBytes(TRANSFER_TEST_BYTES + 73);
    await mkdir(path.join(source, "nested", "empty"), { recursive: true });
    await writeFile(path.join(source, "ROOT.TXT"), "Windows 98\r\n", "ascii");
    await writeFile(path.join(source, "nested", "DATA.BIN"), nestedBinary);

    try {
      const pushed = await client.call("directory_push", {
        host_path: source,
        guest_path: "C:\\MCPTEST\\TREE"
      });
      expect(pushed.result.ok).toBe(true);
      expect(pushed.result.data).toMatchObject({
        direction: "host-to-guest",
        files: 2,
        directories: 2
      });

      const pulled = await client.call("directory_pull", {
        guest_path: "C:\\MCPTEST\\TREE",
        host_path: destination
      });
      expect(pulled.result.ok).toBe(true);
      expect(pulled.result.data).toMatchObject({
        direction: "guest-to-host",
        files: 2,
        directories: 2
      });
      expect(await readFile(path.join(destination, "ROOT.TXT"), "ascii")).toBe(
        "Windows 98\r\n"
      );
      expect(
        await readFile(path.join(destination, "nested", "DATA.BIN"))
      ).toEqual(nestedBinary);
      expect(
        (await stat(path.join(destination, "nested", "empty"))).isDirectory()
      ).toBe(true);
    } finally {
      await client.call("vm_unlock", { force: true });
    }
  });

  it("enforces transfer limits, offsets, CRC, hashes, aborts, and temporary commit", async () => {
    const harness = await createHarness();
    const client = await createClient(harness, "transfer-validation");
    const guestDirectory = path.join(harness.root, "guest", "MCPTEST");
    const guestFile = path.join(guestDirectory, "ATOMIC.BIN");
    const contents = Buffer.from("atomic simulator transfer\0\r\n", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");

    try {
      const firstId = await beginGuestWrite(
        client,
        "C:\\MCPTEST\\ATOMIC.BIN",
        contents.length,
        sha256
      );
      const wrongOffset = await client.call("file_write_chunk", {
        transferId: firstId,
        offset: 1,
        dataBase64: contents.toString("base64"),
        crc32: testCrc32(contents)
      });
      expect(wrongOffset.result).toMatchObject({
        ok: false,
        code: "OFFSET_MISMATCH"
      });
      const wrongCrc = await client.call("file_write_chunk", {
        transferId: firstId,
        offset: 0,
        dataBase64: contents.toString("base64"),
        crc32: 0
      });
      expect(wrongCrc.result).toMatchObject({
        ok: false,
        code: "CRC_MISMATCH"
      });
      expect(
        (
          await client.call("file_write_abort", {
            transferId: firstId
          })
        ).result.ok
      ).toBe(true);
      expect(await readdir(guestDirectory)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/\.tmp$/u)])
      );

      const oversized = deterministicBytes(64 * 1024 + 1);
      const oversizedId = await beginGuestWrite(
        client,
        "C:\\MCPTEST\\OVERSIZE.BIN",
        oversized.length,
        createHash("sha256").update(oversized).digest("hex")
      );
      const tooLarge = await client.call("file_write_chunk", {
        transferId: oversizedId,
        offset: 0,
        dataBase64: oversized.toString("base64"),
        crc32: testCrc32(oversized)
      });
      expect(tooLarge.result).toMatchObject({
        ok: false,
        code: "CHUNK_TOO_LARGE"
      });
      await client.call("file_write_abort", { transferId: oversizedId });

      const mismatchedId = await beginGuestWrite(
        client,
        "C:\\MCPTEST\\MISMATCH.BIN",
        contents.length,
        "0".repeat(64)
      );
      expect(
        (
          await client.call("file_write_chunk", {
            transferId: mismatchedId,
            offset: 0,
            dataBase64: contents.toString("base64"),
            crc32: testCrc32(contents)
          })
        ).result.ok
      ).toBe(true);
      const mismatched = await client.call("file_write_commit", {
        transferId: mismatchedId,
        sha256
      });
      expect(mismatched.result).toMatchObject({
        ok: false,
        code: "SHA256_MISMATCH"
      });
      await expect(
        stat(path.join(guestDirectory, "MISMATCH.BIN"))
      ).rejects.toMatchObject({ code: "ENOENT" });

      const committedId = await beginGuestWrite(
        client,
        "C:\\MCPTEST\\ATOMIC.BIN",
        contents.length,
        sha256
      );
      expect(
        (
          await client.call("file_write_chunk", {
            transferId: committedId,
            offset: 0,
            dataBase64: contents.toString("base64"),
            crc32: testCrc32(contents)
          })
        ).result.ok
      ).toBe(true);
      await expect(stat(guestFile)).rejects.toMatchObject({ code: "ENOENT" });
      const committed = await client.call("file_write_commit", {
        transferId: committedId,
        sha256
      });
      expect(committed.result.ok).toBe(true);
      expect(await readFile(guestFile)).toEqual(contents);
      expect(await readdir(guestDirectory)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/\.tmp$/u)])
      );

      const readChunk = await client.call("file_read_chunk", {
        path: "C:\\MCPTEST\\ATOMIC.BIN",
        offset: 0,
        length: contents.length
      });
      expect(readChunk.result).toMatchObject({
        ok: true,
        data: {
          offset: 0,
          nextOffset: contents.length,
          eof: true,
          size: contents.length,
          crc32: testCrc32(contents),
          sha256
        }
      });
      expect(
        Buffer.from(
          String(
            (readChunk.result.data as { dataBase64?: unknown }).dataBase64
          ),
          "base64"
        )
      ).toEqual(contents);

      const excessiveRead = await client.call("file_read_chunk", {
        path: "C:\\MCPTEST\\ATOMIC.BIN",
        offset: 0,
        length: 64 * 1024 + 1
      });
      expect(excessiveRead.result).toMatchObject({
        ok: false,
        code: "INVALID_ARGUMENT"
      });
      const invalidReadOffset = await client.call("file_read_chunk", {
        path: "C:\\MCPTEST\\ATOMIC.BIN",
        offset: contents.length + 1,
        length: 1
      });
      expect(invalidReadOffset.result).toMatchObject({
        ok: false,
        code: "OFFSET_MISMATCH"
      });
    } finally {
      await client.call("vm_unlock", { force: true });
    }
  });
});

const TRANSFER_TEST_BYTES = 64 * 1024 + 1_337;

function deterministicBytes(length: number): Buffer {
  const result = Buffer.alloc(length);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = (index * 31 + Math.floor(index / 257) + 17) & 0xff;
  }
  return result;
}

async function beginGuestWrite(
  client: BrokerClient,
  guestPath: string,
  size: number,
  sha256: string
): Promise<string> {
  const response = await client.call("file_write_begin", {
    path: guestPath,
    size,
    sha256,
    overwrite: false
  });
  expect(response.result.ok).toBe(true);
  const data = response.result.data as { transferId?: unknown } | undefined;
  expect(typeof data?.transferId).toBe("string");
  return String(data?.transferId);
}

function testCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-test-"));
  const guestPort = await freePort();
  const adapterPort = await freePort();
  const pipePath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\win98-mcp-test-${randomUUID()}`
      : path.join(root, "broker.sock");
  const config: BrokerConfig = {
    bindHost: "0.0.0.0",
    guestPort,
    adapterPort,
    lockingEnabled: true,
    pipePath,
    stateDir: root,
    artifactDir: path.join(root, "artifacts"),
    logPath: path.join(root, "broker.jsonl"),
    leaseTtlMs: 30 * 60 * 1000,
    waitTicketTtlMs: 10 * 60 * 1000,
    requestTimeoutMs: 10_000,
    guestConnectTimeoutMs: 5_000,
    heartbeatTimeoutMs: 30_000,
    maxArtifactBytes: 8 * 1024 * 1024,
  };
  const broker = await startBroker(config);
  const simulator = new SimulatedGuest({
    host: "127.0.0.1",
    port: guestPort,
    rootDirectory: path.join(root, "guest")
  });
  const harness: Harness = { broker, simulator, config, root, clients: [] };
  harnesses.push(harness);
  await simulator.start();
  await waitFor(() => broker.snapshot.state === "online", 5_000);
  return harness;
}

async function createClient(
  harness: Harness,
  label: string
): Promise<BrokerClient> {
  const client = await connectBroker({
    pipePath: harness.config.pipePath,
    sessionLabel: label,
    requestTimeoutMs: 10_000
  });
  harness.clients.push(client);
  return client;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("FREE_PORT_UNAVAILABLE");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_TIMEOUT");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
