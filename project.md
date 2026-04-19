# Outrun the Grid — Project Vision

## The Idea

Running races and long efforts are full of moments that are hard to share: the surge past a landmark, the pace collapse on a hill, the crowd noise at mile 4. Action camera footage captures the feel but loses the data. GPS watches capture the data but lose the feel.

**Outrun the Grid** puts both on screen at the same time, transforming a raw run into an interactive, cinematic event.

It's a personal race-day dashboard — a split-screen view where your footage plays on the left and a live map traces your position on the right. As the video plays, a marker moves along your route in real time. When you hit a steep climb, the UI reacts to the "boss fight." When you hold a fast pace, your marker leaves a glowing trail. The HUD shows your pace, elevation, and dynamic narrative commentary at every moment.

The aesthetic is intentional: synthwave, neon, retro-grid. Running already feels cinematic. The UI should match that feeling.

## Who It's For

Primarily yourself — a tool for reliving and sharing efforts in a way that raw footage or Garmin replays alone can't do. Secondarily, anyone watching: the dashboard makes a run legible and highly engaging to someone who wasn't there.

## What Makes It Different

- **No backend.** Everything runs in the browser from static files. Zero infrastructure cost, deployable to GitHub Pages in minutes.
- **No API keys exposed.** Leaflet + OpenStreetMap for mapping, YouTube for video — no secrets in the repo.
- **Gamified Telemetry.** Pace and elevation aren't just numbers; they dictate the visual state of the dashboard (streaks, climb modes, dynamic colors).
- **Data-first.** The GPS telemetry drives everything. The video is a passenger.

## North Star

The ideal version of this project makes a 17K run feel like a produced broadcast or retro arcade game — reactive pace overlays, AI-generated narrative chapter titles, and a co-op map that tracks you and a ghost runner simultaneously — with minimal manual work per run.