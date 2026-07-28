import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { connect, type Socket } from "node:net";
import { defaultPipePath } from "../host/config.js";
import type {
  BrokerHello,
  BrokerRequest,
  BrokerResponse
} from "../shared/types.js";

export const DEFAULT_BROKER_PIPE = defaultPipePath();

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface BrokerClientOptions {
  pipePath?: string;
  localToken?: string;
  sessionId?: string;
  sessionLabel?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
}

export interface BrokerRequestOptions {
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (response: BrokerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class BrokerClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true) {
    super(message);
    this.name = "BrokerClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * A reconnecting client for the broker's newline-delimited JSON named-pipe
 * protocol. A BrokerClient represents exactly one MCP adapter session; its
 * session identity is retained across broker reconnects.
 */
export class BrokerClient {
  readonly pipePath: string;
  readonly sessionId: string;
  readonly sessionLabel: string;
  readonly localToken: string;

  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private socket: Socket | undefined;
  private connectPromise: Promise<Socket> | undefined;
  private receiveBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(options: BrokerClientOptions = {}) {
    this.pipePath =
      options.pipePath ??
      process.env["WIN98_MCP_PIPE"] ??
      DEFAULT_BROKER_PIPE;
    this.sessionId =
      options.sessionId ??
      process.env["WIN98_MCP_SESSION_ID"] ??
      randomUUID();
    this.sessionLabel =
      (
        options.sessionLabel ??
        process.env["WIN98_MCP_SESSION_LABEL"] ??
        defaultSessionLabel()
      ).slice(0, 128);
    this.localToken =
      options.localToken ??
      process.env["WIN98_MCP_LOCAL_TOKEN"] ??
      "";
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
    options: BrokerRequestOptions = {}
  ): Promise<BrokerResponse> {
    if (this.closed) {
      throw new BrokerClientError(
        "BROKER_CLIENT_CLOSED",
        "The MCP broker client is closed.",
        false
      );
    }

    const socket = await this.ensureConnected();
    const id = randomUUID();
    const request: BrokerRequest = {
      kind: "broker_request",
      id,
      sessionId: this.sessionId,
      sessionLabel: this.sessionLabel,
      method,
      params
    };
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return await new Promise<BrokerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BrokerClientError(
            "BROKER_REQUEST_TIMEOUT",
            `Broker request ${method} timed out after ${timeoutMs} ms.`
          )
        );
      }, timeoutMs);
      timer.unref();

      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(
          new BrokerClientError(
            "BROKER_WRITE_FAILED",
            `Could not send ${method} to the broker: ${error.message}`
          )
        );
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connectPromise = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(
      new BrokerClientError(
        "BROKER_CLIENT_CLOSED",
        "The MCP adapter disconnected from the broker.",
        false
      )
    );
    if (!socket || socket.destroyed) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.end();
      const timer = setTimeout(() => socket.destroy(), 1_000);
      timer.unref();
    });
  }

  private async ensureConnected(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed && this.socket.writable) {
      return this.socket;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }

    this.connectPromise = this.openSocket();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async openSocket(): Promise<Socket> {
    return await new Promise<Socket>((resolve, reject) => {
      const socket = connect(this.pipePath);
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        reject(
          new BrokerClientError(
            "BROKER_CONNECT_TIMEOUT",
            `Timed out connecting to broker pipe ${this.pipePath}.`
          )
        );
      }, this.connectTimeoutMs);
      timeout.unref();

      const failConnect = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(
          new BrokerClientError(
            "BROKER_UNAVAILABLE",
            `Could not connect to broker pipe ${this.pipePath}: ${error.message}`
          )
        );
      };

      socket.setEncoding("utf8");
      socket.once("error", failConnect);
      socket.once("connect", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("error", failConnect);
        this.attachSocket(socket);

        const hello: BrokerHello = {
          kind: "broker_hello",
          sessionId: this.sessionId,
          sessionLabel: this.sessionLabel,
          localAuth: this.localToken
        };
        socket.write(`${JSON.stringify(hello)}\n`, "utf8", (error) => {
          if (error) {
            socket.destroy(error);
            reject(
              new BrokerClientError(
                "BROKER_HELLO_FAILED",
                `Could not initialize broker session: ${error.message}`
              )
            );
            return;
          }
          resolve(socket);
        });
      });
    });
  }

  private attachSocket(socket: Socket): void {
    this.receiveBuffer = "";
    this.socket = socket;
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("error", (error) => {
      this.handleDisconnect(
        socket,
        new BrokerClientError(
          "BROKER_CONNECTION_ERROR",
          `Broker connection failed: ${error.message}`
        )
      );
    });
    socket.on("close", () => {
      this.handleDisconnect(
        socket,
        new BrokerClientError(
          "BROKER_DISCONNECTED",
          "The broker disconnected before completing the request."
        )
      );
    });
  }

  private handleData(chunk: string): void {
    this.receiveBuffer += chunk;
    if (Buffer.byteLength(this.receiveBuffer, "utf8") > this.maxLineBytes) {
      const error = new BrokerClientError(
        "BROKER_RESPONSE_TOO_LARGE",
        `Broker response exceeded ${this.maxLineBytes} bytes.`,
        false
      );
      this.socket?.destroy(error);
      return;
    }

    for (;;) {
      const newline = this.receiveBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.receiveBuffer.slice(0, newline).trimEnd();
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      this.socket?.destroy(
        new BrokerClientError(
          "BROKER_RESPONSE_INVALID",
          `Broker sent invalid JSON: ${errorMessage(error)}`,
          false
        )
      );
      return;
    }

    if (isBrokerReady(value, this.sessionId)) {
      return;
    }
    if (!isBrokerResponse(value)) {
      this.socket?.destroy(
        new BrokerClientError(
          "BROKER_RESPONSE_INVALID",
          "Broker sent a message that is not a broker_response.",
          false
        )
      );
      return;
    }

    const pending = this.pending.get(value.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    pending.resolve(value);
  }

  private handleDisconnect(socket: Socket, error: Error): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.receiveBuffer = "";
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isBrokerReady(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate["kind"] === "broker_ready" &&
    candidate["sessionId"] === sessionId
  );
}

function isBrokerResponse(value: unknown): value is BrokerResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BrokerResponse>;
  return (
    candidate.kind === "broker_response" &&
    typeof candidate.id === "string" &&
    !!candidate.result &&
    typeof candidate.result === "object" &&
    typeof candidate.result.ok === "boolean" &&
    typeof candidate.result.code === "string" &&
    typeof candidate.result.message === "string"
  );
}

function defaultSessionLabel(): string {
  const workspace = basename(process.cwd()) || "workspace";
  return `codex:${workspace}:${process.pid}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
