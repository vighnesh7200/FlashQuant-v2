// FlashQuant app: wires the page to the core, storage, engine and charts.

import {
  mergeFacts, factsOf, OP_KEYS, OP_SHORT, OPS, DURATIONS, esc, mean, normalizeConfig, fingerprint, applyFilters, summarize,
  pbByDuration, movingAverage, histogram, dailyTotals, heatmapGrid, trendInfo, typeAgg, errAgg, weakTypes, toCSV, opsKey,
} from './core.js';
import * as DB from './db.js';
import { createGame } from './engine.js';
import { trickFor } from './tricks.js';
import { analysisHTML } from './analysis.js';
import * as CH from './charts.js';
import { createAccount } from './account.js';

const $ = (id) => document.getElementById(id);

// Cloud account and sync. Everything below works unchanged when nobody is signed in.
const account = createAccount({
  DB,
  hooks: {
    localCount: () => state.rounds.length,
    getRounds: async () => DB.getAllRounds(),
    refresh: async () => {
      await reloadData();
      if (state.game && state.game.isRunning()) return;
      if (state.view === 'stats') rerender();
      else if (state.view === 'home') renderHome();
    },
  },
});

const state = {
  rounds: [], baseFacts: {}, facts: {}, cfg: null, prefs: null, mode: 'n', game: null, last: null, rot: 0,
  sort: { key: 'ts', dir: -1 }, rows: 25, toggles: { speed: true, acc: false, avg10: true, avg100: true },
  presetOpen: false, importPreview: null, notice: '', confirm: {}, view: 'home',
};

/* ---------- formatting ---------- */

