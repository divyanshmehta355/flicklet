mod db;
mod gemini;
mod organizer;
mod scanner;
mod tmdb;

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

#[tauri::command]
fn preview_organize(
    target_root: String,
    item_ids: Option<Vec<String>>,
    options: Option<organizer::OrganizeOptions>,
    db_state: State<'_, DbState>,
) -> Result<organizer::OrganizePreviewReport, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    let all_items = db::get_all_catalog_items(&conn).map_err(|e| e.to_string())?;

    let items_to_preview: Vec<CatalogItem> = match item_ids {
        Some(ids) => all_items.into_iter().filter(|i| ids.contains(&i.id)).collect(),
        None => all_items,
    };

    let opt = options.unwrap_or_default();
    Ok(organizer::generate_organize_preview(&target_root, &items_to_preview, &opt))
}

#[tauri::command]
fn execute_organize(
    plan: Vec<organizer::OrganizePlanItem>,
    double_confirmed: bool,
    options: Option<organizer::OrganizeOptions>,
    db_state: State<'_, DbState>,
) -> Result<organizer::OrganizeExecutionResult, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    let opt = options.unwrap_or_default();
    organizer::execute_organize_plan(&conn, &plan, double_confirmed, &opt)
}

#[tauri::command]
fn rollback_organize(
    batch_id: String,
    db_state: State<'_, DbState>,
) -> Result<usize, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    organizer::rollback_organization_batch(&conn, &batch_id)
}

