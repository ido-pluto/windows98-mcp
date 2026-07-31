#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, Command}, sync::Mutex, time::{Duration, Instant}};
#[cfg(windows)] use std::fs::{File, OpenOptions};
#[cfg(unix)] use std::os::unix::net::UnixStream;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const DEFAULT_PORT: u16 = 9898;

#[cfg(windows)] type LocalStream = File;
#[cfg(unix)] type LocalStream = UnixStream;

struct PipeClient {
    session_id: String,
    writer: LocalStream,
    reader: BufReader<LocalStream>,
}
struct AppState { child: Mutex<Option<Child>>, client: Mutex<Option<PipeClient>>, active_port: Mutex<u16> }

#[derive(Serialize, Deserialize)]
struct Settings { port: u16 }

#[derive(Serialize)]
struct Reply { ok: bool, #[serde(skip_serializing_if = "Option::is_none")] result: Option<Value>, #[serde(skip_serializing_if = "Option::is_none")] image: Option<Value>, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> }

// This is deliberately the exact host runtime file.  The npm MCP adapter and
// the admin app must select the same listener port without a second setting.
fn settings_path() -> Result<PathBuf, String> {
    let root = dirs::data_local_dir().ok_or("Cannot determine local app-data directory")?.join("win98-mcp");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.join("runtime.json"))
}
fn read_settings() -> Settings { settings_path().ok().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Settings { port: DEFAULT_PORT }) }
fn write_settings(port: u16) -> Result<(), String> { fs::write(settings_path()?, serde_json::to_string_pretty(&Settings { port }).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) }

fn sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("WIN98_MCP_BROKER_SIDECAR") { return Ok(PathBuf::from(path)); }
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?.join("broker-sidecar").join(sidecar_file_name());
    if resource.is_file() { return Ok(resource); }
    let beside_exe = std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("Cannot determine admin executable directory")?.join("broker-sidecar").join(sidecar_file_name());
    if beside_exe.is_file() { return Ok(beside_exe); }
    Err(format!("Broker sidecar missing. Set WIN98_MCP_BROKER_SIDECAR for development or install a release that includes resources/broker-sidecar/{}.", sidecar_file_name()))
}
#[cfg(windows)] fn sidecar_file_name() -> &'static str { "windows98-mcp-broker.exe" }
#[cfg(unix)] fn sidecar_file_name() -> &'static str { "windows98-mcp-broker" }
#[cfg(windows)] fn pipe_path(port: u16) -> String { if port == DEFAULT_PORT { r"\\.\pipe\win98-mcp".into() } else { format!(r"\\.\pipe\win98-mcp-{port}") } }
#[cfg(unix)] fn pipe_path(port: u16) -> String { if port == DEFAULT_PORT { "/tmp/win98-mcp.sock".into() } else { format!("/tmp/win98-mcp-{port}.sock") } }
#[cfg(windows)] fn open_local_stream(port: u16) -> Result<LocalStream, String> { OpenOptions::new().read(true).write(true).open(pipe_path(port)).map_err(|e| format!("BROKER_NOT_RUNNING: {e}")) }
#[cfg(unix)] fn open_local_stream(port: u16) -> Result<LocalStream, String> { UnixStream::connect(pipe_path(port)).map_err(|e| format!("BROKER_NOT_RUNNING: {e}")) }
fn pipe_exists(port: u16) -> bool { open_local_stream(port).is_ok() }
fn start_sidecar(app: &AppHandle, state: &AppState, port: u16) -> Result<(), String> {
    if pipe_exists(port) { *state.active_port.lock().map_err(|_| "Broker port state lock failed")? = port; return Ok(()); }
    let executable = sidecar_path(app)?;
    let child = Command::new(executable).args(["broker", "--port", &port.to_string()]).spawn().map_err(|e| format!("Could not start broker sidecar: {e}"))?;
    *state.child.lock().map_err(|_| "Broker process state lock failed")? = Some(child);
    *state.active_port.lock().map_err(|_| "Broker port state lock failed")? = port;
    Ok(())
}
fn stop_sidecar(state: &AppState) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().map_err(|_| "Broker process state lock failed")?.take() { child.kill().map_err(|e| format!("Could not stop broker: {e}"))?; }
    *state.client.lock().map_err(|_| "Broker pipe state lock failed")? = None;
    Ok(())
}

