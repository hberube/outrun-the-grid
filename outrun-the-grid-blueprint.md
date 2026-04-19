# Outrun the Grid: Project Blueprint

A static, browser-based application built for GitHub Pages that synchronizes action camera running footage with GPS telemetry in a split-screen view, highlighting points of interest along the route.

## The GitHub Pages Architecture (Static Site)
Because GitHub Pages only hosts static files, there is no active backend. Instead, we use a "build step" approach:
1. **Local Processing (Python):** Python scripts run locally on your machine to crunch the Garmin GPX data and Overpass API landmarks into static `.json` files.
2. **Static Frontend (HTML/JS):** The web app simply fetches these pre-computed JSON files and plays the video.
3. **Video Hosting Caveat:** GitHub has a hard 100MB file limit. For long 10k or 17k runs, the raw Insta360 `.mp4` will be too large to host directly on GitHub. You will need to either compress it heavily, host the video file on an AWS S3 bucket and link to its URL in the HTML, or upload it to YouTube and use the YouTube IFrame Player API for playback.

---

## Phase 1: Local Data Compilation (The Build Step)
**Goal:** Convert the raw GPS track and landmarks into static web-readable files.

* **The Workflow:** * Export the `.gpx` file from the Garmin dashboard.
    * Run a local Python script using `gpxpy` to extract the timestamp, latitude, longitude, and pace.
    * Run a second Python function querying the OpenStreetMap Overpass API for landmarks within 50 meters of those coordinates.
    * Save both outputs as `route_data.json` and `landmarks.json` in your project folder.
* **Claude Code Prompt Example:**
    > *"Write a local Python script that reads a Garmin .gpx file, extracts the relative time, lat, lon, and calculates the pace. In the same script, query the Overpass API for notable landmarks along these coordinates. Save the results into two static files: route_data.json and landmarks.json."*

---

## Phase 2: The Static Split-Screen Dashboard
**Goal:** Build the user interface that houses the video player and the interactive map side-by-side, entirely in client-side code.

* **The Workflow:**
    * Create a basic `index.html` file with a two-column CSS layout.
    * Embed the video player on the left.
    * Initialize a Leaflet.js map (OpenStreetMap) on the right side. Leaflet is ideal here because it doesn't require exposing API keys in your public GitHub repository.
    * Write JavaScript to `fetch()` the local `route_data.json` and draw a polyline of the route.
* **Claude Code Prompt Example:**
    > *"Create a static index.html file with a split-screen layout. The left column contains an HTML5 video player (or YouTube iframe). The right column initializes a Leaflet.js map. Write vanilla JavaScript to fetch 'route_data.json' and draw the running route polyline on the map."*

---

## Phase 3: Runtime Synchronization & Neon UI
**Goal:** Tie the video playback time to the GPS coordinates and style the dashboard with a synthwave aesthetic.

* **The Workflow:**
    * Add a `timeupdate` event listener to the video element.
    * Match the video's current playback time to the closest timestamp in the JSON data, moving a custom map marker along the polyline.
    * Apply CSS styling with dark backgrounds, glowing pink/cyan borders, and retro-grid background patterns.
* **Claude Code Prompt Example:**
    > *"Add a 'timeupdate' event listener to the video element. Synchronize the video's current time with the timestamps in route_data.json to move a map marker. Then, style the CSS with a synthwave aesthetic: use dark backgrounds (#0b0c10), glowing neon cyan and pink accents, and a retro-grid map container."*

---

## Phase 4: Triggering Landmarks
**Goal:** Display dynamic tooltips when you run past the pre-compiled points of interest.

* **The Workflow:**
    * In the `timeupdate` loop, check if the current video time matches any timestamps in `landmarks.json`.
    * If a match occurs, display an absolute-positioned HTML `div` over the video player (e.g., "Passing Harvard Square").
* **Claude Code Prompt Example:**
    > *"Extend the JavaScript 'timeupdate' function. Fetch 'landmarks.json'. If the current playback time matches a landmark's timestamp, briefly display a stylized neon notification card overlaying the video player."*
