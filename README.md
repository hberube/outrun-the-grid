# Outrun the Grid

A static, browser-based dashboard that synchronizes action camera footage with Garmin GPS telemetry in a split-screen synthwave UI. Hosted on GitHub Pages — no backend required.

![Layout: YouTube video on the left, Leaflet map with neon route on the right]

---

## How it works

1. A local Python script reads your Garmin `.gpx` file and queries OpenStreetMap for nearby landmarks, producing two static JSON files.
2. The web app fetches those files and syncs the YouTube video playback to a moving marker on the map, firing neon overlay cards as you pass landmarks.

---

## Prerequisites

- Python 3.9+
- A Garmin `.gpx` export of your run
- Your run video uploaded to YouTube (can be unlisted)

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/hberube/outrun-the-grid.git
cd outrun-the-grid
```

### 2. Install Python dependencies

```bash
pip install -r requirements.txt
```

### 3. Generate the data files

Export your run as a `.gpx` file from [Garmin Connect](https://connect.garmin.com) (Activity → Export GPX), then run:

```bash
python scripts/build.py path/to/your_run.gpx
```

This writes `data/route_data.json` and `data/landmarks.json`. These files are gitignored — regenerate them locally for each run.

### 4. Set your YouTube video ID

Open `config.json` and update `videoId`:

```json
{
  "videoId": "your_video_id_here",
  "landmarkWindowSeconds": 2
}
```

The video ID is the string after `?v=` in the YouTube watch URL (e.g. `https://youtube.com/watch?v=abc123` → `"abc123"`).

### 5. Serve locally

```bash
python -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080). The video and map should load together.

> **Note:** You must serve via HTTP — opening `index.html` directly as a `file://` URL will block the `fetch()` calls for the JSON data.

---

## Deploy to GitHub Pages

1. Push your repo to GitHub.
2. Go to **Settings → Pages → Source: Deploy from branch → `main` / root**.
3. Upload your `data/` files to the repo (or host them separately and update the fetch paths in `app.js`).

---

## Forking for your own run

This project is designed to be reused. To adapt it for a different run:

| What to change | Where |
|---|---|
| YouTube video | `videoId` in `config.json` |
| GPS data | Re-run `scripts/build.py` with a new `.gpx` |
| Landmark trigger window | `landmarkWindowSeconds` in `config.json` (default `2`) |
| Map style / colors | `css/style.css` CSS variables at the top |

---

## Project structure

```
outrun-the-grid/
├── scripts/
│   └── build.py          # GPX parser + Overpass API landmark fetcher
├── data/                 # gitignored — generated locally
│   ├── route_data.json
│   └── landmarks.json
├── css/
│   └── style.css         # Synthwave theme
├── js/
│   └── app.js            # YouTube sync, Leaflet map, landmark cards
├── index.html
└── requirements.txt
```

---

## Dependencies

| Tool | Purpose |
|---|---|
| [gpxpy](https://github.com/tkrajina/gpxpy) | Parse Garmin GPX files |
| [requests](https://docs.python-requests.org) | Query Overpass API |
| [Leaflet.js](https://leafletjs.com) | Interactive map (no API key needed) |
| [OpenStreetMap](https://www.openstreetmap.org) | Map tiles |
| [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference) | Video playback |

---

## Video hosting options

GitHub has a 100 MB file size limit, so committing a raw `.mp4` from a long run won't work.

| Option | Notes |
|---|---|
| **YouTube (recommended)** | Free, no size limit. Upload as unlisted if you don't want it public. |
| **AWS S3** | Host the `.mp4` publicly, update `VIDEO_ID` logic in `app.js` to use an `<video>` tag instead. |
| **Compressed MP4** | Works for short clips under 100 MB — commit directly to the repo. |
