import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TransferCoordinator } from "../src/host/index.js";
import type { GuestResponse } from "../src/shared/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("guest-to-host transfer resume", () => {
  it("continues from a retained verified host partial after a transient read error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-pull-resume-"));
    roots.push(root);
    const destination = path.join(root, "download.bin");
    const guestBytes = Buffer.alloc(150_000);
    for (let index = 0; index < guestBytes.length; index += 1) {
      guestBytes[index] = (index * 13 + 7) & 0xff;
    }
    const digest = createHash("sha256").update(guestBytes).digest("hex");
    const requestedOffsets: number[] = [];
    let failOnce = true;

    const coordinator = new TransferCoordinator(
      async (_sessionId, method, params): Promise<GuestResponse> => {
        if (method !== "file_read_chunk") {
          throw new Error(`UNEXPECTED_METHOD:${method}`);
        }
        const offset = Number(params["offset"]);
        requestedOffsets.push(offset);
        if (offset === 64 * 1024 && failOnce) {
          failOnce = false;
          throw new Error("TRANSIENT_GUEST_READ_FAILURE");
        }
        const end = Math.min(offset + 64 * 1024, guestBytes.length);
        const data = guestBytes.subarray(offset, end);
        const eof = end === guestBytes.length;
        return {
          kind: "response",
          requestId: `read-${offset}`,
          ok: true,
          code: "OK",
          message: "chunk",
          data: {
            offset,
            nextOffset: end,
            size: guestBytes.length,
            eof,
            dataBase64: data.toString("base64"),
            ...(eof ? { sha256: digest } : {})
          }
        };
      },
      () => undefined,
      () => undefined,
      5_000
    );

    await expect(
      coordinator.execute("session", "file_pull", {
        guest_path: "C:\\MCPTEST\\DOWNLOAD.BIN",
        host_path: destination,
        overwrite: true
      })
    ).rejects.toThrow("TRANSIENT_GUEST_READ_FAILURE");

    const result = await coordinator.execute("session", "file_pull", {
      guest_path: "C:\\MCPTEST\\DOWNLOAD.BIN",
      host_path: destination,
      overwrite: true
    });
    expect(result.bytes).toBe(guestBytes.length);
    expect(result.chunks).toBe(2);
    expect(requestedOffsets).toEqual([0, 64 * 1024, 64 * 1024, 128 * 1024]);
    await expect(readFile(destination)).resolves.toEqual(guestBytes);
    expect(
      (await readdir(root)).some((name) => name.includes("win98mcp.partial"))
    ).toBe(false);
  });

  it("removes a retained host partial during session cleanup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "win98-pull-cleanup-"));
    roots.push(root);
    const destination = path.join(root, "download.bin");
    const guestBytes = Buffer.alloc(70_000, 0x5a);
    let calls = 0;
    const coordinator = new TransferCoordinator(
      async (_sessionId, method, params): Promise<GuestResponse> => {
        if (method !== "file_read_chunk") {
          throw new Error(`UNEXPECTED_METHOD:${method}`);
        }
        calls += 1;
        if (calls === 2) {
          throw new Error("TRANSIENT_GUEST_READ_FAILURE");
        }
        const offset = Number(params["offset"]);
        const end = Math.min(offset + 64 * 1024, guestBytes.length);
        return {
          kind: "response",
          requestId: `read-${offset}`,
          ok: true,
          code: "OK",
          message: "chunk",
          data: {
            offset,
            nextOffset: end,
            size: guestBytes.length,
            eof: end === guestBytes.length,
            dataBase64: guestBytes.subarray(offset, end).toString("base64")
          }
        };
      },
      () => undefined,
      () => undefined,
      5_000
    );

    await expect(
      coordinator.execute("session", "file_pull", {
        guest_path: "C:\\MCPTEST\\DOWNLOAD.BIN",
        host_path: destination,
        overwrite: true
      })
    ).rejects.toThrow("TRANSIENT_GUEST_READ_FAILURE");
    expect(
      (await readdir(root)).some((name) => name.includes("win98mcp.partial"))
    ).toBe(true);
    await coordinator.abortSession("session");
    expect(
      (await readdir(root)).some((name) => name.includes("win98mcp.partial"))
    ).toBe(false);
  });
});
