use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::scanner::DiscoveredVideo;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogItem {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub extension: String,
    pub size_bytes: u64,
    pub last_modified: Option<u64>,
    pub media_type: String, // "movie", "series", "unknown"
    pub display_title: String,
    pub release_year: Option<u32>,
    pub primary_genre: Option<String>,
    pub secondary_genres: Vec<String>,
    pub series_title: Option<String>,
    pub season_number: Option<u32>,
    pub episode_number: Option<u32>,
    pub is_favorite: bool,
    pub ai_status: String, // "unclassified", "classified", "reviewed"
    pub is_missing: bool,
    pub last_scan_time: u64,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub overview: Option<String>,
    pub vote_average: Option<f64>,
    pub tmdb_id: Option<i64>,
}

pub struct DbState(pub Mutex<Connection>);

impl DbState {
    pub fn new(db_path: &Path) -> SqlResult<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        init_schema(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }
}

fn init_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS media_catalog (
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            filename TEXT NOT NULL,
            extension TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            last_modified INTEGER,
            media_type TEXT NOT NULL DEFAULT 'unknown',
            display_title TEXT NOT NULL,
            release_year INTEGER,
            primary_genre TEXT,
            secondary_genres TEXT NOT NULL DEFAULT '[]',
            series_title TEXT,
            season_number INTEGER,
            episode_number INTEGER,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            ai_status TEXT NOT NULL DEFAULT 'unclassified',
            is_missing INTEGER NOT NULL DEFAULT 0,
            last_scan_time INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            poster_url TEXT,
            backdrop_url TEXT,
            overview TEXT,
            vote_average REAL,
            tmdb_id INTEGER
        )",
        [],
    )?;

    // Safe migration: add TMDB columns to existing databases if missing
    let _ = conn.execute("ALTER TABLE media_catalog ADD COLUMN poster_url TEXT", []);
    let _ = conn.execute("ALTER TABLE media_catalog ADD COLUMN backdrop_url TEXT", []);
    let _ = conn.execute("ALTER TABLE media_catalog ADD COLUMN overview TEXT", []);
    let _ = conn.execute("ALTER TABLE media_catalog ADD COLUMN vote_average REAL", []);
    let _ = conn.execute("ALTER TABLE media_catalog ADD COLUMN tmdb_id INTEGER", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_path ON media_catalog(path)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_favorite ON media_catalog(is_favorite)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_display_title ON media_catalog(display_title)",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS rollback_logs (
            id TEXT PRIMARY KEY,
            batch_id TEXT NOT NULL,
            original_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            catalog_item_id TEXT,
            timestamp INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_rollback_batch ON rollback_logs(batch_id)",
        [],
    )?;

    Ok(())
}

fn derive_initial_title(filename: &str) -> String {
    match filename.rfind('.') {
        Some(idx) => filename[..idx].to_string(),
        None => filename.to_string(),
    }
}

