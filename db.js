// FlashQuant storage: IndexedDB for rounds and facts, localStorage only for tiny settings.
// Falls back to memory (with a visible warning) if the browser blocks storage.

import { sanitizeRecord, sanitizeFacts, migrateV1, normalizeConfig, DEFAULT_CFG, SCHEMA_VERSION } from './core.js';

export { sanitizeFacts };

const DB_NAME = 'flashquant';
const DB_VER = 1;
const MAX_IMPORT_ROUNDS = 10000;
const MAX_IMPORT_CHARS = 25000000;
const LEGACY_KEYS = ['zm_hist', 'zm_probs', 'zm_errs', 'zm_tr', 'zm_gh'];

// UI reads this to show a warning banner when data is not being saved durably.
export const storageState = { mode: 'idb', error: null };

const mem = { rounds: new Map(), meta: new Map() };
let dbPromise = null;

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Number(v)) : 0);

function useMemory(reason) {
  storageState.mode = 'memory';
  storageState.error = reason || 'Browser storage is unavailable';
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      useMemory('IndexedDB is not available in this browser');
      return resolve(null);
    }
    let r;
    try {
      r = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) {
      useMemory(e && e.message);
      return resolve(null);
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('rounds')) db.createObjectStore('rounds', { keyPath: 'id' }).createIndex('ts', 'ts');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => {
      useMemory(r.error && r.error.message);
      resolve(null);
    };
    r.onblocked = () => {
      useMemory('Close other FlashQuant tabs and reload');
      resolve(null);
    };
  });
  return dbPromise;
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('Storage write was aborted'));
});

function noteFailure(e) {
  storageState.error = e && e.name === 'QuotaExceededError'
    ? 'Browser storage is full. Download a backup, then free some space.'
    : 'Could not save to browser storage: ' + ((e && e.message) || 'unknown error');
}

/* ---------- rounds ---------- */

export async function getAllRounds() {
  const db = await open();
  if (!db) return Array.from(mem.rounds.values()).sort((a, b) => a.ts - b.ts);
  try {
    const rows = await wrap(db.transaction('rounds').objectStore('rounds').getAll());
    return rows.sort((a, b) => a.ts - b.ts);
  } catch (e) {
    noteFailure(e);
    return Array.from(mem.rounds.values()).sort((a, b) => a.ts - b.ts);
  }
}

// Returns true if the data reached durable storage. On failure the round is kept in memory for this session.
export async function putRounds(list) {
  const db = await open();
  if (!db) {
    list.forEach((r) => mem.rounds.set(r.id, r));
    return false;
  }
  try {
    const tx = db.transaction('rounds', 'readwrite');
    const s = tx.objectStore('rounds');
    list.forEach((r) => s.put(r));
    await done(tx);
    return true;
  } catch (e) {
    noteFailure(e);
    list.forEach((r) => mem.rounds.set(r.id, r));
    return false;
  }
}

export const putRound = (r) => putRounds([r]);

export async function deleteRound(id) {
  mem.rounds.delete(id);
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction('rounds', 'readwrite');
    tx.objectStore('rounds').delete(id);
    await done(tx);
  } catch (e) {
    noteFailure(e);
  }
}

/* ---------- meta (facts, flags) ---------- */

export async function getMeta(key, fallback = null) {
  const db = await open();
  if (!db) return mem.meta.has(key) ? mem.meta.get(key) : fallback;
  try {
    const row = await wrap(db.transaction('meta').objectStore('meta').get(key));
    return row ? row.value : fallback;
  } catch (e) {
    return mem.meta.has(key) ? mem.meta.get(key) : fallback;
  }
}

export async function setMeta(key, value) {
  mem.meta.set(key, value);
  const db = await open();
  if (!db) return false;
  try {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    await done(tx);
    return true;
  } catch (e) {
    noteFailure(e);
    return false;
  }
}

export const getFacts = () => getMeta('facts', {});

