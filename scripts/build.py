"""
build.py — Outrun the Grid data pipeline
Usage: python scripts/build.py <path/to/run.gpx> --id <run-id>

Outputs:
  data/runs/<id>/route_data.json  — GPS track points with pace/elevation
  data/runs/<id>/landmarks.json   — nearby POIs with 2-sentence Claude summaries

Set ANTHROPIC_API_KEY env var to enable Claude summarization.
Without it, landmarks are written with the raw Wikipedia extract.
"""

import argparse
import json
import math
import os
import sys
import time

import gpxpy
import requests


# ── Haversine ─────────────────────────────────────────────────────────────────

def haversine(lat1, lon1, lat2, lon2):
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ── GPX parsing ───────────────────────────────────────────────────────────────

def parse_gpx(gpx_path):
    with open(gpx_path, "r", encoding="utf-8") as f:
        gpx = gpxpy.parse(f)

    points = []
    for track in gpx.tracks:
        for segment in track.segments:
            for pt in segment.points:
                points.append(pt)

    if not points:
        sys.exit("No track points found in GPX file.")

    # Insta360 Studio bug: trkpt longitudes written as positive in western hemisphere.
    fix_lon_sign = False
    if gpx.bounds and gpx.bounds.max_longitude is not None:
        meta_lon = gpx.bounds.max_longitude
        point_lon = points[0].longitude
        if meta_lon < 0 < point_lon:
            fix_lon_sign = True
            print("Note: Fixing Insta360 longitude sign bug (negating all longitudes).")

    t0 = points[0].time
    route = []
    prev_pt = None
    prev_t = None

    for pt in points:
        if pt.time is None:
            continue
        rel_t = (pt.time - t0).total_seconds()

        lon = -pt.longitude if fix_lon_sign else pt.longitude

        pace = None
        if prev_pt is not None and prev_t is not None:
            dt = (pt.time - prev_t).total_seconds()
            prev_lon = -prev_pt.longitude if fix_lon_sign else prev_pt.longitude
            dist = haversine(prev_pt.latitude, prev_lon, pt.latitude, lon)
            if dist > 0 and dt > 0:
                pace = round((dt / 60) / (dist / 1000), 2)

        route.append({
            "t": round(rel_t, 1),
            "lat": pt.latitude,
            "lon": lon,
            "pace": pace,
            "ele": round(pt.elevation, 1) if pt.elevation is not None else None,
        })
        prev_pt = pt
        prev_t = pt.time

    return route


# ── Overpass landmarks ────────────────────────────────────────────────────────

def fetch_overpass_landmarks(route):
    lats = [p["lat"] for p in route]
    lons = [p["lon"] for p in route]
    min_lat, max_lat = min(lats) - 0.001, max(lats) + 0.001
    min_lon, max_lon = min(lons) - 0.001, max(lons) + 0.001

    bbox = f"{min_lat},{min_lon},{max_lat},{max_lon}"
    query = f"""
[out:json][timeout:30];
(
  node["name"]["amenity"]({bbox});
  node["name"]["tourism"]({bbox});
  node["name"]["historic"]({bbox});
  node["name"]["leisure"]({bbox});
);
out body;
"""
    headers = {
        "User-Agent": "outrun-the-grid/1.0 (github.com/hberube/outrun-the-grid)",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    print("Querying Overpass API...")
    try:
        resp = requests.post(
            "https://overpass-api.de/api/interpreter",
            data={"data": query}, headers=headers, timeout=40,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"Warning: Overpass failed ({e}).")
        return []

    landmarks = []
    for el in resp.json().get("elements", []):
        name = el.get("tags", {}).get("name", "").strip()
        el_lat, el_lon = el.get("lat"), el.get("lon")
        if not name or el_lat is None or el_lon is None:
            continue
        best_t, best_dist = None, float("inf")
        for pt in route:
            d = haversine(el_lat, el_lon, pt["lat"], pt["lon"])
            if d < best_dist:
                best_dist = d
                best_t = pt["t"]
        if best_dist <= 50:
            tags = el.get("tags", {})
            osm_tag = next((k for k in ["historic", "tourism", "leisure", "amenity"] if k in tags), "amenity")
            landmarks.append({"t": best_t, "name": name, "lat": el_lat, "lon": el_lon, "source": "osm", "osmTag": osm_tag})

    return landmarks


# ── Wikipedia ─────────────────────────────────────────────────────────────────

def wikipedia_extract(title):
    params = {
        "action": "query", "prop": "extracts|info",
        "exintro": True, "exchars": 800,
        "titles": title, "inprop": "url",
        "format": "json",
    }
    try:
        resp = requests.get("https://en.wikipedia.org/w/api.php", params=params, timeout=10)
        data = resp.json()
        page = next(iter(data["query"]["pages"].values()))
        if page.get("missing") is not None:
            return None
        import re
        text = re.sub(r"<[^>]+>", "", page.get("extract", "")).strip()
        if not text:
            return None
        return {"text": text, "link": page.get("fullurl", f"https://en.wikipedia.org/wiki/{title}")}
    except Exception:
        return None


def wikipedia_search(query):
    params = {
        "action": "query", "list": "search",
        "srsearch": query, "srlimit": 1,
        "format": "json",
    }
    try:
        resp = requests.get("https://en.wikipedia.org/w/api.php", params=params, timeout=10)
        hits = resp.json().get("query", {}).get("search", [])
        return hits[0]["title"] if hits else None
    except Exception:
        return None


def fetch_wikipedia_info(name):
    result = wikipedia_extract(name)
    if not result:
        title = wikipedia_search(name)
        if title:
            result = wikipedia_extract(title)
    return result


# ── Claude summarization ──────────────────────────────────────────────────────

def summarize_with_claude(client, text, name):
    try:
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=120,
            messages=[{
                "role": "user",
                "content": (
                    f"Summarize the following in exactly 2 short, engaging sentences "
                    f"for a runner who just passed this landmark. Be conversational, "
                    f"not encyclopedic. Do not start with the landmark name.\n\n{text}"
                ),
            }],
        )
        return msg.content[0].text.strip()
    except Exception as e:
        print(f"  Warning: Claude failed for '{name}': {e}")
        return None