pub fn upsert_scanned_videos(
    conn: &Connection,
    root_folder: &str,
    videos: &[DiscoveredVideo],
) -> SqlResult<usize> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut select_stmt = conn.prepare("SELECT id FROM media_catalog WHERE path = ?1")?;
    let mut update_stmt = conn.prepare(
        "UPDATE media_catalog 
         SET size_bytes = ?1, last_modified = ?2, last_scan_time = ?3, is_missing = 0 
         WHERE path = ?4",
    )?;
    let mut insert_stmt = conn.prepare(
        "INSERT INTO media_catalog (
            id, path, filename, extension, size_bytes, last_modified,
            media_type, display_title, release_year, series_title,
            season_number, episode_number, last_scan_time, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
    )?;

    for v in videos {
        let exists = select_stmt.exists(params![v.path])?;
        if exists {
            update_stmt.execute(params![
                v.size_bytes as i64,
                v.modified_timestamp.map(|t| t as i64),
                now as i64,
                v.path,
            ])?;
        } else {
            let id = Uuid::new_v4().to_string();
            let info = crate::tmdb::parse_media_filename(&v.name);
            let (display_title, media_type, series_title, season_num, episode_num, release_year) =
                if info.is_series && info.season_number.is_some() && info.episode_number.is_some() {
                    let s = info.season_number.unwrap();
                    let e = info.episode_number.unwrap();
                    let title = format!("{} S{} E{}", info.clean_title, s, e);
                    (
                        title,
                        "series".to_string(),
                        Some(info.clean_title),
                        Some(s),
                        Some(e),
                        info.year,
                    )
                } else if !info.clean_title.is_empty() {
                    (
                        info.clean_title.clone(),
                        if info.is_series {
                            "series".to_string()
                        } else {
                            "movie".to_string()
                        },
                        if info.is_series {
                            Some(info.clean_title)
                        } else {
                            None
                        },
                        info.season_number,
                        info.episode_number,
                        info.year,
                    )
                } else {
                    (
                        derive_initial_title(&v.name),
                        "unknown".to_string(),
                        None,
                        None,
                        None,
                        None,
                    )
                };

            insert_stmt.execute(params![
                id,
                v.path,
                v.name,
                v.extension,
                v.size_bytes as i64,
                v.modified_timestamp.map(|t| t as i64),
                media_type,
                display_title,
                release_year,
                series_title,
                season_num,
                episode_num,
                now as i64,
                now as i64,
            ])?;
        }
    }

    // Detect missing files: any record whose path starts with root_folder but was not refreshed in this scan
    let root_prefix = format!("{}%", root_folder.trim_end_matches(['\\', '/']));
    conn.execute(
        "UPDATE media_catalog 
         SET is_missing = 1 
         WHERE path LIKE ?1 AND last_scan_time < ?2",
        params![root_prefix, now as i64],
    )?;

    Ok(videos.len())
}

pub fn get_all_catalog_items(conn: &Connection) -> SqlResult<Vec<CatalogItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, filename, extension, size_bytes, last_modified,
                media_type, display_title, release_year, primary_genre,
                secondary_genres, series_title, season_number, episode_number,
                is_favorite, ai_status, is_missing, last_scan_time,
                poster_url, backdrop_url, overview, vote_average, tmdb_id
         FROM media_catalog
         ORDER BY is_favorite DESC, display_title COLLATE NOCASE ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        let sec_genres_raw: String = row.get(10)?;
        let secondary_genres: Vec<String> =
            serde_json::from_str(&sec_genres_raw).unwrap_or_default();

        let size_raw: i64 = row.get(4)?;
        let mod_raw: Option<i64> = row.get(5)?;
        let scan_raw: i64 = row.get(17)?;

        Ok(CatalogItem {
            id: row.get(0)?,
            path: row.get(1)?,
            filename: row.get(2)?,
            extension: row.get(3)?,
            size_bytes: size_raw.max(0) as u64,
            last_modified: mod_raw.map(|m| m.max(0) as u64),
            media_type: row.get(6)?,
            display_title: row.get(7)?,
            release_year: row.get(8)?,
            primary_genre: row.get(9)?,
            secondary_genres,
            series_title: row.get(11)?,
            season_number: row.get(12)?,
            episode_number: row.get(13)?,
            is_favorite: row.get::<_, i64>(14)? == 1,
            ai_status: row.get(15)?,
            is_missing: row.get::<_, i64>(16)? == 1,
            last_scan_time: scan_raw.max(0) as u64,
            poster_url: row.get(18)?,
            backdrop_url: row.get(19)?,
            overview: row.get(20)?,
            vote_average: row.get(21)?,
            tmdb_id: row.get(22)?,
        })
    })?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    Ok(items)
}

