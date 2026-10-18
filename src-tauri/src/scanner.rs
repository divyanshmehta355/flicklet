use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

// Common video extensions supported by Flicklet
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "webm", "m4v", "mpg", "mpeg", "ts", "3gp",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredVideo {
    pub name: String,
    pub path: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_timestamp: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub root_folder: String,
    pub total_count: usize,
    pub videos: Vec<DiscoveredVideo>,
}

pub fn scan_directory_recursive(root: &Path) -> Result<Vec<DiscoveredVideo>, String> {
    let mut results = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(current_dir) = stack.pop() {
        let entries = match fs::read_dir(&current_dir) {
            Ok(entries) => entries,
            Err(_) => {
                // Gracefully ignore directories we cannot access (permissions, locked, etc.)
                continue;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();

            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            // Avoid following symlinks and directory junctions to prevent loops or leaving root
            if file_type.is_symlink() {
                continue;
            }

            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_lower = ext.to_ascii_lowercase();
                    if VIDEO_EXTENSIONS.contains(&ext_lower.as_str()) {
                        let metadata = entry.metadata().ok();
                        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
                        let modified_timestamp = metadata.as_ref().and_then(|m| {
                            m.modified()
                                .ok()
                                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                .map(|d| d.as_secs())
                        });

                        let name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string();

                        results.push(DiscoveredVideo {
                            name,
                            path: path.to_string_lossy().to_string(),
                            extension: ext_lower,
                            size_bytes,
                            modified_timestamp,
                        });
                    }
                }
            }
        }
    }

    // Sort alphabetically by filename for consistent display
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(results)
}

#[tauri::command]
pub async fn scan_folder(folder_path: String) -> Result<ScanResult, String> {
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

    let total_count = videos.len();
    Ok(ScanResult {
        root_folder: folder_path,
        total_count,
        videos,
    })
}
