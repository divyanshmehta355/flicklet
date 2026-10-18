mod db;
mod gemini;
mod scanner;

use db::{CatalogItem, DbState};
use gemini::AiClassificationSuggestion;
use scanner::scan_directory_recursive;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

#[derive(Serialize, Deserialize)]
pub struct ApiKeyStatus {
    pub has_key: bool,
    pub source: String,
    pub masked_key: String,
}

/// Resolves the Gemini API key from process environment variables, .env file, or SQLite settings table
pub fn resolve_gemini_api_key(conn: &rusqlite::Connection) -> Option<(String, String)> {
    // 1. Process environment variable (e.g. from launch shell or IDE)
    if let Ok(key) = std::env::var("GEMINI_API_KEY") {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some((trimmed.to_string(), "Environment variable (GEMINI_API_KEY)".to_string()));
        }
    }

    // 2. Check .env file in root, cwd ancestors, and parent directories
    let mut candidates = vec![
        PathBuf::from(".env"),
        PathBuf::from("../.env"),
        PathBuf::from("src-tauri/.env"),
    ];

    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            let p = ancestor.join(".env");
            if !candidates.contains(&p) {
                candidates.push(p);
            }
        }
    }

    for candidate in &candidates {
        if let Ok(contents) = std::fs::read_to_string(candidate) {
            for line in contents.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with('#') || trimmed.is_empty() {
                    continue;
                }
                if let Some((k, v)) = trimmed.split_once('=') {
                    if k.trim() == "GEMINI_API_KEY" {
                        let clean_val = v.trim().trim_matches(['"', '\'']);
                        if !clean_val.is_empty() {
                            return Some((
                                clean_val.to_string(),
                                format!(".env file ({})", candidate.display()),
                            ));
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback to local SQLite settings table
    if let Ok(Some(db_key)) = db::get_setting(conn, "gemini_api_key") {
        let trimmed = db_key.trim();
        if !trimmed.is_empty() {
            return Some((trimmed.to_string(), "Local database settings".to_string()));
        }
    }

    None
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn scan_folder(
    folder_path: String,
    db_state: State<'_, DbState>,
) -> Result<Vec<CatalogItem>, String> {
    let path = PathBuf::from(&folder_path);
    if !path.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }
    if !path.is_dir() {
        return Err(format!("Selected path is not a directory: {}", folder_path));
    }

    let root_clone = path.clone();
    let videos = tauri::async_runtime::spawn_blocking(move || {
        scan_directory_recursive(&root_clone)
    })
    .await
    .map_err(|e| format!("Scan task error: {}", e))??;

    // Upsert discovered videos into persistent SQLite catalog
    {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        db::upsert_scanned_videos(&conn, &folder_path, &videos)
            .map_err(|e| format!("Database sync error: {}", e))?;
    }

    // Return the full updated catalog from SQLite
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::get_all_catalog_items(&conn).map_err(|e| format!("Failed to fetch catalog: {}", e))
}

#[tauri::command]
fn get_catalog(db_state: State<'_, DbState>) -> Result<Vec<CatalogItem>, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::get_all_catalog_items(&conn).map_err(|e| format!("Failed to fetch catalog: {}", e))
}

#[tauri::command]
fn toggle_favorite(id: String, db_state: State<'_, DbState>) -> Result<bool, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::toggle_item_favorite(&conn, &id).map_err(|e| format!("Failed to update favorite: {}", e))
}

#[tauri::command]
fn save_gemini_api_key(api_key: String, db_state: State<'_, DbState>) -> Result<(), String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "gemini_api_key", api_key.trim())
        .map_err(|e| format!("Failed to save API key: {}", e))
}

#[tauri::command]
fn get_gemini_api_key_status(db_state: State<'_, DbState>) -> Result<ApiKeyStatus, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    match resolve_gemini_api_key(&conn) {
        Some((k, source)) => {
            let masked = if k.len() > 8 {
                format!("{}...{}", &k[..4], &k[k.len() - 4..])
            } else {
                "••••••••".to_string()
            };
            Ok(ApiKeyStatus {
                has_key: true,
                source,
                masked_key: masked,
            })
        }
        None => Ok(ApiKeyStatus {
            has_key: false,
            source: "none".to_string(),
            masked_key: String::new(),
        }),
    }
}

#[tauri::command]
async fn test_gemini_connection(
    api_key: Option<String>,
    db_state: State<'_, DbState>,
) -> Result<String, String> {
    let key_to_test = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            let conn = db_state.0.lock().map_err(|e| e.to_string())?;
            resolve_gemini_api_key(&conn)
                .map(|(k, _)| k)
                .ok_or_else(|| {
                    "No Gemini API key found in .env or settings. Please provide a key to test.".to_string()
                })?
        }
    };

    gemini::test_gemini_key(&key_to_test).await
}

#[tauri::command]
async fn classify_media_item(
    id: String,
    db_state: State<'_, DbState>,
) -> Result<AiClassificationSuggestion, String> {
    let (item, api_key) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let item = db::get_catalog_item_by_id(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Item not found in catalog".to_string())?;
        let key = resolve_gemini_api_key(&conn)
            .map(|(k, _)| k)
            .ok_or_else(|| {
                "Gemini API key is not configured. Add GEMINI_API_KEY to your .env file or enter it in Settings.".to_string()
            })?;
        (item, key)
    };

    // Extract parent directory name for helpful context
    let path = Path::new(&item.path);
    let folder_context = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|f| f.to_str())
        .unwrap_or("");

    gemini::classify_media_text(&api_key, &item.filename, folder_context).await
}

