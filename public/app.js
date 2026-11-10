'use strict';

/* =========================================================
   Setwise — personal workout tracker
   Plain JS, no build step. All data lives in localStorage.
   ========================================================= */

const STORE_KEY = 'setwise.v1';
const DAY = 864e5;

// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtW = n => String(Math.round((+n || 0) * 10) / 10);
const compact = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const e1rm = (w, r) => (!r || !w) ? 0 : r === 1 ? w : w * (1 + r / 30);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min} min`;
}
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}
const fmtDate = (ts, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(ts).toLocaleDateString(undefined, opts);
const fmtTime = ts => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// ---------- State ----------
function defaultState() {
  return {
    version: 1,
    welcomed: false,
    exercises: SEED_EXERCISES.map(([name, muscle, equipment]) => ({ id: slug(name), name, muscle, equipment })),
    templates: SEED_TEMPLATES.map(t => ({
      id: uid(),
      name: t.name,
      items: t.items.map(([n, sets, reps]) => ({ exerciseId: slug(n), sets, reps })),
    })),
    sessions: [],
    programs: [],
    programId: null, // the active program (mesocycle)
    active: null,
    settings: { unit: 'kg', rest: 90, autoRest: true },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaultState();
      return { ...d, welcomed: true, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    }
  } catch (e) { /* fall through to defaults */ }
  return defaultState();
}

let state = load();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — browser storage is full or blocked'); }
}
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }

const exById = id => state.exercises.find(e => e.id === id) || { id, name: 'Unknown exercise', muscle: 'Other', equipment: 'Other' };
const unit = () => state.settings.unit;

// ---------- Derived data ----------
const sessionVolume = s => s.entries.reduce((a, en) => a + en.sets.reduce((b, x) => b + (x.w || 0) * (x.r || 0), 0), 0);
const sessionSetCount = s => s.entries.reduce((a, en) => a + en.sets.length, 0);
const sortedSessions = () => [...state.sessions].sort((a, b) => b.start - a.start);

/** Sets of an exercise from its most recent finished session. */
function lastSets(exId) {
  for (const s of sortedSessions()) {
    const sets = s.entries.filter(e => e.exerciseId === exId).flatMap(e => e.sets);
    if (sets.length) return sets;
  }
  return [];
}

/** [{session, sets}] oldest → newest */
function exerciseHistory(exId) {
  return [...state.sessions]
    .sort((a, b) => a.start - b.start)
    .map(s => ({ s, sets: s.entries.filter(e => e.exerciseId === exId).flatMap(e => e.sets) }))
    .filter(h => h.sets.length);
}

function bestOf(sets) {
  let e = 0, w = 0, r = 0, vol = 0;
  for (const x of sets) {
    e = Math.max(e, e1rm(x.w, x.r));
    w = Math.max(w, x.w || 0);
    r = Math.max(r, x.r || 0);
    vol += (x.w || 0) * (x.r || 0);
  }
  return { e1rm: e, weight: w, reps: r, volume: vol };
}

/** PRs this session set compared with every earlier session. First-ever attempts don't count. */
function computePRs(session) {
  const prs = [];
  const ids = [...new Set(session.entries.map(e => e.exerciseId))];
  for (const id of ids) {
    const prior = state.sessions
      .filter(s => s.id !== session.id && s.start < session.start)
      .flatMap(s => s.entries.filter(e => e.exerciseId === id).flatMap(e => e.sets));
    if (!prior.length) continue;
    const before = bestOf(prior);
    const now = bestOf(session.entries.filter(e => e.exerciseId === id).flatMap(e => e.sets));
    if (now.weight > 0) {
      if (now.weight > before.weight) prs.push({ exerciseId: id, type: 'weight', value: now.weight });
      if (now.e1rm > before.e1rm + 0.05) prs.push({ exerciseId: id, type: 'e1rm', value: Math.round(now.e1rm * 10) / 10 });
    } else if (before.weight === 0 && now.reps > before.reps) {
      prs.push({ exerciseId: id, type: 'reps', value: now.reps });
    }
  }
  return prs;
}
const prCount = s => new Set((s.prs || []).map(p => p.exerciseId)).size;
const prLabel = p => p.type === 'weight' ? `Heaviest · ${fmtW(p.value)} ${unit()}` : p.type === 'e1rm' ? `Est. 1RM · ${fmtW(p.value)} ${unit()}` : `Most reps · ${p.value}`;

function weekStreak() {
  const weeks = new Set(state.sessions.map(s => startOfWeek(s.start).getTime()));
  const d = startOfWeek(new Date());
  if (!weeks.has(d.getTime())) d.setDate(d.getDate() - 7);
  let n = 0;
  while (weeks.has(d.getTime())) { n++; d.setDate(d.getDate() - 7); }
  return n;
}

// ---------- Programs (mesocycles) ----------
// A program repeats a weekly schedule of workouts for N weeks, optionally adding
// weight or reps each week and finishing with a deload week.
// Shape: { id, name, weeks, start: 'YYYY-MM-DD', schedule: [templateId|'' × 7, Mon→Sun],
//          progType: 'none'|'weight'|'reps', progAmount, deload }
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DOW_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dow0 = d => (new Date(d).getDay() + 6) % 7; // 0 = Monday
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / DAY);
const roundW = n => unit() === 'lb' ? Math.round(n) : Math.round(n * 2) / 2;
const activeProgram = () => state.programs.find(p => p.id === state.programId) || null;
const tplById = id => state.templates.find(t => t.id === id);
const isDeloadWeek = (p, week) => p.deload && p.weeks > 1 && week === p.weeks;
const CARDIO_TYPES = ['Run', 'Walk', 'Incline Walk', 'Bike', 'Spin', 'Row', 'Elliptical', 'Stair Climber', 'Swim', 'Jump Rope', 'HIIT', 'Other'];
const INTENSITIES = ['Easy / Zone 2', 'Moderate', 'Hard', 'Intervals'];
const distUnit = () => unit() === 'lb' ? 'mi' : 'km';
const cardioOf = p => p.cardio || [];
const liftsPerWeek = p => p.schedule.filter(Boolean).length;
const cardioPerWeek = p => cardioOf(p).filter(c => c?.type).length;
const perWeekText = p => [liftsPerWeek(p) && `${liftsPerWeek(p)}× lifting`, cardioPerWeek(p) && `${cardioPerWeek(p)}× cardio`].filter(Boolean).join(' · ') || 'No training days';
const cardioLabel = c => `${c.type}${c.minutes ? ` · ${c.minutes} min` : ''}`;
/** Display name for a program slot (a lifting workout or a cardio session). */
const slotName = s => s.kind === 'cardio' ? cardioLabel(s.cardio) : (tplById(s.templateId)?.name || 'Deleted workout');

/** Every scheduled workout in the program, in date order. */
function programSlots(p) {
  const start = parseDay(p.start);
  const sd = dow0(start);
  const days = [];
  p.schedule.forEach((templateId, dow) => { if (templateId) days.push({ dow, kind: 'lift', templateId, off: (dow - sd + 7) % 7 }); });
  cardioOf(p).forEach((cardio, dow) => { if (cardio?.type) days.push({ dow, kind: 'cardio', cardio, off: (dow - sd + 7) % 7 }); });
  days.sort((a, b) => a.off - b.off || (a.kind === 'lift' ? -1 : 1));
  const out = [];
  for (let week = 1; week <= p.weeks; week++) {
    for (const d of days) out.push({ week, dow: d.dow, kind: d.kind, templateId: d.templateId, cardio: d.cardio, date: addDays(start, (week - 1) * 7 + d.off) });
  }
  return out;
}
const slotSession = (p, slot) => state.sessions.find(s => s.program?.id === p.id && s.program.week === slot.week && s.program.dow === slot.dow && (s.program.kind || 'lift') === slot.kind);
const programWeek = p => Math.floor(daysBetween(parseDay(p.start), new Date()) / 7) + 1; // may be < 1 or > weeks

/** What the Today screen should offer for this program. */
function programUpNext(p) {
  const slots = programSlots(p);
  const pending = slots.filter(s => !slotSession(p, s));
  const week = programWeek(p);
  const today = dayKey(Date.now());
  if (!slots.length) return { status: 'empty' };
  if (!pending.length) return { status: 'complete' };
  if (week < 1) return { status: 'upcoming', slot: pending[0] };
  if (week > p.weeks) return { status: 'ended', skipped: pending.length };
  const todays = pending.filter(s => dayKey(s.date) === today);
  if (todays.length) return { status: 'today', slots: todays };
  const restDay = !slots.some(s => dayKey(s.date) === today);
  // Missed workouts this week come first, then the next upcoming one.
  const missed = pending.find(s => s.week === week && dayStart(s.date) < dayStart(Date.now()));
  if (missed) return { status: 'missed', slot: missed, restDay };
  const next = pending.find(s => dayStart(s.date) > dayStart(Date.now()));
  return next ? { status: 'next', slot: next, restDay } : { status: 'ended', skipped: pending.length };
}

function progDesc(p) {
  const parts = [];
  if (p.progType === 'weight') parts.push(`+${fmtW(p.progAmount)} ${unit()} per week`);
  else if (p.progType === 'reps') parts.push(`+${plural(+p.progAmount, 'rep')} per week`);
  else parts.push('Same targets each week');
  if (p.deload && p.weeks > 1) parts.push('deload in final week');
  return parts.join(' · ');
}
function weekNote(p, week) {
  if (isDeloadWeek(p, week)) return 'Deload week — lighter weight, fewer sets';
  if (week <= 1) return p.progType === 'none' ? '' : 'Week 1 — set your baseline';
  if (p.progType === 'weight') return `Add ${fmtW(p.progAmount)} ${unit()} to last time`;
  if (p.progType === 'reps') return `Add ${plural(+p.progAmount, 'rep')} to last time`;
  return '';
}
const bumpReps = (reps, n) => String(reps).replace(/\d+/g, m => String(+m + n));

function startProgramSlot(pid, week, dow, kind = 'lift') {
  const p = state.programs.find(p => p.id === pid);
  if (kind === 'cardio') {
    const c = p && cardioOf(p)[dow];
    if (!c?.type) { toast('That cardio session was removed — edit the program'); return; }
    startCardio(c, { id: p.id, name: p.name, week, dow, kind: 'cardio', note: c.intensity ? `Target: ${c.intensity}` : '' });
    return;
  }
  const t = p && tplById(p.schedule[dow]);
  if (!t) { toast('That workout no longer exists — edit the program'); return; }
  const deload = isDeloadWeek(p, week);
  const amt = +p.progAmount || 0;
  const entries = t.items.map(it => {
    const sets = deload ? Math.max(1, Math.round(it.sets * 0.6)) : it.sets;
    let target = it.reps;
    const hint = {};
    if (deload) hint.wMul = 0.9;
    else if (week > 1 && p.progType === 'weight') hint.wAdd = amt;
    else if (week > 1 && p.progType === 'reps') { hint.rAdd = amt; target = bumpReps(it.reps, amt * (week - 1)); }
    const en = newEntry(it.exerciseId, sets, target, itemExtra(it, sets, target));
    en.hint = hint;
    return en;
  });
  beginWorkout(t.name, t.id, entries, { id: p.id, name: p.name, week, dow, note: weekNote(p, week) });
}
/** Weight suggestion for a set, applying the program's progression to last time's weight. */

// ---------- Workout structure: sections, supersets, per-set targets ----------
// Template item: { exerciseId, sets, reps, weight?, rir?, section?, link? }
//   reps / weight may be a comma list with one value per set ("12,12,10,10").
//   link = true means "superset with the next exercise".
const parseList = v => String(v ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
const pick = (list, i) => list.length ? (list[i] ?? list[list.length - 1]) : '';
function setTargets(it, n) {
  const reps = parseList(it.reps), ws = parseList(it.weight);
  return Array.from({ length: n }, (_, i) => ({ tr: pick(reps, i), tw: ws.length ? (parseFloat(pick(ws, i)) || '') : '' }));
}
const itemExtra = (it, n, reps = it.reps) => ({ section: it.section || '', link: !!it.link, rir: it.rir ?? '', rest: it.rest ?? '', targets: setTargets({ ...it, reps }, n) });
// Rest between sets: per exercise in a workout, falling back to the default in Settings.
const REST_OPTIONS = [0, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300];
const restLabel = sec => +sec === 0 ? 'No rest' : fmtClock(+sec);
const restFor = en => (en.rest !== '' && en.rest != null) ? +en.rest : +state.settings.rest;
const repsSummary = trs => !trs.length ? '' : new Set(trs).size === 1 ? trs[0] : trs.join(', ');

/**
 * Render a list (template items, workout entries, session entries) with section
 * headings and superset brackets. renderOne(item, index) returns one item's HTML.
 */
function grouped(list, renderOne, renderSection = sec => `<h2 class="sec-head">${esc(sec)}</h2>`) {
  let html = '', cur = null, i = 0;
  while (i < list.length) {
    const sec = list[i].section || '';
    if (sec !== cur) { if (sec) html += renderSection(sec, i); cur = sec; }
    let j = i;
    while (list[j].link && j + 1 < list.length && (list[j + 1].section || '') === sec) j++;
    const chunk = list.slice(i, j + 1).map((x, k) => renderOne(x, i + k)).join('');
    html += j > i ? `<div class="superset"><div class="ss-label">Superset</div>${chunk}</div>` : chunk;
    i = j + 1;
  }
  return html;
}
/** Is this entry linked to the next one (same section) — i.e. not the end of a superset round? */
const linksToNext = (list, i) => !!list[i].link && i + 1 < list.length && (list[i + 1].section || '') === (list[i].section || '');
const suggestW = (w, h = {}) => w > 0 ? roundW(w * (h.wMul || 1) + (h.wAdd || 0)) : w;

// ---------- UI primitives ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function openModal(html) {
  $('#modal').innerHTML = `<div class="backdrop" data-act="backdrop">${html}</div>`;
}
function closeModal() { $('#modal').innerHTML = ''; }

// ---------- Charts (inline SVG) ----------
function lineChart(pts, suffix = '') {
  if (pts.length < 2) return `<div class="chart-empty">Log this exercise in at least two workouts to see a trend.</div>`;
  const W = 340, H = 180, pl = 38, pr = 14, pt = 16, pb = 26;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs); let x1 = Math.max(...xs); if (x1 === x0) x1 = x0 + 1;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.15 || Math.max(1, y1 * 0.1);
  y0 = Math.max(0, y0 - pad); y1 += pad;
  const X = x => pl + (x - x0) / (x1 - x0) * (W - pl - pr);
  const Y = y => pt + (1 - (y - y0) / (y1 - y0)) * (H - pt - pb);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const area = `${d}L${X(xs[xs.length - 1]).toFixed(1)},${H - pb}L${X(xs[0]).toFixed(1)},${H - pb}Z`;
  const ticks = [y0, (y0 + y1) / 2, y1];
  const dateFmt = { month: 'short', day: 'numeric' };
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend chart">
    ${ticks.map(t => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${pl - 6}" y="${Y(t) + 3}" text-anchor="end">${compact(t)}</text>`).join('')}
    <path class="area" d="${area}"/>
    <path class="line" d="${d}"/>
    ${pts.map(p => `<circle class="dot" cx="${X(p.x)}" cy="${Y(p.y)}" r="3.5"><title>${fmtDate(p.x, dateFmt)}: ${fmtW(p.y)}${suffix}</title></circle>`).join('')}
    <text class="axis" x="${pl}" y="${H - 8}">${fmtDate(x0, dateFmt)}</text>
    <text class="axis" x="${W - pr}" y="${H - 8}" text-anchor="end">${fmtDate(xs[xs.length - 1], dateFmt)}</text>
  </svg>`;
}

function barChart(bars) {
  const W = 340, H = 170, pt = 18, pb = 24, gap = 8;
  const max = Math.max(1, ...bars.map(b => b.v));
  const bw = (W - gap * (bars.length - 1)) / bars.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly volume chart">
    <line class="grid" x1="0" x2="${W}" y1="${H - pb}" y2="${H - pb}"/>
    ${bars.map((b, i) => {
      const h = (b.v / max) * (H - pt - pb);
      const x = i * (bw + gap), y = H - pb - h;
      return `<rect class="bar ${b.cur ? 'cur' : ''}" x="${x}" y="${y}" width="${bw}" height="${Math.max(h, b.v ? 2 : 0)}" rx="4"><title>${b.label}: ${compact(b.v)}</title></rect>
        ${b.v ? `<text class="val" x="${x + bw / 2}" y="${y - 5}" text-anchor="middle">${compact(b.v)}</text>` : ''}
        <text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${b.label}</text>`;
    }).join('')}
  </svg>`;
}

