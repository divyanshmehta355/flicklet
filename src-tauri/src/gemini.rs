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

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key={}",
        api_key.trim()
    );

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

    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Gemini API: {}", e))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read Gemini response: {}", e))?;

    if !status.is_success() {
        let err_msg: Result<GeminiResponse, _> = serde_json::from_str(&text);
        if let Ok(err_obj) = err_msg {
            if let Some(err) = err_obj.error {
                return Err(format!(
                    "Gemini API error ({}): {}",
                    status,
                    err.message.unwrap_or_else(|| "Unknown error".to_string())
                ));
            }
        }
        return Err(format!("Gemini API HTTP {}: {}", status, text));
    }

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
    if api_key.trim().is_empty() {
        return Err("Please enter an API key to test.".to_string());
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key={}",
        api_key.trim()
    );

    let req_body = serde_json::json!({
        "contents": [{
            "parts": [{ "text": "Ping. Answer with 'OK'." }]
        }]
    });

    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("Connection error: {}", e))?;

    let status = res.status();
    if status.is_success() {
        Ok("Gemini API key is valid and connected!".to_string())
    } else {
        let text = res.text().await.unwrap_or_default();
        Err(format!(
            "Gemini key verification failed (HTTP {}): {}",
            status, text
        ))
    }
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

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key={}",
        api_key.trim()
    );

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

    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("Failed to query Gemini assistant: {}", e))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("Failed to read Gemini response: {}", e))?;

    if !status.is_success() {
        return Err(format!("Gemini API error (HTTP {}): {}", status, text));
    }

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
