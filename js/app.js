// ── State ──────────────────────────────────────────────────────────────────
let VIDEO_ID = null;
let LANDMARK_WINDOW = 2;
let LANDMARK_SOURCES = ["overpass", "wikipedia"];
let ytPlayer = null;
let route = [];
let landmarks = [];
let shownLandmarks = new Set();
let syncInterval = null;
let map = null;
let marker = null;
let activeRunId = null;
let runs = [];
let routeBounds = null;
let zoomResetTimer = null;

// ── Voice narration ────────────────────────────────────────────────────────
let voiceEnabled = localStorage.getItem("otg_voice") === "true";

function initVoiceBtn() {
  const btn = document.getElementById("voice-btn");
  if (!btn) return;
  btn.classList.toggle("active", voiceEnabled);
  btn.addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    localStorage.setItem("otg_voice", voiceEnabled);
    btn.classList.toggle("active", voiceEnabled);
    if (!voiceEnabled) speechSynthesis.cancel();
  });
}

function speakLandmark(lm) {
  if (!voiceEnabled || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const intro = new SpeechSynthesisUtterance(lm.name);
  intro.rate = 0.95;
  speechSynthesis.speak(intro);
  // Fetch and speak the DYK extract after the name
  fetchLandmarkInfo(lm).then(info => {
    if (!voiceEnabled || !info?.text) return;
    const clean = info.text.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
    const excerpt = clean.length > 400 ? clean.slice(0, 400) + "…" : clean;
    const body = new SpeechSynthesisUtterance(excerpt);
    body.rate = 0.95;
    speechSynthesis.speak(body);
  });
}

// ── Cache key ──────────────────────────────────────────────────────────────
// Bump this when the landmark schema changes to auto-bust stale caches.
const CACHE_VERSION = "v2";

function routeCacheKey(r) {
  const a = r[0], b = r[Math.floor(r.length / 2)], c = r[r.length - 1];
  return `otg_lm_${CACHE_VERSION}_${a.lat.toFixed(4)}_${a.lon.toFixed(4)}_${b.lat.toFixed(4)}_${c.lat.toFixed(4)}_${r.length}`;
}

// ── Landmark sources ───────────────────────────────────────────────────────
function routeBbox(r) {
  const lats = r.map(p => p.lat), lons = r.map(p => p.lon);
  return {
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    minLon: Math.min(...lons), maxLon: Math.max(...lons),
  };
}

function nearestRoutePoint(lat, lon, r) {
  let best = null, bestDist = Infinity;
  for (const pt of r) {
    const d = Math.hypot(pt.lat - lat, pt.lon - lon);
    if (d < bestDist) { bestDist = d; best = pt; }
  }
  return { point: best, dist: bestDist * 111_000 }; // approx metres
}

async function fetchOverpassLandmarks(r) {
  const { minLat, maxLat, minLon, maxLon } = routeBbox(r);
  const pad = 0.001;
  const bbox = `${minLat - pad},${minLon - pad},${maxLat + pad},${maxLon + pad}`;
  const query = `[out:json][timeout:25];(node["name"]["amenity"](${bbox});node["name"]["tourism"](${bbox});node["name"]["historic"](${bbox});node["name"]["leisure"](${bbox}););out body;`;
  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "outrun-the-grid/1.0 (github.com/hberube/outrun-the-grid)",
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
  const data = await resp.json();

  const results = [];
  const seen = new Set();
  for (const el of data.elements) {
    const name = el.tags?.name?.trim();
    if (!name || seen.has(name)) continue;
    const { point, dist } = nearestRoutePoint(el.lat, el.lon, r);
    if (dist <= 50) {
      seen.add(name);
      const osmType = el.tags?.amenity || el.tags?.tourism || el.tags?.historic || el.tags?.leisure || "place";
      results.push({ t: point.t, name, lat: el.lat, lon: el.lon, source: "osm", osmType });
    }
  }
  return results;
}

async function fetchWikipediaLandmarks(r) {
  const { minLat, maxLat, minLon, maxLon } = routeBbox(r);
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  // radius covers half the diagonal of the bounding box, capped at 10 000m
  const diagMeters = Math.hypot((maxLat - minLat), (maxLon - minLon)) * 111_000;
  const radius = Math.min(Math.ceil(diagMeters / 2) + 200, 10_000);

  const url = `https://en.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: "query", list: "geosearch",
    gscoord: `${centerLat}|${centerLon}`,
    gsradius: radius, gslimit: 30,
    format: "json", origin: "*",
  });
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Wikipedia ${resp.status}`);
  const data = await resp.json();

  const results = [];
  for (const item of data.query?.geosearch ?? []) {
    const { point, dist } = nearestRoutePoint(item.lat, item.lon, r);
    if (dist <= 100) {
      results.push({
        t: point.t,
        name: item.title,
        lat: item.lat,
        lon: item.lon,
        source: "wikipedia",
        pageid: item.pageid,
        url: `https://en.wikipedia.org/?curid=${item.pageid}`,
      });
    }
  }
  return results;
}

