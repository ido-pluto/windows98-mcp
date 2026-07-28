import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type {
  BrokerHello,
  BrokerRequest,
  BrokerResponse
} from "../shared/types.js";

interface PendingCall {
  resolve: (response: BrokerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BrokerClientOptions {
  pipePath: string;
  localToken: string;
  sessionId?: string;
  sessionLabel?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class BrokerClient {
  readonly sessionId: string;
  readonly sessionLabel: string;

  private socket: Socket | undefined;
  private buffer = "";
  private ready = false;
  private readonly pending = new Map<string, PendingCall>();

  constructor(readonly options: BrokerClientOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.sessionLabel =
      options.sessionLabel ?? `MCP adapter ${process.pid}`;
  }

  get connected(): boolean {
    return this.ready && Boolean(this.socket && !this.socket.destroyed);
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    const socket = createConnection(this.options.pipePath);
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.acceptData(chunk));
    socket.on("error", () => {
      // The connect promise and close handler report the actionable error.
    });
    socket.on("close", () => this.closed());

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error("BROKER_CONNECT_TIMEOUT"));
        }
      }, this.options.connectTimeoutMs ?? 5_000);
      timer.unref();
      const onError = (error: Error): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.off("error", onError);
          resolve();
        }
      });
    });
    const hello: BrokerHello = {
      kind: "broker_hello",
      sessionId: this.sessionId,
      sessionLabel: this.sessionLabel,
      localAuth: this.options.localToken
    };
    socket.write(`${JSON.stringify(hello)}\n`);
    await this.waitUntilReady(this.options.connectTimeoutMs ?? 5_000);
  }

  async call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<BrokerResponse> {
    if (!this.connected || !this.socket) {
      throw new Error("BROKER_NOT_CONNECTED");
    }
    const id = randomUUID();
    const request: BrokerRequest = {
      kind: "broker_request",
      id,
      sessionId: this.sessionId,
      sessionLabel: this.sessionLabel,
      method,
      params
    };
    return new Promise<BrokerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BROKER_REQUEST_TIMEOUT:${method}`));
      }, timeoutMs ?? this.options.requestTimeoutMs ?? 11 * 60 * 1000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket?.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = undefined;
    this.ready = false;
  }

  private acceptData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > 64 * 1024 * 1024) {
      this.socket?.destroy(new Error("BROKER_RESPONSE_TOO_LARGE"));
      return;
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        this.socket?.destroy(new Error("BROKER_RESPONSE_INVALID_JSON"));
        return;
      }
      if (isReady(value) && value.sessionId === this.sessionId) {
        this.ready = true;
        continue;
      }
      if (!isBrokerResponse(value)) {
        this.socket?.destroy(new Error("BROKER_RESPONSE_INVALID"));
        return;
      }
      const pending = this.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(value.id);
        pending.resolve(value);
      }
    }
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (!this.ready) {
      if (!this.socket || this.socket.destroyed) {
        throw new Error("BROKER_CONNECTION_CLOSED");
      }
      if (Date.now() - startedAt >= timeoutMs) {
        this.socket.destroy();
        throw new Error("BROKER_HELLO_TIMEOUT");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        timer.unref();
      });
    }
  }

  private closed(): void {
    this.ready = false;
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("BROKER_CONNECTION_CLOSED"));
    }
    this.pending.clear();
  }
}

export async function connectBroker(
  options: BrokerClientOptions
): Promise<BrokerClient> {
  const client = new BrokerClient(options);
  await client.connect();
  return client;
}

export async function brokerIsReachable(
  pipePath: string,
  timeoutMs = 500
): Promise<boolean> {
  const socket = createConnection(pipePath);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function isReady(
  value: unknown
): value is { kind: "broker_ready"; sessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "broker_ready" &&
    "sessionId" in value &&
    typeof value.sessionId === "string"
  );
}

function isBrokerResponse(value: unknown): value is BrokerResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "broker_response" &&
    "id" in value &&
    typeof value.id === "string" &&
    "result" in value &&
    typeof value.result === "object" &&
    value.result !== null
  );
}