// ---------- Views ----------
function viewToday() {
  const now = new Date();
  const wk = startOfWeek(now);
  const week = state.sessions.filter(s => s.start >= wk.getTime());
  const trained = new Set(state.sessions.map(s => dayKey(s.start)));
  const days = [...Array(7)].map((_, i) => { const d = new Date(wk); d.setDate(d.getDate() + i); return d; });
  const prs = state.sessions
    .filter(s => s.start > Date.now() - 30 * DAY)
    .flatMap(s => (s.prs || []).map(p => ({ ...p, date: s.start, sid: s.id })))
    .sort((a, b) => b.date - a.date);
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const last = sortedSessions()[0];

  return `
    ${state.welcomed ? '' : `<div class="card welcome">
      <h2>Welcome to Setwise 👋</h2>
      <p class="muted small" style="margin:6px 0 12px">A simple workout tracker. Build workouts and programs, log your sets, and watch your progress. No account: everything stays on this device.</p>
      <div class="row between"><b>Weights in</b>
        <div class="seg">${['kg', 'lb'].map(u => `<button class="${unit() === u ? 'on' : ''}" data-act="welcome-unit" data-u="${u}">${u}</button>`).join('')}</div></div>
      <p class="muted small" style="margin:12px 0">Tip: on your phone, use <b>Share → Add to Home Screen</b> to install it like an app.</p>
      <button class="btn primary block" data-act="welcome-done">Get started</button>
    </div>`}
    <div class="muted small">${fmtDate(now, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    <h1>${greeting}</h1>

    <div class="stats" style="margin-top:16px">
      <div class="stat"><b>${week.length}</b><span>workouts this week</span></div>
      <div class="stat"><b>${compact(week.reduce((a, s) => a + sessionVolume(s), 0))}</b><span>${unit()} lifted this week</span></div>
      <div class="stat"><b>${weekStreak()}</b><span>week streak</span></div>
    </div>

    <div class="week">
      ${days.map(d => `<div class="${trained.has(dayKey(d)) ? 'on' : ''} ${dayKey(d) === dayKey(now) ? 'today' : ''}">
        ${d.toLocaleDateString(undefined, { weekday: 'narrow' })}<i>${d.getDate()}</i></div>`).join('')}
    </div>

    ${programTodayCard()}

    <div class="section">
      <div class="section-head"><h2>${activeProgram() ? 'Or start any workout' : 'Start a workout'}</h2><a href="#/workouts">Manage</a></div>
      ${state.templates.map(templateCard).join('') || `<div class="empty">No saved workouts yet. <a href="#/workouts/new" style="color:var(--accent)">Create one</a>.</div>`}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" data-act="start" data-id="">+ Empty workout</button>
        <button class="btn" data-act="cardio-start">♥ Log cardio</button>
      </div>
    </div>

    ${prs.length ? `<div class="section">
      <div class="section-head"><h2>Recent PRs</h2></div>
      <div class="card">${prs.slice(0, 6).map(p => `<a class="ex-row" href="#/progress/${encodeURIComponent(p.exerciseId)}">
        <div class="grow"><b>${esc(exById(p.exerciseId).name)}</b><div class="muted small">${fmtDate(p.date)}</div></div>
        <span class="badge pr">🏆 ${prLabel(p)}</span></a>`).join('')}</div>
    </div>` : ''}

    ${last ? `<div class="section"><div class="section-head"><h2>Last workout</h2><a href="#/history">All history</a></div>${sessionCard(last)}</div>` : ''}
  `;
}

function templateCard(t) {
  const names = t.items.map(i => exById(i.exerciseId).name);
  const sets = t.items.reduce((a, i) => a + (+i.sets || 0), 0);
  return `<div class="card tpl">
    <a class="info" href="#/workouts/${t.id}">
      <h3>${esc(t.name || 'Untitled workout')}</h3>
      <p>${plural(t.items.length, 'exercise')} · ${plural(sets, 'set')} — ${esc(names.join(', ') || 'No exercises')}</p>
    </a>
    <button class="btn primary small" data-act="start" data-id="${t.id}" ${t.items.length ? '' : 'disabled'}>Start</button>
  </div>`;
}

function viewWorkouts() {
  return `
    <div class="page-head"><h1>Workouts</h1></div>
    <div class="section-head"><h2>Programs</h2><span class="row" style="gap:14px"><a href="#" data-act="import">Import</a><a href="#/program-edit/new">+ New program</a></span></div>
    ${state.programs.map(programCard).join('') || `<div class="empty">Plan a training block: repeat your weekly workouts for several weeks, with automatic progression and an optional deload week.<br><a class="btn small primary" href="#/program-edit/new" style="margin-top:12px">Create a program</a></div>`}
    <div class="section">
      <div class="section-head"><h2>Workouts</h2><a href="#/workouts/new">+ New workout</a></div>
      ${state.templates.map(templateCard).join('') || `<div class="empty">Build a workout once, then start it in one tap whenever you train.</div>`}
    </div>
    <div class="section">
      <div class="section-head"><h2>Exercise library</h2><a href="#/exercises">Open</a></div>
      <a class="card row between" href="#/exercises"><span>${plural(state.exercises.length, 'exercise')}</span><span class="muted">›</span></a>
    </div>
  `;
}

// Programs ------------------------------------------------
function programStatus(p) {
  const slots = programSlots(p);
  const done = slots.filter(s => slotSession(p, s)).length;
  const week = programWeek(p);
  const label = state.programId === p.id
    ? (done === slots.length && slots.length ? 'Complete' : week < 1 ? `Starts ${fmtDate(parseDay(p.start), { month: 'short', day: 'numeric' })}` : week > p.weeks ? 'Ended' : `Week ${week} of ${p.weeks}`)
    : done === slots.length && slots.length ? 'Complete' : 'Not active';
  return { slots, done, week, label };
}
const progressBar = (done, total) => `<div class="progress" role="progressbar" aria-valuenow="${done}" aria-valuemax="${total}"><div style="width:${total ? (done / total) * 100 : 0}%"></div></div>`;

function programCard(p) {
  const st = programStatus(p);
  const active = state.programId === p.id;
  return `<a class="card program-card" href="#/programs/${p.id}">
    <div class="row between"><h3>${esc(p.name)}</h3><span class="badge ${active ? 'accent' : ''}">${active ? '● ' : ''}${st.label}</span></div>
    <div class="meta"><span>${plural(p.weeks, 'week')}</span><span>${perWeekText(p)} / week</span><span>${st.done}/${st.slots.length} done</span></div>
    ${progressBar(st.done, st.slots.length)}
  </a>`;
}

