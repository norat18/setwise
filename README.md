# Setwise

A free, simple workout tracker that runs in the browser. No account, no backend — each person's data stays in their own browser.

**Live:** https://setwise.lease-reader.workers.dev (Cloudflare) · Firebase Hosting mirror (see below)

## Features
- **Workouts** – build routines with sections (e.g. Warm Up / Weights), supersets, per-set reps and starting weights (`12,12,10,10`), RIR targets and rest time per exercise
- **Programs (mesocycles)** – repeat a weekly schedule for N weeks, with optional weight/rep progression, a deload final week, and cardio days (activity, minutes, intensity); week-by-week plan view and "Run again"
- **Live logging** – "last time" and target suggestions, tick-off sets, rest timer (vibrate + beep), superset flow (no rest between paired exercises, rest after the round), workout clock, notes
- **Cardio logging** – timer, activity, minutes, distance, intensity and pace
- **History** – calendar and list of every session
- **Progress** – weekly volume, sets per muscle group, per-exercise charts (est. 1RM, top weight, volume) and automatic PR detection
- **Exercise library** – ~40 built-in exercises plus your own
- **Your data** – stored in the browser (localStorage); export/import a JSON backup; share a single program as a file
- **Installable** – works offline and can be added to a phone's home screen (PWA)

## Project layout
```
public/              the app (static files, no build step)
  index.html         shell and tab bar
  app.js             state, views, actions, charts
  data.js            seed exercises and starter workouts
  styles.css         light/dark theme
  sw.js, manifest.webmanifest, icon.svg   offline/PWA support
cloudflare.config.ts, wrangler.config.ts  Cloudflare Workers (static assets) config
firebase.json        Firebase Hosting config
```

## Run locally
```bash
npm run dev
```
Then open http://localhost:5173.

## Deploy
```bash
npm install
npm run deploy:cloudflare   # cf deploy → Workers static assets
npm run deploy:firebase     # firebase deploy --only hosting
npm run deploy              # both
```
After changing app files, bump `CACHE` in `public/sw.js` so installed copies refresh their offline cache.

## Sharing programs
Program page → **Share as file** saves a program and its workouts (no history) as `*.setwise.json`.
Anyone can add it with **Workouts → Programs → Import** (or Settings → Import file); it merges with their existing data.

## Private files
`private/` (git-ignored, never deployed) is for personal program files you don't want to publish.
