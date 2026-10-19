import { useState, useEffect, useMemo, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Compass,
  Eye,
  EyeOff,
  Film,
  FolderCheck,
  FolderHeart,
  FolderOpen,
  FolderTree,
  Heart,
  Image as ImageIcon,
  Key,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Tv,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
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
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  vote_average: number | null;
  tmdb_id: number | null;
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

interface SceneSearchResult {
  catalog_item_id: string | null;
  matched_title: string;
  scene_summary: string;
  estimated_timestamp_seconds: number | null;
  timestamp_formatted: string | null;
  is_estimate: boolean;
  confidence: string;
  explanation: string;
}

interface OrganizePlanItem {
  id: string;
  source_path: string;
  target_path: string;
  proposed_relative_path: string;
  display_title: string;
  media_type: string;
  genre: string;
  year: number | null;
  is_selected: boolean;
  has_collision: boolean;
  collision_resolution: string;
  is_across_drives: boolean;
  is_read_only: boolean;
  is_system_path: boolean;
  warning: string | null;
}

interface OrganizePreviewReport {
  target_root: string;
  items: OrganizePlanItem[];
  total_files: number;
  cross_drive_count: number;
  collision_count: number;
  blocked_count: number;
}

interface OrganizeExecutionResult {
  batch_id: string;
  successful_moves: number;
  failed_moves: number;
  skipped_moves: number;
  errors: string[];
}

interface RollbackBatchSummary {
  batch_id: string;
  timestamp: number;
  file_count: number;
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
  { label: "Organize", icon: FolderTree },
];

function App() {
  const [activeNav, setActiveNav] = useState("Home");
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("All");
  const [question, setQuestion] = useState("");

  // Series Hub & Grouping state
  const [selectedSeries, setSelectedSeries] = useState<string | null>(null);
  const [selectedSeason, setSelectedSeason] = useState<number | "all">("all");
  const [seriesViewMode, setSeriesViewMode] = useState<"grouped" | "episodes">("grouped");

  function handleNavigate(tab: string) {
    setActiveNav(tab);
    setSelectedSeries(null);
    setSelectedSeason("all");
  }

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

  // TMDB API Key and Enrichment state
  const [tmdbKeyInput, setTmdbKeyInput] = useState("");
  const [tmdbKeyStatus, setTmdbKeyStatus] = useState<ApiKeyStatus>({
    has_key: false,
    source: "none",
    masked_key: "",
  });
  const [showTmdbKey, setShowTmdbKey] = useState(false);
  const [isSavingTmdbKey, setIsSavingTmdbKey] = useState(false);
  const [isTestingTmdbKey, setIsTestingTmdbKey] = useState(false);
  const [tmdbSettingsMessage, setTmdbSettingsMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const [enrichingItemId, setEnrichingItemId] = useState<string | null>(null);
  const [isEnrichingAllTmdb, setIsEnrichingAllTmdb] = useState(false);
  const [enrichNotice, setEnrichNotice] = useState<string | null>(null);

  // AI Classification review state
  const [classifyingItemId, setClassifyingItemId] = useState<string | null>(null);
  const [reviewItem, setReviewItem] = useState<{
    catalogItem: CatalogItem;
    suggestion: AiClassificationSuggestion;
  } | null>(null);
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);

  // Cinema assistant and timestamp playback state
  const [isAskingAssistant, setIsAskingAssistant] = useState(false);
  const [assistantResult, setAssistantResult] = useState<SceneSearchResult | null>(null);
  const [adjustedTimestamp, setAdjustedTimestamp] = useState<number | null>(null);
  const [isVlcAvailable, setIsVlcAvailable] = useState<boolean>(false);
  const [playbackMessage, setPlaybackMessage] = useState<string | null>(null);

  // Safe File Organization state
  const [organizeTargetRoot, setOrganizeTargetRoot] = useState<string>("");
  const [organizeOptions, setOrganizeOptions] = useState({
    group_movies_by_genre: true,
    include_episode_title: true,
    cleanup_empty_folders: true,
  });
  const [organizePreview, setOrganizePreview] = useState<OrganizePreviewReport | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmAgreed, setConfirmAgreed] = useState(false);
  const [isExecutingOrganize, setIsExecutingOrganize] = useState(false);
  const [lastExecutionResult, setLastExecutionResult] = useState<OrganizeExecutionResult | null>(null);
  const [rollbackHistory, setRollbackHistory] = useState<RollbackBatchSummary[]>([]);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [organizeMessage, setOrganizeMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  // Load existing persistent catalog, API key status, and VLC on launch
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

      try {
        const tmdbStatus = await invoke<ApiKeyStatus>("get_tmdb_api_key_status");
        setTmdbKeyStatus(tmdbStatus);
      } catch (err) {
        console.error("Could not check TMDB API key status:", err);
      }

      try {
        const vlcInstalled = await invoke<boolean>("check_vlc_installed");
        setIsVlcAvailable(vlcInstalled);
      } catch (err) {
        console.error("Could not check VLC status:", err);
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

      // Automatically trigger library auto-identification in background with TMDB & Gemini AI
      handleAutoIdentifyLibrary(false, true);
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

      // Automatically trigger library auto-identification in background with TMDB & Gemini AI
      handleAutoIdentifyLibrary(false, true);
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

  // Save TMDB API key into local SQLite settings
  async function handleSaveTmdbKey() {
    if (!tmdbKeyInput.trim()) return;
    setIsSavingTmdbKey(true);
    setTmdbSettingsMessage(null);
    try {
      await invoke("save_tmdb_api_key", { apiKey: tmdbKeyInput });
      const status = await invoke<ApiKeyStatus>("get_tmdb_api_key_status");
      setTmdbKeyStatus(status);
      setTmdbKeyInput("");
      setTmdbSettingsMessage({
        type: "success",
        text: "TMDB API key saved securely in your local settings.",
      });
    } catch (err) {
      setTmdbSettingsMessage({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSavingTmdbKey(false);
    }
  }

  // Test TMDB API connection
  async function handleTestTmdbKey() {
    setIsTestingTmdbKey(true);
    setTmdbSettingsMessage(null);
    try {
      const msg = await invoke<string>("test_tmdb_connection", {
        apiKey: tmdbKeyInput.trim() ? tmdbKeyInput.trim() : null,
      });
      setTmdbSettingsMessage({ type: "success", text: msg });
    } catch (err) {
      setTmdbSettingsMessage({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsTestingTmdbKey(false);
    }
  }

  // Auto-identify single media item with TMDB & Gemini AI hands-free
  async function handleEnrichItem(item: CatalogItem) {
    setEnrichingItemId(item.id);
    try {
      const updated = await invoke<CatalogItem>("auto_identify_media_item", {
        id: item.id,
      });
      setCatalogItems((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      );
      setEnrichNotice(
        `✨ Auto-identified "${updated.display_title}" with official artwork & ratings!`
      );
      setTimeout(() => setEnrichNotice(null), 5000);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.toLowerCase().includes("not configured")) {
        setActiveNav("Settings");
        setTmdbSettingsMessage({
          type: "info",
          text: "Please add your TMDB_API_KEY or GEMINI_API_KEY to your .env file or enter it in Settings.",
        });
      } else {
        window.alert(`Auto-Identify:\n\n${errMsg}`);
      }
    } finally {
      setEnrichingItemId(null);
    }
  }

  // Batch auto-identify library items with TMDB & Gemini AI
  async function handleAutoIdentifyLibrary(force = false, silent = false) {
    setIsEnrichingAllTmdb(true);
    if (!silent) {
      setEnrichNotice(
        force
          ? "✨ Force re-identifying library items with TMDB & Gemini AI..."
          : "✨ Auto-identifying library with TMDB & Gemini AI..."
      );
    }
    try {
      const count = await invoke<number>("auto_identify_all_media", { force });
      const freshItems = await invoke<CatalogItem[]>("get_catalog");
      if (freshItems && freshItems.length > 0) {
        setCatalogItems(freshItems);
      }
      if (count > 0) {
        setEnrichNotice(
          `✨ Successfully auto-identified ${count} item${count === 1 ? "" : "s"} with official posters, genres, and metadata!`
        );
      } else if (!silent) {
        setEnrichNotice(
          "✨ All titles already have verified posters & metadata. (Click 'Force Refresh' to re-query TMDB & Gemini)."
        );
      }
      setTimeout(() => setEnrichNotice(null), 7000);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (!silent) {
        if (errMsg.toLowerCase().includes("not configured")) {
          setActiveNav("Settings");
          setTmdbSettingsMessage({
            type: "info",
            text: "Please configure your TMDB or Gemini API key in Settings to enable automated identification.",
          });
        } else {
          setEnrichNotice(`Auto-identify notice: ${errMsg}`);
          setTimeout(() => setEnrichNotice(null), 7000);
        }
      }
    } finally {
      setIsEnrichingAllTmdb(false);
    }
  }

  // Auto-identify single catalog item hands-free without manual review modal
  async function handleClassifyItem(item: CatalogItem) {
    setClassifyingItemId(item.id);
    try {
      const updated = await invoke<CatalogItem>("auto_identify_media_item", {
        id: item.id,
      });
      setCatalogItems((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c))
      );
      setEnrichNotice(
        `✨ Auto-identified "${updated.display_title}" with official artwork & metadata!`
      );
      setTimeout(() => setEnrichNotice(null), 5000);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.toLowerCase().includes("not configured")) {
        setActiveNav("Settings");
        setTmdbSettingsMessage({
          type: "info",
          text: "Please add your TMDB_API_KEY or GEMINI_API_KEY to your .env file or enter it in Settings.",
        });
      } else {
        window.alert(`Auto-Identify:\n\n${errMsg}`);
      }
    } finally {
      setClassifyingItemId(null);
    }
  }

  // Save approved AI classification metadata to SQLite & auto-enrich with TMDB
  async function handleSaveReview() {
    if (!reviewItem) return;
    setIsSavingMetadata(true);
    try {
      const updated = await invoke<CatalogItem>("save_classified_metadata", {
        id: reviewItem.catalogItem.id,
        metadata: reviewItem.suggestion,
      });

      // Automatically attempt TMDB enrichment now that title and year are verified!
      try {
        const enriched = await invoke<CatalogItem>("enrich_media_item_with_tmdb", {
          id: updated.id,
        });
        setCatalogItems((prev) =>
          prev.map((item) => (item.id === enriched.id ? enriched : item))
        );
      } catch {
        setCatalogItems((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item))
        );
      }

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
    const q = query.toLowerCase().trim();
    const matchesSearch =
      !q ||
      item.display_title.toLowerCase().includes(q) ||
      item.filename.toLowerCase().includes(q) ||
      (item.series_title !== null && item.series_title.toLowerCase().includes(q));

    const isSeries = item.media_type === "series" || item.series_title !== null;

    const matchesNav =
      activeNav === "Home" ||
      (activeNav === "All movies" && !isSeries) ||
      (activeNav === "TV shows" && isSeries) ||
      (activeNav === "Collections" && item.is_favorite);

    const matchesGenre =
      genre === "All" ||
      item.primary_genre === genre ||
      item.secondary_genres.includes(genre);

    return matchesSearch && matchesNav && matchesGenre;
  });

  interface SeriesGroup {
    seriesTitle: string;
    episodes: CatalogItem[];
    seasons: number[];
    posterUrl: string | null;
    backdropUrl: string | null;
    overview: string | null;
    voteAverage: number | null;
    genres: string[];
    totalSizeBytes: number;
  }

  // Group catalog series items by series_title for organized Series View
  const seriesGroups: SeriesGroup[] = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();

    for (const item of catalogItems) {
      const isSeries = item.media_type === "series" || item.series_title !== null;
      if (isSeries) {
        let key = item.series_title?.trim();
        if (!key) {
          const seasonMatch = item.display_title.match(/^(.*?)\s+S\d+\s+E\d+/i);
          key = seasonMatch ? seasonMatch[1].trim() : item.display_title.trim();
        }
        if (!map.has(key)) {
          map.set(key, []);
        }
        map.get(key)!.push(item);
      }
    }

    const groups: SeriesGroup[] = [];

    for (const [title, eps] of map.entries()) {
      eps.sort((a, b) => {
        const sA = a.season_number ?? 1;
        const sB = b.season_number ?? 1;
        if (sA !== sB) return sA - sB;
        const eA = a.episode_number ?? 0;
        const eB = b.episode_number ?? 0;
        if (eA !== eB) return eA - eB;
        return a.display_title.localeCompare(b.display_title);
      });

      const seasons = Array.from(
        new Set(eps.map((e) => e.season_number ?? 1))
      ).sort((a, b) => a - b);

      const posterUrl = eps.find((e) => e.poster_url)?.poster_url || null;
      const backdropUrl =
        eps.find((e) => e.backdrop_url)?.backdrop_url || posterUrl;
      const overview = eps.find((e) => e.overview)?.overview || null;

      const ratings = eps
        .map((e) => e.vote_average)
        .filter((r): r is number => r !== null && r > 0);
      const voteAverage =
        ratings.length > 0
          ? ratings.reduce((acc, curr) => acc + curr, 0) / ratings.length
          : null;

      const genres = Array.from(
        new Set(
          eps
            .flatMap((e) => [e.primary_genre, ...(e.secondary_genres || [])])
            .filter((g): g is string => !!g && g !== "Unknown")
        )
      );

      const totalSizeBytes = eps.reduce((acc, e) => acc + e.size_bytes, 0);

      groups.push({
        seriesTitle: title,
        episodes: eps,
        seasons,
        posterUrl,
        backdropUrl,
        overview,
        voteAverage,
        genres,
        totalSizeBytes,
      });
    }

    return groups.sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle));
  }, [catalogItems]);

  const filteredSeriesGroups = useMemo(() => {
    const q = query.toLowerCase().trim();
    return seriesGroups.filter((group) => {
      const matchesSearch =
        !q ||
        group.seriesTitle.toLowerCase().includes(q) ||
        group.episodes.some(
          (e) =>
            e.display_title.toLowerCase().includes(q) ||
            e.filename.toLowerCase().includes(q)
        );

      const matchesGenre =
        genre === "All" ||
        group.genres.includes(genre) ||
        group.episodes.some(
          (e) =>
            e.primary_genre === genre || e.secondary_genres.includes(genre)
        );

      return matchesSearch && matchesGenre;
    });
  }, [seriesGroups, query, genre]);

  const currentSeries = useMemo(() => {
    if (!selectedSeries) return null;
    return (
      seriesGroups.find(
        (g) => g.seriesTitle.toLowerCase() === selectedSeries.toLowerCase()
      ) || null
    );
  }, [seriesGroups, selectedSeries]);

  const visibleEpisodes = useMemo(() => {
    if (!currentSeries) return [];
    return currentSeries.episodes.filter(
      (ep) => selectedSeason === "all" || (ep.season_number ?? 1) === selectedSeason
    );
  }, [currentSeries, selectedSeason]);

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

  function formatSeconds(totalSec: number): string {
    const clamped = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    const s = clamped % 60;
    return `${h.toString().padStart(2, "0")}:${m
      .toString()
      .padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  function handleNudge(deltaSeconds: number) {
    setAdjustedTimestamp((prev) => {
      const current = prev ?? 0;
      return Math.max(0, current + deltaSeconds);
    });
  }

  async function handlePlayInVlc(filePath: string, seconds: number | null) {
    setPlaybackMessage(null);
    try {
      await invoke("play_in_vlc", {
        filePath,
        startTimeSeconds: seconds !== null && seconds > 0 ? seconds : null,
      });
    } catch (err) {
      setPlaybackMessage(
        `VLC launch error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleOpenDefaultPlayer(filePath: string) {
    setPlaybackMessage(null);
    try {
      await openPath(filePath);
    } catch (err) {
      setPlaybackMessage(
        `Player error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleRevealInExplorer(filePath: string) {
    setPlaybackMessage(null);
    try {
      await revealItemInDir(filePath);
    } catch (err) {
      setPlaybackMessage(
        `Explorer error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function askFlicklet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim()) return;

    setIsAskingAssistant(true);
    setAssistantResult(null);
    setPlaybackMessage(null);

    try {
      const result = await invoke<SceneSearchResult>("ask_scene_assistant", {
        question: question.trim(),
      });
      setAssistantResult(result);
      setAdjustedTimestamp(result.estimated_timestamp_seconds ?? null);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.toLowerCase().includes("not configured")) {
        setActiveNav("Settings");
        setSettingsMessage({
          type: "info",
          text: "Please add your GEMINI_API_KEY to your .env file or enter it in Settings to use the scene assistant.",
        });
      } else {
        window.alert(`Flicklet Assistant:\n\n${errMsg}`);
      }
    } finally {
      setIsAskingAssistant(false);
    }
  }

  const matchedCatalogItem = assistantResult
    ? catalogItems.find((item) => {
        if (
          assistantResult.catalog_item_id &&
          item.id === assistantResult.catalog_item_id
        ) {
          return true;
        }
        const titleA = item.display_title.toLowerCase().trim();
        const titleB = assistantResult.matched_title.toLowerCase().trim();
        if (titleA === titleB) return true;
        if (titleA.length > 3 && titleB.length > 3) {
          if (titleA.includes(titleB) || titleB.includes(titleA)) return true;
        }
        const fileA = item.filename.toLowerCase();
        if (titleB.length > 3 && fileA.includes(titleB)) return true;
        return false;
      })
    : null;

  // Load rollback history
  async function loadRollbackHistory() {
    try {
      const history = await invoke<RollbackBatchSummary[]>("get_rollback_history");
      setRollbackHistory(history);
    } catch (err) {
      console.error("Failed to load rollback history:", err);
    }
  }

  // Browse destination directory for organization
  async function handleBrowseOrganizeTarget() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Destination Folder for Organized Library",
      });
      if (selected) {
        const path = typeof selected === "string" ? selected : selected[0];
        setOrganizeTargetRoot(path);
        if (catalogItems.length > 0) {
          handleGeneratePreview(path);
        }
      }
    } catch (err) {
      console.error("Target folder picker failed:", err);
    }
  }

  // Generate Dry-Run Preview
  async function handleGeneratePreview(
    targetOverride?: string,
    optionsOverride?: {
      group_movies_by_genre: boolean;
      include_episode_title: boolean;
      cleanup_empty_folders: boolean;
    }
  ) {
    const target = targetOverride || organizeTargetRoot;
    const opts = optionsOverride || organizeOptions;
    if (!target.trim()) {
      setOrganizeMessage({
        type: "error",
        text: "Please select or enter a target destination directory.",
      });
      return;
    }

    setIsLoadingPreview(true);
    setOrganizeMessage(null);
    try {
      const report = await invoke<OrganizePreviewReport>("preview_organize", {
        targetRoot: target.trim(),
        itemIds: null,
        options: opts,
      });
      setOrganizePreview(report);
    } catch (err) {
      setOrganizeMessage({
        type: "error",
        text: `Preview failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setIsLoadingPreview(false);
    }
  }

  function handleToggleOrganizeOption(key: keyof typeof organizeOptions) {
    const updated = { ...organizeOptions, [key]: !organizeOptions[key] };
    setOrganizeOptions(updated);
    if (organizeTargetRoot.trim() && catalogItems.length > 0) {
      handleGeneratePreview(undefined, updated);
    }
  }

  // Toggle selection of a single item in organize preview
  function handleToggleSelectItem(id: string) {
    if (!organizePreview) return;
    setOrganizePreview({
      ...organizePreview,
      items: organizePreview.items.map((item) =>
        item.id === id && !item.is_system_path && !item.is_read_only
          ? { ...item, is_selected: !item.is_selected }
          : item
      ),
    });
  }

  // Toggle selection for all eligible items
  function handleToggleSelectAll(selectAll: boolean) {
    if (!organizePreview) return;
    setOrganizePreview({
      ...organizePreview,
      items: organizePreview.items.map((item) =>
        item.is_system_path || item.is_read_only
          ? item
          : { ...item, is_selected: selectAll }
      ),
    });
  }

  // Change collision resolution per item ("keep_both" | "skip")
  function handleChangeCollisionResolution(id: string, resolution: string) {
    if (!organizePreview) return;
    setOrganizePreview({
      ...organizePreview,
      items: organizePreview.items.map((item) =>
        item.id === id ? { ...item, collision_resolution: resolution } : item
      ),
    });
  }

  // Execute organization after double confirmation
  async function handleExecuteOrganize() {
    if (!organizePreview || !confirmAgreed) return;
    setIsExecutingOrganize(true);
    setOrganizeMessage(null);

    try {
      const result = await invoke<OrganizeExecutionResult>("execute_organize", {
        plan: organizePreview.items,
        doubleConfirmed: true,
        options: organizeOptions,
      });

      setLastExecutionResult(result);
      setShowConfirmModal(false);
      setConfirmAgreed(false);

      // Refresh persistent catalog from SQLite
      const updatedCatalog = await invoke<CatalogItem[]>("get_catalog");
      setCatalogItems(updatedCatalog);

      // Refresh rollback history
      await loadRollbackHistory();

      // Refresh dry-run preview report
      await handleGeneratePreview();

      setOrganizeMessage({
        type: "success",
        text: `Successfully organized ${result.successful_moves} files into genre folders! (Batch: ${result.batch_id.slice(0, 8)})`,
      });
    } catch (err) {
      setOrganizeMessage({
        type: "error",
        text: `Organization error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setIsExecutingOrganize(false);
    }
  }

  // Rollback an executed batch
  async function handleRollbackBatch(batchId: string) {
    const confirmed = window.confirm(
      "Are you sure you want to undo this organization batch? Files will be restored to their previous locations."
    );
    if (!confirmed) return;

    setIsRollingBack(true);
    setOrganizeMessage(null);
    try {
      const restoredCount = await invoke<number>("rollback_organize", { batchId });

      // Refresh catalog and history
      const updatedCatalog = await invoke<CatalogItem[]>("get_catalog");
      setCatalogItems(updatedCatalog);
      await loadRollbackHistory();
      if (organizeTargetRoot) {
        await handleGeneratePreview();
      }

      setOrganizeMessage({
        type: "success",
        text: `Rollback complete! Successfully restored ${restoredCount} files to their original paths.`,
      });
    } catch (err) {
      setOrganizeMessage({
        type: "error",
        text: `Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setIsRollingBack(false);
    }
  }

  // Auto-load rollback history and preview when entering Organize tab
  useEffect(() => {
    if (activeNav === "Organize") {
      loadRollbackHistory();
      if (!organizeTargetRoot && selectedFolder) {
        const defaultTarget = `${selectedFolder}\\Organized Cinema`;
        setOrganizeTargetRoot(defaultTarget);
        if (catalogItems.length > 0) {
          handleGeneratePreview(defaultTarget);
        }
      } else if (organizeTargetRoot && !organizePreview && catalogItems.length > 0) {
        handleGeneratePreview(organizeTargetRoot);
      }
    }
  }, [activeNav, catalogItems.length, organizeTargetRoot, selectedFolder]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={() => handleNavigate("Home")}>
          <img
            src="/flicklet-logo.svg"
            alt="Flicklet"
            className="brand-mark-img"
          />
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
              onClick={() => handleNavigate(label)}
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
          onClick={() => handleNavigate("Settings")}
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

            {/* TMDB Artwork & Ratings Configuration Card */}
            <div className="settings-card">
              <h3>TMDB Poster Artwork &amp; Ratings</h3>
              <p className="settings-description">
                Flicklet integrates with The Movie Database (TMDB) to fetch official high-definition
                posters, backdrop artwork, community star ratings, and plot overviews for your movie and series library.
              </p>

              {tmdbKeyStatus.has_key && (
                <div className="status-callout info" style={{ marginBottom: 18 }}>
                  <Sparkles size={16} />
                  <span>
                    <strong>Active TMDB Key:</strong> {tmdbKeyStatus.masked_key}{" "}
                    (Loaded via {tmdbKeyStatus.source})
                  </span>
                </div>
              )}

              <div className="form-group">
                <label htmlFor="tmdb-key">TMDB API KEY (v3 auth)</label>
                <div className="settings-input-row">
                  <div className="settings-input-wrapper">
                    <input
                      id="tmdb-key"
                      type={showTmdbKey ? "text" : "password"}
                      className="settings-input"
                      placeholder={
                        tmdbKeyStatus.has_key
                          ? `Configured via ${tmdbKeyStatus.source}`
                          : "Paste 32-character TMDB API key"
                      }
                      value={tmdbKeyInput}
                      onChange={(e) => setTmdbKeyInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="visibility-toggle"
                      onClick={() => setShowTmdbKey(!showTmdbKey)}
                      title={showTmdbKey ? "Hide Key" : "Show Key"}
                    >
                      {showTmdbKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <button
                    className="btn-primary"
                    onClick={handleSaveTmdbKey}
                    disabled={isSavingTmdbKey || !tmdbKeyInput.trim()}
                  >
                    {isSavingTmdbKey ? (
                      <Loader2 size={13} className="spin-icon" />
                    ) : (
                      <Key size={13} />
                    )}
                    <span>Save Key</span>
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={handleTestTmdbKey}
                    disabled={
                      isTestingTmdbKey ||
                      (!tmdbKeyStatus.has_key && !tmdbKeyInput.trim())
                    }
                  >
                    {isTestingTmdbKey ? (
                      <Loader2 size={13} className="spin-icon" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    <span>Test Connection</span>
                  </button>
                </div>
              </div>

              {tmdbSettingsMessage && (
                <div className={`status-callout ${tmdbSettingsMessage.type}`}>
                  {tmdbSettingsMessage.type === "success" && (
                    <CheckCircle2 size={16} />
                  )}
                  {tmdbSettingsMessage.type === "error" && (
                    <AlertCircle size={16} />
                  )}
                  {tmdbSettingsMessage.type === "info" && (
                    <Sparkles size={16} />
                  )}
                  <span>{tmdbSettingsMessage.text}</span>
                </div>
              )}

              <div className="settings-notice">
                <strong>Configuring via .env file (Recommended):</strong>
                <br />
                Add <code>TMDB_API_KEY</code> to your project root <code>.env</code> file:
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
                  TMDB_API_KEY=your_tmdb_api_key_here
                </pre>
                Flicklet automatically detects and loads it. <code>.env</code> is added to <code>.gitignore</code> to keep your credentials safe.
                <br />
                <br />
                Need a free TMDB key? Generate one at{" "}
                <a
                  href="https://www.themoviedb.org/settings/api"
                  target="_blank"
                  rel="noreferrer"
                >
                  themoviedb.org/settings/api
                </a>
                .
              </div>
            </div>
          </div>
        ) : activeNav === "Organize" ? (
          /* Safe File Organization View */
          <div className="organize-view">
            <div className="organize-intro-card">
              <div className="eyebrow" style={{ marginBottom: 6 }}>
                <Sparkles size={15} /> SAFE PERSONAL CINEMA ORGANIZER
              </div>
              <h2>Organize Library &amp; Dry-Run Preview</h2>
              <p>
                Flicklet structures your movie and series collection into an elegant, standard genre layout without touching anything without your double-confirmed approval.
              </p>

              <div className="safety-pill-row">
                <span className="safety-pill">
                  <ShieldCheck size={14} /> Dry-run preview first
                </span>
                <span className="safety-pill">
                  <ShieldCheck size={14} /> Name collision detection
                </span>
                <span className="safety-pill">
                  <ShieldCheck size={14} /> Cross-drive copy verification
                </span>
                <span className="safety-pill">
                  <ShieldCheck size={14} /> System &amp; read-only protection
                </span>
                <span className="safety-pill">
                  <Undo2 size={14} /> 1-Click rollback ledger
                </span>
              </div>
            </div>

            {/* Destination Configuration */}
            <div className="organize-config-card">
              <div className="organize-config-title">Destination Library Folder</div>
              <div className="organize-target-row">
                <input
                  type="text"
                  className="organize-target-input"
                  value={organizeTargetRoot}
                  onChange={(e) => setOrganizeTargetRoot(e.target.value)}
                  placeholder="e.g. D:\Movies\Organized Cinema"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleBrowseOrganizeTarget}
                >
                  <FolderOpen size={14} />
                  <span>Browse Destination...</span>
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handleGeneratePreview()}
                  disabled={isLoadingPreview || !organizeTargetRoot.trim() || catalogItems.length === 0}
                >
                  {isLoadingPreview ? (
                    <>
                      <Loader2 size={14} className="spin-icon" />
                      <span>Generating Preview...</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw size={14} />
                      <span>Generate Preview</span>
                    </>
                  )}
                </button>
              </div>

              {/* Organization Rules & Structure Preview Banner */}
              <div className="organize-rules-banner">
                <div className="organize-rule-item">
                  <div className="rule-badge tv">TV SHOWS</div>
                  <div className="rule-text">
                    <strong>TV Shows / {'{Show Name}'} / Season {'{XX}'} / {'{Show Name}'} - S{'{XX}'}E{'{YY}'} - {'{Title}'}.ext</strong>
                    <span>Episodes are consolidated cleanly into Season folders — no single-file folders.</span>
                  </div>
                </div>
                <div className="organize-rule-item">
                  <div className="rule-badge movie">MOVIES</div>
                  <div className="rule-text">
                    <strong>Movies / {'{Genre}'} / {'{Title}'} ({'{Year}'}).ext</strong>
                    <span>Direct movie files in genre folders — no single-file wrapper subfolders.</span>
                  </div>
                </div>
              </div>

              {/* Toggles for custom organization preferences */}
              <div className="organize-options-row">
                <label className="organize-option-toggle">
                  <input
                    type="checkbox"
                    checked={organizeOptions.group_movies_by_genre}
                    onChange={() => handleToggleOrganizeOption("group_movies_by_genre")}
                  />
                  <span>Group Movies by Genre</span>
                </label>
                <label className="organize-option-toggle">
                  <input
                    type="checkbox"
                    checked={organizeOptions.include_episode_title}
                    onChange={() => handleToggleOrganizeOption("include_episode_title")}
                  />
                  <span>Include Episode Titles in TV Filenames</span>
                </label>
                <label className="organize-option-toggle">
                  <input
                    type="checkbox"
                    checked={organizeOptions.cleanup_empty_folders}
                    onChange={() => handleToggleOrganizeOption("cleanup_empty_folders")}
                  />
                  <span>Clean Up Empty Source Folders</span>
                </label>
              </div>

              {catalogItems.length === 0 && (
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--muted)" }}>
                  💡 Please scan a folder from the Home screen first so Flicklet has titles to organize.
                </p>
              )}
            </div>

            {organizeMessage && (
              <div
                className={`status-callout ${organizeMessage.type}`}
                style={{ marginTop: 16 }}
              >
                {organizeMessage.type === "success" && <CheckCircle2 size={16} />}
                {organizeMessage.type === "error" && <AlertCircle size={16} />}
                {organizeMessage.type === "info" && <Sparkles size={16} />}
                <span>{organizeMessage.text}</span>
              </div>
            )}

            {lastExecutionResult && (
              <div
                className="status-callout info"
                style={{ marginTop: 12 }}
              >
                <FolderCheck size={16} />
                <span>
                  Last execution summary: {lastExecutionResult.successful_moves} moved
                  {lastExecutionResult.skipped_moves > 0 &&
                    `, ${lastExecutionResult.skipped_moves} skipped`}
                  {lastExecutionResult.failed_moves > 0 &&
                    `, ${lastExecutionResult.failed_moves} failed`}
                  .
                </span>
              </div>
            )}

            {/* Preview Report */}
            {organizePreview && (
              <>
                <div className="preview-stats-row">
                  <div className="stat-card">
                    <div className="stat-number">{organizePreview.total_files}</div>
                    <div className="stat-label">Total Titles</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-number">
                      {organizePreview.items.filter((i) => i.is_selected).length}
                    </div>
                    <div className="stat-label">Selected to Move</div>
                  </div>
                  <div
                    className={`stat-card ${
                      organizePreview.collision_count > 0 ? "warn" : ""
                    }`}
                  >
                    <div className="stat-number">{organizePreview.collision_count}</div>
                    <div className="stat-label">Collisions</div>
                  </div>
                  <div
                    className={`stat-card ${
                      organizePreview.cross_drive_count > 0 ? "warn" : ""
                    }`}
                  >
                    <div className="stat-number">
                      {organizePreview.cross_drive_count}
                    </div>
                    <div className="stat-label">Cross-Drive Moves</div>
                  </div>
                  <div
                    className={`stat-card ${
                      organizePreview.blocked_count > 0 ? "blocked" : ""
                    }`}
                  >
                    <div className="stat-number">{organizePreview.blocked_count}</div>
                    <div className="stat-label">Blocked / Safe</div>
                  </div>
                </div>

                <div className="preview-table-wrapper">
                  <div className="preview-table-header">
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button
                        type="button"
                        className="btn-nudge"
                        onClick={() => handleToggleSelectAll(true)}
                      >
                        Select All
                      </button>
                      <button
                        type="button"
                        className="btn-nudge"
                        onClick={() => handleToggleSelectAll(false)}
                      >
                        Deselect All
                      </button>
                      <span>
                        Showing {organizePreview.items.length} proposed file moves
                      </span>
                    </div>
                    <span style={{ fontSize: 10, color: "var(--muted)" }}>
                      Source Path → Target Path
                    </span>
                  </div>

                  <div className="preview-list">
                    {organizePreview.items.map((item) => (
                      <div
                        key={item.id}
                        className={`preview-item ${
                          item.is_system_path || item.is_read_only ? "blocked" : ""
                        } ${item.has_collision ? "has-collision" : ""}`}
                      >
                        <div>
                          <input
                            type="checkbox"
                            checked={item.is_selected}
                            disabled={item.is_system_path || item.is_read_only}
                            onChange={() => handleToggleSelectItem(item.id)}
                            style={{ cursor: "pointer" }}
                          />
                        </div>

                        <div className="source-path-box">
                          <div className="path-title">
                            <span>{item.display_title}</span>
                            <span className="genre-chip" style={{ margin: 0, padding: "2px 6px" }}>
                              {item.genre}
                            </span>
                          </div>
                          <span title={item.source_path}>{item.source_path}</span>
                        </div>

                        <div className="arrow-icon">
                          <ArrowRight size={15} />
                        </div>

                        <div className="target-path-box">
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            {item.has_collision && (
                              <span className="badge-collision" title="Target already exists on disk">
                                ⚠️ Collision
                              </span>
                            )}
                            {item.is_across_drives && (
                              <span className="badge-cross-drive" title="Cross-drive move requires copy & byte verification">
                                💽 Cross-Drive
                              </span>
                            )}
                            {(item.is_system_path || item.is_read_only) && (
                              <span className="badge-blocked">
                                ⛔ Blocked
                              </span>
                            )}
                          </div>
                          <span title={item.target_path}>{item.proposed_relative_path}</span>
                        </div>

                        <div>
                          {item.has_collision ? (
                            <select
                              className="collision-select"
                              value={item.collision_resolution}
                              onChange={(e) =>
                                handleChangeCollisionResolution(
                                  item.id,
                                  e.target.value
                                )
                              }
                            >
                              <option value="keep_both">Keep both (append &apos; (1)&apos;)</option>
                              <option value="skip">Skip file</option>
                            </select>
                          ) : (
                            <span style={{ fontSize: 10, color: "var(--muted)" }}>
                              {item.is_selected ? "Ready" : "Excluded"}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="organize-bottom-bar">
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>
                      <strong>
                        {organizePreview.items.filter((i) => i.is_selected).length}
                      </strong>{" "}
                      of {organizePreview.items.length} files selected to move
                    </div>

                    <button
                      type="button"
                      className="btn-primary"
                      disabled={
                        organizePreview.items.filter((i) => i.is_selected).length === 0
                      }
                      onClick={() => {
                        setConfirmAgreed(false);
                        setShowConfirmModal(true);
                      }}
                    >
                      <ShieldCheck size={14} />
                      <span>Review &amp; Double Confirm Move...</span>
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Rollback Ledger History */}
            {rollbackHistory.length > 0 && (
              <div className="rollback-history-card">
                <div className="organize-config-title">Rollback History &amp; Undo</div>
                <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--muted)" }}>
                  Every organization operation is securely journaled in your local SQLite ledger so you can restore files back to their previous locations anytime.
                </p>

                {rollbackHistory.map((batch) => (
                  <div key={batch.batch_id} className="rollback-item">
                    <div className="rollback-item-info">
                      <Undo2 size={15} style={{ color: "var(--cherry)" }} />
                      <div>
                        <strong>{batch.file_count} files organized</strong>
                        <div className="rollback-batch-tag">
                          Batch ID: {batch.batch_id} ·{" "}
                          {new Date(batch.timestamp * 1000).toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => handleRollbackBatch(batch.batch_id)}
                      disabled={isRollingBack}
                    >
                      {isRollingBack ? (
                        <Loader2 size={13} className="spin-icon" />
                      ) : (
                        <Undo2 size={13} />
                      )}
                      <span>Undo / Rollback</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
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
                <img
                  src="/flicklet-logo.svg"
                  alt=""
                  style={{
                    width: 76,
                    height: 76,
                    borderRadius: 18,
                    boxShadow: "0 8px 24px rgba(200, 62, 85, 0.25)",
                    display: "block",
                  }}
                />
              </div>
            </section>

            <form className="ai-search" onSubmit={askFlicklet}>
              <div className="ai-icon">
                {isAskingAssistant ? (
                  <Loader2 size={21} className="spin-icon" />
                ) : (
                  <WandSparkles size={21} />
                )}
              </div>
              <div className="ai-search-content">
                <label htmlFor="ai-question">ASK YOUR LITTLE MOVIE ASSISTANT</label>
                <input
                  id="ai-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="e.g. When does the spinning top stop in Inception? Or find something cozy..."
                  disabled={isAskingAssistant}
                />
              </div>
              <button
                className="ask-button"
                type="submit"
                disabled={isAskingAssistant || !question.trim()}
              >
                {isAskingAssistant ? (
                  <>
                    <span>Thinking...</span>
                    <Loader2 size={13} className="spin-icon" />
                  </>
                ) : (
                  <>
                    <span>Ask Flicklet</span>
                    <span>↗</span>
                  </>
                )}
              </button>
            </form>

            {/* Assistant Loading State */}
            {isAskingAssistant && (
              <div className="assistant-result-card">
                <div className="assistant-header">
                  <div className="assistant-title-group">
                    <div className="assistant-sparkle-icon">
                      <Loader2 className="spin-icon" size={18} />
                    </div>
                    <h4>Consulting Flicklet cinema memory...</h4>
                  </div>
                </div>
                <p className="assistant-summary" style={{ margin: 0 }}>
                  Analyzing scene moments and estimating timestamps for &ldquo;{question}&rdquo;...
                </p>
              </div>
            )}

            {/* Assistant Result Card */}
            {assistantResult && (
              <div className="assistant-result-card">
                <div className="assistant-header">
                  <div className="assistant-title-group">
                    <div className="assistant-sparkle-icon">
                      <Sparkles size={18} />
                    </div>
                    <h4>{assistantResult.matched_title}</h4>
                    {matchedCatalogItem ? (
                      <span className="assistant-matched-badge">
                        In your library
                      </span>
                    ) : (
                      <span className="assistant-matched-badge">
                        Cinema Knowledge
                      </span>
                    )}
                    <span
                      className={`confidence-pill confidence-${assistantResult.confidence.toLowerCase()}`}
                    >
                      {assistantResult.confidence} confidence
                    </span>
                  </div>
                  <button
                    className="btn-icon-close"
                    onClick={() => {
                      setAssistantResult(null);
                      setPlaybackMessage(null);
                    }}
                    title="Dismiss"
                  >
                    <X size={16} />
                  </button>
                </div>

                <p className="assistant-summary">
                  {assistantResult.scene_summary}
                </p>

                {adjustedTimestamp !== null && (
                  <div className="timestamp-box">
                    <div className="timestamp-bar">
                      <div className="timestamp-display">
                        <div className="timestamp-pill">
                          <span>⏱️</span>
                          <span>~{formatSeconds(adjustedTimestamp)}</span>
                          {assistantResult.is_estimate && (
                            <span className="estimated-tag">Estimated</span>
                          )}
                        </div>

                        <div className="timestamp-nudges">
                          <button
                            type="button"
                            className="btn-nudge"
                            onClick={() => handleNudge(-60)}
                            title="Jump back 60 seconds"
                          >
                            -60s
                          </button>
                          <button
                            type="button"
                            className="btn-nudge"
                            onClick={() => handleNudge(-15)}
                            title="Jump back 15 seconds"
                          >
                            -15s
                          </button>
                          <button
                            type="button"
                            className="btn-nudge"
                            onClick={() => handleNudge(15)}
                            title="Jump forward 15 seconds"
                          >
                            +15s
                          </button>
                          <button
                            type="button"
                            className="btn-nudge"
                            onClick={() => handleNudge(60)}
                            title="Jump forward 60 seconds"
                          >
                            +60s
                          </button>
                        </div>
                      </div>

                      {matchedCatalogItem && (
                        <div className="timestamp-actions">
                          {isVlcAvailable ? (
                            <button
                              type="button"
                              className="btn-play-vlc"
                              onClick={() =>
                                handlePlayInVlc(
                                  matchedCatalogItem.path,
                                  adjustedTimestamp
                                )
                              }
                            >
                              <Play size={13} fill="currentColor" />
                              <span>
                                Play in VLC at {formatSeconds(adjustedTimestamp)}
                              </span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn-play-vlc"
                              onClick={() =>
                                handleOpenDefaultPlayer(matchedCatalogItem.path)
                              }
                              title="Play with system default player"
                            >
                              <Play size={13} fill="currentColor" />
                              <span>Play in Default Player</span>
                            </button>
                          )}

                          <button
                            type="button"
                            className="btn-play-default"
                            onClick={() =>
                              handleOpenDefaultPlayer(matchedCatalogItem.path)
                            }
                            title="Play with system default player"
                          >
                            <span>Default Player</span>
                          </button>

                          <button
                            type="button"
                            className="btn-play-default"
                            onClick={() =>
                              handleRevealInExplorer(matchedCatalogItem.path)
                            }
                            title="Show in Windows Explorer"
                          >
                            <span>Show in Folder</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <p className="timestamp-explanation">
                      💡 {assistantResult.explanation ||
                        "Estimated based on standard release. Intros, edition differences, or logos may shift this timestamp slightly."}
                    </p>

                    {!isVlcAvailable && matchedCatalogItem && (
                      <p className="vlc-notice">
                        ℹ️ <strong>Tip:</strong> Install{" "}
                        <a
                          href="https://www.videolan.org/vlc/"
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => {
                            e.preventDefault();
                            openUrl("https://www.videolan.org/vlc/");
                          }}
                        >
                          VLC Media Player
                        </a>{" "}
                        to jump directly to estimated timestamps.
                      </p>
                    )}

                    {!matchedCatalogItem && (
                      <p className="not-in-library-notice">
                        📁 This title is not in your currently scanned folder. You can add the folder where it lives to enable 1-click playback.
                      </p>
                    )}
                  </div>
                )}

                {adjustedTimestamp === null && matchedCatalogItem && (
                  <div className="timestamp-box" style={{ marginTop: 12 }}>
                    <div className="timestamp-actions">
                      <button
                        type="button"
                        className="btn-play-vlc"
                        onClick={() =>
                          isVlcAvailable
                            ? handlePlayInVlc(matchedCatalogItem.path, null)
                            : handleOpenDefaultPlayer(matchedCatalogItem.path)
                        }
                      >
                        <Play size={13} fill="currentColor" />
                        <span>Play {matchedCatalogItem.display_title}</span>
                      </button>
                      <button
                        type="button"
                        className="btn-play-default"
                        onClick={() =>
                          handleRevealInExplorer(matchedCatalogItem.path)
                        }
                      >
                        <span>Show in Folder</span>
                      </button>
                    </div>
                  </div>
                )}

                {playbackMessage && (
                  <div className="scan-error-banner" style={{ marginTop: 12 }}>
                    <AlertCircle size={15} />
                    <span>{playbackMessage}</span>
                  </div>
                )}
              </div>
            )}

            <section className="library-section">
              <div className="section-heading">
                <div>
                  <p className="section-kicker">
                    {activeNav === "TV shows" && seriesViewMode === "grouped" && currentSeries
                      ? "SERIES HUB"
                      : activeNav === "TV shows" && seriesViewMode === "grouped"
                      ? "ORGANIZED SERIES COLLECTIONS"
                      : "A LITTLE BIT OF EVERYTHING"}
                  </p>
                  <h2>
                    {activeNav === "TV shows" && seriesViewMode === "grouped" && currentSeries
                      ? currentSeries.seriesTitle
                      : activeNav === "Home"
                      ? "Your collection"
                      : activeNav}
                  </h2>
                </div>
                <span className="item-count">
                  {isScanning
                    ? "Scanning..."
                    : activeNav === "TV shows" && seriesViewMode === "grouped" && currentSeries
                    ? `${visibleEpisodes.length} episode${visibleEpisodes.length === 1 ? "" : "s"}`
                    : activeNav === "TV shows" && seriesViewMode === "grouped"
                    ? `${filteredSeriesGroups.length} series · ${filteredCatalog.length} episodes`
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
                  {hasCatalog && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setActiveNav("Organize")}
                      title="Preview and organize library into genre folders"
                    >
                      <FolderTree size={13} />
                      <span>Organize</span>
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
                <div className="library-toolbar-actions">
                  {activeNav === "TV shows" && (
                    <div className="view-mode-toggle">
                      <button
                        type="button"
                        className={`view-mode-btn ${seriesViewMode === "grouped" ? "active" : ""}`}
                        onClick={() => {
                          setSeriesViewMode("grouped");
                          setSelectedSeries(null);
                        }}
                      >
                        By Series
                      </button>
                      <button
                        type="button"
                        className={`view-mode-btn ${seriesViewMode === "episodes" ? "active" : ""}`}
                        onClick={() => setSeriesViewMode("episodes")}
                      >
                        All Episodes
                      </button>
                    </div>
                  )}

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

                  {hasCatalog && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        className="btn-enrich-all"
                        onClick={() => handleAutoIdentifyLibrary(false, false)}
                        disabled={isEnrichingAllTmdb || isScanning}
                        title="Automatically identify titles, genres, posters & metadata using TMDB & Gemini AI"
                      >
                        {isEnrichingAllTmdb ? (
                          <>
                            <Loader2 size={13} className="spin-icon" />
                            <span>Auto-Identifying...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles size={13} />
                            <span>Auto-Identify</span>
                          </>
                        )}
                      </button>
                      <button
                        className="btn-enrich-all"
                        style={{
                          background: "var(--cream)",
                          border: "1px solid var(--border)",
                          color: "var(--ink-muted)",
                        }}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Re-query TMDB & Gemini AI for all items in your catalog to update posters, overviews and ratings?"
                            )
                          ) {
                            handleAutoIdentifyLibrary(true, false);
                          }
                        }}
                        disabled={isEnrichingAllTmdb || isScanning}
                        title="Force re-fetch official artwork and metadata from TMDB and Gemini for all items"
                      >
                        <RefreshCw size={12} />
                        <span>Force Refresh</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {enrichNotice && (
                <div className="status-callout success" style={{ marginBottom: 18 }}>
                  <CheckCircle2 size={16} />
                  <span>{enrichNotice}</span>
                </div>
              )}

              {/* Media Grid */}
              {hasCatalog ? (
                isScanning ? (
                  <div className="empty-state">
                    <Loader2 className="spin-icon" size={32} />
                    <h3>Scanning and syncing library...</h3>
                    <p>Updating SQLite catalog with discovered media files</p>
                  </div>
                ) : activeNav === "TV shows" && seriesViewMode === "grouped" ? (
                  currentSeries ? (
                    /* Detailed Series Hub */
                    <div className="series-hub">
                      <button
                        type="button"
                        className="series-back-btn"
                        onClick={() => {
                          setSelectedSeries(null);
                          setSelectedSeason("all");
                        }}
                      >
                        <ArrowLeft size={14} />
                        <span>Back to all TV series</span>
                      </button>

                      <div
                        className="series-hero-banner"
                        style={
                          currentSeries.backdropUrl
                            ? { backgroundImage: `url(${currentSeries.backdropUrl})` }
                            : undefined
                        }
                      >
                        <div className="series-hero-overlay" />
                        {currentSeries.posterUrl && (
                          <div className="series-hero-poster">
                            <img
                              src={currentSeries.posterUrl}
                              alt={currentSeries.seriesTitle}
                              onError={(e) => {
                                (e.currentTarget as HTMLElement).style.display = "none";
                              }}
                            />
                          </div>
                        )}
                        <div className="series-hero-info">
                          <div className="series-hero-meta">
                            <span className="genre-chip" style={{ margin: 0 }}>
                              {currentSeries.genres[0] || "TV Series"}
                            </span>
                            {currentSeries.voteAverage !== null && currentSeries.voteAverage > 0 && (
                              <span className="series-hero-rating">
                                <Star size={12} fill="#f6c854" stroke="#f6c854" />
                                <span>{currentSeries.voteAverage.toFixed(1)} / 10 TMDB</span>
                              </span>
                            )}
                            <span>•</span>
                            <span>
                              {currentSeries.seasons.length}{" "}
                              {currentSeries.seasons.length === 1 ? "Season" : "Seasons"}
                            </span>
                            <span>•</span>
                            <span>
                              {currentSeries.episodes.length}{" "}
                              {currentSeries.episodes.length === 1 ? "Episode" : "Episodes"}
                            </span>
                            <span>•</span>
                            <span>{formatBytes(currentSeries.totalSizeBytes)}</span>
                          </div>
                          <h1 className="series-hero-title">{currentSeries.seriesTitle}</h1>
                          {currentSeries.overview && (
                            <p className="series-hero-overview">{currentSeries.overview}</p>
                          )}
                        </div>
                      </div>

                      {/* Season Selector Bar */}
                      {currentSeries.seasons.length > 1 && (
                        <div className="season-selector-bar">
                          <button
                            type="button"
                            className={`season-pill ${selectedSeason === "all" ? "active" : ""}`}
                            onClick={() => setSelectedSeason("all")}
                          >
                            All Seasons ({currentSeries.episodes.length})
                          </button>
                          {currentSeries.seasons.map((s) => {
                            const count = currentSeries.episodes.filter(
                              (e) => (e.season_number ?? 1) === s
                            ).length;
                            return (
                              <button
                                key={s}
                                type="button"
                                className={`season-pill ${selectedSeason === s ? "active" : ""}`}
                                onClick={() => setSelectedSeason(s)}
                              >
                                Season {s} ({count})
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Episode Rows Grid */}
                      <div className="episodes-grid">
                        {visibleEpisodes.map((ep) => {
                          const isClassifying = classifyingItemId === ep.id;
                          const isEnriching = enrichingItemId === ep.id;
                          return (
                            <article className="episode-row-card" key={ep.id}>
                              <div className="episode-still">
                                {ep.poster_url ? (
                                  <img
                                    src={ep.poster_url}
                                    alt={ep.display_title}
                                    loading="lazy"
                                    onError={(e) => {
                                      (e.currentTarget as HTMLElement).style.display = "none";
                                    }}
                                  />
                                ) : (
                                  <div className="episode-still-fallback">
                                    <span>📺</span>
                                  </div>
                                )}
                                <span className="episode-badge-pill">
                                  S{ep.season_number ?? 1} E{ep.episode_number ?? 1}
                                </span>
                                {ep.vote_average !== null && ep.vote_average > 0 && (
                                  <span className="episode-rating-pill">
                                    <Star size={9} fill="#ffd166" stroke="#ffd166" />
                                    <span>{ep.vote_average.toFixed(1)}</span>
                                  </span>
                                )}
                              </div>

                              <div className="episode-details">
                                <div>
                                  <div className="episode-header">
                                    <h4 className="episode-title">{ep.display_title}</h4>
                                    <button
                                      className={`favorite-button ${
                                        ep.is_favorite ? "favorited" : ""
                                      }`}
                                      aria-label={`Favorite ${ep.display_title}`}
                                      onClick={() => handleToggleFavorite(ep.id)}
                                    >
                                      <Heart size={16} />
                                    </button>
                                  </div>
                                  {ep.overview && (
                                    <p className="episode-overview" title={ep.overview}>
                                      {ep.overview}
                                    </p>
                                  )}
                                </div>

                                <div className="episode-footer">
                                  <div className="episode-file-meta" title={ep.path}>
                                    {formatBytes(ep.size_bytes)} · {ep.extension.toUpperCase()} ·{" "}
                                    {ep.filename}
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <button
                                      type="button"
                                      className="btn-play-default"
                                      onClick={() =>
                                        isVlcAvailable
                                          ? handlePlayInVlc(ep.path, null)
                                          : handleOpenDefaultPlayer(ep.path)
                                      }
                                      style={{
                                        background: "var(--cherry)",
                                        color: "#fffdfa",
                                        borderColor: "var(--cherry)",
                                        padding: "5px 11px",
                                        fontSize: 11,
                                      }}
                                    >
                                      <Play size={11} fill="currentColor" />
                                      <span>Play Episode</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="btn-play-default"
                                      onClick={() => handleRevealInExplorer(ep.path)}
                                      title="Show in Windows Explorer"
                                      style={{ padding: "5px 9px", fontSize: 11 }}
                                    >
                                      <span>Folder</span>
                                    </button>
                                    {ep.ai_status === "approved" ? (
                                      <span className="badge-ai-approved">
                                        <Sparkles size={10} /> Verified
                                      </span>
                                    ) : (
                                      <button
                                        className="btn-ai-classify"
                                        onClick={() => handleClassifyItem(ep)}
                                        disabled={isClassifying}
                                        title="Auto-identify episode with TMDB & Gemini AI"
                                      >
                                        {isClassifying ? (
                                          <Loader2 size={11} className="spin-icon" />
                                        ) : (
                                          <Sparkles size={11} />
                                        )}
                                        <span>Auto-Identify</span>
                                      </button>
                                    )}
                                    <button
                                      className="btn-tmdb-enrich"
                                      onClick={() => handleEnrichItem(ep)}
                                      disabled={isEnriching}
                                      title="Refresh TMDB episode details"
                                    >
                                      {isEnriching ? (
                                        <Loader2 size={10} className="spin-icon" />
                                      ) : (
                                        <ImageIcon size={10} />
                                      )}
                                      <span>TMDB</span>
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  ) : filteredSeriesGroups.length > 0 ? (
                    /* Series Cards Grid */
                    <div className="movie-grid">
                      {filteredSeriesGroups.map((show, idx) => {
                        const tones = [
                          "poster-wolf",
                          "poster-romance",
                          "poster-mystery",
                          "poster-horror",
                        ];
                        const tone = tones[idx % tones.length];
                        return (
                          <article
                            className="movie-card"
                            key={show.seriesTitle}
                            onClick={() => {
                              setSelectedSeries(show.seriesTitle);
                              setSelectedSeason("all");
                            }}
                            style={{ cursor: "pointer" }}
                          >
                            <div
                              className={`poster ${tone}`}
                              title={`View ${show.seriesTitle} Episodes`}
                            >
                              {show.posterUrl ? (
                                <>
                                  <img
                                    src={show.posterUrl}
                                    alt={show.seriesTitle}
                                    className="poster-img"
                                    loading="lazy"
                                    onError={(e) => {
                                      (e.currentTarget as HTMLElement).style.display = "none";
                                    }}
                                  />
                                  <div className="poster-overlay-gradient" />
                                  {show.voteAverage !== null && show.voteAverage > 0 && (
                                    <span
                                      className="poster-rating-badge"
                                      title={`TMDB Rating: ${show.voteAverage.toFixed(1)} / 10`}
                                    >
                                      <Star size={11} fill="#f6c854" stroke="#f6c854" />
                                      <span>{show.voteAverage.toFixed(1)}</span>
                                    </span>
                                  )}
                                  <span className="series-count-badge">
                                    <Tv size={11} />
                                    <span>
                                      {show.seasons.length}{" "}
                                      {show.seasons.length === 1 ? "Season" : "Seasons"} ·{" "}
                                      {show.episodes.length} Eps
                                    </span>
                                  </span>
                                  <span
                                    className="poster-title"
                                    style={{ position: "relative", zIndex: 1 }}
                                  >
                                    {show.seriesTitle}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span className="poster-symbol">📺</span>
                                  <span className="poster-title">{show.seriesTitle}</span>
                                  <span className="series-count-badge">
                                    <Tv size={11} />
                                    <span>
                                      {show.seasons.length} Season(s) · {show.episodes.length} Eps
                                    </span>
                                  </span>
                                </>
                              )}
                            </div>
                            <div className="movie-info">
                              <div style={{ minWidth: 0, overflow: "hidden" }}>
                                <h3
                                  title={show.seriesTitle}
                                  style={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {show.seriesTitle}
                                </h3>
                                <p>
                                  {show.seasons.length}{" "}
                                  {show.seasons.length === 1 ? "Season" : "Seasons"} ·{" "}
                                  {show.episodes.length} Episodes · {formatBytes(show.totalSizeBytes)}
                                </p>
                                {show.overview && (
                                  <p className="card-overview" title={show.overview}>
                                    {show.overview}
                                  </p>
                                )}
                              </div>
                            </div>
                            <div className="card-actions">
                              <span className="genre-chip" style={{ marginTop: 0 }}>
                                {show.genres[0] || "TV Series"}
                              </span>
                              <button
                                type="button"
                                className="btn-play-default"
                                style={{
                                  background: "var(--cherry)",
                                  color: "#fffdfa",
                                  borderColor: "var(--cherry)",
                                  padding: "4px 10px",
                                  fontSize: 10,
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedSeries(show.seriesTitle);
                                  setSelectedSeason("all");
                                }}
                              >
                                <span>View Episodes ↗</span>
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <Tv size={32} />
                      <h3>No TV series found</h3>
                      <p>
                        Try searching with another keyword or ensure your video files are scanned.
                      </p>
                    </div>
                  )
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
                            {item.poster_url ? (
                              <>
                                <img
                                  src={item.poster_url}
                                  alt={item.display_title}
                                  className="poster-img"
                                  loading="lazy"
                                  onError={(e) => {
                                    (e.currentTarget as HTMLElement).style.display = "none";
                                  }}
                                />
                                <div className="poster-overlay-gradient" />
                                {item.vote_average != null && item.vote_average > 0 && (
                                  <span
                                    className="poster-rating-badge"
                                    title={`TMDB Rating: ${item.vote_average.toFixed(1)} / 10`}
                                  >
                                    <Star size={11} fill="#f6c854" stroke="#f6c854" />
                                    <span>{item.vote_average.toFixed(1)}</span>
                                  </span>
                                )}
                                {item.season_number && item.episode_number ? (
                                  <span
                                    className="poster-type"
                                    style={{
                                      background: "rgba(30, 15, 24, 0.9)",
                                      color: "#fff",
                                      border: "1px solid rgba(255, 255, 255, 0.3)",
                                      fontWeight: 700,
                                    }}
                                  >
                                    S{item.season_number} E{item.episode_number}
                                  </span>
                                ) : (
                                  <span className="poster-type">
                                    {item.extension.toUpperCase()}
                                  </span>
                                )}
                                <span
                                  className="poster-title"
                                  style={{ position: "relative", zIndex: 1 }}
                                >
                                  {item.display_title}
                                </span>
                                <span
                                  className="poster-year"
                                  style={{ position: "relative", zIndex: 1 }}
                                >
                                  {item.release_year
                                    ? item.release_year
                                    : formatBytes(item.size_bytes)}
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="poster-symbol">{symbol}</span>
                                <span className="poster-title">
                                  {item.display_title}
                                </span>
                                <span className="poster-year">
                                  {item.release_year
                                    ? item.release_year
                                    : formatBytes(item.size_bytes)}
                                </span>
                                {item.season_number && item.episode_number ? (
                                  <span
                                    className="poster-type"
                                    style={{
                                      background: "rgba(30, 15, 24, 0.9)",
                                      color: "#fff",
                                      border: "1px solid rgba(255, 255, 255, 0.3)",
                                      fontWeight: 700,
                                    }}
                                  >
                                    S{item.season_number} E{item.episode_number}
                                  </span>
                                ) : (
                                  <span className="poster-type">
                                    {item.extension.toUpperCase()}
                                  </span>
                                )}
                              </>
                            )}
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
                              {item.overview && (
                                <p className="card-overview" title={item.overview}>
                                  {item.overview}
                                </p>
                              )}
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
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <button
                                type="button"
                                className="btn-card-play"
                                onClick={() =>
                                  isVlcAvailable
                                    ? handlePlayInVlc(item.path, null)
                                    : handleOpenDefaultPlayer(item.path)
                                }
                                title={
                                  isVlcAvailable
                                    ? "Play in VLC"
                                    : "Play with Default Player"
                                }
                              >
                                <Play size={11} fill="currentColor" />
                              </button>
                              <span className="genre-chip" style={{ marginTop: 0 }}>
                                {item.primary_genre && item.primary_genre !== "Unknown"
                                  ? item.primary_genre
                                  : item.media_type === "series" || item.series_title !== null
                                  ? "Series"
                                  : "Movie"}
                              </span>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {item.ai_status === "approved" ? (
                                <span
                                  className="badge-ai-approved"
                                  title="Metadata verified with TMDB & AI"
                                >
                                  <Sparkles size={10} /> Verified
                                </span>
                              ) : (
                                <button
                                  className="btn-ai-classify"
                                  onClick={() => handleClassifyItem(item)}
                                  disabled={isClassifying}
                                  title="Auto-identify title, genre & artwork with TMDB & Gemini AI"
                                >
                                  {isClassifying ? (
                                    <>
                                      <Loader2 size={11} className="spin-icon" />
                                      <span>Identifying...</span>
                                    </>
                                  ) : (
                                    <>
                                      <Sparkles size={11} />
                                      <span>Auto-Identify</span>
                                    </>
                                  )}
                                </button>
                              )}

                              <button
                                className="btn-tmdb-enrich"
                                onClick={() => handleEnrichItem(item)}
                                disabled={enrichingItemId === item.id}
                                title={
                                  item.poster_url
                                    ? "Refresh TMDB Poster & Artwork"
                                    : "Fetch TMDB Poster & Artwork"
                                }
                              >
                                {enrichingItemId === item.id ? (
                                  <Loader2 size={10} className="spin-icon" />
                                ) : (
                                  <ImageIcon size={10} />
                                )}
                                <span>{item.poster_url ? "TMDB" : "Poster"}</span>
                              </button>
                            </div>
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

        {/* Double Confirmation Modal for Safe Organization */}
        {showConfirmModal && organizePreview && (
          <div
            className="modal-backdrop"
            onClick={() => {
              if (!isExecutingOrganize) setShowConfirmModal(false);
            }}
          >
            <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>
                    <ShieldAlert size={14} color="var(--cherry)" /> DOUBLE CONFIRMATION REQUIRED
                  </div>
                  <h3>Confirm Library Reorganization</h3>
                </div>
                <button
                  type="button"
                  className="btn-icon-close"
                  onClick={() => {
                    if (!isExecutingOrganize) setShowConfirmModal(false);
                  }}
                  disabled={isExecutingOrganize}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="confirm-callout">
                <strong>Safety check before moving files:</strong>
                <br />
                You are about to organize{" "}
                <strong>
                  {organizePreview.items.filter((i) => i.is_selected).length} files
                </strong>{" "}
                into standard genre folders at:
                <br />
                <code
                  style={{
                    display: "block",
                    margin: "6px 0",
                    padding: "4px 8px",
                    background: "#fff8f9",
                    borderRadius: 6,
                    fontSize: 10,
                    wordBreak: "break-all",
                  }}
                >
                  {organizeTargetRoot}
                </code>
                • A rollback entry will be recorded so you can undo this anytime.
                <br />
                • Destination byte sizes are verified before source files are removed.
                <br />
                • Blocked system files and read-only files are preserved automatically.
              </div>

              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmAgreed}
                  onChange={(e) => setConfirmAgreed(e.target.checked)}
                  disabled={isExecutingOrganize}
                />
                <span>I have reviewed the preview and approve moving these files.</span>
              </label>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowConfirmModal(false)}
                  disabled={isExecutingOrganize}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!confirmAgreed || isExecutingOrganize}
                  onClick={handleExecuteOrganize}
                >
                  {isExecutingOrganize ? (
                    <>
                      <Loader2 size={13} className="spin-icon" />
                      <span>Moving files safely...</span>
                    </>
                  ) : (
                    <>
                      <FolderCheck size={13} />
                      <span>Execute Organization</span>
                    </>
                  )}
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
