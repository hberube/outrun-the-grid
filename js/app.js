// ── State ──────────────────────────────────────────────────────────────────
let VIDEO_ID = null;
let LANDMARK_WINDOW = 2;
let LANDMARK_SOURCES = ["overpass", "wikipedia"];
let ytPlayer = null;
let route = [];
let landmarks = [];
let segments = [];
let shownLandmarks = new Set();
let syncInterval = null;
let map = null;
let marker = null;
let activeRunId = null;
let runs = [];
let routeBounds = null;
let zoomResetTimer = null;
let activeSegment = null;
let segmentFinishTimer = null;

// ── Voice narration ────────────────────────────────────────────────────────
let voiceEnabled = localStorage.getItem("otg_voice") === "true";
let voiceLang    = localStorage.getItem("otg_voice_lang") || "en";
let preferredVoice = null;

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const prefix = voiceLang === "fr" ? "fr" : "en";
  const score = v => {
    if (!v.lang.startsWith(prefix)) return 0;
    const n = v.name;
    if (voiceLang === "fr") {
      const isCA = v.lang.startsWith("fr-CA");
      if (isCA && /Google/.test(n))            return 6;
      if (isCA && /Microsoft.*Natural/.test(n)) return 5;
      if (isCA)                                 return 4;
      if (/Google/.test(n))                     return 3;
      if (/Microsoft.*Natural/.test(n))         return 2;
      return 1;
    }
    if (/Google/.test(n) && !/eSpeak/.test(n)) return 4;
    if (/Microsoft.*Natural/.test(n))           return 3;
    if (/Microsoft/.test(n))                    return 2;
    return 1;
  };
  const ranked = [...voices].sort((a, b) => score(b) - score(a));
  preferredVoice = ranked[0]?.lang.startsWith(prefix) ? ranked[0] : null;
}

function applyVoice(utt) {
  if (preferredVoice) utt.voice = preferredVoice;
  utt.lang  = voiceLang === "fr" ? "fr-CA" : "en-US";
  utt.rate  = 0.92;
  utt.pitch = 1.05;
}

function initVoiceBtn() {
  const btn = document.getElementById("voice-btn");
  if (!btn) return;
  btn.classList.toggle("active", voiceEnabled);
  btn.addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    localStorage.setItem("otg_voice", voiceEnabled);
    btn.classList.toggle("active", voiceEnabled);
    if (!voiceEnabled) cancelSpeech();
  });
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function initLangToggle() {
  document.querySelectorAll(".lang-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.lang === voiceLang);
    btn.addEventListener("click", () => {
      voiceLang = btn.dataset.lang;
      localStorage.setItem("otg_voice_lang", voiceLang);
      document.querySelectorAll(".lang-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.lang === voiceLang)
      );
      cancelSpeech();
      pickVoice();
      buildTimeline(landmarks); // re-render cards in the new language
    });
  });
}

function fetchInfo(lm) {
  return voiceLang === "fr" ? fetchLandmarkInfoFr(lm) : fetchLandmarkInfo(lm);
}

let speakQueue = Promise.resolve();

function speakUtterance(text) {
  return new Promise(resolve => {
    const utt = new SpeechSynthesisUtterance(text);
    applyVoice(utt);
    utt.onend = resolve;
    utt.onerror = resolve;
    speechSynthesis.speak(utt);
  });
}

function cancelSpeech() {
  speechSynthesis.cancel();
  speakQueue = Promise.resolve();
}

async function fetchLandmarkInfoFr(lm) {
  if (dykCacheFr.has(lm.name)) return dykCacheFr.get(lm.name);

  let result = null;

  // 1. Pre-built Claude FR summary (build time — best quality)
  if (lm.summary_fr) {
    result = { text: lm.summary_fr, link: lm.link || null };
  }

  // 2. French Wikipedia (localStorage cache)
  if (!result) {
    const lsKey = `otg_summary_fr_v1_${lm.name}`;
    const stored = localStorage.getItem(lsKey);
    if (stored) {
      result = JSON.parse(stored);
    } else {
      try {
        const params = new URLSearchParams({
          action: "query", prop: "extracts", exintro: true,
          exchars: 500, titles: lm.name, format: "json", origin: "*",
        });
        const resp = await fetch(`https://fr.wikipedia.org/w/api.php?${params}`);
        const data = await resp.json();
        const page = Object.values(data.query.pages)[0];
        if (!page.missing) {
          const text = page.extract?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
          if (text && text.length > 20) {
            result = { text: text.slice(0, 500), link: lm.link || null };
            localStorage.setItem(lsKey, JSON.stringify(result));
          }
        }
      } catch (_) {}
    }
  }

  // 3. Fall back to English
  if (!result) result = await fetchLandmarkInfo(lm);

  dykCacheFr.set(lm.name, result);
  return result;
}

