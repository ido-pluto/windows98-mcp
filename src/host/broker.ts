import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import {
  createServer,
  createConnection,
  type Server,
  type Socket
} from "node:net";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import {
  decodeJson,
  encodeFrame,
  encodeJson,
  FrameDecoder,
} from "../shared/protocol.js";
import {
  FrameType,
  PROTOCOL_VERSION,
  UNLOCK_REMINDER,
  type BrokerHello,
  type BrokerRequest,
  type BrokerResponse,
  type ConnectionSnapshot,
  type GuestCapabilities,
  type GuestRequest,
  type GuestResponse,
  type ToolResult
} from "../shared/types.js";
import { ArtifactStore, type StoredArtifact } from "./artifacts.js";
import {
  loadBrokerConfig,
  publicConfig,
  type BrokerConfig,
  type LoadBrokerConfigOptions
} from "./config.js";
import { LeaseManager, type LeaseOwner } from "./lease.js";
import { IncomingStreamRegistry } from "./incoming-streams.js";
import { JsonlLogger } from "./logger.js";
import {
  TRANSFER_METHODS,
  TransferCoordinator,
  type TransferProgress
} from "./transfers.js";

interface GuestHelloMessage {
  kind: "guest_hello";
  capabilities: GuestCapabilities;
}

interface ReadyMessage {
  kind: "ready";
  epoch: number;
}

interface BinaryDescriptor {
  streamId: number;
  mimeType?: string;
  totalBytes?: number;
  sha256?: string;
}

