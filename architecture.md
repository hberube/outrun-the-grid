# Architecture

Outrun the Grid has two separate layers. The build layer runs once locally per run; the runtime layer runs in any browser with no server.

---

## Build Layer (local Python)

```text
your_run.gpx
     │
     ▼
scripts/build.py  ←── ANTHROPIC_API_KEY (optional, env var only)
     │
     ├─▶ data/runs/{id}/route_data.json   [{t, lat, lon, pace, ele}, ...]
     └─▶ data/runs/{id}/landmarks.json    [{t, name, lat, lon, source, summary, link}, ...]
```

**`scripts/build.py`** takes a `.gpx` file and a `--id` slug and produces two JSON files:

1. **GPX parsing** (`parse_gpx`) — walks every track point:
   - `t`: seconds since first point
   - `lat`, `lon`: coordinates (Insta360 sign-fix applied if needed)
   - `pace`: min/km from time delta ÷ haversine distance
   - `ele`: elevation in meters

2. **Insta360 longitude fix** — compares `gpx.bounds.max_longitude` sign to `points[0].longitude`; negates all longitudes if they disagree (western hemisphere bug in Insta360 Studio GPX export)

3. **Overpass landmark fetch** (`fetch_overpass_landmarks`) — POIs with `amenity`, `tourism`, `historic`, or `leisure` tags within 50m of the route bbox; deduplicates within 5-second buckets

4. **Wikipedia enrichment** (`fetch_wikipedia_info`) — fetches intro extract by landmark name; falls back to Wikipedia search if direct lookup misses

5. **Claude Haiku summarization** (`summarize_with_claude`) — if `ANTHROPIC_API_KEY` is set, compresses the Wikipedia text to 2 conversational sentences using `claude-haiku-4-5-20251001`; key never written to any file

Both output files are committed to the repo (`data/runs/` is not gitignored). Raw `.gpx` files are gitignored.

---

## Runtime Layer (static browser)

```text
Browser boot
  │
  ├── fetch config.json            ← landmarkWindowSeconds, landmarkSources
  ├── fetch runs.json              ← playlist of runs (id, name, date, distance, videoId, gpx)
  │
  ├── Leaflet.js (OpenStreetMap)   ← route polyline + neon marker
  └── YouTube IFrame API           ← video player
            │
            └── setInterval 250ms ─▶ binary search route_data
                                      move marker
                                      update HUD (pace, ele, time)
                                      check & fire landmark cards
                                      update active legend + transcript row

  Per-run data (on selectRun):
  ├── fetch data/runs/{id}/route_data.json
  ├── fetch data/runs/{id}/landmarks.json   ←── static (pre-built summaries)
  │     └── 404? → fetch Overpass + Wikipedia live → cache in localStorage
  └── render map, legend, transcript
```

### Boot sequence

`config.json` and `runs.json` are fetched in parallel. The YouTube player is created exactly once — after both the IFrame API script fires `onYouTubeIframeAPIReady` **and** the config fetch resolves. A `|| ytPlayer` guard in `tryInitPlayer` prevents double-creation.

`selectRun(runs[0])` is called automatically after boot to load the first run.

### Run switching

`selectRun(run)` is the single entry point for loading any run:
1. Fetch `route_data.json` for the run
2. `resetMap()` — removes old route polyline, pins, and marker layers
3. Switch YouTube video:
   - If player ready: `stopVideo()` → 150ms delay → `loadVideoById()` + `setSize()` (avoids black-screen rendering bug)
   - If player not yet ready: store `pendingVideoId`; delivered in `onReady`
4. Fetch landmarks (static file first, live fetch fallback)
5. Rebuild legend and transcript

### Sync loop

