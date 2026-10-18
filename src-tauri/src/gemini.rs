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
