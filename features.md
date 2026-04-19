# Features

A living list of what's shipped and what's worth building next. Update this as the product evolves.

---

## Shipped

- **Split-screen layout** — video left, interactive map right, full viewport
- **Route polyline** — GPX track drawn on the Leaflet map in neon cyan
- **Live position marker** — neon dot moves along the route in sync with video playback (250ms resolution)
- **HUD** — real-time pace (min/km), elevation (m), and elapsed time updated every tick
- **Dynamic landmark fetching** — Overpass API (OSM POIs) and Wikipedia Geosearch queried live in the browser; results cached in `localStorage` per route fingerprint so subsequent loads are instant
- **Landmark overlay cards** — neon popup spans both panels when you pass a point of interest; Wikipedia landmarks show in purple, OSM in pink
- **Landmark map pins** — POIs plotted on the map with source-colored markers
- **Seek detection** — scrubbing the video resets landmark state so cards re-trigger correctly
- **Synthwave aesthetic** — dark backgrounds, glowing cyan/pink/purple borders, retro grid, monospace font
- **`config.json`** — per-run settings (video ID, landmark window, enabled sources) editable without touching code
- **Insta360 longitude fix** — auto-detects and corrects the Insta360 Studio GPX sign bug for western-hemisphere runs

---

## Ideas & Next Phases

Uncommitted possibilities, ordered loosely by impact and buildability.

### Phase 2 — Reactive Telemetry

The run's data starts driving the visual state of the dashboard, not just the marker position.

- **Dynamic polyline colors** — route polyline color-shifts from cyan (fast) to pink (slow) per segment; the live marker emits a short "light cycle" tail
- **Gradient computation** — add `gradient` (%) to `route_data.json` during the build step; steep climbs get flagged as Boss Zones
- **Pace Streaks** — trigger a glowing "Combo" visual on the HUD when holding a target pace for more than a kilometer
- **Boss Zones** — when playback enters a steep climb, shift the UI into a high-effort mode (pulsing magenta grid, color shift)
- **Elevation profile** — chart below the video showing the full route with a playhead cursor

### Phase 3 — Cinematic Layer

Narrative and visual storytelling on top of the telemetry.

- **AI "Color Commentary"** — during the build step, pass segment telemetry to Claude to generate 80s-inspired chapter titles (e.g., "Heartbreak Hill / Midnight Stride") timestamped along the route
- **Director's Cut Mode** — hotkey that fades the map and HUD to focus on the neon-bordered video; snaps back on landmark or Boss Zone trigger
- **Playback speed control** — 1× / 1.5× / 2× to accelerate through flat sections

### Phase 4 — Multi-Runner

- **Ghost Runners** — load a second GPX to overlay two polylines and two markers on the same map with synchronized playback
- **The Gap Metric** — real-time HUD stat showing time/distance gap between Runner A and B
- **Multi-run index page** — landing page listing all runs with thumbnails, letting you pick which to load