interface PendingGuestRequest {
  method: string;
  resolve: (response: GuestResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AdapterSession {
  id: string;
  label: string;
  connectedAt: string;
  socket: Socket;
  buffer: string;
  greeted: boolean;
  resources: Set<string>;
}

interface ProcessedGuestResponse {
  response: GuestResponse;
  image?: BrokerResponse["image"];
}

interface CleanupOutcome {
  sanitized: boolean;
  pendingReconnect: boolean;
}

const LOCAL_MESSAGE_LIMIT = 2 * 1024 * 1024;
const DATA_FLAG_FINAL = 1;
const SAFE_RETRY_METHODS = new Set([
  "screen_capture",
  "mouse_position",
  "clipboard_get",
  "window_list",
  "window_capture",
  "process_list",
  "process_wait",
  "fs_stat",
  "fs_list",
  "system_info"
]);
const NON_LOCKING_METHODS = new Set([
  "vm_status",
  "vm_capabilities",
  "vm_lock",
  "vm_wait",
  "vm_unlock",
  "host_network_info",
  "broker_set_upstream",
  "broker_sessions",
  "broker_disconnect_session",
  "broker_set_locking"
]);

export class Broker {
  readonly lease: LeaseManager;
  readonly artifacts: ArtifactStore;
  readonly logger: JsonlLogger;
  readonly transfers: TransferCoordinator;

  private localServer?: Server;
  private adapterServer?: Server;
  private guestServer?: Server;
  private guest: GuestConnection | undefined;
  private proxyBridge: UpstreamGuestBridge | undefined;
  private readonly adapters = new Map<string, AdapterSession>();
  private readonly openResources = new Map<string, Set<string>>();
  private started = false;
  private stopping = false;
  private connectionEpoch = 0;
  private connectionState: ConnectionSnapshot = {
    state: "offline",
    epoch: 0
  };
  private capabilities: GuestCapabilities | undefined;
  private cleanupChain: Promise<void> = Promise.resolve();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(readonly config: BrokerConfig) {
    this.lease = new LeaseManager(config.leaseTtlMs, config.waitTicketTtlMs);
    this.artifacts = new ArtifactStore(config.artifactDir, config.maxArtifactBytes);
    this.logger = new JsonlLogger(config.logPath);
    this.transfers = new TransferCoordinator(
      async (sessionId, method, params, timeoutMs) => {
        if (!this.guest?.ready || this.guest.closed) {
          throw new Error("GUEST_NOT_CONNECTED");
        }
        return this.guest.request(sessionId, method, params, timeoutMs);
      },
      (sessionId, resource) => this.addResource(sessionId, resource),
      (sessionId, resource) => this.removeResource(sessionId, resource),
      config.requestTimeoutMs,
      (sessionId, progress) => this.emitTransferProgress(sessionId, progress)
    );
    this.lease.on("expired", (owner: LeaseOwner) => {
      this.logger.write("warn", "lease_expired", {
        sessionId: owner.sessionId,
        ownerLabel: owner.label
      });
      void this.enqueueCleanup(owner.sessionId, "lease_expired", true, false);
    });
    this.lease.on("acquired", (owner: LeaseOwner) => {
      this.logger.write("info", "lease_acquired", {
        sessionId: owner.sessionId,
        ownerLabel: owner.label
      });
    });
    this.lease.on("released", (owner: LeaseOwner) => {
      this.logger.write("info", "lease_released", {
        sessionId: owner.sessionId,
        ownerLabel: owner.label
      });
    });
  }

  static async create(
    options: LoadBrokerConfigOptions = {}
  ): Promise<Broker> {
    return new Broker(await loadBrokerConfig(options));
  }

  get snapshot(): ConnectionSnapshot {
    return { ...this.connectionState };
  }

  get guestCapabilities(): GuestCapabilities | undefined {
    return this.capabilities ? { ...this.capabilities, commands: [...this.capabilities.commands] } : undefined;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await Promise.all([
      mkdir(dirname(this.config.logPath), { recursive: true }),
      mkdir(this.config.artifactDir, { recursive: true }),
      this.logger.initialize(),
      this.artifacts.initialize()
    ]);
    if (process.platform !== "win32") {
      await unlink(this.config.pipePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
    this.localServer = createServer((socket) => this.acceptAdapter(socket));
    this.adapterServer = createServer((socket) => this.acceptAdapter(socket));
    this.guestServer = createServer((socket) => this.acceptGuest(socket));
    try {
      await Promise.all([
        listen(this.localServer, this.config.pipePath),
        listen(this.adapterServer, this.config.adapterPort, "0.0.0.0"),
        listen(this.guestServer, this.config.guestPort, this.config.bindHost)
      ]);
    } catch (error) {
      await Promise.allSettled([
        closeServer(this.localServer),
        closeServer(this.adapterServer),
        closeServer(this.guestServer)
      ]);
      throw error;
    }
    this.started = true;
    this.stopping = false;
    this.heartbeatTimer = setInterval(
      () => this.checkGuestHeartbeat(),
      Math.max(1_000, Math.floor(this.config.heartbeatTimeoutMs / 3))
    );
    this.heartbeatTimer.unref();
    this.logger.write("info", "broker_started", {
      bindHost: this.config.bindHost,
      guestPort: this.config.guestPort,
      adapterPort: this.config.adapterPort,
      pipePath: this.config.pipePath
    });
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }
    this.stopping = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.lease.close();
    for (const adapter of this.adapters.values()) {
      adapter.socket.destroy();
    }
    this.adapters.clear();
    await this.transfers.abortAll();
    this.proxyBridge?.destroy();
    this.proxyBridge = undefined;
    this.guest?.destroy();
    this.guest = undefined;
    await Promise.allSettled([
      closeServer(this.localServer),
      closeServer(this.adapterServer),
      closeServer(this.guestServer)
    ]);
    if (process.platform !== "win32") {
      await unlink(this.config.pipePath).catch(() => undefined);
    }
    this.started = false;
    this.stopping = false;
    this.logger.write("info", "broker_stopped");
    await this.logger.flush();
  }

  async execute(
    sessionId: string,
    sessionLabel: string,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<BrokerResponse> {
    const requestId = randomUUID();
    const adapter = this.adapters.get(sessionId);
    if (adapter && adapter.label !== sessionLabel) {
      return {
        kind: "broker_response",
        id: requestId,
        result: this.result(
          sessionId,
          requestId,
          false,
          "SESSION_LABEL_MISMATCH",
          "The adapter session label does not match the connected session.",
          false
        )
      };
    }
    const local = await this.executeLocal(
      sessionId,
      sessionLabel,
      method,
      params,
      requestId
    );
    if (local) {
      return local;
    }

    if (!(await this.waitForGuest())) {
      return this.brokerResponse(
        requestId,
        this.result(
          sessionId,
          requestId,
          false,
          this.connectionState.state === "sanitizing" ? "VM_SANITIZING" : "GUEST_CONNECT_TIMEOUT",
          this.connectionState.state === "sanitizing"
            ? "The guest is connected but cleanup is still in progress."
            : "Windows 98 did not connect to the host listener within 5 seconds.",
          true,
          "Start WIN98CTL.EXE and verify the host IP and port in WIN98CTL.INI."
        )
      );
    }
    if (
      this.capabilities &&
      !capabilitySupports(this.capabilities.commands, method) &&
      !method.startsWith("file_") &&
      !method.startsWith("directory_")
    ) {
      return this.brokerResponse(
        requestId,
        this.result(
          sessionId,
          requestId,
          false,
          "METHOD_UNSUPPORTED",
          `The connected guest does not advertise support for ${method}.`,
          false
        )
      );
    }

    if (this.config.lockingEnabled) {
      const acquisition = this.lease.acquire(sessionId, sessionLabel, true);
      if (!acquisition.acquired) {
        return this.brokerResponse(
          requestId,
          this.result(
            sessionId,
            requestId,
            false,
            "VM_BUSY",
            "Another agent owns the Windows 98 VM.",
            true,
            "Call vm_wait with the returned ticket, or retry after the current lease expires.",
            {
              waitTicket: acquisition.ticket,
              queuePosition: acquisition.queuePosition,
              retryAfterMs: 1_000
            }
          )
        );
      }
      this.lease.touch(sessionId);
    }

    try {
      const timeout = requestTimeout(method, params, this.config.requestTimeoutMs);
      const renewalTimer = this.config.lockingEnabled
        ? setInterval(
            () => this.lease.touch(sessionId),
            Math.max(1_000, Math.min(60_000, Math.floor(this.config.leaseTtlMs / 3)))
          )
        : undefined;
      renewalTimer?.unref();
      try {
        if (TRANSFER_METHODS.has(method)) {
        let progress;
          progress = await this.transfers.execute(sessionId, method, params);
        if (this.config.lockingEnabled) this.lease.touch(sessionId);
        return this.brokerResponse(
          requestId,
          this.result(
            sessionId,
            requestId,
            true,
            "OK",
            `${method} completed. ${this.operationReminder()}`,
            false,
            undefined,
            this.config.lockingEnabled ? addUnlockReminder(progress) : progress
          )
        );
        }
        const guest = this.guest;
        if (!guest) throw new Error("GUEST_NOT_CONNECTED");
        const guestResponse = await guest.request(
          sessionId,
          method,
          params,
          timeout
        );
        if (this.config.lockingEnabled) this.lease.touch(sessionId);
        const processed = await this.processGuestResponse(guestResponse, timeout);
        this.trackResources(sessionId, method, params, processed.response);
        const data = this.config.lockingEnabled
          ? addUnlockReminder(processed.response.data)
          : processed.response.data;
        return {
          kind: "broker_response",
          id: requestId,
          result: this.result(
            sessionId,
            requestId,
            processed.response.ok,
            processed.response.code,
            `${processed.response.message} ${this.operationReminder()}`,
            !processed.response.ok && SAFE_RETRY_METHODS.has(method),
            processed.response.ok ? undefined : remediationForCode(processed.response.code),
            data
          ),
          ...(processed.image ? { image: processed.image } : {})
        };
      } finally {
        if (renewalTimer) clearInterval(renewalTimer);
      }
    } catch (error) {
      if (this.config.lockingEnabled) this.lease.touch(sessionId);
      const code = errorCode(error);
      const retryable = SAFE_RETRY_METHODS.has(method);
      const transfer = TRANSFER_METHODS.has(method);
      const reportedCode = transfer
        ? method.startsWith("directory_")
          ? "PARTIAL_TRANSFER"
          : code
        : retryable
          ? code
          : "OUTCOME_UNKNOWN";
      return this.brokerResponse(
        requestId,
        this.result(
          sessionId,
          requestId,
          false,
          reportedCode,
          `${errorMessage(error)} ${this.operationReminder()}`,
          retryable,
          transfer
            ? "Correct the reported path or transfer error and retry. Directory transfers merge, so already committed files remain."
            : retryable
            ? "Retry after checking vm_status."
            : "Inspect the VM with screen_capture before repeating this operation."
        )
      );
    }
  }

  private async executeLocal(
    sessionId: string,
    sessionLabel: string,
    method: string,
    params: Record<string, unknown>,
    requestId: string
  ): Promise<BrokerResponse | undefined> {
    if (!NON_LOCKING_METHODS.has(method)) {
      return undefined;
    }
    if (method === "vm_status") {
      return this.brokerResponse(
        requestId,
        this.result(sessionId, requestId, true, "OK", "Broker status.", false, undefined, {
          connection: this.snapshot,
          lease: {
            ...this.lease.snapshot(sessionId),
            lockingEnabled: this.config.lockingEnabled
          },
          broker: publicConfig(this.config)
        })
      );
    }
    if (method === "host_network_info") {
      return this.brokerResponse(
        requestId,
        this.result(sessionId, requestId, true, "OK", "Host IPv4 addresses.", false, undefined, {
          addresses: hostIpv4Addresses(),
          guestPort: this.config.guestPort,
          upstream: this.config.upstreamHost
            ? { host: this.config.upstreamHost, port: this.config.upstreamPort }
            : undefined
        })
      );
    }
    if (method === "broker_set_upstream") {
      const enabled = params["enabled"] === true;
      const host = typeof params["host"] === "string" ? params["host"].trim() : "";
      const rawPort = params["port"];
      const port = typeof rawPort === "number" ? rawPort : undefined;
      if (enabled && (!host || !Number.isInteger(port) || port === undefined || port < 1 || port > 65_535)) {
        return this.brokerResponse(
          requestId,
          this.result(sessionId, requestId, false, "INVALID_ARGUMENT", "A proxy host and port between 1 and 65535 are required.", false)
        );
      }
      const unchanged = enabled
        ? this.config.upstreamHost === host && this.config.upstreamPort === port
        : this.config.upstreamHost === undefined;
      if (unchanged) {
        return this.brokerResponse(
          requestId,
          this.result(
            sessionId,
            requestId,
            true,
            "OK",
            "The requested proxy configuration is already active.",
            false,
            undefined,
            { upstream: enabled ? { host, port } : undefined, reconnecting: false }
          )
        );
      }
      if (this.lease.currentOwner) {
        return this.brokerResponse(
          requestId,
          this.result(
            sessionId,
            requestId,
            false,
            "VM_BUSY",
            "Close active VM work before changing the proxy destination.",
            true,
            "Call vm_unlock after closing terminals and transfers."
          )
        );
      }
      const previous = this.config.upstreamHost
        ? { host: this.config.upstreamHost, port: this.config.upstreamPort }
        : undefined;
      if (enabled) {
        this.config.upstreamHost = host;
        this.config.upstreamPort = port!;
      } else {
        delete this.config.upstreamHost;
        delete this.config.upstreamPort;
      }
      // The guest keeps a two-second reconnect loop. Closing its current
      // channel is deliberate: its next connection is accepted using the
      // newly selected direct or upstream transport.
      const guest = this.guest;
      const bridge = this.proxyBridge;
      this.guest = undefined;
      this.proxyBridge = undefined;
      this.capabilities = undefined;
      this.connectionState = { state: "offline", epoch: ++this.connectionEpoch };
      guest?.destroy();
      bridge?.destroy();
      this.logger.write("info", "upstream_reconfigured", {
        previous,
        upstream: enabled ? { host, port } : undefined
      });
      return this.brokerResponse(
        requestId,
        this.result(
          sessionId,
          requestId,
          true,
          "OK",
          enabled
            ? "Proxy destination applied. The guest will reconnect through the remote broker."
            : "Proxy disabled. The guest will reconnect directly to this broker.",
          false,
          undefined,
          { upstream: enabled ? { host, port } : undefined, reconnecting: true }
        )
      );
    }
    if (method === "broker_sessions") {
      return this.brokerResponse(
        requestId,
        this.result(sessionId, requestId, true, "OK", "Connected broker adapter sessions.", false, undefined, {
          lockingEnabled: this.config.lockingEnabled,
          sessions: [...this.adapters.values()].map((adapter) => ({
            sessionId: adapter.id,
            label: adapter.label,
            connectedAt: adapter.connectedAt,
            current: adapter.id === sessionId,
            holdsLease: this.lease.currentOwner?.sessionId === adapter.id,
            resources: [...(this.openResources.get(adapter.id) ?? [])]
          }))
        })
      );
    }
    if (method === "broker_disconnect_session") {
      const targetSessionId = typeof params["session_id"] === "string"
        ? params["session_id"]
        : typeof params["sessionId"] === "string" ? params["sessionId"] : "";
      if (!targetSessionId) {
        return this.brokerResponse(requestId, this.result(
          sessionId, requestId, false, "INVALID_ARGUMENT", "session_id is required.", false
        ));
      }
      if (targetSessionId === sessionId) {
        return this.brokerResponse(requestId, this.result(
          sessionId, requestId, false, "CANNOT_DISCONNECT_SELF", "Close this admin app or MCP process to disconnect its own session.", false
        ));
      }
      const target = this.adapters.get(targetSessionId);
      if (!target) {
        return this.brokerResponse(requestId, this.result(
          sessionId, requestId, false, "SESSION_NOT_FOUND", "The requested agent session is no longer connected.", false
        ));
      }
      target.socket.destroy();
      this.logger.write("warn", "adapter_disconnect_requested", {
        requestedBy: sessionId,
        targetSessionId,
        targetLabel: target.label
      });
      return this.brokerResponse(requestId, this.result(
        sessionId,
        requestId,
        true,
        "OK",
        "Disconnect requested. If that agent owned the exclusive lease, cleanup and release are now running.",
        false,
        undefined,
        { targetSessionId, cleanupPending: this.config.lockingEnabled && this.lease.currentOwner?.sessionId === targetSessionId }
      ));
    }
    if (method === "broker_set_locking") {
      const enabled = params["enabled"];
      if (typeof enabled !== "boolean") {
        return this.brokerResponse(requestId, this.result(
          sessionId, requestId, false, "INVALID_ARGUMENT", "enabled must be true or false.", false
        ));
      }
      if (enabled === this.config.lockingEnabled) {
        return this.brokerResponse(requestId, this.result(
          sessionId, requestId, true, "OK", enabled ? "Exclusive locking is already enabled." : "Exclusive locking is already disabled.", false,
          undefined, { lockingEnabled: enabled }
        ));
      }
      if (this.lease.currentOwner) {
        return this.brokerResponse(requestId, this.result(
          sessionId,
          requestId,
          false,
          "VM_BUSY",
          "Disconnect or unlock the current lease owner before changing exclusive locking.",
          true,
          "Use the Agents panel to disconnect the owner, then apply the change again."
        ));
      }
      if (enabled && this.openResources.size > 0) {
        return this.brokerResponse(requestId, this.result(
          sessionId,
          requestId,
          false,
          "RESOURCES_ACTIVE",
          "Close active terminals and transfers before re-enabling exclusive locking.",
          false
        ));
      }
      this.lease.clearWaiters();
      this.config.lockingEnabled = enabled;
      this.logger.write("warn", "exclusive_locking_changed", { enabled, requestedBy: sessionId });
      return this.brokerResponse(requestId, this.result(
        sessionId,
        requestId,
        true,
        "OK",
        enabled
          ? "Exclusive locking enabled. VM work will again use one lease owner."
          : "Exclusive locking disabled. Agents may issue concurrent requests; mouse and keyboard actions can collide.",
        false,
        undefined,
        { lockingEnabled: enabled }
      ));
    }
    if (method === "vm_capabilities") {
      if (!this.capabilities) {
        return this.brokerResponse(
          requestId,
          this.result(
            sessionId,
            requestId,
            false,
            "VM_OFFLINE",
            "No guest capabilities are currently available.",
            true
          )
        );
      }
      return this.brokerResponse(
        requestId,
        this.result(
          sessionId,
          requestId,
          true,
          "OK",
          "Guest capabilities.",
          false,
          undefined,
          this.guestCapabilities
        )
      );
    }
    if (method === "vm_lock") {
      if (!this.config.lockingEnabled) {
        return this.brokerResponse(requestId, this.result(
          sessionId, requestId, true, "LOCKING_DISABLED",
          "Exclusive locking is disabled; this session may operate concurrently with other agents.", false
        ));
      }
      const acquisition = this.lease.acquire(sessionId, sessionLabel, true);
      return this.brokerResponse(
        requestId,
        acquisition.acquired
          ? this.result(
              sessionId,
              requestId,
              true,
              "OK",
              `VM lease acquired. ${UNLOCK_REMINDER}`,
              false
            )
          : this.result(
              sessionId,
              requestId,
              false,
              "VM_BUSY",
              "Another agent owns the Windows 98 VM.",
              true,
              "Call vm_wait with this wait ticket.",
              {
                waitTicket: acquisition.ticket,
                queuePosition: acquisition.queuePosition,
                retryAfterMs: 1_000
              }
            )
      );
    }
    if (method === "vm_wait") {
      if (!this.config.lockingEnabled) {
        return this.brokerResponse(requestId, this.result(
          sessionId, requestId, true, "LOCKING_DISABLED",
          "Exclusive locking is disabled; no lease wait is needed.", false
        ));
      }
      const seconds = boundedNumber(params["wait_seconds"], 10, 0, 600);
      const ticketId =
        typeof params["ticket_id"] === "string" ? params["ticket_id"] : undefined;
      const acquisition = await this.lease.wait(
        sessionId,
        sessionLabel,
        Math.floor(seconds * 1_000),
        ticketId
      );
      return this.brokerResponse(
        requestId,
        acquisition.acquired
          ? this.result(
              sessionId,
              requestId,
              true,
              "OK",
              `VM lease acquired. ${UNLOCK_REMINDER}`,
              false
            )
          : this.result(
              sessionId,
              requestId,
              false,
              "VM_BUSY",
              "The wait period ended before the VM became available.",
              true,
              "Call vm_wait again with the same ticket.",
              {
                waitTicket: acquisition.ticket,
                queuePosition: acquisition.queuePosition,
                retryAfterMs: 1_000
              }
            )
      );
    }

    const force = params["force"] === true;
    if (!this.config.lockingEnabled) {
      const resources = this.openResources.get(sessionId);
      if (!force && resources && resources.size > 0) {
        return this.brokerResponse(requestId, this.result(
          sessionId, requestId, false, "RESOURCES_ACTIVE",
          "Close this session's terminal or transfer resources before finishing.", false,
          "Close the listed resources, or call vm_unlock with force=true.",
          { resources: [...resources] }
        ));
      }
      await this.enqueueCleanup(sessionId, "explicit_unlock_parallel", force, false);
      return this.brokerResponse(requestId, this.result(
        sessionId,
        requestId,
        true,
        "LOCKING_DISABLED",
        "This session's resources were released. Exclusive locking remains disabled.",
        false
      ));
    }
    if (this.lease.currentOwner?.sessionId !== sessionId) {
      this.lease.disconnect(sessionId);
      return this.brokerResponse(
        requestId,
        this.result(
          sessionId,
          requestId,
          true,
          "NOT_LOCKED",
          "This session does not own the VM lease.",
          false
        )
      );
    }
    const resources = this.openResources.get(sessionId);
    if (!force && resources && resources.size > 0) {
      return this.brokerResponse(
        requestId,
        this.result(
          sessionId,
          requestId,
          false,
          "RESOURCES_ACTIVE",
          "The VM cannot be unlocked while terminal or transfer resources remain active.",
          false,
          "Close the listed resources, or call vm_unlock with force=true.",
          { resources: [...resources] }
        )
      );
    }
    const cleanup = await this.enqueueCleanup(
      sessionId,
      "explicit_unlock",
      force,
      true
    );
    if (!cleanup.sanitized) {
      return this.brokerResponse(
        requestId,
        this.result(
          sessionId,
          requestId,
          false,
          "CLEANUP_PENDING_RECONNECT",
          "The local lease was released, but guest cleanup was not acknowledged. New owners remain blocked.",
          true,
          "Restart or reconnect WIN98CTL.EXE. The broker will sanitize the guest before allowing another owner."
        )
      );
    }
    return this.brokerResponse(
      requestId,
      this.result(
        sessionId,
        requestId,
        true,
        "OK",
        "VM lease released and guest input state sanitized.",
        false
      )
    );
  }

  private result<T>(
    sessionId: string,
    requestId: string,
    ok: boolean,
    code: string,
    message: string,
    retryable: boolean,
    remediation?: string,
    data?: T
  ): ToolResult<T> {
    return {
      ok,
      code,
      message,
      requestId,
      connection: this.snapshot,
      lease: this.lease.snapshot(sessionId),
      retryable,
      ...(remediation !== undefined ? { remediation } : {}),
      ...(data !== undefined ? { data } : {})
    };
  }

  private brokerResponse(id: string, result: ToolResult): BrokerResponse {
    return { kind: "broker_response", id, result };
  }

  private emitTransferProgress(sessionId: string, progress: TransferProgress): void {
    const adapter = this.adapters.get(sessionId);
    if (adapter?.greeted && !adapter.socket.destroyed) {
      writeLine(adapter.socket, { kind: "broker_progress", sessionId, progress });
    }
  }

  private acceptAdapter(socket: Socket): void {
    socket.setNoDelay(true);
    const provisionalId = randomUUID();
    const adapter: AdapterSession = {
      id: provisionalId,
      label: "unidentified adapter",
      connectedAt: new Date().toISOString(),
      socket,
      buffer: "",
      greeted: false,
      resources: new Set()
    };
    let chain = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      adapter.buffer += chunk.toString("utf8");
      if (Buffer.byteLength(adapter.buffer, "utf8") > LOCAL_MESSAGE_LIMIT) {
        socket.destroy(new Error("LOCAL_MESSAGE_TOO_LARGE"));
        return;
      }
      const lines = adapter.buffer.split("\n");
      adapter.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        chain = chain
          .then(() => this.handleAdapterLine(adapter, line))
          .catch((error) => {
            this.logger.write("warn", "adapter_protocol_error", { error });
            socket.destroy();
          });
      }
    });
    socket.on("error", (error) => {
      this.logger.write("debug", "adapter_socket_error", { error });
    });
    socket.on("close", () => this.adapterClosed(adapter));
  }

  private async handleAdapterLine(
    adapter: AdapterSession,
    line: string
  ): Promise<void> {
    const message = JSON.parse(line) as unknown;
    if (!adapter.greeted) {
      if (!isBrokerHello(message)) {
        throw new Error("BROKER_HELLO_REQUIRED");
      }
      if (this.adapters.has(message.sessionId)) {
        throw new Error("SESSION_ALREADY_CONNECTED");
      }
      adapter.id = message.sessionId;
      adapter.label = message.sessionLabel.slice(0, 128);
      adapter.greeted = true;
      this.adapters.set(adapter.id, adapter);
      writeLine(adapter.socket, {
        kind: "broker_ready",
        sessionId: adapter.id,
        connection: this.snapshot
      });
      this.logger.write("info", "adapter_connected", {
        sessionId: adapter.id,
        sessionLabel: adapter.label
      });
      return;
    }
    if (!isBrokerRequest(message)) {
      throw new Error("BROKER_REQUEST_INVALID");
    }
    if (message.sessionId !== adapter.id || message.sessionLabel !== adapter.label) {
      throw new Error("SESSION_IDENTITY_MISMATCH");
    }
    const response = await this.execute(
      adapter.id,
      adapter.label,
      message.method,
      message.params
    );
    response.id = message.id;
    writeLine(adapter.socket, response);
  }

  private adapterClosed(adapter: AdapterSession): void {
    if (!adapter.greeted || this.adapters.get(adapter.id) !== adapter) {
      return;
    }
    this.adapters.delete(adapter.id);
    const relation = this.lease.disconnect(adapter.id);
    this.logger.write("info", "adapter_disconnected", {
      sessionId: adapter.id,
      relation
    });
    if (relation === "owner") {
      void this.enqueueCleanup(adapter.id, "adapter_disconnect", true, true);
    } else if (!this.config.lockingEnabled) {
      // In advisory parallel mode there is no lease owner, but this adapter
      // can still own broker-tracked terminal or transfer resources.
      void this.enqueueCleanup(adapter.id, "adapter_disconnect_parallel", true, false);
    }
  }

  private acceptGuest(socket: Socket): void {
    if ((this.guest && !this.guest.closed) || (this.proxyBridge && !this.proxyBridge.closed)) {
      socket.end();
      this.logger.write("warn", "guest_rejected", { reason: "already_connected" });
      return;
    }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    if (this.config.upstreamHost && this.config.upstreamPort) {
      const epoch = ++this.connectionEpoch;
      const bridge = new UpstreamGuestBridge(
        socket,
        this.config.upstreamHost,
        this.config.upstreamPort,
        (state) => {
          if (this.proxyBridge === bridge) {
            this.connectionState = state;
          }
        },
        (error) => {
          if (this.proxyBridge === bridge) {
            this.proxyBridge = undefined;
            this.connectionState = { state: "offline", epoch };
            this.logger.write("warn", "upstream_bridge_closed", { error, upstream: `${this.config.upstreamHost}:${this.config.upstreamPort}` });
          }
        },
        epoch,
        socket.remoteAddress
      );
      this.proxyBridge = bridge;
      this.connectionState = {
        state: "connecting",
        epoch,
        connectedAt: new Date().toISOString(),
        ...(socket.remoteAddress ? { remoteAddress: socket.remoteAddress } : {})
      };
      this.logger.write("info", "upstream_bridge_connecting", {
        upstream: `${this.config.upstreamHost}:${this.config.upstreamPort}`,
        guestAddress: socket.remoteAddress
      });
      bridge.start();
      return;
    }
    const guest = new GuestConnection(
      socket,
      this.config,
      () => ++this.connectionEpoch,
      (state, capabilities) => this.guestStateChanged(guest, state, capabilities),
      (error) => this.guestClosed(guest, error),
      this.logger
    );
    this.guest = guest;
    this.connectionState = {
      state: "connecting",
      epoch: this.connectionEpoch,
      connectedAt: new Date().toISOString(),
      ...(socket.remoteAddress ? { remoteAddress: socket.remoteAddress } : {})
    };
    guest.start();
  }

  private guestStateChanged(
    guest: GuestConnection,
    state: ConnectionSnapshot,
    capabilities?: GuestCapabilities
  ): void {
    if (this.guest !== guest) {
      return;
    }
    this.connectionState = state;
    if (capabilities) {
      this.capabilities = capabilities;
    }
    if (state.state === "sanitizing") {
      this.lease.setBlocked(true);
      void guest
        .request("broker", "session_abort", { reason: "connection_start" }, 10_000)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`SANITIZE_FAILED:${response.code}`);
          }
          if (this.guest !== guest || guest.closed) {
            return;
          }
          this.connectionState = {
            ...state,
            state: "online",
            lastSeenAt: new Date().toISOString()
          };
          this.lease.setBlocked(false);
          this.logger.write("info", "guest_online", {
            epoch: state.epoch,
            guestBuildId: capabilities?.guestBuildId
          });
        })
        .catch((error) => {
          this.logger.write("error", "guest_initial_sanitize_failed", { error });
          guest.destroy();
        });
    }
  }

  private guestClosed(guest: GuestConnection, error?: Error): void {
    if (this.guest !== guest) {
      return;
    }
    this.guest = undefined;
    this.capabilities = undefined;
    this.connectionState = {
      state: "offline",
      epoch: this.connectionEpoch
    };
    this.logger.write("warn", "guest_disconnected", {
      error,
      epoch: this.connectionEpoch
    });
  }

  private async enqueueCleanup(
    sessionId: string,
    reason: string,
    force: boolean,
    releaseOwner: boolean
  ): Promise<CleanupOutcome> {
    const operation = this.cleanupChain.then(async () => {
      if (!this.config.lockingEnabled) {
        let cleanupFailed = false;
        try {
          await this.transfers.abortSession(sessionId);
          await this.closeSessionResources(sessionId);
        } catch (error) {
          cleanupFailed = true;
          this.logger.write("error", "parallel_session_cleanup_failed", {
            error,
            sessionId,
            reason
          });
        }
        this.openResources.delete(sessionId);
        return { sanitized: !cleanupFailed, pendingReconnect: false };
      }
      this.lease.setBlocked(true);
      let sanitized = false;
      let cleanupFailed = false;
      try {
        await this.transfers.abortSession(sessionId);
      } catch (error) {
        cleanupFailed = true;
        this.logger.write("error", "transfer_cleanup_failed", {
          error,
          sessionId,
          reason
        });
        this.guest?.destroy();
      }
      this.openResources.delete(sessionId);
      const guest = this.guest;
      if (!cleanupFailed && guest?.ready && !guest.closed) {
        this.connectionState = {
          ...this.connectionState,
          state: "sanitizing"
        };
        try {
          const response = await guest.request(
            sessionId,
            "session_abort",
            { reason, force },
            10_000
          );
          if (!response.ok) {
            throw new Error(`SESSION_ABORT_FAILED:${response.code}`);
          }
          if (this.guest === guest && !guest.closed) {
            this.connectionState = {
              ...this.connectionState,
              state: "online",
              lastSeenAt: new Date().toISOString()
            };
            sanitized = true;
          }
        } catch (error) {
          cleanupFailed = true;
          this.logger.write("error", "guest_cleanup_failed", {
            error,
            sessionId,
            reason
          });
          guest.destroy();
        }
      }
      if (releaseOwner) {
        this.lease.release(sessionId);
      }
      if (sanitized) {
        this.lease.setBlocked(false);
      }
      return {
        sanitized,
        pendingReconnect: !sanitized
      };
    });
    this.cleanupChain = operation.then(
      () => undefined,
      () => undefined
    );
    return await operation;
  }

  private async closeSessionResources(sessionId: string): Promise<void> {
    const resources = [...(this.openResources.get(sessionId) ?? [])];
    const guest = this.guest;
    if (!guest?.ready || guest.closed) return;
    for (const resource of resources) {
      if (resource.startsWith("terminal:")) {
        const terminalId = resource.slice("terminal:".length);
        try {
          await guest.request(sessionId, "shell_terminate", { session_id: terminalId }, 10_000);
        } catch {
          // A terminal can have exited between resource tracking and cleanup.
        }
        try {
          await guest.request(sessionId, "shell_close", { session_id: terminalId }, 10_000);
        } catch {
          // The guest may already have cleaned the terminal after a failure.
        }
      } else if (resource.startsWith("guest-transfer:")) {
        const transferId = resource.slice("guest-transfer:".length);
        try {
          await guest.request(sessionId, "file_write_abort", { transferId }, 10_000);
        } catch {
          // The partial remains resumable even when the guest has disconnected.
        }
      }
    }
  }

  private operationReminder(): string {
    return this.config.lockingEnabled
      ? UNLOCK_REMINDER
      : "Exclusive locking is disabled; concurrent mouse and keyboard actions can collide.";
  }

  private async processGuestResponse(
    response: GuestResponse,
    timeoutMs: number
  ): Promise<ProcessedGuestResponse> {
    if (!this.guest) {
      return { response };
    }
    const record = isRecord(response.data) ? { ...response.data } : undefined;
    let imageBytes: Buffer | undefined;
    let imageMimeType = "image/png";
    if (record && typeof record["imageBase64"] === "string") {
      imageBytes = decodeStrictBase64(record["imageBase64"]);
      if (typeof record["mimeType"] === "string") {
        imageMimeType = record["mimeType"];
      }
      delete record["imageBase64"];
    } else if (record && isBinaryDescriptor(record["binary"])) {
      const descriptor = record["binary"];
      if (
        descriptor.mimeType === "image/png" ||
        descriptor.mimeType === "image/bmp" ||
        descriptor.mimeType === "image/x-ms-bmp"
      ) {
        imageBytes = await this.guest.waitForStream(descriptor, timeoutMs);
        imageMimeType = descriptor.mimeType;
        delete record["binary"];
      }
    }
    if (!imageBytes) {
      return { response };
    }
    const pngBytes = normalizeImageToPng(imageBytes, imageMimeType);
    const artifact = await this.artifacts.put(pngBytes, "image/png", ".png");
    const updated: GuestResponse = {
      ...response,
      data: {
        ...(record ?? {}),
        artifact: publicArtifact(artifact)
      }
    };
    return {
      response: updated,
      image: {
        mimeType: "image/png",
        data: pngBytes.toString("base64")
      }
    };
  }

  private trackResources(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    response: GuestResponse
  ): void {
    if (!response.ok && response.code !== "NEEDS_ATTENTION") {
      return;
    }
    let resources = this.openResources.get(sessionId);
    if (!resources) {
      resources = new Set();
      this.openResources.set(sessionId, resources);
    }
    if (
      (method === "shell_start" || method === "shell_exec") &&
      isRecord(response.data) &&
      (method === "shell_start" || response.data["running"] === true)
    ) {
      const id = response.data["sessionId"] ?? response.data["session_id"];
      if (typeof id === "string") {
        resources.add(`terminal:${id}`);
      }
    }
    if (method === "shell_close") {
      const id = params["session_id"] ?? params["sessionId"];
      if (typeof id === "string") {
        resources.delete(`terminal:${id}`);
      }
    }
    if (method === "file_write_begin" && isRecord(response.data)) {
      const id = response.data["transferId"];
      if (typeof id === "string") {
        resources.add(`guest-transfer:${id}`);
      }
    }
    if (method === "file_write_commit" || method === "file_write_abort") {
      const id = params["transferId"];
      if (typeof id === "string") {
        resources.delete(`guest-transfer:${id}`);
      }
    }
    if (resources.size === 0) {
      this.openResources.delete(sessionId);
    }
  }

  private addResource(sessionId: string, resource: string): void {
    let resources = this.openResources.get(sessionId);
    if (!resources) {
      resources = new Set();
      this.openResources.set(sessionId, resources);
    }
    resources.add(resource);
  }

  private removeResource(sessionId: string, resource: string): void {
    const resources = this.openResources.get(sessionId);
    resources?.delete(resource);
    if (resources?.size === 0) {
      this.openResources.delete(sessionId);
    }
  }

  private checkGuestHeartbeat(): void {
    const guest = this.guest;
    if (!guest || guest.closed) {
      return;
    }
    if (
      Date.now() - guest.lastSeenAt > this.config.heartbeatTimeoutMs &&
      !guest.hasPendingRequests
    ) {
      this.logger.write("warn", "guest_heartbeat_timeout");
      guest.destroy();
      return;
    }
    if (guest.ready) {
      guest.sendPing();
    }
  }

  private async waitForGuest(): Promise<boolean> {
    if (this.connectionState.state === "online" && this.guest?.ready && !this.guest.closed) return true;
    const deadline = Date.now() + this.config.guestConnectTimeoutMs;
    while (Date.now() < deadline) {
      if (this.connectionState.state === "online" && this.guest?.ready && !this.guest.closed) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }
}

