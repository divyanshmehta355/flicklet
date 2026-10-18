use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::db::{self, CatalogItem};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizePlanItem {
    pub id: String,
    pub source_path: String,
    pub target_path: String,
    pub proposed_relative_path: String,
    pub display_title: String,
    pub media_type: String,
    pub genre: String,
    pub year: Option<u32>,
    pub is_selected: bool,
    pub has_collision: bool,
    pub collision_resolution: String, // "keep_both", "skip", "overwrite"
    pub is_across_drives: bool,
    pub is_read_only: bool,
    pub is_system_path: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizePreviewReport {
    pub target_root: String,
    pub items: Vec<OrganizePlanItem>,
    pub total_files: usize,
    pub cross_drive_count: usize,
    pub collision_count: usize,
    pub blocked_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizeExecutionResult {
    pub batch_id: String,
    pub successful_moves: usize,
    pub failed_moves: usize,
    pub skipped_moves: usize,
    pub errors: Vec<String>,
}

/// Sanitize filename/folder components for Windows filesystem safety
pub fn sanitize_component(input: &str) -> String {
    let mut clean = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '<' | '>' | '"' | '|' | '?' | '*' => {}
            ':' => clean.push_str(" - "),
            '/' | '\\' => clean.push('-'),
            c if (c as u32) < 32 => {}
            c => clean.push(c),
        }
    }
    let trimmed = clean.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        let upper = trimmed.to_uppercase();
        let reserved = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
            "LPT9",
        ];
        if reserved.contains(&upper.as_str()) {
            format!("{}_item", trimmed)
        } else {
            trimmed.to_string()
        }
    }
}

/// Check if a path is located inside critical Windows system folders
pub fn is_system_or_dangerous_path(path: &Path) -> bool {
    let s = path.to_string_lossy().to_lowercase();
    let dangerous = [
        r"\windows\",
        r"\program files\",
        r"\program files (x86)\",
        r"\programdata\",
        r"\system volume information\",
        r"\$recycle.bin\",
        r"\appdata\",
    ];
    for d in dangerous {
        if s.contains(d) {
            return true;
        }
    }
    false
}

/// Check whether moving from src to dst crosses drive boundaries (e.g. C: -> D:)
pub fn is_cross_drive(src: &Path, dst: &Path) -> bool {
    let src_prefix = src.components().next();
    let dst_prefix = dst.components().next();
    src_prefix != dst_prefix
}

/// Build the structured proposed relative path per Section 10 rules
pub fn build_proposed_relative_path(item: &CatalogItem) -> (PathBuf, String) {
    let ext = item.extension.trim_start_matches('.').to_lowercase();
    let is_series = item.media_type.eq_ignore_ascii_case("series");

    if is_series {
        let series_name = sanitize_component(
            item.series_title
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&item.display_title),
        );
        let season_num = item.season_number.unwrap_or(1);
        let episode_num = item.episode_number.unwrap_or(1);
        let season_folder = format!("Season {:02}", season_num);

        let final_filename = format!(
            "{} - S{:02}E{:02}.{}",
            series_name, season_num, episode_num, ext
        );
        let rel_path = PathBuf::from("TV Shows")
            .join(&series_name)
            .join(&season_folder)
            .join(&final_filename);

        (rel_path, final_filename)
    } else {
        // Movies / {Genre} / {Title} ({Year}) / {Title} ({Year}).{ext}
        let genre = sanitize_component(
            item.primary_genre
                .as_deref()
                .filter(|g| !g.trim().is_empty() && !g.eq_ignore_ascii_case("unknown"))
                .unwrap_or("Other"),
        );
        let title = sanitize_component(&item.display_title);
        let folder_and_file_name = match item.release_year {
            Some(year) if year > 1880 && year < 2100 => format!("{} ({})", title, year),
            _ => title,
        };
        let final_filename = format!("{}.{}", folder_and_file_name, ext);
        let rel_path = PathBuf::from("Movies")
            .join(&genre)
            .join(&folder_and_file_name)
            .join(&final_filename);

        (rel_path, final_filename)
    }
}

