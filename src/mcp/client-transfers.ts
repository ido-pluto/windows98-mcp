import {
  TransferCoordinator,
  type TransferProgress
} from "../host/transfers.js";
import type { GuestResponse } from "../shared/types.js";
import { BrokerClient } from "./broker-client.js";

/**
 * Runs file and directory transfers on the machine that runs the MCP/admin
 * client. The broker only transports the guest-side primitive calls, so a
 * TCP-connected Mac never asks a Windows broker to open a macOS path.
 */
export class ClientTransferRunner {
  private readonly transfers: TransferCoordinator;

  constructor(
    private readonly client: BrokerClient,
    onProgress: (progress: TransferProgress) => void = () => undefined
  ) {
    this.transfers = new TransferCoordinator(
      async (_sessionId, method, params, timeoutMs) =>
        toGuestResponse(await client.request(method, params, { timeoutMs })),
      () => undefined,
      () => undefined,
      10 * 60 * 1_000,
      (_sessionId, progress) => onProgress(progress)
    );
  }

  async execute(
    method: string,
    params: Record<string, unknown>
  ): Promise<TransferProgress> {
    return await this.transfers.execute(this.client.sessionId, method, params);
  }

  async abort(): Promise<void> {
    await this.transfers.abortSession(this.client.sessionId);
  }
}

function toGuestResponse(response: Awaited<ReturnType<BrokerClient["request"]>>): GuestResponse {
  return {
    kind: "response",
    requestId: response.id,
    ok: response.result.ok,
    code: response.result.code,
    message: response.result.message,
    data: response.result.data
  };
}
