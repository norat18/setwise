'use strict';

/* =========================================================
   Optional cloud sync: Google sign-in + Cloud Firestore.
   Nothing here runs until someone turns sync on in Settings,
   and the Firebase SDK is only downloaded at that point.

   Cloud layout (only the signed-in user can read or write it):
     users/{uid}/meta/main        { json, updatedAt }  exercises, workouts, programs, settings
     users/{uid}/sessions/{id}    { json, updatedAt }  one finished workout
                                  { deleted: true, updatedAt } once deleted
   The workout in progress stays on the device.
   ========================================================= */

// A Firebase web config is public by design; access is controlled by the Firestore rules.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDao8B_qxBZrNw7kHmqo1gw4zIapd8Y5ns',
  // Sign-in pages are served from the app's own address so Safari keeps the result
  // (Firebase Hosting serves /__/auth/* on every site).
  authDomain: location.hostname === 'setwiseapp.web.app' ? 'setwiseapp.web.app' : 'setwise-c0ajl.firebaseapp.com',
  projectId: 'setwise-c0ajl',
  storageBucket: 'setwise-c0ajl.firebasestorage.app',
  messagingSenderId: '1076657664425',
  appId: '1:1076657664425:web:593b2096d98fabaecdd4b8',
};
const FB_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SYNC_KEY = 'setwise.sync'; // '1' once sync is turned on on this device
const SYNC_HOSTS = ['setwiseapp.web.app', 'localhost'];
const MAIN_KEYS = ['exercises', 'templates', 'programs', 'programId', 'settings', 'imported', 'lastBackup'];

// phase: off | loading | signed-out | syncing | synced | error | unsupported
const syncState = { phase: 'off', user: null, error: '', last: 0 };
let fb = null, unsubs = [], meta = null, ready = false, pushTimer = null, applyingRemote = false;

const syncAllowed = () => SYNC_HOSTS.includes(location.hostname);
const mainJSON = () => JSON.stringify(Object.fromEntries(MAIN_KEYS.map(k => [k, state[k] ?? null])));
const syncedSessions = () => state.sessions.filter(x => !x.sample);

/** Small, fast string hash (cyrb53), used to spot what changed since the last sync. */
function hashStr(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// What this device knows is already in the cloud: { main: hash|null, sessions: { id: hash | 'D' } }
const metaKey = () => 'setwise.syncmeta.' + syncState.user.uid;
function loadMeta() {
  try { return JSON.parse(localStorage.getItem(metaKey())) || { main: null, sessions: {} }; }
  catch (e) { return { main: null, sessions: {} }; }
}
function saveMeta() { try { localStorage.setItem(metaKey(), JSON.stringify(meta)); } catch (e) { /* ignore */ } }

async function loadFirebase() {
  if (fb) return fb;
  if (window.__setwiseFakeFirebase) return (fb = await window.__setwiseFakeFirebase()); // tests only
  const [appM, A, F] = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => import(FB_SDK + f)));
  const app = appM.initializeApp(FIREBASE_CONFIG);
  let db;
  try {
    // Keeps unsent changes on the device if the app closes while offline.
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch (e) { db = F.getFirestore(app); }
  fb = { auth: A.getAuth(app), db, A, F };
  return fb;
}

function authError(e) {
  const code = e?.code || '';
  if (code === 'auth/unauthorized-domain') return 'Sign-in isn’t set up for this address yet.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return '';
  if (code === 'auth/network-request-failed') return 'No internet connection. Try again when you’re online.';
  if (code === 'auth/operation-not-allowed' || code === 'auth/configuration-not-found') return 'Google sign-in isn’t turned on for Setwise yet.';
  return `Sign-in didn’t work (${code || e?.message || 'unknown error'}). Please try again.`;
}