function speakLandmark(lm) {
  if (!voiceEnabled || !window.speechSynthesis) return;
  speakQueue = speakQueue.then(async () => {
    if (!voiceEnabled) return;
    await speakUtterance(lm.name);
    if (!voiceEnabled) return;
    const info = voiceLang === "fr"
      ? await fetchLandmarkInfoFr(lm)
      : await fetchLandmarkInfo(lm);
    if (!voiceEnabled || !info?.text) return;
    const clean = info.text.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
    const excerpt = clean.length > 400 ? clean.slice(0, 400) + "…" : clean;
    await speakUtterance(excerpt);
    // Auto-close the DYK popup if it's still showing this landmark
    if (currentDykLm?.t === lm.t) {
      document.getElementById("did-you-know").classList.add("hidden");
      currentDykLm = null;
    }
  });
}

// ── Cache key ──────────────────────────────────────────────────────────────
// Bump this when the landmark schema changes to auto-bust stale caches.
const CACHE_VERSION = "v4";

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
      const osmTag = ["historic","tourism","leisure","amenity"].find(k => el.tags?.[k]) ?? "amenity";
      const osmType = el.tags?.[osmTag] || "place";
      results.push({ t: point.t, name, lat: el.lat, lon: el.lon, source: "osm", osmTag, osmType });
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
    runs = (await runsResp.json()).sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
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
  if (ytPlayer) {
    clearInterval(syncInterval);
    syncInterval = null;
    if (playerReady) {
      ytPlayer.cueVideoById(VIDEO_ID);
    }
    // if not yet ready, VIDEO_ID is already set — onReady will pick it up
  } else {
    tryInitPlayer();
  }

  resetHUD();
  shownLandmarks.clear();
  activeTimelineT = null;
  dykCache.clear();
  dykCacheFr.clear();
  if (zoomResetTimer) { clearTimeout(zoomResetTimer); zoomResetTimer = null; }
  cancelSpeech();
  hideSegmentCard();
  activeSegment = null;
  segments = [];

  // Update picker active state
  document.querySelectorAll(".run-card").forEach(c => {
    c.classList.toggle("active", c.dataset.id === run.id);
  });

  // Load landmarks — prefer pre-built static file, fall back to dynamic fetch
  landmarks = [];
  buildTimeline([]);
  if (route.length) {
    try {
      const lmResp = await fetch(`data/runs/${run.id}/landmarks.json`);
      if (lmResp.ok) {
        landmarks = await lmResp.json();
      }
    } catch (_) {}

    if (!landmarks.length) {
      landmarks = await loadLandmarks(route, LANDMARK_SOURCES);
    }

    addLandmarkPins();

    // Load Strava segments (optional)
    try {
      const segResp = await fetch(`data/runs/${run.id}/segments.json`);
      if (segResp.ok) segments = await segResp.json();
    } catch (_) {}

    buildTimeline(landmarks);
  }
}

// ── Map ────────────────────────────────────────────────────────────────────
let routeLayer = null;
let pinsLayer = null;

