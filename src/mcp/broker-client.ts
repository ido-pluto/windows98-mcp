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
const RECONNECT_INITIAL_MS = 250;
const RECONNECT_MAX_MS = 5_000;

export interface BrokerClientOptions {
  pipePath?: string;
  host?: string;
  port?: number;
  sessionId?: string;
  sessionLabel?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  /** Receives broker-originated transfer progress for persistent CLI clients. */
  onProgress?: (progress: unknown) => void;
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
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly sessionId: string;
  readonly sessionLabel: string;

  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private socket: Socket | undefined;
  /** A connecting socket is not yet the active session socket, but must still
   * be destroyed when the client is closed. */
  private openingSocket: Socket | undefined;
  private connectPromise: Promise<Socket> | undefined;
  private receiveBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  private reconnecting = false;
  private requestChain: Promise<void> = Promise.resolve();
  private readyCallback: ((socket: Socket) => void) | undefined;
  private readonly onProgress: ((progress: unknown) => void) | undefined;
  /** Avoid creating a new broker connection merely to clean up a session that
   * never submitted any work (for example an empty or malformed rpc stream). */
  private hasSentRequest = false;

  constructor(options: BrokerClientOptions = {}) {
    this.pipePath =
      options.pipePath ??
      process.env["WIN98_MCP_PIPE"] ??
      DEFAULT_BROKER_PIPE;
    this.host = options.host ?? process.env["WIN98_MCP_BROKER_HOST"];
    const configuredPort = options.port ?? numberEnvironment("WIN98_MCP_BROKER_PORT");
    this.port = this.host ? configuredPort ?? 9899 : undefined;
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
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.onProgress = options.onProgress;
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

    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const operation = this.requestChain.then(() =>
      this.requestWithRecovery(method, params, timeoutMs)
    );
    this.requestChain = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async close(options: { cleanup?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    if (options.cleanup && this.hasSentRequest) {
      // Bypass the caller's ordered request chain. A stdio EOF can happen
      // while a long request is still awaiting a result; cleanup must be sent
      // to the broker immediately (the broker preserves guest-side order).
      await this.requestWithRecovery("vm_unlock", { force: true }, 5_000)
        .catch(() => undefined);
    }
    this.closed = true;
    this.connectPromise = undefined;
    const openingSocket = this.openingSocket;
    this.openingSocket = undefined;
    openingSocket?.destroy();
    const socket = this.socket;
    this.socket = undefined;
    this.readyCallback = undefined;
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
      const socket = this.host
        ? connect({ host: this.host, port: this.port! })
        : connect(this.pipePath);
      this.openingSocket = socket;
      let settled = false;
      const clearOpeningSocket = (): void => {
        if (this.openingSocket === socket) {
          this.openingSocket = undefined;
        }
      };
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearOpeningSocket();
        socket.destroy();
        reject(
          new BrokerClientError(
            "BROKER_CONNECT_TIMEOUT",
            `Timed out connecting to broker ${this.endpoint}.`
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
        clearOpeningSocket();
        socket.destroy();
        reject(
          new BrokerClientError(
            "BROKER_UNAVAILABLE",
            `Could not connect to broker ${this.endpoint}: ${error.message}`
          )
        );
      };

      const closeBeforeReady = (): void => {
        failConnect(new BrokerClientError(
          "BROKER_DISCONNECTED",
          "The broker closed the connection before confirming the session."
        ));
      };

      socket.setEncoding("utf8");
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);
      socket.once("error", failConnect);
      socket.once("close", closeBeforeReady);
      socket.once("connect", () => {
        if (settled || this.closed) {
          clearOpeningSocket();
          socket.destroy();
          return;
        }
        this.attachSocket(socket);
        clearOpeningSocket();
        this.readyCallback = (readySocket) => {
          if (readySocket !== socket || settled || this.closed) return;
          settled = true;
          clearTimeout(timeout);
          socket.off("error", failConnect);
          socket.off("close", closeBeforeReady);
          this.readyCallback = undefined;
          resolve(socket);
        };

        const hello: BrokerHello = {
          kind: "broker_hello",
          sessionId: this.sessionId,
          sessionLabel: this.sessionLabel,
        };
        socket.write(`${JSON.stringify(hello)}\n`, "utf8", (error) => {
          if (error) {
            socket.destroy(error);
            failConnect(
              new BrokerClientError(
                "BROKER_HELLO_FAILED",
                `Could not initialize broker session: ${error.message}`
              )
            );
            return;
          }
        });
      });
    });
  }

