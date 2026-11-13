// FlashQuant charts: plain SVG strings, themed through CSS variables. No libraries.

import { esc, mean, quantile } from './core.js';

const W = 640;
const H = 240;
const PAD = { l: 46, r: 46, t: 14, b: 30 };
const IW = W - PAD.l - PAD.r;
const IH = H - PAD.t - PAD.b;

function niceMax(v) {
  if (!(v > 0)) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1));
const lin = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

function frame({ yMaxL, yMaxR, yLabelL, yLabelR, xTicks, xLabel, label }) {
  const yl = lin(0, yMaxL, PAD.t + IH, PAD.t);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">`;
  for (let i = 0; i <= 4; i++) {
    const v = (yMaxL / 4) * i;
    const y = yl(v);
    s += `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}"/><text class="ax" x="${PAD.l - 6}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`;
    if (yMaxR) s += `<text class="ax" x="${W - PAD.r + 6}" y="${y + 4}">${fmt((yMaxR / 4) * i)}</text>`;
  }
  xTicks.forEach((t) => (s += `<text class="ax" x="${t.x}" y="${H - 10}" text-anchor="middle">${esc(t.label)}</text>`));
  if (yLabelL) s += `<text class="axt" transform="translate(11 ${PAD.t + IH / 2}) rotate(-90)" text-anchor="middle">${esc(yLabelL)}</text>`;
  if (yLabelR) s += `<text class="axt" transform="translate(${W - 8} ${PAD.t + IH / 2}) rotate(90)" text-anchor="middle">${esc(yLabelR)}</text>`;
  if (xLabel) s += `<text class="axt" x="${PAD.l + IW / 2}" y="${H - 0}" text-anchor="middle" dy="-0">${esc(xLabel)}</text>`;
  return { open: s, yl };
}

const poly = (pts, cls) => (pts.length > 1 ? `<polyline class="${cls}" fill="none" points="${pts.map((p) => p.map((n) => Math.round(n * 10) / 10).join(',')).join(' ')}"/>` : '');

// Pace series for one round: cumulative average and a rolling 5-second speed, both in solves per minute.
export function paceSeries(log, dur, win = 5) {
  const avg = [];
  const inst = [];
  const times = log.map((r) => r.at / 1000);
  const from = Math.min(5, Math.max(2, Math.floor(dur / 6)));
  for (let s = 1; s <= dur; s++) {
    const solved = times.filter((t) => t <= s).length;
    const w = Math.min(win, s);
    const recent = times.filter((t) => t > s - w && t <= s).length;
    inst.push({ x: s, y: (recent * 60) / w });
    if (s >= from) avg.push({ x: s, y: (solved * 60) / s });
  }
  return { avg, inst };
}

export function pacingChart(log, dur, wrongAt) {
  const { avg, inst } = paceSeries(log, dur);
  const top = niceMax(Math.max(10, ...avg.map((p) => p.y), ...inst.map((p) => p.y)) * 1.05);
  const step = dur <= 60 ? 10 : dur <= 120 ? 20 : dur <= 300 ? 60 : 120;
  const xs = lin(0, dur, PAD.l, PAD.l + IW);
  const xTicks = [];
  for (let t = 0; t <= dur; t += step) xTicks.push({ x: xs(t), label: t + 's' });
  const f = frame({ yMaxL: top, yLabelL: 'Solves per minute', xTicks, label: `Pace over the round: running average and rolling ${5}-second speed, with ${wrongAt.length} wrong attempts marked.` });
  let s = f.open;
  s += poly(inst.map((p) => [xs(p.x), f.yl(p.y)]), 'ln-b');
  s += poly(avg.map((p) => [xs(p.x), f.yl(p.y)]), 'ln-a');
  wrongAt.forEach((ms) => {
    const x = xs(Math.min(dur, ms / 1000));
    const y = PAD.t + IH - 6;
    s += `<path class="wrong-x" d="M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}"><title>Wrong attempt at ${(ms / 1000).toFixed(1)}s</title></path>`;
  });
  return s + '</svg>';
}

// Problems solved in each 10-second slice of the round, with the count above every bar.
export function paceBins(log, dur, slice = 10) {
  const nb = Math.max(1, Math.ceil(dur / slice));
  const bins = new Array(nb).fill(0);
  log.forEach((r) => { bins[Math.min(nb - 1, Math.floor(r.at / (slice * 1000)))]++; });
  return bins;
}