def summarize_with_claude_fr(client, text, name):
    try:
        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=120,
            messages=[{
                "role": "user",
                "content": (
                    f"Résume le texte suivant en exactement 2 courtes phrases engageantes "
                    f"en français canadien pour un coureur qui vient de passer ce point d'intérêt. "
                    f"Sois conversationnel, pas encyclopédique. Ne commence pas par le nom du lieu.\n\n{text}"
                ),
            }],
        )
        return msg.content[0].text.strip()
    except Exception as e:
        print(f"  Warning: Claude FR failed for '{name}': {e}")
        return None


# ── Dedup ─────────────────────────────────────────────────────────────────────

def dedup_landmarks(landmarks):
    seen = set()
    deduped = []
    for lm in sorted(landmarks, key=lambda x: x["t"]):
        bucket = round(lm["t"] / 5)
        if bucket not in seen:
            seen.add(bucket)
            deduped.append(lm)
    return deduped


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("gpx_file", help="Path to Garmin .gpx export")
    parser.add_argument("--id", dest="run_id", required=True,
                        help="Run ID matching runs.json (e.g. run-eve-6k)")
    args = parser.parse_args()

    if not os.path.isfile(args.gpx_file):
        sys.exit(f"File not found: {args.gpx_file}")

    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "runs", args.run_id)
    os.makedirs(out_dir, exist_ok=True)

    # ── Route ─────────────────────────────────────────────────────────────────
    print(f"Parsing {args.gpx_file}...")
    route = parse_gpx(args.gpx_file)
    print(f"Extracted {len(route)} track points.")

    route_path = os.path.join(out_dir, "route_data.json")
    with open(route_path, "w", encoding="utf-8") as f:
        json.dump(route, f, separators=(",", ":"))
    print(f"Wrote {route_path}")

    # ── Landmarks ─────────────────────────────────────────────────────────────
    landmarks = dedup_landmarks(fetch_overpass_landmarks(route))
    print(f"Found {len(landmarks)} landmarks within 50m of route.")

    # Claude client (optional)
    claude = None
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if api_key:
        try:
            import anthropic
            claude = anthropic.Anthropic(api_key=api_key)
            print("Claude summarization enabled.")
        except ImportError:
            print("Warning: anthropic package not installed. Run: pip install anthropic")
    else:
        print("Note: Set ANTHROPIC_API_KEY to enable 2-sentence summaries.")

    # Enrich each landmark with Wikipedia + Claude summary (EN + FR)
    for i, lm in enumerate(landmarks, 1):
        print(f"  [{i}/{len(landmarks)}] {lm['name']}")
        info = fetch_wikipedia_info(lm["name"])
        if info:
            lm["link"] = info["link"]
            if claude:
                summary_en = summarize_with_claude(claude, info["text"], lm["name"])
                lm["summary"] = summary_en or info["text"][:400]
                summary_fr = summarize_with_claude_fr(claude, info["text"], lm["name"])
                if summary_fr:
                    lm["summary_fr"] = summary_fr
            else:
                lm["summary"] = info["text"][:400]
        time.sleep(0.2)  # be polite to Wikipedia

    landmarks_path = os.path.join(out_dir, "landmarks.json")
    with open(landmarks_path, "w", encoding="utf-8") as f:
        json.dump(landmarks, f, ensure_ascii=False, indent=2)
    print(f"Wrote {landmarks_path}")


if __name__ == "__main__":
    main()
