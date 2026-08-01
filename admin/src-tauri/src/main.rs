#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::{BufRead, BufReader, Write}, net::TcpStream, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::Mutex, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const DEFAULT_PORT: u16 = 9898;
const DEFAULT_BROKER_PORT: u16 = 9899;

type LocalStream = TcpStream;

struct PipeClient {
    session_id: String,
    writer: LocalStream,
    reader: BufReader<LocalStream>,
}
#[derive(Clone)] struct BrokerEndpoint { host: String, port: u16 }
struct AppState { child: Mutex<Option<Child>>, client: Mutex<Option<PipeClient>>, endpoint: Mutex<BrokerEndpoint> }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    port: u16,
    #[serde(default = "default_broker_host")] broker_host: String,
    #[serde(default = "default_broker_port")] broker_port: u16,
    #[serde(default = "default_locking_enabled")] locking_enabled: bool,
    #[serde(default)] upstream_enabled: bool,
    #[serde(default)] upstream_host: String,
    #[serde(default = "default_upstream_port")] upstream_port: u16,
}
fn default_upstream_port() -> u16 { DEFAULT_PORT }
fn default_broker_host() -> String { "127.0.0.1".into() }
fn default_broker_port() -> u16 { DEFAULT_BROKER_PORT }
fn default_locking_enabled() -> bool { false }

#[derive(Serialize)]
struct Reply { ok: bool, #[serde(skip_serializing_if = "Option::is_none")] result: Option<Value>, #[serde(skip_serializing_if = "Option::is_none")] image: Option<Value>, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> }

// This is deliberately the exact host runtime file.  The npm MCP adapter and
// the admin app must select the same listener port without a second setting.
fn settings_path() -> Result<PathBuf, String> {
    let root = dirs::data_local_dir().ok_or("Cannot determine local app-data directory")?.join("win98-mcp");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.join("runtime.json"))
}
fn default_settings() -> Settings { Settings { port: DEFAULT_PORT, broker_host: default_broker_host(), broker_port: DEFAULT_BROKER_PORT, locking_enabled: false, upstream_enabled: false, upstream_host: String::new(), upstream_port: DEFAULT_PORT } }
fn read_settings() -> Settings { settings_path().ok().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(default_settings) }
fn write_settings(settings: &Settings) -> Result<(), String> { fs::write(settings_path()?, serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) }

