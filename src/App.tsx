
import { useState, type FormEvent } from "react";
import {
  Clapperboard,
  Compass,
  Film,
  FolderHeart,
  Heart,
  Search,
  Settings,
  Sparkles,
  Tv,
  WandSparkles,
} from "lucide-react";
import "./App.css";

type MediaItem = {
  title: string;
  year: number;
  genre: string;
  kind: "Movie" | "Series";
  tone: string;
  symbol: string;
};

const media: MediaItem[] = [
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

  const genres = [
    "All",
    "Romantic Comedy",
    "Horror",
    "Supernatural",
    "Mystery",
  ];

  const filteredMedia = media.filter((item) => {
    const matchesSearch = item.title
      .toLowerCase()
      .includes(query.toLowerCase());

    const matchesGenre = genre === "All" || item.genre === genre;
    const matchesNav =
      activeNav !== "All movies" ||
      item.kind === "Movie";
    const matchesSeries =
      activeNav !== "TV shows" ||
      item.kind === "Series";

    return matchesSearch && matchesGenre && matchesNav && matchesSeries;
  });

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
              {filteredMedia.length} titles <Heart size={13} />
            </span>
          </div>

          <div className="library-toolbar">
            <div className="library-search">
              <Search size={17} />
              <input
                aria-label="Search titles"
                placeholder="Find a title..."
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
                {genres.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="movie-grid">
            {filteredMedia.map((item) => (
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
                    <p>{item.year} <span>·</span> {item.kind}</p>
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

          {filteredMedia.length === 0 && (
            <div className="empty-state">
              <Film size={30} />
              <h3>No titles found just yet</h3>
              <p>Try another search or choose a different genre.</p>
            </div>
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
