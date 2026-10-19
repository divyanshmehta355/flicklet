use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::db;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmdbMediaDetails {
    pub tmdb_id: i64,
    pub title: String,
    pub overview: Option<String>,
    pub release_date: Option<String>,
    pub release_year: Option<u32>,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub vote_average: Option<f64>,
    pub media_type: Option<String>,
    pub series_title: Option<String>,
    pub season_number: Option<u32>,
    pub episode_number: Option<u32>,
    pub primary_genre: Option<String>,
}

pub fn map_tmdb_genre_id_to_name(id: i64) -> Option<&'static str> {
    match id {
        28 => Some("Action"),
        12 => Some("Adventure"),
        16 => Some("Animation"),
        35 => Some("Comedy"),
        80 => Some("Crime"),
        99 => Some("Documentary"),
        18 => Some("Drama"),
        10751 => Some("Family"),
        14 => Some("Fantasy"),
        36 => Some("History"),
        27 => Some("Horror"),
        10402 => Some("Musical"),
        9648 => Some("Mystery"),
        10749 => Some("Romance"),
        878 => Some("Science Fiction"),
        10770 => Some("Drama"),
        53 => Some("Thriller"),
        10752 => Some("War"),
        37 => Some("Western"),
        // TV specific
        10759 => Some("Action"),
        10762 => Some("Family"),
        10763 => Some("Documentary"),
        10764 => Some("Other"),
        10765 => Some("Science Fiction"),
        10766 => Some("Drama"),
        10767 => Some("Other"),
        10768 => Some("War"),
        _ => None,
    }
}

#[derive(Deserialize, Clone)]
pub struct TmdbSearchItem {
    pub id: i64,
    pub title: Option<String>,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub release_date: Option<String>,
    pub first_air_date: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub vote_average: Option<f64>,
    pub genre_ids: Option<Vec<i64>>,
}

#[derive(Deserialize)]
struct TmdbSearchResponse {
    pub results: Option<Vec<TmdbSearchItem>>,
}

#[derive(Deserialize, Clone)]
pub struct TmdbSeasonEpisodeItem {
    pub episode_number: u32,
    #[allow(dead_code)]
    pub season_number: Option<u32>,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub still_path: Option<String>,
    pub vote_average: Option<f64>,
    pub air_date: Option<String>,
}

#[derive(Deserialize)]
struct TmdbSeasonResponse {
    pub episodes: Option<Vec<TmdbSeasonEpisodeItem>>,
}

