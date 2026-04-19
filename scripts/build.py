"""
build.py — Outrun the Grid data pipeline
Usage: python scripts/build.py <path/to/run.gpx>
Outputs: data/route_data.json, data/landmarks.json
"""

import argparse
import json
import math
import os
import sys

import gpxpy
import requests


def haversine(lat1, lon1, lat2, lon2):
    """Return distance in meters between two lat/lon points."""
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


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

    t0 = points[0].time
    route = []
    prev_pt = None
    prev_t = None

    for pt in points:
        if pt.time is None:
            continue
        rel_t = (pt.time - t0).total_seconds()

        pace = None
        if prev_pt is not None and prev_t is not None:
            dt = (pt.time - prev_t).total_seconds()
            dist = haversine(prev_pt.latitude, prev_pt.longitude, pt.latitude, pt.longitude)
            if dist > 0 and dt > 0:
                pace = round((dt / 60) / (dist / 1000), 2)  # min/km

        route.append({
            "t": round(rel_t, 1),
            "lat": pt.latitude,
            "lon": pt.longitude,
            "pace": pace,
            "ele": round(pt.elevation, 1) if pt.elevation is not None else None,
        })
        prev_pt = pt
        prev_t = pt.time

    return route


def fetch_landmarks(route):
    lats = [p["lat"] for p in route]
    lons = [p["lon"] for p in route]
    min_lat, max_lat = min(lats) - 0.001, max(lats) + 0.001
    min_lon, max_lon = min(lons) - 0.001, max(lons) + 0.001

    overpass_url = "https://overpass-api.de/api/interpreter"
    query = f"""
[out:json][timeout:30];
(
  node["name"][~"amenity|shop|tourism|historic|leisure"~"."]
    ({min_lat},{min_lon},{max_lat},{max_lon});
);
out body;
"""
    print("Querying Overpass API for landmarks...")
    try:
        resp = requests.post(overpass_url, data={"data": query}, timeout=40)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"Warning: Overpass query failed ({e}). Writing empty landmarks.json.")
        return []

    elements = resp.json().get("elements", [])
    landmarks = []

    for el in elements:
        name = el.get("tags", {}).get("name", "").strip()
        if not name:
            continue
        el_lat, el_lon = el.get("lat"), el.get("lon")
        if el_lat is None or el_lon is None:
            continue

        # Find nearest route point within 50m
        best_t, best_dist = None, float("inf")
        for pt in route:
            d = haversine(el_lat, el_lon, pt["lat"], pt["lon"])
            if d < best_dist:
                best_dist = d
                best_t = pt["t"]

        if best_dist <= 50:
            landmarks.append({
                "t": best_t,
                "name": name,
                "lat": el_lat,
                "lon": el_lon,
            })

    # Sort by time; deduplicate by rounding to nearest 5s
    seen = set()
    deduped = []
    for lm in sorted(landmarks, key=lambda x: x["t"]):
        bucket = round(lm["t"] / 5)
        if bucket not in seen:
            seen.add(bucket)
            deduped.append(lm)

    print(f"Found {len(deduped)} landmarks within 50m of route.")
    return deduped


def main():
    parser = argparse.ArgumentParser(description="Build route_data.json and landmarks.json from a GPX file.")
    parser.add_argument("gpx_file", help="Path to Garmin .gpx export")
    args = parser.parse_args()

    if not os.path.isfile(args.gpx_file):
        sys.exit(f"File not found: {args.gpx_file}")

    out_dir = os.path.join(os.path.dirname(__file__), "..", "data")
    os.makedirs(out_dir, exist_ok=True)

    print(f"Parsing {args.gpx_file}...")
    route = parse_gpx(args.gpx_file)
    print(f"Extracted {len(route)} track points.")

    route_path = os.path.join(out_dir, "route_data.json")
    with open(route_path, "w", encoding="utf-8") as f:
        json.dump(route, f, separators=(",", ":"))
    print(f"Wrote {route_path}")

    landmarks = fetch_landmarks(route)
    landmarks_path = os.path.join(out_dir, "landmarks.json")
    with open(landmarks_path, "w", encoding="utf-8") as f:
        json.dump(landmarks, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {landmarks_path}")


if __name__ == "__main__":
    main()