pub fn toggle_item_favorite(conn: &Connection, id: &str) -> SqlResult<bool> {
    conn.execute(
        "UPDATE media_catalog 
         SET is_favorite = CASE WHEN is_favorite = 1 THEN 0 ELSE 1 END 
         WHERE id = ?1",
        params![id],
    )?;

    let mut stmt = conn.prepare("SELECT is_favorite FROM media_catalog WHERE id = ?1")?;
    let new_val: i64 = stmt.query_row(params![id], |row| row.get(0))?;
    Ok(new_val == 1)
}

pub fn get_setting(conn: &Connection, key: &str) -> SqlResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_catalog_item_by_id(conn: &Connection, id: &str) -> SqlResult<Option<CatalogItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, filename, extension, size_bytes, last_modified,
                media_type, display_title, release_year, primary_genre,
                secondary_genres, series_title, season_number, episode_number,
                is_favorite, ai_status, is_missing, last_scan_time,
                poster_url, backdrop_url, overview, vote_average, tmdb_id
         FROM media_catalog
         WHERE id = ?1",
    )?;

    let mut rows = stmt.query_map(params![id], |row| {
        let sec_genres_raw: String = row.get(10)?;
        let secondary_genres: Vec<String> =
            serde_json::from_str(&sec_genres_raw).unwrap_or_default();

        let size_raw: i64 = row.get(4)?;
        let mod_raw: Option<i64> = row.get(5)?;
        let scan_raw: i64 = row.get(17)?;

        Ok(CatalogItem {
            id: row.get(0)?,
            path: row.get(1)?,
            filename: row.get(2)?,
            extension: row.get(3)?,
            size_bytes: size_raw.max(0) as u64,
            last_modified: mod_raw.map(|m| m.max(0) as u64),
            media_type: row.get(6)?,
            display_title: row.get(7)?,
            release_year: row.get(8)?,
            primary_genre: row.get(9)?,
            secondary_genres,
            series_title: row.get(11)?,
            season_number: row.get(12)?,
            episode_number: row.get(13)?,
            is_favorite: row.get::<_, i64>(14)? == 1,
            ai_status: row.get(15)?,
            is_missing: row.get::<_, i64>(16)? == 1,
            last_scan_time: scan_raw.max(0) as u64,
            poster_url: row.get(18)?,
            backdrop_url: row.get(19)?,
            overview: row.get(20)?,
            vote_average: row.get(21)?,
            tmdb_id: row.get(22)?,
        })
    })?;

    if let Some(item_res) = rows.next() {
        Ok(Some(item_res?))
    } else {
        Ok(None)
    }
}

pub fn update_catalog_metadata(
    conn: &Connection,
    id: &str,
    display_title: &str,
    release_year: Option<u32>,
    media_type: &str,
    primary_genre: &str,
    secondary_genres: &[String],
    series_title: Option<&str>,
    season_number: Option<u32>,
    episode_number: Option<u32>,
    ai_status: &str,
) -> SqlResult<()> {
    let sec_json = serde_json::to_string(secondary_genres).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "UPDATE media_catalog
         SET display_title = ?1,
             release_year = ?2,
             media_type = ?3,
             primary_genre = ?4,
             secondary_genres = ?5,
             series_title = ?6,
             season_number = ?7,
             episode_number = ?8,
             ai_status = ?9
         WHERE id = ?10",
        params![
            display_title,
            release_year.map(|y| y as i64),
            media_type,
            primary_genre,
            sec_json,
            series_title,
            season_number.map(|s| s as i64),
            episode_number.map(|e| e as i64),
            ai_status,
            id,
        ],
    )?;
    Ok(())
}