function hostIpv4Addresses(): Array<{ name: string; address: string; netmask: string; virtual: boolean }> {
  const addresses: Array<{ name: string; address: string; netmask: string; virtual: boolean }> = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      addresses.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        virtual: /vmware|qemu|virtual|vbox|hyper-v|vethernet/i.test(name)
      });
    }
  }
  return addresses.sort((left, right) => Number(right.virtual) - Number(left.virtual) || left.name.localeCompare(right.name));
}

/**
 * A transparent reverse bridge. The local VM still dials this broker, while
 * this broker dials the configured upstream broker and pipes the existing v2
 * frames unchanged. The upstream therefore sees the real VM as its guest and
 * retains the normal broker, lease, screenshot, terminal, and transfer paths.
 */
class UpstreamGuestBridge {
  closed = false;
  private upstream: Socket | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private connected = false;

  constructor(
    private readonly guestSocket: Socket,
    private readonly host: string,
    private readonly port: number,
    private readonly onState: (state: ConnectionSnapshot) => void,
    private readonly onClose: (error?: Error) => void,
    private readonly epoch: number,
    private readonly guestAddress?: string
  ) {}

  start(): void {
    this.guestSocket.pause();
    this.guestSocket.on("error", (error) => this.destroy(error));
    this.guestSocket.on("close", () => this.destroy());
    this.connectUpstream();
  }

