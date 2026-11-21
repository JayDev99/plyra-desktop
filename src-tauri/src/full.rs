//! "Review & analysis": the full Plyra Chess (game review with the AI coach, position investigations, progress,
//! plan & account, and the Theoretician where the plan allows it) shown inside this window.
//!
//! It uses the Plyra Chess already installed on this computer (%LOCALAPPDATA%\Programs\PlyraChess). If its server
//! is already running it is reused; otherwise it is started without a window of its own. It registers itself in
//! %USERPROFILE%\.plyra-chess\running.json exactly like the Plyra launcher does, so opening the regular Plyra
//! shortcut at the same time reuses the same server instead of starting a second one. The server stops by
//! itself a few seconds after this window closes (Plyra 1.0.53 and later).

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default().join(".plyra-chess")
}

fn install_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default().join("Programs").join("PlyraChess")
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn installed_version(app: &PathBuf) -> String {
    std::fs::read_to_string(app.join("installer").join("product.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("version").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default()
}

fn running_port(version: &str) -> Option<u16> {
    let s = std::fs::read_to_string(home().join("running.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    let same = v.get("version").and_then(|x| x.as_str()) == Some(version);
    if same && port_open(port) {
        Some(port)
    } else {
        None
    }
}

#[tauri::command]
pub async fn open_full() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(start).await.map_err(|e| e.to_string())?
}

fn start() -> Result<String, String> {
    let dir = install_dir();
    let app = dir.join("app");
    let python = dir.join("venv").join("Scripts").join("python.exe");
    if !python.exists() || !app.join("app.py").exists() {
        return Err("not-installed".into());
    }
    let version = installed_version(&app);
    if let Some(port) = running_port(&version) {
        return Ok(format!("http://localhost:{port}"));
    }
    let port = (8501u16..8551).find(|p| !port_open(*p)).unwrap_or(8501);
    let h = home();
    let _ = std::fs::create_dir_all(&h);
    let log = std::fs::File::create(h.join("app.log")).map_err(|e| e.to_string())?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&python);
    let args: Vec<String> = vec![
        "-m".into(), "streamlit".into(), "run".into(),
        app.join("app.py").to_string_lossy().into_owned(),
        "--server.port".into(), port.to_string(),
        "--server.headless".into(), "true".into(),
        "--browser.gatherUsageStats".into(), "false".into(),
        "--client.toolbarMode".into(), "minimal".into(),
        "--client.showErrorDetails".into(), "none".into(),
    ];
    cmd.args(&args)
    .current_dir(&app)
    .env("PYTHONIOENCODING", "utf-8")
    .env("PYTHONUTF8", "1")
    .stdin(Stdio::null())
    .stdout(Stdio::from(log))
    .stderr(Stdio::from(log2));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let state = serde_json::json!({
        "pid": child.id(), "port": port, "version": version,
        "app_dir": app.to_string_lossy(), "launcher": std::process::id(),
    });
    let _ = std::fs::write(h.join("running.json"), state.to_string());
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(90) {
        if port_open(port) {
            return Ok(format!("http://localhost:{port}"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("Plyra Chess did not start. Details are in .plyra-chess\\app.log.".into())
}