/// Find an available unique path if collision resolution is "keep_both"
pub fn resolve_collision_path(target_path: &Path, existing_set: &HashSet<PathBuf>) -> PathBuf {
    if !target_path.exists() && !existing_set.contains(target_path) {
        return target_path.to_path_buf();
    }

    let parent = target_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = target_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = target_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    let mut counter = 1;
    loop {
        let candidate_name = format!("{} ({}){}", stem, counter, ext);
        let candidate = parent.join(&candidate_name);
        if !candidate.exists() && !existing_set.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

/// Generate a dry-run organization preview for the given items
pub fn generate_organize_preview(
    target_root: &str,
    items: &[CatalogItem],
) -> OrganizePreviewReport {
    let target_root_path = PathBuf::from(target_root);
    let mut plan_items = Vec::new();
    let mut planned_targets = HashSet::new();

    let mut cross_drive_count = 0;
    let mut collision_count = 0;
    let mut blocked_count = 0;

    for item in items {
        // Missing files on disk cannot be organized
        if item.is_missing {
            continue;
        }

        let source = PathBuf::from(&item.path);
        let (rel_path, _) = build_proposed_relative_path(item);
        let proposed_target = target_root_path.join(&rel_path);

        let is_system = is_system_or_dangerous_path(&source);
        let is_read_only = match fs::metadata(&source) {
            Ok(meta) => meta.permissions().readonly(),
            Err(_) => false,
        };

        let is_across = is_cross_drive(&source, &proposed_target);
        if is_across {
            cross_drive_count += 1;
        }

        let has_disk_collision = proposed_target.exists();
        let has_plan_collision = planned_targets.contains(&proposed_target);
        let has_collision = (has_disk_collision || has_plan_collision) && proposed_target != source;

        if has_collision {
            collision_count += 1;
        }

        let mut warning = None;
        if is_system {
            warning = Some("Blocked: File is located in a protected Windows system directory.".to_string());
            blocked_count += 1;
        } else if is_read_only {
            warning = Some("Blocked: File is marked read-only on disk.".to_string());
            blocked_count += 1;
        } else if is_across {
            warning = Some("Cross-drive move: File will be copied, size-verified, and removed from source.".to_string());
        } else if has_collision {
            warning = Some("Destination file already exists. Will append ' (1)' if kept.".to_string());
        }

        // Keep track of planned target
        planned_targets.insert(proposed_target.clone());

        plan_items.push(OrganizePlanItem {
            id: item.id.clone(),
            source_path: item.path.clone(),
            target_path: proposed_target.to_string_lossy().to_string(),
            proposed_relative_path: rel_path.to_string_lossy().to_string(),
            display_title: item.display_title.clone(),
            media_type: item.media_type.clone(),
            genre: item.primary_genre.clone().unwrap_or_else(|| "Other".to_string()),
            year: item.release_year,
            is_selected: !is_system && !is_read_only,
            has_collision,
            collision_resolution: "keep_both".to_string(),
            is_across_drives: is_across,
            is_read_only,
            is_system_path: is_system,
            warning,
        });
    }

    OrganizePreviewReport {
        target_root: target_root.to_string(),
        total_files: plan_items.len(),
        cross_drive_count,
        collision_count,
        blocked_count,
        items: plan_items,
    }
}

/// Execute file moves with strict safety checks, rollback logging, and database updates
pub fn execute_organize_plan(
    conn: &rusqlite::Connection,
    plan: &[OrganizePlanItem],
    double_confirmed: bool,
) -> Result<OrganizeExecutionResult, String> {
    if !double_confirmed {
        return Err("Explicit double confirmation is required before any files can be moved.".to_string());
    }

    let batch_id = Uuid::new_v4().to_string();
    let mut successful_moves = 0;
    let mut failed_moves = 0;
    let mut skipped_moves = 0;
    let mut errors = Vec::new();
    let mut allocated_targets = HashSet::new();

    for item in plan {
        if !item.is_selected {
            skipped_moves += 1;
            continue;
        }

        if item.is_system_path || item.is_read_only {
            skipped_moves += 1;
            errors.push(format!(
                "Skipped blocked file {}: system or read-only.",
                item.display_title
            ));
            continue;
        }

        let source = PathBuf::from(&item.source_path);
        if !source.exists() {
            failed_moves += 1;
            errors.push(format!(
                "Source file does not exist on disk: {}",
                item.source_path
            ));
            continue;
        }

        let mut target = PathBuf::from(&item.target_path);

        // If source is already at target, skip
        if source == target {
            skipped_moves += 1;
            continue;
        }

        // Handle collision resolution
        if (target.exists() || allocated_targets.contains(&target)) && target != source {
            match item.collision_resolution.as_str() {
                "skip" => {
                    skipped_moves += 1;
                    continue;
                }
                "keep_both" | _ => {
                    target = resolve_collision_path(&target, &allocated_targets);
                }
            }
        }

        allocated_targets.insert(target.clone());

        // Ensure parent directory exists
        if let Some(parent) = target.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                failed_moves += 1;
                errors.push(format!(
                    "Failed to create target folder {}: {}",
                    parent.display(),
                    e
                ));
                continue;
            }
        }

        let is_across = is_cross_drive(&source, &target);

        // Perform move operation
        let move_result: Result<(), String> = if is_across {
            // Rule 6 & Rule 9: Copy, verify size, then delete source
            match fs::copy(&source, &target) {
                Ok(copied_bytes) => {
                    let src_meta = fs::metadata(&source).map_err(|e| e.to_string())?;
                    if copied_bytes != src_meta.len() {
                        let _ = fs::remove_file(&target);
                        Err("Cross-drive copy byte count verification failed. Source file preserved.".to_string())
                    } else {
                        fs::remove_file(&source).map_err(|e| {
                            format!("Target copied successfully, but source deletion failed: {}", e)
                        })?;
                        Ok(())
                    }
                }
                Err(e) => Err(format!("Cross-drive copy failed: {}", e)),
            }
        } else {
            // Same filesystem: atomic rename
            fs::rename(&source, &target).map_err(|e| format!("Move failed: {}", e))
        };

        match move_result {
            Ok(()) => {
                let actual_target_str = target.to_string_lossy().to_string();
                let new_filename = target
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or(&item.display_title)
                    .to_string();

                // Record rollback log entry
                let _ = db::record_rollback_entry(
                    conn,
                    &batch_id,
                    &item.source_path,
                    &actual_target_str,
                    Some(&item.id),
                );

                // Update SQLite catalog item path
                let _ = db::update_item_path(conn, &item.id, &actual_target_str, &new_filename);

                successful_moves += 1;
            }
            Err(e) => {
                failed_moves += 1;
                errors.push(format!("Failed to move '{}': {}", item.display_title, e));
            }
        }
    }

    Ok(OrganizeExecutionResult {
        batch_id,
        successful_moves,
        failed_moves,
        skipped_moves,
        errors,
    })
}

