import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FrameDecoder,
  decodeHeader,
  encodeFrame,
  encodeJson,
  verifyFrameMac
} from "../src/shared/protocol.js";
import {
  FRAME_HEADER_BYTES,
  FrameType,
  MAX_CONTROL_PAYLOAD
} from "../src/shared/types.js";

describe("wire protocol", () => {
  it("decodes a frame arriving one byte at a time", () => {
    const key = randomBytes(32);
    const encoded = encodeFrame(
      {
        type: FrameType.Request,
        flags: 0,
        streamId: 7,
        sequence: 42n
      },
      encodeJson({ hello: "windows 98" }),
      key,
      "host-to-guest"
    );
    const decoder = new FrameDecoder();
    const decoded = [];
    for (const byte of encoded) {
      decoded.push(...decoder.push(Buffer.from([byte])));
    }
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.header.streamId).toBe(7);
    expect(decoded[0]?.header.sequence).toBe(42n);
    expect(decoded[0]?.payload.toString("utf8")).toContain("windows 98");
    expect(
      decoded[0] &&
        verifyFrameMac(decoded[0], key, "host-to-guest")
    ).toBe(true);
    expect(decoder.pendingBytes).toBe(0);
  });

  it("decodes coalesced frames and rejects direction changes", () => {
    const key = randomBytes(32);
    const first = encodeFrame(
      { type: FrameType.Ping, flags: 0, streamId: 0, sequence: 1n },
      Buffer.alloc(0),
      key,
      "guest-to-host"
    );
    const second = encodeFrame(
      { type: FrameType.Pong, flags: 0, streamId: 0, sequence: 2n },
      Buffer.alloc(0),
      key,
      "guest-to-host"
    );
    const frames = new FrameDecoder().push(Buffer.concat([first, second]));
    expect(frames).toHaveLength(2);
    expect(
      frames.every((frame) =>
        verifyFrameMac(frame, key, "guest-to-host")
      )
    ).toBe(true);
    expect(
      frames.some((frame) =>
        verifyFrameMac(frame, key, "host-to-guest")
      )
    ).toBe(false);
  });

  it("rejects invalid magic, unsupported versions, and oversized controls", () => {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.write("NOPE", 0, "ascii");
    expect(() => decodeHeader(header)).toThrow("FRAME_MAGIC_INVALID");

    const oversized = Buffer.alloc(FRAME_HEADER_BYTES);
    oversized.write("W98M", 0, "ascii");
    oversized.writeUInt16LE(1, 4);
    oversized.writeUInt16LE(FrameType.Request, 6);
    oversized.writeUInt32LE(MAX_CONTROL_PAYLOAD + 1, 24);
    expect(() => decodeHeader(oversized)).toThrow("FRAME_LENGTH_EXCEEDED");
  });
});
