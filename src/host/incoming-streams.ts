import { createHash } from "node:crypto";

export interface IncomingStreamDescriptor {
  streamId: number;
  totalBytes?: number;
  sha256?: string;
}

interface IncomingStream {
  chunks: Buffer[];
  bytes: number;
  complete: boolean;
  error?: Error;
  waiters: Array<() => void>;
  retentionTimer?: NodeJS.Timeout;
}

const DEFAULT_UNCLAIMED_RETENTION_MS = 60_000;
const DEFAULT_MAX_UNCLAIMED_STREAMS = 16;

/**
 * Buffers guest data frames that can legally arrive before their response
 * descriptor. Unclaimed streams are short-lived and bounded so a faulty guest
 * cannot retain arbitrary memory for the lifetime of the connection.
 */
export class IncomingStreamRegistry {
  private readonly streams = new Map<number, IncomingStream>();

  constructor(
    private readonly maxStreamBytes: number,
    private readonly unclaimedRetentionMs = DEFAULT_UNCLAIMED_RETENTION_MS,
    private readonly maxUnclaimedStreams = DEFAULT_MAX_UNCLAIMED_STREAMS
  ) {}

  get size(): number {
    return this.streams.size;
  }

  accept(streamId: number, final: boolean, payload: Buffer): void {
    if (!Number.isInteger(streamId) || streamId <= 0) {
      throw new Error("DATA_STREAM_ID_INVALID");
    }
    let stream = this.streams.get(streamId);
    if (!stream) {
      if (this.streams.size >= this.maxUnclaimedStreams) {
        throw new Error("DATA_STREAM_LIMIT_EXCEEDED");
      }
      stream = this.createUnclaimedStream(streamId);
    }
    if (stream.complete) {
      throw new Error("DATA_AFTER_STREAM_END");
    }
    stream.bytes += payload.length;
    if (stream.bytes > this.maxStreamBytes) {
      stream.error = new Error("DATA_STREAM_TOO_LARGE");
      stream.complete = true;
    } else {
      stream.chunks.push(Buffer.from(payload));
      stream.complete = final;
    }
    if (stream.retentionTimer) {
      this.scheduleRetention(streamId, stream);
    }
    if (stream.complete || stream.error) {
      this.wake(stream);
    }
  }

  async waitFor(
    descriptor: IncomingStreamDescriptor,
    timeoutMs: number
  ): Promise<Buffer> {
    if (!Number.isInteger(descriptor.streamId) || descriptor.streamId <= 0) {
      throw new Error("DATA_STREAM_ID_INVALID");
    }
    let stream = this.streams.get(descriptor.streamId);
    if (!stream) {
      stream = {
        chunks: [],
        bytes: 0,
        complete: false,
        waiters: []
      };
      this.streams.set(descriptor.streamId, stream);
    }
    if (stream.retentionTimer) {
      clearTimeout(stream.retentionTimer);
      delete stream.retentionTimer;
    }

    let wake: (() => void) | undefined;
    try {
      if (!stream.complete && !stream.error) {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              reject(new Error("DATA_STREAM_TIMEOUT"));
            }
          }, timeoutMs);
          timer.unref();
          wake = () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          };
          stream?.waiters.push(wake);
        });
      }
      if (stream.error) {
        throw stream.error;
      }
      const data = Buffer.concat(stream.chunks, stream.bytes);
      if (
        descriptor.totalBytes !== undefined &&
        data.length !== descriptor.totalBytes
      ) {
        throw new Error("DATA_STREAM_LENGTH_MISMATCH");
      }
      if (
        descriptor.sha256 !== undefined &&
        createHash("sha256").update(data).digest("hex") !== descriptor.sha256
      ) {
        throw new Error("DATA_STREAM_HASH_MISMATCH");
      }
      return data;
    } finally {
      if (wake) {
        const index = stream.waiters.indexOf(wake);
        if (index >= 0) {
          stream.waiters.splice(index, 1);
        }
      }
      if (stream.retentionTimer) {
        clearTimeout(stream.retentionTimer);
      }
      if (this.streams.get(descriptor.streamId) === stream) {
        this.streams.delete(descriptor.streamId);
      }
      stream.chunks.length = 0;
    }
  }

  close(error: Error): void {
    for (const stream of this.streams.values()) {
      if (stream.retentionTimer) {
        clearTimeout(stream.retentionTimer);
      }
      stream.error = error;
      this.wake(stream);
      if (stream.waiters.length === 0) {
        stream.chunks.length = 0;
      }
    }
    this.streams.clear();
  }

  private createUnclaimedStream(streamId: number): IncomingStream {
    const stream: IncomingStream = {
      chunks: [],
      bytes: 0,
      complete: false,
      waiters: []
    };
    this.streams.set(streamId, stream);
    this.scheduleRetention(streamId, stream);
    return stream;
  }

  private scheduleRetention(streamId: number, stream: IncomingStream): void {
    if (stream.retentionTimer) {
      clearTimeout(stream.retentionTimer);
    }
    const timer = setTimeout(() => {
      if (
        this.streams.get(streamId) === stream &&
        stream.waiters.length === 0
      ) {
        this.streams.delete(streamId);
        stream.chunks.length = 0;
      }
    }, this.unclaimedRetentionMs);
    timer.unref();
    stream.retentionTimer = timer;
  }

  private wake(stream: IncomingStream): void {
    for (const wake of stream.waiters.splice(0)) {
      wake();
    }
  }
}