  destroy(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.guestSocket.unpipe();
    this.upstream?.unpipe();
    this.upstream?.destroy();
    this.upstream = undefined;
    this.guestSocket.destroy();
    this.onClose(error);
  }

  private connectUpstream(): void {
    if (this.closed || this.connected) return;
    this.onState({
      state: "connecting",
      epoch: this.epoch,
      connectedAt: new Date().toISOString(),
      ...(this.guestAddress ? { remoteAddress: this.guestAddress } : {})
    });
    const upstream = createConnection({ host: this.host, port: this.port });
    this.upstream = upstream;
    upstream.setNoDelay(true);
    upstream.setKeepAlive(true, 10_000);
    let settled = false;
    const retry = (error?: Error): void => {
      if (settled || this.closed || this.connected) return;
      settled = true;
      upstream.destroy();
      this.upstream = undefined;
      this.retryTimer = setTimeout(() => this.connectUpstream(), 2_000);
      this.retryTimer.unref();
      if (error) {
        this.onState({
          state: "connecting",
          epoch: this.epoch,
          ...(this.guestAddress ? { remoteAddress: this.guestAddress } : {})
        });
      }
    };
    upstream.once("error", retry);
    upstream.once("connect", () => {
      if (this.closed) {
        upstream.destroy();
        return;
      }
      settled = true;
      this.connected = true;
      upstream.removeListener("error", retry);
      upstream.on("error", (error) => this.destroy(error));
      upstream.on("close", () => this.destroy());
      this.guestSocket.pipe(upstream);
      upstream.pipe(this.guestSocket);
      this.guestSocket.resume();
      this.onState({
        state: "online",
        epoch: this.epoch,
        connectedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        ...(this.guestAddress ? { remoteAddress: this.guestAddress } : {})
      });
    });
    upstream.once("close", () => retry());
  }
}