#[tauri::command]
fn save_classified_metadata(
    id: String,
    metadata: AiClassificationSuggestion,
    db_state: State<'_, DbState>,
) -> Result<CatalogItem, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::update_catalog_metadata(
        &conn,
        &id,
        &metadata.display_title,
        metadata.release_year,
        &metadata.media_type,
        &metadata.primary_genre,
        &metadata.secondary_genres,
        metadata.series_title.as_deref(),
        metadata.season_number,
        metadata.episode_number,
        "approved",
    )
    .map_err(|e| format!("Failed to save metadata: {}", e))?;

    db::get_catalog_item_by_id(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Updated item not found".to_string())
}

#[tauri::command]
async fn ask_scene_assistant(
    question: String,
    db_state: State<'_, DbState>,
) -> Result<gemini::SceneSearchResult, String> {
    let (catalog_summary, api_key) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let items = db::get_all_catalog_items(&conn).map_err(|e| e.to_string())?;
        let key = resolve_gemini_api_key(&conn)
            .map(|(k, _)| k)
            .ok_or_else(|| {
                "Gemini API key is not configured. Add GEMINI_API_KEY to your .env file or enter it in Settings.".to_string()
            })?;

        let summary: Vec<serde_json::Value> = items
            .iter()
            .map(|item| {
                serde_json::json!({
                    "id": item.id,
                    "title": item.display_title,
                    "year": item.release_year,
                    "genre": item.primary_genre,
                    "media_type": item.media_type,
                    "filename": item.filename,
                })
            })
            .collect();

        (serde_json::to_string(&summary).unwrap_or_default(), key)
    };

    gemini::search_scene(&api_key, &question, &catalog_summary).await
}

pub fn find_vlc_executable() -> Option<PathBuf> {
    let standard_paths = [
        r"C:\Program Files\VideoLAN\VLC\vlc.exe",
        r"C:\Program Files (x86)\VideoLAN\VLC\vlc.exe",
    ];

    for p in &standard_paths {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
    }

    if let Ok(output) = std::process::Command::new("where.exe").arg("vlc.exe").output() {
        if output.status.success() {
            if let Ok(s) = String::from_utf8(output.stdout) {
                if let Some(first_line) = s.lines().next() {
                    let path = PathBuf::from(first_line.trim());
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
fn check_vlc_installed() -> bool {
    find_vlc_executable().is_some()
}

#[tauri::command]
fn play_in_vlc(file_path: String, start_time_seconds: Option<u64>) -> Result<(), String> {
    let file = PathBuf::from(&file_path);
    if !file.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    let vlc = find_vlc_executable().ok_or_else(|| {
        "VLC is not installed at standard paths. You can install it from https://videolan.org or open with your default player.".to_string()
    })?;

    let mut cmd = std::process::Command::new(vlc);
    if let Some(sec) = start_time_seconds {
        cmd.arg(format!("--start-time={}", sec));
    }
    cmd.arg(&file_path);

    cmd.spawn()
        .map_err(|e| format!("Failed to launch VLC: {}", e))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app data directory: {}", e))?;
            std::fs::create_dir_all(&app_data)
                .map_err(|e| format!("Failed to create app data directory: {}", e))?;

            let db_path = app_data.join("flicklet.db");
            let db_state = DbState::new(&db_path)
                .map_err(|e| format!("Failed to initialize SQLite database: {}", e))?;
            app.manage(db_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            scan_folder,
            get_catalog,
            toggle_favorite,
            save_gemini_api_key,
            get_gemini_api_key_status,
            test_gemini_connection,
            classify_media_item,
            save_classified_metadata,
            ask_scene_assistant,
            check_vlc_installed,
            play_in_vlc
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
