# Outrun the Grid

A static, browser-based dashboard that synchronizes action camera footage with Garmin GPS telemetry in a split-screen synthwave UI. Hosted on GitHub Pages — no backend required.

---

## How it works

1. A local Python script reads your Garmin `.gpx` file, queries OpenStreetMap for nearby landmarks, fetches Wikipedia summaries, and optionally generates 2-sentence EN + FR-CA descriptions via Claude AI.
2. The web app fetches those static JSON files and syncs YouTube video playback to a moving marker on the map, firing landmark cards as you pass each point of interest.
3. Click any landmark in the timeline or on the map to jump the video to that moment.

---

## Prerequisites

- Python 3.9+
- A Garmin `.gpx` export of your run
- Your run video uploaded to YouTube (can be unlisted)
- *(Optional)* An Anthropic API key for AI-generated landmark descriptions

---

## Adding a new run

### Step 1 — Export your GPS file

In [Garmin Connect](https://connect.garmin.com): open your activity → ••• menu → **Export GPX**. Save the file anywhere on your machine.

### Step 2 — Upload your video to YouTube

Upload your action cam footage to YouTube (can be unlisted). Copy the video ID — it's the part after `?v=` in the watch URL, e.g. `https://youtube.com/watch?v=`**`dQw4w9WgXcQ`**.

### Step 3 — Choose a run ID

Pick a URL-safe slug for your run, e.g. `my-run-10k-april`. Use lowercase letters, numbers, and hyphens only.

### Step 4 — Generate the data files

Install dependencies if you haven't already:

```bash
pip install -r requirements.txt
```

Run the build script:

```bash
python scripts/build.py path/to/your_run.gpx --id my-run-10k-april
```

This creates two files:

```
data/runs/my-run-10k-april/
├── route_data.json    # GPS track points with pace + elevation
└── landmarks.json     # Nearby POIs from OpenStreetMap
```

> **With Claude descriptions (recommended):** Set your Anthropic API key in the terminal before running — it will generate concise 2-sentence summaries in both English and French Canadian for every landmark that has a Wikipedia article.
>
> ```bash
> # Windows
> set ANTHROPIC_API_KEY=sk-ant-...
>
> # macOS / Linux
> export ANTHROPIC_API_KEY=sk-ant-...
>
> python scripts/build.py path/to/your_run.gpx --id my-run-10k-april
> ```
>
> **Never commit your API key.** Set it only in your terminal session, not in any file.

### Step 5 — Register the run in `runs.json`

Open `runs.json` and add an entry to the array:

```json
[
  {
    "id": "my-run-10k-april",
    "name": "Sunday 10K",
    "date": "2026-04-19",
    "distance": "10K",
    "videoId": "dQw4w9WgXcQ",
    "gpx": "my_run.gpx"
  }
]
```

| Field | Description |
|---|---|
| `id` | Must match the `--id` slug you used in Step 3 |
| `name` | Display name shown in the run picker |
| `date` | ISO date (`YYYY-MM-DD`) |
| `distance` | Display string, e.g. `5K`, `10K`, `Half` |
| `videoId` | YouTube video ID (the part after `?v=`) |
| `gpx` | GPX filename (informational only, not fetched by the app) |
| `order` | *(optional)* Integer controlling sort order in the picker; lowest number loads first. Runs without this field sort last. |

### Step 6 — Preview locally

```bash
python -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080).

> You must serve via HTTP — opening `index.html` as a `file://` URL blocks the `fetch()` calls for the JSON data.

### Step 7 — Deploy

Commit the new data files and push:

```bash
git add data/runs/my-run-10k-april/ runs.json
git commit -m "feat: add my-run-10k-april"
git push
```

GitHub Pages redeploys automatically within ~30 seconds.

---

## Updating landmark descriptions

Landmark descriptions are stored directly in `data/runs/<id>/landmarks.json`. Each entry looks like this:

```json
{
  "t": 272.0,
  "name": "Tech Model Railroad Club",
  "lat": 42.3620171,
  "lon": -71.0973259,
  "source": "osm",
  "osmTag": "tourism",
  "link": "https://en.wikipedia.org/wiki/Tech_Model_Railroad_Club",
  "summary": "English description shown when EN is selected.",
  "summary_fr": "Description en français affichée quand FR est sélectionné."
}
```

### To edit a description

Open the relevant `landmarks.json` file and update the `summary` and/or `summary_fr` fields directly. Commit and push.

### To regenerate all descriptions

Re-run `build.py` with your API key set (see Step 4 above). This overwrites the entire `landmarks.json` and re-fetches all POIs from OpenStreetMap, so any manual edits will be lost.

### To add or remove a landmark manually

Edit `landmarks.json` directly:

- **Add:** insert a new JSON object into the array. The `t` field is the timestamp in seconds from the start of the video when the landmark should appear.
- **Remove:** delete the object from the array.

After editing, commit and push. The app reads the file fresh on every page load.

### Landmark filter categories

Each landmark has an `osmTag` field that determines which filter pill controls its visibility:

| `osmTag` value | Filter button | On by default |
|---|---|---|
| `historic` | HISTORIC | Yes |
| `tourism`, `leisure` | PLACES | Yes |
| `amenity` | STORES | No |
| `source: "wikipedia"` | WIKI | Yes |
| `source: "strava"` | STRAVA | Yes |

To change the default, edit `const FILTERS` in `js/app.js`.

---

## Strava segment racing

When a Strava activity ID is configured, the app shows a live racing card during each segment — elapsed time, delta vs. the KOM, and a gold PR badge if you set a personal record. PR segments also appear as special entries in the route timeline.

### Step 1 — Get your Strava activity ID

Open the activity on Strava. The URL is `https://www.strava.com/activities/`**`12345678901`**. Copy the numeric ID.

### Step 2 — Add it to `runs.json`

```json
{
  "id": "my-run-10k-april",
  "stravaActivityId": "12345678901",
  ...
}
```

### Step 3 — Set Strava API credentials

Create a Strava API application at [strava.com/settings/api](https://www.strava.com/settings/api) if you don't have one. Then set these environment variables in your terminal before running `build.py`:

```bash
# Windows
set STRAVA_CLIENT_ID=12345
set STRAVA_CLIENT_SECRET=abc123...
set STRAVA_REFRESH_TOKEN=def456...

# macOS / Linux
export STRAVA_CLIENT_ID=12345
export STRAVA_CLIENT_SECRET=abc123...
export STRAVA_REFRESH_TOKEN=def456...
```

> **Never commit these values.** Set them only in your terminal session.

To get a refresh token with `activity:read_all` scope, use the Strava OAuth flow once (e.g. via [strava-get-token](https://github.com/nats-nui/strava-get-token) or any OAuth helper), then save the refresh token — it stays valid until revoked.

### Step 4 — Run `build.py`

```bash
python scripts/build.py path/to/your_run.gpx --id my-run-10k-april
```

If Strava credentials are set and `stravaActivityId` is present in `runs.json`, the script automatically fetches segment efforts and writes:

```
data/runs/my-run-10k-april/
├── route_data.json
├── landmarks.json
└── segments.json    ← new
```

If credentials are missing, a note is printed and the script continues without the Strava data.

### `segments.json` format

```json
[
  {
    "t_start": 245.0,
    "t_end": 347.0,
    "name": "Kendall Sq Sprint",
    "elapsed_time": 102,
    "kom_elapsed_time": 91,
    "kom_athlete": "M. Dupont",
    "athlete_rank": 47,
    "is_pr": true,
    "previous_pr": 110
  }
]
```

All times are in seconds relative to the start of the video.

---

## Project structure

```
outrun-the-grid/
├── scripts/
│   └── build.py              # GPX parser + Overpass API + Claude summarizer
├── data/
│   └── runs/
│       └── <run-id>/
│           ├── route_data.json   # GPS track points (generated)
│           ├── landmarks.json    # POIs with descriptions (generated + editable)
│           └── segments.json     # Strava segment efforts (generated, optional)
├── css/
│   └── style.css             # Synthwave theme + layout
├── js/
│   └── app.js                # YouTube sync, Leaflet map, voice narration, filters
├── index.html
├── runs.json                 # Run registry — one entry per run
├── config.json               # App config (landmark window, sources)
└── requirements.txt
```

---

## Configuration (`config.json`)

```json
{
  "landmarkWindowSeconds": 2,
  "landmarkSources": ["overpass", "wikipedia"]
}
```

| Key | Description |
|---|---|
| `landmarkWindowSeconds` | How close (in seconds) the video must be to a landmark's `t` before the overlay fires |
| `landmarkSources` | Which sources to query at runtime if no pre-built `landmarks.json` exists. Options: `"overpass"` (OpenStreetMap POIs), `"wikipedia"` (geotagged articles) |

---

## Dependencies

| Tool | Purpose |
|---|---|
| [gpxpy](https://github.com/tkrajina/gpxpy) | Parse Garmin GPX files |
| [requests](https://docs.python-requests.org) | Query Overpass + Wikipedia APIs |
| [anthropic](https://github.com/anthropics/anthropic-sdk-python) | Generate landmark summaries via Claude Haiku *(optional)* |
| [Leaflet.js](https://leafletjs.com) | Interactive map (no API key needed) |
| [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference) | Video playback and seeking |

---

## Video hosting

GitHub has a 100 MB file size limit — commit a raw `.mp4` only for very short clips.

| Option | Notes |
|---|---|
| **YouTube (recommended)** | Free, no size limit. Upload as unlisted to keep it private. |
| **AWS S3 / R2** | Host the `.mp4` publicly; swap the YouTube player for an HTML `<video>` tag in `app.js`. |
