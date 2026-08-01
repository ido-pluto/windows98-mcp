import { invoke } from "@tauri-apps/api/core";
import type { BrokerReply, BrokerStatus } from "./types";

export async function request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const reply = await invoke<BrokerReply<T>>("broker_request", { method, params });
  if (!reply.ok) throw new Error(typeof reply.error === "string" ? reply.error : reply.error?.message ?? "Broker request failed");
  return reply.result?.data as T;
}

export async function requestWithImage<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<BrokerReply<T>> {
  const reply = await invoke<BrokerReply<T>>("broker_request", { method, params });
  if (!reply.ok) throw new Error(typeof reply.error === "string" ? reply.error : reply.error?.message ?? "Broker request failed");
  return reply;
}

export const status = () => request<BrokerStatus>("vm_status");
export const testConnection = () => invoke<BrokerStatus>("wait_for_guest");
export const showMessage = (message: string) => request("show_message", { message });
export const agentDiagnostics = () => request<{
  agentLogPath?: string;
  crashLogPath?: string;
  supervisorLogPath?: string;
  supervisorState?: string;
  lastCrash?: string;
}>("agent_diagnostics");
