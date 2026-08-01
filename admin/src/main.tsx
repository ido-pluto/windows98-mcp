import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { agentDiagnostics, request, requestWithImage, showMessage, status, testConnection } from "./broker";
import type { BrokerStatus } from "./types";
import "./styles.css";

type Settings = { port: number; brokerHost: string; brokerPort: number; lockingEnabled: boolean; upstreamEnabled: boolean; upstreamHost: string; upstreamPort: number };
type HostAddress = { name: string; address: string; netmask: string; virtual: boolean };
type GuestEntry = { name: string; isDirectory: boolean; size?: number };
type AgentSession = { sessionId: string; label: string; connectedAt: string; current: boolean; holdsLease: boolean; resources: string[] };
type PickerMode = "upload-destination" | "download-file" | "download-directory";
type TransferProgress = { direction: string; files: number; directories: number; bytes: number; chunks: number; totalBytes?: number; totalFiles?: number; currentPath?: string; startedAt: number };

const defaultSettings: Settings = { port: 9898, brokerHost: "127.0.0.1", brokerPort: 9899, lockingEnabled: false, upstreamEnabled: false, upstreamHost: "", upstreamPort: 9898 };
const asText = (value: unknown) => JSON.stringify(value, null, 2);
const parentPath = (path: string) => path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "") || "C:\\";
const childPath = (path: string, name: string) => `${path.replace(/[\\/]+$/, "")}\\${name}`;
const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const formatDuration = (seconds: number) => seconds < 60 ? `${Math.ceil(seconds)} sec` : `${Math.floor(seconds / 60)} min ${Math.ceil(seconds % 60)} sec`;