pub fn update_catalog_tmdb_metadata(
    conn: &Connection,
    id: &str,
    poster_url: Option<&str>,
    backdrop_url: Option<&str>,
    overview: Option<&str>,
    vote_average: Option<f64>,
    tmdb_id: Option<i64>,
    display_title: Option<&str>,
    release_year: Option<u32>,
    media_type: Option<&str>,
    series_title: Option<&str>,
    season_number: Option<u32>,
    episode_number: Option<u32>,
    primary_genre: Option<&str>,
) -> SqlResult<()> {
    conn.execute(
        "UPDATE media_catalog
         SET poster_url = COALESCE(?1, poster_url),
             backdrop_url = COALESCE(?2, backdrop_url),
             overview = COALESCE(?3, overview),
             vote_average = COALESCE(?4, vote_average),
             tmdb_id = COALESCE(?5, tmdb_id),
             display_title = COALESCE(?6, display_title),
             release_year = COALESCE(?7, release_year),
             media_type = COALESCE(?8, media_type),
             series_title = COALESCE(?9, series_title),
             season_number = COALESCE(?10, season_number),
             episode_number = COALESCE(?11, episode_number),
             primary_genre = COALESCE(?12, primary_genre),
             ai_status = 'approved'
         WHERE id = ?13",
        params![
            poster_url,
            backdrop_url,
            overview,
            vote_average,
            tmdb_id,
            display_title,
            release_year.map(|y| y as i64),
            media_type,
            series_title,
            season_number.map(|s| s as i64),
            episode_number.map(|e| e as i64),
            primary_genre,
            id,
        ],
    )?;
    Ok(())
}

pub fn update_item_path(
    conn: &Connection,
    id: &str,
    new_path: &str,
    new_filename: &str,
) -> SqlResult<()> {
    conn.execute(
        "UPDATE media_catalog SET path = ?1, filename = ?2 WHERE id = ?3",
        params![new_path, new_filename, id],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackLogEntry {
    pub id: String,
    pub batch_id: String,
    pub original_path: String,
    pub target_path: String,
    pub catalog_item_id: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackBatchSummary {
    pub batch_id: String,
    pub timestamp: u64,
    pub file_count: usize,
}

pub fn record_rollback_entry(
    conn: &Connection,
    batch_id: &str,
    original_path: &str,
    target_path: &str,
    catalog_item_id: Option<&str>,
) -> SqlResult<()> {
    let id = Uuid::new_v4().to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO rollback_logs (id, batch_id, original_path, target_path, catalog_item_id, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, batch_id, original_path, target_path, catalog_item_id, now as i64],
    )?;
    Ok(())
}

pub fn get_rollback_batch_entries(
    conn: &Connection,
    batch_id: &str,
) -> SqlResult<Vec<RollbackLogEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, batch_id, original_path, target_path, catalog_item_id, timestamp
         FROM rollback_logs
         WHERE batch_id = ?1
         ORDER BY timestamp DESC",
    )?;

    let rows = stmt.query_map(params![batch_id], |row| {
        let ts: i64 = row.get(5)?;
        Ok(RollbackLogEntry {
            id: row.get(0)?,
            batch_id: row.get(1)?,
            original_path: row.get(2)?,
            target_path: row.get(3)?,
            catalog_item_id: row.get(4)?,
            timestamp: ts.max(0) as u64,
        })
    })?;

    let mut entries = Vec::new();
    for r in rows {
        entries.push(r?);
    }
    Ok(entries)
}

pub fn delete_rollback_batch(conn: &Connection, batch_id: &str) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM rollback_logs WHERE batch_id = ?1",
        params![batch_id],
    )?;
    Ok(())
}

pub fn get_recent_rollback_batches(
    conn: &Connection,
) -> SqlResult<Vec<RollbackBatchSummary>> {
    let mut stmt = conn.prepare(
        "SELECT batch_id, MAX(timestamp) as ts, COUNT(*) as cnt
         FROM rollback_logs
         GROUP BY batch_id
         ORDER BY ts DESC
         LIMIT 10",
    )?;

    let rows = stmt.query_map([], |row| {
        let ts: i64 = row.get(1)?;
        let cnt: i64 = row.get(2)?;
        Ok(RollbackBatchSummary {
            batch_id: row.get(0)?,
            timestamp: ts.max(0) as u64,
            file_count: cnt.max(0) as usize,
        })
    })?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r?);
    }
    Ok(list)
}