export function paceBars(log, dur) {
  const bins = paceBins(log, dur);
  const mx = Math.max(...bins, 1);
  const w = 640;
  const h = 150;
  const top = 20;
  const base = h - 24;
  const gap = 4;
  const bw = (w - gap * (bins.length - 1)) / bins.length;
  const avg = mean(bins);
  let s = `<svg class="chart pace" viewBox="0 0 ${w} ${h}" role="img" aria-label="Problems solved per 10 seconds: ${esc(bins.join(', '))}">`;
  bins.forEach((v, i) => {
    const bh = (v / mx) * (base - top);
    const x = i * (bw + gap);
    s += `<rect class="bar" x="${x}" y="${base - bh}" width="${bw}" height="${bh}" rx="2"><title>${i * 10}–${Math.min(dur, i * 10 + 10)}s: ${v} solved</title></rect><text class="ax cnt" x="${x + bw / 2}" y="${base - bh - 5}" text-anchor="middle">${v}</text>`;
  });
  s += `<text class="ax" x="0" y="${h - 6}">0s</text><text class="ax" x="${w}" y="${h - 6}" text-anchor="end">${dur}s</text>`;
  return s + '</svg>';
}

// History: one dot per round, with 10-round and 100-round averages. opts: { speed, acc, avg10, avg100 }
export function historyChart(rows, ma10, ma100, opts) {
  const n = rows.length;
  if (!n) return '<p class="muted">No rounds match these filters yet.</p>';
  const spm = rows.map((r) => r.spm);
  const top = niceMax(Math.max(...spm, ...ma10, 5) * 1.1);
  const xs = n === 1 ? () => PAD.l + IW / 2 : lin(1, n, PAD.l + 10, PAD.l + IW - 10);
  const ticks = [];
  const every = Math.max(1, Math.ceil(n / 8));
  for (let i = 1; i <= n; i += every) ticks.push({ x: xs(i), label: '#' + i });
  const f = frame({ yMaxL: top, yMaxR: opts.acc ? 100 : 0, yLabelL: 'Solves per minute', yLabelR: opts.acc ? 'Accuracy %' : '', xTicks: ticks, label: `History of ${n} rounds: speed${opts.acc ? ', accuracy' : ''}${opts.avg10 ? ', 10-round average' : ''}${opts.avg100 ? ', 100-round average' : ''}.` });
  const ya = lin(0, 100, PAD.t + IH, PAD.t);
  let s = f.open;
  if (opts.speed) rows.forEach((r, i) => (s += `<circle class="dot-a" cx="${xs(i + 1)}" cy="${f.yl(r.spm)}" r="3"><title>#${i + 1}: ${r.spm.toFixed(1)}/min, ${r.score} solved</title></circle>`));
  if (opts.acc) rows.forEach((r, i) => (s += `<path class="dot-b" d="M${xs(i + 1)} ${ya(r.acc) - 3.5}l3.5 6.5h-7z"><title>#${i + 1}: ${r.acc.toFixed(1)}% accuracy</title></path>`));
  if (opts.avg10 && opts.speed) s += poly(ma10.map((v, i) => [xs(i + 1), f.yl(v)]), 'ln-a');
  if (opts.avg100 && opts.speed && n > 10) s += poly(ma100.map((v, i) => [xs(i + 1), f.yl(v)]), 'ln-c');
  return s + '</svg>';
}

