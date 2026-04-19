# Features

A living list of what's shipped and what's worth building next. Update this as the product evolves — cross things off, add new ideas, reprioritize freely.

---

## Shipped

- **Split-screen layout** — video left, interactive map right, full viewport
- **Route polyline** — GPX track drawn on the Leaflet map in neon cyan
- **Live position marker** — neon dot moves along the route in sync with video playback (250ms resolution)
- **HUD** — real-time pace (min/km), elevation (m), and elapsed time updated every tick
- **Landmark overlay cards** — neon notification card flashes over the video when you pass a point of interest
- **Landmark map pins** — Overpass API POIs within 50m of the route marked on the map
- **Seek detection** — scrubbing the video resets landmark state so cards re-trigger correctly
- **Synthwave aesthetic** — dark backgrounds, glowing cyan/pink borders, retro grid, monospace font
- **`config.json`** — per-run settings (YouTube video ID, landmark trigger window) editable without touching code
- **Insta360 longitude fix** — auto-detects and corrects the Insta360 Studio GPX sign bug for western-hemisphere runs

---

## Ideas

These are unordered and uncommitted — possibilities worth exploring as the project matures.

### Data & Telemetry
- **Elevation profile** — chart below the video showing the full route elevation with a playhead cursor
- **Pace color-coding** — route polyline color-shifts from cyan (fast) to pink (slow) based on per-segment pace
- **Split markers** — km or mile markers on the map with time callouts (e.g. "km 3 — 5:12")
- **Heart rate overlay** — if Garmin exports HR data in the GPX, show it in the HUD
- **Video/GPS offset calibration** — input field to shift the GPS timestamps relative to the video (handles cases where the camera started before/after the watch)

### UI & Experience
- **Mobile layout** — stacked vertical layout (video top, map bottom) for phones
- **Fullscreen map mode** — toggle to expand the map to full screen without leaving the page
- **Playback speed control** — 1x / 1.5x / 2x buttons to review efforts faster
- **Dark/light map tiles** — toggle between OSM standard and a dark CartoDB basemap

### Content & Sharing
- **Custom landmark list** — define named waypoints in `config.json` as a fallback or override for Overpass (useful when Overpass is down or a landmark isn't in OSM)
- **Highlight reel timestamps** — mark moments during playback that get exported as a shareable list (e.g. for cutting a recap video)
- **Shareable URL with timestamp** — URL hash encodes current playback time so you can link to a specific moment

### Infrastructure
- **GitHub Actions build step** — commit a GPX file to a `runs/` folder and a workflow automatically runs `build.py` and commits the resulting JSON files
- **Multi-run index** — a landing page listing all runs with thumbnails, letting you pick which one to load
- **Multi-run comparison** — overlay two route polylines on the same map with synchronized playback
