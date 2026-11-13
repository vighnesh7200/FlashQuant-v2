// FlashQuant post-round analysis. Pure: takes data, returns an HTML string. Everything dynamic is escaped.

import { OPS, esc, mean, median, trendInfo } from './core.js';
import { pacingChart, paceBars } from './charts.js';

const sec = (ms) => (ms / 1000).toFixed(2) + 's';
const tbl = (head, rows) =>
  '<div class="scroll"><table><thead><tr>' + head.map((h) => `<th scope="col">${h}</th>`).join('') + '</tr></thead><tbody>' +
  rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
const lab = (k) => { const [op, b] = k.split('|'); return esc(`${OPS[op]}: ${b}`); };
const good = (t) => `<span class="good">${t}</span>`;
const bad = (t) => `<span class="bad">${t}</span>`;
const faster = (now, before) => {
  if (!now || !before) return '–';
  const p = Math.round((Math.abs(now - before) / before) * 100);
  return p === 0 ? 'same' : now < before ? good(`▲ ${p}% faster`) : bad(`▼ ${p}% slower`);
};

// Reference time for each problem: median of its own type, falling back to its operation, then the whole round.
export function refTimes(log) {
  const byType = {};
  const byOp = {};
  log.forEach((r) => {
    (byType[r.op + '|' + r.bucket] = byType[r.op + '|' + r.bucket] || []).push(r.time);
    (byOp[r.op] = byOp[r.op] || []).push(r.time);
  });
  const all = median(log.map((r) => r.time));
  return (r) => {
    const t = byType[r.op + '|' + r.bucket];
    const o = byOp[r.op];
    return t.length >= 3 ? median(t) : o.length >= 3 ? median(o) : all;
  };
}

// Stalls are judged against the problem's own type, so a hard problem that takes a while is not a "stall".
export function stallStats(log) {
  const ref = refTimes(log);
  let lost = 0;
  let count = 0;
  let run = 0;
  let runMs = 0;
  let bestRun = 0;
  let bestMs = 0;
  const rows = [];
  log.forEach((r) => {
    const m = ref(r);
    if (r.time > m * 2 && r.time - m > 1500) {
      count++;
      lost += r.time - m;
      rows.push(r);
    }
    if (r.time > m * 1.5 && r.time - m > 800) {
      run++;
      runMs += r.time;
      if (run > bestRun) { bestRun = run; bestMs = runMs; }
    } else { run = 0; runMs = 0; }
  });
  return { count, lost, bestRun, bestMs };
}

export function quarters(log, dur) {
  const Q = [[], [], [], []];
  log.forEach((r) => Q[Math.min(3, Math.floor(r.at / ((dur * 1000) / 4)))].push(r));
  return Q.map((l) => ({ n: l.length, avg: l.length ? mean(l.map((r) => r.time)) : null, wrong: l.reduce((p, r) => p + r.wrong, 0) }));
}

