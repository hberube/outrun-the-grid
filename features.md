# Features

A living list of what's shipped and what's worth building next. Update this as the product evolves.

---

## Shipped

### Core playback & sync
- **Split-screen layout** — video left, interactive map right, full viewport on desktop; stacked single-column on mobile
- **YouTube IFrame player** — embedded via YouTube IFrame API; video ID stored per run in `runs.json`
- **Live position marker** — neon dot moves along the route in sync with video playback (250ms resolution via `setInterval`)
- **Binary search sync** — O(log n) route lookup on every tick, not a linear scan
- **Seek detection** — 500ms poll detects scrubs (Δt > 3s) and resets landmark state so cards re-trigger correctly after scrubbing

### HUD
- **Pace** — real-time min/km, derived from GPX timestamps and haversine distance
- **Elevation** — meters above sea level from GPX elevation data
- **Elapsed time** — seconds since run start, formatted as m:ss

### Map
- **Route polyline** — GPX track drawn on Leaflet / OpenStreetMap in neon cyan
- **Landmark map pins** — POIs plotted with source-colored markers (pink = OSM, purple = Wikipedia); tooltip on hover
- **Map zoom on landmark** — map flies in to zoom 17 when passing a POI, returns to full route bounds after 6 seconds
- **300px fixed height** (desktop) / **35vh** (mobile) — keeps video dominant

### Landmarks
- **Dynamic landmark fetching** — Overpass API (OSM POIs) and Wikipedia Geosearch queried live in the browser; results cached in `localStorage` per route fingerprint
- **Build-time landmarks** — `scripts/build.py` fetches Overpass + Wikipedia and calls Claude Haiku to generate 2-sentence summaries; output committed to `data/runs/{id}/landmarks.json` and served statically (browser falls back to live fetch if file is absent)
- **Landmark overlay cards** — neon popup spans full viewport width when passing a POI; Wikipedia = purple, OSM = pink; auto-dismisses after 3.5s
- **Landmarks legend** — collapsible panel listing all POIs in time order; click any row to seek video to that timestamp
- **Active legend highlight** — current landmark row glows cyan and auto-scrolls into view as video plays

### Did You Know modal
- **Wikipedia extract** — clicking a landmark or legend row opens a modal with a Wikipedia summary and "Read more" link
- **Claude Haiku summaries** — if `landmarks.json` was built with `ANTHROPIC_API_KEY` set, the 2-sentence summary is already baked in and shown instantly; otherwise fetched live from Wikipedia
- **DYK source badge** — shows whether text came from Wikipedia or OSM

### Voice narration
- **VOX toggle** — button in HUD; preference persisted in `localStorage`
- **Natural voice selection** — picks Google Neural > Microsoft Natural > Microsoft > any non-local English voice at runtime
- **Queued narration** — landmark name spoken first, then 2-sentence summary; next landmark waits for previous to finish (no interruption)
- **Run-switch cleanup** — switching runs or toggling VOX off cancels speech and resets the queue

### Narration transcript
- **Scrolling script panel** — fills the bottom-right of the map panel; lists every landmark with its timestamp, name, and summary
- **Synchronized highlight** — active landmark glows cyan with left border and auto-scrolls into view; passed landmarks dim slightly
- **Async text fill** — panel renders immediately with placeholders; summaries fill in as they resolve
- **Hidden on mobile** — not shown on small screens where vertical space is tight

### Runs playlist
- **`runs.json` manifest** — each entry has `id`, `name`, `date`, `distance`, `videoId`, `gpx`
- **RUNS panel** — slide-in overlay triggered by header button; lists all runs as selectable cards
- **Run switching** — selecting a run loads the correct video, route, landmark pins, legend, and transcript without a page reload
- **Black-screen fix** — `stopVideo()` + 150ms delay + `setSize()` on switch to avoid YouTube IFrame rendering bug

### Build pipeline (`scripts/build.py`)
- **GPX parsing** — extracts `t`, `lat`, `lon`, `pace`, `ele` for every track point
- **Insta360 longitude fix** — auto-detects and corrects the Insta360 Studio western-hemisphere sign bug
- **Overpass landmark fetch** — queries OSM POIs within 50m of the route
- **Wikipedia enrichment** — fetches intro extract for each landmark by name (with search fallback)
- **Claude Haiku summarization** — if `ANTHROPIC_API_KEY` is set, compresses Wikipedia text to 2 conversational sentences
- **Output** — `data/runs/{id}/route_data.json` and `data/runs/{id}/landmarks.json`; both committed to repo

### Configuration
- **`config.json`** — `landmarkWindowSeconds` and `landmarkSources` configurable without touching code
- **`.gitignore`** — raw `.gpx` files excluded; `data/runs/` JSON committed

### Mobile
- **Stacked layout** — single-column below 700px
- **16:9 video** — `padding-bottom: 56.25%` aspect-ratio trick
- **Bottom-sheet DYK** — slides up from screen bottom with animation
- **Full-width RUNS panel** — no side margins on mobile
- **Legend starts collapsed** — saves vertical space; 40px tap targets

---

## Ideas & Next Phases

### Phase 2 — Reactive Telemetry

The run's data starts driving the visual state of the dashboard.

- **Dynamic polyline colors** — route polyline shifts from cyan (fast) to pink (slow) per segment; live marker emits a short "light cycle" tail
- **Gradient computation** — add `gradient` (%) to `route_data.json` at build time; steep climbs flagged as Boss Zones
- **Pace streaks** — trigger a glowing "Combo" visual on the HUD when holding a target pace for more than a kilometer
- **Boss Zones** — when playback enters a steep climb, shift the UI into high-effort mode (pulsing magenta grid, color shift)
- **Elevation profile** — mini chart below the video showing full route with a playhead cursor

### Phase 3 — Cinematic Layer

- **AI chapter titles** — at build time, pass segment telemetry to Claude to generate 80s-inspired chapter titles (e.g., "Heartbreak Hill / Midnight Stride") timestamped along the route and shown as overlay text
- **Director's Cut Mode** — hotkey that fades map and HUD to focus on the neon-bordered video; snaps back on landmark or Boss Zone trigger
- **Playback speed control** — 1× / 1.5× / 2× to accelerate through flat sections

### Phase 4 — Multi-Runner

- **Ghost runners** — load a second GPX to overlay two polylines and two markers on the same map with synchronized playback
- **The Gap Metric** — real-time HUD stat showing time/distance gap between Runner A and B
