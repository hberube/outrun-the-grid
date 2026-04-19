# Architecture

Outrun the Grid has two completely separate layers that never talk to each other at runtime. The build layer runs once on your machine; the runtime layer runs in any browser with no server.

---

## Build Layer (local Python)

```
your_run.gpx
     │
     ▼
scripts/build.py
     │
     ├─▶ data/route_data.json   [{t, lat, lon, pace, ele}, ...]
     └─▶ data/landmarks.json    [{t, name, lat, lon}, ...]
```

**`scripts/build.py`** does two things:

1. **GPX parsing** — uses `gpxpy` to walk every track point and compute:
   - `t`: seconds elapsed since the first point
   - `lat`, `lon`: coordinates
   - `pace`: min/km, derived from time delta / haversine distance
   - `ele`: elevation in meters

2. **Landmark fetching** — queries the [Overpass API](https://overpass-api.de) for named `amenity`, `tourism`, `historic`, and `leisure` nodes within the route's bounding box. Each result is matched to the nearest route point within 50 meters and stamped with that point's `t` value.

**Known quirk:** Insta360 Studio's GPX exporter drops the negative sign on longitudes in the western hemisphere (the `<bounds>` metadata is correct but `<trkpt>` elements are wrong). The script auto-detects this by comparing the metadata max longitude sign to the first track point and negates all longitudes if they disagree.

**Output files are gitignored.** They contain your personal GPS data and are regenerated per run.

---

## Runtime Layer (static browser)

```
Browser
  │
  ├── fetch config.json          ← videoId, landmarkWindowSeconds
  ├── fetch data/route_data.json
  ├── fetch data/landmarks.json
  │
  ├── Leaflet.js (OpenStreetMap) ← draws route polyline + neon marker
  └── YouTube IFrame API         ← video player
            │
            └── timeupdate (250ms) ─▶ binary search route_data
                                      move marker
                                      update HUD
                                      check landmarks
```

### Boot sequence

Both the YouTube IFrame API and the data fetch happen in parallel on page load. A `tryInitPlayer()` gate ensures the YouTube player is only created after **both** the API script is ready (`onYouTubeIframeAPIReady`) and `config.json` has been fetched (so `VIDEO_ID` is available). Whichever finishes last triggers player creation.

### Sync loop

When the YouTube player state changes to `PLAYING`, a `setInterval` fires every 250ms. Each tick:
1. Reads `ytPlayer.getCurrentTime()` (seconds)
2. Binary-searches `route_data` on `t` to find the closest point — O(log n)
3. Moves the Leaflet marker to that point's coordinates
4. Updates the HUD (pace, elevation, elapsed time)
5. Checks whether any landmark's `t` falls within ±`landmarkWindowSeconds` of the current time and hasn't been shown yet → shows the overlay card for 3 seconds

A separate 500ms poll detects seeks (time jumps > 3s) and clears the shown-landmarks set so cards re-trigger after scrubbing.

### Key dependencies

| Dependency | How loaded | Why |
|---|---|---|
| [Leaflet.js 1.9](https://leafletjs.com) | CDN | Interactive map, no API key |
| [OpenStreetMap](https://www.openstreetmap.org) | Tile CDN | Map tiles, no API key |
| [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference) | Script tag | Video playback with time access |

---

## Deployment

The entire site is static. Push to any static host (GitHub Pages, Netlify, S3).

```
GitHub Pages
  └── serves index.html, css/, js/, config.json
         data/ ── generated locally, NOT committed
         video ── hosted on YouTube (unlisted or public)
```

To update for a new run: regenerate `data/`, update `config.json`, push. No build pipeline, no CI required.