function advice({ rec, log, history, before, killerReady }) {
  const A = [];
  const D = rec.dur * 1000;
  const overall = mean(log.map((r) => r.time));
  const ref = refTimes(log);

  // 1. Biggest time sink, by type
  const T = {};
  log.forEach((r) => { const k = r.op + '|' + r.bucket; const t = T[k] || (T[k] = { n: 0, t: 0 }); t.n++; t.t += r.time; });
  let best = null;
  Object.keys(T).forEach((k) => {
    const b = T[k];
    if (b.n < 3) return;
    const x = (b.t / b.n - overall) * b.n;
    if (x > 2000 && (!best || x > best.x)) best = { k, x, a: b.t / b.n };
  });
  if (best) A.push(`<b>Biggest time sink:</b> ${lab(best.k)} averaged ${sec(best.a)} against ${sec(overall)} overall and cost about ${sec(best.x)} this round. Practise this type first.`);

  // 2. Accuracy: the operation with the highest error rate, with a diagnosis from how far off the answers were
  const roundWrong = rec.wrong;
  let wk = null;
  Object.keys(OPS).forEach((op) => {
    const l = log.filter((r) => r.op === op);
    const w = l.reduce((p, r) => p + r.wrong, 0);
    if (w >= 3 && (!wk || w / (l.length + w) > wk.r)) wk = { op, w, r: w / (l.length + w) };
  });
  if (wk && roundWrong >= 3) {
    const e = rec.errKinds[wk.op] || [0, 0, 0];
    const tot = e[0] + e[1] + e[2];
    const why = tot < 3 ? 'Keep an eye on this one.'
      : e[0] / tot > 0.4 ? 'Many errors were off by a multiple of 10, which points to a dropped carry or borrow. Settle the tens digit first.'
      : e[1] / tot > 0.4 ? 'Many errors were off by 1 or 2, so glance at the units digit before you commit.'
      : 'Most errors were far from the answer, so drill the underlying facts before chasing speed.';
    A.push(`<b>Accuracy:</b> ${esc(OPS[wk.op])} had the highest error rate this round (${Math.round(wk.r * 100)}%). ${why}`);
  }

  // 3. Stalls, only when they actually cost something
  const st = stallStats(log);
  if (st.count >= 3 && st.lost > D * 0.05) A.push(`<b>Stalls:</b> ${st.count} problems took more than twice what is normal for their type and cost ${sec(st.lost)} (${Math.round((st.lost / D) * 100)}% of the round). Find them in the slowest list below.`);

  // 4. Stamina / warm-up, only with enough problems per quarter to mean something
  if (log.length >= 40) {
    const q = quarters(log, rec.dur);
    if (q[0].avg && q[3].avg) {
      if (q[3].avg > q[0].avg * 1.2) A.push('<b>Stamina:</b> you slow down late in the round. Practise longer durations to build endurance.');
      else if (q[0].avg > q[3].avg * 1.2) A.push('<b>Warm-up:</b> your first quarter is your slowest. Do a few easy problems before you press Start.');
    }
  }

  // 5. Plateau, only with enough rounds at these exact settings
  const tr = trendInfo(history.concat([rec]), 20);
  if (tr.ready && tr.dir === 'flat') A.push('<b>Plateau:</b> your last 10 rounds are within 3% of the 10 before them. Try Killer mode to work on weak spots instead of repeating the same mix.');

  if (!A.length) A.push('This was a clean round. Widen your ranges or try a longer duration.');
  A.push(`<b>Next step:</b> ${killerReady ? 'play a Killer round to attack your weak spots directly.' : 'play a few more normal rounds to unlock Killer mode.'}`);
  return A;
}

