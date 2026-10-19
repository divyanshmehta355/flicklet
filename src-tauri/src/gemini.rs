use serde::{Deserialize, Serialize};

pub const VALID_GENRES: &[&str] = &[
    "Action",
    "Adventure",
    "Animation",
    "Comedy",
    "Crime",
    "Documentary",
    "Drama",
    "Fantasy",
    "Horror",
    "Mystery",
    "Romance",
    "Science Fiction",
    "Thriller",
    "Family",
    "Musical",
    "Other",
    "Unknown",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiClassificationSuggestion {
    pub display_title: String,
    pub release_year: Option<u32>,
    pub media_type: String, // "movie", "series", "unknown"
    pub primary_genre: String,
    pub secondary_genres: Vec<String>,
    pub series_title: Option<String>,
    pub season_number: Option<u32>,
    pub episode_number: Option<u32>,
    pub confidence: String, // "high", "medium", "low"
}

// Request and response models for Gemini REST API
#[derive(Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GenerationConfig {
    #[serde(rename = "responseMimeType")]
    response_mime_type: String,
}

#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "generationConfig")]
    generation_config: GenerationConfig,
}

#[derive(Deserialize)]
struct GeminiCandidatePart {
    text: Option<String>,
}

#[derive(Deserialize)]
struct GeminiCandidateContent {
    parts: Option<Vec<GeminiCandidatePart>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiCandidateContent>,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
    error: Option<GeminiErrorObj>,
}

#[derive(Deserialize)]
struct GeminiErrorObj {
    message: Option<String>,
}

pub const CANDIDATE_MODELS: &[&str] = &[
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.8-flash",
];

async fn execute_gemini_request<T: Serialize>(
    api_key: &str,
    body: &T,
) -> Result<String, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Gemini API key is not configured. Please add GEMINI_API_KEY to your .env file or Settings.".to_string());
    }

    let client = reqwest::Client::builder()
        .user_agent("Flicklet/1.0 (Desktop Cinema Organizer)")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut last_error = String::new();

    for &model in CANDIDATE_MODELS {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, key
        );

        let res = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await;

        match res {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    let text = response
                        .text()
                        .await
                        .map_err(|e| format!("Failed to read Gemini response: {}", e))?;
                    return Ok(text);
                }

                let text = response.text().await.unwrap_or_default();
                let err_msg = serde_json::from_str::<GeminiResponse>(&text)
                    .ok()
                    .and_then(|r| r.error)
                    .and_then(|e| e.message)
                    .unwrap_or(text);

                // If authentication failed or bad request, stop immediately and return clean error
                if status == reqwest::StatusCode::BAD_REQUEST
                    || status == reqwest::StatusCode::UNAUTHORIZED
                    || status == reqwest::StatusCode::FORBIDDEN
                {
                    return Err(format!("Gemini API error ({}): {}", status, err_msg));
                }

                // If 503 (high demand) or 404 (model unavailable), record and cascade to next model
                last_error = format!("Model '{}' returned HTTP {}: {}", model, status, err_msg);
            }
            Err(e) => {
                last_error = format!("Network connection error with model '{}': {}", model, e);
            }
        }
    }

    Err(format!(
        "Gemini API request failed across all candidate models. Last error: {}",
        last_error
    ))
}

pub async fn classify_media_text(
    api_key: &str,
    filename: &str,
    folder_context: &str,
) -> Result<AiClassificationSuggestion, String> {
    if api_key.trim().is_empty() {
        return Err(
            "Gemini API key is not configured. Please set your API key in Settings.".to_string(),
        );
    }

    let prompt = format!(
        r#"You are a film and television metadata specialist for Flicklet, a personal desktop cinema organizer.
Analyze the provided video filename and directory name to recognize the movie or TV series.
Do NOT guess information you are unsure of. If release year, series title, or season/episode cannot be reliably inferred, set them to null.

Input:
- Filename: "{filename}"
- Folder path / directory context: "{folder_context}"

Valid primary and secondary genres MUST be selected ONLY from this exact controlled taxonomy:
- Action
- Adventure
- Animation
- Comedy
- Crime
- Documentary
- Drama
- Fantasy
- Horror
- Mystery
- Romance
- Science Fiction
- Thriller
- Family
- Musical
- Other
- Unknown

Respond with a JSON object adhering to this schema:
{{
  "display_title": "Clean, human-readable title without release group, resolution, or codec tags",
  "release_year": 2024,
  "media_type": "movie",
  "primary_genre": "One exact genre from the taxonomy",
  "secondary_genres": ["Zero or more exact genres from the taxonomy"],
  "series_title": null,
  "season_number": null,
  "episode_number": null,
  "confidence": "high"
}}"#
    );

    let req_body = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart { text: prompt }],
        }],
        generation_config: GenerationConfig {
            response_mime_type: "application/json".to_string(),
        },
    };

    let text = execute_gemini_request(api_key, &req_body).await?;

    let parsed: GeminiResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Could not parse Gemini JSON response: {}", e))?;

    let raw_json_text = parsed
        .candidates
        .as_ref()
        .and_then(|c| c.first())
        .and_then(|cand| cand.content.as_ref())
        .and_then(|cont| cont.parts.as_ref())
        .and_then(|parts| parts.first())
        .and_then(|p| p.text.as_ref())
        .ok_or_else(|| "Gemini returned empty candidate content.".to_string())?;

    let mut suggestion: AiClassificationSuggestion = serde_json::from_str(raw_json_text)
        .map_err(|e| {
            format!(
                "AI output failed schema validation: {}. Raw: {}",
                e, raw_json_text
            )
        })?;

    // Validate genre taxonomy: if Gemini returned an unrecognized genre, fallback gracefully to "Other" or "Unknown"
    if !VALID_GENRES.contains(&suggestion.primary_genre.as_str()) {
        suggestion.primary_genre = "Other".to_string();
    }
    suggestion
        .secondary_genres
        .retain(|g| VALID_GENRES.contains(&g.as_str()));

    Ok(suggestion)
}

