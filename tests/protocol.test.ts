import { describe, expect, it } from "vitest";
import {
  FrameDecoder,
  decodeHeader,
  encodeFrame,
  encodeJson
} from "../src/shared/protocol.js";
import {
  FRAME_HEADER_BYTES,
  FrameType,
  MAX_CONTROL_PAYLOAD,
  PROTOCOL_VERSION
} from "../src/shared/types.js";

describe("protocol v2 wire framing", () => {
  it("decodes an unauthenticated frame arriving one byte at a time", () => {
    const encoded = encodeFrame(
      { type: FrameType.Request, flags: 0, streamId: 7, sequence: 42n },
      encodeJson({ hello: "windows 98" })
    );
    const decoder = new FrameDecoder();
    const decoded = [];
    for (const byte of encoded) decoded.push(...decoder.push(Buffer.from([byte])));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.header.streamId).toBe(7);
    expect(decoded[0]?.header.sequence).toBe(42n);
    expect(decoded[0]?.mac).toHaveLength(0);
    expect(decoded[0]?.payload.toString("utf8")).toContain("windows 98");
    expect(decoder.pendingBytes).toBe(0);
  });

  it("decodes coalesced HELLO and READY frames without a MAC trailer", () => {
    const first = encodeFrame(
      { type: FrameType.Hello, flags: 0, streamId: 0, sequence: 0n },
      encodeJson({ kind: "guest_hello" })
    );
    const second = encodeFrame(
      { type: FrameType.Ready, flags: 0, streamId: 0, sequence: 0n },
      encodeJson({ kind: "ready", epoch: 1 })
    );
    const frames = new FrameDecoder().push(Buffer.concat([first, second]));
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.header.type)).toEqual([FrameType.Hello, FrameType.Ready]);
  });

  it("rejects invalid magic, unsupported versions, and oversized controls", () => {
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.write("NOPE", 0, "ascii");
    expect(() => decodeHeader(header)).toThrow("FRAME_MAGIC_INVALID");

    header.write("W98M", 0, "ascii");
    header.writeUInt16LE(PROTOCOL_VERSION + 1, 4);
    expect(() => decodeHeader(header)).toThrow("PROTOCOL_VERSION_UNSUPPORTED");

    header.writeUInt16LE(PROTOCOL_VERSION, 4);
    header.writeUInt16LE(FrameType.Request, 6);
    header.writeUInt32LE(MAX_CONTROL_PAYLOAD + 1, 24);
    expect(() => decodeHeader(header)).toThrow("FRAME_LENGTH_EXCEEDED");
  });
});
