import { createHmac, timingSafeEqual } from "node:crypto";
import {
  FRAME_HEADER_BYTES,
  FRAME_MAC_BYTES,
  FrameType,
  MAX_CONTROL_PAYLOAD,
  MAX_DATA_PAYLOAD,
  PROTOCOL_MAGIC,
  PROTOCOL_VERSION,
  type DecodedFrame,
  type FrameHeader
} from "./types.js";

const MAGIC = Buffer.from(PROTOCOL_MAGIC, "ascii");

export function encodeHeader(header: FrameHeader): Buffer {
  validatePayloadLength(header.type, header.payloadLength);
  const buffer = Buffer.alloc(FRAME_HEADER_BYTES);
  MAGIC.copy(buffer, 0);
  buffer.writeUInt16LE(header.version, 4);
  buffer.writeUInt16LE(header.type, 6);
  buffer.writeUInt32LE(header.flags >>> 0, 8);
  buffer.writeUInt32LE(header.streamId >>> 0, 12);
  buffer.writeBigUInt64LE(header.sequence, 16);
  buffer.writeUInt32LE(header.payloadLength >>> 0, 24);
  return buffer;
}

export function decodeHeader(buffer: Buffer): FrameHeader {
  if (buffer.length < FRAME_HEADER_BYTES) {
    throw new Error("FRAME_HEADER_TRUNCATED");
  }
  if (!timingSafeEqual(buffer.subarray(0, 4), MAGIC)) {
    throw new Error("FRAME_MAGIC_INVALID");
  }
  const version = buffer.readUInt16LE(4);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`PROTOCOL_VERSION_UNSUPPORTED:${version}`);
  }
  const type = buffer.readUInt16LE(6) as FrameType;
  const header: FrameHeader = {
    version,
    type,
    flags: buffer.readUInt32LE(8),
    streamId: buffer.readUInt32LE(12),
    sequence: buffer.readBigUInt64LE(16),
    payloadLength: buffer.readUInt32LE(24)
  };
  validatePayloadLength(type, header.payloadLength);
  return header;
}

export function frameMac(
  key: Buffer,
  direction: "host-to-guest" | "guest-to-host",
  header: Buffer,
  payload: Buffer
): Buffer {
  return createHmac("sha256", key)
    .update(direction, "ascii")
    .update(header)
    .update(payload)
    .digest();
}

export function encodeFrame(
  header: Omit<FrameHeader, "version" | "payloadLength">,
  payload: Buffer,
  key?: Buffer,
  direction: "host-to-guest" | "guest-to-host" = "host-to-guest"
): Buffer {
  const fullHeader: FrameHeader = {
    ...header,
    version: PROTOCOL_VERSION,
    payloadLength: payload.length
  };
  const encodedHeader = encodeHeader(fullHeader);
  const mac = key
    ? frameMac(key, direction, encodedHeader, payload)
    : Buffer.alloc(FRAME_MAC_BYTES);
  return Buffer.concat([encodedHeader, payload, mac]);
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: DecodedFrame[] = [];

    while (this.pending.length >= FRAME_HEADER_BYTES) {
      const headerBytes = this.pending.subarray(0, FRAME_HEADER_BYTES);
      const header = decodeHeader(headerBytes);
      const frameLength =
        FRAME_HEADER_BYTES + header.payloadLength + FRAME_MAC_BYTES;
      if (this.pending.length < frameLength) {
        break;
      }
      frames.push({
        header,
        payload: Buffer.from(
          this.pending.subarray(
            FRAME_HEADER_BYTES,
            FRAME_HEADER_BYTES + header.payloadLength
          )
        ),
        mac: Buffer.from(
          this.pending.subarray(
            FRAME_HEADER_BYTES + header.payloadLength,
            frameLength
          )
        )
      });
      this.pending = this.pending.subarray(frameLength);
    }
    return frames;
  }

  get pendingBytes(): number {
    return this.pending.length;
  }
}

export function verifyFrameMac(
  frame: DecodedFrame,
  key: Buffer,
  direction: "host-to-guest" | "guest-to-host"
): boolean {
  const header = encodeHeader(frame.header);
  const expected = frameMac(key, direction, header, frame.payload);
  return timingSafeEqual(expected, frame.mac);
}

export function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function decodeJson<T>(payload: Buffer): T {
  return JSON.parse(payload.toString("utf8")) as T;
}

function validatePayloadLength(type: FrameType, payloadLength: number): void {
  if (!Number.isInteger(payloadLength) || payloadLength < 0) {
    throw new Error("FRAME_LENGTH_INVALID");
  }
  const max = type === FrameType.Data ? MAX_DATA_PAYLOAD : MAX_CONTROL_PAYLOAD;
  if (payloadLength > max) {
    throw new Error(`FRAME_LENGTH_EXCEEDED:${payloadLength}:${max}`);
  }
}