pub async fn test_gemini_key(api_key: &str) -> Result<String, String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("Please enter an API key to test.".to_string());
    }

    let req_body = serde_json::json!({
        "contents": [{
            "parts": [{ "text": "Ping. Answer with 'OK'." }]
        }]
    });

    execute_gemini_request(trimmed, &req_body).await?;
    Ok("Gemini API key is valid and connected!".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneSearchResult {
    pub catalog_item_id: Option<String>,
    pub matched_title: String,
    pub scene_summary: String,
    pub estimated_timestamp_seconds: Option<u64>,
    pub timestamp_formatted: Option<String>,
    pub is_estimate: bool,
    pub confidence: String,
    pub explanation: String,
}

pub async fn search_scene(
    api_key: &str,
    question: &str,
    catalog_summary_json: &str,
) -> Result<SceneSearchResult, String> {
    if api_key.trim().is_empty() {
        return Err(
            "Gemini API key is not configured. Please add GEMINI_API_KEY to your .env file or Settings.".to_string(),
        );
    }

    let prompt = format!(
        r#"You are Flicklet's cozy cinema assistant.
A user has asked a question about their personal movie and TV collection:
"{question}"

Here is the user's catalog of available titles:
{catalog_summary_json}

Instructions:
1. Identify which title in the catalog is being asked about or best matches the question/mood.
2. If the user is asking about a specific scene or plot event:
   - Provide a vivid, concise summary of the scene.
   - Provide an ESTIMATED timestamp in seconds and HH:MM:SS format where that scene typically occurs.
   - Note: Because you are working from film text and knowledge rather than inspecting the video stream, ALWAYS set is_estimate: true.
   - In explanation, state clearly why this is an estimate and note that home video editions, distributor intros, and frame rates may shift the timestamp slightly.
3. If the user is asking for a recommendation (e.g. "what should I watch tonight" or "something spooky"):
   - Match the best title from the catalog.
   - Explain why in a cozy, cinema-loving tone.
   - Leave estimated_timestamp_seconds and timestamp_formatted as null.

Respond ONLY with a JSON object adhering to this schema:
{{
  "catalog_item_id": "matched item ID from the catalog, or null",
  "matched_title": "Title Name",
  "scene_summary": "Scene description or recommendation summary",
  "estimated_timestamp_seconds": 3600,
  "timestamp_formatted": "01:00:00",
  "is_estimate": true,
  "confidence": "high" | "medium" | "low",
  "explanation": "Context and honest estimate note"
}}"#
    );

    let req_body = GeminiRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart { text: prompt }],
        }],
        generation_config: GenerationConfig {
            response_mime_type: "application/json".to_string(),
        },
    };

    let text = execute_gemini_request(api_key, &req_body).await?;

    let parsed: GeminiResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse Gemini response: {}", e))?;

    let raw_json_text = parsed
        .candidates
        .as_ref()
        .and_then(|c| c.first())
        .and_then(|cand| cand.content.as_ref())
        .and_then(|cont| cont.parts.as_ref())
        .and_then(|parts| parts.first())
        .and_then(|p| p.text.as_ref())
        .ok_or_else(|| "Gemini returned empty assistant response.".to_string())?;

    let result: SceneSearchResult = serde_json::from_str(raw_json_text)
        .map_err(|e| format!("Assistant response failed schema validation: {}. Raw: {}", e, raw_json_text))?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get_test_gemini_key() -> Option<String> {
        if let Ok(key) = std::env::var("GEMINI_API_KEY") {
            let t = key.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
        for path in [".env", "../.env", "src-tauri/.env"] {
            if let Ok(contents) = std::fs::read_to_string(path) {
                for line in contents.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        if k.trim() == "GEMINI_API_KEY" {
                            let clean = v.trim().trim_matches(['"', '\'']).to_string();
                            if !clean.is_empty() {
                                return Some(clean);
                            }
                        }
                    }
                }
            }
        }
        None
    }

    #[test]
    fn test_live_gemini() {
        let key = match get_test_gemini_key() {
            Some(k) => k,
            None => {
                println!("Skipping test_live_gemini: GEMINI_API_KEY not configured in env");
                return;
            }
        };

        tauri::async_runtime::block_on(async {
            let test_res = test_gemini_key(&key).await;
            println!("test_gemini_key result: {:?}", test_res);
            assert!(test_res.is_ok(), "Expected Gemini key to connect: {:?}", test_res);

            let classify_res = classify_media_text(
                &key,
                "Interstellar.2014.1080p.BluRay.x264.mkv",
                "Movies",
            ).await;
            println!("classify_media_text result: {:?}", classify_res);
            assert!(classify_res.is_ok());
            let suggestion = classify_res.unwrap();
            println!("Suggestion title: {} ({:?}) - Genre: {}", suggestion.display_title, suggestion.release_year, suggestion.primary_genre);
            assert_eq!(suggestion.display_title, "Interstellar");
        });
    }
}