let started = null;
function startSync() {
  if (started) return started;
  started = (async () => {
    if (!syncAllowed()) { syncState.phase = 'unsupported'; refreshSyncUI(); return; }
    syncState.phase = 'loading'; refreshSyncUI();
    try { await loadFirebase(); }
    catch (e) { started = null; syncState.phase = 'error'; syncState.error = 'Couldn’t reach the sync service. Check your connection.'; refreshSyncUI(); return; }
    try { await fb.A.getRedirectResult(fb.auth); } catch (e) { syncState.error = authError(e); }
    fb.A.onAuthStateChanged(fb.auth, user => {
      stopListening();
      syncState.user = user ? { uid: user.uid, email: user.email || '', name: user.displayName || '' } : null;
      if (!user) { syncState.phase = 'signed-out'; refreshSyncUI(); return; }
      syncState.error = '';
      meta = loadMeta();
      syncState.phase = 'syncing'; refreshSyncUI();
      listen(user.uid);
    });
  })();
  return started;
}

function stopListening() {
  unsubs.forEach(u => u()); unsubs = [];
  ready = false; clearTimeout(pushTimer);
}

function listen(uid) {
  const { F, db } = fb;
  let gotMain = false, gotSessions = false;
  const both = () => { if (gotMain && gotSessions && !ready) { ready = true; pushNow(); } };
  unsubs.push(F.onSnapshot(F.doc(db, 'users', uid, 'meta', 'main'), snap => {
    if (snap.metadata?.hasPendingWrites) return;
    applyRemoteMain(snap.exists() ? snap.data() : null);
    gotMain = true; both();
  }, onSyncError));
  unsubs.push(F.onSnapshot(F.collection(db, 'users', uid, 'sessions'), snap => {
    applyRemoteSessions(snap.docChanges().filter(c => c.type !== 'removed' && !c.doc.metadata?.hasPendingWrites));
    gotSessions = true; both();
    if (ready && !snap.metadata?.hasPendingWrites) setSynced();
  }, onSyncError));
}

function adoptMain(m) {
  MAIN_KEYS.forEach(k => { state[k] = m[k] ?? (k === 'imported' ? [] : null); });
  state.settings = { ...defaultState().settings, ...(m.settings || {}) };
}

// ---------- Earlier versions (undo an update from another device) ----------
const EARLIER_KEY = 'setwise.earlier';
function earlierVersions() {
  try { return JSON.parse(localStorage.getItem(EARLIER_KEY)) || []; } catch (e) { return []; }
}
function keepEarlierVersion(json) {
  const list = earlierVersions().filter(v => v.json !== json);
  list.unshift({ at: Date.now(), json });
  try { localStorage.setItem(EARLIER_KEY, JSON.stringify(list.slice(0, 5))); } catch (e) { /* storage full */ }
}
function earlierCard() {
  const list = earlierVersions();
  if (!list.length) return '';
  return `<details class="earlier"><summary class="small">Earlier versions on this device (${list.length})</summary>
    <p class="muted small">Saved here each time a change from another device replaced your workouts, programs or settings. Restoring one sends it to all your devices.</p>
    ${list.map((v, i) => {
      let names = '';
      try { names = (JSON.parse(v.json).templates || []).map(t => t.name).join(', '); } catch (e) { /* skip */ }
      return `<div class="earlier-row"><div style="min-width:0"><b>${fmtDate(v.at, { month: 'short', day: 'numeric' })}, ${fmtTime(v.at)}</b><div class="muted small ellipsis">${esc(names || 'No workouts')}</div></div>
        <button class="btn small" data-act="sync-restore" data-i="${i}">Restore</button></div>`;
    }).join('')}
  </details>`;
}

function applyRemoteMain(data) {
  if (!data?.json) return; // nothing in the cloud yet: the first push creates it
  const rh = hashStr(data.json);
  if (rh === meta.main) return;
  let remote;
  try { remote = JSON.parse(data.json); } catch (e) { return; }
  const localJ = mainJSON();
  const localUnsent = meta.main !== null && hashStr(localJ) !== meta.main;
  applyingRemote = true;
  // Whatever is about to be replaced is kept on this device so it can be restored.
  if (!localUnsent && hashStr(localJ) !== rh) keepEarlierVersion(localJ);
  if (meta.main === null) {
    // First sync on this device: the cloud copy wins, and anything only on this device is added to it.
    const local = JSON.parse(localJ);
    adoptMain(remote);
    mergeInto({ ...local, sessions: [] });
  } else if (!localUnsent) {
    adoptMain(remote);
  } // else: this device changed it too and is about to send its version
  meta.main = rh;
  saveMeta(); save();
  applyingRemote = false;
  renderSoon();
  // If merging or a newer local edit left this device different from the cloud, send it.
  if (ready && hashStr(mainJSON()) !== meta.main) schedulePush();
}