Every 250ms while playing:
1. `ytPlayer.getCurrentTime()` → `t`
2. Binary-search `route_data` on `t` — O(log n)
3. Move Leaflet marker to `[pt.lat, pt.lon]`
4. Update HUD (pace, elevation, elapsed time)
5. Check landmarks: any `lm.t` within ±`landmarkWindowSeconds` not yet shown → `showLandmarkCard(lm)`
6. Update active legend row and transcript row (both auto-scroll)

`showLandmarkCard` also triggers:
- Map `flyTo(lm coords, zoom 17)` — returns to route bounds after 6s via `setTimeout`
- `speakLandmark(lm)` — queued via promise chain; name then summary; checks `voiceEnabled` before each step

A 500ms poll detects seeks (Δt > 3s) and clears `shownLandmarks` so cards re-trigger after scrubbing.

### Voice narration queue

```text
speakLandmark(lm)
  └── speakQueue = speakQueue.then(async () => {
        await speakUtterance(lm.name)      ← waits for onend
        info = await fetchLandmarkInfo(lm)
        await speakUtterance(info.text)    ← waits for onend
      })
```

Each landmark runs fully before the next starts. `cancelSpeech()` calls `speechSynthesis.cancel()` and resets `speakQueue` to `Promise.resolve()`.

### Landmark info resolution

`fetchLandmarkInfo(lm)` priority order:
1. `dykCache` (in-memory, cleared on run switch)
2. `lm.summary` (pre-built by `build.py` via Claude — instant)
3. Direct Wikipedia extract by name
4. Wikipedia search → extract
5. Fallback text

### Landmark cache (live fetch path)

Cache key: `otg_lm_v2_{lat0}_{lon0}_{latMid}_{latEnd}_{pointCount}` in `localStorage`. Bump `CACHE_VERSION` in `app.js` to force re-fetch across all users.

Wikipedia summary cache: `otg_summary_v1_{landmarkName}` in `localStorage`.

---

## File structure

```
outrun-the-grid/
├── scripts/
│   └── build.py              # GPX → route_data.json + landmarks.json (with Claude summaries)
├── data/
│   └── runs/
│       ├── run-eve-6k-041126/
│       │   ├── route_data.json
│       │   └── landmarks.json   ← committed; regenerate with build.py
│       └── camb-classic-5k-spring/
│           ├── route_data.json
│           └── landmarks.json
├── css/
│   └── style.css             # Synthwave theme + responsive
├── js/
│   └── app.js                # All runtime logic
├── index.html
├── runs.json                 # Playlist manifest
├── config.json               # landmarkWindowSeconds, landmarkSources
└── requirements.txt          # gpxpy, requests, anthropic
```

---

## Key dependencies

| Dependency | How loaded | Purpose |
|---|---|---|
| [Leaflet.js 1.9](https://leafletjs.com) | CDN | Map, no API key needed |
| [OpenStreetMap](https://www.openstreetmap.org) | Tile CDN | Map tiles |
| [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference) | Script tag | Video + `getCurrentTime()` |
| [Overpass API](https://overpass-api.de) | `fetch()` in browser or `requests` in build | OSM POI landmarks |
| [Wikipedia API](https://en.wikipedia.org/w/api.php) | `fetch()` in browser or `requests` in build | Article extracts |
| [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) | Native browser | Voice narration |
| [Claude Haiku](https://anthropic.com) | `anthropic` Python SDK at build time | 2-sentence landmark summaries |

---

## Planned Build Layer Additions

```text
your_run.gpx
(optional) ghost_run.gpx
     │
     ▼
scripts/build.py
     │
     ├─▶ data/runs/{id}/route_data.json   [{t, lat, lon, pace, ele, gradient}, ...]  ← add gradient
     ├─▶ data/runs/{id}/landmarks.json    (current)
     ├─▶ data/runs/{id}/narrative.json    [{t, title, text}, ...]                    ← Phase 3 (AI chapters)
     └─▶ data/runs/{id}/ghost_data.json   [{t, lat, lon, pace}, ...]                 ← Phase 4
```