function App() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [connection, setConnection] = useState<BrokerStatus>();
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [notice, setNotice] = useState("Starting broker…");
  const [addresses, setAddresses] = useState<HostAddress[]>([]);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("ver");
  const [terminal, setTerminal] = useState("");
  const [shellId, setShellId] = useState<string>();
  const [transferActive, setTransferActive] = useState(false);
  const [transferProgress, setTransferProgress] = useState<TransferProgress>();
  const [uploadPath, setUploadPath] = useState("");
  const [uploadDirectory, setUploadDirectory] = useState(false);
  const [uploadGuestPath, setUploadGuestPath] = useState("C:\\MCPTEST\\");
  const [downloadGuestPath, setDownloadGuestPath] = useState("C:\\MCPTEST\\");
  const [downloadPath, setDownloadPath] = useState("");
  const [downloadDirectory, setDownloadDirectory] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [shot, setShot] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<Awaited<ReturnType<typeof agentDiagnostics>>>();
  const [pickerMode, setPickerMode] = useState<PickerMode>();
  const [pickerPath, setPickerPath] = useState("C:\\");
  const [pickerEntries, setPickerEntries] = useState<GuestEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [nextConnection, agentData] = await Promise.all([
        status(),
        request<{ sessions?: AgentSession[] }>("broker_sessions")
      ]);
      setConnection(nextConnection);
      setAgentSessions(agentData.sessions ?? []);
      setNotice("Ready");
    }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }, []);

  const refreshAddresses = useCallback(async () => {
    try {
      const network = await request<{ addresses?: HostAddress[] }>("host_network_info");
      const values = network.addresses ?? [];
      setAddresses(values);
      setSelectedAddress((current) => current || values[0]?.address || "");
    } catch { /* The broker may still be starting. */ }
  }, []);

  useEffect(() => {
    void (async () => {
      const saved = await invoke<Settings>("get_settings");
      setSettings(saved);
      await invoke("start_broker", { settings: saved });
      await Promise.all([refresh(), refreshAddresses()]);
    })();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshAddresses]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<Omit<TransferProgress, "startedAt">>("transfer-progress", (event) => setTransferProgress((current) => ({ ...event.payload, startedAt: current?.startedAt ?? Date.now() }))).then((stop) => { unlisten = stop; });
    return () => unlisten?.();
  }, []);

  const proxyConnected = settings.upstreamEnabled && connection?.connection.state === "online";
  // In transparent proxy mode the upstream broker owns the VM protocol. Local
  // controls are intentionally disabled so two brokers never issue frames on
  // the same guest connection; operate it from the remote machine instead.
  const guestOnline = connection?.connection.state === "online" && !settings.upstreamEnabled;
  const connectionText = useMemo(() => settings.upstreamEnabled ? (proxyConnected ? "Proxy connected" : "Proxy connecting") : guestOnline ? "Guest online" : "Waiting for guest", [guestOnline, proxyConnected, settings.upstreamEnabled]);

  async function releaseVm() { try { await request("vm_unlock"); } catch { /* Preserve the primary result. */ } }
  async function applySettings() {
    if (!settings.brokerHost.trim()) { setNotice("Set a broker host or IP address."); return; }
    if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535 || !Number.isInteger(settings.brokerPort) || settings.brokerPort < 1 || settings.brokerPort > 65535 || !Number.isInteger(settings.upstreamPort) || settings.upstreamPort < 1 || settings.upstreamPort > 65535) { setNotice("Ports must be between 1 and 65535."); return; }
    if (settings.upstreamEnabled && !settings.upstreamHost.trim()) { setNotice("Set the remote broker IP before enabling proxy."); return; }
    if (shellId || transferActive) { setNotice("Close active terminal or transfer work before changing connection settings."); return; }
    if (settings.lockingEnabled && connection?.lease?.lockingEnabled === false && !window.confirm("Enable exclusive locking? Other agents will wait behind the current lease owner.")) return;
    try { await invoke("save_settings", { settings }); await invoke("restart_broker", { settings }); setNotice(settings.upstreamEnabled ? `Connecting to ${settings.upstreamHost}:${settings.upstreamPort}…` : `Connected to broker ${settings.brokerHost}:${settings.brokerPort}.`); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }
  async function disconnectAgent(agent: AgentSession) {
    if (!window.confirm(`Disconnect ${agent.label}? Any exclusive VM lease it owns will be cleaned up and released.`)) return;
    try {
      await request("broker_disconnect_session", { session_id: agent.sessionId });
      setNotice(`Disconnect requested for ${agent.label}.`);
      window.setTimeout(() => void refresh(), 250);
    } catch (error) { setNotice(String(error)); }
  }
  async function sendMessage() { if (!message.trim()) return; try { await showMessage(message); setMessage(""); setNotice("Message sent to Windows 98."); } catch (error) { setNotice(String(error)); } finally { await releaseVm(); } }
  async function runCommand() {
    let activeId: string | undefined;
    try {
      const started = await request<{ sessionId?: string; session_id?: string }>("shell_start", { command });
      activeId = started.sessionId ?? started.session_id;
      if (!activeId) throw new Error("The broker did not return a terminal session ID.");
      setShellId(activeId); setTerminal(""); setNotice("Command started.");
      let cursor = 0;
      for (let i = 0; i < 300; i++) {
        const read = await request<{ text?: string; combined?: string; cursor?: number; exited?: boolean; running?: boolean; exitCode?: number }>("shell_read", { session_id: activeId, after_cursor: cursor, wait_ms: 500, max_bytes: 65536 });
        const output = read.combined ?? read.text;
        if (output) setTerminal((old) => old + output);
        cursor = read.cursor ?? cursor;
        // The Windows 98 agent returns `combined` plus `running`; the
        // simulator's legacy result also supports `text` plus `exited`.
        if (read.exited === true || read.running === false) { await request("shell_close", { session_id: activeId }); activeId = undefined; setShellId(undefined); await releaseVm(); setNotice(`Command exited (${read.exitCode ?? "unknown"}).`); break; }
      }
    } catch (error) { if (activeId) { try { await request("shell_terminate", { session_id: activeId }); await request("shell_close", { session_id: activeId }); } catch { /* Best effort. */ } } setShellId(undefined); await releaseVm(); setNotice(String(error)); }
  }
  async function stopCommand() { if (!shellId) return; try { await request("shell_terminate", { session_id: shellId }); await request("shell_close", { session_id: shellId }); setShellId(undefined); setNotice("Command terminated."); } catch (error) { setNotice(String(error)); } finally { await releaseVm(); } }
  async function chooseUpload(directory: boolean) { const selection = await open({ directory, multiple: false }); if (typeof selection === "string") { setUploadPath(selection); setUploadDirectory(directory); } }
  async function chooseDownload(directory: boolean) { const selection = directory ? await open({ directory: true, multiple: false }) : await save({ defaultPath: downloadGuestPath.split(/[\\/]/).pop() || "download" }); if (typeof selection === "string") { setDownloadPath(selection); setDownloadDirectory(directory); } }
  async function transfer(direction: "push" | "pull", directory: boolean) {
    const hostPath = direction === "push" ? uploadPath : downloadPath;
    const sourceName = uploadPath.split(/[\\/]/).filter(Boolean).pop();
    const guestPath = direction === "push"
      ? directory ? uploadGuestPath : sourceName ? childPath(uploadGuestPath, sourceName) : uploadGuestPath
      : downloadGuestPath;
    if (!hostPath || !guestPath) { setNotice("Select both the local and Windows 98 locations first."); return; }
    setTransferProgress({ direction: direction === "push" ? "host-to-guest" : "guest-to-host", files: 0, directories: 0, bytes: 0, chunks: 0, currentPath: direction === "push" ? hostPath : guestPath, startedAt: Date.now() });
    setTransferActive(true);
    // Let React paint the progress area before the broker operation starts.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await invoke("client_transfer", {
        method: `${directory ? "directory" : "file"}_${direction}`,
        params: direction === "push"
          ? { host_path: hostPath, guest_path: guestPath, overwrite }
          : { guest_path: guestPath, host_path: hostPath, overwrite }
      });
      setNotice(`${directory ? "Directory" : "File"} ${direction} completed.`);
    }
    catch (error) { setNotice(String(error)); }
    finally { setTransferActive(false); setTransferProgress(undefined); await releaseVm(); }
  }
  async function browseGuest(path = pickerPath) { try { const result = await request<{ entries?: GuestEntry[] }>("fs_list", { path, recursive: false }); setPickerPath(path); setPickerEntries((result.entries ?? []).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))); } catch (error) { setNotice(String(error)); } finally { await releaseVm(); } }
  function openGuestPicker(mode: PickerMode) { setPickerMode(mode); void browseGuest(mode === "upload-destination" ? uploadGuestPath : downloadGuestPath); }
  function selectGuestPath(path: string) { if (pickerMode === "upload-destination") setUploadGuestPath(path); else setDownloadGuestPath(path); setPickerMode(undefined); }
  async function capture() { try { const result = await requestWithImage("screen_capture"); const data = result.image?.data; if (!data) throw new Error("The broker did not return screenshot data."); setShot(`data:image/png;base64,${data}`); setNotice("Screenshot captured."); } catch (error) { setNotice(String(error)); } finally { await releaseVm(); } }
  async function saveShot() { if (!shot) return; const path = await save({ defaultPath: "win98-screenshot.png", filters: [{ name: "PNG", extensions: ["png"] }] }); if (path) { await invoke("save_base64_png", { path, dataUrl: shot }); setNotice(`Saved ${path}`); } }
  async function refreshDiagnostics() { try { setDiagnostics(await agentDiagnostics()); setNotice("Recovery diagnostics refreshed."); } catch (error) { setNotice(String(error)); } }

  const transferRate = transferProgress && transferProgress.bytes > 0 ? transferProgress.bytes / Math.max((Date.now() - transferProgress.startedAt) / 1000, 0.001) : 0;
  const eta = transferProgress?.totalBytes !== undefined && transferRate > 0 ? Math.max(0, transferProgress.totalBytes - transferProgress.bytes) / transferRate : undefined;

  return <main className="win98">
    <p className="statusline"><b>{connectionText}</b> — {settings.upstreamEnabled && proxyConnected ? "Proxy is active. Use MCP or the admin app on the remote machine to control the VM." : notice}</p>
    <fieldset><legend>Broker and VM connection</legend><div className="form-grid"><label>Broker host / IP <input value={settings.brokerHost} onChange={(e) => setSettings({ ...settings, brokerHost: e.target.value })} placeholder="127.0.0.1" /></label><label>Broker control port <input type="number" min="1" max="65535" value={settings.brokerPort} onChange={(e) => setSettings({ ...settings, brokerPort: Number(e.target.value) })} /></label><label>Guest listener port <input type="number" min="1" max="65535" value={settings.port} onChange={(e) => setSettings({ ...settings, port: Number(e.target.value) })} /></label><button disabled={!!shellId || transferActive} onClick={() => void applySettings()}>Apply</button><button onClick={() => void testConnection().then(setConnection).catch((e) => setNotice(String(e)))}>Wait / test</button><label className="check"><input type="checkbox" checked={settings.lockingEnabled} onChange={(e) => setSettings({ ...settings, lockingEnabled: e.target.checked })} /> Exclusive lock agents (off by default)</label><label className="check"><input type="checkbox" checked={settings.upstreamEnabled} onChange={(e) => setSettings({ ...settings, upstreamEnabled: e.target.checked })} /> Proxy upward to remote broker</label><label>Remote broker IP <input disabled={!settings.upstreamEnabled} value={settings.upstreamHost} onChange={(e) => setSettings({ ...settings, upstreamHost: e.target.value })} placeholder="192.168.1.50" /></label><label>Remote broker port <input disabled={!settings.upstreamEnabled} type="number" min="1" max="65535" value={settings.upstreamPort} onChange={(e) => setSettings({ ...settings, upstreamPort: Number(e.target.value) })} /></label></div><dl><dt>Broker endpoint</dt><dd>{settings.brokerHost}:{settings.brokerPort}</dd><dt>VM address</dt><dd>{connection?.connection.remoteAddress ?? "not connected"}</dd><dt>Build</dt><dd>{connection?.connection.guestBuildId ?? "—"}</dd><dt>Exclusive locking</dt><dd>{connection?.lease?.lockingEnabled === false ? "Disabled — FIFO guest queue is active; input may collide" : "Enabled"}</dd></dl></fieldset>
    <fieldset><legend>Connected agents</legend><p>Disconnecting an agent closes its MCP/admin connection. In exclusive mode, an owner is sanitized and its lease is released automatically.</p><div className="agent-list">{agentSessions.length ? agentSessions.map((agent) => <div className="agent" key={agent.sessionId}><span><b>{agent.label}</b>{agent.current ? " (this admin)" : ""}{agent.holdsLease ? " — holds VM lease" : ""}<small>{agent.resources.length ? ` Resources: ${agent.resources.join(", ")}` : " No active resources"}</small></span><button disabled={agent.current} onClick={() => void disconnectAgent(agent)}>Disconnect</button></div>) : <span>No connected agents.</span>}</div></fieldset>
    <fieldset><legend>Host IP for VMware / QEMU</legend><div className="ip-list">{addresses.length ? addresses.map((address) => <label key={`${address.name}-${address.address}`} className="radio"><input type="radio" checked={selectedAddress === address.address} onChange={() => setSelectedAddress(address.address)} /> <b>{address.address}</b> — {address.name}{address.virtual ? " (virtual adapter)" : ""}</label>) : <span>No active IPv4 address found.</span>}</div><div className="ini">host={selectedAddress || "<select an address>"}{"\n"}port={settings.port}</div></fieldset>
    <fieldset><legend>Message</legend><textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message for Windows 98" /><button disabled={!guestOnline} onClick={() => void sendMessage()}>Show message</button></fieldset>
    <fieldset><legend>Remote terminal</legend><div className="row"><input value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Command" /><button disabled={!guestOnline || !!shellId} onClick={() => void runCommand()}>Run</button><button disabled={!shellId} onClick={() => void stopCommand()}>Terminate</button></div><pre>{terminal || "Output will stream here."}</pre></fieldset>
    <fieldset><legend>Files and directories</legend><div className="transfer-grid"><div><b>Upload to Windows 98</b><div className="row"><input readOnly value={uploadPath} placeholder="Select a local file or folder" /><button onClick={() => void chooseUpload(false)}>File…</button><button onClick={() => void chooseUpload(true)}>Folder…</button></div><div className="row"><input value={uploadGuestPath} onChange={(e) => setUploadGuestPath(e.target.value)} placeholder="Guest destination folder" /><button disabled={!guestOnline || transferActive} onClick={() => openGuestPicker("upload-destination")}>Browse guest…</button></div><button disabled={!guestOnline || !uploadPath || transferActive} onClick={() => void transfer("push", uploadDirectory)}>Upload {uploadDirectory ? "folder" : "file"}</button></div><div><b>Download from Windows 98</b><div className="row"><input value={downloadGuestPath} onChange={(e) => setDownloadGuestPath(e.target.value)} /><button disabled={!guestOnline || transferActive} onClick={() => openGuestPicker(downloadDirectory ? "download-directory" : "download-file")}>Browse guest…</button></div><div className="row"><input readOnly value={downloadPath} placeholder="Select a local destination" /><button onClick={() => void chooseDownload(false)}>Save file…</button><button onClick={() => void chooseDownload(true)}>Folder…</button></div><button disabled={!guestOnline || !downloadPath || transferActive} onClick={() => void transfer("pull", downloadDirectory)}>Download {downloadDirectory ? "folder" : "file"}</button></div></div>{transferProgress && <div className="transfer-progress"><b>{transferProgress.direction === "host-to-guest" ? "Uploading" : "Downloading"}</b><progress max={transferProgress.totalBytes ?? undefined} value={transferProgress.totalBytes ? transferProgress.bytes : undefined} /><span>{formatBytes(transferProgress.bytes)}{transferProgress.totalBytes !== undefined ? ` / ${formatBytes(transferProgress.totalBytes)}` : ""} · {transferProgress.files}{transferProgress.totalFiles !== undefined ? ` / ${transferProgress.totalFiles}` : ""} files</span><span>{transferRate ? `${formatBytes(transferRate)}/sec${eta !== undefined ? ` · about ${formatDuration(eta)} remaining` : ""}` : "Calculating speed…"}</span><small>{transferProgress.currentPath ?? "Preparing transfer…"}</small></div>}<label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite existing files</label></fieldset>
    <fieldset><legend>Screen</legend><button disabled={!guestOnline} onClick={() => void capture()}>Capture screenshot</button><button disabled={!shot} onClick={() => void saveShot()}>Save PNG…</button><button disabled={!shot} onClick={() => setShot(undefined)}>Clear screenshot</button>{shot ? <img className="screenshot" src={shot} alt="Windows 98 screenshot" /> : <p>No screenshot captured.</p>}</fieldset>
    <fieldset><legend>Agent recovery</legend><p>WIN98SUP restarts WIN98CTL after unexpected exits and only dismisses confirmed WIN98CTL fault dialogs.</p><button disabled={!guestOnline} onClick={() => void refreshDiagnostics()}>Refresh diagnostics</button>{diagnostics ? <pre>{asText(diagnostics)}</pre> : <p>No diagnostics loaded.</p>}</fieldset>
    <details><summary>Broker status</summary><pre>{asText(connection ?? {})}</pre></details>
    {pickerMode && <div className="modal"><section className="picker"><header className="titlebar"><strong>Select Windows 98 {pickerMode === "download-file" ? "file" : "folder"}</strong></header><div className="row"><input value={pickerPath} onChange={(e) => setPickerPath(e.target.value)} /><button onClick={() => void browseGuest()}>Go</button><button onClick={() => void browseGuest(parentPath(pickerPath))}>Up</button></div><div className="entries"><button className="entry" onDoubleClick={() => void browseGuest(parentPath(pickerPath))}>📁 ..</button>{pickerEntries.map((entry) => <button key={entry.name} className="entry" onDoubleClick={() => entry.isDirectory ? void browseGuest(childPath(pickerPath, entry.name)) : pickerMode === "download-file" ? selectGuestPath(childPath(pickerPath, entry.name)) : undefined} onClick={() => !entry.isDirectory && pickerMode === "download-file" ? selectGuestPath(childPath(pickerPath, entry.name)) : undefined}>{entry.isDirectory ? "📁" : "📄"} {entry.name}</button>)}</div><div className="row"><button onClick={() => selectGuestPath(pickerPath)} disabled={pickerMode === "download-file"}>Select this folder</button><button onClick={() => setPickerMode(undefined)}>Cancel</button></div></section></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
