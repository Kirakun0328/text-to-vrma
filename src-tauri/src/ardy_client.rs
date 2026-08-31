use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

const DEFAULT_PORT: u16 = 2337;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArdyConfig {
    pub python_exe: Option<String>,
    pub merged_base: Option<String>,
    pub hf_home: Option<String>,
    pub port: u16,
    pub text_encoder_device: String,
}

impl Default for ArdyConfig {
    fn default() -> Self {
        Self {
            python_exe: None,
            merged_base: None,
            hf_home: None,
            port: DEFAULT_PORT,
            text_encoder_device: "cpu".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArdyStatus {
    pub config_path: String,
    pub configured: bool,
    pub running: bool,
    pub port: u16,
    pub log_path: String,
    pub last_error: Option<String>,
}

pub struct ArdyClient {
    user_data_dir: PathBuf,
    engine_dir: PathBuf,
    child: Option<Child>,
    last_error: Option<String>,
}

impl ArdyClient {
    pub fn new(user_data_dir: PathBuf, engine_dir: PathBuf) -> Self {
        Self {
            user_data_dir,
            engine_dir,
            child: None,
            last_error: None,
        }
    }

    fn config_path(&self) -> PathBuf {
        self.user_data_dir.join("ardy-engine.json")
    }

    fn log_path(&self) -> PathBuf {
        self.user_data_dir.join("ardy-engine.log")
    }

    fn setup_log_path(&self) -> PathBuf {
        self.user_data_dir.join("ardy-setup.log")
    }

    pub fn read_config(&self) -> ArdyConfig {
        let mut config = ArdyConfig::default();

        // Read config file
        if let Ok(content) = fs::read_to_string(self.config_path()) {
            let content = content.strip_prefix('\u{FEFF}').unwrap_or(&content);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content) {
                config.python_exe = parsed["pythonExe"]
                    .as_str()
                    .map(|s| s.to_string());
                config.merged_base = parsed["mergedBase"]
                    .as_str()
                    .map(|s| s.to_string());
                config.hf_home = parsed["hfHome"]
                    .as_str()
                    .map(|s| s.to_string());
                config.port = parsed["port"]
                    .as_u64()
                    .map(|p| p as u16)
                    .unwrap_or(DEFAULT_PORT);
                config.text_encoder_device = parsed["textEncoderDevice"]
                    .as_str()
                    .unwrap_or("cpu")
                    .to_string();
            }
        }

        // Override with environment variables
        if let Ok(val) = std::env::var("ARDY_PYTHON") {
            config.python_exe = Some(val);
        }
        if let Ok(val) = std::env::var("ARDY_MERGED_BASE") {
            config.merged_base = Some(val);
        }
        if let Ok(val) = std::env::var("ARDY_HF_HOME") {
            config.hf_home = Some(val);
        } else if let Ok(val) = std::env::var("HF_HOME") {
            config.hf_home = Some(val);
        }

        config
    }

    pub fn get_status(&self) -> ArdyStatus {
        let config = self.read_config();
        ArdyStatus {
            config_path: self.config_path().to_string_lossy().to_string(),
            configured: config.python_exe.is_some() && !config.python_exe.as_deref().unwrap_or("").is_empty(),
            running: self.child.as_ref().map_or(false, |c| c.id() != 0),
            port: config.port,
            log_path: self.log_path().to_string_lossy().to_string(),
            last_error: self.last_error.clone(),
        }
    }

    pub fn start(&mut self) -> Result<ArdyStatus, String> {
        let config = self.read_config();

        let python_exe = config
            .python_exe
            .as_ref()
            .filter(|s| !s.is_empty())
            .ok_or("ARDY_NOT_CONFIGURED")?;

        // Validate python path: must be absolute, exist, and be a file (no directory traversal via relative)
        let p = std::path::Path::new(python_exe);
        if !p.is_absolute() {
            return Err(format!("Python path must be absolute: {}", python_exe));
        }
        if !p.exists() || !p.is_file() {
            return Err(format!("Python not found: {}", python_exe));
        }

        // Check if already running
        if let Some(ref mut child) = self.child {
            match child.try_wait() {
                Ok(Some(_)) => {} // Exited, need to restart
                Ok(None) => return Ok(self.get_status()), // Still running
                Err(_) => {}
            }
        }

        let server_script = self.engine_dir.join("server.py");
        let mut args = vec![
            server_script.to_string_lossy().to_string(),
            "--port".to_string(),
            config.port.to_string(),
        ];
        if let Some(ref merged_base) = config.merged_base {
            if !merged_base.is_empty() {
                args.push("--merged-base".to_string());
                args.push(merged_base.clone());
            }
        }

        self.last_error = None;

        // Build clean PATH for Windows
        let child_path = if cfg!(target_os = "windows") {
            let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
            let python_dir = std::path::Path::new(python_exe)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            format!(
                "{};{}\\System32;{};{}\\System32\\Wbem",
                python_dir, system_root, system_root, system_root
            )
        } else {
            std::env::var("PATH").unwrap_or_default()
        };

        // Build environment
        let mut child_env: std::collections::HashMap<String, String> =
            std::env::vars().collect();
        child_env.insert("PATH".to_string(), child_path);
        child_env.insert(
            "TEXT_ENCODER_DEVICE".to_string(),
            config.text_encoder_device,
        );
        if let Some(ref hf_home) = config.hf_home {
            if !hf_home.is_empty() {
                child_env.insert("HF_HOME".to_string(), hf_home.clone());
            }
        }

        // Open log file
        let log_path = self.log_path();
        fs::create_dir_all(log_path.parent().unwrap()).ok();
        let log_content = format!(
            "\n--- ARDY start {} ---\n",
            chrono_like_now()
        );
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(log_content.as_bytes())
            })
            .ok();

        let child = Command::new(python_exe)
            .args(&args)
            .current_dir(&self.engine_dir)
            .envs(&child_env)
            .stdin(Stdio::null())
            .stdout(Stdio::from(fs::File::create(&log_path).map_err(|e| e.to_string())?))
            .stderr(Stdio::from(fs::File::options().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?))
            .spawn()
            .map_err(|e| format!("Failed to start ARDY engine: {}", e))?;

        self.child = Some(child);
        Ok(self.get_status())
    }