async function loadLandmarks(r, sources) {
  const cacheKey = routeCacheKey(r);
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    console.log("Landmarks: loaded from cache.");
    return JSON.parse(cached);
  }

  console.log("Landmarks: fetching from", sources.join(", "), "...");
  setLandmarkStatus("Fetching landmarks…");

  const fetchers = [];
  if (sources.includes("overpass")) fetchers.push(fetchOverpassLandmarks(r).catch(e => { console.warn("Overpass failed:", e.message); return []; }));
  if (sources.includes("wikipedia")) fetchers.push(fetchWikipediaLandmarks(r).catch(e => { console.warn("Wikipedia failed:", e.message); return []; }));

  const results = await Promise.all(fetchers);
  const merged = deduplicateLandmarks(results.flat());
  console.log(`Landmarks: ${merged.length} found, caching.`);
  localStorage.setItem(cacheKey, JSON.stringify(merged));
  setLandmarkStatus(null);
  return merged;
}

function deduplicateLandmarks(lms) {
  // Sort by time, then remove entries whose names are within 5s of each other
  lms.sort((a, b) => a.t - b.t);
  const out = [];
  const seenNames = new Set();
  for (const lm of lms) {
    const key = lm.name.toLowerCase();
    if (!seenNames.has(key)) {
      seenNames.add(key);
      out.push(lm);
    }
  }
  return out;
}

function setLandmarkStatus(msg) {
  const card = document.getElementById("landmark-card");
  const nameEl = document.getElementById("landmark-name");
  const iconEl = document.querySelector(".landmark-icon");
  if (msg) {
    nameEl.textContent = msg;
    if (iconEl) iconEl.textContent = "⟳";
    card.classList.remove("hidden");
  } else {
    card.classList.add("hidden");
    if (iconEl) iconEl.textContent = "◈";
  }
}

// ── Data loading ───────────────────────────────────────────────────────────
async function loadData() {
  try {
    const [configResp, runsResp] = await Promise.all([
      fetch("config.json"),
      fetch("runs.json"),
    ]);
    const config = await configResp.json();
    LANDMARK_WINDOW = config.landmarkWindowSeconds ?? 2;
    LANDMARK_SOURCES = config.landmarkSources ?? ["overpass", "wikipedia"];
    runs = await runsResp.json();
  } catch (e) {
    console.warn("Could not load config/runs:", e.message);
  }

  configReady = true;
  buildRunsPicker();
  initMap();

  // Load first run by default (also calls tryInitPlayer internally)
  if (runs.length) await selectRun(runs[0]);
}

async function selectRun(run) {
  if (activeRunId === run.id) return;
  activeRunId = run.id;
  VIDEO_ID = run.videoId;

  // Load route data
  try {
    const resp = await fetch(`data/runs/${run.id}/route_data.json`);
    route = await resp.json();
  } catch (e) {
    console.warn("Could not load route data for", run.id, e.message);
    route = [];
  }

  resetMap();

  // Switch or init YouTube player
  if (ytPlayer && playerReady) {
    clearInterval(syncInterval);
    syncInterval = null;
    ytPlayer.loadVideoById(run.videoId);
  } else if (ytPlayer && !playerReady) {
    pendingVideoId = run.videoId;  // deliver once onReady fires
  } else {
    tryInitPlayer();
  }

  resetHUD();
  shownLandmarks.clear();
  activeLegendT = null;
  dykCache.clear();
  if (zoomResetTimer) { clearTimeout(zoomResetTimer); zoomResetTimer = null; }
  speechSynthesis.cancel();

  // Update picker active state
  document.querySelectorAll(".run-card").forEach(c => {
    c.classList.toggle("active", c.dataset.id === run.id);
  });

  // Fetch landmarks for this run
  landmarks = [];
  buildLegend([]);
  if (route.length) {
    landmarks = await loadLandmarks(route, LANDMARK_SOURCES);
    addLandmarkPins();
    buildLegend(landmarks);
  }
}