let pdraft = null;
function newProgramDraft() {
  const schedule = ['', '', '', '', '', '', ''];
  [0, 2, 4].forEach((dow, i) => { if (state.templates[i]) schedule[dow] = state.templates[i].id; });
  return {
    id: uid(), name: '', weeks: 6, start: dayKey(startOfWeek(new Date())), schedule,
    progType: 'weight', progAmount: unit() === 'lb' ? 5 : 2.5, deload: true,
  };
}
function programSummary(d) {
  const weeks = Math.max(1, Math.min(26, parseInt(d.weeks, 10) || 1));
  const n = d.schedule.filter(Boolean).length + cardioOf(d).filter(c => c?.type).length;
  const end = /^\d{4}-\d\d-\d\d$/.test(d.start || '') ? addDays(parseDay(d.start), weeks * 7 - 1) : null;
  return `${plural(n * weeks, 'session')} over ${plural(weeks, 'week')}${end ? ` · ends ${fmtDate(end, { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}`;
}
function viewProgramEditor(id) {
  if (!pdraft || pdraft._for !== id) {
    const p = state.programs.find(p => p.id === id);
    if (id !== 'new' && !p) return `<a class="back" href="#/workouts">‹ Workouts</a><div class="empty">That program doesn't exist anymore.</div>`;
    pdraft = p ? JSON.parse(JSON.stringify(p)) : newProgramDraft();
    if (!Array.isArray(pdraft.cardio)) pdraft.cardio = [null, null, null, null, null, null, null];
    pdraft._for = id;
    pdraft.makeActive = id === 'new' || state.programId === id;
  }
  const d = pdraft;
  const isNew = id === 'new';
  const other = activeProgram() && activeProgram().id !== d.id ? activeProgram() : null;
  return `
    <a class="back" href="${isNew ? '#/workouts' : `#/programs/${d.id}`}">‹ ${isNew ? 'Workouts' : 'Program'}</a>
    <div class="page-head"><h1>${isNew ? 'New program' : 'Edit program'}</h1></div>

    <label class="field"><span>Name</span><input data-bind="pdraft.name" value="${esc(d.name)}" placeholder="e.g. Strength Block 1" autocomplete="off"></label>
    <div class="row" style="align-items:flex-start">
      <label class="field" style="flex:1"><span>Length (weeks)</span><input type="number" min="1" max="26" inputmode="numeric" data-bind="pdraft.weeks" data-num value="${esc(d.weeks)}"></label>
      <label class="field" style="flex:1.4"><span>Start date</span><input type="date" data-bind="pdraft.start" value="${esc(d.start)}"></label>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>Weekly schedule</h2>
      <p class="muted small" style="margin:4px 0 6px">Pick a workout and/or cardio for each day. The same week repeats for the whole program.</p>
      ${DOW.map((day, i) => {
        const c = d.cardio[i];
        return `<div class="pday">
        <b>${DOW_LONG[i]}</b>
        <div class="pday-fields">
          <label><span>Workout</span><select data-psched="${i}" aria-label="${DOW_LONG[i]} workout">
            <option value="">${c?.type ? 'None' : 'Rest'}</option>
            ${state.templates.map(t => `<option value="${t.id}" ${d.schedule[i] === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
            ${d.schedule[i] && !tplById(d.schedule[i]) ? `<option value="${esc(d.schedule[i])}" selected>Deleted workout</option>` : ''}
          </select></label>
          <label><span>Cardio</span><select data-pcardio="${i}.type" aria-label="${DOW_LONG[i]} cardio">
            <option value="">None</option>
            ${CARDIO_TYPES.map(t => `<option ${c?.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></label>
        </div>
        ${c?.type ? `<div class="pday-fields">
          <label><span>Minutes</span><input inputmode="numeric" data-pcardio="${i}.minutes" value="${esc(c.minutes ?? '')}" placeholder="30"></label>
          <label><span>Intensity</span><select data-pcardio="${i}.intensity">${INTENSITIES.map(t => `<option ${c.intensity === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        </div>` : ''}
      </div>`;
      }).join('')}
      ${state.templates.length ? '' : `<p class="small" style="color:var(--danger)">You need at least one saved workout to schedule lifting. <a href="#/workouts/new" style="text-decoration:underline">Create one</a>.</p>`}
    </div>

    <div class="card">
      <h2>Progression</h2>
      <div class="setting"><div><b>Each week</b><p>Applied to what you lifted last time.</p></div>
        <select data-bind="pdraft.progType" style="width:auto">
          <option value="weight" ${d.progType === 'weight' ? 'selected' : ''}>Add weight</option>
          <option value="reps" ${d.progType === 'reps' ? 'selected' : ''}>Add reps</option>
          <option value="none" ${d.progType === 'none' ? 'selected' : ''}>Keep the same</option>
        </select></div>
      ${d.progType === 'none' ? '' : `<div class="setting"><div><b>Amount</b><p>${d.progType === 'weight' ? `${unit()} added per week` : 'reps added per week'}</p></div>
        <input type="number" min="0" step="${d.progType === 'weight' ? '0.5' : '1'}" inputmode="decimal" data-bind="pdraft.progAmount" data-dec value="${esc(d.progAmount)}"></div>`}
      <div class="setting"><div><b>Deload final week</b><p>~60% of sets at ~90% weight to recover.</p></div>
        <input type="checkbox" class="switch" data-bind="pdraft.deload" ${d.deload ? 'checked' : ''} aria-label="Deload final week"></div>
      <div class="setting"><div><b>Make this my active program</b><p>${other ? `Replaces “${esc(other.name)}” on your Today screen.` : 'Shows today’s workout on your Today screen.'}</p></div>
        <input type="checkbox" class="switch" data-bind="pdraft.makeActive" ${d.makeActive ? 'checked' : ''} aria-label="Make active program"></div>
    </div>

    <p class="muted small" id="prog-summary" style="text-align:center;margin:14px 0 0">${programSummary(d)}</p>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn primary" data-act="prog-save">Save program</button>
    </div>
    ${isNew ? '' : `<button class="btn block ghost danger" data-act="prog-delete">Delete program</button>`}
  `;
}

function viewProgram(id) {
  const p = state.programs.find(p => p.id === id);
  if (!p) return `<a class="back" href="#/workouts">‹ Workouts</a><div class="empty">Program not found.</div>`;
  const st = programStatus(p);
  const active = state.programId === p.id;
  const today = dayKey(Date.now());
  const rows = [];
  for (let w = 1; w <= p.weeks; w++) {
    const slots = st.slots.filter(s => s.week === w);
    rows.push(`<div class="pweek ${active && w === st.week ? 'cur' : ''}">
      <div class="pweek-label"><b>W${w}</b>${isDeloadWeek(p, w) ? '<span>Deload</span>' : ''}</div>
      <div class="pslots">${slots.map(s => {
        const sess = slotSession(p, s);
        const k = dayKey(s.date);
        const cls = (s.kind === 'cardio' ? 'cardio ' : '') + (sess ? 'done' : k === today ? 'today' : dayStart(s.date) < dayStart(Date.now()) ? 'missed' : '');
        const inner = `<span class="d">${DOW[s.dow]} ${s.date.getDate()}</span><span class="t">${sess ? '✓ ' : s.kind === 'cardio' ? '♥ ' : ''}${esc(slotName(s))}</span>`;
        return sess
          ? `<a class="pslot ${cls}" href="#/history/${sess.id}">${inner}</a>`
          : `<button class="pslot ${cls}" data-act="pslot" data-p="${p.id}" data-w="${s.week}" data-d="${s.dow}" data-k="${s.kind}" data-ask="1">${inner}</button>`;
      }).join('')}</div>
    </div>`);
  }
  return `
    <a class="back" href="#/workouts">‹ Workouts</a>
    <div class="row between" style="align-items:flex-start"><h1>${esc(p.name)}</h1><a class="btn small" href="#/program-edit/${p.id}">Edit</a></div>
    <div class="muted" style="margin-top:4px">${fmtDate(parseDay(p.start), { month: 'short', day: 'numeric' })} – ${fmtDate(addDays(parseDay(p.start), p.weeks * 7 - 1), { month: 'short', day: 'numeric', year: 'numeric' })} · ${progDesc(p)}</div>
    <div class="card" style="margin-top:16px">
      <div class="row between"><b>${st.done} of ${st.slots.length} sessions done</b><span class="badge ${active ? 'accent' : ''}">${st.label}</span></div>
      ${progressBar(st.done, st.slots.length)}
    </div>
    <div class="card">${rows.join('')}</div>
    <p class="muted small" style="margin-top:8px">${perWeekText(p)} per week. Tap a day to start it early or make up a missed one.</p>
    <div class="btn-row" style="margin-top:14px">
      ${active ? `<button class="btn" data-act="prog-deactivate" data-id="${p.id}">Stop following</button>` : `<button class="btn primary" data-act="prog-activate" data-id="${p.id}">Make active</button>`}
      <button class="btn" data-act="prog-repeat" data-id="${p.id}">Run again</button>
    </div>
    <button class="btn block ghost" data-act="prog-export" data-id="${p.id}">Share as file</button>
    <p class="muted small" style="text-align:center;margin-top:6px">Saves this program and its workouts (no history) so someone else can import it.</p>
  `;
}

function programTodayCard() {
  const p = activeProgram();
  if (!p) return '';
  const st = programStatus(p);
  const nx = programUpNext(p);
  const slotBtn = (s, primary) => `<button class="btn ${primary ? 'primary' : ''} small" data-act="pslot" data-p="${p.id}" data-w="${s.week}" data-d="${s.dow}" data-k="${s.kind}">Start</button>`;
  const tname = s => (s.kind === 'cardio' ? '♥ ' : '') + esc(slotName(s));
  const slotNote = s => s.kind === 'cardio' ? esc(s.cardio.intensity || 'Cardio') : esc(weekNote(p, s.week) || progDesc(p));
  let body;
  switch (nx.status) {
    case 'today':
      body = nx.slots.map((s, i) => `<div class="tpl"${i ? ' style="margin-top:12px"' : ''}><div class="info"><h3>Today: ${tname(s)}</h3><p>${slotNote(s)}</p></div>${slotBtn(s, i === 0)}</div>`).join('');
      break;
    case 'missed':
      body = `<div class="tpl"><div class="info"><h3>Missed ${DOW_LONG[nx.slot.dow]}: ${tname(nx.slot)}</h3><p>${nx.restDay ? 'Rest day today — or catch up now.' : 'Catch up when you can.'}</p></div>${slotBtn(nx.slot, true)}</div>`;
      break;
    case 'next':
      body = `<div class="tpl"><div class="info"><h3>${nx.restDay ? 'Rest day 😌' : 'Up next'}</h3><p>${fmtDate(nx.slot.date)} · ${tname(nx.slot)}${nx.slot.week !== st.week ? ` (week ${nx.slot.week})` : ''}</p></div>${slotBtn(nx.slot, false)}</div>`;
      break;
    case 'upcoming':
      body = `<div class="tpl"><div class="info"><h3>Starts ${fmtDate(nx.slot.date, { weekday: 'long', month: 'short', day: 'numeric' })}</h3><p>First up: ${tname(nx.slot)}</p></div>${slotBtn(nx.slot, false)}</div>`;
      break;
    case 'complete':
      body = `<h3>🎉 Program complete!</h3><p class="muted small" style="margin:4px 0 10px">All ${st.slots.length} sessions done. Run it again or plan your next block.</p>
        <div class="btn-row"><button class="btn primary small" data-act="prog-repeat" data-id="${p.id}">Run again</button><button class="btn small" data-act="prog-deactivate" data-id="${p.id}">Finish</button></div>`;
      break;
    case 'ended':
      body = `<h3>Program finished</h3><p class="muted small" style="margin:4px 0 10px">${st.done} of ${st.slots.length} sessions done.</p>
        <div class="btn-row"><button class="btn primary small" data-act="prog-repeat" data-id="${p.id}">Run again</button><button class="btn small" data-act="prog-deactivate" data-id="${p.id}">Finish</button></div>`;
      break;
    default:
      body = `<p class="muted">This program has no training days. <a href="#/program-edit/${p.id}" style="color:var(--accent)">Edit it</a>.</p>`;
  }
  return `<div class="section">
    <div class="section-head"><h2>${esc(p.name)}</h2><a href="#/programs/${p.id}">View plan</a></div>
    <div class="card">
      <div class="row between small"><span class="muted">${st.label}${isDeloadWeek(p, st.week) ? ' · deload' : ''}</span><span class="muted">${st.done}/${st.slots.length}</span></div>
      ${progressBar(st.done, st.slots.length)}
      <div style="margin-top:12px">${body}</div>
    </div>
  </div>`;
}

// Template editor works on a draft copy so Cancel really cancels.
let draft = null;
function viewTemplateEditor(id) {
  if (!draft || draft._for !== id) {
    const t = state.templates.find(t => t.id === id);
    if (id !== 'new' && !t) return `<a class="back" href="#/workouts">‹ Workouts</a><div class="empty">That workout doesn't exist anymore.</div>`;
    draft = t ? JSON.parse(JSON.stringify(t)) : { id: uid(), name: '', items: [] };
    draft._for = id;
  }
  const isNew = id === 'new';
  return `
    <a class="back" href="#/workouts">‹ Workouts</a>
    <div class="page-head"><h1>${isNew ? 'New workout' : 'Edit workout'}</h1></div>
    <label class="field"><span>Name</span><input data-bind="draft.name" value="${esc(draft.name)}" placeholder="e.g. Push Day" autocomplete="off"></label>

    <div class="card" style="margin-top:16px">
      ${grouped(draft.items, (it, i) => `<div class="titem">
        <div class="titem-top">
          <span class="name">${esc(exById(it.exerciseId).name)}</span>
          <button class="icon-btn" data-act="titem-move" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="icon-btn" data-act="titem-move" data-i="${i}" data-d="1" ${i === draft.items.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button class="icon-btn" data-act="titem-remove" data-i="${i}" aria-label="Remove">✕</button>
        </div>
        <div class="tfields">
          <label><span>Sets</span><input inputmode="numeric" data-titem="${i}.sets" value="${esc(it.sets)}"></label>
          <label><span>Reps</span><input data-titem="${i}.reps" value="${esc(it.reps)}" placeholder="8-12"></label>
          <label><span>${unit()}</span><input inputmode="decimal" data-titem="${i}.weight" value="${esc(it.weight ?? '')}" placeholder="—"></label>
          <label><span>RIR</span><input inputmode="numeric" data-titem="${i}.rir" value="${esc(it.rir ?? '')}" placeholder="—"></label>
          ${linksToNext(draft.items, i)
            ? `<div class="rest-note">No rest · superset</div>`
            : `<label class="rest-field"><span>${i > 0 && linksToNext(draft.items, i - 1) ? 'Rest after round' : 'Rest between sets'}</span>
              <select data-titem="${i}.rest">
                <option value="" ${it.rest === '' || it.rest == null ? 'selected' : ''}>Default (${restLabel(state.settings.rest)})</option>
                ${REST_OPTIONS.map(v => `<option value="${v}" ${it.rest !== '' && it.rest != null && +it.rest === v ? 'selected' : ''}>${restLabel(v)}</option>`).join('')}
              </select></label>`}
        </div>
        ${i < draft.items.length - 1 && (draft.items[i + 1].section || '') === (it.section || '')
          ? `<button class="link-btn ${it.link ? 'on' : ''}" data-act="titem-link" data-i="${i}">${it.link ? '⛓ Superset with next · tap to unlink' : '+ Superset with next'}</button>` : ''}
      </div>`, sec => `<input class="sec-input" data-sec="${esc(sec)}" value="${esc(sec)}" aria-label="Section name">`)
        || `<div class="muted" style="text-align:center;padding:18px 0">No exercises yet.</div>`}
      <p class="muted small" style="margin:10px 0 0">Tip: use commas for different values per set, e.g. reps <b>12,12,10,10</b>. Section names are editable.</p>
      <div class="btn-row" style="margin-top:4px">
        <button class="btn ghost" data-act="pick" data-mode="template">+ Add exercise</button>
        <button class="btn ghost" data-act="tpl-section">+ New section</button>
      </div>
      ${draft._section ? `<p class="muted small" style="text-align:center;margin:6px 0 0">New exercises go into “${esc(draft._section)}”.</p>` : ''}
    </div>

    <div class="btn-row" style="margin-top:18px">
      <button class="btn primary" data-act="tpl-save">Save</button>
      ${isNew ? '' : `<button class="btn" data-act="tpl-start">Save & start</button>`}
    </div>
    ${isNew ? '' : `<button class="btn block ghost danger" data-act="tpl-delete">Delete workout</button>`}
  `;
}

function viewLog() {
  const a = state.active;
  if (a.cardio) return viewCardioLog();
  const done = a.entries.reduce((n, en) => n + en.sets.filter(s => s.done).length, 0);
  const total = a.entries.reduce((n, en) => n + en.sets.length, 0);
  return `
    <header class="log-head">
      <div>
        <input class="title-input" data-bind="active.name" value="${esc(a.name)}" aria-label="Workout name" autocomplete="off">
        <div class="muted small"><span data-elapsed="${a.start}">${fmtClock((Date.now() - a.start) / 1000)}</span> · ${done}/${total} sets</div>
      </div>
      <button class="btn primary" data-act="finish">Finish</button>
    </header>
    ${a.program ? `<div class="program-strip"><span class="badge accent">${esc(a.program.name)} · Week ${a.program.week}</span>${a.program.note ? `<span class="muted small">${esc(a.program.note)}</span>` : ''}</div>` : ''}
    ${grouped(a.entries, entryCard) || `<div class="empty">Add your first exercise to get going.</div>`}
    <button class="btn block" data-act="pick" data-mode="log">+ Add exercise</button>
    <label class="field"><span>Notes</span><textarea data-bind="active.notes" rows="3" placeholder="Energy, sleep, how it felt…">${esc(a.notes)}</textarea></label>
    <button class="btn block ghost danger" data-act="discard">Discard workout</button>
  `;
}

function entryCard(en, ei) {
  const ex = exById(en.exerciseId);
  const prev = lastSets(en.exerciseId);
  const n = state.active.entries.length;
  const targetReps = parseInt(en.target, 10);
  const h = en.hint || {};
  return `<section class="card entry">
    <div class="entry-head">
      <a class="entry-name" href="#/progress/${encodeURIComponent(ex.id)}">${esc(ex.name)}</a>
      <button class="icon-btn" data-act="entry-move" data-ei="${ei}" data-d="-1" ${ei === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="icon-btn" data-act="entry-move" data-ei="${ei}" data-d="1" ${ei === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="icon-btn" data-act="entry-remove" data-ei="${ei}" aria-label="Remove exercise">✕</button>
    </div>
    ${(() => {
      const reps = repsSummary(en.sets.map(s => s.tr).filter(Boolean)) || en.target;
      const ws = en.sets.map(s => s.tw).filter(w => w !== '' && w != null);
      const parts = [];
      if (reps) parts.push(`${en.sets.length} × ${esc(reps)} reps`);
      if (en.rir !== '' && en.rir != null) parts.push(`${esc(en.rir)} RIR`);
      if (en.rest !== '' && en.rest != null && !linksToNext(state.active.entries, state.active.entries.indexOf(en))) parts.push(`rest ${restLabel(en.rest)}`);
      if (ws.length && !prev.length) parts.push(`start ${esc(repsSummary(ws.map(fmtW)))} ${unit()}`);
      return parts.length ? `<div class="muted small">Target ${parts.join(' · ')}</div>` : '';
    })()}
    <div class="sets">
      <div class="set-row set-head"><span>Set</span><span>Last time</span><span>${unit()}</span><span>Reps</span><span></span></div>
      ${en.sets.map((s, si) => {
        const p = prev[si] || prev[prev.length - 1];
        const wPh = p ? fmtW(suggestW(p.w, h)) : (s.tw !== '' && s.tw != null ? fmtW(suggestW(+s.tw, h)) : '');
        const rPh = p ? p.r + (h.rAdd || 0) : (parseInt(s.tr, 10) || targetReps || '');
        return `<div class="set-row ${s.done ? 'done' : ''}">
          <span class="set-n">${si + 1}</span>
          <span class="prev">${prev[si] ? `${fmtW(prev[si].w)} × ${prev[si].r}` : '—'}</span>
          <input inputmode="decimal" data-set="${ei}.${si}.w" value="${s.w === '' ? '' : fmtW(s.w)}" placeholder="${wPh}" aria-label="Weight, set ${si + 1}">
          <input inputmode="numeric" data-set="${ei}.${si}.r" value="${s.r}" placeholder="${rPh}" aria-label="Reps, set ${si + 1}">
          <button class="check ${s.done ? 'on' : ''}" data-act="toggle-set" data-ei="${ei}" data-si="${si}" aria-label="Mark set ${si + 1} done" aria-pressed="${s.done}">✓</button>
        </div>`;
      }).join('')}
    </div>
    <div class="entry-foot">
      <button class="btn small ghost" data-act="set-add" data-ei="${ei}">+ Add set</button>
      ${en.sets.length > 1 ? `<button class="btn small ghost" data-act="set-remove" data-ei="${ei}">− Remove set</button>` : ''}
    </div>
  </section>`;
}

// History ------------------------------------------------
const cal = { y: new Date().getFullYear(), m: new Date().getMonth(), day: null };

function viewHistory() {
  const first = new Date(cal.y, cal.m, 1);
  const daysIn = new Date(cal.y, cal.m + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  const byDay = {};
  state.sessions.forEach(s => { (byDay[dayKey(s.start)] ||= []).push(s); });
  const today = dayKey(Date.now());
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(`<button class="out" tabindex="-1" aria-hidden="true"></button>`);
  for (let d = 1; d <= daysIn; d++) {
    const k = dayKey(new Date(cal.y, cal.m, d));
    cells.push(`<button class="${byDay[k] ? 'has' : ''} ${k === today ? 'today' : ''} ${k === cal.day ? 'sel' : ''}" data-act="cal-day" data-day="${k}" ${byDay[k] ? '' : 'disabled style="opacity:1;cursor:default"'}>${d}</button>`);
  }
  const monthStart = first.getTime(), monthEnd = new Date(cal.y, cal.m + 1, 1).getTime();
  let list = sortedSessions().filter(s => cal.day ? dayKey(s.start) === cal.day : s.start >= monthStart && s.start < monthEnd);
  const monthCount = state.sessions.filter(s => s.start >= monthStart && s.start < monthEnd).length;

  let lastHead = '';
  const listHtml = list.map(s => {
    const h = fmtDate(s.start, { weekday: 'long', month: 'short', day: 'numeric' });
    const head = h !== lastHead ? `<div class="date-head">${h}</div>` : '';
    lastHead = h;
    return head + sessionCard(s, false);
  }).join('');

  return `
    <div class="page-head"><h1>History</h1><span class="muted small">${plural(state.sessions.length, 'workout')} total</span></div>
    <div class="card">
      <div class="cal-head">
        <button class="icon-btn" data-act="cal-nav" data-d="-1" aria-label="Previous month">‹</button>
        <b>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} <span class="muted small">· ${monthCount}</span></b>
        <button class="icon-btn" data-act="cal-nav" data-d="1" aria-label="Next month">›</button>
      </div>
      <div class="cal">
        ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<span class="dow">${d}</span>`).join('')}
        ${cells.join('')}
      </div>
    </div>
    ${cal.day ? `<button class="btn small ghost" style="margin-top:10px" data-act="cal-clear">Show whole month</button>` : ''}
    ${listHtml || `<div class="empty" style="margin-top:16px">${state.sessions.length ? 'No workouts in this period.' : 'Finished workouts will show up here.'}</div>`}
  `;
}

function cardioMeta(c) {
  return [`${c.minutes} min`, c.distance ? `${fmtW(c.distance)} ${c.distUnit || distUnit()}` : '', c.intensity].filter(Boolean);
}
function sessionCard(s, showDate = true) {
  if (s.cardio) {
    return `<a class="card session-card" href="#/history/${s.id}">
      <h3><span class="badge cardio-badge">♥ Cardio</span> ${esc(s.name)}</h3>
      <div class="meta">${showDate ? `<span>${fmtDate(s.start)}</span>` : `<span>${fmtTime(s.start)}</span>`}${cardioMeta(s.cardio).map(x => `<span>${esc(x)}</span>`).join('')}</div>
    </a>`;
  }
  const names = [...new Set(s.entries.map(e => exById(e.exerciseId).name))];
  return `<a class="card session-card" href="#/history/${s.id}">
    <h3>${esc(s.name)} ${prCount(s) ? `<span class="badge pr">🏆 ${prCount(s)}</span>` : ''}</h3>
    <div class="meta">
      ${showDate ? `<span>${fmtDate(s.start)}</span>` : `<span>${fmtTime(s.start)}</span>`}
      <span>${fmtDuration(s.end - s.start)}</span>
      <span>${plural(sessionSetCount(s), 'set')}</span>
      <span>${compact(sessionVolume(s))} ${unit()}</span>
    </div>
    <p class="ex-list">${esc(names.join(' · '))}</p>
  </a>`;
}

function viewSession(id) {
  const s = state.sessions.find(s => s.id === id);
  if (!s) return `<a class="back" href="#/history">‹ History</a><div class="empty">Workout not found.</div>`;
  const prSet = new Set((s.prs || []).map(p => p.exerciseId));
  if (s.cardio) {
    const c = s.cardio;
    const pace = c.distance && c.minutes ? c.minutes / c.distance : 0;
    return `
    <a class="back" href="#/history">‹ History</a>
    <h1>${esc(s.name)}</h1>
    <div class="muted" style="margin-top:4px">${fmtDate(s.start, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${fmtTime(s.start)}</div>
    ${s.program ? `<a class="badge accent" style="margin-top:8px" href="#/programs/${s.program.id}">${esc(s.program.name)} · Week ${s.program.week}</a>` : ''}
    <div class="stats" style="margin-top:16px">
      <div class="stat"><b>${c.minutes}</b><span>minutes</span></div>
      <div class="stat"><b>${c.distance ? fmtW(c.distance) : '—'}</b><span>${c.distUnit || distUnit()}</span></div>
      <div class="stat"><b>${pace ? `${Math.floor(pace)}:${String(Math.round((pace % 1) * 60)).padStart(2, '0')}` : '—'}</b><span>pace / ${c.distUnit || distUnit()}</span></div>
    </div>
    <div class="card" style="margin-top:10px"><div class="row between"><span class="muted">Activity</span><b>${esc(c.type)}</b></div>
      <div class="row between" style="margin-top:8px"><span class="muted">Intensity</span><b>${esc(c.intensity || '—')}</b></div></div>
    ${s.notes ? `<div class="card" style="margin-top:10px"><div class="muted small" style="margin-bottom:4px">Notes</div>${esc(s.notes).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="btn-row" style="margin-top:18px"><button class="btn primary" data-act="session-repeat" data-id="${s.id}">Do it again</button></div>
    <button class="btn block ghost danger" data-act="session-delete" data-id="${s.id}">Delete from history</button>`;
  }
  return `
    <a class="back" href="#/history">‹ History</a>
    <h1>${esc(s.name)}</h1>
    <div class="muted" style="margin-top:4px">${fmtDate(s.start, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · ${fmtTime(s.start)}</div>
    ${s.program ? `<a class="badge accent" style="margin-top:8px" href="#/programs/${s.program.id}">${esc(s.program.name)} · Week ${s.program.week}</a>` : ''}
    <div class="stats" style="margin-top:16px">
      <div class="stat"><b>${fmtDuration(s.end - s.start)}</b><span>duration</span></div>
      <div class="stat"><b>${compact(sessionVolume(s))}</b><span>${unit()} volume</span></div>
      <div class="stat pr"><b>${prCount(s)}</b><span>${prCount(s) === 1 ? 'exercise' : 'exercises'} with a PR</span></div>
    </div>
    ${(s.prs || []).length ? `<div class="row" style="flex-wrap:wrap;gap:6px;margin-top:12px">${s.prs.map(p => `<span class="badge pr">🏆 ${esc(exById(p.exerciseId).name)} — ${prLabel(p)}</span>`).join('')}</div>` : ''}
    <div class="card" style="margin-top:16px">
      ${grouped(s.entries, en => `<div class="detail-ex">
        <div class="row between"><a href="#/progress/${encodeURIComponent(en.exerciseId)}"><b>${esc(exById(en.exerciseId).name)}</b></a>${prSet.has(en.exerciseId) ? '<span class="badge pr">PR</span>' : ''}</div>
        <div class="detail-sets">${en.sets.map((x, i) => `<span class="n">${i + 1}</span><span>${x.w ? `${fmtW(x.w)} ${unit()} × ${x.r}` : `${x.r} reps`}</span><span class="e">${x.w && x.r ? `≈${fmtW(e1rm(x.w, x.r))} 1RM` : ''}</span>`).join('')}</div>
      </div>`)}
    </div>
    ${s.notes ? `<div class="card" style="margin-top:10px"><div class="muted small" style="margin-bottom:4px">Notes</div>${esc(s.notes).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="btn-row" style="margin-top:18px">
      <button class="btn primary" data-act="session-repeat" data-id="${s.id}">Repeat workout</button>
      <button class="btn" data-act="session-template" data-id="${s.id}">Save as workout</button>
    </div>
    <button class="btn block ghost danger" data-act="session-delete" data-id="${s.id}">Delete from history</button>
  `;
}

// Progress -----------------------------------------------
function viewProgress() {
  const wk = startOfWeek(new Date());
  const bars = [];
  for (let i = 7; i >= 0; i--) {
    const a = new Date(wk); a.setDate(a.getDate() - i * 7);
    const b = new Date(a); b.setDate(b.getDate() + 7);
    const ss = state.sessions.filter(s => s.start >= a.getTime() && s.start < b.getTime());
    bars.push({ label: fmtDate(a, { month: 'numeric', day: 'numeric' }), v: ss.reduce((t, s) => t + sessionVolume(s), 0), cur: i === 0 });
  }

  const since = Date.now() - 30 * DAY;
  const muscleSets = {};
  state.sessions.filter(s => s.start >= since).forEach(s => s.entries.forEach(en => {
    const m = exById(en.exerciseId).muscle;
    muscleSets[m] = (muscleSets[m] || 0) + en.sets.length;
  }));
  const muscles = Object.entries(muscleSets).sort((a, b) => b[1] - a[1]);
  const mMax = Math.max(1, ...muscles.map(m => m[1]));

  const exIds = [...new Set(sortedSessions().flatMap(s => s.entries.map(e => e.exerciseId)))];
  const rows = exIds.map(id => {
    const h = exerciseHistory(id);
    const best = bestOf(h.flatMap(x => x.sets));
    return { id, ex: exById(id), count: h.length, best, last: h[h.length - 1].s.start };
  });

  if (!state.sessions.length) {
    return `<div class="page-head"><h1>Progress</h1></div>
      <div class="empty">Finish a workout and your volume, muscle split and strength trends will appear here.<br><br>
      Want to look around first? <button class="btn small" data-act="sample-add" style="margin-top:8px">Load sample data</button></div>`;
  }

  return `
    <div class="page-head"><h1>Progress</h1></div>
    <div class="card">
      <div class="section-head"><h2>Weekly volume</h2><span class="muted small">${unit()} · last 8 weeks</span></div>
      ${barChart(bars)}
    </div>
    <div class="card">
      <div class="section-head"><h2>Sets by muscle</h2><span class="muted small">last 30 days</span></div>
      ${muscles.map(([m, n]) => `<div class="hbar"><span>${esc(m)}</span><div class="track"><div class="fill" style="width:${(n / mMax) * 100}%"></div></div><b>${n}</b></div>`).join('') || `<div class="muted small">No workouts in the last 30 days.</div>`}
    </div>
    <div class="section">
      <div class="section-head"><h2>Exercises</h2><span class="muted small">best est. 1RM</span></div>
      <div class="card" style="padding-top:2px;padding-bottom:2px">
        ${rows.map(r => `<a class="ex-row" href="#/progress/${encodeURIComponent(r.id)}">
          <div class="grow"><b>${esc(r.ex.name)}</b><div class="muted small">${plural(r.count, 'session')} · last ${fmtDate(r.last, { month: 'short', day: 'numeric' })}</div></div>
          <span class="big">${r.best.weight ? `${fmtW(r.best.e1rm)} ${unit()}` : `${r.best.reps} reps`}</span><span class="muted">›</span>
        </a>`).join('')}
      </div>
    </div>
  `;
}

let progMetric = 'e1rm';
function viewExerciseProgress(id) {
  const ex = exById(id);
  const h = exerciseHistory(id);
  const all = h.flatMap(x => x.sets);
  const best = bestOf(all);
  const bodyweight = best.weight === 0;
  const metric = bodyweight ? 'reps' : progMetric;
  const metrics = { e1rm: 'Est. 1RM', weight: 'Top weight', volume: 'Volume', reps: 'Most reps' };
  const pts = h.map(x => ({ x: x.s.start, y: bestOf(x.sets)[metric] }));
  const bestVol = Math.max(0, ...h.map(x => bestOf(x.sets).volume));
  const u = unit();

  return `
    <a class="back" href="#/progress">‹ Progress</a>
    <h1>${esc(ex.name)}</h1>
    <div class="muted" style="margin-top:4px">${esc(ex.muscle)} · ${esc(ex.equipment)}</div>
    ${!h.length ? `<div class="empty" style="margin-top:16px">You haven't logged ${esc(ex.name)} yet.</div>` : `
    <div class="card" style="margin-top:16px">
      ${bodyweight ? `<div class="section-head"><h2>Most reps per session</h2></div>` : `<div class="seg" role="tablist">${['e1rm', 'weight', 'volume'].map(m => `<button class="${m === metric ? 'on' : ''}" data-act="metric" data-m="${m}">${metrics[m]}</button>`).join('')}</div>`}
      <div style="margin-top:10px">${lineChart(pts, metric === 'reps' ? ' reps' : ' ' + u)}</div>
    </div>
    <div class="pr-grid" style="margin-top:10px">
      ${bodyweight ? `
        <div class="stat pr"><b>${best.reps}</b><span>most reps in a set</span></div>
        <div class="stat"><b>${all.reduce((a, s) => a + s.r, 0)}</b><span>total reps logged</span></div>` : `
        <div class="stat pr"><b>${fmtW(best.e1rm)}</b><span>best est. 1RM (${u})</span></div>
        <div class="stat pr"><b>${fmtW(best.weight)}</b><span>heaviest set (${u})</span></div>
        <div class="stat"><b>${compact(bestVol)}</b><span>best session volume (${u})</span></div>
        <div class="stat"><b>${h.length}</b><span>sessions logged</span></div>`}
    </div>
    <div class="section">
      <div class="section-head"><h2>History</h2></div>
      ${[...h].reverse().map(x => `<a class="card" href="#/history/${x.s.id}">
        <div class="row between"><b>${fmtDate(x.s.start)}</b><span class="muted small">${esc(x.s.name)}</span></div>
        <div class="muted small" style="margin-top:4px">${x.sets.map(s => s.w ? `${fmtW(s.w)}×${s.r}` : `${s.r} reps`).join(' · ')}</div>
      </a>`).join('')}
    </div>`}
  `;
}

// Exercise library ---------------------------------------
let libQuery = '';
function viewExercises() {
  return `
    <a class="back" href="#/workouts">‹ Workouts</a>
    <div class="page-head"><h1>Exercises</h1></div>
    <div class="card">
      <h2>Add a custom exercise</h2>
      <label class="field"><span>Name</span><input id="new-ex-name" placeholder="e.g. Landmine Press" autocomplete="off"></label>
      <div class="row" style="margin-top:10px">
        <select id="new-ex-muscle" aria-label="Muscle group">${MUSCLES.map(m => `<option>${m}</option>`).join('')}</select>
        <select id="new-ex-equip" aria-label="Equipment">${EQUIPMENT.map(m => `<option>${m}</option>`).join('')}</select>
      </div>
      <button class="btn primary block" data-act="ex-create">Add exercise</button>
    </div>
    <input type="search" id="lib-q" placeholder="Search ${state.exercises.length} exercises" value="${esc(libQuery)}" style="margin-top:16px" autocomplete="off">
    <div id="lib-list">${libraryList()}</div>
  `;
}
function libraryList() {
  const q = libQuery.trim().toLowerCase();
  const used = new Set(state.sessions.flatMap(s => s.entries.map(e => e.exerciseId)));
  const list = state.exercises.filter(e => !q || e.name.toLowerCase().includes(q) || e.muscle.toLowerCase().includes(q));
  return MUSCLES.map(m => {
    const items = list.filter(e => e.muscle === m).sort((a, b) => a.name.localeCompare(b.name));
    if (!items.length) return '';
    return `<div class="date-head">${m}</div><div class="card" style="padding-top:2px;padding-bottom:2px">${items.map(e => `<div class="ex-row">
      <a class="grow" href="#/progress/${encodeURIComponent(e.id)}"><b>${esc(e.name)}</b><div class="muted small">${esc(e.equipment)}${e.custom ? ' · custom' : ''}</div></a>
      ${e.custom && !used.has(e.id) ? `<button class="icon-btn" data-act="ex-delete" data-id="${esc(e.id)}" aria-label="Delete ${esc(e.name)}">✕</button>` : ''}
    </div>`).join('')}</div>`;
  }).join('') || `<div class="empty" style="margin-top:12px">No matches.</div>`;
}

// Settings -----------------------------------------------
function viewSettings() {
  const s = state.settings;
  const hasSample = state.sessions.some(x => x.sample);
  return `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="card">
      <div class="setting"><div><b>Weight unit</b><p>Labels only — existing numbers aren't converted.</p></div>
        <select data-bind="settings.unit"><option value="kg" ${s.unit === 'kg' ? 'selected' : ''}>kg</option><option value="lb" ${s.unit === 'lb' ? 'selected' : ''}>lb</option></select></div>
      <div class="setting"><div><b>Default rest timer</b><p>Seconds between sets, unless a workout sets its own rest per exercise.</p></div>
        <input type="number" min="0" step="15" inputmode="numeric" data-bind="settings.rest" data-num value="${s.rest}"></div>
      <div class="setting"><div><b>Auto-start rest timer</b><p>When you tick off a set.</p></div>
        <input type="checkbox" class="switch" data-bind="settings.autoRest" ${s.autoRest ? 'checked' : ''} aria-label="Auto-start rest timer"></div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Your data</h2></div>
      <div class="card">
        <p class="muted small" style="margin-top:0">Everything is stored in this browser on this device — there's no account and nothing is sent anywhere. Export a backup regularly, or to move to another device. Import accepts a backup or a shared program file.</p>
        <div class="btn-row">
          <button class="btn" data-act="export">Export backup</button>
          <button class="btn" data-act="import">Import file</button>
        </div>
        <div class="btn-row" style="margin-top:10px">
          ${hasSample ? `<button class="btn" data-act="sample-remove">Remove sample data</button>` : `<button class="btn" data-act="sample-add">Load sample data</button>`}
        </div>
        <button class="btn block ghost danger" data-act="reset">Erase all data</button>
      </div>
    </div>
    <p class="muted small" style="text-align:center;margin-top:24px">Setwise · ${plural(state.sessions.length, 'workout')} logged</p>
  `;
}

// ---------- Exercise picker ----------
const picker = { mode: 'log', q: '', muscle: '' };
function openPicker(mode) {
  Object.assign(picker, { mode, q: '', muscle: '' });
  openModal(`<div class="sheet" role="dialog" aria-modal="true" aria-label="Add exercise">
    <div class="sheet-head"><h2>Add exercise</h2><button class="icon-btn" data-act="close-modal" aria-label="Close">✕</button></div>
    <input id="picker-q" type="search" placeholder="Search or type a new name" autocomplete="off">
    <div class="chips">${['', ...MUSCLES].map(m => `<button class="chip ${m === '' ? 'on' : ''}" data-act="picker-muscle" data-m="${m}">${m || 'All'}</button>`).join('')}</div>
    <div id="picker-list">${pickerList()}</div>
  </div>`);
  // Don't pop the keyboard on phones; do focus on desktop.
  if (matchMedia('(pointer: fine)').matches) $('#picker-q').focus();
}
function pickerList() {
  const q = picker.q.trim().toLowerCase();
  const list = state.exercises
    .filter(e => (!picker.muscle || e.muscle === picker.muscle) && (!q || e.name.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const exact = state.exercises.some(e => e.name.toLowerCase() === q);
  return list.map(e => `<button class="pick-row" data-act="pick-ex" data-id="${esc(e.id)}"><b>${esc(e.name)}</b><span class="muted small">${esc(e.muscle)} · ${esc(e.equipment)}</span></button>`).join('')
    + (q && !exact ? `<button class="pick-row create" data-act="pick-create">+ Create “${esc(picker.q.trim())}”${picker.muscle ? ` in ${esc(picker.muscle)}` : ''}</button>` : '')
    || `<div class="muted" style="padding:20px 0;text-align:center">No exercises.</div>`;
}
function addExerciseTo(id) {
  if (picker.mode === 'log' && state.active) {
    const prev = lastSets(id);
    const lastEn = state.active.entries[state.active.entries.length - 1];
    state.active.entries.push(newEntry(id, Math.max(prev.length, 3), '', { section: lastEn?.section || '' }));
    save();
  } else if (picker.mode === 'template' && draft) {
    const lastIt = draft.items[draft.items.length - 1];
    draft.items.push({ exerciseId: id, sets: 3, reps: '10', section: draft._section ?? lastIt?.section ?? '' });
  }
  closeModal();
  render();
  if (picker.mode === 'log') requestAnimationFrame(() => $$('.entry').pop()?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
function createExercise(name, muscle, equipment) {
  name = name.trim().replace(/\s+/g, ' ');
  if (!name) return null;
  if (name === name.toLowerCase()) name = name.replace(/\b[a-z]/g, c => c.toUpperCase());
  const existing = state.exercises.find(e => e.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  let id = slug(name) || uid();
  if (state.exercises.some(e => e.id === id)) id += '-' + uid().slice(-4);
  const ex = { id, name, muscle: muscle || 'Other', equipment: equipment || 'Other', custom: true };
  state.exercises.push(ex);
  save();
  return ex;
}

// ---------- Workout lifecycle ----------
function newEntry(exerciseId, sets = 3, target = '', extra = {}) {
  const t = extra.targets || [];
  return {
    id: uid(), exerciseId, target: String(target ?? ''),
    section: extra.section || '', link: !!extra.link, rir: extra.rir ?? '', rest: extra.rest ?? '',
    sets: Array.from({ length: +sets || 1 }, (_, i) => ({ w: '', r: '', done: false, tr: t[i]?.tr ?? '', tw: t[i]?.tw ?? '' })),
  };
}
function beginWorkout(name, templateId, entries, program = null, cardio = null) {
  if (state.active && !confirm('A workout is already in progress. Discard it and start this one?')) return;
  state.active = { id: uid(), name, templateId, program, start: Date.now(), notes: '', restEnd: null, restTotal: 0, entries, ...(cardio ? { cardio } : {}) };
  save();
  location.hash = '#/log';
}
/** Start a cardio session. c = { type, minutes?, intensity? } (a program's plan, or a blank one). */
function startCardio(c = {}, program = null) {
  const type = c.type || 'Run';
  beginWorkout(type, null, [], program, {
    type, intensity: c.intensity || INTENSITIES[0], minutes: '', distance: '',
    target: { minutes: c.minutes || '', intensity: c.intensity || '' },
  });
}
function finishCardio() {
  const a = state.active, c = a.cardio;
  const elapsedMin = Math.max(1, Math.round((Date.now() - a.start) / 60000));
  const minutes = parseInt(c.minutes, 10) || elapsedMin;
  const distance = parseFloat(String(c.distance).replace(',', '.')) || 0;
  const session = {
    id: a.id,
    name: a.name.trim() || c.type,
    kind: 'cardio',
    templateId: null,
    ...(a.program ? { program: { id: a.program.id, name: a.program.name, week: a.program.week, dow: a.program.dow, kind: 'cardio' } } : {}),
    start: a.start,
    end: Date.now(),
    notes: a.notes.trim(),
    cardio: { type: c.type, minutes, ...(distance ? { distance, distUnit: distUnit() } : {}), intensity: c.intensity },
    entries: [],
    prs: [],
  };
  state.sessions.push(session);
  state.active = null;
  save();
  location.hash = '#/history/' + session.id;
  toast(`${c.type} logged — ${minutes} min. Nice work!`);
}
function viewCardioLog() {
  const a = state.active, c = a.cardio, tg = c.target || {};
  const goal = [tg.minutes && `${tg.minutes} min`, tg.intensity].filter(Boolean).join(' · ');
  return `
    <header class="log-head">
      <div>
        <input class="title-input" data-bind="active.name" value="${esc(a.name)}" aria-label="Session name" autocomplete="off">
        <div class="muted small">Cardio${goal ? ` · goal ${esc(goal)}` : ''}</div>
      </div>
      <button class="btn primary" data-act="finish">Finish</button>
    </header>
    ${a.program ? `<div class="program-strip"><span class="badge accent">${esc(a.program.name)} · Week ${a.program.week}</span></div>` : ''}
    <div class="card cardio-clock">
      <div class="big-clock" data-elapsed="${a.start}">${fmtClock((Date.now() - a.start) / 1000)}</div>
      <div class="muted small">${tg.minutes ? `Target ${tg.minutes}:00` : 'Elapsed time'}</div>
    </div>
    <div class="card">
      <div class="pday-fields">
        <label><span>Activity</span><select data-cardio="type">${CARDIO_TYPES.map(t => `<option ${c.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label><span>Intensity</span><select data-cardio="intensity">${INTENSITIES.map(t => `<option ${c.intensity === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label><span>Minutes</span><input inputmode="numeric" data-cardio="minutes" value="${esc(c.minutes)}" placeholder="Uses timer"></label>
        <label><span>Distance (${distUnit()})</span><input inputmode="decimal" data-cardio="distance" value="${esc(c.distance)}" placeholder="Optional"></label>
      </div>
      <p class="muted small" style="margin:10px 0 0">Leave minutes empty to use the timer. Logging afterwards? Just type the minutes.</p>
    </div>
    <label class="field"><span>Notes</span><textarea data-bind="active.notes" rows="3" placeholder="Route, heart rate, how it felt…">${esc(a.notes)}</textarea></label>
    <button class="btn block ghost danger" data-act="discard">Discard session</button>
  `;
}
function startTemplate(tid) {
  const t = state.templates.find(t => t.id === tid);
  if (!t) return beginWorkout('Workout', null, []);
  beginWorkout(t.name || 'Workout', t.id, t.items.map(it => newEntry(it.exerciseId, it.sets, it.reps, itemExtra(it, +it.sets || 1))));
}
function finishWorkout() {
  const a = state.active;
  if (a.cardio) return finishCardio();
  const kept = a.entries.map(en => ({ exerciseId: en.exerciseId, section: en.section || '', link: !!en.link, sets: en.sets.filter(s => s.done) })).filter(en => en.sets.length);
  if (!kept.length) {
    if (confirm('No sets are ticked off yet. Discard this workout instead?')) { state.active = null; save(); location.hash = '#/today'; }
    return;
  }
  const undone = a.entries.reduce((n, en) => n + en.sets.filter(s => !s.done).length, 0);
  if (undone && !confirm(`${plural(undone, 'unticked set')} will be left out. Finish workout?`)) return;
  const session = {
    id: a.id,
    name: a.name.trim() || 'Workout',
    templateId: a.templateId,
    ...(a.program ? { program: { id: a.program.id, name: a.program.name, week: a.program.week, dow: a.program.dow } } : {}),
    start: a.start,
    end: Date.now(),
    notes: a.notes.trim(),
    entries: kept.map(en => ({ exerciseId: en.exerciseId, ...(en.section ? { section: en.section } : {}), ...(en.link ? { link: true } : {}), sets: en.sets.map(s => ({ w: +s.w || 0, r: +s.r || 0 })) })),
  };
  session.prs = computePRs(session);
  state.sessions.push(session);
  state.active = null;
  save();
  location.hash = '#/history/' + session.id;
  toast(prCount(session) ? `Workout saved — PRs on ${plural(prCount(session), 'exercise')}! 🏆` : 'Workout saved. Nice work!');
}

// ---------- Rest timer ----------
function startRest(sec) {
  if (!state.active || !sec) return;
  state.active.restEnd = Date.now() + sec * 1000;
  state.active.restTotal = sec;
  save();
  renderRest();
}
function renderRest() {
  const el = $('#rest');
  const a = state.active;
  if (!a || !a.restEnd) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  if (!el.firstChild) {
    el.innerHTML = `<div class="rest-bar"><div class="rest-fill"></div><span class="rest-label">Rest</span><span class="rest-time"></span>
      <button data-act="rest-adj" data-d="-15" aria-label="Subtract 15 seconds">−15</button>
      <button data-act="rest-adj" data-d="15" aria-label="Add 15 seconds">+15</button>
      <button data-act="rest-skip">Skip</button></div>`;
  }
  updateRest();
}
function updateRest() {
  const a = state.active;
  if (!a || !a.restEnd) return;
  const left = (a.restEnd - Date.now()) / 1000;
  if (left <= 0) {
    a.restEnd = null;
    save();
    renderRest();
    navigator.vibrate?.([200, 100, 200]);
    beep();
    toast('Rest over — next set!');
    return;
  }
  const t = $('#rest .rest-time'), f = $('#rest .rest-fill');
  if (t) t.textContent = fmtClock(Math.ceil(left));
  if (f) f.style.width = `${Math.min(100, (1 - left / (a.restTotal || 1)) * 100)}%`;
}
let audioCtx;
function beep() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.25);
  } catch (e) { /* audio not available */ }
}

// ---------- Sample data ----------
function addSampleData() {
  const lb = unit() === 'lb';
  const plan = [
    { name: 'Lower Body', ex: [['barbell-back-squat', 70, 5, 4, 2.5], ['romanian-deadlift', 60, 8, 3, 2.5], ['leg-press', 120, 10, 3, 5], ['standing-calf-raise', 50, 15, 3, 2.5]] },
    { name: 'Upper Body', ex: [['bench-press', 55, 5, 4, 1.25], ['barbell-row', 50, 8, 4, 1.25], ['overhead-press', 35, 8, 3, 0.6], ['lat-pulldown', 50, 10, 3, 1.25], ['dumbbell-curl', 12, 12, 2, 0.3]] },
    { name: 'Full Body', ex: [['deadlift', 90, 5, 3, 2.5], ['incline-dumbbell-press', 20, 10, 3, 0.5], ['pull-up', 0, 6, 3, 0], ['hanging-leg-raise', 0, 10, 3, 0]] },
  ];
  const wk = startOfWeek(new Date());
  const made = [];
  for (let w = 7; w >= 0; w--) {
    [0, 2, 4].forEach((dayOff, k) => {
      const d = new Date(wk);
      d.setDate(d.getDate() - w * 7 + dayOff);
      d.setHours(18, Math.floor(Math.random() * 40), 0, 0);
      if (d.getTime() > Date.now() - 3600e3) return;
      if (Math.random() < 0.12) return; // the occasional missed day
      const p = plan[k];
      const prog = 7 - w;
      const entries = p.ex.map(([id, base, reps, sets, inc]) => {
        let wt = base + inc * prog + (Math.random() < 0.3 ? -inc : 0);
        if (lb) wt = Math.round(wt * 2.2 / 5) * 5;
        else wt = Math.round(wt * 2) / 2;
        return {
          exerciseId: id,
          sets: Array.from({ length: sets }, (_, i) => ({
            w: base ? wt : 0,
            r: base ? Math.max(1, reps - (i === sets - 1 && Math.random() < 0.4 ? 1 : 0)) : reps + Math.floor(prog / 2) - (i > 1 ? 1 : 0),
          })),
        };
      });
      made.push({ id: uid(), name: p.name, templateId: null, start: d.getTime(), end: d.getTime() + (48 + Math.random() * 25) * 60e3, notes: '', entries, sample: true });
    });
  }
  state.sessions.push(...made);
  state.sessions.sort((a, b) => a.start - b.start);
  made.forEach(s => { s.prs = computePRs(s); });
  save();
  toast(`Added ${made.length} sample workouts`);
  render();
}

// ---------- Actions (event delegation) ----------
const actions = {
  start: el => startTemplate(el.dataset.id),
  'cardio-start': () => startCardio(),
  pick: el => openPicker(el.dataset.mode),
  'close-modal': closeModal,
  backdrop: (el, e) => { if (e.target === el) closeModal(); },
  'picker-muscle': el => {
    picker.muscle = el.dataset.m;
    $$('.chip').forEach(c => c.classList.toggle('on', c === el));
    $('#picker-list').innerHTML = pickerList();
  },
  'pick-ex': el => addExerciseTo(el.dataset.id),
  'pick-create': () => { const ex = createExercise(picker.q, picker.muscle, 'Other'); if (ex) addExerciseTo(ex.id); },

  // Active workout
  'toggle-set': el => {
    const en = state.active.entries[+el.dataset.ei];
    const s = en.sets[+el.dataset.si];
    if (!s.done) {
      const [wi, ri] = $$('input', el.closest('.set-row'));
      if (s.w === '' && wi.placeholder !== '') s.w = parseFloat(wi.placeholder);
      if (s.r === '' && ri.placeholder !== '') s.r = parseInt(ri.placeholder, 10);
      if (s.r === '' || !(s.r > 0)) { s.r = ''; ri.focus(); toast('Enter your reps first'); return; }
      if (s.w === '' || isNaN(s.w)) s.w = 0;
      s.done = true;
      const ei = +el.dataset.ei;
      if (linksToNext(state.active.entries, ei)) {
        // Superset: go straight to the same set of the next exercise, rest after the round.
        save(); render();
        const next = $(`[data-set="${ei + 1}.${+el.dataset.si}.w"]`) || $(`[data-set="${ei + 1}.0.w"]`);
        next?.closest('.entry')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (state.settings.autoRest) startRest(restFor(en));
      // End of a superset round: jump back to the first exercise for the next set.
      let first = ei;
      while (first > 0 && linksToNext(state.active.entries, first - 1)) first--;
      if (first < ei) {
        save(); render();
        $(`[data-set="${first}.${+el.dataset.si + 1}.w"]`)?.closest('.entry')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    } else {
      s.done = false;
    }
    save();
    render();
  },
  'set-add': el => {
    const en = state.active.entries[+el.dataset.ei];
    const last = en.sets[en.sets.length - 1];
    en.sets.push({ w: last ? last.w : '', r: last ? last.r : '', done: false, tr: last?.tr ?? '', tw: last?.tw ?? '' });
    save(); render();
  },
  'set-remove': el => { state.active.entries[+el.dataset.ei].sets.pop(); save(); render(); },
  'entry-move': el => { move(state.active.entries, +el.dataset.ei, +el.dataset.d); save(); render(); },
  'entry-remove': el => {
    const en = state.active.entries[+el.dataset.ei];
    if (en.sets.some(s => s.done) && !confirm(`Remove ${exById(en.exerciseId).name} and its logged sets?`)) return;
    state.active.entries.splice(+el.dataset.ei, 1); save(); render();
  },
  finish: finishWorkout,
  discard: () => {
    if (!confirm('Discard this workout? Nothing from it will be saved.')) return;
    state.active = null; save(); location.hash = '#/today';
  },
  'rest-adj': el => {
    const a = state.active; if (!a?.restEnd) return;
    a.restEnd = Math.max(Date.now() + 1000, a.restEnd + +el.dataset.d * 1000);
    a.restTotal = Math.max(1, a.restTotal + +el.dataset.d);
    save(); updateRest();
  },
  'rest-skip': () => { if (state.active) { state.active.restEnd = null; save(); renderRest(); } },

  // Programs
  pslot: el => {
    const p = state.programs.find(p => p.id === el.dataset.p);
    const w = +el.dataset.w, d = +el.dataset.d;
    const k = el.dataset.k || 'lift';
    const label = k === 'cardio' ? (cardioOf(p || {})[d] ? cardioLabel(cardioOf(p)[d]) : 'cardio') : (tplById(p?.schedule[d])?.name || 'workout');
    if (el.dataset.ask && !confirm(`Start week ${w}, ${DOW_LONG[d]}: ${label} now?`)) return;
    startProgramSlot(el.dataset.p, w, d, k);
  },
  'prog-save': () => {
    const d = pdraft;
    const name = d.name.trim();
    if (!name) { toast('Give your program a name'); $('[data-bind="pdraft.name"]')?.focus(); return; }
    if (!d.start) { toast('Pick a start date'); return; }
    if (!d.schedule.some(Boolean) && !cardioOf(d).some(c => c?.type)) { toast('Schedule at least one workout or cardio day'); return; }
    const { _for, makeActive, ...p } = d;
    p.name = name;
    p.weeks = Math.max(1, Math.min(26, parseInt(p.weeks, 10) || 1));
    p.progAmount = Math.max(0, parseFloat(p.progAmount) || 0);
    p.cardio = cardioOf(p).map(c => c?.type ? { type: c.type, minutes: parseInt(c.minutes, 10) || '', intensity: c.intensity || INTENSITIES[0] } : null);
    const idx = state.programs.findIndex(x => x.id === p.id);
    if (idx >= 0) state.programs[idx] = p; else state.programs.push(p);
    if (makeActive) state.programId = p.id;
    else if (state.programId === p.id) state.programId = null;
    pdraft = null;
    save();
    toast('Program saved');
    location.hash = '#/programs/' + p.id;
  },
  'prog-delete': () => {
    if (!confirm(`Delete “${pdraft.name || 'this program'}”? Workouts you logged stay in your history.`)) return;
    state.programs = state.programs.filter(p => p.id !== pdraft.id);
    if (state.programId === pdraft.id) state.programId = null;
    pdraft = null; save(); location.hash = '#/workouts';
  },
  'prog-activate': el => { state.programId = el.dataset.id; save(); toast('Now following this program'); render(); },
  'prog-deactivate': el => { if (state.programId === el.dataset.id) state.programId = null; save(); render(); },
  'prog-repeat': el => {
    const src = state.programs.find(p => p.id === el.dataset.id);
    const next = startOfWeek(addDays(new Date(), 7));
    const end = addDays(parseDay(src.start), src.weeks * 7);
    const start = dayStart(end) > dayStart(Date.now()) ? end : next;
    const m = src.name.match(/^(.*?)(\d+)$/);
    const copy = { ...JSON.parse(JSON.stringify(src)), id: uid(), name: m ? m[1] + (+m[2] + 1) : `${src.name} (round 2)`, start: dayKey(start) };
    state.programs.push(copy);
    state.programId = copy.id;
    save();
    toast(`Next round starts ${fmtDate(start, { weekday: 'short', month: 'short', day: 'numeric' })}`);
    location.hash = '#/program-edit/' + copy.id;
  },

  // Template editor
  'titem-move': el => { move(draft.items, +el.dataset.i, +el.dataset.d); render(); },
  'titem-remove': el => { draft.items.splice(+el.dataset.i, 1); render(); },
  'titem-link': el => { const it = draft.items[+el.dataset.i]; it.link = !it.link; render(); },
  'tpl-section': () => {
    const name = prompt('Section name (e.g. Warm Up, Weights, Finisher)');
    if (!name?.trim()) return;
    draft._section = name.trim();
    openPicker('template');
  },
  'tpl-save': () => { if (saveDraft()) location.hash = '#/workouts'; },
  'tpl-start': () => { const id = saveDraft(); if (id) startTemplate(id); },
  'tpl-delete': () => {
    const usedIn = state.programs.filter(p => p.schedule.includes(draft.id)).map(p => p.name);
    if (!confirm(`Delete “${draft.name || 'this workout'}”? Your history is kept.${usedIn.length ? `\n\nIt's scheduled in: ${usedIn.join(', ')}. Those days will need a new workout.` : ''}`)) return;
    state.templates = state.templates.filter(t => t.id !== draft.id);
    draft = null; save(); location.hash = '#/workouts';
  },

  // History
  'cal-nav': el => {
    const d = new Date(cal.y, cal.m + +el.dataset.d, 1);
    cal.y = d.getFullYear(); cal.m = d.getMonth(); cal.day = null; render();
  },
  'cal-day': el => { cal.day = cal.day === el.dataset.day ? null : el.dataset.day; render(); },
  'cal-clear': () => { cal.day = null; render(); },
  'session-repeat': el => {
    const s = state.sessions.find(s => s.id === el.dataset.id);
    if (s.cardio) return startCardio({ type: s.cardio.type, minutes: s.cardio.minutes, intensity: s.cardio.intensity });
    beginWorkout(s.name, s.templateId, s.entries.map(en => newEntry(en.exerciseId, en.sets.length, '', { section: en.section, link: en.link })));
  },
  'session-template': el => {
    const s = state.sessions.find(s => s.id === el.dataset.id);
    const t = { id: uid(), name: s.name, items: s.entries.map(en => ({ exerciseId: en.exerciseId, sets: en.sets.length, reps: repsSummary(en.sets.map(x => String(x.r))) || '10', weight: en.sets.some(x => x.w) ? repsSummary(en.sets.map(x => fmtW(x.w))) : '', section: en.section || '', link: !!en.link })) };
    state.templates.push(t); save();
    toast('Saved to Workouts');
  },
  'session-delete': el => {
    if (!confirm('Delete this workout from your history? This can’t be undone.')) return;
    state.sessions = state.sessions.filter(s => s.id !== el.dataset.id);
    save(); location.hash = '#/history';
  },

  // Progress
  metric: el => { progMetric = el.dataset.m; render(); },

  // Exercise library
  'ex-create': () => {
    const name = $('#new-ex-name').value.trim();
    if (!name) { $('#new-ex-name').focus(); return; }
    if (state.exercises.some(e => e.name.toLowerCase() === name.toLowerCase())) { toast('That exercise already exists'); return; }
    createExercise(name, $('#new-ex-muscle').value, $('#new-ex-equip').value);
    toast(`Added ${name}`);
    render();
  },
  'ex-delete': el => {
    const ex = exById(el.dataset.id);
    if (!confirm(`Delete ${ex.name}?`)) return;
    state.exercises = state.exercises.filter(e => e.id !== ex.id);
    state.templates.forEach(t => { t.items = t.items.filter(i => i.exerciseId !== ex.id); });
    save(); render();
  },

  // Settings / data
  export: () => {
    const blob = new Blob([JSON.stringify({ app: 'setwise', exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `setwise-backup-${dayKey(Date.now())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  import: () => $('#import-file').click(),
  'prog-export': el => {
    const p = state.programs.find(p => p.id === el.dataset.id);
    downloadJSON(programFile(p), `${slug(p.name) || 'program'}.setwise.json`);
  },
  'welcome-unit': el => { state.settings.unit = el.dataset.u; save(); render(); },
  'welcome-done': () => { state.welcomed = true; save(); render(); },
  'sample-add': addSampleData,
  'sample-remove': () => {
    state.sessions = state.sessions.filter(s => !s.sample);
    save(); toast('Sample workouts removed'); render();
  },
  reset: () => {
    if (!confirm('Erase all workouts, templates and settings? Export a backup first if you might want them.')) return;
    if (!confirm('Really erase everything?')) return;
    state = defaultState(); save(); location.hash = '#/today'; render();
  },
};

function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
function saveDraft() {
  const name = draft.name.trim();
  if (!name) { toast('Give your workout a name'); $('[data-bind="draft.name"]')?.focus(); return null; }
  if (!draft.items.length) { toast('Add at least one exercise'); return null; }
  const { _for, _section, ...t } = draft;
  t.name = name;
  t.items = t.items.map(i => ({
    ...i,
    sets: Math.max(1, Math.min(20, parseInt(i.sets, 10) || 1)),
    reps: String(i.reps || '').trim(),
    weight: String(i.weight ?? '').trim(),
    rir: String(i.rir ?? '').trim(),
    rest: i.rest === '' || i.rest == null ? '' : +i.rest,
    section: String(i.section || '').trim(),
    link: !!i.link,
  }));
  const idx = state.templates.findIndex(x => x.id === t.id);
  if (idx >= 0) state.templates[idx] = t; else state.templates.push(t);
  draft = null;
  save();
  toast('Workout saved');
  return t.id;
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.set !== undefined && state.active) {
    const [ei, si, f] = el.dataset.set.split('.');
    const raw = el.value.replace(',', '.').trim();
    const v = raw === '' ? '' : f === 'r' ? parseInt(raw, 10) : parseFloat(raw);
    state.active.entries[+ei].sets[+si][f] = (v === '' || isNaN(v)) ? '' : v;
    saveSoon();
  } else if (el.dataset.pcardio !== undefined && pdraft && el.tagName === 'INPUT') {
    const [i, f] = el.dataset.pcardio.split('.');
    if (pdraft.cardio[+i]) pdraft.cardio[+i][f] = el.value;
  } else if (el.dataset.cardio !== undefined && state.active?.cardio) {
    const a = state.active;
    if (el.dataset.cardio === 'type' && a.name === a.cardio.type) {
      a.name = el.value;
      const t = $('[data-bind="active.name"]'); if (t) t.value = el.value;
    }
    a.cardio[el.dataset.cardio] = el.value;
    saveSoon();
  } else if (el.dataset.sec !== undefined && draft) {
    const from = el.dataset.sec, to = el.value;
    draft.items.forEach(it => { if ((it.section || '') === from) it.section = to; });
    if (draft._section === from) draft._section = to;
    el.dataset.sec = to;
  } else if (el.dataset.titem !== undefined && draft) {
    const [i, f] = el.dataset.titem.split('.');
    draft.items[+i][f] = el.value;
  } else if (el.dataset.bind && el.type !== 'checkbox' && el.tagName !== 'SELECT') {
    bind(el);
    if (pdraft && $('#prog-summary')) $('#prog-summary').innerHTML = programSummary(pdraft);
  } else if (el.id === 'picker-q') {
    picker.q = el.value;
    $('#picker-list').innerHTML = pickerList();
  } else if (el.id === 'lib-q') {
    libQuery = el.value;
    $('#lib-list').innerHTML = libraryList();
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.psched !== undefined && pdraft) { pdraft.schedule[+el.dataset.psched] = el.value; render(); return; }
  if (el.dataset.pcardio !== undefined && pdraft && el.tagName === 'SELECT') {
    const [i, f] = el.dataset.pcardio.split('.');
    if (f === 'type') {
      pdraft.cardio[+i] = el.value ? { minutes: 30, intensity: INTENSITIES[0], ...(pdraft.cardio[+i] || {}), type: el.value } : null;
      render();
    } else if (pdraft.cardio[+i]) pdraft.cardio[+i][f] = el.value;
    $('#prog-summary') && ($('#prog-summary').innerHTML = programSummary(pdraft));
    return;
  }
  if (el.dataset.bind && (el.type === 'checkbox' || el.tagName === 'SELECT')) { bind(el); render(); }
  if (el.id === 'import-file' && el.files[0]) importFile(el.files[0]).finally(() => { el.value = ''; });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#modal').firstChild) closeModal();
  if (e.key === 'Enter' && e.target.id === 'picker-q') {
    const first = $('#picker-list [data-act]');
    first?.click();
  }
  // Enter in a set input jumps to the next input
  if (e.key === 'Enter' && e.target.dataset.set !== undefined) {
    e.preventDefault();
    const inputs = $$('[data-set]');
    inputs[inputs.indexOf(e.target) + 1]?.focus();
  }
});

function bind(el) {
  const [root, key] = el.dataset.bind.split('.');
  const target = { active: state.active, draft, pdraft, settings: state.settings }[root];
  if (!target) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.num !== undefined) v = Math.max(0, parseInt(v, 10) || 0);
  if (el.dataset.dec !== undefined) v = Math.max(0, parseFloat(String(v).replace(',', '.')) || 0);
  target[key] = v;
  if (root === 'active' || root === 'settings') saveSoon();
}

/** A program plus the workouts it schedules, as a shareable file (no history, no personal data). */
function programFile(p) {
  const used = [...new Set(p.schedule.filter(Boolean))].map(tplById).filter(Boolean);
  return {
    app: 'setwise', type: 'program', version: 1, unit: unit(),
    program: { name: p.name, weeks: p.weeks, schedule: p.schedule.map(id => (id && tplById(id) ? id : null)), cardio: cardioOf(p), progType: p.progType, progAmount: p.progAmount, deload: !!p.deload },
    templates: used.map(t => ({
      key: t.id, name: t.name,
      items: t.items.map(it => {
        const ex = exById(it.exerciseId);
        return { exercise: { name: ex.name, muscle: ex.muscle, equipment: ex.equipment }, sets: it.sets, reps: it.reps ?? '', weight: it.weight ?? '', rir: it.rir ?? '', rest: it.rest ?? '', section: it.section || '', link: !!it.link };
      }),
    })),
  };
}
function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const uniqueName = (name, list) => { let n = name, i = 2; while (list.some(x => x.name === n)) n = `${name} (${i++})`; return n; };
/** Add a shared program file to this device without touching existing data. */
function importProgramData(data) {
  if (data.unit && data.unit !== unit() && confirm(`This program's weights are in ${data.unit}. Switch the app to ${data.unit}?\n\n(Labels only — existing numbers aren't converted.)`)) state.settings.unit = data.unit;
  const ids = {};
  for (const t of data.templates) {
    const items = (t.items || []).map(it => {
      const e = it.exercise || {};
      const ex = state.exercises.find(x => x.name.toLowerCase() === String(e.name || '').toLowerCase()) || createExercise(String(e.name || 'Exercise'), MUSCLES.includes(e.muscle) ? e.muscle : 'Other', EQUIPMENT.includes(e.equipment) ? e.equipment : 'Other');
      return { exerciseId: ex.id, sets: Math.max(1, Math.min(20, parseInt(it.sets, 10) || 1)), reps: String(it.reps ?? ''), weight: String(it.weight ?? ''), rir: String(it.rir ?? ''), rest: it.rest === '' || it.rest == null ? '' : +it.rest, section: String(it.section || ''), link: !!it.link };
    });
    const tpl = { id: uid(), name: uniqueName(String(t.name || 'Workout'), state.templates), items };
    state.templates.push(tpl);
    ids[t.key] = tpl.id;
  }
  const p = data.program;
  const cardio = Array.isArray(p.cardio) ? p.cardio.slice(0, 7) : [];
  const prog = {
    id: uid(), name: uniqueName(String(p.name || 'Program'), state.programs),
    weeks: Math.max(1, Math.min(26, parseInt(p.weeks, 10) || 4)),
    start: dayKey(startOfWeek(addDays(new Date(), 7))), // next Monday — change it in Edit
    schedule: Array.from({ length: 7 }, (_, i) => (p.schedule?.[i] && ids[p.schedule[i]]) || ''),
    cardio: Array.from({ length: 7 }, (_, i) => (cardio[i]?.type && CARDIO_TYPES.includes(cardio[i].type) ? { type: cardio[i].type, minutes: parseInt(cardio[i].minutes, 10) || '', intensity: INTENSITIES.includes(cardio[i].intensity) ? cardio[i].intensity : INTENSITIES[0] } : null)),
    progType: ['weight', 'reps', 'none'].includes(p.progType) ? p.progType : 'none',
    progAmount: Math.max(0, parseFloat(p.progAmount) || 0),
    deload: !!p.deload,
  };
  state.programs.push(prog);
  if (!activeProgram()) state.programId = prog.id;
  save();
  return prog;
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.type === 'program' && data.program && Array.isArray(data.templates)) {
      if (!confirm(`Add the program “${data.program.name}” with ${plural(data.templates.length, 'workout')}? Your existing data stays as it is.`)) return;
      const prog = importProgramData(data);
      toast(`Added ${prog.name}`);
      location.hash = '#/programs/' + prog.id;
      render();
      return;
    }
    if (!Array.isArray(data.exercises) || !Array.isArray(data.templates) || !Array.isArray(data.sessions)) throw new Error('shape');
    if (!confirm(`Replace your current data with this backup (${plural(data.sessions.length, 'workout')})?`)) return;
    const d = defaultState();
    state = { ...d, welcomed: true, imported: data.imported || [], exercises: data.exercises, templates: data.templates, sessions: data.sessions, programs: Array.isArray(data.programs) ? data.programs : [], programId: data.programId || null, active: data.active || null, settings: { ...d.settings, ...(data.settings || {}) } };
    save(); render(); toast('Backup imported');
  } catch (err) {
    toast('That file isn’t a Setwise backup');
  }
}

// ---------- Router ----------
const views = {
  today: viewToday, workouts: viewWorkouts, template: viewTemplateEditor, log: viewLog,
  history: viewHistory, session: viewSession, progress: viewProgress, exercise: viewExerciseProgress,
  exercises: viewExercises, settings: viewSettings, program: viewProgram, 'program-edit': viewProgramEditor,
};
function parseRoute() {
  const [name = 'today', arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'today', arg: arg ? decodeURIComponent(arg) : undefined };
}
function render() {
  const { name, arg } = parseRoute();
  if (name === 'log' && !state.active) { location.replace('#/today'); return; }
  const key = { workouts: arg ? 'template' : 'workouts', history: arg ? 'session' : 'history', progress: arg ? 'exercise' : 'progress', programs: arg ? 'program' : 'workouts' }[name] || name;
  $('#view').innerHTML = (views[key] || viewToday)(arg);
  const tab = ['exercises', 'programs', 'program-edit'].includes(name) ? 'workouts' : name;
  $$('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  $('#resume').innerHTML = state.active && name !== 'log'
    ? `<a class="resume" href="#/log"><span class="grow">${esc(state.active.name || 'Workout')} in progress</span><span data-elapsed="${state.active.start}">${fmtClock((Date.now() - state.active.start) / 1000)}</span><span>Resume ›</span></a>`
    : '';
  renderRest();
}

let lastRoute = '';
window.addEventListener('hashchange', () => {
  const { name, arg } = parseRoute();
  if (!(name === 'workouts' && arg)) draft = null;
  if (name !== 'program-edit') pdraft = null;
  closeModal();
  render();
  const r = name + '/' + (arg || '');
  if (r !== lastRoute) window.scrollTo(0, 0);
  lastRoute = r;
});

// Clock: workout timer + rest countdown
setInterval(() => {
  $$('[data-elapsed]').forEach(el => { el.textContent = fmtClock((Date.now() - +el.dataset.elapsed) / 1000); });
  updateRest();
}, 1000);

// Keep data in sync if the app is open in two tabs
window.addEventListener('storage', e => { if (e.key === STORE_KEY) { state = load(); render(); } });

// Offline support + ask the browser not to evict our data
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
navigator.storage?.persist?.().catch(() => {});

save();
lastRoute = (() => { const { name, arg } = parseRoute(); return name + '/' + (arg || ''); })();
render();
