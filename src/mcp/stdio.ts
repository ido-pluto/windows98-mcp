import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";
import {
  BrokerClient,
  type BrokerClientOptions
} from "./broker-client.js";
import { createMcpServer } from "./server.js";

export interface StdioMcpOptions extends BrokerClientOptions {
  stdin?: Readable;
  stdout?: Writable;
  onClose?: () => void;
}

/**
 * Start one stdio MCP adapter session. The broker connection is lazy so MCP
 * initialization and tool discovery remain available while the broker or guest
 * is offline; the first tool call reports a structured connectivity error.
 */
export async function startStdioMcp(
  options: StdioMcpOptions = {}
): Promise<void> {
  const client = new BrokerClient(options);
  const server = createMcpServer(client);
  const transport = new StdioServerTransport(
    options.stdin ?? process.stdin,
    options.stdout ?? process.stdout
  );

  server.server.onclose = () => {
    // EOF is deliberate, unlike a dropped broker socket. Release any
    // terminal, transfer, and held-input state immediately instead of leaving
    // it resumable for the transport-loss grace period.
    void client.close({ cleanup: true });
    options.onClose?.();
  };
  server.server.onerror = (error) => {
    process.stderr.write(`[win98-mcp] ${error.message}\n`);
  };

  await server.connect(transport);
}
