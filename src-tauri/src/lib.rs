mod db;
mod scanner;

use db::{CatalogItem, DbState};
use scanner::scan_directory_recursive;
use std::path::PathBuf;
use tauri::{Manager, State};

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
            toggle_favorite
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
