"""
build.py — Outrun the Grid data pipeline
Usage: python scripts/build.py <path/to/run.gpx|run.mp4> --id <run-id> [--strava-activity-id <id>]
       MP4 input (Insta360 or other camera with embedded GPS) requires exiftool in PATH.

Outputs:
  data/runs/<id>/route_data.json  — GPS track points with pace/elevation
  data/runs/<id>/landmarks.json   — nearby POIs with 2-sentence Claude summaries
  data/runs/<id>/segments.json    — Strava segment efforts with KOM comparison (optional)

Set ANTHROPIC_API_KEY env var to enable Claude summarization.
Set STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN to enable Strava segments.
Without the API key, landmarks are written with the raw Wikipedia extract.
"""

import argparse
import json
import math
import os
import sys
import time
from datetime import timezone

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


# ── Strava ────────────────────────────────────────────────────────────────────

def strava_get_token(client_id, client_secret, refresh_token):
    resp = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def strava_get_activity(activity_id, access_token):
    resp = requests.get(
        f"https://www.strava.com/api/v3/activities/{activity_id}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def strava_get_leaderboard(segment_id, access_token):
    try:
        resp = requests.get(
            f"https://www.strava.com/api/v3/segments/{segment_id}/leaderboard",
            params={"per_page": 1},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        entries = data.get("entries", [])
        if entries:
            return {
                "elapsed_time": entries[0].get("elapsed_time"),
                "athlete_name": entries[0].get("athlete_name", ""),
                "entry_count": data.get("entry_count"),
            }
    except Exception as e:
        print(f"    Warning: leaderboard fetch failed: {e}")
    return None


def fmt_time(seconds):
    m, s = divmod(int(seconds), 60)
    return f"{m}:{s:02d}"


def build_segments(activity, access_token):
    from datetime import datetime

    efforts = activity.get("segment_efforts", [])
    if not efforts:
        print("  No segment efforts found in this activity.")
        return []

    # Activity start time (UTC)
    act_start_str = activity["start_date"]  # e.g. "2026-04-11T10:23:45Z"
    act_start = datetime.fromisoformat(act_start_str.replace("Z", "+00:00"))

    segments = []
    for i, effort in enumerate(efforts, 1):
        name = effort["name"]
        elapsed = effort["elapsed_time"]
        print(f"  [{i}/{len(efforts)}] {name} — {fmt_time(elapsed)}")

        # Video-relative timestamps
        effort_start_str = effort["start_date"]
        effort_start = datetime.fromisoformat(effort_start_str.replace("Z", "+00:00"))
        t_start = round((effort_start - act_start).total_seconds(), 1)
        t_end = round(t_start + elapsed, 1)

        # PR detection
        is_pr = effort.get("pr_rank") == 1
        prev_pr = None
        stats = effort.get("segment", {}).get("athlete_segment_stats", {})
        if stats.get("pr_elapsed_time") and not is_pr:
            prev_pr = stats["pr_elapsed_time"]

        # KOM comparison
        segment_id = effort["segment"]["id"]
        kom = strava_get_leaderboard(segment_id, access_token)
        time.sleep(0.3)  # rate limiting

        seg = {
            "t_start": t_start,
            "t_end": t_end,
            "name": name,
            "elapsed_time": elapsed,
            "is_pr": is_pr,
        }
        if prev_pr:
            seg["previous_pr"] = prev_pr
        if kom:
            if kom.get("elapsed_time"):
                seg["kom_elapsed_time"] = kom["elapsed_time"]
            seg["kom_athlete"] = kom.get("athlete_name", "")
            if kom.get("entry_count"):
                seg["total_efforts"] = kom["entry_count"]

        # Rank from activity effort
        rank = effort.get("rank")
        if rank:
            seg["athlete_rank"] = rank

        segments.append(seg)

    return segments


# ── MP4 GPS extraction ────────────────────────────────────────────────────────

def extract_gps_from_mp4(mp4_path):
    import shutil, tempfile, subprocess

    if not shutil.which("exiftool"):
        sys.exit("exiftool not found in PATH. Install from https://exiftool.org and retry.")

    tmp = tempfile.NamedTemporaryFile(suffix=".gpx", delete=False)
    tmp.close()

    result = subprocess.run(
        ["exiftool", "-ee3", "-p", "gpx.fmt", mp4_path],
        capture_output=True, text=True
    )
    if result.returncode != 0 or not result.stdout.strip():
        os.unlink(tmp.name)
        sys.exit(f"exiftool failed to extract GPS from {mp4_path}.\n{result.stderr}")

    with open(tmp.name, "w", encoding="utf-8") as f:
        f.write(result.stdout)
    print(f"Extracted GPS from MP4 → temp GPX")
    return tmp.name


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("gpx_file", help="Path to .gpx export (Garmin) or .mp4 (camera with GPS, requires exiftool)")
    parser.add_argument("--id", dest="run_id", required=True,
                        help="Run ID matching runs.json (e.g. run-eve-6k)")
    parser.add_argument("--strava-activity-id", dest="strava_activity_id", default=None,
                        help="Strava activity ID to fetch segment data")
    args = parser.parse_args()

    if not os.path.isfile(args.gpx_file):
        sys.exit(f"File not found: {args.gpx_file}")

    temp_gpx = None
    if args.gpx_file.lower().endswith(".mp4"):
        temp_gpx = extract_gps_from_mp4(args.gpx_file)
        gpx_path = temp_gpx
    else:
        gpx_path = args.gpx_file

    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "runs", args.run_id)
    os.makedirs(out_dir, exist_ok=True)

    # ── Route ─────────────────────────────────────────────────────────────────
    print(f"Parsing {args.gpx_file}...")
    route = parse_gpx(gpx_path)
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

    # ── Strava segments (optional) ─────────────────────────────────────────────
    strava_id = args.strava_activity_id or os.environ.get("STRAVA_ACTIVITY_ID", "")
    client_id = os.environ.get("STRAVA_CLIENT_ID", "")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET", "")
    refresh_token = os.environ.get("STRAVA_REFRESH_TOKEN", "")

    if strava_id and client_id and client_secret and refresh_token:
        print(f"\nFetching Strava segments for activity {strava_id}...")
        try:
            access_token = strava_get_token(client_id, client_secret, refresh_token)
            activity = strava_get_activity(strava_id, access_token)
            segments = build_segments(activity, access_token)
            segments_path = os.path.join(out_dir, "segments.json")
            with open(segments_path, "w", encoding="utf-8") as f:
                json.dump(segments, f, ensure_ascii=False, indent=2)
            print(f"Wrote {segments_path} ({len(segments)} segments)")
        except Exception as e:
            print(f"Warning: Strava fetch failed — {e}")
    else:
        missing = []
        if not strava_id:      missing.append("--strava-activity-id or STRAVA_ACTIVITY_ID")
        if not client_id:      missing.append("STRAVA_CLIENT_ID")
        if not client_secret:  missing.append("STRAVA_CLIENT_SECRET")
        if not refresh_token:  missing.append("STRAVA_REFRESH_TOKEN")
        print(f"\nNote: Skipping Strava segments. Set {', '.join(missing)} to enable.")

    if temp_gpx and os.path.exists(temp_gpx):
        os.unlink(temp_gpx)


if __name__ == "__main__":
    main()
