mod ardy_client;
mod codex_client;

use ardy_client::{ArdyClient, ArdyClientState};
use codex_client::{CodexClient, CodexClientState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Initialize Codex client
            let codex_client = CodexClient::new(
                "codex".to_string(),
                std::env::temp_dir().to_string_lossy().to_string(),
            );
            app.manage(CodexClientState(std::sync::Mutex::new(codex_client)));

            // Initialize ARDY client
            let user_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let engine_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default())
                .join("tools")
                .join("ardy-engine");

            // Fallback: in dev mode, use project root
            let engine_dir = if engine_dir.exists() {
                engine_dir
            } else {
                std::env::current_dir()
                    .unwrap_or_default()
                    .join("tools")
                    .join("ardy-engine")
            };

            let ardy_client = ArdyClient::new(user_data_dir, engine_dir);
            app.manage(ArdyClientState(std::sync::Mutex::new(ardy_client)));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            codex_client::codex_get_status,
            codex_client::codex_list_models,
            codex_client::codex_generate_motion,
            codex_client::codex_login,
            codex_client::codex_logout,
            ardy_client::ardy_get_status,
            ardy_client::ardy_start,
            ardy_client::ardy_stop,
            ardy_client::ardy_setup,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Clean up on window close
                if let Some(state) = window.try_state::<CodexClientState>() {
                    if let Ok(mut client) = state.0.lock() {
                        client.close();
                    }
                }
                if let Some(state) = window.try_state::<ArdyClientState>() {
                    if let Ok(mut client) = state.0.lock() {
                        client.stop();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