// opts: { rec, log, wrongAt, history (earlier completed rounds at the same settings), before (typeAgg of earlier rounds), killerReady }
export function analysisHTML({ rec, log, wrongAt, history, before, killerReady }) {
  if (!log.length) return '<h1>Analysis</h1><p>No problems were solved in this round.</p>';
  const T = log.map((r) => r.time);
  const md = median(T);
  const prevBest = history.reduce((p, r) => Math.max(p, r.spm), 0);
  const prev10 = history.slice(-10);

  let h = `<h1>Analysis</h1><div class="tiles">
    <div class="tile"><span>Solves/min</span><b>${rec.spm.toFixed(1)}</b></div>
    <div class="tile"><span>Raw/min</span><b>${rec.rawSpm.toFixed(1)}</b></div>
    <div class="tile"><span>Accuracy</span><b>${rec.acc.toFixed(1)}%</b></div>
    <div class="tile"><span>Consistency</span><b>${rec.cons === null ? '–' : Math.round(rec.cons) + '%'}</b></div>
    <div class="tile"><span>Solved</span><b>${rec.score}</b></div>
    <div class="tile"><span>Wrong tries</span><b>${rec.wrong}</b></div></div>`;
  h += `<p class="muted small">Settings: ${esc(rec.label)}. Median time ${sec(md)}, average ${sec(mean(T))}.</p>`;
  if (history.length) {
    h += `<p>${rec.spm > prevBest ? good('New personal best') + ` for these settings (previous best ${prevBest.toFixed(1)}/min).` : rec.spm === prevBest ? 'You matched your best for these settings.' : `Your best for these settings is ${prevBest.toFixed(1)}/min, ${(prevBest - rec.spm).toFixed(1)} ahead of this round.`} Average of your previous ${prev10.length} round${prev10.length === 1 ? '' : 's'} here: <b>${mean(prev10.map((r) => r.spm)).toFixed(1)}</b>/min.</p>`;
  } else h += '<p class="muted">This is your first round with these exact settings, so there is nothing to compare against yet.</p>';

  h += `<h2>Pace</h2><p class="muted small">Solid line: running average. Dashed line: rolling 5-second speed. Crosses mark wrong attempts.</p>${pacingChart(log, rec.dur, wrongAt)}`;
  h += `<h2>Pace by 10 seconds</h2><p class="muted small">Problems solved in each 10-second slice. Dips show where you stalled or tired.</p>${paceBars(log, rec.dur)}`;
  h += `<h2>What to fix next</h2><ol class="advice"><li>${advice({ rec, log, history, before, killerReady }).join('</li><li>')}</li></ol>`;

  // By operation, compared with your earlier rounds at the same settings
  const ops = Object.keys(OPS).filter((k) => log.some((r) => r.op === k));
  const overall = mean(T);
  const overallWrong = rec.wrong / (log.length + rec.wrong);
  h += '<h2>Speed and accuracy by operation</h2>' + tbl(['Operation', 'Solved', 'Avg time', 'Median', 'Accuracy', 'Verdict', 'Vs your usual'], ops.map((k) => {
    const l = log.filter((r) => r.op === k);
    const w = l.reduce((p, r) => p + r.wrong, 0);
    const a = mean(l.map((r) => r.time));
    const e = w / (l.length + w);
    const prior = history.map((r) => r.perOp[k]).filter(Boolean);
    const verdict = ops.length < 2 ? '–' : (a <= overall ? 'Fast' : 'Slow') + (e <= overallWrong ? ' and accurate' : a <= overall ? ' but sloppy' : ' and error-prone');
    return [esc(OPS[k]), l.length, sec(a), sec(median(l.map((r) => r.time))), Math.round((1 - e) * 100) + '%', verdict, prior.length ? faster(a, mean(prior)) : 'no earlier rounds'];
  }));

  // By difficulty
  const B = {};
  log.forEach((r) => { const k = r.op + '|' + r.bucket; const b = B[k] || (B[k] = { n: 0, t: 0, w: 0 }); b.n++; b.t += r.time; b.w += r.wrong; });
  h += '<h2>Speed by difficulty</h2>' + tbl(['Type', 'Solved', 'Avg time', 'Wrong'], Object.keys(B).sort((a, b) => B[b].t / B[b].n - B[a].t / B[a].n).map((k) => [lab(k), B[k].n, sec(B[k].t / B[k].n), B[k].w]));

  // Killer comparison
  if (rec.mode === 'k') {
    h += '<h2>Killer mode: before and now</h2>' + tbl(['Type', 'Before', 'This round'], Object.keys(B).map((k) => [lab(k), before[k] ? sec(before[k][1] / before[k][0]) : '–', sec(B[k].t / B[k].n)]));
    h += '<p class="muted small">Killer rounds only give you your weak types, so compare these numbers with the same type in normal rounds, not with the overall average.</p>';
  }

  // Stalls and consistency
  const st = stallStats(log);
  h += '<h2>Consistency and stalls</h2>' + tbl(['Measure', 'Value'], [
    ['Consistency', rec.cons === null ? 'Not enough problems yet' : `${Math.round(rec.cons)}% (judged within each problem type, so mixing easy and hard types is not penalised)`],
    ['Stalls (over 2× normal for the type)', `${st.count} problem${st.count === 1 ? '' : 's'}`],
    ['Time lost to stalls', `${sec(st.lost)} (${Math.round((st.lost / (rec.dur * 1000)) * 100)}% of the round)`],
    ['Longest slow streak', st.bestRun ? `${st.bestRun} in a row, ${sec(st.bestMs)} in total` : 'none'],
  ]);

  // Fatigue
  if (log.length >= 40) {
    const q = quarters(log, rec.dur);
    const mx = Math.max(...q.map((x) => x.avg || 0), 1);
    h += '<h2>Fatigue curve</h2>' + tbl(['Quarter', 'Solved', 'Avg time', 'Wrong', ''], q.map((x, i) => [`Q${i + 1}`, x.n, x.avg ? sec(x.avg) : '–', x.wrong, `<div class="meter"><i style="width:${Math.round(((x.avg || 0) / mx) * 100)}%"></i></div>`]));
  } else h += '<h2>Fatigue curve</h2><p class="muted">Needs at least 40 solved problems in a round to say anything reliable. Try a longer duration.</p>';

  // Slowest
  h += '<h2>10 slowest problems</h2>' + tbl(['Problem', 'Type', 'Time', 'Wrong tries'], log.slice().sort((a, b) => b.time - a.time).slice(0, 10).map((r) => [esc(r.text), esc(r.bucket), sec(r.time), r.wrong]));

  // Errors
  const ek = Object.keys(rec.errKinds);
  if (ek.length) h += '<h2>How far off were your mistakes?</h2>' + tbl(['Operation', 'Off by 10, 20…', 'Off by 1 or 2', 'Further off'], ek.map((k) => [esc(OPS[k]), ...rec.errKinds[k]]));
  return h;
}