// ── Map ────────────────────────────────────────────────────────────────────
let routeLayer = null;
let pinsLayer = null;

function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: false }).setView([0, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
}

function resetMap() {
  if (!map) return;

  // Remove old layers
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (pinsLayer)  { map.removeLayer(pinsLayer);  pinsLayer = null; }
  if (marker)     { map.removeLayer(marker);      marker = null; }

  if (!route.length) return;

  const latlngs = route.map(p => [p.lat, p.lon]);
  routeLayer = L.polyline(latlngs, { color: "#66fcf1", weight: 3, opacity: 0.85 }).addTo(map);
  routeBounds = routeLayer.getBounds();
  map.fitBounds(routeBounds, { padding: [24, 24] });

  const neonIcon = L.divIcon({
    className: "",
    html: '<div class="neon-dot"></div>',
    iconSize: [14, 14], iconAnchor: [7, 7],
  });
  marker = L.marker([route[0].lat, route[0].lon], { icon: neonIcon }).addTo(map);
}

function resetHUD() {
  document.getElementById("hud-pace").textContent = "--:--";
  document.getElementById("hud-ele").textContent  = "---m";
  document.getElementById("hud-time").textContent = "0:00";
}

function addLandmarkPins() {
  if (!map) return;
  if (pinsLayer) { map.removeLayer(pinsLayer); pinsLayer = null; }
  pinsLayer = L.layerGroup().addTo(map);
  landmarks.forEach(lm => {
    const color = lm.source === "wikipedia" ? "#c084fc" : "#ff2d78";
    L.circleMarker([lm.lat, lm.lon], {
      radius: 4, color, fillColor: color, fillOpacity: 0.85, weight: 1,
    })
      .bindTooltip(lm.name, { permanent: false, className: "lm-tip" })
      .addTo(pinsLayer);
  });
}

// ── Landmarks legend ───────────────────────────────────────────────────────
function buildLegend(lms) {
  const list = document.getElementById("legend-list");
  if (!list) return;
  list.innerHTML = "";

  lms.forEach(lm => {
    const li = document.createElement("li");
    li.className = "legend-item";
    li.dataset.t = lm.t;

    const m = Math.floor(lm.t / 60);
    const s = Math.floor(lm.t % 60).toString().padStart(2, "0");
    const srcClass = lm.source === "wikipedia" ? "wikipedia" : "osm";
    const icon = lm.source === "wikipedia" ? "◉" : "◈";

    li.innerHTML = `
      <span class="legend-ts">${m}:${s}</span>
      <span class="legend-icon ${srcClass}">${icon}</span>
      <span class="legend-name">${lm.name}</span>
    `;

    li.addEventListener("click", () => {
      if (ytPlayer && typeof ytPlayer.seekTo === "function") {
        ytPlayer.seekTo(lm.t, true);
        shownLandmarks.clear();
      }
      showDidYouKnow(lm);
    });

    list.appendChild(li);
  });

  // Toggle button
  const toggle = document.getElementById("legend-toggle");
  const legend = document.getElementById("legend");
  if (toggle && legend) {
    toggle.onclick = null;
    toggle.addEventListener("click", () => legend.classList.toggle("collapsed"));
    if (window.innerWidth <= 700) legend.classList.add("collapsed");
  }
}

// ── Did You Know ───────────────────────────────────────────────────────────
const dykCache = new Map();

async function fetchWikipediaExtract(title) {
  const url = `https://en.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: "query", prop: "extracts|info",
    exintro: true, exchars: 600,
    titles: title, inprop: "url",
    format: "json", origin: "*",
  });
  const resp = await fetch(url);
  const data = await resp.json();
  const page = Object.values(data.query.pages)[0];
  if (!page || page.missing !== undefined) return null;
  const text = (page.extract || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { text, link: page.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}` };
}