export async function startBroker(
  configOrOptions: BrokerConfig | LoadBrokerConfigOptions = {}
): Promise<Broker> {
  const broker = isBrokerConfig(configOrOptions)
    ? new Broker(configOrOptions)
    : await Broker.create(configOrOptions);
  await broker.start();
  return broker;
}

class GuestConnection {
  ready = false;
  closed = false;
  lastSeenAt = Date.now();

  private readonly decoder = new FrameDecoder();
  private phase: "hello" | "ready" = "hello";
  private txSequence = 1n;
  private rxSequence = 1n;
  private nextStreamId = 1;
  private readonly pending = new Map<string, PendingGuestRequest>();
  // Windows 98 executes one request at a time.  Advisory parallel mode still
  // accepts calls from several adapters, but queues frames here so clients do
  // not receive a spurious guest-level VM_BUSY race.
  private advisoryRequestChain: Promise<void> = Promise.resolve();
  private readonly streams: IncomingStreamRegistry;
  private frameChain: Promise<void> = Promise.resolve();
  private handshakeTimer: NodeJS.Timeout | undefined;
  private epoch = 0;
  private capabilities: GuestCapabilities | undefined;

  get hasPendingRequests(): boolean {
    return this.pending.size > 0;
  }

  constructor(
    private readonly socket: Socket,
    private readonly config: BrokerConfig,
    private readonly nextEpoch: () => number,
    private readonly onState: (
      state: ConnectionSnapshot,
      capabilities?: GuestCapabilities
    ) => void,
    private readonly onClose: (error?: Error) => void,
    private readonly logger: JsonlLogger
  ) {
    this.streams = new IncomingStreamRegistry(config.maxArtifactBytes);
  }

