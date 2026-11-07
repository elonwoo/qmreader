use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use std::os::unix::process::CommandExt;
use tauri::ipc::Channel;
use tauri::{Manager, RunEvent, State};

#[derive(Deserialize)]
struct FetchRequest {
    id: u64,
    method: String,
    path: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

struct ReadyState {
    ready: bool,
    error: Option<String>,
}

struct Bridge {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Arc<Mutex<HashMap<u64, Channel<String>>>>,
    ready: Arc<(Mutex<ReadyState>, Condvar)>,
    socket_path: PathBuf,
}

impl Bridge {
    fn wait_ready(&self) -> Result<(), String> {
        let (lock, condvar) = &*self.ready;
        let mut state = lock.lock().map_err(|_| "readiness lock poisoned".to_string())?;
        let deadline = Instant::now() + Duration::from_secs(45);
        while !state.ready && state.error.is_none() {
            let now = Instant::now();
            if now >= deadline {
                return Err("native backend did not become ready within 45s".to_string());
            }
            let (next, _) = condvar
                .wait_timeout(state, deadline - now)
                .map_err(|_| "readiness wait failed".to_string())?;
            state = next;
        }
        if let Some(error) = state.error.clone() {
            return Err(error);
        }
        Ok(())
    }

    fn shutdown(&self) {
        // server.js forks refresh workers and source children. They inherit the
        // bridge process group, so signal the whole group instead of leaving
        // Node workers running after the window closes.
        let mut child_group = None;
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                child_group = Some(child.id() as i32);
            }
        }
        if let Some(pid) = child_group {
            unsafe { libc::kill(-pid, libc::SIGTERM); }
            let deadline = Instant::now() + Duration::from_secs(4);
            if let Ok(mut guard) = self.child.lock() {
                if let Some(child) = guard.as_mut() {
                    while Instant::now() < deadline {
                        match child.try_wait() {
                            Ok(Some(_)) => break,
                            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                            Err(_) => break,
                        }
                    }
                }
            }
            // Any worker that ignored SIGTERM is killed; the bridge already
            // flushed SQLite/cache state in its SIGTERM handler.
            unsafe { libc::kill(-pid, libc::SIGKILL); }
        }
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.wait();
            }
        }
        if let Ok(mut guard) = self.stdin.lock() {
            let _ = guard.take();
        }
        let _ = fs::remove_file(&self.socket_path);
    }
}

struct RuntimePaths {
    node: PathBuf,
    runtime: PathBuf,
    bridge_script: PathBuf,
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| path.exists()).cloned()
}

fn resolve_runtime(app: &tauri::App, app_data: &Path) -> Result<RuntimePaths, String> {
    let exe = std::env::current_exe().map_err(|error| format!("current_exe failed: {error}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "current executable has no parent".to_string())?
        .to_path_buf();
    let mut resource_dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        resource_dirs.push(dir.join("runtime"));
    }
    resource_dirs.push(exe_dir.join("../Resources/runtime"));

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest_dir
        .parent()
        .ok_or_else(|| "CARGO_MANIFEST_DIR has no parent".to_string())?
        .to_path_buf();
    let mut runtime_candidates = resource_dirs.clone();
    runtime_candidates.push(manifest_dir.join("runtime"));
    runtime_candidates.push(project_root.clone());
    let runtime = first_existing(&runtime_candidates)
        .filter(|dir| dir.join("native/bridge.cjs").exists())
        .ok_or_else(|| {
            format!(
                "QMReader runtime not found. Tried: {}",
                runtime_candidates
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
    let bridge_script = runtime.join("native/bridge.cjs");

    let env_node = std::env::var("QMREADER_NODE_BIN").ok().map(PathBuf::from);
    let mut node_candidates: Vec<PathBuf> = Vec::new();
    if let Some(node) = env_node {
        node_candidates.push(node);
    }
    node_candidates.push(exe_dir.join("node"));
    node_candidates.push(exe_dir.join("node-aarch64-apple-darwin"));
    node_candidates.push(runtime.join("node"));
    node_candidates.push(manifest_dir.join("binaries/node-aarch64-apple-darwin"));
    let node = first_existing(&node_candidates).ok_or_else(|| {
        format!(
            "bundled Node executable not found. Tried: {}",
            node_candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;

    let _ = app_data;
    Ok(RuntimePaths {
        node,
        runtime,
        bridge_script,
    })
}

fn socket_path() -> PathBuf {
    let candidate = std::env::temp_dir().join(format!("qmreader-{}.sock", std::process::id()));
    if candidate.as_os_str().len() < 100 {
        candidate
    } else {
        PathBuf::from(format!("/tmp/qmreader-{}.sock", std::process::id()))
    }
}

fn start_bridge(paths: &RuntimePaths, app_data: &Path) -> Result<Bridge, String> {
    let socket = socket_path();
    let _ = fs::remove_file(&socket);
    let log_dir = app_data.join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| format!("create log dir: {error}"))?;
    let log_path = log_dir.join("native.log");
    let mut log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("open {}: {error}", log_path.display()))?;
    let _ = writeln!(
        log_file,
        "---- QMReader {} starting bridge {} ----",
        env!("CARGO_PKG_VERSION"),
        chrono_like_stamp()
    );

    let mut child = Command::new(&paths.node)
        .arg(&paths.bridge_script)
        .current_dir(&paths.runtime)
        .env("QMREADER_APP_DATA_DIR", app_data)
        .env("QMREADER_SOCKET", &socket)
        .env("QMREADER_SERVER_ROOT", &paths.runtime)
        .env("QMREADER_NODE_BIN", &paths.node)
        .env("NODE_ENV", "production")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|error| format!("spawn Node bridge with {:?}: {error}", paths.node))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Node bridge stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Node bridge stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Node bridge stderr unavailable".to_string())?;

    let pending: Arc<Mutex<HashMap<u64, Channel<String>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let ready: Arc<(Mutex<ReadyState>, Condvar)> = Arc::new((
        Mutex::new(ReadyState {
            ready: false,
            error: None,
        }),
        Condvar::new(),
    ));

    let reader_pending = Arc::clone(&pending);
    let reader_ready = Arc::clone(&ready);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    eprintln!("[bridge] stdout read error: {error}");
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("[bridge] invalid protocol line: {error}: {line}");
                    continue;
                }
            };
            if value.get("type").and_then(|value| value.as_str()) == Some("ready") {
                let (lock, condvar) = &*reader_ready;
                if let Ok(mut state) = lock.lock() {
                    state.ready = true;
                    condvar.notify_all();
                }
                continue;
            }
            let Some(id) = value.get("id").and_then(|value| value.as_u64()) else {
                continue;
            };
            let kind = value
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            let channel = reader_pending
                .lock()
                .ok()
                .and_then(|pending| pending.get(&id).cloned());
            if let Some(channel) = channel {
                let _ = channel.send(line.clone());
                if kind == "end" || kind == "error" {
                    if let Ok(mut pending) = reader_pending.lock() {
                        pending.remove(&id);
                    }
                }
            }
        }

        let (lock, condvar) = &*reader_ready;
        if let Ok(mut state) = lock.lock() {
            if !state.ready {
                state.error = Some("native bridge exited before becoming ready".to_string());
                state.ready = true;
            }
            condvar.notify_all();
        }
        eprintln!("[bridge] Node bridge stdout closed");
        if let Ok(mut pending) = reader_pending.lock() {
            for (_, channel) in pending.drain() {
                let _ = channel.send(
                    "{\"type\":\"error\",\"message\":\"native bridge exited\"}".to_string(),
                );
            }
        }
    });

    let mut stderr_file = log_file;
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            eprintln!("[node] {line}");
            let _ = writeln!(stderr_file, "{line}");
            let _ = stderr_file.flush();
        }
    });

    Ok(Bridge {
        stdin: Mutex::new(Some(stdin)),
        child: Mutex::new(Some(child)),
        pending,
        ready,
        socket_path: socket,
    })
}