#[tauri::command]
fn get_rollback_history(
    db_state: State<'_, DbState>,
) -> Result<Vec<db::RollbackBatchSummary>, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::get_recent_rollback_batches(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_tmdb_api_key_status(db_state: State<'_, DbState>) -> Result<ApiKeyStatus, String> {
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    match tmdb::resolve_tmdb_api_key(&conn) {
        Some((key, source)) => {
            let masked = if key.len() > 8 {
                format!("{}...{}", &key[..4], &key[key.len() - 4..])
            } else {
                "configured".to_string()
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
fn save_tmdb_api_key(api_key: String, db_state: State<'_, DbState>) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    let conn = db_state.0.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "tmdb_api_key", trimmed)
        .map_err(|e| format!("Failed to save TMDB API key: {}", e))
}

#[tauri::command]
async fn test_tmdb_connection(
    api_key: Option<String>,
    db_state: State<'_, DbState>,
) -> Result<String, String> {
    let key_to_test = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            let conn = db_state.0.lock().map_err(|e| e.to_string())?;
            tmdb::resolve_tmdb_api_key(&conn)
                .map(|(k, _)| k)
                .ok_or_else(|| {
                    "No TMDB API key found in .env or settings. Please provide a key to test.".to_string()
                })?
        }
    };

    tmdb::test_tmdb_key(&key_to_test).await
}

enum IdentificationResult {
    Tmdb(tmdb::TmdbMediaDetails),
    Gemini(gemini::AiClassificationSuggestion),
}

fn apply_identification_result(
    conn: &rusqlite::Connection,
    item: &CatalogItem,
    result: IdentificationResult,
) -> Result<(), String> {
    match result {
        IdentificationResult::Tmdb(details) => {
            let is_unclassified = item.ai_status == "unclassified";
            let new_title = if (is_unclassified || details.series_title.is_some())
                && !details.title.trim().is_empty()
            {
                Some(details.title.as_str())
            } else {
                None
            };

            db::update_catalog_tmdb_metadata(
                conn,
                &item.id,
                details.poster_url.as_deref(),
                details.backdrop_url.as_deref(),
                details.overview.as_deref(),
                details.vote_average,
                Some(details.tmdb_id),
                new_title,
                details.release_year,
                details.media_type.as_deref(),
                details.series_title.as_deref(),
                details.season_number,
                details.episode_number,
                details.primary_genre.as_deref(),
            )
            .map_err(|e| format!("Failed to save TMDB metadata: {}", e))
        }
        IdentificationResult::Gemini(suggestion) => {
            db::update_catalog_metadata(
                conn,
                &item.id,
                &suggestion.display_title,
                suggestion.release_year,
                &suggestion.media_type,
                &suggestion.primary_genre,
                &suggestion.secondary_genres,
                suggestion.series_title.as_deref(),
                suggestion.season_number,
                suggestion.episode_number,
                "approved",
            )
            .map_err(|e| format!("Failed to save Gemini metadata: {}", e))
        }
    }
}

async fn resolve_media_identification(
    item: &CatalogItem,
    tmdb_key: Option<&str>,
    gemini_key: Option<&str>,
    client: &reqwest::Client,
    show_cache: &mut std::collections::HashMap<String, Option<tmdb::TmdbTvShowSummary>>,
    season_cache: &mut std::collections::HashMap<(i64, u32), std::collections::HashMap<u32, tmdb::TmdbSeasonEpisodeItem>>,
) -> Result<Option<IdentificationResult>, String> {
    if tmdb_key.is_none() && gemini_key.is_none() {
        return Err("Neither TMDB nor Gemini API key is configured. Please provide at least one API key in Settings or .env.".to_string());
    }

    let info = tmdb::parse_media_filename(&item.filename);
    let is_series_episode = (info.is_series || item.media_type == "series")
        && (info.season_number.is_some() || item.season_number.is_some())
        && (info.episode_number.is_some() || item.episode_number.is_some());

    let mut matched_details: Option<tmdb::TmdbMediaDetails> = None;

    if let Some(t_key) = tmdb_key {
        if is_series_episode {
            let season = info
                .season_number
                .or(item.season_number.map(|s| s as u32))
                .unwrap_or(1);
            let episode = info
                .episode_number
                .or(item.episode_number.map(|e| e as u32))
                .unwrap_or(1);
            let show_query = item.series_title.as_deref().unwrap_or(
                if !info.clean_title.is_empty() {
                    &info.clean_title
                } else {
                    &item.display_title
                },
            );

            let show_summary_opt = if let Some(cached) = show_cache.get(show_query) {
                cached.clone()
            } else {
                let fetched = tmdb::search_tmdb_tv_show(client, show_query, t_key)
                    .await
                    .ok()
                    .flatten();
                show_cache.insert(show_query.to_string(), fetched.clone());
                fetched
            };

            if let Some(show) = show_summary_opt {
                let season_key = (show.id, season);
                let episodes_map = if let Some(cached_season) = season_cache.get(&season_key) {
                    cached_season.clone()
                } else {
                    let fetched = tmdb::fetch_tmdb_season_episodes(client, show.id, season, t_key)
                        .await
                        .unwrap_or_default();
                    season_cache.insert(season_key, fetched.clone());
                    fetched
                };

                if let Some(ep_data) = episodes_map.get(&episode) {
                    let ep_title = ep_data.name.as_deref().unwrap_or("").trim();
                    let display_title = if !ep_title.is_empty()
                        && !ep_title.eq_ignore_ascii_case(&format!("Episode {}", episode))
                    {
                        format!("{} S{} E{}: {}", show.name, season, episode, ep_title)
                    } else {
                        format!("{} S{} E{}", show.name, season, episode)
                    };

                    let overview = ep_data
                        .overview
                        .as_deref()
                        .filter(|o| !o.trim().is_empty())
                        .map(|o| o.to_string())
                        .or_else(|| show.overview.clone());

                    let poster_url = ep_data
                        .still_path
                        .as_deref()
                        .map(|s| format!("https://image.tmdb.org/t/p/w500{}", s))
                        .or_else(|| show.poster_url.clone());

                    let backdrop_url = show.backdrop_url.clone().or_else(|| poster_url.clone());

                    let vote_average = if ep_data.vote_average.unwrap_or(0.0) > 0.0 {
                        ep_data.vote_average
                    } else {
                        show.vote_average
                    };

                    matched_details = Some(tmdb::TmdbMediaDetails {
                        tmdb_id: show.id,
                        title: display_title,
                        overview,
                        release_date: ep_data.air_date.clone().or(show.first_air_date.clone()),
                        release_year: show
                            .first_air_date
                            .as_deref()
                            .and_then(|d| d.split('-').next())
                            .and_then(|y| y.parse::<u32>().ok()),
                        poster_url,
                        backdrop_url,
                        vote_average,
                        media_type: Some("series".to_string()),
                        series_title: Some(show.name),
                        season_number: Some(season),
                        episode_number: Some(episode),
                        primary_genre: show.primary_genre,
                    });
                }
            }
        }

        if matched_details.is_none() {
            let title_to_search = if item.media_type == "series" {
                item.series_title.as_deref().unwrap_or(&item.display_title)
            } else {
                &item.display_title
            };
            matched_details = tmdb::search_tmdb(
                title_to_search,
                item.release_year,
                Some(&item.media_type),
                t_key,
            )
            .await
            .ok()
            .flatten();
        }
    }

    if let Some(details) = matched_details {
        return Ok(Some(IdentificationResult::Tmdb(details)));
    }

    // Direct TMDB lookup didn't match. If Gemini is available, use Gemini to parse & clean
    if let Some(g_key) = gemini_key {
        let path = Path::new(&item.path);
        let folder_context = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|f| f.to_str())
            .unwrap_or("");

        if let Ok(suggestion) = gemini::classify_media_text(g_key, &item.filename, folder_context).await {
            // Re-query TMDB using the clean title and year extracted by Gemini
            if let Some(t_key) = tmdb_key {
                let mut retry_tmdb: Option<tmdb::TmdbMediaDetails> = None;
                if suggestion.media_type == "series" || suggestion.season_number.is_some() {
                    let season = suggestion.season_number.unwrap_or(1);
                    let episode = suggestion.episode_number.unwrap_or(1);
                    let show_query = suggestion
                        .series_title
                        .as_deref()
                        .unwrap_or(&suggestion.display_title);
                    retry_tmdb = tmdb::search_tmdb_tv_episode(client, show_query, season, episode, t_key)
                        .await
                        .ok()
                        .flatten();
                }

                if retry_tmdb.is_none() {
                    retry_tmdb = tmdb::search_tmdb(
                        &suggestion.display_title,
                        suggestion.release_year,
                        Some(&suggestion.media_type),
                        t_key,
                    )
                    .await
                    .ok()
                    .flatten();
                }

                if let Some(details) = retry_tmdb {
                    return Ok(Some(IdentificationResult::Tmdb(details)));
                }
            }

            // Fallback to Gemini suggestion directly
            return Ok(Some(IdentificationResult::Gemini(suggestion)));
        }
    }

    Ok(None)
}

#[tauri::command]
async fn auto_identify_media_item(
    id: String,
    db_state: State<'_, DbState>,
) -> Result<CatalogItem, String> {
    let (item, tmdb_key, gemini_key) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let item = db::get_catalog_item_by_id(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Item not found in catalog".to_string())?;
        let tmdb_k = tmdb::resolve_tmdb_api_key(&conn).map(|(k, _)| k);
        let gemini_k = resolve_gemini_api_key(&conn).map(|(k, _)| k);
        (item, tmdb_k, gemini_k)
    };

    let client = reqwest::Client::new();
    let mut show_cache = std::collections::HashMap::new();
    let mut season_cache = std::collections::HashMap::new();

    let res = resolve_media_identification(
        &item,
        tmdb_key.as_deref(),
        gemini_key.as_deref(),
        &client,
        &mut show_cache,
        &mut season_cache,
    )
    .await?;

    if let Some(id_res) = res {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        apply_identification_result(&conn, &item, id_res)?;
        db::get_catalog_item_by_id(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Updated item not found".to_string())
    } else {
        Err(format!(
            "No metadata found on TMDB or Gemini AI for '{}'",
            item.display_title
        ))
    }
}

#[tauri::command]
async fn enrich_media_item_with_tmdb(
    id: String,
    db_state: State<'_, DbState>,
) -> Result<CatalogItem, String> {
    auto_identify_media_item(id, db_state).await
}

#[tauri::command]
async fn auto_identify_all_media(
    db_state: State<'_, DbState>,
) -> Result<usize, String> {
    let (items, tmdb_key, gemini_key) = {
        let conn = db_state.0.lock().map_err(|e| e.to_string())?;
        let items = db::get_all_catalog_items(&conn).map_err(|e| e.to_string())?;
        let tmdb_k = tmdb::resolve_tmdb_api_key(&conn).map(|(k, _)| k);
        let gemini_k = resolve_gemini_api_key(&conn).map(|(k, _)| k);
        (items, tmdb_k, gemini_k)
    };

    if tmdb_key.is_none() && gemini_key.is_none() {
        return Err("Neither TMDB nor Gemini API key is configured. Please add an API key in Settings or .env.".to_string());
    }

    let client = reqwest::Client::new();
    let mut show_cache = std::collections::HashMap::new();
    let mut season_cache = std::collections::HashMap::new();
    let mut identified_count = 0;

    for item in items {
        // Skip items that are already approved and have poster artwork
        if item.ai_status == "approved" && item.poster_url.is_some() {
            continue;
        }

        let res_opt = resolve_media_identification(
            &item,
            tmdb_key.as_deref(),
            gemini_key.as_deref(),
            &client,
            &mut show_cache,
            &mut season_cache,
        )
        .await
        .unwrap_or(None);

        if let Some(res) = res_opt {
            if let Ok(conn) = db_state.0.lock() {
                if apply_identification_result(&conn, &item, res).is_ok() {
                    identified_count += 1;
                }
            }
        }
    }

    Ok(identified_count)
}

#[tauri::command]
async fn enrich_all_catalog_items_with_tmdb(
    db_state: State<'_, DbState>,
) -> Result<usize, String> {
    auto_identify_all_media(db_state).await
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
            play_in_vlc,
            preview_organize,
            execute_organize,
            rollback_organize,
            get_rollback_history,
            get_tmdb_api_key_status,
            save_tmdb_api_key,
            test_tmdb_connection,
            enrich_media_item_with_tmdb,
            enrich_all_catalog_items_with_tmdb,
            auto_identify_media_item,
            auto_identify_all_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


