// FlashQuant core: pure logic only. No DOM, no storage. Safe to unit-test in Node.

export const SCHEMA_VERSION = 2;
export const OPS = { a: 'Addition (+)', s: 'Subtraction (−)', m: 'Multiplication (×)', d: 'Division (÷)' };
export const OP_KEYS = ['a', 's', 'm', 'd'];
export const OP_SHORT = { a: '+', s: '−', m: '×', d: '÷' };
export const DURATIONS = [30, 60, 120, 300, 600];
export const DEFAULT_CFG = {
  ops: ['a', 's', 'm', 'd'],
  a: [2, 100, 2, 100],
  m: [2, 12, 2, 100],
  dur: 120,
};

/* ---------- small helpers ---------- */

export const mean = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);

export function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(a, p) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

/* ---------- config ---------- */

function fixPair(lo, hi, min, max, dl, dh) {
  let a = clampInt(lo, min, max, dl);
  let b = clampInt(hi, min, max, dh);
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

// Clamp and repair any user input so the game can never get an unanswerable problem.
// Divisors and multipliers start at 1, so "0 ÷ 0" cannot occur.
export function normalizeConfig(c) {
  c = c || {};
  let ops = OP_KEYS.filter((k) => Array.isArray(c.ops) && c.ops.includes(k));
  if (!ops.length) ops = ['a'];
  const A = Array.isArray(c.a) ? c.a : DEFAULT_CFG.a;
  const M = Array.isArray(c.m) ? c.m : DEFAULT_CFG.m;
  const [a1, a2] = fixPair(A[0], A[1], 0, 9999, 2, 100);
  const [a3, a4] = fixPair(A[2], A[3], 0, 9999, 2, 100);
  const [m1, m2] = fixPair(M[0], M[1], 1, 999, 2, 12);
  const [m3, m4] = fixPair(M[2], M[3], 1, 9999, 2, 100);
  const dur = DURATIONS.includes(Number(c.dur)) ? Number(c.dur) : 120;
  return { ops, a: [a1, a2, a3, a4], m: [m1, m2, m3, m4], dur };
}

// Identifies "the same game". Ranges only count if an operation that uses them is on.
export function fingerprint(cfg) {
  const parts = ['d' + cfg.dur, cfg.ops.join('')];
  if (cfg.ops.includes('a') || cfg.ops.includes('s')) parts.push('a' + cfg.a.join('-'));
  if (cfg.ops.includes('m') || cfg.ops.includes('d')) parts.push('m' + cfg.m.join('-'));
  return parts.join('|');
}

export function settingsLabel(cfg) {
  const ops = OP_KEYS.filter((k) => cfg.ops.includes(k)).map((k) => OP_SHORT[k]).join(' ');
  const bits = [cfg.dur + 's', ops];
  if (cfg.ops.includes('a') || cfg.ops.includes('s')) bits.push(`add ${cfg.a[0]}–${cfg.a[1]} / ${cfg.a[2]}–${cfg.a[3]}`);
  if (cfg.ops.includes('m') || cfg.ops.includes('d')) bits.push(`mul ${cfg.m[0]}–${cfg.m[1]} / ${cfg.m[2]}–${cfg.m[3]}`);
  return bits.join(' · ');
}

/* ---------- problems ---------- */

function carries(x, y) {
  let c = 0;
  let k = 0;
  while (x > 0 || y > 0) {
    const s = (x % 10) + (y % 10) + k;
    k = s >= 10 ? 1 : 0;
    c += k;
    x = Math.floor(x / 10);
    y = Math.floor(y / 10);
  }
  return c;
}

function borrows(minuend, sub) {
  let b = 0;
  let k = 0;
  while (minuend > 0 || sub > 0) {
    const md = minuend % 10;
    const sd = sub % 10;
    if (md - k < sd) {
      b++;
      k = 1;
    } else k = 0;
    minuend = Math.floor(minuend / 10);
    sub = Math.floor(sub / 10);
  }
  return b;
}

const sizeBand = (p, word) => (p < 100 ? `${word} under 100` : p < 1000 ? `${word} 100–999` : `${word} 1000+`);

// The bucket describes how hard the problem is, in a way you can actually practise.
export function bucketOf(op, x, y) {
  if (op === 'a') {
    const c = carries(x, y);
    return c === 0 ? 'No carry' : c === 1 ? '1 carry' : '2+ carries';
  }
  if (op === 's') {
    const b = borrows(x + y, x);
    return b === 0 ? 'No borrow' : b === 1 ? '1 borrow' : '2+ borrows';
  }
  if (op === 'm') return sizeBand(x * y, 'Product');
  return sizeBand(x * y, 'Dividend');
}

const ri = (a, b, rng) => a + Math.floor(rng() * (b - a + 1));

export function makeProblem(op, x, y) {
  let text;
  let answer;
  if (op === 'a') { text = `${x} + ${y}`; answer = x + y; }
  else if (op === 's') { text = `${x + y} − ${x}`; answer = y; }
  else if (op === 'm') { text = `${x} × ${y}`; answer = x * y; }
  else { text = `${x * y} ÷ ${x}`; answer = y; }
  return { op, x, y, text, answer, bucket: bucketOf(op, x, y) };
}

function operands(op, cfg, rng) {
  return op === 'a' || op === 's'
    ? [ri(cfg.a[0], cfg.a[1], rng), ri(cfg.a[2], cfg.a[3], rng)]
    : [ri(cfg.m[0], cfg.m[1], rng), ri(cfg.m[2], cfg.m[3], rng)];
}

export function randomProblem(cfg, rng = Math.random) {
  const op = cfg.ops[Math.floor(rng() * cfg.ops.length)];
  const [x, y] = operands(op, cfg, rng);
  return makeProblem(op, x, y);
}

// Try to hit a specific difficulty bucket; fall back to a normal problem if the ranges can't produce it.
export function problemInBucket(op, bucket, cfg, rng = Math.random, tries = 300) {
  for (let i = 0; i < tries; i++) {
    const [x, y] = operands(op, cfg, rng);
    if (bucketOf(op, x, y) === bucket) return makeProblem(op, x, y);
  }
  return null;
}

/* ---------- per-round metrics ---------- */

// Monkeytype-style mapping from coefficient of variation to 0–100.
export function cvToConsistency(cv) {
  return Math.max(0, Math.min(100, 100 * (1 - Math.tanh(cv + Math.pow(cv, 3) / 3 + Math.pow(cv, 5) / 5))));
}

// Per-problem times are divided by the median for that problem type first,
// so mixing easy and hard problem types is not counted as "inconsistent".
export function consistencyOf(log) {
  if (log.length < 5) return null;
  const byType = {};
  const byOp = {};
  log.forEach((r) => {
    (byType[r.op + '|' + r.bucket] = byType[r.op + '|' + r.bucket] || []).push(r.time);
    (byOp[r.op] = byOp[r.op] || []).push(r.time);
  });
  const all = median(log.map((r) => r.time));
  const norm = log.map((r) => {
    const t = byType[r.op + '|' + r.bucket];
    const o = byOp[r.op];
    const ref = t.length >= 3 ? median(t) : o.length >= 3 ? median(o) : all;
    return ref > 0 ? r.time / ref : 1;
  });
  const m = mean(norm);
  if (m <= 0) return null;
  const sd = Math.sqrt(mean(norm.map((v) => (v - m) * (v - m))));
  return cvToConsistency(sd / m);
}

// log entries: { op, bucket, time(ms), wrong, at(ms since start), x, y }
export function roundMetrics(log, dur, pendingWrong = 0) {
  const solved = log.length;
  const wrong = log.reduce((p, r) => p + r.wrong, 0) + pendingWrong;
  const attempts = solved + wrong;
  const perOp = {};
  const perType = {};
  OP_KEYS.forEach((k) => {
    const l = log.filter((r) => r.op === k);
    if (l.length) perOp[k] = Math.round(mean(l.map((r) => r.time)));
  });
  log.forEach((r) => {
    const k = r.op + '|' + r.bucket;
    const t = perType[k] || (perType[k] = [0, 0, 0]);
    t[0]++;
    t[1] += r.time;
    t[2] += r.wrong;
  });
  Object.keys(perType).forEach((k) => (perType[k][1] = Math.round(perType[k][1] / perType[k][0])));
  // How wrong were the wrong answers? [off by a multiple of 10, off by 1-2, further off] per operation.
  const errKinds = {};
  log.forEach((r) => (r.errs || []).forEach((d) => {
    const k = errKinds[r.op] || (errKinds[r.op] = [0, 0, 0]);
    const a = Math.abs(d);
    if (a % 10 === 0) k[0]++;
    else if (a <= 2) k[1]++;
    else k[2]++;
  }));
  return {
    score: solved,
    wrong,
    spm: (solved * 60) / dur,
    rawSpm: (attempts * 60) / dur,
    acc: attempts ? (solved / attempts) * 100 : 0,
    cons: consistencyOf(log),
    perOp,
    perType,
    errKinds,
  };
}

function newId(ts) {
  try {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* fall through */ }
  return ts.toString(36) + Math.random().toString(36).slice(2, 10);
}

export function buildRecord({ cfg, mode, log, wrongAt = [], pendingWrong = 0, elapsed, completed, ts = Date.now() }) {
  const base = {
    v: SCHEMA_VERSION,
    id: newId(ts),
    ts,
    mode: mode === 'k' ? 'k' : 'n',
    dur: cfg.dur,
    elapsed: Math.round(elapsed),
    completed: !!completed,
    fp: fingerprint(cfg),
    label: settingsLabel(cfg),
    ops: cfg.ops.slice(),
    cfg: { a: cfg.a.slice(), m: cfg.m.slice() },
  };
  if (!completed) {
    return { ...base, score: log.length, wrong: 0, spm: 0, rawSpm: 0, acc: 0, cons: null, perOp: {}, perType: {}, errKinds: {}, tl: [], wl: [] };
  }
  const m = roundMetrics(log, cfg.dur, pendingWrong);
  return {
    ...base,
    ...m,
    tl: log.map((r) => Math.round(r.at / 100) / 10),
    wl: wrongAt.map((t) => Math.round(t / 100) / 10),
  };
}

// Facts for the times-table heatmap (bounded: at most 11×11 keys).
export function factsFromLog(log) {
  const out = {};
  log.forEach((r) => {
    if ((r.op !== 'm' && r.op !== 'd') || r.x > 12 || r.y > 12) return;
    const k = Math.min(r.x, r.y) + '_' + Math.max(r.x, r.y);
    const f = out[k] || (out[k] = [0, 0, 0]);
    f[0]++;
    f[1] += r.time;
    f[2] += r.wrong;
  });
  return out;
}

export function mergeFacts(base, add) {
  const out = { ...base };
  Object.keys(add).forEach((k) => {
    const a = out[k] || [0, 0, 0];
    out[k] = [a[0] + add[k][0], a[1] + add[k][1], a[2] + add[k][2]];
  });
  return out;
}

/* ---------- aggregates over many rounds ---------- */

export const byTime = (records) => records.slice().sort((a, b) => a.ts - b.ts);

export function typeAgg(records) {
  const A = {};
  records.forEach((r) => {
    if (!r.completed || !r.perType) return;
    Object.keys(r.perType).forEach((k) => {
      const t = r.perType[k];
      const a = A[k] || (A[k] = [0, 0, 0]);
      a[0] += t[0];
      a[1] += t[0] * t[1];
      a[2] += t[2];
    });
  });
  return A;
}

// Totals of error kinds per operation across rounds.
export function errAgg(records) {
  const A = {};
  records.forEach((r) => {
    if (!r.completed || !r.errKinds) return;
    Object.keys(r.errKinds).forEach((k) => {
      const a = A[k] || (A[k] = [0, 0, 0]);
      r.errKinds[k].forEach((v, i) => (a[i] += v));
    });
  });
  return A;
}

// Weakest problem types: slow relative to your own average, plus a penalty for errors.
export function weakTypes(agg, allowedOps) {
  let n = 0;
  let s = 0;
  Object.keys(agg).forEach((k) => {
    n += agg[k][0];
    s += agg[k][1];
  });
  if (!n) return [];
  const m = s / n;
  return Object.keys(agg)
    .filter((k) => agg[k][0] >= 3 && (!allowedOps || allowedOps.includes(k.split('|')[0])))
    .map((k) => {
      const a = agg[k];
      return { k, n: a[0], avg: a[1] / a[0], w: a[2], sc: a[1] / a[0] / m + (2 * a[2]) / a[0] };
    })
    .sort((x, y) => y.sc - x.sc);
}

export function pickKillerType(weak, rng = Math.random) {
  const W = weak.slice(0, 3);
  if (!W.length) return null;
  const tot = W.reduce((p, w) => p + w.sc, 0);
  let r = rng() * tot;
  for (const w of W) {
    r -= w.sc;
    if (r <= 0) return w;
  }
  return W[0];
}

// Killer problem: only drills your weak types, and respects the operations and ranges you have switched on.
export function killerProblem(cfg, agg, rng = Math.random) {
  const t = pickKillerType(weakTypes(agg, cfg.ops), rng);
  if (t) {
    const [op, bucket] = t.k.split('|');
    const p = problemInBucket(op, bucket, cfg, rng);
    if (p) return p;
  }
  return randomProblem(cfg, rng);
}

/* ---------- filtering and stats ---------- */

const DAY = 86400000;
const RANGE_MS = { day: DAY, week: 7 * DAY, month: 30 * DAY, '3m': 90 * DAY };

export const opsKey = (ops) => OP_KEYS.filter((k) => ops.includes(k)).join('');

export function applyFilters(records, f = {}) {
  const now = f.now || Date.now();
  return byTime(records).filter((r) => {
    if (f.range && f.range !== 'all' && r.ts < now - RANGE_MS[f.range]) return false;
    if (f.mode && f.mode !== 'all' && r.mode !== f.mode) return false;
    if (f.dur && f.dur !== 'all' && r.dur !== Number(f.dur)) return false;
    if (f.ops && f.ops !== 'all' && opsKey(r.ops) !== f.ops) return false;
    if (f.fp && f.fp !== 'all' && r.fp !== f.fp) return false;
    return true;
  });
}

function trio(rows, sel) {
  const v = rows.map(sel).filter((x) => Number.isFinite(x));
  if (!v.length) return { high: null, avg: null, last10: null };
  return { high: Math.max(...v), avg: mean(v), last10: mean(v.slice(-10)) };
}

export function summarize(records) {
  const rows = byTime(records);
  const done = rows.filter((r) => r.completed);
  const perf = done.filter((r) => r.score > 0);
  const aborted = rows.length - done.length;
  return {
    started: rows.length,
    completed: done.length,
    completedPct: rows.length ? (done.length / rows.length) * 100 : 0,
    restartsPerCompleted: done.length ? aborted / done.length : 0,
    timeSec: rows.reduce((p, r) => p + (r.elapsed || 0), 0),
    solved: perf.reduce((p, r) => p + r.score, 0),
    spm: trio(perf, (r) => r.spm),
    rawSpm: trio(perf, (r) => r.rawSpm),
    acc: trio(perf, (r) => r.acc),
    cons: trio(perf, (r) => r.cons),
  };
}

// Best round per duration, ranked by solves per minute so different durations compare fairly.
export function pbByDuration(records) {
  const out = {};
  records.forEach((r) => {
    if (!r.completed || r.score <= 0) return;
    const b = out[r.dur];
    if (!b || r.spm > b.spm) out[r.dur] = r;
  });
  return out;
}

export function movingAverage(values, n) {
  return values.map((_, i) => mean(values.slice(Math.max(0, i - n + 1), i + 1)));
}

export function histogram(values, bin) {
  if (!values.length) return [];
  const top = Math.floor(Math.max(...values) / bin);
  const bins = [];
  for (let i = 0; i <= top; i++) bins.push({ lo: i * bin, hi: i * bin + bin - 1, count: 0 });
  values.forEach((v) => bins[Math.floor(v / bin)].count++);
  return bins;
}

export function localDayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Daily practice, in the viewer's own timezone.
export function dailyTotals(records) {
  const D = {};
  records.forEach((r) => {
    const k = localDayKey(r.ts);
    const d = D[k] || (D[k] = { key: k, sec: 0, rounds: 0, spm: [] });
    d.sec += r.elapsed || 0;
    d.rounds++;
    if (r.completed && r.score > 0) d.spm.push(r.spm);
  });
  return Object.values(D)
    .map((d) => ({ key: d.key, minutes: d.sec / 60, rounds: d.rounds, avgSpm: d.spm.length ? mean(d.spm) : null }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

// Calendar grid: columns are weeks (Monday first), each with 7 day cells.
export function heatmapGrid(records, weeks = 26, now = Date.now()) {
  const per = {};
  records.forEach((r) => {
    const k = localDayKey(r.ts);
    per[k] = (per[k] || 0) + (r.elapsed || 0);
  });
  const vals = Object.values(per).filter((v) => v > 0);
  const q = [0.25, 0.5, 0.75].map((p) => quantile(vals, p));
  const level = (v) => (v <= 0 ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // Monday = 0
  const start = new Date(today);
  start.setDate(start.getDate() - dow - (weeks - 1) * 7);
  const cols = [];
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      const key = localDayKey(day.getTime());
      const future = day.getTime() > today.getTime();
      col.push({ key, sec: per[key] || 0, level: future ? -1 : level(per[key] || 0), month: day.getMonth(), date: day.getDate() });
    }
    cols.push(col);
  }
  return cols;
}

// Only speak about a trend once there is enough data to mean something.
export function trendInfo(records, need = 30) {
  const v = byTime(records).filter((r) => r.completed && r.score > 0).map((r) => r.spm);
  if (v.length < need) return { ready: false, have: v.length, need };
  const last = mean(v.slice(-10));
  const prev = mean(v.slice(-20, -10));
  const pct = prev ? ((last - prev) / prev) * 100 : 0;
  return { ready: true, pct, dir: Math.abs(pct) < 3 ? 'flat' : pct > 0 ? 'up' : 'down' };
}

/* ---------- CSV ---------- */

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = "'" + s; // block spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

export function toCSV(records) {
  const head = ['id', 'date_utc', 'date_local', 'mode', 'duration_s', 'elapsed_s', 'completed', 'settings', 'operations', 'solved', 'wrong_attempts', 'spm', 'raw_spm', 'accuracy_pct', 'consistency_pct', 'add_avg_ms', 'sub_avg_ms', 'mul_avg_ms', 'div_avg_ms'];
  const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : '');
  const rows = byTime(records).map((r) => [
    r.id,
    new Date(r.ts).toISOString(),
    new Date(r.ts).toLocaleString('sv-SE'),
    r.mode === 'k' ? 'killer' : 'normal',
    r.dur,
    r.elapsed,
    r.completed ? 'yes' : 'no',
    r.label,
    r.ops.join(''),
    r.score,
    r.wrong,
    r2(r.spm),
    r2(r.rawSpm),
    r2(r.acc),
    r2(r.cons),
    r.perOp.a ?? '',
    r.perOp.s ?? '',
    r.perOp.m ?? '',
    r.perOp.d ?? '',
  ]);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/* ---------- import safety and migration ---------- */

const MAX_SERIES = 3000;
const numArr = (a) => (Array.isArray(a) ? a.slice(0, MAX_SERIES).map((x) => num(x, NaN)).filter(Number.isFinite) : []);

// Returns a clean record, or null if the input is not a usable round. Never trusts imported strings.
export function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const dur = num(r.dur, NaN);
  const ts = num(r.ts, NaN);
  if (!Number.isFinite(dur) || dur <= 0 || dur > 3600 || !Number.isFinite(ts) || ts <= 0) return null;
  let ops = OP_KEYS.filter((k) => Array.isArray(r.ops) && r.ops.includes(k));
  if (!ops.length) ops = ['a'];
  const perOp = {};
  OP_KEYS.forEach((k) => {
    if (r.perOp && Number.isFinite(Number(r.perOp[k]))) perOp[k] = num(r.perOp[k]);
  });
  const perType = {};
  if (r.perType && typeof r.perType === 'object') {
    Object.keys(r.perType).slice(0, 40).forEach((k) => {
      const t = r.perType[k];
      if (/^[asmd]\|[^<>&"']{1,30}$/.test(k) && Array.isArray(t) && t.length >= 3) perType[k] = [num(t[0]), num(t[1]), num(t[2])];
    });
  }
  const errKinds = {};
  OP_KEYS.forEach((k) => {
    const e = r.errKinds && r.errKinds[k];
    if (Array.isArray(e) && e.length >= 3) errKinds[k] = [num(e[0]), num(e[1]), num(e[2])].map((x) => Math.max(0, x));
  });
  let fp = String(r.fp || 'legacy').replace(/[^\w|.\-–]/g, '').slice(0, 80);
  let label = String(r.label || fp).replace(/[<>&"']/g, '').slice(0, 100);
  let cfg = { a: DEFAULT_CFG.a, m: DEFAULT_CFG.m };
  if (r.cfg && Array.isArray(r.cfg.a) && Array.isArray(r.cfg.m)) {
    const n = normalizeConfig({ ops, a: r.cfg.a, m: r.cfg.m, dur });
    cfg = { a: n.a, m: n.m };
    fp = fingerprint(n);
    label = settingsLabel(n);
  }
  return {
    v: SCHEMA_VERSION,
    id: String(r.id || newId(ts)).replace(/[^\w-]/g, '').slice(0, 64) || newId(ts),
    ts,
    mode: r.mode === 'k' ? 'k' : 'n',
    dur,
    elapsed: Math.min(3600, Math.max(0, num(r.elapsed, dur))),
    completed: r.completed !== false,
    fp,
    label,
    ops,
    cfg,
    score: Math.max(0, num(r.score)),
    wrong: Math.max(0, num(r.wrong)),
    spm: Math.max(0, num(r.spm)),
    rawSpm: Math.max(0, num(r.rawSpm)),
    acc: Math.min(100, Math.max(0, num(r.acc))),
    cons: r.cons === null || r.cons === undefined ? null : Math.min(100, Math.max(0, num(r.cons))),
    perOp,
    perType,
    errKinds,
    tl: numArr(r.tl),
    wl: numArr(r.wl),
  };
}

// Convert the old localStorage history (v1) into v2 records.
export function migrateV1(hist) {
  if (!Array.isArray(hist)) return [];
  return hist
    .map((g, i) => {
      if (!g || !Number.isFinite(Number(g.score)) || !Number.isFinite(Number(g.dur))) return null;
      const types = g.types && typeof g.types === 'object' ? g.types : {};
      const wrong = Object.keys(types).reduce((p, k) => p + num((types[k] || [])[2]), 0);
      const score = num(g.score);
      const attempts = score + wrong;
      const spm = (score * 60) / num(g.dur);
      return sanitizeRecord({
        id: 'v1-' + (g.ts || i) + '-' + i,
        ts: num(g.ts, Date.now() - (hist.length - i) * 1000),
        mode: g.mode,
        dur: g.dur,
        elapsed: g.dur,
        completed: true,
        fp: 'legacy-d' + g.dur,
        label: 'Earlier version · ' + g.dur + 's',
        ops: Object.keys(g.ops || {}),
        score,
        wrong,
        spm,
        rawSpm: (attempts * 60) / num(g.dur),
        acc: attempts ? (score / attempts) * 100 : 0,
        cons: null,
        perOp: g.ops,
        perType: {}, // old bucket names differ from the new ones, so they are not carried over
        tl: g.tl,
        wl: [],
      });
    })
    .filter(Boolean);
}
