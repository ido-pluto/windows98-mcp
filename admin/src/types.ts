export interface BrokerStatus {
  broker: { pipePath: string; guestPort: number; lockingEnabled?: boolean };
  connection: { state: "online" | "offline" | string; connectedAt?: string; remoteAddress?: string; guestBuildId?: string };
  lease?: { held: boolean; expiresAt?: string; lockingEnabled?: boolean };
}

export interface BrokerReply<T = unknown> {
  ok: boolean;
  result?: { data?: T; code?: string; message?: string };
  image?: { mimeType: string; data: string };
  error?: { code?: string; message?: string } | string;
}
