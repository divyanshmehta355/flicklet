import { useState, useEffect, type FormEvent } from "react";
import {
  AlertCircle,
  Clapperboard,
  Compass,
  Film,
  FolderHeart,
  FolderOpen,
  Heart,
  Loader2,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Tv,
  WandSparkles,
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

  const genres = [
    "All",
    "Romantic Comedy",
    "Horror",
    "Supernatural",
    "Mystery",
  ];

  // Load existing persistent catalog from SQLite upon application launch
  useEffect(() => {
    async function loadCatalog() {
      try {
        const items = await invoke<CatalogItem[]>("get_catalog");
        if (items && items.length > 0) {
          setCatalogItems(items);
        }
      } catch (err) {
        console.error("Could not load existing SQLite catalog:", err);
      }
    }
    loadCatalog();
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

      if (!selected) {
        return; // User cancelled
      }

      const folderPath = typeof selected === "string" ? selected : selected[0];
      setSelectedFolder(folderPath);
      setIsScanning(true);

      const items = await invoke<CatalogItem[]>("scan_folder", {
        folderPath,
      });

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

  // Filter catalog based on active navigation and search query
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

    // UI prototype only: Gemini integration comes in a later milestone.
    window.alert(
      `Your future Flicklet AI question:\n\n${question}\n\nWe'll connect Gemini in a later milestone.`,
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
                  title={selectedFolder || (hasCatalog ? `${catalogItems.length} items cataloged in SQLite` : undefined)}
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
                    <span>{hasCatalog || selectedFolder ? "Scan Folder" : "Choose Folder"}</span>
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
            {!hasCatalog && (
              <label className="genre-select">
                <span>Genre</span>
                <select
                  value={genre}
                  onChange={(event) => setGenre(event.target.value)}
                >
                  {genres.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {/* Media Grid: Real Persistent Catalog vs Initial Sample */}
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

                  return (
                    <article className="movie-card" key={item.id}>
                      <div className={`poster ${tone}`} title={item.path}>
                        <span className="poster-symbol">{symbol}</span>
                        <span className="poster-title">{item.display_title}</span>
                        <span className="poster-year">
                          {item.release_year ? item.release_year : formatBytes(item.size_bytes)}
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
                            <div className="badge-missing" title="File was not found at this location during the last scan">
                              ⚠️ File missing on disk
                            </div>
                          )}
                        </div>
                        <button
                          className={`favorite-button ${item.is_favorite ? "favorited" : ""}`}
                          aria-label={`Favorite ${item.display_title}`}
                          onClick={() => handleToggleFavorite(item.id)}
                        >
                          <Heart size={17} />
                        </button>
                      </div>
                      <span className="genre-chip">
                        {item.primary_genre || (item.media_type === "series" ? "Series" : "Movie")}
                      </span>
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
                    : "Try searching with a different keyword or selecting another tab."}
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

        <footer className="app-footer">
          <span>flicklet ♡ a softer place for stories</span>
          <span>your collection, your little universe</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