export async function addFacts(add) {
  const base = await getFacts();
  const out = { ...base };
  Object.keys(add).forEach((k) => {
    const a = out[k] || [0, 0, 0];
    out[k] = [a[0] + add[k][0], a[1] + add[k][1], a[2] + add[k][2]];
  });
  return setMeta('facts', out);
}

/* ---------- settings and preferences (tiny, so localStorage is fine) ---------- */

const SETTINGS_KEY = 'fq_settings';
const PREFS_KEY = 'fq_prefs';
const readLS = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

export function loadSettings() {
  const s = readLS(SETTINGS_KEY);
  return normalizeConfig(s && typeof s === 'object' ? s : DEFAULT_CFG);
}

export const saveSettings = (cfg) => writeLS(SETTINGS_KEY, normalizeConfig(cfg));

const FILTER_RANGES = ['all', 'day', 'week', 'month', '3m'];
const FILTER_MODES = ['all', 'n', 'k'];

export function cleanFilters(f) {
  f = f && typeof f === 'object' ? f : {};
  return {
    range: FILTER_RANGES.includes(f.range) ? f.range : 'all',
    mode: FILTER_MODES.includes(f.mode) ? f.mode : 'all',
    dur: f.dur === 'all' || [30, 60, 120, 300, 600].includes(Number(f.dur)) ? (f.dur === 'all' ? 'all' : Number(f.dur)) : 'all',
    ops: typeof f.ops === 'string' && /^[asmd]{1,4}$/.test(f.ops) ? f.ops : 'all',
    fp: typeof f.fp === 'string' && /^[\w|.\-–]{1,80}$/.test(f.fp) ? f.fp : 'all',
  };
}