fn chrono_like_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => format!("{}s", duration.as_secs()),
        Err(_) => "unknown".to_string(),
    }
}

#[tauri::command]
fn native_fetch(
    state: State<'_, Arc<Bridge>>,
    req: FetchRequest,
    channel: Channel<String>,
) -> Result<(), String> {
    state.wait_ready()?;
    let id = req.id;
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "request table poisoned".to_string())?;
        pending.insert(id, channel);
    }
    let line = serde_json::to_string(&serde_json::json!({
        "id": req.id,
        "method": req.method,
        "path": req.path,
        "headers": req.headers,
        "body": req.body,
    }))
    .map_err(|error| format!("encode request: {error}"))?;
    let write_result = {
        let mut guard = state
            .stdin
            .lock()
            .map_err(|_| "bridge stdin poisoned".to_string())?;
        match guard.as_mut() {
            Some(stdin) => writeln!(stdin, "{line}")
                .and_then(|_| stdin.flush())
                .map_err(|error| format!("write bridge request: {error}")),
            None => Err("native bridge is not running".to_string()),
        }
    };
    if let Err(error) = write_result {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&id);
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
fn native_cancel(state: State<'_, Arc<Bridge>>, id: u64) -> Result<(), String> {
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(&id);
    }
    let mut guard = state
        .stdin
        .lock()
        .map_err(|_| "bridge stdin poisoned".to_string())?;
    match guard.as_mut() {
        Some(stdin) => {
            writeln!(stdin, "{{\"cancel\":{id}}}")
                .and_then(|_| stdin.flush())
                .map_err(|error| format!("cancel request: {error}"))
        }
        None => Ok(()),
    }
}

#[tauri::command]
fn native_log(app: tauri::AppHandle, message: String) {
    if let Ok(dir) = app.path().app_data_dir() {
        let logs = dir.join("logs");
        let _ = fs::create_dir_all(&logs);
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("webview.log"))
        {
            let _ = writeln!(file, "{message}");
        }
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs can be opened externally".to_string());
    }
    Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("open {url}: {error}"))
}

fn main() {
    let builder = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            native_fetch,
            native_cancel,
            native_log,
            open_external
        ])
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("app_data_dir: {error}"))?;
            fs::create_dir_all(&app_data)
                .map_err(|error| format!("create app data dir: {error}"))?;
            let paths = resolve_runtime(app, &app_data)?;
            let bridge = start_bridge(&paths, &app_data)?;
            app.manage(Arc::new(bridge));
            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build QMReader");
    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(bridge) = app_handle.try_state::<Arc<Bridge>>() {
                bridge.shutdown();
            }
        }
    });
}