    pub fn stop(&mut self) -> ArdyStatus {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
        self.get_status()
    }

    pub fn setup(&self) -> Result<serde_json::Value, String> {
        let platform = std::env::consts::OS;
        let script_name = match platform {
            "macos" => "install_mac.sh",
            "linux" => "install_linux.sh",
            _ => "install.ps1",
        };

        let script = self.engine_dir.join(script_name);
        if !script.exists() {
            return Err(format!("Setup script not found: {}", script.display()));
        }

        if platform == "macos" {
            Command::new("open")
                .args(["-a", "Terminal", script.to_string_lossy().as_ref()])
                .spawn()
                .ok();
            return Ok(serde_json::json!({"started": true}));
        }

        if platform == "linux" {
            return self.setup_linux(&script);
        }

        // Windows
        Command::new("cmd.exe")
            .args([
                "/c", "start", "ARDY Engine Setup",
                "powershell", "-ExecutionPolicy", "Bypass", "-File",
                script.to_string_lossy().as_ref(),
            ])
            .spawn()
            .ok();

        Ok(serde_json::json!({"started": true}))
    }

    fn setup_linux(&self, script: &std::path::Path) -> Result<serde_json::Value, String> {
        let terminals = [
            ("x-terminal-emulator", vec!["-e", "bash"]),
            ("gnome-terminal", vec!["--", "bash"]),
            ("konsole", vec!["-e", "bash"]),
            ("xfce4-terminal", vec!["-x", "bash"]),
            ("mate-terminal", vec!["--", "bash"]),
            ("tilix", vec!["-e", "bash"]),
            ("alacritty", vec!["-e", "bash"]),
            ("kitty", vec![]),
            ("xterm", vec!["-e", "bash"]),
        ];

        for (cmd, pre_args) in &terminals {
            if which(cmd) {
                let mut command = Command::new(cmd);
                for arg in pre_args {
                    command.arg(arg);
                }
                command.arg(script);
                if command.spawn().is_ok() {
                    return Ok(serde_json::json!({"started": true, "terminal": cmd}));
                }
            }
        }

        // Fallback: background execution
        let log_path = self.setup_log_path();
        fs::create_dir_all(log_path.parent().unwrap()).ok();
        let log_content = format!(
            "\n--- ARDY setup {} ---\n",
            chrono_like_now()
        );
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(log_content.as_bytes())
            })
            .ok();

        Command::new("bash")
            .arg(script)
            .current_dir(&self.engine_dir)
            .stdout(Stdio::from(fs::File::create(&log_path).ok().unwrap()))
            .stderr(Stdio::null())
            .spawn()
            .ok();

        Ok(serde_json::json!({
            "started": true,
            "background": true,
            "logPath": log_path.to_string_lossy()
        }))
    }
}

fn which(cmd: &str) -> bool {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let full_path = std::path::Path::new(dir).join(cmd);
            if full_path.exists() {
                return true;
            }
        }
    }
    false
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple UTC timestamp
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Approximate date (good enough for log timestamps)
    let year = 1970 + (days / 365) as u32;
    format!("{}-01-01T{:02}:{:02}:{:02}Z", year, hours, minutes, seconds)
}

pub struct ArdyClientState(pub Mutex<ArdyClient>);

#[tauri::command]
pub fn ardy_get_status(state: tauri::State<'_, ArdyClientState>) -> Result<ArdyStatus, String> {
    let client = state.0.lock().map_err(|e| e.to_string())?;
    Ok(client.get_status())
}

#[tauri::command]
pub fn ardy_start(state: tauri::State<'_, ArdyClientState>) -> Result<ArdyStatus, String> {
    let mut client = state.0.lock().map_err(|e| e.to_string())?;
    client.start()
}

#[tauri::command]
pub fn ardy_stop(state: tauri::State<'_, ArdyClientState>) -> Result<ArdyStatus, String> {
    let mut client = state.0.lock().map_err(|e| e.to_string())?;
    Ok(client.stop())
}

#[tauri::command]
pub fn ardy_setup(state: tauri::State<'_, ArdyClientState>) -> Result<serde_json::Value, String> {
    let client = state.0.lock().map_err(|e| e.to_string())?;
    client.setup()
}