async function searchWikipedia(query) {
  const url = `https://en.wikipedia.org/w/api.php?` + new URLSearchParams({
    action: "query", list: "search",
    srsearch: query, srlimit: 1,
    format: "json", origin: "*",
  });
  const resp = await fetch(url);
  const data = await resp.json();
  const hit = data.query?.search?.[0];
  return hit ? hit.title : null;
}

async function fetchLandmarkInfo(lm) {
  if (dykCache.has(lm.name)) return dykCache.get(lm.name);

  let result = null;

  try {
    // Try the landmark name directly first (works for Wikipedia-sourced and
    // many OSM landmarks whose names match a Wikipedia article exactly)
    result = await fetchWikipediaExtract(lm.name);

    // If no direct hit, search Wikipedia for the name
    if (!result) {
      const found = await searchWikipedia(lm.name);
      if (found) result = await fetchWikipediaExtract(found);
    }
  } catch (e) {
    console.warn("Wikipedia fetch failed:", e.message);
  }

  if (!result) {
    const type = (lm.osmType || "point of interest").replace(/_/g, " ");
    result = { text: `No Wikipedia article found for this ${type}.`, link: null };
  }

  dykCache.set(lm.name, result);
  return result;
}

function showDidYouKnow(lm) {
  const panel  = document.getElementById("did-you-know");
  const title  = document.getElementById("dyk-title");
  const body   = document.getElementById("dyk-body");
  const source = document.getElementById("dyk-source");
  const link   = document.getElementById("dyk-link");

  title.textContent  = lm.name;
  source.textContent = lm.source === "wikipedia" ? "// Wikipedia" : `// OpenStreetMap · ${(lm.osmType || "place").replace(/_/g, " ")}`;
  body.textContent   = "Loading…";
  body.classList.add("loading");
  link.classList.add("hidden");
  panel.classList.remove("hidden");

  fetchLandmarkInfo(lm).then(info => {
    body.textContent = info.text;
    body.classList.remove("loading");
    if (info.link) {
      link.href = info.link;
      link.classList.remove("hidden");
    }
  });
}