export function barsChart({ bars, line = null, yLabelL, yLabelR, label, xEvery = 1 }) {
  if (!bars.length) return '<p class="muted">Nothing to show yet.</p>';
  const top = niceMax(Math.max(...bars.map((b) => b.v), 1) * 1.1);
  const topR = line ? niceMax(Math.max(...line.filter((v) => v !== null), 1) * 1.1) : 0;
  const slot = IW / bars.length;
  const bw = Math.max(3, Math.min(48, slot * 0.7));
  const ticks = bars.map((b, i) => (i % xEvery === 0 ? { x: PAD.l + slot * (i + 0.5), label: b.label } : null)).filter(Boolean);
  const f = frame({ yMaxL: top, yMaxR: topR, yLabelL, yLabelR, xTicks: ticks, label });
  let s = f.open;
  bars.forEach((b, i) => {
    const x = PAD.l + slot * (i + 0.5) - bw / 2;
    const y = f.yl(b.v);
    s += `<rect class="bar" x="${x}" y="${y}" width="${bw}" height="${Math.max(0, PAD.t + IH - y)}" rx="2"><title>${esc(b.title || b.label + ': ' + fmt(b.v))}</title></rect>`;
  });
  if (line) {
    const yr = lin(0, topR, PAD.t + IH, PAD.t);
    const pts = [];
    line.forEach((v, i) => v !== null && pts.push([PAD.l + slot * (i + 0.5), yr(v)]));
    s += poly(pts, 'ln-b');
    pts.forEach((p) => (s += `<circle class="dot-b" cx="${p[0]}" cy="${p[1]}" r="2.5"/>`));
  }
  return s + '</svg>';
}

// Calendar heatmap in the viewer's own timezone. Monday is the first row.
export function calendarChart(cols) {
  const cell = 12;
  const gap = 3;
  const left = 30;
  const top = 18;
  const w = left + cols.length * (cell + gap);
  const h = top + 7 * (cell + gap);
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let s = `<svg class="cal" viewBox="0 0 ${w} ${h}" role="img" aria-label="Practice calendar for the last ${cols.length} weeks">`;
  names.forEach((n, d) => (s += `<text class="ax" x="${left - 6}" y="${top + d * (cell + gap) + cell - 2}" text-anchor="end">${n}</text>`));
  let lastMonth = -1;
  cols.forEach((col, i) => {
    const m = col[0].month;
    if (m !== lastMonth) {
      s += `<text class="ax" x="${left + i * (cell + gap)}" y="10">${months[m]}</text>`;
      lastMonth = m;
    }
    col.forEach((d, j) => {
      if (d.level < 0) return;
      const mins = d.sec / 60;
      s += `<rect class="cal-l${d.level}" x="${left + i * (cell + gap)}" y="${top + j * (cell + gap)}" width="${cell}" height="${cell}" rx="2"><title>${d.key}: ${d.sec ? (mins < 1 ? '<1' : Math.round(mins)) + ' min practised' : 'no practice'}</title></rect>`;
    });
  });
  return s + '</svg>';
}

// Times-table grid. Colour is relative to your own 10th and 90th percentile, so one slow tap cannot wash it out.
export function factsTable(facts) {
  const keys = Object.keys(facts).filter((k) => facts[k][0] > 0);
  if (!keys.length) return '<p class="muted">Multiplication and division facts (up to 12 × 12) appear here as you practise them.</p>';
  const avgs = keys.map((k) => facts[k][1] / facts[k][0]);
  const lo = quantile(avgs, 0.1);
  const hi = quantile(avgs, 0.9);
  let s = '<div class="scroll"><table class="hm"><thead><tr><th scope="col"><span class="sr">Row × column</span></th>';
  for (let i = 2; i <= 12; i++) s += `<th scope="col">${i}</th>`;
  s += '</tr></thead><tbody>';
  for (let i = 2; i <= 12; i++) {
    s += `<tr><th scope="row">${i}</th>`;
    for (let j = 2; j <= 12; j++) {
      const f = facts[Math.min(i, j) + '_' + Math.max(i, j)];
      if (!f || !f[0]) {
        s += '<td></td>';
        continue;
      }
      const v = f[1] / f[0];
      const t = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0;
      const err = f[2] / f[0];
      s += `<td style="background:hsl(${Math.round(125 - 125 * t)},62%,58%)" title="${i} × ${j}: ${(v / 1000).toFixed(2)}s average over ${f[0]} tries, ${f[2]} wrong">${(v / 1000).toFixed(1)}${err >= 0.25 ? '<b aria-label="often wrong">!</b>' : ''}</td>`;
    }
    s += '</tr>';
  }
  return s + '</tbody></table></div>';
}

export function sparkline(values) {
  if (values.length < 2) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = lin(0, values.length - 1, 2, 118);
  const y = lin(lo, hi === lo ? lo + 1 : hi, 26, 2);
  return `<svg class="spark" viewBox="0 0 120 28" aria-hidden="true">${poly(values.map((v, i) => [x(i), y(v)]), 'ln-a')}</svg>`;
}

