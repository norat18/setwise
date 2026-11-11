# Setwise

A free, simple workout tracker that runs in the browser. No account needed: each person's data stays in their own browser, with optional Google sign-in to sync across devices.

**Live:** https://setwiseapp.web.app

Older addresses (https://setwise.lease-reader.workers.dev, https://setwise-c0ajl.web.app) still work. They send new visitors to the main address and offer existing users a one-tap **Move my data**, since each address keeps its own data.

## Features
- **Workouts** – build routines with sections (e.g. Warm Up / Weights), supersets, per-set reps and starting weights (`12,12,10,10`), RIR targets and rest time per exercise
- **Programs (mesocycles)** – repeat a weekly schedule for N weeks, with optional weight/rep progression, a deload final week, and cardio days (activity, minutes, intensity); week-by-week plan view and "Run again"
- **Live logging** – "last time" and target suggestions, tick-off sets, rest timer (vibrate + beep), superset flow (no rest between paired exercises, rest after the round), workout clock, notes, optional per-set RIR, auto warm-up sets, and a plate calculator for barbell lifts
- **Cardio logging** – timer, activity, minutes, distance, intensity and pace
- **History** – calendar and list of every session; edit sets, reps, RIR and notes afterwards (PRs are recalculated)
- **Progress** – weekly volume, sets per muscle group, per-exercise charts (est. 1RM, top weight, volume) and automatic PR detection
- **Exercise library** – ~40 built-in exercises plus your own
- **Sync (optional)** – sign in with Google to keep data in Cloud Firestore and use it on several devices (`public/sync.js`)
- **Your data** – stored in the browser (localStorage); export/import a JSON backup with a "last backup" date and a reminder after 3 sessions without one; asks the browser to protect the data from automatic cleanup; share a single program as a file
- **Installable** – works offline and can be added to a phone's home screen (PWA)

## Project layout
```
public/              the app (static files, no build step)
  index.html         shell and tab bar
  app.js             state, views, actions, charts
  sync.js            optional cloud sync (Firebase Auth + Firestore), loaded only when turned on
  data.js            seed exercises and starter workouts
  styles.css         light/dark theme
  sw.js, manifest.webmanifest, icon.svg   offline/PWA support
cloudflare.config.ts, wrangler.config.ts  Cloudflare Workers (static assets) config
firebase.json        Firebase Hosting + Firestore rules config
firestore.rules      each signed-in user can read/write only users/{their uid}/**
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
### Automatic deploys
Every push to `main` deploys to both hosts:

- **Cloudflare** – Workers Builds, connected to this repo in the Cloudflare dashboard (Workers & Pages → setwise → Settings → Build). Deploy command: `npx cf deploy`. Build logs and rollbacks are in the dashboard.
- **Firebase** – GitHub Actions (`.github/workflows/deploy.yml`), also runnable by hand from the Actions tab. Needs the repository secret `FIREBASE_SERVICE_ACCOUNT`: the full JSON key of a service account for the Firebase project (Project settings → Service accounts → Generate new private key).

After changing app files, bump `CACHE` in `public/sw.js` so installed copies refresh their offline cache.

## Sharing programs
Program page → **Share as file** saves a program and its workouts (no history) as `*.setwise.json`.
Anyone can add it with **Workouts → Programs → Import** (or Settings → Import file); it merges with their existing data.

## Private files
`private/` (git-ignored, never deployed) is for personal program files you don't want to publish.

## Cloud sync setup
Sync uses the Firebase project `setwise-c0ajl`:
- **Authentication:** Google provider enabled; `setwiseapp.web.app` is an authorized domain.
- **Firestore:** `(default)` database. After changing `firestore.rules`, run `npx firebase deploy --only firestore:rules`; the GitHub workflow only deploys Hosting.

Data lives at `users/{uid}/meta/main` (exercises, workouts, programs, settings) and `users/{uid}/sessions/{id}` (one per finished session; deletions are kept as `{ deleted: true }`). Each device sends changes within about a second; when two devices edit the same thing, the newest one to reach the cloud wins.