fn connect_pipe(port: u16) -> Result<PipeClient, String> {
    let mut writer = open_local_stream(port)?;
    let session_id = Uuid::new_v4().to_string();
    let hello = json!({ "kind": "broker_hello", "sessionId": session_id, "sessionLabel": "Windows 98 MCP Admin" });
    writeln!(writer, "{}", hello).map_err(|_| "BROKER_HELLO_WRITE_FAILED")?;
    writer.flush().map_err(|_| "BROKER_HELLO_FLUSH_FAILED")?;
    let mut reader = BufReader::new(writer.try_clone().map_err(|e| e.to_string())?);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return Err("BROKER_CLOSED_DURING_HELLO".into()),
            Ok(_) => match serde_json::from_str::<Value>(&line) {
                Ok(value) if value.get("kind").and_then(Value::as_str) == Some("broker_ready") && value.get("sessionId") == Some(&Value::String(session_id.clone())) => return Ok(PipeClient { session_id, writer, reader }),
                _ => continue,
            },
            Err(e) => return Err(format!("BROKER_HELLO_READ_FAILED: {e}")),
        }
    }
}
fn broker_call(state: &AppState, method: String, params: Value) -> Reply {
    let port = match state.active_port.lock() { Ok(port) => *port, Err(_) => return Reply { ok: false, result: None, image: None, error: Some("BROKER_PORT_STATE_LOCK_FAILED".into()) } };
    let mut slot = match state.client.lock() { Ok(value) => value, Err(_) => return Reply { ok: false, result: None, image: None, error: Some("BROKER_PIPE_STATE_LOCK_FAILED".into()) } };
    if slot.is_none() { match connect_pipe(port) { Ok(client) => *slot = Some(client), Err(error) => return Reply { ok: false, result: None, image: None, error: Some(error) } } }
    let client = slot.as_mut().expect("pipe client just initialized");
    let id = Uuid::new_v4().to_string();
    let request = json!({ "kind": "broker_request", "id": id, "sessionId": client.session_id, "sessionLabel": "Windows 98 MCP Admin", "method": method, "params": params });
    let result = (|| -> Result<Reply, String> {
        writeln!(client.writer, "{}", request).map_err(|_| "BROKER_WRITE_FAILED")?;
        client.writer.flush().map_err(|_| "BROKER_FLUSH_FAILED")?;
        loop {
            let mut line = String::new();
            match client.reader.read_line(&mut line) {
                Ok(0) => return Err("BROKER_CLOSED_CONNECTION".into()),
                Ok(_) => match serde_json::from_str::<Value>(&line) {
                    Ok(value) if value.get("id") == Some(&Value::String(id.clone())) => return Ok(Reply { ok: value.get("result").and_then(|r| r.get("ok")).and_then(Value::as_bool).unwrap_or(false), result: value.get("result").cloned(), image: value.get("image").cloned(), error: value.get("result").and_then(|r| r.get("message")).map(|x| x.to_string()) }),
                    _ => continue,
                },
                Err(e) => return Err(format!("BROKER_READ_FAILED: {e}")),
            }
        }
    })();
    match result { Ok(reply) => reply, Err(error) => { *slot = None; Reply { ok: false, result: None, image: None, error: Some(error) } } }
}

#[tauri::command] fn get_port() -> u16 { read_settings().port }
#[tauri::command] fn save_port(port: u16) -> Result<(), String> { if port == 0 { return Err("Port must be between 1 and 65535".into()); } write_settings(port) }
#[tauri::command] fn start_broker(app: AppHandle, state: State<AppState>, port: u16) -> Result<(), String> { start_sidecar(&app, &state, port) }
#[tauri::command] fn restart_broker(app: AppHandle, state: State<AppState>, port: u16) -> Result<(), String> { stop_sidecar(&state)?; start_sidecar(&app, &state, port) }
#[tauri::command] fn broker_request(state: State<AppState>, method: String, params: Value) -> Reply { broker_call(&state, method, params) }
#[tauri::command] fn wait_for_guest(state: State<AppState>) -> Result<Value, String> { let started = Instant::now(); loop { let reply = broker_call(&state, "vm_status".into(), json!({})); if reply.ok { if let Some(result) = reply.result { if result.pointer("/data/connection/state").and_then(Value::as_str) == Some("online") { return Ok(result.get("data").cloned().unwrap_or(result)); } } } if started.elapsed() >= Duration::from_secs(5) { return Err("GUEST_CONNECT_TIMEOUT: the guest did not connect within 5 seconds".into()); } std::thread::sleep(Duration::from_millis(250)); } }
#[tauri::command] fn save_base64_png(path: String, data_url: String) -> Result<(), String> { let encoded = data_url.split_once(',').map(|(_, value)| value).ok_or("Invalid PNG data URL")?; let bytes = STANDARD.decode(encoded).map_err(|e| e.to_string())?; fs::write(Path::new(&path), bytes).map_err(|e| e.to_string()) }

fn main() {
    tauri::Builder::default().manage(AppState { child: Mutex::new(None), client: Mutex::new(None), active_port: Mutex::new(read_settings().port) }).invoke_handler(tauri::generate_handler![get_port, save_port, start_broker, restart_broker, broker_request, wait_for_guest, save_base64_png]).run(tauri::generate_context!()).expect("error while running Windows 98 MCP Admin");
}
