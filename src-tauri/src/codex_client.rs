use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MIN_CODEX_VERSION: [u32; 3] = [0, 144, 1];
const REQUEST_TIMEOUT_MS: u64 = 30_000;
const TURN_TIMEOUT_MS: u64 = 180_000;

const MOTION_BONE_NAMES: &[&str] = &[
    "hips", "spine", "chest", "upperChest", "neck", "head",
    "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
    "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
    "leftUpperLeg", "leftLowerLeg", "leftFoot",
    "rightUpperLeg", "rightLowerLeg", "rightFoot",
];

const MOTION_EXPRESSION_NAMES: &[&str] = &[
    "happy", "angry", "sad", "relaxed", "surprised", "neutral",
    "aa", "ih", "ou", "ee", "oh",
    "blink", "blinkLeft", "blinkRight",
    "lookUp", "lookDown", "lookLeft", "lookRight",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexStatus {
    pub available: bool,
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_openai_auth: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexModel {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateMotionRequest {
    pub model: String,
    pub system_prompt: String,
    pub prompt: String,
    pub refine_prompt: Option<String>,
    pub refine: Option<bool>,
}

pub struct CodexClient {
    command: String,
    cwd: String,
    process: Option<Child>,
    stdin: Option<std::process::ChildStdin>,
    stdout_reader: Option<BufReader<std::process::ChildStdout>>,
    request_id: u32,
    version: Option<String>,
}

impl CodexClient {
    pub fn new(command: String, cwd: String) -> Self {
        Self {
            command,
            cwd,
            process: None,
            stdin: None,
            stdout_reader: None,
            request_id: 0,
            version: None,
        }
    }

    pub fn detect_version(&self) -> Result<String, String> {
        let output = Command::new(&self.command)
            .arg("--version")
            .envs(std::env::vars())
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "Codex CLI is not installed. Install Codex CLI (0.144.1+) or switch to OpenAI API key mode.".to_string()
                } else {
                    format!("Failed to run codex --version: {}", e)
                }
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let version = stdout
            .trim()
            .split_whitespace()
            .find(|s| s.chars().next().map_or(false, |c| c.is_ascii_digit()))
            .ok_or("Could not parse Codex CLI version")?
            .to_string();

        Ok(version)
    }

    pub fn compare_version(version: &str) -> i32 {
        let parts: Vec<u32> = version
            .split('.')
            .filter_map(|s| s.parse().ok())
            .collect();
        for (i, &min_val) in MIN_CODEX_VERSION.iter().enumerate() {
            let part_val = parts.get(i).copied().unwrap_or(0);
            let diff = part_val as i32 - min_val as i32;
            if diff != 0 {
                return diff;
            }
        }
        0
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.process.is_some() {
            return Ok(());
        }

        let version = self.detect_version()?;
        if Self::compare_version(&version) < 0 {
            return Err(format!(
                "Codex CLI {} is too old. Update to 0.144.1 or later.",
                version
            ));
        }
        self.version = Some(version);

        let mut child = Command::new(&self.command)
            .args(["app-server", "--stdio"])
            .current_dir(&self.cwd)
            .envs(std::env::vars())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "Codex CLI is not installed. Install Codex CLI (0.144.1+) or switch to OpenAI API key mode.".to_string()
                } else {
                    format!("Failed to start Codex CLI: {}", e)
                }
            })?;

        let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let stdout_reader = BufReader::new(stdout);

        self.process = Some(child);
        self.stdin = Some(stdin);
        self.stdout_reader = Some(stdout_reader);

        let init_request = serde_json::json!({
            "method": "initialize",
            "id": self.next_request_id(),
            "params": {
                "clientInfo": {
                    "name": "text-to-vrma",
                    "title": "Text-To-VRMA",
                    "version": "1.0.0"
                }
            }
        });

        self.write_message(&init_request)?;

        let response = self.read_response()?;
        if let Some(error) = response.get("error") {
            return Err(error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Initialize failed")
                .to_string());
        }

        let initialized = serde_json::json!({
            "method": "initialized",
            "params": {}
        });
        self.write_message(&initialized)?;

        Ok(())
    }

    fn next_request_id(&mut self) -> u32 {
        self.request_id += 1;
        self.request_id
    }

    fn write_message(&mut self, message: &serde_json::Value) -> Result<(), String> {
        if let Some(stdin) = &mut self.stdin {
            let mut msg = serde_json::to_string(message).map_err(|e| e.to_string())?;
            msg.push('\n');
            stdin
                .write_all(msg.as_bytes())
                .map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn read_response(&mut self) -> Result<serde_json::Value, String> {
        if let Some(reader) = &mut self.stdout_reader {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
            if line.is_empty() {
                return Err("EOF from Codex process".to_string());
            }
            serde_json::from_str(&line).map_err(|e| format!("Invalid JSON: {}", e))
        } else {
            Err("No stdout".to_string())
        }
    }

    pub fn request(&mut self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_request_id();
        let request = serde_json::json!({
            "method": method,
            "id": id,
            "params": params
        });

        self.write_message(&request)?;

        let deadline = Instant::now() + Duration::from_millis(REQUEST_TIMEOUT_MS);
        loop {
            if Instant::now() > deadline {
                return Err(format!("Codex ({}) timed out", method));
            }

            let response = self.read_response()?;
            if let Some(resp_id) = response.get("id").and_then(|i| i.as_u64()) {
                if resp_id == id as u64 {
                    if let Some(error) = response.get("error") {
                        return Err(error
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error")
                            .to_string());
                    }
                    return Ok(response
                        .get("result")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null));
                }
            }
        }
    }

    pub fn get_status(&mut self) -> Result<CodexStatus, String> {
        self.start()?;
        let result = self.request("account/read", serde_json::json!({"refreshToken": false}))?;
        let account = result.get("account").cloned();
        let requires_openai_auth = result.get("requiresOpenaiAuth").cloned().and_then(|v| v.as_bool());
        Ok(CodexStatus {
            available: true,
            version: self.version.clone(),
            account,
            requires_openai_auth,
            error: None,
        })
    }

    pub fn login(&mut self) -> Result<serde_json::Value, String> {
        self.start()?;
        self.request(
            "account/login/start",
            serde_json::json!({
                "type": "chatgpt",
                "appBrand": "codex",
                "codexStreamlinedLogin": true,
                "useHostedLoginSuccessPage": true
            }),
        )
    }

    pub fn logout(&mut self) -> Result<CodexStatus, String> {
        self.start()?;
        self.request("account/logout", serde_json::json!({}))?;
        self.get_status()
    }

    pub fn list_models(&mut self) -> Result<Vec<CodexModel>, String> {
        self.start()?;
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let mut params = serde_json::json!({
                "includeHidden": false
            });
            if let Some(ref c) = cursor {
                params["cursor"] = serde_json::json!(c);
            }

            let result = self.request("model/list", params)?;
            if let Some(data) = result.get("data").and_then(|d| d.as_array()) {
                for item in data {
                    models.push(CodexModel {
                        id: item["id"].as_str().unwrap_or("").to_string(),
                        model: item["model"].as_str().unwrap_or("").to_string(),
                        display_name: item["displayName"].as_str().unwrap_or("").to_string(),
                        description: item["description"].as_str().unwrap_or("").to_string(),
                        is_default: item["isDefault"].as_bool().unwrap_or(false),
                    });
                }
            }
            cursor = result.get("nextCursor").and_then(|c| c.as_str()).map(|s| s.to_string());
            if cursor.is_none() {
                break;
            }
        }

        Ok(models)
    }

    pub fn generate_motion(
        &mut self,
        request: GenerateMotionRequest,
    ) -> Result<serde_json::Value, String> {
        if request.model.is_empty() || request.system_prompt.is_empty() || request.prompt.is_empty() {
            return Err("Invalid Codex generation request.".to_string());
        }

        self.start()?;

        let account = self.request("account/read", serde_json::json!({"refreshToken": true}))?;
        let account_type = account
            .get("account")
            .and_then(|a| a.get("type"))
            .and_then(|t| t.as_str());
        if account_type != Some("chatgpt") {
            return Err("Codex authentication required. Login with ChatGPT.".to_string());
        }

        let started = self.request(
            "thread/start",
            serde_json::json!({
                "model": request.model,
                "cwd": self.cwd,
                "baseInstructions": request.system_prompt,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "ephemeral": true
            }),
        )?;

        let thread_id = started["thread"]["id"]
            .as_str()
            .ok_or("Failed to get thread ID")?
            .to_string();

        let mut output = self.run_turn(&thread_id, &request.prompt, &request.model)?;

        if request.refine.unwrap_or(false) {
            if let Some(ref refine_prompt) = request.refine_prompt {
                if !refine_prompt.trim().is_empty() {
                    output = self.run_turn(&thread_id, refine_prompt, &request.model)?;
                }
            }
        }

        serde_json::from_str(&output).map_err(|_| "Invalid motion JSON from Codex".to_string())
    }

    fn run_turn(
        &mut self,
        thread_id: &str,
        text: &str,
        model: &str,
    ) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_millis(TURN_TIMEOUT_MS);

        self.request(
            "turn/start",
            serde_json::json!({
                "threadId": thread_id,
                "model": model,
                "effort": "low",
                "input": [{"type": "text", "text": text}],
                "outputSchema": self.build_output_schema()
            }),
        )?;

        let mut messages: Vec<String> = Vec::new();
        loop {
            if Instant::now() > deadline {
                return Err("Codex response timed out".to_string());
            }

            let response = self.read_response()?;
            let method = response.get("method").and_then(|m| m.as_str());

            if method == Some("item/completed") {
                if let Some(params) = response.get("params") {
                    if params.get("item").and_then(|i| i.get("type")).and_then(|t| t.as_str())
                        == Some("agentMessage")
                    {
                        if let Some(text) = params["item"]["text"].as_str() {
                            messages.push(text.to_string());
                        }
                    }
                }
            } else if method == Some("turn/completed") {
                if let Some(params) = response.get("params") {
                    let status = params["turn"]["status"].as_str();
                    if status == Some("completed") {
                        return messages
                            .last()
                            .cloned()
                            .ok_or("No output from Codex".to_string());
                    } else {
                        return Err(
                            params["turn"]["error"]["message"]
                                .as_str()
                                .unwrap_or("Codex generation failed")
                                .to_string(),
                        );
                    }
                }
            }
        }
    }

    fn build_output_schema(&self) -> serde_json::Value {
        let mut tracks_props = serde_json::Map::new();
        for &bone in MOTION_BONE_NAMES {
            tracks_props.insert(
                bone.to_string(),
                serde_json::json!({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["t", "r"],
                        "properties": {
                            "t": {"type": "number", "minimum": 0, "maximum": 20},
                            "r": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "number"}}
                        }
                    }
                }),
            );
        }

        let mut expr_props = serde_json::Map::new();
        for &expr in MOTION_EXPRESSION_NAMES {
            expr_props.insert(
                expr.to_string(),
                serde_json::json!({
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["t", "w"],
                        "properties": {
                            "t": {"type": "number", "minimum": 0, "maximum": 20},
                            "w": {"type": "number", "minimum": 0, "maximum": 1}
                        }
                    }
                }),
            );
        }

        serde_json::json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "duration", "loop", "tracks", "hips", "expressions"],
            "properties": {
                "name": {"type": "string"},
                "duration": {"type": "number", "exclusiveMinimum": 0, "maximum": 20},
                "loop": {"type": "boolean"},
                "tracks": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": MOTION_BONE_NAMES,
                    "properties": tracks_props
                },
                "hips": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["t", "p"],
                        "properties": {
                            "t": {"type": "number", "minimum": 0, "maximum": 20},
                            "p": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "number"}}
                        }
                    }
                },
                "expressions": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": MOTION_EXPRESSION_NAMES,
                    "properties": expr_props
                }
            }
        })
    }

    pub fn close(&mut self) {
        self.stdin.take();
        self.stdout_reader.take();
        if let Some(mut child) = self.process.take() {
            let _ = child.kill();
        }
    }
}

