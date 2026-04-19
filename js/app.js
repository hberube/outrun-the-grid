// ── Config ─────────────────────────────────────────────────────────────────
// Replace with your YouTube video ID (the part after ?v= in the watch URL).
const VIDEO_ID = "dQw4w9WgXcQ";

// How many seconds ahead/behind a landmark timestamp triggers the card.
const LANDMARK_WINDOW = 2;

// ── State ──────────────────────────────────────────────────────────────────
let ytPlayer = null;
let route = [];
let landmarks = [];
let shownLandmarks = new Set();
let syncInterval = null;
let map = null;
let routeLine = null;
let marker = null;

// ── Data loading ───────────────────────────────────────────────────────────
async function loadData() {
  try {
    const [routeResp, landmarksResp] = await Promise.all([
      fetch("data/route_data.json"),
      fetch("data/landmarks.json"),
    ]);
    route = await routeResp.json();
    landmarks = await landmarksResp.json();
  } catch (e) {
    console.warn("Could not load data files:", e.message);
  }
  initMap();
}

// ── Map ────────────────────────────────────────────────────────────────────
function initMap() {
  const center = route.length ? [route[0].lat, route[0].lon] : [0, 0];
  const zoom = route.length ? 15 : 2;

  map = L.map("map", { zoomControl: true, attributionControl: false }).setView(center, zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
  }).addTo(map);

  if (route.length) {
    const latlngs = route.map((p) => [p.lat, p.lon]);
    routeLine = L.polyline(latlngs, {
      color: "#66fcf1",
      weight: 3,
      opacity: 0.85,
    }).addTo(map);

    map.fitBounds(routeLine.getBounds(), { padding: [24, 24] });

    const neonIcon = L.divIcon({
      className: "",
      html: '<div class="neon-dot"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    marker = L.marker([route[0].lat, route[0].lon], { icon: neonIcon }).addTo(map);

    // Add landmark pins
    landmarks.forEach((lm) => {
      L.circleMarker([lm.lat, lm.lon], {
        radius: 4,
        color: "#ff2d78",
        fillColor: "#ff2d78",
        fillOpacity: 0.8,
        weight: 1,
      })
        .bindTooltip(lm.name, { permanent: false, className: "lm-tip" })
        .addTo(map);
    });
  }
}

// ── Binary search ──────────────────────────────────────────────────────────
function findClosestIndex(currentTime) {
  let lo = 0, hi = route.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (route[mid].t < currentTime) lo = mid + 1;
    else hi = mid;
  }
  // Check neighbour too
  if (lo > 0 && Math.abs(route[lo - 1].t - currentTime) < Math.abs(route[lo].t - currentTime)) {
    return lo - 1;
  }
  return lo;
}

// ── Sync tick ──────────────────────────────────────────────────────────────
function onTick() {
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
  const t = ytPlayer.getCurrentTime();
  if (!route.length) return;

  const idx = findClosestIndex(t);
  const pt = route[idx];

  // Move marker
  if (marker) marker.setLatLng([pt.lat, pt.lon]);

  // Update HUD
  updateHUD(pt, t);

  // Landmarks
  checkLandmarks(t);
}

// ── HUD ────────────────────────────────────────────────────────────────────
function updateHUD(pt, t) {
  const paceEl = document.getElementById("hud-pace");
  const eleEl = document.getElementById("hud-ele");
  const timeEl = document.getElementById("hud-time");

  if (pt.pace !== null && pt.pace !== undefined) {
    const mins = Math.floor(pt.pace);
    const secs = Math.round((pt.pace - mins) * 60).toString().padStart(2, "0");
    paceEl.textContent = `${mins}:${secs}`;
  } else {
    paceEl.textContent = "--:--";
  }

  eleEl.textContent = pt.ele !== null ? `${Math.round(pt.ele)}m` : "---m";

  const totalSecs = Math.floor(t);
  const m = Math.floor(totalSecs / 60);
  const s = (totalSecs % 60).toString().padStart(2, "0");
  timeEl.textContent = `${m}:${s}`;
}

// ── Landmark overlay ───────────────────────────────────────────────────────
function checkLandmarks(t) {
  for (const lm of landmarks) {
    if (shownLandmarks.has(lm.t)) continue;
    if (Math.abs(lm.t - t) <= LANDMARK_WINDOW) {
      showLandmarkCard(lm);
    }
  }
}

function showLandmarkCard(lm) {
  shownLandmarks.add(lm.t);
  const card = document.getElementById("landmark-card");
  const nameEl = document.getElementById("landmark-name");
  nameEl.textContent = `// ${lm.name.toUpperCase()}`;
  card.classList.remove("hidden");
  setTimeout(() => card.classList.add("hidden"), 3000);
}

// ── YouTube IFrame API callback ────────────────────────────────────────────
function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player("player", {
    videoId: VIDEO_ID,
    playerVars: {
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
    },
    events: {
      onStateChange: onPlayerStateChange,
    },
  });
}

function onPlayerStateChange(event) {
  // YT.PlayerState.PLAYING === 1
  if (event.data === 1) {
    if (!syncInterval) {
      syncInterval = setInterval(onTick, 250);
    }
  } else {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ── Reset shown landmarks when user seeks ─────────────────────────────────
// Poll for large time jumps (seek detection)
let lastT = 0;
setInterval(() => {
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
  const t = ytPlayer.getCurrentTime();
  if (Math.abs(t - lastT) > 3) {
    shownLandmarks.clear();
  }
  lastT = t;
}, 500);

// ── Boot ───────────────────────────────────────────────────────────────────
loadData();
