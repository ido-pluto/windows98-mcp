import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IncomingStreamRegistry } from "../src/host/incoming-streams.js";

describe("incoming data stream retention", () => {
  it("removes a descriptor-created stream after timeout", async () => {
    const streams = new IncomingStreamRegistry(1024, 1_000, 4);

    await expect(
      streams.waitFor({ streamId: 1 }, 10)
    ).rejects.toThrow("DATA_STREAM_TIMEOUT");
    expect(streams.size).toBe(0);
  });

  it("claims and verifies data that arrived before its descriptor", async () => {
    const streams = new IncomingStreamRegistry(1024, 1_000, 4);
    const data = Buffer.from("Windows 98");
    streams.accept(7, true, data);

    await expect(
      streams.waitFor(
        {
          streamId: 7,
          totalBytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex")
        },
        100
      )
    ).resolves.toEqual(data);
    expect(streams.size).toBe(0);
  });

  it("evicts unclaimed streams and bounds their count", async () => {
    const streams = new IncomingStreamRegistry(1024, 20, 2);
    streams.accept(1, true, Buffer.from("one"));
    streams.accept(2, true, Buffer.from("two"));
    expect(() =>
      streams.accept(3, true, Buffer.from("three"))
    ).toThrow("DATA_STREAM_LIMIT_EXCEEDED");

    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(streams.size).toBe(0);
  });

  it("treats retention as an inactivity timeout while frames arrive", async () => {
    const streams = new IncomingStreamRegistry(1024, 200, 2);
    streams.accept(4, false, Buffer.from("first"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    streams.accept(4, true, Buffer.from("second"));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    await expect(
      streams.waitFor({ streamId: 4, totalBytes: 11 }, 100)
    ).resolves.toEqual(Buffer.from("firstsecond"));
  });

  it("clears waiting streams when the connection closes", async () => {
    const streams = new IncomingStreamRegistry(1024, 1_000, 4);
    const waiting = streams.waitFor({ streamId: 9 }, 1_000);
    streams.close(new Error("GUEST_DISCONNECTED"));

    await expect(waiting).rejects.toThrow("GUEST_DISCONNECTED");
    expect(streams.size).toBe(0);
  });
});
