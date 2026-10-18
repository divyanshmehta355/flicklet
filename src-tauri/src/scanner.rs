use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
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