  private attachSocket(socket: Socket): void {
    this.receiveBuffer = "";
    this.socket = socket;
    socket.on("data", (chunk: string) => this.handleData(socket, chunk));
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

  private handleData(socket: Socket, chunk: string): void {
    // A close/reconnect race can leave a buffered data event on the old
    // socket. Never let an old frame satisfy a request on the replacement.
    if (this.socket !== socket) {
      return;
    }
    this.receiveBuffer += chunk;
    if (Buffer.byteLength(this.receiveBuffer, "utf8") > this.maxLineBytes) {
      const error = new BrokerClientError(
        "BROKER_RESPONSE_TOO_LARGE",
        `Broker response exceeded ${this.maxLineBytes} bytes.`,
        false
      );
      socket.destroy(error);
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
      this.handleLine(socket, line);
    }
  }

  private handleLine(socket: Socket, line: string): void {
    if (this.socket !== socket) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      socket.destroy(
        new BrokerClientError(
          "BROKER_RESPONSE_INVALID",
          `Broker sent invalid JSON: ${errorMessage(error)}`,
          false
        )
      );
      return;
    }

    if (isBrokerSessionClosed(value, this.sessionId)) {
      this.closeFromBroker(
        new BrokerClientError(
          "BROKER_SESSION_DISCONNECTED",
          "This MCP/CLI session was disconnected by a broker administrator.",
          false
        )
      );
      return;
    }

    if (isBrokerReady(value, this.sessionId)) {
      this.readyCallback?.(socket);
      return;
    }
    if (isBrokerProgress(value, this.sessionId)) {
      this.onProgress?.((value as Record<string, unknown>)["progress"]);
      return;
    }
    if (!isBrokerResponse(value)) {
      socket.destroy(
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
    if (!this.closed) {
      void this.reconnectForever();
    }
  }

  private closeFromBroker(error: BrokerClientError): void {
    if (this.closed) return;
    this.closed = true;
    this.connectPromise = undefined;
    this.readyCallback = undefined;
    const openingSocket = this.openingSocket;
    this.openingSocket = undefined;
    openingSocket?.destroy();
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(error);
    socket?.destroy();
  }

  private async requestWithRecovery(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<BrokerResponse> {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let lastError: Error | undefined;
    while (!this.closed && Date.now() < deadline) {
      attempts += 1;
      try {
        const socket = await this.ensureConnected();
        const response = await this.sendOnce(socket, method, params, Math.max(1, deadline - Date.now()));
        if (attempts > 1) {
          response.result.recovery = { replayed: true, attempts };
        }
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (this.closed || !isRecoverableBrokerError(lastError)) {
          throw lastError;
        }
        await sleep(Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * Math.min(attempts, 20)));
      }
    }
    throw new BrokerClientError(
      "BROKER_RECONNECTING",
      `Broker recovery did not complete while replaying ${method}: ${lastError?.message ?? "connection unavailable"}`
    );
  }

  private async sendOnce(
    socket: Socket,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<BrokerResponse> {
    const id = randomUUID();
    const request: BrokerRequest = { kind: "broker_request", id, sessionId: this.sessionId, sessionLabel: this.sessionLabel, method, params };
    return await new Promise<BrokerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timeout has an unknown outcome. Only a confirmed transport loss
        // is replayed; replaying a live request can duplicate side effects.
        reject(new BrokerClientError("BROKER_REQUEST_TIMEOUT", `Broker request ${method} timed out after ${timeoutMs} ms.`, false));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.hasSentRequest = true;
      socket.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(id);
        pending.reject(new BrokerClientError("BROKER_WRITE_FAILED", `Could not send ${method} to the broker: ${error.message}`));
      });
    });
  }

  private async reconnectForever(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    let delay = RECONNECT_INITIAL_MS;
    try {
      while (!this.closed && !this.socket) {
        try {
          await this.ensureConnected();
          return;
        } catch {
          await sleep(delay);
          delay = Math.min(RECONNECT_MAX_MS, delay * 2);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private get endpoint(): string {
    return this.host ? `${this.host}:${this.port}` : this.pipePath;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function isRecoverableBrokerError(error: Error): boolean {
  return !(error instanceof BrokerClientError) || error.retryable;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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

function isBrokerSessionClosed(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate["kind"] === "broker_session_closed" && candidate["sessionId"] === sessionId;
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

function isBrokerProgress(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate["kind"] === "broker_progress" && candidate["sessionId"] === sessionId;
}

function numberEnvironment(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : undefined;
}

function defaultSessionLabel(): string {
  const workspace = basename(process.cwd()) || "workspace";
  return `codex:${workspace}:${process.pid}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