#[derive(Clone, Debug)]
pub struct TmdbTvShowSummary {
    pub id: i64,
    pub name: String,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub overview: Option<String>,
    pub vote_average: Option<f64>,
    pub first_air_date: Option<String>,
    pub primary_genre: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ExtractedMediaInfo {
    pub clean_title: String,
    pub year: Option<u32>,
    pub is_series: bool,
    pub season_number: Option<u32>,
    pub episode_number: Option<u32>,
}

/// Resolves the TMDB API key from process environment variables, .env file, or SQLite settings table
pub fn resolve_tmdb_api_key(conn: &rusqlite::Connection) -> Option<(String, String)> {
    // 1. Process environment variable
    if let Ok(key) = std::env::var("TMDB_API_KEY") {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some((
                trimmed.to_string(),
                "Environment variable (TMDB_API_KEY)".to_string(),
            ));
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
                    if k.trim() == "TMDB_API_KEY" {
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
    if let Ok(Some(db_key)) = db::get_setting(conn, "tmdb_api_key") {
        let trimmed = db_key.trim().to_string();
        if !trimmed.is_empty() {
            return Some((trimmed, "Local app settings".to_string()));
        }
    }

    None
}

/// Tests whether the TMDB API key is valid
pub async fn test_tmdb_key(api_key: &str) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Please enter a TMDB API key to test.".to_string());
    }

    let url = format!(
        "https://api.themoviedb.org/3/authentication?api_key={}",
        api_key.trim()
    );

    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to TMDB: {}", e))?;

    let status = res.status();
    if status.is_success() {
        Ok("TMDB API key is valid and connected!".to_string())
    } else {
        let text = res.text().await.unwrap_or_default();
        Err(format!(
            "TMDB authentication failed (HTTP {}): {}",
            status, text
        ))
    }
}

/// Intelligent parser for video filenames and raw release titles
pub fn parse_media_filename(raw: &str) -> ExtractedMediaInfo {
    let mut s = raw.to_string();

    // 1. Remove known release/piracy site tags
    let lower = s.to_lowercase();
    for site in [
        "vegamovie", "yts", "rarbg", "1337x", "torrent", "psa", "pahe", "galaxytv",
        "eztv", "tgx", "ettv", "cinevood", "katmovie",
    ] {
        if let Some(pos) = lower.find(site) {
            let slice = &s[..pos];
            if let Some(delim_pos) = slice.rfind(['-', '_', '[', '(', ' ']) {
                s.truncate(delim_pos);
            } else {
                s.truncate(pos);
            }
            break;
        }
    }

    // 2. Strip leading numbers like "2 - ", "2. ", "01 - "
    let bytes = s.as_bytes();
    let mut start_idx = 0;
    while start_idx < bytes.len() && bytes[start_idx].is_ascii_digit() {
        start_idx += 1;
    }
    if start_idx > 0 && start_idx < bytes.len() {
        let after_digits = &s[start_idx..];
        if after_digits.starts_with(" - ")
            || after_digits.starts_with(". ")
            || after_digits.starts_with("- ")
            || after_digits.starts_with(". ")
        {
            if let Some(first_letter) = after_digits.find(|c: char| c.is_alphabetic()) {
                s = after_digits[first_letter..].to_string();
            }
        }
    }

    // 3. Detect Season and Episode patterns: S01E01, S1 E2, 1x04
    let mut is_series = false;
    let mut season_opt: Option<u32> = None;
    let mut episode_opt: Option<u32> = None;
    let mut series_cutoff: Option<usize> = None;

    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();

    // Pattern 1: SxxExx or Sxx.Exx or Sxx - Exx or Sxx Exx
    for i in 0..len {
        let c_lower = chars[i].to_ascii_lowercase();
        if c_lower == 's' && i + 1 < len {
            let is_boundary = i == 0
                || chars[i - 1] == '.'
                || chars[i - 1] == ' '
                || chars[i - 1] == '_'
                || chars[i - 1] == '-';
            if is_boundary {
                let mut j = i + 1;
                while j < len && chars[j].is_ascii_digit() {
                    j += 1;
                }
                let s_digits: String = chars[i + 1..j].iter().collect();
                if !s_digits.is_empty() {
                    let mut e_idx = j;
                    while e_idx < len
                        && (chars[e_idx] == ' '
                            || chars[e_idx] == '.'
                            || chars[e_idx] == '_'
                            || chars[e_idx] == '-')
                    {
                        e_idx += 1;
                    }
                    if e_idx < len && chars[e_idx].to_ascii_lowercase() == 'e' {
                        let mut k = e_idx + 1;
                        while k < len && chars[k].is_ascii_digit() {
                            k += 1;
                        }
                        let e_digits: String = chars[e_idx + 1..k].iter().collect();
                        if !e_digits.is_empty() {
                            if let (Ok(s_num), Ok(e_num)) =
                                (s_digits.parse::<u32>(), e_digits.parse::<u32>())
                            {
                                is_series = true;
                                season_opt = Some(s_num);
                                episode_opt = Some(e_num);
                                series_cutoff = Some(i);
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Pattern 2: 1x05 or 01x05
        if c_lower == 'x'
            && i > 0
            && i + 1 < len
            && chars[i - 1].is_ascii_digit()
            && chars[i + 1].is_ascii_digit()
        {
            let mut s_start = i - 1;
            while s_start > 0 && chars[s_start - 1].is_ascii_digit() {
                s_start -= 1;
            }
            let is_boundary = s_start == 0
                || chars[s_start - 1] == '.'
                || chars[s_start - 1] == ' '
                || chars[s_start - 1] == '_';
            if is_boundary {
                let s_digits: String = chars[s_start..i].iter().collect();
                let mut e_end = i + 1;
                while e_end < len && chars[e_end].is_ascii_digit() {
                    e_end += 1;
                }
                let e_digits: String = chars[i + 1..e_end].iter().collect();
                if let (Ok(s_num), Ok(e_num)) =
                    (s_digits.parse::<u32>(), e_digits.parse::<u32>())
                {
                    is_series = true;
                    season_opt = Some(s_num);
                    episode_opt = Some(e_num);
                    series_cutoff = Some(s_start);
                    break;
                }
            }
        }
    }

    if let Some(cutoff) = series_cutoff {
        s.truncate(cutoff);
    }

    // 4. Detect 4-digit release year: 19xx or 20xx
    let mut detected_year: Option<u32> = None;
    let words: Vec<&str> = s
        .split(|c| c == '.' || c == '_' || c == ' ' || c == '-' || c == '[' || c == '(')
        .collect();
    for word in &words {
        let clean_word = word.trim_matches(['(', ')', '[', ']', '.', '_', '-']);
        if clean_word.len() == 4 {
            if let Ok(y) = clean_word.parse::<u32>() {
                if (1900..=2040).contains(&y) {
                    detected_year = Some(y);
                    if let Some(pos) = s.find(clean_word) {
                        s.truncate(pos);
                    }
                    break;
                }
            }
        }
    }

    // 5. Replace dots, underscores, dashes with spaces
    let mut cleaned = String::new();
    for c in s.chars() {
        if c == '.' || c == '_' || c == '-' {
            cleaned.push(' ');
        } else {
            cleaned.push(c);
        }
    }

    // 6. Remove quality / audio / release noise words
    let noise_words = [
        "720p", "1080p", "2160p", "4k", "bluray", "brrip", "bdrip", "web-dl",
        "webdl", "webrip", "web", "h264", "x264", "h265", "x265", "hevc",
        "10bit", "aac", "ac3", "dts", "ddp5", "ddp", "hindi", "english",
        "esub", "sub", "repack", "proper", "remastered", "dc", "extended",
        "unrated", "amzn", "nf", "hulu", "telesync", "camrip", "hdcam",
    ];

    let mut final_tokens = Vec::new();
    for token in cleaned.split_whitespace() {
        let t_clean = token.trim_matches(['(', ')', '[', ']', '{', '}', ',', '.']);
        let t_lower = t_clean.to_lowercase();
        if !noise_words.contains(&t_lower.as_str()) && !t_clean.is_empty() {
            final_tokens.push(t_clean);
        }
    }

    let clean_title = final_tokens.join(" ").trim().to_string();

    ExtractedMediaInfo {
        clean_title,
        year: detected_year,
        is_series,
        season_number: season_opt,
        episode_number: episode_opt,
    }
}

#[allow(dead_code)]
pub fn clean_title_for_search(raw: &str) -> (String, Option<u32>, bool) {
    let info = parse_media_filename(raw);
    (info.clean_title, info.year, info.is_series)
}

/// Search for a TV show by name on TMDB
pub async fn search_tmdb_tv_show(
    client: &reqwest::Client,
    show_name: &str,
    api_key: &str,
) -> Result<Option<TmdbTvShowSummary>, String> {
    let mut queries = vec![show_name.to_string()];
    if !show_name.to_lowercase().starts_with("the ") {
        queries.push(format!("The {}", show_name));
    }

    for q in queries {
        let url = "https://api.themoviedb.org/3/search/tv";
        let res = client
            .get(url)
            .header("Accept", "application/json")
            .query(&[("api_key", api_key.trim()), ("query", &q)])
            .send()
            .await
            .map_err(|e| format!("TMDB error: {}", e))?;

        if !res.status().is_success() {
            continue;
        }

        let parsed: TmdbSearchResponse = res
            .json()
            .await
            .map_err(|e| format!("Failed to parse TMDB response: {}", e))?;

        if let Some(results) = parsed.results {
            if let Some(first) = results.into_iter().next() {
                let name = first.name.unwrap_or_else(|| q.clone());
                let poster_url = first
                    .poster_path
                    .map(|p| format!("https://image.tmdb.org/t/p/w500{}", p));
                let backdrop_url = first
                    .backdrop_path
                    .map(|p| format!("https://image.tmdb.org/t/p/w1280{}", p));

                let primary_genre = first
                    .genre_ids
                    .as_ref()
                    .and_then(|ids| ids.first())
                    .and_then(|id| map_tmdb_genre_id_to_name(*id))
                    .map(|s| s.to_string());

                return Ok(Some(TmdbTvShowSummary {
                    id: first.id,
                    name,
                    poster_url,
                    backdrop_url,
                    overview: first.overview.filter(|o| !o.trim().is_empty()),
                    vote_average: first.vote_average,
                    first_air_date: first.first_air_date,
                    primary_genre,
                }));
            }
        }
    }

    Ok(None)
}

/// Fetch an entire season's episodes from TMDB in a single HTTP call
pub async fn fetch_tmdb_season_episodes(
    client: &reqwest::Client,
    show_id: i64,
    season_number: u32,
    api_key: &str,
) -> Result<HashMap<u32, TmdbSeasonEpisodeItem>, String> {
    let url = format!(
        "https://api.themoviedb.org/3/tv/{}/season/{}",
        show_id, season_number
    );

    let res = client
        .get(&url)
        .header("Accept", "application/json")
        .query(&[("api_key", api_key.trim())])
        .send()
        .await
        .map_err(|e| format!("TMDB season error: {}", e))?;

    if !res.status().is_success() {
        return Ok(HashMap::new());
    }

    let parsed: TmdbSeasonResponse = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse season response: {}", e))?;

    let mut map = HashMap::new();
    if let Some(episodes) = parsed.episodes {
        for ep in episodes {
            map.insert(ep.episode_number, ep);
        }
    }
    Ok(map)
}

/// Fetches exact episode metadata: title ("Legacies S1 E1: This Is the Part Where You Run"),
/// unique episode synopsis, episode still photo, and episode community rating.
pub async fn search_tmdb_tv_episode(
    client: &reqwest::Client,
    show_name: &str,
    season: u32,
    episode: u32,
    api_key: &str,
) -> Result<Option<TmdbMediaDetails>, String> {
    let show = match search_tmdb_tv_show(client, show_name, api_key).await? {
        Some(s) => s,
        None => return Ok(None),
    };

    let season_map = fetch_tmdb_season_episodes(client, show.id, season, api_key).await?;

    if let Some(ep_data) = season_map.get(&episode) {
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

        let parsed_year = ep_data
            .air_date
            .as_deref()
            .or(show.first_air_date.as_deref())
            .and_then(|d| d.split('-').next())
            .and_then(|y| y.parse::<u32>().ok());

        Ok(Some(TmdbMediaDetails {
            tmdb_id: show.id,
            title: display_title,
            overview,
            release_date: ep_data.air_date.clone().or(show.first_air_date.clone()),
            release_year: parsed_year,
            poster_url,
            backdrop_url,
            vote_average,
            media_type: Some("series".to_string()),
            series_title: Some(show.name),
            season_number: Some(season),
            episode_number: Some(episode),
            primary_genre: show.primary_genre.clone(),
        }))
    } else {
        // Fallback to show-level info with proper S1 E1 naming
        let display_title = format!("{} S{} E{}", show.name, season, episode);
        Ok(Some(TmdbMediaDetails {
            tmdb_id: show.id,
            title: display_title,
            overview: show.overview,
            release_date: show.first_air_date.clone(),
            release_year: show
                .first_air_date
                .as_deref()
                .and_then(|d| d.split('-').next())
                .and_then(|y| y.parse::<u32>().ok()),
            poster_url: show.poster_url,
            backdrop_url: show.backdrop_url,
            vote_average: show.vote_average,
            media_type: Some("series".to_string()),
            series_title: Some(show.name),
            season_number: Some(season),
            episode_number: Some(episode),
            primary_genre: show.primary_genre.clone(),
        }))
    }
}

fn map_search_item_to_details(
    item: TmdbSearchItem,
    fallback_query: &str,
    fallback_year: Option<u32>,
    is_series: bool,
) -> TmdbMediaDetails {
    let matched_title = item
        .title
        .or(item.name)
        .unwrap_or_else(|| fallback_query.to_string());

    let date_str = item.release_date.or(item.first_air_date);
    let parsed_year = date_str
        .as_deref()
        .and_then(|d| d.split('-').next())
        .and_then(|y| y.parse::<u32>().ok());

    let poster_url = item
        .poster_path
        .map(|p| format!("https://image.tmdb.org/t/p/w500{}", p));

    let backdrop_url = item
        .backdrop_path
        .map(|p| format!("https://image.tmdb.org/t/p/w1280{}", p));

    let primary_genre = item
        .genre_ids
        .as_ref()
        .and_then(|ids| ids.first())
        .and_then(|id| map_tmdb_genre_id_to_name(*id))
        .map(|s| s.to_string());

    TmdbMediaDetails {
        tmdb_id: item.id,
        title: matched_title,
        overview: item.overview.filter(|o| !o.trim().is_empty()),
        release_date: date_str,
        release_year: parsed_year.or(fallback_year),
        poster_url,
        backdrop_url,
        vote_average: item.vote_average,
        media_type: Some(if is_series {
            "series".to_string()
        } else {
            "movie".to_string()
        }),
        series_title: None,
        season_number: None,
        episode_number: None,
        primary_genre,
    }
}

/// Search for a movie or TV show on TMDB and return poster artwork and metadata
pub async fn search_tmdb(
    title: &str,
    year: Option<u32>,
    media_type: Option<&str>,
    api_key: &str,
) -> Result<Option<TmdbMediaDetails>, String> {
    if api_key.trim().is_empty() {
        return Err("TMDB API key is not configured.".to_string());
    }

    let info = parse_media_filename(title);
    let client = reqwest::Client::new();

    // 1. If this is a TV series episode (e.g. S1 E1 or S01E01), fetch exact episode metadata!
    if (info.is_series || media_type == Some("series"))
        && info.season_number.is_some()
        && info.episode_number.is_some()
    {
        let query_show = if !info.clean_title.is_empty() {
            &info.clean_title
        } else {
            title
        };

        if let Ok(Some(ep_details)) = search_tmdb_tv_episode(
            &client,
            query_show,
            info.season_number.unwrap(),
            info.episode_number.unwrap(),
            api_key,
        )
        .await
        {
            return Ok(Some(ep_details));
        }
    }

    // 2. Otherwise search general movie or TV endpoint
    let is_series = media_type
        .map(|m| m.eq_ignore_ascii_case("series") || m.eq_ignore_ascii_case("tv"))
        .unwrap_or(false)
        || info.is_series;

    let target_year = year.or(info.year);
    let primary_endpoint = if is_series { "tv" } else { "movie" };
    let secondary_endpoint = if is_series { "movie" } else { "tv" };

    let mut queries = Vec::new();
    if !info.clean_title.is_empty() {
        queries.push(info.clean_title.clone());
    }
    if !queries.contains(&title.to_string()) && !title.trim().is_empty() {
        queries.push(title.trim().to_string());
    }
    if !info.clean_title.is_empty() && !info.clean_title.to_lowercase().starts_with("the ") {
        queries.push(format!("The {}", info.clean_title));
    }

    for q in &queries {
        if let Ok(Some(item)) =
            execute_search(&client, primary_endpoint, q, target_year, api_key).await
        {
            return Ok(Some(map_search_item_to_details(
                item,
                q,
                target_year,
                is_series,
            )));
        }

        if target_year.is_some() {
            if let Ok(Some(item)) =
                execute_search(&client, primary_endpoint, q, None, api_key).await
            {
                return Ok(Some(map_search_item_to_details(
                    item,
                    q,
                    target_year,
                    is_series,
                )));
            }
        }

        if let Ok(Some(item)) =
            execute_search(&client, secondary_endpoint, q, target_year, api_key).await
        {
            return Ok(Some(map_search_item_to_details(
                item,
                q,
                target_year,
                !is_series,
            )));
        }

        if target_year.is_some() {
            if let Ok(Some(item)) =
                execute_search(&client, secondary_endpoint, q, None, api_key).await
            {
                return Ok(Some(map_search_item_to_details(
                    item,
                    q,
                    target_year,
                    !is_series,
                )));
            }
        }
    }

    Ok(None)
}

async fn execute_search(
    client: &reqwest::Client,
    endpoint: &str,
    query: &str,
    year_opt: Option<u32>,
    api_key: &str,
) -> Result<Option<TmdbSearchItem>, String> {
    let url = format!("https://api.themoviedb.org/3/search/{}", endpoint);

    let mut req = client
        .get(&url)
        .header("Accept", "application/json")
        .query(&[("api_key", api_key.trim()), ("query", query)]);

    let year_str;
    if let Some(y) = year_opt {
        year_str = y.to_string();
        if endpoint == "movie" {
            req = req.query(&[("year", &year_str)]);
        } else {
            req = req.query(&[("first_air_date_year", &year_str)]);
        }
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("TMDB request error: {}", e))?;

    if !res.status().is_success() {
        return Ok(None);
    }

    let parsed: TmdbSearchResponse = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse TMDB response: {}", e))?;

    Ok(parsed.results.and_then(|mut r| {
        if !r.is_empty() {
            Some(r.remove(0))
        } else {
            None
        }
    }))
}