pub struct CodexClientState(pub Mutex<CodexClient>);

#[tauri::command]
pub fn codex_get_status(state: tauri::State<'_, CodexClientState>) -> Result<CodexStatus, String> {
    let mut client = state.0.lock().map_err(|e| e.to_string())?;
    client.get_status()
}

#[tauri::command]
pub fn codex_list_models(state: tauri::State<'_, CodexClientState>) -> Result<Vec<CodexModel>, String> {
    let mut client = state.0.lock().map_err(|e| e.to_string())?;
    client.list_models()
}

#[tauri::command]
pub fn codex_generate_motion(
    state: tauri::State<'_, CodexClientState>,
    request: GenerateMotionRequest,
) -> Result<serde_json::Value, String> {
    let mut client = state.0.lock().map_err(|e| e.to_string())?;
    client.generate_motion(request)
}

#[tauri::command]
pub fn codex_login(state: tauri::State<'_, CodexClientState>) -> Result<serde_json::Value, String> {
    let mut client = state.0.lock().map_err(|e| e.to_string())?;
    client.login()
}

#[tauri::command]
pub fn codex_logout(state: tauri::State<'_, CodexClientState>) -> Result<CodexStatus, String> {
    let mut client = state.0.lock().map_err(|e| e.to_string())?;
    client.logout()
}