function initDidYouKnow() {
  const panel = document.getElementById("did-you-know");
  document.getElementById("dyk-close").addEventListener("click", () => panel.classList.add("hidden"));
  panel.addEventListener("click", e => { if (e.target === panel) panel.classList.add("hidden"); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") panel.classList.add("hidden"); });
}

let activeLegendT = null;

function updateActiveLegendItem(t) {
  // Find the last landmark whose timestamp has been passed
  let best = null;
  for (const lm of landmarks) {
    if (lm.t <= t) best = lm;
    else break;
  }
  const nextT = best ? best.t : null;
  if (nextT === activeLegendT) return; // no change
  activeLegendT = nextT;

  const list = document.getElementById("legend-list");
  if (!list) return;
  list.querySelectorAll(".legend-item").forEach(li => {
    const active = Number(li.dataset.t) === nextT;
    li.classList.toggle("active", active);
    if (active) li.scrollIntoView({ block: "nearest" });
  });
}

// ── Binary search ──────────────────────────────────────────────────────────
function findClosestIndex(currentTime) {
  let lo = 0, hi = route.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (route[mid].t < currentTime) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(route[lo - 1].t - currentTime) < Math.abs(route[lo].t - currentTime)) return lo - 1;
  return lo;
}

// ── Sync tick ──────────────────────────────────────────────────────────────
function onTick() {
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
  const t = ytPlayer.getCurrentTime();
  if (!route.length) return;
  const pt = route[findClosestIndex(t)];
  if (marker) marker.setLatLng([pt.lat, pt.lon]);
  updateHUD(pt, t);
  checkLandmarks(t);
  updateActiveLegendItem(t);
}

// ── HUD ────────────────────────────────────────────────────────────────────
function updateHUD(pt, t) {
  const paceEl = document.getElementById("hud-pace");
  const eleEl  = document.getElementById("hud-ele");
  const timeEl = document.getElementById("hud-time");

  if (pt.pace != null) {
    const mins = Math.floor(pt.pace);
    const secs = Math.round((pt.pace - mins) * 60).toString().padStart(2, "0");
    paceEl.textContent = `${mins}:${secs}`;
  } else {
    paceEl.textContent = "--:--";
  }
  eleEl.textContent = pt.ele != null ? `${Math.round(pt.ele)}m` : "---m";
  const m = Math.floor(t / 60), s = Math.floor(t % 60).toString().padStart(2, "0");
  timeEl.textContent = `${m}:${s}`;
}

// ── Landmark overlay ───────────────────────────────────────────────────────
function checkLandmarks(t) {
  for (const lm of landmarks) {
    if (shownLandmarks.has(lm.t)) continue;
    if (Math.abs(lm.t - t) <= LANDMARK_WINDOW) showLandmarkCard(lm);
  }
}

function showLandmarkCard(lm) {
  shownLandmarks.add(lm.t);
  const card    = document.getElementById("landmark-card");
  const nameEl  = document.getElementById("landmark-name");
  const iconEl  = document.querySelector(".landmark-icon");

  nameEl.textContent = lm.name.toUpperCase();
  card.dataset.source = lm.source ?? "osm";
  if (iconEl) iconEl.textContent = lm.source === "wikipedia" ? "◉" : "◈";

  card.classList.remove("hidden");
  setTimeout(() => card.classList.add("hidden"), 3500);

  // Zoom map in to landmark, then fly back to full route after 6s
  if (map && lm.lat != null && lm.lon != null) {
    if (zoomResetTimer) { clearTimeout(zoomResetTimer); zoomResetTimer = null; }
    map.flyTo([lm.lat, lm.lon], 17, { animate: true, duration: 1.2 });
    zoomResetTimer = setTimeout(() => {
      if (map && routeBounds) map.flyToBounds(routeBounds, { padding: [24, 24], duration: 1.5 });
      zoomResetTimer = null;
    }, 6000);
  }

  speakLandmark(lm);
}

// ── YouTube IFrame API ─────────────────────────────────────────────────────
let ytApiReady = false;
let configReady = false;
let playerReady = false;
let pendingVideoId = null;

function tryInitPlayer() {
  if (!ytApiReady || !configReady || !VIDEO_ID || ytPlayer) return;
  playerReady = false;
  ytPlayer = new YT.Player("player", {
    videoId: VIDEO_ID,
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => {
        playerReady = true;
        if (pendingVideoId) {
          ytPlayer.loadVideoById(pendingVideoId);
          pendingVideoId = null;
        }
      },
      onStateChange: onPlayerStateChange,
    },
  });
}

function onYouTubeIframeAPIReady() {
  ytApiReady = true;
  tryInitPlayer();
}

function onPlayerStateChange(event) {
  if (event.data === 1) {
    if (!syncInterval) syncInterval = setInterval(onTick, 250);
  } else {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ── Seek detection ─────────────────────────────────────────────────────────
let lastT = 0;
setInterval(() => {
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
  const t = ytPlayer.getCurrentTime();
  if (Math.abs(t - lastT) > 3) shownLandmarks.clear();
  lastT = t;
}, 500);

// ── Runs picker ────────────────────────────────────────────────────────────
function buildRunsPicker() {
  const list = document.getElementById("runs-list");
  if (!list) return;
  list.innerHTML = "";

  runs.forEach(run => {
    const card = document.createElement("div");
    card.className = "run-card";
    card.dataset.id = run.id;

    const thumb = `https://img.youtube.com/vi/${run.videoId}/mqdefault.jpg`;
    card.innerHTML = `
      <img class="run-thumb" src="${thumb}" alt="${run.name}" loading="lazy">
      <div class="run-info">
        <span class="run-name">${run.name}</span>
        <span class="run-meta">${run.date} · ${run.distance}</span>
      </div>
    `;
    card.addEventListener("click", () => {
      document.querySelectorAll(".run-card").forEach(c => c.classList.remove("active"));
      card.classList.add("active");
      document.getElementById("runs-panel").classList.add("hidden");
      selectRun(run);
    });
    list.appendChild(card);
  });
}

function initRunsPicker() {
  const btn   = document.getElementById("runs-btn");
  const panel = document.getElementById("runs-panel");
  const close = document.getElementById("runs-close");
  btn.addEventListener("click",  () => panel.classList.toggle("hidden"));
  close.addEventListener("click", () => panel.classList.add("hidden"));
}

// ── Boot ───────────────────────────────────────────────────────────────────
initDidYouKnow();
initRunsPicker();
initVoiceBtn();
loadData();