/// Rollback an executed organization batch in reverse order
pub fn rollback_organization_batch(
    conn: &rusqlite::Connection,
    batch_id: &str,
) -> Result<usize, String> {
    let entries = db::get_rollback_batch_entries(conn, batch_id)
        .map_err(|e| format!("Failed to read rollback logs: {}", e))?;

    if entries.is_empty() {
        return Err(format!("No rollback records found for batch ID {}", batch_id));
    }

    let mut restored_count = 0;
    let mut rollback_errors = Vec::new();

    for entry in &entries {
        let current_path = PathBuf::from(&entry.target_path);
        let orig_path = PathBuf::from(&entry.original_path);

        if !current_path.exists() {
            rollback_errors.push(format!(
                "File at {} no longer exists to rollback",
                entry.target_path
            ));
            continue;
        }

        if let Some(parent) = orig_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let is_across = is_cross_drive(&current_path, &orig_path);
        let move_res = if is_across {
            match fs::copy(&current_path, &orig_path) {
                Ok(bytes) => {
                    let meta = fs::metadata(&current_path).map_err(|e| e.to_string())?;
                    if bytes == meta.len() {
                        let _ = fs::remove_file(&current_path);
                        Ok(())
                    } else {
                        let _ = fs::remove_file(&orig_path);
                        Err("Byte verification failed during rollback copy".to_string())
                    }
                }
                Err(e) => Err(format!("Rollback copy failed: {}", e)),
            }
        } else {
            fs::rename(&current_path, &orig_path).map_err(|e| format!("Rollback rename failed: {}", e))
        };

        if move_res.is_ok() {
            if let Some(item_id) = &entry.catalog_item_id {
                let orig_filename = orig_path
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or("")
                    .to_string();
                let _ = db::update_item_path(conn, item_id, &entry.original_path, &orig_filename);
            }
            restored_count += 1;
        } else if let Err(e) = move_res {
            rollback_errors.push(e);
        }
    }

    // Remove rollback batch from database now that it has been reversed
    let _ = db::delete_rollback_batch(conn, batch_id);

    if !rollback_errors.is_empty() {
        Err(format!(
            "Restored {} files with errors: {}",
            restored_count,
            rollback_errors.join("; ")
        ))
    } else {
        Ok(restored_count)
    }
}