  start(): void {
    this.handshakeTimer = setTimeout(
      () => this.fail(new Error("GUEST_HELLO_TIMEOUT")),
      this.config.guestConnectTimeoutMs
    );
    this.handshakeTimer.unref();
    this.socket.on("data", (chunk: Buffer) => {
      this.lastSeenAt = Date.now();
      try {
        const frames = this.decoder.push(chunk);
        for (const frame of frames) {
          this.frameChain = this.frameChain
            .then(() => this.handleFrame(frame))
            .catch((error) => this.fail(asError(error)));
        }
      } catch (error) {
        this.fail(asError(error));
      }
    });
    this.socket.on("error", (error) => {
      this.logger.write("debug", "guest_socket_error", { error });
    });
    this.socket.on("close", () => this.closeInternal());
  }

  async request(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<GuestResponse> {
    if (
      !this.config.lockingEnabled &&
      method !== "session_abort" &&
      method !== "sanitize"
    ) {
      const operation = this.advisoryRequestChain.then(() =>
        this.requestNow(sessionId, method, params, timeoutMs)
      );
      this.advisoryRequestChain = operation.then(
        () => undefined,
        () => undefined
      );
      return await operation;
    }
    return await this.requestNow(sessionId, method, params, timeoutMs);
  }

  private async requestNow(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<GuestResponse> {
    if (!this.ready || this.closed) {
      throw new Error("GUEST_NOT_CONNECTED");
    }
    const requestId = randomUUID();
    const request: GuestRequest = {
      kind: "request",
      requestId,
      sessionId,
      method,
      params
    };
    return new Promise<GuestResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`GUEST_REQUEST_TIMEOUT:${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { method, resolve, reject, timer });
      try {
        this.sendFrame(FrameType.Request, this.nextStreamId++, encodeJson(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(asError(error));
      }
    });
  }

  async waitForStream(
    descriptor: BinaryDescriptor,
    timeoutMs: number
  ): Promise<Buffer> {
    return await this.streams.waitFor(descriptor, timeoutMs);
  }

  sendPing(): void {
    if (this.ready && !this.closed) {
      this.sendFrame(FrameType.Ping, 0, Buffer.alloc(0));
    }
  }

  destroy(): void {
    this.socket.destroy();
  }

  private async handleFrame(frame: ReturnType<FrameDecoder["push"]>[number]): Promise<void> {
    if (this.phase !== "ready") {
      await this.handleHello(frame);
      return;
    }
    if (frame.header.sequence !== this.rxSequence) {
      throw new Error(
        `FRAME_SEQUENCE_INVALID:${frame.header.sequence.toString()}:${this.rxSequence.toString()}`
      );
    }
    this.rxSequence += 1n;
    this.lastSeenAt = Date.now();

    if (frame.header.type === FrameType.Response) {
      const response = decodeJson<GuestResponse>(frame.payload);
      if (!isGuestResponse(response)) {
        throw new Error("GUEST_RESPONSE_INVALID");
      }
      const pending = this.pending.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(response.requestId);
        pending.resolve(response);
      }
      return;
    }
    if (frame.header.type === FrameType.Data) {
      this.acceptData(frame.header.streamId, frame.header.flags, frame.payload);
      return;
    }
    if (frame.header.type === FrameType.Ping) {
      this.sendFrame(FrameType.Pong, frame.header.streamId, frame.payload);
      return;
    }
    if (frame.header.type === FrameType.Pong || frame.header.type === FrameType.Event) {
      return;
    }
    if (frame.header.type === FrameType.Error) {
      this.logger.write("warn", "guest_protocol_error", {
        message: frame.payload.toString("utf8").slice(0, 1024)
      });
      return;
    }
    throw new Error(`FRAME_TYPE_UNEXPECTED:${frame.header.type}`);
  }

  private async handleHello(
    frame: ReturnType<FrameDecoder["push"]>[number]
  ): Promise<void> {
    if (frame.header.type !== FrameType.Hello) {
      throw new Error("GUEST_HELLO_REQUIRED");
    }
    const hello = decodeJson<GuestHelloMessage>(frame.payload);
    if (hello.kind !== "guest_hello" || !isCapabilities(hello.capabilities)) {
      throw new Error("GUEST_HELLO_INVALID");
    }
    this.capabilities = hello.capabilities;
    this.epoch = this.nextEpoch();
    this.phase = "ready";
    this.ready = true;
    this.txSequence = 1n;
    this.rxSequence = 1n;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
    const ready: ReadyMessage = {
      kind: "ready",
      epoch: this.epoch
    };
    this.write(encodeFrame({ type: FrameType.Ready, flags: 0, streamId: 0, sequence: 0n }, encodeJson(ready)));
    const now = new Date().toISOString();
    this.onState(
      {
        state: "sanitizing",
        epoch: this.epoch,
        connectedAt: now,
        lastSeenAt: now,
        guestBuildId: hello.capabilities.guestBuildId,
        ...(this.socket.remoteAddress
          ? { remoteAddress: this.socket.remoteAddress }
          : {})
      },
      hello.capabilities
    );
  }

  private acceptData(streamId: number, flags: number, payload: Buffer): void {
    this.streams.accept(
      streamId,
      (flags & DATA_FLAG_FINAL) !== 0,
      payload
    );
  }

  private sendFrame(type: FrameType, streamId: number, payload: Buffer): void {
    const sequence = this.txSequence;
    this.txSequence += 1n;
    this.write(
      encodeFrame(
        { type, flags: 0, streamId, sequence },
        payload
      )
    );
  }

  private write(buffer: Buffer): void {
    if (this.closed || !this.socket.writable) {
      throw new Error("GUEST_SOCKET_CLOSED");
    }
    this.socket.write(buffer);
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }
    this.logger.write("warn", "guest_protocol_failure", { error });
    this.socket.destroy(error);
  }

  private closeInternal(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`GUEST_DISCONNECTED:${pending.method}`));
    }
    this.pending.clear();
    this.streams.close(new Error("GUEST_DISCONNECTED"));
    this.onClose();
  }
}

function listen(
  server: Server,
  pathOrPort: string | number,
  host?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    const done = (): void => {
      server.off("error", onError);
      resolve();
    };
    if (typeof pathOrPort === "string") {
      server.listen(pathOrPort, done);
    } else {
      server.listen(pathOrPort, host, done);
    }
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

function writeLine(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function isBrokerHello(value: unknown): value is BrokerHello {
  return (
    isRecord(value) &&
    value["kind"] === "broker_hello" &&
    typeof value["sessionId"] === "string" &&
    value["sessionId"].length >= 8 &&
    typeof value["sessionLabel"] === "string" &&
    value["sessionLabel"].length > 0
  );
}

function isBrokerRequest(value: unknown): value is BrokerRequest {
  return (
    isRecord(value) &&
    value["kind"] === "broker_request" &&
    typeof value["id"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["sessionLabel"] === "string" &&
    typeof value["method"] === "string" &&
    isRecord(value["params"])
  );
}

function isGuestResponse(value: unknown): value is GuestResponse {
  return (
    isRecord(value) &&
    value["kind"] === "response" &&
    typeof value["requestId"] === "string" &&
    typeof value["ok"] === "boolean" &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string"
  );
}

function isCapabilities(value: unknown): value is GuestCapabilities {
  return (
    isRecord(value) &&
    typeof value["guestId"] === "string" &&
    typeof value["guestBuildId"] === "string" &&
    value["protocolVersion"] === PROTOCOL_VERSION &&
    typeof value["osName"] === "string" &&
    typeof value["osVersion"] === "string" &&
    typeof value["ansiCodePage"] === "number" &&
    typeof value["oemCodePage"] === "number" &&
    typeof value["screenWidth"] === "number" &&
    typeof value["screenHeight"] === "number" &&
    typeof value["colorDepth"] === "number" &&
    typeof value["supportsLongFileNames"] === "boolean" &&
    typeof value["supportsMouseWheel"] === "boolean" &&
    typeof value["maxPath"] === "number" &&
    typeof value["maxFileBytes"] === "number" &&
    Array.isArray(value["commands"]) &&
    value["commands"].every((command) => typeof command === "string")
  );
}

function isBinaryDescriptor(value: unknown): value is BinaryDescriptor {
  return (
    isRecord(value) &&
    Number.isInteger(value["streamId"]) &&
    (value["mimeType"] === undefined || typeof value["mimeType"] === "string") &&
    (value["totalBytes"] === undefined || Number.isInteger(value["totalBytes"])) &&
    (value["sha256"] === undefined || typeof value["sha256"] === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilitySupports(commands: string[], method: string): boolean {
  if (commands.includes(method)) {
    return true;
  }
  const group =
    method.startsWith("mouse_") ? "mouse"
      : method.startsWith("keyboard_") ? "keyboard"
        : method.startsWith("clipboard_") ? "clipboard"
          : method.startsWith("window_") ? "windows"
            : method.startsWith("shell_") ? "shell"
              : method.startsWith("process_") ? "processes"
                : method.startsWith("fs_") ||
                    method.startsWith("file_") ||
                    method.startsWith("directory_") ? "filesystem"
                  : method.startsWith("system_") ? "system"
                    : method === "input_batch" ? "input_batch"
                      : method;
  return commands.includes(group) ||
    (method === "input_batch" &&
      commands.includes("mouse") &&
      commands.includes("keyboard"));
}

export function convertBmp24ToPng(bmp: Buffer): Buffer {
  if (bmp.length < 54 || bmp.toString("ascii", 0, 2) !== "BM") {
    throw new Error("BMP_HEADER_INVALID");
  }
  const pixelOffset = bmp.readUInt32LE(10);
  const dibSize = bmp.readUInt32LE(14);
  const width = bmp.readInt32LE(18);
  const signedHeight = bmp.readInt32LE(22);
  const planes = bmp.readUInt16LE(26);
  const bitsPerPixel = bmp.readUInt16LE(28);
  const compression = bmp.readUInt32LE(30);
  if (
    dibSize < 40 ||
    width <= 0 ||
    signedHeight === 0 ||
    signedHeight === -2_147_483_648 ||
    planes !== 1 ||
    bitsPerPixel !== 24 ||
    compression !== 0
  ) {
    throw new Error("BMP_FORMAT_UNSUPPORTED");
  }
  const height = Math.abs(signedHeight);
  if (width > 16_384 || height > 16_384) {
    throw new Error("BMP_DIMENSIONS_INVALID");
  }
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowBytes * height;
  if (
    !Number.isSafeInteger(pixelBytes) ||
    pixelOffset < 14 + dibSize ||
    pixelOffset + pixelBytes > bmp.length
  ) {
    throw new Error("BMP_PIXEL_DATA_TRUNCATED");
  }
  const png = new PNG({ width, height });
  const bottomUp = signedHeight > 0;
  for (let y = 0; y < height; y += 1) {
    const sourceY = bottomUp ? height - 1 - y : y;
    const sourceRow = pixelOffset + sourceY * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * 3;
      const destination = (y * width + x) * 4;
      png.data[destination] = bmp.readUInt8(source + 2);
      png.data[destination + 1] = bmp.readUInt8(source + 1);
      png.data[destination + 2] = bmp.readUInt8(source);
      png.data[destination + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function normalizeImageToPng(image: Buffer, mimeType: string): Buffer {
  if (mimeType === "image/png") {
    if (
      image.length < 8 ||
      !image.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ) {
      throw new Error("PNG_HEADER_INVALID");
    }
    return image;
  }
  if (mimeType === "image/bmp" || mimeType === "image/x-ms-bmp") {
    return convertBmp24ToPng(image);
  }
  throw new Error(`IMAGE_MIME_UNSUPPORTED:${mimeType}`);
}

function decodeStrictBase64(value: string): Buffer {
  const result = Buffer.from(value, "base64");
  if (
    result.length === 0 ||
    result.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
  ) {
    throw new Error("BASE64_INVALID");
  }
  return result;
}

function requestTimeout(
  method: string,
  params: Record<string, unknown>,
  defaultTimeout: number
): number {
  const requested =
    typeof params["timeout_ms"] === "number" ? params["timeout_ms"] : 0;
  const longPoll =
    method === "shell_read" && typeof params["wait_ms"] === "number"
      ? params["wait_ms"]
      : 0;
  const estimated = estimateGuestOperationMs(method, params);
  return Math.max(
    defaultTimeout,
    Math.min(
      60 * 60 * 1000,
      Math.floor(Math.max(requested, longPoll, estimated) + 5_000)
    )
  );
}

function estimateGuestOperationMs(
  method: string,
  params: Record<string, unknown>
): number {
  if (method === "mouse_move" || method === "mouse_drag") {
    return finiteNonnegative(params["duration_ms"]);
  }
  if (method === "mouse_click") {
    const clicks = finiteNonnegative(params["click_count"]) || 1;
    const interval = finiteNonnegative(params["interval_ms"]);
    return Math.max(0, clicks - 1) * interval;
  }
  if (method === "keyboard_type") {
    const text = typeof params["text"] === "string" ? params["text"] : "";
    const interval =
      typeof params["interval_ms"] === "number"
        ? finiteNonnegative(params["interval_ms"])
        : 10;
    return text.length * interval;
  }
  if (method !== "input_batch" || !Array.isArray(params["actions"])) {
    return 0;
  }
  let total = 0;
  for (const value of params["actions"]) {
    if (!isRecord(value) || typeof value["type"] !== "string") {
      continue;
    }
    const type = value["type"];
    if (type === "delay") {
      total += finiteNonnegative(value["milliseconds"]);
    } else if (type === "mouse_move" || type === "mouse_drag") {
      total +=
        typeof value["duration_ms"] === "number"
          ? finiteNonnegative(value["duration_ms"])
          : type === "mouse_drag"
            ? 500
            : 0;
    } else if (type === "mouse_click") {
      const clicks =
        typeof value["click_count"] === "number"
          ? finiteNonnegative(value["click_count"])
          : 1;
      const interval =
        typeof value["interval_ms"] === "number"
          ? finiteNonnegative(value["interval_ms"])
          : 100;
      total += Math.max(0, clicks - 1) * interval;
    } else if (type === "keyboard_type") {
      const text = typeof value["text"] === "string" ? value["text"] : "";
      const interval =
        typeof value["interval_ms"] === "number"
          ? finiteNonnegative(value["interval_ms"])
          : 10;
      total += text.length * interval;
    }
  }
  return total;
}

function finiteNonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function errorCode(error: unknown): string {
  const message = errorMessage(error);
  return message.split(":", 1)[0] || "BROKER_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remediationForCode(code: string): string | undefined {
  if (code === "CHARACTER_NOT_REPRESENTABLE") {
    return "Use clipboard_set followed by Ctrl+V, or type text supported by the guest code page.";
  }
  if (code === "NEEDS_ATTENTION") {
    return "Inspect the attached screenshot and continue with mouse or keyboard tools.";
  }
  return undefined;
}

function addUnlockReminder(data: unknown): unknown {
  if (isRecord(data)) {
    return { ...data, unlockReminder: UNLOCK_REMINDER };
  }
  return { value: data, unlockReminder: UNLOCK_REMINDER };
}

function publicArtifact(artifact: StoredArtifact): Omit<StoredArtifact, "path"> {
  const { path: _path, ...safe } = artifact;
  return safe;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isBrokerConfig(
  value: BrokerConfig | LoadBrokerConfigOptions
): value is BrokerConfig {
  return "guestPort" in value && "pipePath" in value;
}

export function connectToBrokerPipe(pipePath: string): Socket {
  return createConnection(pipePath);
}