const f1 = (v) => (v === null || v === undefined ? '–' : v.toFixed(1));
const pct1 = (v) => (v === null || v === undefined ? '–' : v.toFixed(1) + '%');
const pct0 = (v) => (v === null || v === undefined ? '–' : Math.round(v) + '%');
const hms = (s) => {
  s = Math.round(s);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const dayShort = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const opsLabel = (key) => key.split('').map((k) => OP_SHORT[k]).join(' ');
const faster = (now, before) => {
  if (!now || !before) return '–';
  const p = Math.round((Math.abs(now - before) / before) * 100);
  return p === 0 ? 'same' : now < before ? `<span class="good">▲ ${p}% faster</span>` : `<span class="bad">▼ ${p}% slower</span>`;
};

function download(text, name, type) {
  const blob = new Blob([type === 'text/csv' ? '﻿' + text : text], { type });
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}

/* ---------- views and routing ---------- */

const VIEWS = ['home', 'game', 'result', 'analysis', 'stats'];

function show(v) {
  state.view = v;
  VIEWS.forEach((x) => $('v-' + x).classList.toggle('hide', x !== v));
  document.body.classList.toggle('playing', v === 'game');
  [['nav-play', 'home'], ['nav-stats', 'stats']].forEach(([id, view]) => {
    if (v === view) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  });
  if (v !== 'game') {
    window.scrollTo(0, 0);
    const h = document.querySelector('#v-' + v + ' h1');
    if (h) {
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
  }
}

function route() {
  if (state.game && state.game.isRunning()) return;
  if (location.hash === '#/stats') {
    renderStats();
    show('stats');
  } else {
    renderHome();
    show('home');
  }
}

function go(hash) {
  if (location.hash !== hash) location.hash = hash;
  else route();
}

function updateBanner() {
  const b = $('banner');
  const s = DB.storageState;
  if (!s.error) return b.classList.add('hide');
  b.textContent = s.mode === 'memory'
    ? `Your browser is blocking saved data (private browsing, perhaps), so rounds from this session will be lost when you close the page. (${s.error})`
    : s.error;
  b.classList.remove('hide');
}

/* ---------- settings form ---------- */

function fillForm(cfg) {
  OP_KEYS.forEach((k) => ($('op-' + k).checked = cfg.ops.includes(k)));
  ['a1', 'a2', 'a3', 'a4'].forEach((id, i) => ($(id).value = cfg.a[i]));
  ['m1', 'm2', 'm3', 'm4'].forEach((id, i) => ($(id).value = cfg.m[i]));
  $('dur').value = String(cfg.dur);
}

function readForm() {
  const n = (id) => parseInt($(id).value, 10);
  return {
    ops: OP_KEYS.filter((k) => $('op-' + k).checked),
    a: [n('a1'), n('a2'), n('a3'), n('a4')],
    m: [n('m1'), n('m2'), n('m3'), n('m4')],
    dur: Number($('dur').value),
  };
}

function onSettingsChange() {
  const raw = readForm();
  const cfg = normalizeConfig(raw);
  let msg = '';
  if (!raw.ops.length) msg = 'Pick at least one operation, so Addition was turned back on.';
  else if (raw.a.some((v, i) => v !== cfg.a[i]) || raw.m.some((v, i) => v !== cfg.m[i])) {
    msg = 'Some ranges were adjusted so every problem has an answer: "from" cannot be above "to", and multiplication and division numbers start at 1.';
  }
  $('adjusted').textContent = msg;
  $('adjusted').classList.toggle('hide', !msg);
  state.cfg = cfg;
  fillForm(cfg);
  DB.saveSettings(cfg);
  updatePBLine();
}

/* ---------- home ---------- */

const killerReady = () => state.rounds.filter((r) => r.completed && r.mode === 'n' && Object.keys(r.perType || {}).length).length >= 3;

function bestFor(fp, mode) {
  let best = null;
  state.rounds.forEach((r) => {
    if (r.completed && r.score > 0 && r.fp === fp && r.mode === mode && (!best || r.spm > best.spm)) best = r;
  });
  return best;
}

function updatePBLine() {
  const b = bestFor(fingerprint(state.cfg), 'n');
  $('pb-line').textContent = b
    ? `Your best at these settings: ${b.score} solved in ${b.dur}s (${b.spm.toFixed(1)} per minute), ${dayShort(b.ts)}.`
    : 'No normal rounds yet at these exact settings. Change any setting and your personal best and ghost start fresh.';
}

function renderHome() {
  fillForm(state.cfg);
  updatePBLine();
  const ready = killerReady();
  $('btn-kill').disabled = !ready;
  $('kill-note').textContent = ready
    ? 'Killer mode only drills your weakest question types, within the operations and ranges selected above.'
    : 'Play 3 normal rounds to unlock Killer mode. It then drills only your weakest question types.';
  $('trick').innerHTML = trickFor(state.rounds, state.rot).html;
  state.rot++;
  DB.setMeta('trickRot', state.rot);
  updateBanner();
}

/* ---------- playing ---------- */

function ghostTimelineFor(rec) {
  if (!rec) return null;
  if (rec.tl && rec.tl.length) return rec.tl;
  return Array.from({ length: rec.score }, (_, i) => ((i + 1) * rec.dur) / rec.score);
}

function startGame(mode) {
  const cfg = normalizeConfig(readForm());
  state.cfg = cfg;
  fillForm(cfg);
  DB.saveSettings(cfg);
  state.mode = mode;
  const fp = fingerprint(cfg);
  const ghostRec = bestFor(fp, mode);
  const tl = ghostTimelineFor(ghostRec);
  $('btn-ghost').classList.toggle('hide', !tl);
  $('btn-ghost').textContent = state.prefs.ghost ? 'Hide ghost' : 'Show ghost';
  $('g-ghost').textContent = '';
  state.game = createGame({
    cfg, mode, agg: typeAgg(state.rounds), ghostTimeline: tl,
    onTick: ({ leftSec, solved, ghost }) => {
      $('g-time').textContent = leftSec;
      $('g-score').textContent = solved;
      const el = $('g-ghost');
      if (ghost === null || !state.prefs.ghost) el.textContent = '';
      else {
        const d = solved - ghost;
        el.innerHTML = `Ghost <b>${ghost}</b> <span class="${d >= 0 ? 'good' : 'bad'}">(${d > 0 ? '+' : ''}${d})</span>`;
      }
    },
    onProblem: (p) => {
      $('g-q').textContent = p.text;
      const a = $('g-ans');
      a.value = '';
      a.style.width = String(p.answer).length + 1 + 'ch';
      a.classList.remove('off');
      a.focus({ preventScroll: true });
    },
    onWrong: () => {},
    onEnd: handleEnd,
  });
  show('game');
  state.game.start();
  $('g-ans').focus({ preventScroll: true });
}

function handleEnd(res) {
  document.body.classList.remove('playing');
  const rec = res.record;
  if (!res.completed) {
    if (res.touched) {
      state.rounds.push(rec);
      DB.putRound(rec).then(() => {
        updateBanner();
        account.afterRound(rec);
      });
    }
    go('#/');
    route();
    return;
  }
  const history = state.rounds.filter((r) => r.completed && r.score > 0 && r.fp === rec.fp && r.mode === rec.mode);
  const before = typeAgg(state.rounds);
  state.last = { ...res, history, before };
  state.rounds.push(rec);
  renderResult();
  show('result');
  refreshFacts();
  DB.putRound(rec).then(() => {
    DB.requestPersistence();
    updateBanner();
    account.afterRound(rec);
  });
}

function renderResult() {
  const { record: r, history } = state.last;
  const best = history.reduce((p, x) => Math.max(p, x.spm), 0);
  const note = !history.length ? 'First round with these exact settings.'
    : r.spm > best ? '<span class="good">New personal best for these settings.</span>'
    : r.spm === best ? 'You matched your best for these settings.'
    : `Your best for these settings is ${best.toFixed(1)} per minute.`;
  $('h-result').textContent = r.mode === 'k' ? 'Killer round done!' : "Time's up!";
  $('r-body').innerHTML = `<p class="big">${r.score}</p>
    <p class="muted">solved in ${r.dur} seconds${r.mode === 'k' ? ' · Killer mode' : ''}</p>
    <div class="tiles">
      <div class="tile"><span>Solves/min</span><b>${r.spm.toFixed(1)}</b></div>
      <div class="tile"><span>Accuracy</span><b>${r.acc.toFixed(1)}%</b></div>
      <div class="tile"><span>Consistency</span><b>${r.cons === null ? '–' : Math.round(r.cons) + '%'}</b></div>
      <div class="tile"><span>Wrong tries</span><b>${r.wrong}</b></div>
    </div><p>${note}</p>`;
  $('btn-copy').textContent = 'Copy score';
}

function abortRound() {
  if (state.game && state.game.isRunning()) state.game.abort();
}

/* ---------- stats ---------- */

const RANGES = [['all', 'All time'], ['day', 'Last day'], ['week', 'Last week'], ['month', 'Last month'], ['3m', 'Last 3 months']];

function filtersHTML(f) {
  const all = state.rounds;
  const opsSet = [...new Set(all.map((r) => opsKey(r.ops)))].sort();
  const fpMap = new Map();
  all.forEach((r) => fpMap.set(r.fp, { label: r.label, ts: r.ts }));
  const fps = [...fpMap.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 40);
  const sel = (key, value, opts) =>
    `<select data-filter="${key}" aria-label="Filter by ${key}">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(value) === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const withCurrent = (list, v, text) => (v !== 'all' && !list.some(([x]) => String(x) === String(v)) ? list.concat([[v, text]]) : list);
  return `<div class="chips" role="group" aria-label="Date range">${RANGES.map(([v, t]) => `<button type="button" class="btn small" data-act="range" data-v="${v}" aria-pressed="${f.range === v}">${t}</button>`).join('')}</div>
  <div class="filters">
    <label>Mode ${sel('mode', f.mode, [['all', 'All'], ['n', 'Normal'], ['k', 'Killer']])}</label>
    <label>Duration ${sel('dur', f.dur, [['all', 'All']].concat(DURATIONS.map((d) => [d, d + ' s'])))}</label>
    <label>Operations ${sel('ops', f.ops, withCurrent([['all', 'All']].concat(opsSet.map((k) => [k, opsLabel(k)])), f.ops, opsLabel(f.ops === 'all' ? '' : f.ops)))}</label>
    <label>Settings ${sel('fp', f.fp, withCurrent([['all', 'All']].concat(fps.map(([k, v]) => [k, v.label])), f.fp, f.fp))}</label>
    <button type="button" class="btn small" data-act="current">Current settings</button>
    ${state.presetOpen
      ? '<input type="text" id="preset-name" maxlength="30" placeholder="Preset name" aria-label="Preset name"><button type="button" class="btn small primary" data-act="preset-save">Save</button>'
      : '<button type="button" class="btn small" data-act="preset-open">Save as preset</button>'}
  </div>
  ${state.prefs.presets.length ? `<div class="presets" aria-label="Saved presets">${state.prefs.presets.map((p, i) => `<span class="chip-x"><button type="button" class="btn small" data-act="preset" data-i="${i}">${esc(p.name)}</button><button type="button" class="btn small" data-act="preset-del" data-i="${i}" aria-label="Delete preset ${esc(p.name)}">×</button></span>`).join('')}</div>` : ''}`;
}

function summaryHTML(rows) {
  const s = summarize(rows);
  const pb = pbByDuration(rows);
  let h = `<h2>Personal bests</h2><div class="pbs">${DURATIONS.map((d) => (pb[d]
    ? `<div class="pb"><span>${d} seconds</span><b>${pb[d].spm.toFixed(1)}</b><small>per min · ${pb[d].score} solved · ${Math.round(pb[d].acc)}%</small></div>`
    : `<div class="pb"><span>${d} seconds</span><b>–</b><small>no rounds</small></div>`)).join('')}</div>`;
  h += `<h2>Summary</h2><div class="kv">
    <div><span>Rounds started</span><b>${s.started}</b></div>
    <div><span>Rounds completed</span><b>${s.completed}${s.started ? ` (${Math.round(s.completedPct)}%)` : ''}</b><span>${s.restartsPerCompleted.toFixed(1)} quits per completed round</span></div>
    <div><span>Time practising</span><b>${hms(s.timeSec)}</b></div>
    <div><span>Problems solved</span><b>${s.solved}</b></div></div>`;
  const row = (name, t, fmt) => `<tr><th scope="row">${name}</th><td>${fmt(t.high)}</td><td>${fmt(t.avg)}</td><td>${fmt(t.last10)}</td></tr>`;
  h += `<div class="scroll"><table class="matrix"><thead><tr><th scope="col"></th><th scope="col">Highest</th><th scope="col">Average</th><th scope="col">Last 10 rounds</th></tr></thead><tbody>
    ${row('Solves per minute', s.spm, f1)}${row('Raw per minute (wrong tries included)', s.rawSpm, f1)}${row('Accuracy', s.acc, pct1)}${row('Consistency', s.cons, pct0)}</tbody></table></div>`;
  return h;
}

function chartsHTML(rows, allRows) {
  const done = rows.filter((r) => r.completed && r.score > 0);
  const t = state.toggles;
  const spm = done.map((r) => r.spm);
  const tr = trendInfo(rows);
  const trendText = !tr.ready
    ? `A trend appears after ${tr.need} completed rounds (you have ${tr.have}). Before that, one lucky or unlucky round can make a trend look much bigger than it is.`
    : tr.dir === 'flat' ? 'Your last 10 rounds are within 3% of the 10 before them: a plateau.'
    : `Your last 10 rounds are <span class="${tr.dir === 'up' ? 'good' : 'bad'}">${tr.dir === 'up' ? '▲' : '▼'} ${Math.abs(tr.pct).toFixed(0)}% ${tr.dir === 'up' ? 'faster' : 'slower'}</span> than the 10 before them.`;
  const toggle = (k, label) => `<button type="button" class="btn small" data-act="toggle" data-k="${k}" aria-pressed="${t[k]}">${label}</button>`;
  let h = `<h2>Progress</h2><p>${trendText}</p>
    <div class="chips" role="group" aria-label="Chart lines">${toggle('speed', 'Speed dots')}${toggle('acc', 'Accuracy triangles')}${toggle('avg10', 'Average of 10')}${toggle('avg100', 'Average of 100')}</div>
    ${CH.historyChart(done, movingAverage(spm, 10), movingAverage(spm, 100), t)}`;
  const bin = Math.max(...spm, 0) < 60 ? 5 : Math.max(...spm, 0) < 150 ? 10 : 20;
  const hist = histogram(spm, bin);
  h += '<h2>Speed distribution</h2>' + (hist.length
    ? CH.barsChart({ bars: hist.map((b) => ({ label: `${b.lo}–${b.hi}`, v: b.count, title: `${b.lo}–${b.hi} per minute: ${b.count} round${b.count === 1 ? '' : 's'}` })), yLabelL: 'Rounds', label: 'Histogram of round speeds', xEvery: Math.ceil(hist.length / 8) })
    : '<p class="muted">Nothing to show yet.</p>');
  const days = dailyTotals(rows).slice(-45);
  h += '<h2>Daily practice</h2>' + CH.barsChart({
    bars: days.map((d) => ({ label: new Date(d.key + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), v: Math.round(d.minutes * 10) / 10, title: `${d.key}: ${d.minutes.toFixed(1)} min, ${d.rounds} round${d.rounds === 1 ? '' : 's'}` })),
    line: days.map((d) => d.avgSpm), yLabelL: 'Minutes practised', yLabelR: 'Average solves/min', label: 'Minutes practised per day with average speed', xEvery: Math.ceil(days.length / 8),
  });
  h += '<p class="muted small">Days use your own timezone. The dashed line is your average speed that day.</p>';
  h += `<h2>Calendar</h2>${CH.calendarChart(heatmapGrid(allRows, 26))}<p class="muted small">All your practice for the last 26 weeks, ignoring the filters above. Darker means more time that day, compared with your own busier days.</p>`;
  return h;
}

function analysisAreasHTML(rows) {
  const done = rows.filter((r) => r.completed && r.score > 0);
  let h = '';
  const W = weakTypes(typeAgg(rows)).slice(0, 5);
  h += '<h2>Weakest areas</h2>' + (W.length
    ? `<div class="scroll"><table><thead><tr><th scope="col">Type</th><th scope="col">Avg time</th><th scope="col">Wrong rate</th><th scope="col">Samples</th></tr></thead><tbody>${W.map((w) => { const [op, b] = w.k.split('|'); return `<tr><td>${esc(OPS[op])}: ${esc(b)}</td><td>${(w.avg / 1000).toFixed(2)}s</td><td>${Math.round((w.w / w.n) * 100)}%</td><td>${w.n}</td></tr>`; }).join('')}</tbody></table></div>`
    : '<p class="muted">Play a few more rounds and your weakest problem types appear here.</p>');
  const m = Math.min(10, Math.floor(done.length / 2));
  if (m >= 3) {
    const rowsOp = OP_KEYS.map((k) => {
      const f = mean(done.slice(0, m).map((r) => r.perOp[k]).filter(Boolean));
      const l = mean(done.slice(-m).map((r) => r.perOp[k]).filter(Boolean));
      return f && l ? `<tr><td>${esc(OPS[k])}</td><td>${(f / 1000).toFixed(2)}s</td><td>${(l / 1000).toFixed(2)}s</td><td>${faster(l, f)}</td></tr>` : '';
    }).join('');
    if (rowsOp) h += `<h2>Speed by operation: first ${m} vs last ${m} rounds</h2><div class="scroll"><table><thead><tr><th scope="col">Operation</th><th scope="col">First ${m}</th><th scope="col">Last ${m}</th><th scope="col">Change</th></tr></thead><tbody>${rowsOp}</tbody></table></div>`;
  }
  const E = errAgg(rows);
  const items = Object.keys(E).map((k) => {
    const e = E[k];
    const tot = e[0] + e[1] + e[2];
    if (tot < 3) return '';
    const top = Math.max(...e);
    return `<li>${esc(OPS[k])}: ${tot} wrong attempts, mostly ${top === e[0] ? 'off by a multiple of 10 (a dropped carry or borrow)' : top === e[1] ? 'off by 1 or 2 (small slips)' : 'far from the answer (a recall problem)'}.</li>`;
  }).join('');
  h += '<h2>Error review</h2>' + (items ? `<ul>${items}</ul>` : '<p class="muted">Not enough wrong attempts yet to see a pattern.</p>');
  h += `<h2>Times-table heatmap</h2>${CH.factsTable(state.facts)}<p class="muted small">Seconds per fact, from multiplication and division up to 12 × 12. Green is fast and red is slow, relative to your own fastest and slowest facts. A "!" marks facts you often get wrong. Not affected by the filters.</p>`;
  return h;
}

function tableHTML(rows) {
  const cols = [['ts', 'Date'], ['mode', 'Mode'], ['label', 'Settings'], ['score', 'Solved'], ['spm', 'Solves/min'], ['rawSpm', 'Raw/min'], ['acc', 'Accuracy'], ['cons', 'Consistency'], ['wrong', 'Wrong']];
  const { key, dir } = state.sort;
  const sorted = rows.slice().sort((a, b) => {
    const x = a[key] === null ? -1 : a[key];
    const y = b[key] === null ? -1 : b[key];
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
  const shown = sorted.slice(0, state.rows);
  const head = cols.map(([k, t]) => `<th scope="col" aria-sort="${k === key ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-act="sort" data-k="${k}">${t}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('') + '<th scope="col"><span class="sr">Delete</span></th>';
  const body = shown.map((r) => {
    const ok = r.completed;
    const confirming = state.confirm['del:' + r.id];
    return `<tr><td>${new Date(r.ts).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${r.mode === 'k' ? 'Killer' : 'Normal'}</td><td>${esc(r.label)}</td><td>${r.score}</td>${ok
      ? `<td>${r.spm.toFixed(1)}</td><td>${r.rawSpm.toFixed(1)}</td><td>${r.acc.toFixed(1)}%</td><td>${r.cons === null ? '–' : Math.round(r.cons) + '%'}</td><td>${r.wrong}</td>`
      : '<td colspan="5" class="muted">quit early</td>'}<td><button type="button" class="btn small" data-act="del" data-id="${esc(r.id)}" aria-label="Delete this round">${confirming ? 'Click again' : '✕'}</button></td></tr>`;
  }).join('');
  return `<h2>Rounds</h2><div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    ${sorted.length > shown.length ? `<p class="center"><button type="button" class="btn" data-act="more">Load more (${sorted.length - shown.length} left)</button></p>` : ''}`;
}

function dataHTML(rows) {
  const c = state.confirm;
  return `<h2>Your data</h2>
    <div class="actions">
      <button type="button" class="btn" data-act="csv"${rows.length ? '' : ' disabled'}>Export CSV (${rows.length} round${rows.length === 1 ? '' : 's'} shown)</button>
      <button type="button" class="btn" data-act="backup">Download backup</button>
      <button type="button" class="btn" data-act="import">Import backup</button>
      <button type="button" class="btn" data-act="reset">${c.reset ? 'Click again to erase everything' + (account.isSignedIn() ? ', including your cloud copy' : '') : 'Reset all data'}</button>
    </div>
    <input type="file" id="import-file" accept=".json,application/json" class="sr" tabindex="-1" aria-label="Choose a backup file">
    <div id="import-preview" role="status">${importPreviewHTML()}</div>
    <p class="muted small">CSV has one row per round with every metric, for your own spreadsheets. A backup restores everything, including the times-table facts.</p>`;
}

function importPreviewHTML() {
  const p = state.importPreview;
  if (state.notice) return `<div class="preview">${esc(state.notice)}</div>`;
  if (!p) return '';
  if (!p.ok) return `<div class="preview"><b>This file cannot be imported.</b> ${esc(p.error)} Nothing was changed.</div>`;
  return `<div class="preview"><p>Found <b>${p.rounds.length}</b> round${p.rounds.length === 1 ? '' : 's'} from ${dayShort(p.from)} to ${dayShort(p.to)} (${esc(p.kind)} backup)${p.skipped ? `, and skipped ${p.skipped} unusable entr${p.skipped === 1 ? 'y' : 'ies'}` : ''}. Nothing has been changed yet.</p>
    <div class="actions"><button type="button" class="btn primary" data-act="import-merge">Add to my data</button>
    <button type="button" class="btn" data-act="import-replace">${state.confirm.replace ? 'Click again to replace everything' + (account.isSignedIn() ? ' and your cloud copy' : '') : 'Replace my data' + (account.isSignedIn() ? ' and cloud copy' : '')}</button>
    <button type="button" class="btn" data-act="import-cancel">Cancel</button></div>
    <p class="muted small">"Add" keeps what you have and skips rounds you already have. "Replace" erases your current data first.</p></div>`;
}

function renderStats() {
  const f = state.prefs.filters;
  const rows = applyFilters(state.rounds, f);
  let h = '';
  if (!state.rounds.length) {
    h = '<div class="empty">No rounds yet. Play one and your stats appear here, or import a backup below.</div>';
  } else {
    h = filtersHTML(f);
    h += rows.length ? summaryHTML(rows) + chartsHTML(rows, state.rounds) + analysisAreasHTML(rows) + tableHTML(rows) : '<div class="empty">No rounds match these filters.</div>';
  }
  $('st-body').innerHTML = h + dataHTML(rows);
}

function rerender() {
  const y = window.scrollY;
  renderStats();
  window.scrollTo(0, y);
}

function setFilters(patch) {
  state.prefs.filters = DB.cleanFilters({ ...state.prefs.filters, ...patch });
  DB.savePrefs(state.prefs);
  state.rows = 25;
  rerender();
}

function twoStep(key, afterMs = 4000) {
  if (state.confirm[key]) {
    delete state.confirm[key];
    return true;
  }
  state.confirm[key] = true;
  setTimeout(() => {
    if (state.confirm[key]) {
      delete state.confirm[key];
      if (state.view === 'stats') rerender();
    }
  }, afterMs);
  return false;
}

// Heatmap facts = the older running total (base) plus the facts each round carries.
function refreshFacts() {
  state.facts = mergeFacts(state.baseFacts, factsOf(state.rounds));
}

async function reloadData() {
  state.rounds = await DB.getAllRounds();
  state.baseFacts = await DB.getFacts();
  refreshFacts();
}

async function onStatsClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  state.notice = '';
  if (act === 'range') return setFilters({ range: t.dataset.v });
  if (act === 'current') return setFilters({ fp: fingerprint(state.cfg), dur: 'all', ops: 'all' });
  if (act === 'toggle') { state.toggles[t.dataset.k] = !state.toggles[t.dataset.k]; return rerender(); }
  if (act === 'sort') {
    const k = t.dataset.k;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 };
    return rerender();
  }
  if (act === 'more') { state.rows += 25; return rerender(); }
  if (act === 'preset-open') { state.presetOpen = true; rerender(); const i = $('preset-name'); if (i) i.focus(); return; }
  if (act === 'preset-save') {
    const name = ($('preset-name').value || '').replace(/[<>&"']/g, '').trim().slice(0, 30);
    if (!name) return $('preset-name').focus();
    state.prefs.presets = state.prefs.presets.concat([{ name, filters: { ...state.prefs.filters } }]).slice(-12);
    DB.savePrefs(state.prefs);
    state.presetOpen = false;
    return rerender();
  }
  if (act === 'preset') {
    const p = state.prefs.presets[Number(t.dataset.i)];
    return p && setFilters(p.filters);
  }
  if (act === 'preset-del') {
    state.prefs.presets.splice(Number(t.dataset.i), 1);
    DB.savePrefs(state.prefs);
    return rerender();
  }
  if (act === 'csv') return download(toCSV(applyFilters(state.rounds, state.prefs.filters)), 'flashquant-rounds.csv', 'text/csv');
  if (act === 'backup') return download(await DB.backupText(), `flashquant-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  if (act === 'import') return $('import-file').click();
  if (act === 'import-cancel') { state.importPreview = null; return rerender(); }
  if (act === 'import-merge' || act === 'import-replace') {
    if (act === 'import-replace' && !twoStep('replace')) return rerender();
    if (act === 'import-replace') {
      const gone = await account.deleteCloud();
      if (!gone.ok) {
        state.notice = 'Nothing was replaced, because your cloud copy could not be cleared: ' + gone.message;
        state.importPreview = null;
        return rerender();
      }
    }
    const res = await DB.applyBackup(state.importPreview, act === 'import-replace' ? 'replace' : 'merge');
    await reloadData();
    state.importPreview = null;
    state.notice = res.ok ? `Done. ${res.added} round${res.added === 1 ? '' : 's'} added, ${res.total} in total.` : `The import did not finish: ${res.error || 'storage error'}`;
    updateBanner();
    account.syncNow();
    return rerender();
  }
  if (act === 'reset') {
    if (!twoStep('reset')) return rerender();
    const gone = await account.deleteCloud();
    if (!gone.ok) {
      state.notice = 'Nothing was erased, because your cloud copy could not be deleted: ' + gone.message;
      return rerender();
    }
    await DB.clearAll();
    state.rounds = [];
    state.baseFacts = {};
    state.facts = {};
    state.prefs = DB.loadPrefs();
    state.cfg = DB.loadSettings();
    state.notice = 'All data was erased.';
    return rerender();
  }
  if (act === 'del') {
    if (!twoStep('del:' + t.dataset.id)) return rerender();
    await DB.deleteRound(t.dataset.id);
    state.rounds = state.rounds.filter((r) => r.id !== t.dataset.id);
    refreshFacts();
    if (!(await account.deleteRound(t.dataset.id))) state.notice = 'Deleted here, but the cloud copy could not be removed (you may be offline). It can reappear after the next sync.';
    return rerender();
  }
}

async function onStatsChange(e) {
  const t = e.target;
  if (t.matches('[data-filter]')) {
    const k = t.dataset.filter;
    return setFilters({ [k]: k === 'dur' && t.value !== 'all' ? Number(t.value) : t.value });
  }
  if (t.id === 'import-file') {
    const file = t.files && t.files[0];
    t.value = '';
    if (!file) return;
    state.notice = '';
    state.confirm = {};
    state.importPreview = file.size > 25e6 ? { ok: false, error: 'That file is too large to be a FlashQuant backup.' } : DB.parseBackup(await file.text());
    $('import-preview').innerHTML = importPreviewHTML();
  }
}

/* ---------- init ---------- */

function bind() {
  $('settings').addEventListener('change', onSettingsChange);
  $('settings').addEventListener('submit', (e) => e.preventDefault());
  $('btn-start').addEventListener('click', () => startGame('n'));
  $('btn-kill').addEventListener('click', () => startGame('k'));
  $('btn-abort').addEventListener('click', abortRound);
  $('btn-ghost').addEventListener('click', () => {
    state.prefs.ghost = !state.prefs.ghost;
    DB.savePrefs(state.prefs);
    $('btn-ghost').textContent = state.prefs.ghost ? 'Hide ghost' : 'Show ghost';
    if (!state.prefs.ghost) $('g-ghost').textContent = '';
    $('g-ans').focus({ preventScroll: true });
  });
  const ans = $('g-ans');
  ans.addEventListener('input', () => {
    const digits = ans.value.replace(/\D/g, '');
    if (digits !== ans.value) ans.value = digits;
    const r = state.game && state.game.input(digits);
    if (!r) return;
    if (r.state === 'solved' || r.state === 'wrong') ans.value = '';
    if (r.state === 'wrong') {
      ans.classList.remove('shake');
      void ans.offsetWidth;
      ans.classList.add('shake');
    }
    ans.classList.toggle('off', r.state === 'off-track');
  });
  // Keep the keyboard up while a round runs, but never trap keyboard users who tab to another control.
  ans.addEventListener('blur', (e) => {
    if (e.relatedTarget === null && state.game && state.game.isRunning()) {
      setTimeout(() => state.game && state.game.isRunning() && ans.focus({ preventScroll: true }), 30);
    }
  });
  $('v-game').addEventListener('pointerdown', (e) => {
    if (!e.target.closest('button')) setTimeout(() => ans.focus({ preventScroll: true }), 0);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.game && state.game.isRunning()) abortRound();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.game && state.game.isRunning()) state.game.poll();
  });
  $('btn-again').addEventListener('click', () => startGame(state.mode));
  $('an-again').addEventListener('click', () => startGame(state.mode));
  $('btn-back').addEventListener('click', () => go('#/'));
  $('an-back').addEventListener('click', () => show('result'));
  $('btn-analyze').addEventListener('click', () => {
    const L = state.last;
    $('an-body').innerHTML = analysisHTML({ rec: L.record, log: L.log, wrongAt: L.wrongAt, history: L.history, before: L.before, killerReady: killerReady() });
    show('analysis');
  });
  $('btn-copy').addEventListener('click', function () {
    const r = state.last.record;
    const text = `I solved ${r.score} in ${r.dur}s (${r.spm.toFixed(1)} per minute, ${Math.round(r.acc)}% accuracy)${r.mode === 'k' ? ' in Killer mode' : ''} on FlashQuant`;
    const btn = this;
    try {
      navigator.clipboard.writeText(text).then(() => (btn.textContent = 'Copied!'), () => (btn.textContent = text));
    } catch (e) {
      btn.textContent = text;
    }
  });
  [$('nav-play'), $('nav-stats'), document.querySelector('.brand')].forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (state.game && state.game.isRunning()) return;
      go(a.getAttribute('href'));
    }));
  $('st-body').addEventListener('click', onStatsClick);
  $('st-body').addEventListener('change', onStatsChange);
  window.addEventListener('hashchange', route);
}

async function init() {
  $('btn-start').disabled = true;
  $('btn-kill').disabled = true;
  state.prefs = DB.loadPrefs();
  state.cfg = DB.loadSettings();
  bind();
  try { await DB.migrateLegacy(); } catch (e) { /* the old data stays untouched in localStorage */ }
  await reloadData();
  state.rot = await DB.getMeta('trickRot', 0);
  $('btn-start').disabled = false;
  route();
  account.init();
}

init();