fn sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("WIN98_MCP_BROKER_SIDECAR") { return Ok(PathBuf::from(path)); }
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    // Tauri places declared bundle resources beneath `resources/` in a macOS
    // app.  Portable Windows archives keep the sidecar beside the executable.
    // Check both canonical bundle layouts so the release archive never needs
    // to be modified after macOS has signed the .app bundle.
    for resource in [
        resource_dir.join("broker-sidecar").join(sidecar_file_name()),
        resource_dir.join("resources").join("broker-sidecar").join(sidecar_file_name()),
    ] {
        if resource.is_file() { return Ok(resource); }
    }
    let beside_exe = std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("Cannot determine admin executable directory")?.join("broker-sidecar").join(sidecar_file_name());
    if beside_exe.is_file() { return Ok(beside_exe); }
    Err(format!("Broker sidecar missing. Set WIN98_MCP_BROKER_SIDECAR for development or install a release that includes resources/broker-sidecar/{}.", sidecar_file_name()))
}
#[cfg(windows)] fn sidecar_file_name() -> &'static str { "windows98-mcp-broker.exe" }
#[cfg(unix)] fn sidecar_file_name() -> &'static str { "windows98-mcp-broker" }
fn is_local_broker(host: &str) -> bool { matches!(host.trim().to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1") }
fn endpoint(settings: &Settings) -> BrokerEndpoint { BrokerEndpoint { host: settings.broker_host.trim().to_owned(), port: settings.broker_port } }
fn open_broker_stream(endpoint: &BrokerEndpoint) -> Result<LocalStream, String> { TcpStream::connect((endpoint.host.as_str(), endpoint.port)).map_err(|e| format!("BROKER_NOT_RUNNING: {e}")) }
fn broker_exists(endpoint: &BrokerEndpoint) -> bool { open_broker_stream(endpoint).is_ok() }
fn validate_settings(settings: &Settings) -> Result<(), String> {
    if settings.port == 0 || settings.broker_port == 0 || settings.upstream_port == 0 { return Err("Ports must be between 1 and 65535".into()); }
    if settings.broker_host.trim().is_empty() { return Err("Set a broker host or IP address.".into()); }
    if settings.upstream_enabled && settings.upstream_host.trim().is_empty() { return Err("Set the remote broker IP or host before enabling proxy.".into()); }
    Ok(())
}
fn start_sidecar(app: &AppHandle, state: &AppState, settings: &Settings) -> Result<(), String> {
    validate_settings(settings)?;
    let endpoint = endpoint(settings);
    *state.endpoint.lock().map_err(|_| "Broker endpoint state lock failed")? = endpoint.clone();
    if !is_local_broker(&endpoint.host) || broker_exists(&endpoint) { return Ok(()); }
    let executable = sidecar_path(app)?;
    let mut command = Command::new(executable);
    command.args(["broker", "--port", &settings.port.to_string(), "--adapter-port", &endpoint.port.to_string()]);
    if settings.upstream_enabled { command.args(["--upstream", &format!("{}:{}", settings.upstream_host.trim(), settings.upstream_port)]); }
    let child = command.spawn().map_err(|e| format!("Could not start broker sidecar: {e}"))?;
    *state.child.lock().map_err(|_| "Broker process state lock failed")? = Some(child);
    Ok(())
}
fn apply_broker_settings(app: &AppHandle, state: &AppState, settings: &Settings) -> Result<(), String> {
    validate_settings(settings)?;
    let params = json!({
        "enabled": settings.upstream_enabled,
        "host": settings.upstream_host.trim(),
        "port": settings.upstream_port
    });
    let mut last_error = String::from("BROKER_NOT_RUNNING");
    let mut upstream_applied = false;
    for _ in 0..20 {
        let reply = broker_call(app, state, "broker_set_upstream".into(), params.clone());
        if reply.ok { upstream_applied = true; break; }
        last_error = reply.error.unwrap_or_else(|| "BROKER_PROXY_CONFIGURATION_FAILED".into());
        std::thread::sleep(Duration::from_millis(250));
    }
    if !upstream_applied { return Err(last_error); }
    let locking_params = json!({ "enabled": settings.locking_enabled });
    for _ in 0..20 {
        let reply = broker_call(app, state, "broker_set_locking".into(), locking_params.clone());
        if reply.ok { return Ok(()); }
        last_error = reply.error.unwrap_or_else(|| "BROKER_LOCK_CONFIGURATION_FAILED".into());
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(last_error)
}
fn stop_sidecar(state: &AppState) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().map_err(|_| "Broker process state lock failed")?.take() {
        match child.kill() {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {}
            Err(error) => return Err(format!("Could not stop broker: {error}"))
        }
        child.wait().map_err(|error| format!("Could not wait for broker shutdown: {error}"))?;
    }
    *state.client.lock().map_err(|_| "Broker pipe state lock failed")? = None;
    Ok(())
}

fn connect_broker(endpoint: &BrokerEndpoint) -> Result<PipeClient, String> {
    let mut writer = open_broker_stream(endpoint)?;
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
fn broker_call(app: &AppHandle, state: &AppState, method: String, params: Value) -> Reply {
    let endpoint = match state.endpoint.lock() { Ok(endpoint) => endpoint.clone(), Err(_) => return Reply { ok: false, result: None, image: None, error: Some("BROKER_ENDPOINT_STATE_LOCK_FAILED".into()) } };
    let mut slot = match state.client.lock() { Ok(value) => value, Err(_) => return Reply { ok: false, result: None, image: None, error: Some("BROKER_PIPE_STATE_LOCK_FAILED".into()) } };
    if slot.is_none() { match connect_broker(&endpoint) { Ok(client) => *slot = Some(client), Err(error) => return Reply { ok: false, result: None, image: None, error: Some(error) } } }
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
                    Ok(value) if value.get("kind").and_then(Value::as_str) == Some("broker_progress") => {
                        let _ = app.emit("transfer-progress", value.get("progress").cloned().unwrap_or(Value::Null));
                        continue;
                    }
                    Ok(value) if value.get("id") == Some(&Value::String(id.clone())) => return Ok(Reply { ok: value.get("result").and_then(|r| r.get("ok")).and_then(Value::as_bool).unwrap_or(false), result: value.get("result").cloned(), image: value.get("image").cloned(), error: value.get("result").and_then(|r| r.get("message")).map(|x| x.to_string()) }),
                    _ => continue,
                },
                Err(e) => return Err(format!("BROKER_READ_FAILED: {e}")),
            }
        }
    })();
    match result { Ok(reply) => reply, Err(error) => { *slot = None; Reply { ok: false, result: None, image: None, error: Some(error) } } }
}

// Transfer paths belong to the computer running this admin window. Delegate
// the verified chunk/hash workflow to the bundled Node sidecar, which opens a
// fresh TCP control session to the selected broker and streams progress back.
fn run_client_transfer(app: &AppHandle, state: &AppState, method: String, params: Value) -> Result<Value, String> {
    let endpoint = state.endpoint.lock().map_err(|_| "Broker endpoint state lock failed")?.clone();
    let executable = sidecar_path(app)?;
    let request = serde_json::to_string(&json!({ "method": method, "params": params })).map_err(|e| e.to_string())?;
    let mut child = Command::new(executable)
        .args(["client-transfer", "--broker-host", &endpoint.host, "--broker-port", &endpoint.port.to_string(), "--transfer-request", &request])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start local transfer sidecar: {e}"))?;
    let stdout = child.stdout.take().ok_or("CLIENT_TRANSFER_STDOUT_UNAVAILABLE")?;
    let mut final_result: Option<Value> = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| format!("CLIENT_TRANSFER_READ_FAILED: {e}"))?;
        let value: Value = serde_json::from_str(&line).map_err(|_| format!("CLIENT_TRANSFER_INVALID_OUTPUT: {line}"))?;
        match value.get("kind").and_then(Value::as_str) {
            Some("transfer_progress") => { let _ = app.emit("transfer-progress", value.get("progress").cloned().unwrap_or(Value::Null)); }
            Some("transfer_result") => final_result = Some(value),
            _ => {}
        }
    }
    let status = child.wait().map_err(|e| format!("CLIENT_TRANSFER_WAIT_FAILED: {e}"))?;
    let result = final_result.ok_or_else(|| format!("CLIENT_TRANSFER_NO_RESULT: {status}"))?;
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(result.get("data").cloned().unwrap_or(Value::Null));
    }
    Err(result.get("error").and_then(Value::as_str).unwrap_or("CLIENT_TRANSFER_FAILED").to_owned())
}