function applyRemoteSessions(changes) {
  let changed = false;
  applyingRemote = true;
  for (const c of changes) {
    const id = c.doc.id, d = c.doc.data();
    const rh = d.deleted ? 'D' : hashStr(d.json || '');
    if (meta.sessions[id] === rh) continue;
    const i = state.sessions.findIndex(x => x.id === id);
    const known = meta.sessions[id];
    if (i >= 0 && known && known !== 'D' && hashStr(JSON.stringify(state.sessions[i])) !== known) {
      meta.sessions[id] = rh; continue; // edited here too and not sent yet: this device's version wins
    }
    if (d.deleted) { if (i >= 0) { state.sessions.splice(i, 1); changed = true; } }
    else {
      try {
        const s = JSON.parse(d.json);
        if (i >= 0) state.sessions[i] = s; else state.sessions.push(s);
        changed = true;
      } catch (e) { continue; }
    }
    meta.sessions[id] = rh;
  }
  saveMeta();
  if (changed) save();
  applyingRemote = false;
  if (changed) renderSoon();
}

/** Called by save() in app.js after every local change. */
function onLocalSave() {
  if (applyingRemote || !ready) return;
  schedulePush();
}
function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushNow, 1200); }

function pushNow() {
  if (!ready || !syncState.user) return;
  const { F, db } = fb, uid = syncState.user.uid, now = Date.now();
  const writes = [];
  const mj = mainJSON(), mh = hashStr(mj);
  if (mh !== meta.main) writes.push([F.doc(db, 'users', uid, 'meta', 'main'), { json: mj, updatedAt: now }, () => { meta.main = mh; }]);
  const here = new Set();
  for (const s of syncedSessions()) {
    here.add(s.id);
    const j = JSON.stringify(s), h = hashStr(j);
    if (meta.sessions[s.id] !== h) writes.push([F.doc(db, 'users', uid, 'sessions', s.id), { json: j, updatedAt: now }, () => { meta.sessions[s.id] = h; }]);
  }
  for (const [id, h] of Object.entries(meta.sessions)) {
    if (h !== 'D' && !here.has(id)) writes.push([F.doc(db, 'users', uid, 'sessions', id), { deleted: true, updatedAt: now }, () => { meta.sessions[id] = 'D'; }]);
  }
  if (!writes.length) { setSynced(); return; }
  syncState.phase = 'syncing'; refreshSyncUI();
  for (let i = 0; i < writes.length; i += 400) {
    const chunk = writes.slice(i, i + 400);
    const batch = F.writeBatch(db);
    chunk.forEach(([ref, data]) => batch.set(ref, data));
    chunk.forEach(w => w[2]());
    batch.commit().then(setSynced).catch(onSyncError); // resolves once the server has it; queued while offline
  }
  saveMeta();
}

function setSynced() {
  if (!syncState.user) return;
  syncState.phase = 'synced'; syncState.last = Date.now(); syncState.error = '';
  refreshSyncUI();
}
function onSyncError(e) {
  syncState.phase = 'error';
  syncState.error = e?.code === 'permission-denied' ? 'The cloud refused this account’s data. Try signing out and in again.' : `Sync hit a problem (${e?.code || e?.message || 'unknown'}). It will retry when you reopen the app.`;
  refreshSyncUI();
}

