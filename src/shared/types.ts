export const PROTOCOL_MAGIC = "W98M";
export const PROTOCOL_VERSION = 2;
export const FRAME_HEADER_BYTES = 28;
/** Protocol v2 has no authentication trailer. CRC/SHA-256 remain in transfer payloads. */
export const FRAME_MAC_BYTES = 0;
export const MAX_CONTROL_PAYLOAD = 1024 * 1024;
export const MAX_DATA_PAYLOAD = 64 * 1024;
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_WAIT_TICKET_TTL_MS = 10 * 60 * 1000;
export const UNLOCK_REMINDER =
  "VM remains locked by this session; call vm_unlock when finished.";

export enum FrameType {
  Hello = 1,
  Ready = 2,
  Request = 10,
  Response = 11,
  Event = 12,
  Data = 13,
  Cancel = 14,
  Ping = 20,
  Pong = 21,
  Error = 255
}

export interface FrameHeader {
  version: number;
  type: FrameType;
  flags: number;
  streamId: number;
  sequence: bigint;
  payloadLength: number;
}

export interface DecodedFrame {
  header: FrameHeader;
  payload: Buffer;
  mac: Buffer;
}

export interface GuestCapabilities {
  guestId: string;
  guestBuildId: string;
  protocolVersion: number;
  osName: string;
  osVersion: string;
  ansiCodePage: number;
  oemCodePage: number;
  screenWidth: number;
  screenHeight: number;
  colorDepth: number;
  supportsLongFileNames: boolean;
  supportsMouseWheel: boolean;
  maxPath: number;
  maxFileBytes: number;
  commands: string[];
}

export type ConnectionState =
  | "offline"
  | "connecting"
  | "online"
  | "sanitizing";

export interface ConnectionSnapshot {
  state: ConnectionState;
  epoch: number;
  connectedAt?: string;
  lastSeenAt?: string;
  /** Why the last guest connection went offline, when known. */
  offlineReason?: string;
  guestBuildId?: string;
  remoteAddress?: string;
}

export interface LeaseSnapshot {
  held: boolean;
  heldByCaller: boolean;
  ownerLabel?: string;
  acquiredAt?: string;
  lastActivityAt?: string;
  expiresAt?: string;
  reminder?: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  code: string;
  message: string;
  requestId: string;
  connection: ConnectionSnapshot;
  lease: LeaseSnapshot;
  retryable: boolean;
  /** Present when an MCP request was replayed after adapter/broker recovery. */
  recovery?: { replayed: boolean; attempts: number };
  remediation?: string;
  data?: T;
}

export interface BrokerRequest {
  kind: "broker_request";
  id: string;
  sessionId: string;
  sessionLabel: string;
  method: string;
  params: Record<string, unknown>;
}

export interface BrokerResponse {
  kind: "broker_response";
  id: string;
  result: ToolResult;
  image?: {
    mimeType: "image/png";
    data: string;
  };
}

export interface BrokerHello {
  kind: "broker_hello";
  sessionId: string;
  sessionLabel: string;
}

export interface GuestRequest {
  kind: "request";
  requestId: string;
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
}

export interface GuestResponse {
  kind: "response";
  requestId: string;
  ok: boolean;
  code: string;
  message: string;
  data?: unknown;
}

export interface WaitTicket {
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MouseButton = "left" | "right" | "middle";
export type KeyAction = "down" | "up" | "press";