#[tauri::command] fn get_settings() -> Settings { read_settings() }
#[tauri::command] fn save_settings(settings: Settings) -> Result<(), String> { validate_settings(&settings)?; write_settings(&settings) }
#[tauri::command] fn start_broker(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<(), String> {
    start_sidecar(&app, &state, &settings)?;
    apply_broker_settings(&app, &state, &settings)
}
#[tauri::command] fn restart_broker(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<(), String> {
    validate_settings(&settings)?;
    let active = state.endpoint.lock().map_err(|_| "Broker endpoint state lock failed")?.clone();
    // A broker started by another MCP/admin process is already the correct
    // singleton for this port. Do not race its pipe by attempting to replace it.
    let requested = endpoint(&settings);
    if active.host == requested.host && active.port == requested.port && state.child.lock().map_err(|_| "Broker process state lock failed")?.is_none() && broker_exists(&requested) {
        return apply_broker_settings(&app, &state, &settings);
    }
    // Applying a lock/proxy setting to the sidecar we own must not restart it:
    // restarting would disconnect every MCP/admin agent merely to change a
    // broker policy. A changed guest listener port still requires a restart.
    if active.host == requested.host && active.port == requested.port && broker_exists(&requested) {
        let status = broker_call(&app, &state, "vm_status".into(), json!({}));
        let current_port = status.result.as_ref()
            .and_then(|result| result.pointer("/data/broker/guestPort"))
            .and_then(Value::as_u64)
            .map(|port| port as u16);
        if current_port == Some(settings.port) {
            return apply_broker_settings(&app, &state, &settings);
        }
    }
    if !is_local_broker(&requested.host) { stop_sidecar(&state)?; *state.endpoint.lock().map_err(|_| "Broker endpoint state lock failed")? = requested; return apply_broker_settings(&app, &state, &settings); }
    stop_sidecar(&state)?;
    start_sidecar(&app, &state, &settings)?;
    apply_broker_settings(&app, &state, &settings)
}
#[tauri::command] async fn broker_request(app: AppHandle, method: String, params: Value) -> Reply {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        broker_call(&worker, &state, method, params)
    }).await.unwrap_or_else(|error| Reply { ok: false, result: None, image: None, error: Some(format!("BROKER_TASK_FAILED: {error}")) })
}
#[tauri::command] async fn client_transfer(app: AppHandle, method: String, params: Value) -> Result<Value, String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        run_client_transfer(&worker, &state, method, params)
    }).await.map_err(|error| format!("CLIENT_TRANSFER_TASK_FAILED: {error}"))?
}
#[tauri::command] fn wait_for_guest(app: AppHandle, state: State<AppState>) -> Result<Value, String> { let started = Instant::now(); loop { let reply = broker_call(&app, &state, "vm_status".into(), json!({})); if reply.ok { if let Some(result) = reply.result { if result.pointer("/data/connection/state").and_then(Value::as_str) == Some("online") { return Ok(result.get("data").cloned().unwrap_or(result)); } } } if started.elapsed() >= Duration::from_secs(5) { return Err("GUEST_CONNECT_TIMEOUT: the guest did not connect within 5 seconds".into()); } std::thread::sleep(Duration::from_millis(250)); } }
#[tauri::command] fn save_base64_png(path: String, data_url: String) -> Result<(), String> { let encoded = data_url.split_once(',').map(|(_, value)| value).ok_or("Invalid PNG data URL")?; let bytes = STANDARD.decode(encoded).map_err(|e| e.to_string())?; fs::write(Path::new(&path), bytes).map_err(|e| e.to_string()) }

fn main() {
    let settings = read_settings();
    tauri::Builder::default().plugin(tauri_plugin_dialog::init()).manage(AppState { child: Mutex::new(None), client: Mutex::new(None), endpoint: Mutex::new(endpoint(&settings)) }).invoke_handler(tauri::generate_handler![get_settings, save_settings, start_broker, restart_broker, broker_request, client_transfer, wait_for_guest, save_base64_png]).run(tauri::generate_context!()).expect("error while running Windows 98 MCP Admin");
}