function initMap() {
  map = L.map("map", { zoomControl: true, attributionControl: false }).setView([0, 0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }).addTo(map);
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

// ── Landmark filters ───────────────────────────────────────────────────────
const FILTERS = { historic: true, places: true, stores: false, wiki: true, strava: true };

function filterLandmarks(lms) {
  return lms.filter(lm => {
    if (lm.source === "strava")    return FILTERS.strava;
    if (lm.source === "wikipedia") return FILTERS.wiki;
    const tag = lm.osmTag ?? "amenity";
    if (tag === "historic")                      return FILTERS.historic;
    if (tag === "tourism" || tag === "leisure")  return FILTERS.places;
    return FILTERS.stores;
  });
}

function initFilters() {
  document.querySelectorAll(".filter-btn").forEach(btn => {
    const key = btn.dataset.filter;
    btn.classList.toggle("active", FILTERS[key]);
    btn.addEventListener("click", () => {
      FILTERS[key] = !FILTERS[key];
      btn.classList.toggle("active", FILTERS[key]);
      buildTimeline(landmarks);
      addLandmarkPins();
    });
  });
}

function seekToLandmark(lm) {
  if (ytPlayer && typeof ytPlayer.seekTo === "function") {
    ytPlayer.seekTo(lm.t, true);
    ytPlayer.playVideo();
    shownLandmarks.clear();
  }
}

function addLandmarkPins() {
  if (!map) return;
  if (pinsLayer) { map.removeLayer(pinsLayer); pinsLayer = null; }
  pinsLayer = L.layerGroup().addTo(map);
  filterLandmarks(landmarks).forEach(lm => {
    const color = lm.source === "wikipedia" ? "#c084fc" : "#ff2d78";
    L.circleMarker([lm.lat, lm.lon], {
      radius: 6, color, fillColor: color, fillOpacity: 0.85, weight: 1,
      interactive: true,
    })
      .bindTooltip(lm.name, { permanent: false, className: "lm-tip" })
      .on("click", () => { seekToLandmark(lm); showDidYouKnow(lm); })
      .addTo(pinsLayer);
  });
}

// ── Route Timeline (replaces separate legend + transcript) ─────────────────
function buildTimeline(lms) {
  const list = document.getElementById("timeline-list");
  if (!list) return;
  list.innerHTML = "";

  // Build PR segment entries as synthetic landmark-like objects
  const prEntries = FILTERS.strava
    ? segments.filter(s => s.is_pr).map(seg => ({
        t: seg.t_end,
        name: seg.name,
        source: "strava",
        _seg: seg,
      }))
    : [];

  const allItems = [...filterLandmarks(lms), ...prEntries]
    .sort((a, b) => a.t - b.t);

  allItems.forEach(lm => {
    const card = document.createElement("div");
    card.dataset.t = lm.t;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", lm.name);

    const m = Math.floor(lm.t / 60);
    const s = Math.floor(lm.t % 60).toString().padStart(2, "0");

    if (lm.source === "strava") {
      const seg = lm._seg;
      card.className = "timeline-card strava-pr";
      const delta = seg.kom_elapsed_time
        ? seg.elapsed_time - seg.kom_elapsed_time
        : null;
      const deltaStr = delta !== null
        ? `${delta >= 0 ? "+" : "-"}${fmtSecs(Math.abs(delta))} vs KOM`
        : "";
      const rankStr = seg.athlete_rank ? `#${seg.athlete_rank}` : "";
      card.innerHTML = `
        <div class="timeline-meta">
          <span class="timeline-ts">${m}:${s}</span>
          <span class="timeline-icon strava">★</span>
          <span class="timeline-name">${lm.name}</span>
        </div>
        <p class="timeline-text strava-pr-detail">PR · ${fmtSecs(seg.elapsed_time)}${deltaStr ? " · " + deltaStr : ""}${rankStr ? " · " + rankStr : ""}</p>
      `;
      const activate = () => {
        if (ytPlayer && typeof ytPlayer.seekTo === "function") {
          ytPlayer.seekTo(seg.t_start, true);
          ytPlayer.playVideo();
          shownLandmarks.clear();
        }
      };
      card.addEventListener("click", activate);
      card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
    } else {
      card.className = "timeline-card";
      const srcClass = lm.source === "wikipedia" ? "wikipedia" : "osm";
      const icon = lm.source === "wikipedia" ? "◉" : "◈";
      card.innerHTML = `
        <div class="timeline-meta">
          <span class="timeline-ts">${m}:${s}</span>
          <span class="timeline-icon ${srcClass}">${icon}</span>
          <span class="timeline-name">${lm.name}</span>
        </div>
        <p class="timeline-text">…</p>
      `;
      const activate = () => {
        seekToLandmark(lm);
        showDidYouKnow(lm);
      };
      card.addEventListener("click", activate);
      card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
      fetchInfo(lm).then(info => {
        const p = card.querySelector(".timeline-text");
        if (p && info?.text) p.textContent = info.text;
      });
    }

    list.appendChild(card);
  });

  // Toggle button
  const toggle = document.getElementById("timeline-toggle");
  const timeline = document.getElementById("route-timeline");
  if (toggle && timeline) {
    toggle.onclick = null;
    toggle.addEventListener("click", () => timeline.classList.toggle("collapsed"));
    if (window.innerWidth <= 700) timeline.classList.add("collapsed");
  }
}

// ── Did You Know ───────────────────────────────────────────────────────────
const dykCache   = new Map(); // EN results
const dykCacheFr = new Map(); // FR results — separate to avoid EN bleed-through

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

  // Pre-built summary from build.py (preferred — already Claude-summarized)
  if (lm.summary) {
    const result = { text: lm.summary, link: lm.link || null };
    dykCache.set(lm.name, result);
    return result;
  }

  // Fallback: fetch Wikipedia live (for dynamically-loaded landmarks)
  let result = null;
  try {
    result = await fetchWikipediaExtract(lm.name);
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

  currentDykLm = lm;
  title.textContent  = lm.name;
  source.textContent = lm.source === "wikipedia" ? "// Wikipedia" : `// OpenStreetMap · ${(lm.osmTag || lm.osmType || "place").replace(/_/g, " ")}`;
  body.textContent   = "Loading…";
  body.classList.add("loading");
  link.classList.add("hidden");
  panel.classList.remove("hidden");

  fetchInfo(lm).then(info => {
    body.textContent = info.text;
    body.classList.remove("loading");
    if (info.link) {
      link.href = info.link;
      link.classList.remove("hidden");
    }
  });
}

let currentDykLm = null;

function initDidYouKnow() {
  const panel = document.getElementById("did-you-know");
  const close = () => { panel.classList.add("hidden"); currentDykLm = null; };
  document.getElementById("dyk-close").addEventListener("click", close);
  panel.addEventListener("click", e => { if (e.target === panel) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
}

let activeTimelineT = null;

function updateActiveTimelineCard(t) {
  let best = null;
  for (const lm of landmarks) {
    if (lm.t <= t) best = lm;
    else break;
  }
  const nextT = best ? best.t : null;
  if (nextT === activeTimelineT) return;
  activeTimelineT = nextT;

  const list = document.getElementById("timeline-list");
  if (!list) return;
  list.querySelectorAll(".timeline-card").forEach(card => {
    const itemT = Number(card.dataset.t);
    card.classList.toggle("active", itemT === nextT);
    card.classList.toggle("passed", itemT < (nextT ?? Infinity) && itemT !== nextT);
    if (itemT === nextT) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
  checkSegments(t);
  updateActiveTimelineCard(t);
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

// ── Segment racing card ────────────────────────────────────────────────────
function fmtSecs(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

function checkSegments(t) {
  for (const seg of segments) {
    if (t >= seg.t_start && t < seg.t_end) {
      if (activeSegment !== seg) {
        activeSegment = seg;
        if (segmentFinishTimer) { clearTimeout(segmentFinishTimer); segmentFinishTimer = null; }
        showSegmentCard(seg);
      }
      updateSegmentTimer(seg, t);
      return;
    }
  }
  // Not inside any segment
  if (activeSegment) {
    finalizeSegmentCard(activeSegment);
    activeSegment = null;
  }
}

function showSegmentCard(seg) {
  const card = document.getElementById("segment-card");
  document.getElementById("seg-name").textContent = seg.name;
  document.getElementById("seg-timer").textContent = "0:00";
  document.getElementById("seg-pr-badge").classList.toggle("hidden", !seg.is_pr);
  const komEl = document.getElementById("seg-kom");
  komEl.textContent = seg.kom_elapsed_time
    ? `KOM ${fmtSecs(seg.kom_elapsed_time)}${seg.kom_athlete ? " · " + seg.kom_athlete : ""}`
    : "";
  document.getElementById("seg-delta").textContent = "";
  document.getElementById("seg-delta").className = "seg-delta";
  card.classList.remove("hidden", "finalized");
}

function updateSegmentTimer(seg, t) {
  const elapsed = t - seg.t_start;
  document.getElementById("seg-timer").textContent = fmtSecs(elapsed);
  if (seg.kom_elapsed_time) {
    const delta = elapsed - seg.kom_elapsed_time;
    const deltaEl = document.getElementById("seg-delta");
    const sign = delta >= 0 ? "+" : "-";
    deltaEl.textContent = `${sign}${fmtSecs(Math.abs(delta))} vs KOM`;
    deltaEl.className = `seg-delta ${delta <= 0 ? "ahead" : "behind"}`;
  }
}

function finalizeSegmentCard(seg) {
  document.getElementById("seg-timer").textContent = fmtSecs(seg.elapsed_time);
  const deltaEl = document.getElementById("seg-delta");
  if (seg.kom_elapsed_time) {
    const delta = seg.elapsed_time - seg.kom_elapsed_time;
    const sign = delta >= 0 ? "+" : "-";
    deltaEl.textContent = `${sign}${fmtSecs(Math.abs(delta))} vs KOM`;
    deltaEl.className = `seg-delta ${delta <= 0 ? "ahead" : "behind"}`;
  }
  if (seg.athlete_rank) {
    const rankEl = document.createElement("div");
    rankEl.className = "seg-rank";
    rankEl.textContent = `RANK #${seg.athlete_rank}`;
    document.getElementById("segment-card").appendChild(rankEl);
  }
  document.getElementById("segment-card").classList.add("finalized");
  segmentFinishTimer = setTimeout(hideSegmentCard, 5000);
}

function hideSegmentCard() {
  const card = document.getElementById("segment-card");
  card.classList.add("hidden");
  card.classList.remove("finalized");
  // Remove any dynamically added rank element
  card.querySelectorAll(".seg-rank").forEach(el => el.remove());
  if (segmentFinishTimer) { clearTimeout(segmentFinishTimer); segmentFinishTimer = null; }
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

function tryInitPlayer() {
  if (!ytApiReady || !configReady || !VIDEO_ID || ytPlayer) return;
  playerReady = false;
  ytPlayer = new YT.Player("player", {
    videoId: VIDEO_ID,
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => { playerReady = true; },
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
initLangToggle();
initFilters();
loadData();