export function loadPrefs() {
  const p = readLS(PREFS_KEY) || {};
  const presets = Array.isArray(p.presets)
    ? p.presets.slice(0, 12).map((x) => ({ name: String((x && x.name) || '').replace(/[<>&"']/g, '').slice(0, 30), filters: cleanFilters(x && x.filters) })).filter((x) => x.name)
    : [];
  return { ghost: p.ghost !== false, filters: cleanFilters(p.filters), presets };
}

export const savePrefs = (p) => writeLS(PREFS_KEY, p);

/* ---------- reset, persistence, migration ---------- */

export async function clearAll() {
  mem.rounds.clear();
  mem.meta.clear();
  const db = await open();
  if (db) {
    try {
      const tx = db.transaction(['rounds', 'meta'], 'readwrite');
      tx.objectStore('rounds').clear();
      tx.objectStore('meta').clear();
      await done(tx);
    } catch (e) {
      noteFailure(e);
    }
  }
  LEGACY_KEYS.concat([SETTINGS_KEY, PREFS_KEY]).forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
  await setMeta('migratedV1', true); // do not re-import old data after a deliberate reset
}

// Empties rounds and the older facts total but keeps settings and preferences. Used when switching accounts.
export async function clearData() {
  mem.rounds.clear();
  const db = await open();
  if (db) {
    try {
      const tx = db.transaction('rounds', 'readwrite');
      tx.objectStore('rounds').clear();
      await done(tx);
    } catch (e) {
      noteFailure(e);
    }
  }
  await setMeta('facts', {});
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* ignore */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { used: e.usage || 0, quota: e.quota || 0 };
    }
  } catch (e) { /* ignore */ }
  return null;
}

function factsFromLegacyProbs(probs) {
  const facts = {};
  if (!probs || typeof probs !== 'object') return facts;
  Object.values(probs).forEach((p) => {
    if (!Array.isArray(p) || (p[3] !== 'm' && p[3] !== 'd')) return;
    const x = Number(p[4]);
    const y = Number(p[5]);
    if (!(x >= 1 && x <= 12 && y >= 1 && y <= 12)) return;
    const k = Math.min(x, y) + '_' + Math.max(x, y);
    const f = facts[k] || (facts[k] = [0, 0, 0]);
    f[0] += num(p[0]);
    f[1] += num(p[1]);
    f[2] += num(p[2]);
  });
  return facts;
}

// One-time import of the old localStorage data. The old keys are left in place as a safety copy.
export async function migrateLegacy() {
  if (await getMeta('migratedV1', false)) return { migrated: 0 };
  const hist = readLS('zm_hist');
  if (!Array.isArray(hist) || !hist.length) {
    await setMeta('migratedV1', true);
    return { migrated: 0 };
  }
  const recs = migrateV1(hist.slice(-MAX_IMPORT_ROUNDS));
  const ok = await putRounds(recs);
  await addFacts(sanitizeFacts(factsFromLegacyProbs(readLS('zm_probs'))));
  if (ok) await setMeta('migratedV1', true);
  return { migrated: recs.length, durable: ok };
}

/* ---------- backup: export, validate, preview, apply ---------- */

export async function backupText() {
  return JSON.stringify({
    app: 'flashquant',
    schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    rounds: await getAllRounds(),
    facts: await getFacts(),
  });
}

// Reads and validates a backup WITHOUT touching stored data. The UI shows the result before anything is applied.
export function parseBackup(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The backup is empty.' };
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, error: 'That file is too large to be a FlashQuant backup.' };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'That is not valid JSON, so it cannot be a backup.' };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'This file is not a FlashQuant backup.' };
  let raw;
  let rounds;
  let facts;
  let kind;
  if (obj.app === 'flashquant' && Array.isArray(obj.rounds)) {
    kind = 'current';
    raw = obj.rounds.slice(0, MAX_IMPORT_ROUNDS);
    rounds = raw.map(sanitizeRecord).filter(Boolean);
    facts = sanitizeFacts(obj.facts);
  } else if (Array.isArray(obj.h)) {
    kind = 'earlier version';
    raw = obj.h.slice(0, MAX_IMPORT_ROUNDS);
    rounds = migrateV1(raw);
    facts = sanitizeFacts(factsFromLegacyProbs(obj.p));
  } else {
    return { ok: false, error: 'This file is not a FlashQuant backup.' };
  }
  if (!rounds.length) return { ok: false, error: 'No usable rounds were found in this backup.' };
  const ids = new Set();
  rounds = rounds.filter((r) => (ids.has(r.id) ? false : (ids.add(r.id), true)));
  const ts = rounds.map((r) => r.ts);
  return {
    ok: true,
    kind,
    rounds,
    facts,
    skipped: raw.length - rounds.length,
    from: Math.min(...ts),
    to: Math.max(...ts),
  };
}

// mode "merge": keep what you have and add new rounds (same round id = skipped, so re-importing never duplicates).
// mode "replace": erase current rounds and facts first.
export async function applyBackup(parsed, mode) {
  if (!parsed || !parsed.ok) return { ok: false, added: 0 };
  let existing = [];
  let facts = parsed.facts;
  if (mode === 'replace') {
    const db = await open();
    mem.rounds.clear();
    if (db) {
      try {
        const tx = db.transaction('rounds', 'readwrite');
        tx.objectStore('rounds').clear();
        await done(tx);
      } catch (e) {
        noteFailure(e);
        return { ok: false, added: 0, error: storageState.error };
      }
    }
  } else {
    existing = await getAllRounds();
    // Facts are running totals, so re-adding them would double count. Keep whichever side has more samples.
    const have = await getFacts();
    facts = { ...have };
    Object.keys(parsed.facts).forEach((k) => {
      if (!have[k] || parsed.facts[k][0] > have[k][0]) facts[k] = parsed.facts[k];
    });
  }
  const known = new Set(existing.map((r) => r.id));
  const fresh = parsed.rounds.filter((r) => !known.has(r.id));
  const ok = await putRounds(fresh);
  await setMeta('facts', facts);
  return { ok, added: fresh.length, total: existing.length + fresh.length, error: ok ? null : storageState.error };
}
