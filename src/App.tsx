import { useState, useEffect, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clapperboard,
  Compass,
  Eye,
  EyeOff,
  Film,
  FolderHeart,
  FolderOpen,
  Heart,
  Key,
  Loader2,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Tv,
  WandSparkles,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type MediaItem = {
  title: string;
  year: number;
  genre: string;
  kind: "Movie" | "Series";
  tone: string;
  symbol: string;
};

interface CatalogItem {
  id: string;
  path: string;
  filename: string;
  extension: string;
  size_bytes: number;
  last_modified: number | null;
  media_type: string;
  display_title: string;
  release_year: number | null;
  primary_genre: string | null;
  secondary_genres: string[];
  series_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  is_favorite: boolean;
  ai_status: string;
  is_missing: boolean;
  last_scan_time: number;
}

interface AiClassificationSuggestion {
  display_title: string;
  release_year: number | null;
  media_type: string;
  primary_genre: string;
  secondary_genres: string[];
  series_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  confidence: string;
}

interface ApiKeyStatus {
  has_key: boolean;
  source: string;
  masked_key: string;
}

const TAXONOMY_GENRES = [
  "All",
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

const sampleMedia: MediaItem[] = [
  {
    title: "The Conjuring",
    year: 2013,
    genre: "Horror",
    kind: "Movie",
    tone: "poster-horror",
    symbol: "☾",
  },
  {
    title: "Teen Wolf",
    year: 2011,
    genre: "Supernatural",
    kind: "Series",
    tone: "poster-wolf",
    symbol: "✦",
  },
  {
    title: "The Love Hypothesis",
    year: 2026,
    genre: "Romantic Comedy",
    kind: "Movie",
    tone: "poster-romance",
    symbol: "♡",
  },
  {
    title: "Midnight Stories",
    year: 2024,
    genre: "Mystery",
    kind: "Movie",
    tone: "poster-mystery",
    symbol: "✧",
  },
];

const navItems = [
  { label: "Home", icon: Compass },
  { label: "All movies", icon: Film },
  { label: "TV shows", icon: Tv },
  { label: "Collections", icon: FolderHeart },
];

function App() {
  const [activeNav, setActiveNav] = useState("Home");
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("All");
  const [question, setQuestion] = useState("");

  // Persistent SQLite catalog state
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Settings & Gemini API state
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>({
    has_key: false,
    source: "none",
    masked_key: "",
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isTestingKey, setIsTestingKey] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  // AI Classification review state
  const [classifyingItemId, setClassifyingItemId] = useState<string | null>(null);
  const [reviewItem, setReviewItem] = useState<{
    catalogItem: CatalogItem;
    suggestion: AiClassificationSuggestion;
  } | null>(null);
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);

  // Load existing persistent catalog and API key status on launch
  useEffect(() => {
    async function initApp() {
      try {
        const items = await invoke<CatalogItem[]>("get_catalog");
        if (items && items.length > 0) {
          setCatalogItems(items);
        }
      } catch (err) {
        console.error("Could not load SQLite catalog:", err);
      }

      try {
        const status = await invoke<ApiKeyStatus>("get_gemini_api_key_status");
        setApiKeyStatus(status);
      } catch (err) {
        console.error("Could not check Gemini API key status:", err);
      }
    }
    initApp();
  }, []);

  // Native Windows folder picker -> Rust scan & SQLite upsert
  async function handleChooseFolder() {
    setScanError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select your movies or series folder",
      });

      if (!selected) return;

      const folderPath = typeof selected === "string" ? selected : selected[0];
      setSelectedFolder(folderPath);
      setIsScanning(true);

      const items = await invoke<CatalogItem[]>("scan_folder", { folderPath });
      setCatalogItems(items);
    } catch (error) {
      console.error("Folder scan failed:", error);
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsScanning(false);
    }
  }

  // Rescan active folder
  async function handleRescan() {
    if (!selectedFolder) return;
    setScanError(null);
    setIsScanning(true);
    try {
      const items = await invoke<CatalogItem[]>("scan_folder", {
        folderPath: selectedFolder,
      });
      setCatalogItems(items);
    } catch (error) {
      console.error("Rescan failed:", error);
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsScanning(false);
    }
  }

  // Toggle favorite status persisted into SQLite
  async function handleToggleFavorite(id: string) {
    try {
      const newFav = await invoke<boolean>("toggle_favorite", { id });
      setCatalogItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, is_favorite: newFav } : item
        )
      );
    } catch (error) {
      console.error("Failed to toggle favorite:", error);
    }
  }

  // Save Gemini API key into local SQLite settings
  async function handleSaveApiKey() {
    if (!apiKeyInput.trim()) return;
    setIsSavingKey(true);
    setSettingsMessage(null);
    try {
      await invoke("save_gemini_api_key", { apiKey: apiKeyInput });
      const status = await invoke<ApiKeyStatus>("get_gemini_api_key_status");
      setApiKeyStatus(status);
      setApiKeyInput("");
      setSettingsMessage({
        type: "success",
        text: "Gemini API key saved securely in your local settings.",
      });
    } catch (err) {
      setSettingsMessage({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSavingKey(false);
    }
  }

  // Test Gemini API connection
  async function handleTestApiKey() {
    setIsTestingKey(true);
    setSettingsMessage(null);
    try {
      const msg = await invoke<string>("test_gemini_connection", {
        apiKey: apiKeyInput.trim() ? apiKeyInput.trim() : null,
      });
      setSettingsMessage({ type: "success", text: msg });
    } catch (err) {
      setSettingsMessage({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsTestingKey(false);
    }
  }

  // Request AI classification for a single catalog item
  async function handleClassifyItem(item: CatalogItem) {
    setClassifyingItemId(item.id);
    try {
      const suggestion = await invoke<AiClassificationSuggestion>(
        "classify_media_item",
        { id: item.id }
      );
      setReviewItem({ catalogItem: item, suggestion });
      // Keep apiKeyStatus in sync
      const status = await invoke<ApiKeyStatus>("get_gemini_api_key_status");
      setApiKeyStatus(status);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.toLowerCase().includes("not configured")) {
        setActiveNav("Settings");
        setSettingsMessage({
          type: "info",
          text: "Please add your GEMINI_API_KEY to your .env file or enter it in Settings.",
        });
      } else {
        window.alert(`AI Classification:\n\n${errMsg}`);
      }
    } finally {
      setClassifyingItemId(null);
    }
  }

  // Save approved AI classification metadata to SQLite
  async function handleSaveReview() {
    if (!reviewItem) return;
    setIsSavingMetadata(true);
    try {
      const updated = await invoke<CatalogItem>("save_classified_metadata", {
        id: reviewItem.catalogItem.id,
        metadata: reviewItem.suggestion,
      });

      setCatalogItems((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );
      setReviewItem(null);
    } catch (error) {
      window.alert(
        `Failed to save metadata:\n\n${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setIsSavingMetadata(false);
    }
  }

  // Filter catalog based on active navigation, search query, and genre
  const filteredCatalog = catalogItems.filter((item) => {
    const matchesSearch =
      item.display_title.toLowerCase().includes(query.toLowerCase()) ||
      item.filename.toLowerCase().includes(query.toLowerCase());

    const matchesNav =
      activeNav === "Home" ||
      (activeNav === "All movies" && item.media_type !== "series") ||
      (activeNav === "TV shows" && item.media_type === "series") ||
      (activeNav === "Collections" && item.is_favorite);

    const matchesGenre =
      genre === "All" ||
      item.primary_genre === genre ||
      item.secondary_genres.includes(genre);

    return matchesSearch && matchesNav && matchesGenre;
  });

  // Filter sample preview items (when no local media has ever been scanned)
  const filteredSampleMedia = sampleMedia.filter((item) => {
    const matchesSearch = item.title
      .toLowerCase()
      .includes(query.toLowerCase());
    const matchesGenre = genre === "All" || item.genre === genre;
    const matchesNav =
      activeNav === "Home" ||
      (activeNav === "All movies" && item.kind === "Movie") ||
      (activeNav === "TV shows" && item.kind === "Series");

    return matchesSearch && matchesGenre && matchesNav;
  });

  const hasCatalog = catalogItems.length > 0;

  function askFlicklet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim()) return;

    window.alert(
      `Your future Flicklet AI question:\n\n${question}\n\nWe'll connect Scene Search in a subsequent milestone.`,
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={() => setActiveNav("Home")}>
          <span className="brand-mark">
            <Clapperboard size={25} strokeWidth={2.2} />
          </span>
          <span>
            <span className="brand-name">flicklet</span>
            <span className="brand-caption">your cozy cinema</span>
          </span>
        </a>

        <div className="sidebar-label">YOUR SPACE</div>

        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`nav-item ${activeNav === label ? "active" : ""}`}
              onClick={() => setActiveNav(label)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {label === "Collections" && (
                <Heart className="nav-heart" size={15} />
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="note-sparkle">✦</span>
          <p className="note-title">A little reminder</p>
          <p className="note-copy">
            Your next favorite story might already be in your collection.
          </p>
        </div>

        <button
          className={`nav-item settings-link ${activeNav === "Settings" ? "active" : ""}`}
          onClick={() => setActiveNav("Settings")}
        >
          <Settings size={19} />
          <span>Settings</span>
        </button>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">My library <span>/</span> {activeNav}</div>
          <div className="topbar-note">
            made with <Heart size={13} fill="currentColor" /> and movies
          </div>
        </header>

        {activeNav === "Settings" ? (
          /* Settings View */
          <div className="settings-container">
            <div className="settings-card">
              <h3>Gemini AI Configuration</h3>
              <p className="settings-description">
                Flicklet uses Google Gemini 2.0 Flash to identify titles, release
                years, and genres from video filenames. Video files, audio, and
                media contents are never transmitted.
              </p>

              {apiKeyStatus.has_key && (
                <div className="status-callout info" style={{ marginBottom: 18 }}>
                  <Sparkles size={16} />
                  <span>
                    <strong>Active Key:</strong> {apiKeyStatus.masked_key}{" "}
                    (Loaded via {apiKeyStatus.source})
                  </span>
                </div>
              )}

              <div className="form-group">
                <label htmlFor="gemini-key">GOOGLE GEMINI API KEY</label>
                <div className="settings-input-row">
                  <div className="settings-input-wrapper">
                    <input
                      id="gemini-key"
                      type={showApiKey ? "text" : "password"}
                      className="settings-input"
                      placeholder={
                        apiKeyStatus.has_key
                          ? `Configured via ${apiKeyStatus.source}`
                          : "Paste AIza... API key"
                      }
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="visibility-toggle"
                      onClick={() => setShowApiKey(!showApiKey)}
                      title={showApiKey ? "Hide Key" : "Show Key"}
                    >
                      {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <button
                    className="btn-primary"
                    onClick={handleSaveApiKey}
                    disabled={isSavingKey || !apiKeyInput.trim()}
                  >
                    {isSavingKey ? (
                      <Loader2 size={13} className="spin-icon" />
                    ) : (
                      <Key size={13} />
                    )}
                    <span>Save Key</span>
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={handleTestApiKey}
                    disabled={isTestingKey || (!apiKeyStatus.has_key && !apiKeyInput.trim())}
                  >
                    {isTestingKey ? (
                      <Loader2 size={13} className="spin-icon" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    <span>Test Connection</span>
                  </button>
                </div>
              </div>

              {settingsMessage && (
                <div className={`status-callout ${settingsMessage.type}`}>
                  {settingsMessage.type === "success" && <CheckCircle2 size={16} />}
                  {settingsMessage.type === "error" && <AlertCircle size={16} />}
                  {settingsMessage.type === "info" && <Sparkles size={16} />}
                  <span>{settingsMessage.text}</span>
                </div>
              )}

              <div className="settings-notice">
                <strong>Configuring via .env file (Recommended):</strong>
                <br />
                You can create a <code>.env</code> file in your project root (see <code>.env.example</code>):
                <pre
                  style={{
                    margin: "8px 0",
                    padding: "8px 12px",
                    background: "var(--blush-light)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 11,
                    fontFamily: "Consolas, monospace",
                  }}
                >
                  GEMINI_API_KEY=your_gemini_api_key_here
                </pre>
                Flicklet automatically detects and loads it. <code>.env</code> is added to <code>.gitignore</code> to keep your key completely private.
                <br />
                <br />
                Need a free key? Create one at{" "}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google AI Studio
                </a>
                .
              </div>
            </div>
          </div>
        ) : (
          /* Main Library View */
          <>
            <section className="welcome">
              <div className="welcome-copy">
                <div className="eyebrow">
                  <Sparkles size={15} /> YOUR PERSONAL MOVIE UNIVERSE
                </div>
                <h1>A little movie magic, <em>every day.</em></h1>
                <p>
                  Your favorite movies, comfort shows, and unforgettable moments —
                  all in one cozy place.
                </p>
              </div>
              <div className="welcome-decoration" aria-hidden="true">
                <span className="decor-star star-one">✦</span>
                <span className="decor-star star-two">✧</span>
                <span className="decor-heart">♡</span>
                <Clapperboard size={74} strokeWidth={1.1} />
              </div>
            </section>

            <form className="ai-search" onSubmit={askFlicklet}>
              <div className="ai-icon"><WandSparkles size={21} /></div>
              <div className="ai-search-content">
                <label htmlFor="ai-question">ASK YOUR LITTLE MOVIE ASSISTANT</label>
                <input
                  id="ai-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="Find something spooky, cozy, or unforgettable..."
                />
              </div>
              <button className="ask-button" type="submit">
                Ask Flicklet <span>↗</span>
              </button>
            </form>

            <section className="library-section">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">A LITTLE BIT OF EVERYTHING</p>
                  <h2>{activeNav === "Home" ? "Your collection" : activeNav}</h2>
                </div>
                <span className="item-count">
                  {isScanning
                    ? "Scanning..."
                    : hasCatalog
                    ? `${filteredCatalog.length} titles`
                    : `${filteredSampleMedia.length} titles (preview)`}{" "}
                  <Heart size={13} />
                </span>
              </div>

              {/* Local Folder Scanner & SQLite Sync Banner */}
              <div className="folder-panel">
                <div className="folder-panel-info">
                  <div className="folder-panel-icon">
                    <FolderOpen size={20} />
                  </div>
                  <div className="folder-panel-text">
                    <h3 className="folder-panel-title">
                      {selectedFolder
                        ? "Active Media Folder"
                        : hasCatalog
                        ? "Local SQLite Media Library"
                        : "Connect your local cinema library"}
                    </h3>
                    <p
                      className="folder-panel-path"
                      title={
                        selectedFolder ||
                        (hasCatalog
                          ? `${catalogItems.length} items cataloged in SQLite`
                          : undefined)
                      }
                    >
                      {selectedFolder
                        ? selectedFolder
                        : hasCatalog
                        ? `${catalogItems.length} video files persisted in your local library`
                        : "Choose a folder on your PC. Flicklet scans video files safely in read-only mode."}
                    </p>
                  </div>
                </div>
                <div className="folder-panel-actions">
                  {selectedFolder && (
                    <button
                      className="btn-secondary"
                      onClick={handleRescan}
                      disabled={isScanning}
                      title="Rescan current folder"
                    >
                      <RefreshCw
                        size={13}
                        className={isScanning ? "spin-icon" : ""}
                      />
                      <span>{isScanning ? "Scanning..." : "Rescan"}</span>
                    </button>
                  )}
                  <button
                    className="btn-primary"
                    onClick={handleChooseFolder}
                    disabled={isScanning}
                  >
                    {isScanning ? (
                      <>
                        <Loader2 size={14} className="spin-icon" />
                        <span>Scanning...</span>
                      </>
                    ) : (
                      <>
                        <FolderOpen size={14} />
                        <span>
                          {hasCatalog || selectedFolder
                            ? "Scan Folder"
                            : "Choose Folder"}
                        </span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Scan Error Message */}
              {scanError && (
                <div className="scan-error-banner">
                  <AlertCircle size={16} />
                  <span>Scan error: {scanError}</span>
                </div>
              )}

              <div className="library-toolbar">
                <div className="library-search">
                  <Search size={17} />
                  <input
                    aria-label="Search titles"
                    placeholder={
                      hasCatalog
                        ? "Search your persistent collection..."
                        : "Find a title..."
                    }
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <label className="genre-select">
                  <span>Genre</span>
                  <select
                    value={genre}
                    onChange={(event) => setGenre(event.target.value)}
                  >
                    {TAXONOMY_GENRES.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Media Grid */}
              {hasCatalog ? (
                isScanning ? (
                  <div className="empty-state">
                    <Loader2 className="spin-icon" size={32} />
                    <h3>Scanning and syncing library...</h3>
                    <p>Updating SQLite catalog with discovered media files</p>
                  </div>
                ) : filteredCatalog.length > 0 ? (
                  <div className="movie-grid">
                    {filteredCatalog.map((item, idx) => {
                      const tones = [
                        "poster-romance",
                        "poster-mystery",
                        "poster-horror",
                        "poster-wolf",
                      ];
                      const symbols = ["🎬", "✦", "☾", "♡", "✧"];
                      const tone = tones[idx % tones.length];
                      const symbol = symbols[idx % symbols.length];
                      const isClassifying = classifyingItemId === item.id;

                      return (
                        <article className="movie-card" key={item.id}>
                          <div className={`poster ${tone}`} title={item.path}>
                            <span className="poster-symbol">{symbol}</span>
                            <span className="poster-title">
                              {item.display_title}
                            </span>
                            <span className="poster-year">
                              {item.release_year
                                ? item.release_year
                                : formatBytes(item.size_bytes)}
                            </span>
                            <span className="poster-type">
                              {item.extension.toUpperCase()}
                            </span>
                          </div>
                          <div className="movie-info">
                            <div style={{ minWidth: 0, overflow: "hidden" }}>
                              <h3
                                title={item.display_title}
                                style={{
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.display_title}
                              </h3>
                              <p>
                                {formatBytes(item.size_bytes)}{" "}
                                <span>·</span> {item.extension.toUpperCase()}
                              </p>
                              <div
                                className="video-path-preview"
                                title={item.path}
                              >
                                {item.path}
                              </div>
                              {item.is_missing && (
                                <div className="badge-missing">
                                  ⚠️ File missing on disk
                                </div>
                              )}
                            </div>
                            <button
                              className={`favorite-button ${
                                item.is_favorite ? "favorited" : ""
                              }`}
                              aria-label={`Favorite ${item.display_title}`}
                              onClick={() => handleToggleFavorite(item.id)}
                            >
                              <Heart size={17} />
                            </button>
                          </div>

                          <div className="card-actions">
                            <span className="genre-chip">
                              {item.primary_genre ||
                                (item.media_type === "series"
                                  ? "Series"
                                  : "Local File")}
                            </span>

                            {item.ai_status === "approved" ? (
                              <span
                                className="badge-ai-approved"
                                title="Metadata verified with AI"
                              >
                                <Sparkles size={10} /> Verified
                              </span>
                            ) : (
                              <button
                                className="btn-ai-classify"
                                onClick={() => handleClassifyItem(item)}
                                disabled={isClassifying}
                                title="Identify with Gemini AI"
                              >
                                {isClassifying ? (
                                  <>
                                    <Loader2 size={11} className="spin-icon" />
                                    <span>AI...</span>
                                  </>
                                ) : (
                                  <>
                                    <WandSparkles size={11} />
                                    <span>AI Identify</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state">
                    <Film size={32} />
                    <h3>
                      {activeNav === "Collections"
                        ? "No favorites yet"
                        : "No matching titles"}
                    </h3>
                    <p>
                      {activeNav === "Collections"
                        ? "Click the little heart icon on any title to add it to your cozy favorites."
                        : "Try searching with a different keyword or selecting another genre."}
                    </p>
                  </div>
                )
              ) : (
                <>
                  <div className="movie-grid">
                    {filteredSampleMedia.map((item) => (
                      <article className="movie-card" key={item.title}>
                        <div className={`poster ${item.tone}`}>
                          <span className="poster-symbol">{item.symbol}</span>
                          <span className="poster-title">{item.title}</span>
                          <span className="poster-year">{item.year}</span>
                          <span className="poster-type">{item.kind}</span>
                        </div>
                        <div className="movie-info">
                          <div>
                            <h3>{item.title}</h3>
                            <p>
                              {item.year} <span>·</span> {item.kind}
                            </p>
                          </div>
                          <button
                            className="favorite-button"
                            aria-label={`Favorite ${item.title}`}
                            onClick={(event) => {
                              event.currentTarget.classList.toggle("favorited");
                            }}
                          >
                            <Heart size={17} />
                          </button>
                        </div>
                        <span className="genre-chip">{item.genre}</span>
                      </article>
                    ))}
                  </div>

                  {filteredSampleMedia.length === 0 && (
                    <div className="empty-state">
                      <Film size={30} />
                      <h3>No titles found just yet</h3>
                      <p>Try another search or choose a different genre.</p>
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}

        {/* AI Classification Review Modal */}
        {reviewItem && (
          <div className="modal-backdrop" onClick={() => setReviewItem(null)}>
            <div
              className="modal-dialog"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className="modal-header">
                <div>
                  <h3>Review AI Suggestions</h3>
                  <p title={reviewItem.catalogItem.path}>
                    File: {reviewItem.catalogItem.filename}
                  </p>
                </div>
                <button
                  className="favorite-button"
                  onClick={() => setReviewItem(null)}
                  aria-label="Close dialog"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="form-group">
                <label>CLEANED DISPLAY TITLE</label>
                <input
                  className="form-input"
                  value={reviewItem.suggestion.display_title}
                  onChange={(e) =>
                    setReviewItem({
                      ...reviewItem,
                      suggestion: {
                        ...reviewItem.suggestion,
                        display_title: e.target.value,
                      },
                    })
                  }
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>RELEASE YEAR</label>
                  <input
                    type="number"
                    className="form-input"
                    value={reviewItem.suggestion.release_year ?? ""}
                    onChange={(e) =>
                      setReviewItem({
                        ...reviewItem,
                        suggestion: {
                          ...reviewItem.suggestion,
                          release_year: e.target.value
                            ? parseInt(e.target.value, 10)
                            : null,
                        },
                      })
                    }
                    placeholder="e.g. 2024"
                  />
                </div>
                <div className="form-group">
                  <label>MEDIA TYPE</label>
                  <select
                    className="form-select"
                    value={reviewItem.suggestion.media_type}
                    onChange={(e) =>
                      setReviewItem({
                        ...reviewItem,
                        suggestion: {
                          ...reviewItem.suggestion,
                          media_type: e.target.value,
                        },
                      })
                    }
                  >
                    <option value="movie">Movie</option>
                    <option value="series">TV Series</option>
                    <option value="unknown">Unknown</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>PRIMARY GENRE (FOR LIBRARY PLACEMENT)</label>
                <select
                  className="form-select"
                  value={reviewItem.suggestion.primary_genre}
                  onChange={(e) =>
                    setReviewItem({
                      ...reviewItem,
                      suggestion: {
                        ...reviewItem.suggestion,
                        primary_genre: e.target.value,
                      },
                    })
                  }
                >
                  {TAXONOMY_GENRES.filter((g) => g !== "All").map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>

              {reviewItem.suggestion.media_type === "series" && (
                <div className="form-row">
                  <div className="form-group">
                    <label>SEASON NUMBER</label>
                    <input
                      type="number"
                      className="form-input"
                      value={reviewItem.suggestion.season_number ?? ""}
                      onChange={(e) =>
                        setReviewItem({
                          ...reviewItem,
                          suggestion: {
                            ...reviewItem.suggestion,
                            season_number: e.target.value
                              ? parseInt(e.target.value, 10)
                              : null,
                          },
                        })
                      }
                      placeholder="Season (e.g. 1)"
                    />
                  </div>
                  <div className="form-group">
                    <label>EPISODE NUMBER</label>
                    <input
                      type="number"
                      className="form-input"
                      value={reviewItem.suggestion.episode_number ?? ""}
                      onChange={(e) =>
                        setReviewItem({
                          ...reviewItem,
                          suggestion: {
                            ...reviewItem.suggestion,
                            episode_number: e.target.value
                              ? parseInt(e.target.value, 10)
                              : null,
                          },
                        })
                      }
                      placeholder="Episode (e.g. 1)"
                    />
                  </div>
                </div>
              )}

              <div className="modal-actions">
                <button
                  className="btn-secondary"
                  onClick={() => setReviewItem(null)}
                  disabled={isSavingMetadata}
                >
                  Discard
                </button>
                <button
                  className="btn-primary"
                  onClick={handleSaveReview}
                  disabled={isSavingMetadata}
                >
                  {isSavingMetadata ? (
                    <Loader2 size={13} className="spin-icon" />
                  ) : (
                    <CheckCircle2 size={13} />
                  )}
                  <span>Accept &amp; Save</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <footer className="app-footer">
          <span>flicklet ♡ a softer place for stories</span>
          <span>your collection, your little universe</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
