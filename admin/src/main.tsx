import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { request, requestWithImage, showMessage, status, testConnection } from "./broker";
import type { BrokerStatus } from "./types";
import "./styles.css";

const asText = (value: unknown) => JSON.stringify(value, null, 2);

function App() {
  const [port, setPort] = useState(9898);
  const [connection, setConnection] = useState<BrokerStatus>();
  const [notice, setNotice] = useState("Starting broker…");
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("ver");
  const [terminal, setTerminal] = useState("");
  const [shellId, setShellId] = useState<string>();
  const [guestPath, setGuestPath] = useState("C:\\MCPTEST\\");
  const [hostPath, setHostPath] = useState("");
  const [shot, setShot] = useState<string>();

  const refresh = useCallback(async () => {
    try { setConnection(await status()); setNotice("Ready"); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }, []);

  useEffect(() => {
    void (async () => {
      const saved = await invoke<number>("get_port");
      setPort(saved);
      await invoke("start_broker", { port: saved });
      await refresh();
    })();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const guestOnline = connection?.connection.state === "online";
  const connectionText = useMemo(() => guestOnline ? "Guest online" : "Waiting for guest", [guestOnline]);

  async function releaseVm() {
    try { await request("vm_unlock"); } catch { /* A resource may still need cleanup; preserve the useful action error. */ }
  }

  async function applyPort() {
    const nextPort = Number(port);
    if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) { setNotice("Port must be between 1 and 65535."); return; }
    try { await invoke("save_port", { port: nextPort }); await invoke("restart_broker", { port: nextPort }); setNotice(`Listening on port ${nextPort}.`); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function sendMessage() {
    if (!message.trim()) return;
    try { await showMessage(message); setMessage(""); setNotice("Message sent to Windows 98."); }
    catch (error) { setNotice(String(error)); }
    finally { await releaseVm(); }
  }

  async function runCommand() {
    let activeId: string | undefined;
    try {
      const started = await request<{ sessionId?: string; session_id?: string }>("shell_start", { command });
      activeId = started.sessionId ?? started.session_id;
      if (!activeId) throw new Error("The broker did not return a terminal session ID.");
      setShellId(activeId); setTerminal(""); setNotice("Command started.");
      let cursor: number | undefined;
      for (let i = 0; i < 300; i++) {
        const read = await request<{ text?: string; cursor?: number; exited?: boolean; exitCode?: number }>("shell_read", { session_id: activeId, after_cursor: cursor, wait_ms: 500, max_bytes: 65536 });
        if (read.text) setTerminal((old) => old + read.text);
        cursor = read.cursor;
        if (read.exited) { await request("shell_close", { session_id: activeId }); activeId = undefined; setShellId(undefined); await releaseVm(); setNotice(`Command exited (${read.exitCode ?? "unknown"}).`); break; }
      }
    } catch (error) {
      if (activeId) { try { await request("shell_terminate", { session_id: activeId }); await request("shell_close", { session_id: activeId }); } catch { /* Best-effort cleanup. */ } }
      setShellId(undefined); await releaseVm(); setNotice(String(error));
    }
  }

  async function stopCommand() {
    if (!shellId) return;
    try { await request("shell_terminate", { session_id: shellId }); await request("shell_close", { session_id: shellId }); setShellId(undefined); await releaseVm(); setNotice("Command terminated."); }
    catch (error) { setNotice(String(error)); }
  }

  async function chooseHostPath(directory = false) {
    const selection = await open({ directory, multiple: false });
    if (typeof selection === "string") setHostPath(selection);
  }

  async function transfer(direction: "push" | "pull", directory = false) {
    if (!hostPath || !guestPath) { setNotice("Choose a host path and set a guest path first."); return; }
    const method = directory ? `directory_${direction}` : `file_${direction}`;
    try {
      await request(method, direction === "push" ? { host_path: hostPath, guest_path: guestPath, overwrite: false } : { guest_path: guestPath, host_path: hostPath, overwrite: false });
      setNotice(`${directory ? "Directory" : "File"} ${direction} completed.`);
    } catch (error) { setNotice(String(error)); }
    finally { await releaseVm(); }
  }

  async function capture() {
    try {
      const result = await requestWithImage("screen_capture");
      const data = result.image?.data;
      if (!data) throw new Error("The broker did not return screenshot data.");
      setShot(`data:image/png;base64,${data}`); setNotice("Screenshot captured.");
    } catch (error) { setNotice(String(error)); }
    finally { await releaseVm(); }
  }

  async function saveShot() {
    if (!shot) return;
    const path = await save({ defaultPath: "win98-screenshot.png", filters: [{ name: "PNG", extensions: ["png"] }] });
    if (path) { await invoke("save_base64_png", { path, dataUrl: shot }); setNotice(`Saved ${path}`); }
  }

  return <main>
    <header><div><h1>Windows 98 MCP Admin</h1><p>{notice}</p></div><span className={guestOnline ? "pill online" : "pill"}>{connectionText}</span></header>
    <section className="card connection"><h2>Connection</h2><label>Guest listener port <input type="number" min="1" max="65535" value={port} onChange={(e) => setPort(Number(e.target.value))} /></label><button onClick={() => void applyPort()}>Apply port</button><button className="secondary" onClick={() => void testConnection().then(setConnection).catch((e) => setNotice(String(e)))}>Wait / test (5s)</button><dl><dt>Pipe</dt><dd>{connection?.broker.pipePath ?? "—"}</dd><dt>Guest</dt><dd>{connection?.connection.remoteAddress ?? "not connected"}</dd><dt>Build</dt><dd>{connection?.connection.guestBuildId ?? "—"}</dd><dt>Connected</dt><dd>{connection?.connection.connectedAt ?? "—"}</dd></dl></section>
    <section className="card"><h2>Message</h2><p>Displays a Windows 98 message box titled “Windows 98 Remote Control”.</p><textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message for Windows 98" /><button disabled={!guestOnline} onClick={() => void sendMessage()}>Show message</button></section>
    <section className="card"><h2>Remote terminal</h2><div className="row"><input value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Command" /><button disabled={!guestOnline || !!shellId} onClick={() => void runCommand()}>Run</button><button className="danger" disabled={!shellId} onClick={() => void stopCommand()}>Terminate</button></div><pre>{terminal || "Output will stream here."}</pre></section>
    <section className="card"><h2>Files and directories</h2><div className="row"><input value={hostPath} onChange={(e) => setHostPath(e.target.value)} placeholder="Host file or directory" /><button className="secondary" onClick={() => void chooseHostPath(false)}>File…</button><button className="secondary" onClick={() => void chooseHostPath(true)}>Folder…</button></div><input value={guestPath} onChange={(e) => setGuestPath(e.target.value)} placeholder="Guest path" /><div className="row"><button disabled={!guestOnline} onClick={() => void transfer("push")}>Push file</button><button disabled={!guestOnline} onClick={() => void transfer("pull")}>Pull file</button><button disabled={!guestOnline} onClick={() => void transfer("push", true)}>Push directory</button><button disabled={!guestOnline} onClick={() => void transfer("pull", true)}>Pull directory</button></div></section>
    <section className="card"><h2>Screen</h2><button disabled={!guestOnline} onClick={() => void capture()}>Capture screenshot</button><button className="secondary" disabled={!shot} onClick={() => void saveShot()}>Save PNG…</button>{shot ? <img className="screenshot" src={shot} alt="Windows 98 screenshot" /> : <p>No screenshot captured.</p>}</section>
    <details><summary>Broker status</summary><pre>{asText(connection ?? {})}</pre></details>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