async function syncSignIn() {
  try { localStorage.setItem(SYNC_KEY, '1'); } catch (e) { /* ignore */ }
  syncState.error = '';
  await startSync();
  if (!fb) return;
  const provider = new fb.A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  // Home-screen apps can't receive a result from a pop-up window, so sign in within the app's own window there.
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (standalone) { syncState.phase = 'loading'; refreshSyncUI(); return fb.A.signInWithRedirect(fb.auth, provider); }
  try { await fb.A.signInWithPopup(fb.auth, provider); }
  catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) return fb.A.signInWithRedirect(fb.auth, provider);
    syncState.error = authError(e); refreshSyncUI();
  }
}
async function syncSignOut() {
  if (!confirm('Stop syncing on this device? Your data stays here and in the cloud.')) return;
  try { localStorage.removeItem(SYNC_KEY); } catch (e) { /* ignore */ }
  stopListening();
  if (fb) await fb.A.signOut(fb.auth).catch(() => {});
  syncState.phase = 'signed-out'; syncState.user = null;
  refreshSyncUI(); render();
}

/** Re-render after a change from another device, without stealing focus from a field being typed in. */
function renderSoon() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && $('#view').contains(a)) a.addEventListener('blur', () => setTimeout(render, 0), { once: true });
  else render();
}

function syncAgo() {
  const s = Math.round((Date.now() - syncState.last) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : fmtTime(syncState.last);
}
function syncCard() {
  const p = syncState.phase, u = syncState.user;
  const err = syncState.error ? `<p class="sync-err small">${esc(syncState.error)}</p>` : '';
  let body;
  if (!syncAllowed()) {
    body = `<p class="muted small" style="margin:0">Sync works at <b>${esc(HOME.replace(/^https?:\/\//, ''))}</b>. Move your data there first.</p>`;
  } else if (u) {
    const status = p === 'synced' ? `✓ Synced ${syncAgo()}`
      : p === 'error' ? 'Not synced'
      : navigator.onLine === false ? 'Offline. Changes will sync when you’re back online.'
      : 'Syncing…';
    body = `<div class="row between" style="gap:10px"><div style="min-width:0"><b class="ellipsis">${esc(u.email || u.name || 'Signed in')}</b><div class="muted small">${status}</div></div>
      <button class="btn small" data-act="sync-out">Sign out</button></div>${err}${earlierCard()}`;
  } else if (p === 'loading' || (p === 'off' && syncTurnedOn())) {
    body = `<p class="muted small" style="margin:0">Connecting…</p>`;
  } else {
    body = `<p class="muted small" style="margin-top:0">Sign in to keep a copy of your workouts in the cloud and use Setwise on more than one device. Only you can see your data.</p>
      <button class="btn primary block" data-act="sync-in">Sign in with Google</button>${err}`;
  }
  return `<div class="card" id="sync-card">${body}</div>`;
}
function refreshSyncUI() {
  const el = $('#sync-card');
  if (el) el.outerHTML = syncCard();
}

actions['sync-in'] = () => syncSignIn();
actions['sync-out'] = () => syncSignOut();
actions['sync-restore'] = el => {
  const list = earlierVersions(), v = list[+el.dataset.i];
  if (!v) return;
  if (!confirm(`Restore the version from ${fmtDate(v.at, { month: 'short', day: 'numeric' })}, ${fmtTime(v.at)}? It replaces the workouts, programs and settings on all your devices. Your workout history isn't affected.`)) return;
  keepEarlierVersion(mainJSON()); // so this can be undone too
  adoptMain(JSON.parse(v.json));
  try { localStorage.setItem(EARLIER_KEY, JSON.stringify(earlierVersions().filter(x => x.json !== v.json))); } catch (e) { /* ignore */ }
  save(); render();
  toast('Restored. Your other devices will update in a few seconds.');
};
addEventListener('online', () => { if (ready) pushNow(); refreshSyncUI(); });
addEventListener('offline', refreshSyncUI);
setInterval(() => { if (syncState.phase === 'synced') refreshSyncUI(); }, 30000);

if (syncTurnedOn() && !LEAVING) startSync();
if (parseRoute().name === 'settings') render();
