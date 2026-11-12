import assert from 'node:assert/strict';
import * as C from './core.js';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log('ok  ' + name);
};

// deterministic rng
const seeded = (s) => () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);

t('normalizeConfig repairs bad input', () => {
  const c = C.normalizeConfig({ ops: [], a: [100, 2, 'x', -5], m: [0, 0, 0, 0], dur: 77 });
  assert.deepEqual(c.ops, ['a']);
  assert.ok(c.a[0] <= c.a[1] && c.a[2] <= c.a[3]);
  assert.ok(c.a[2] >= 0);
  assert.equal(c.m[0], 1); // divisor can never be 0
  assert.equal(c.dur, 120);
});

t('no problem is ever unanswerable (0 ÷ 0)', () => {
  const cfg = C.normalizeConfig({ ops: ['m', 'd'], m: [0, 0, 0, 0], dur: 30 });
  const rng = seeded(7);
  for (let i = 0; i < 2000; i++) {
    const p = C.randomProblem(cfg, rng);
    assert.ok(Number.isInteger(p.answer) && p.answer > 0, p.text);
  }
});

t('problem answers are correct for every op', () => {
  assert.equal(C.makeProblem('a', 38, 47).answer, 85);
  assert.equal(C.makeProblem('s', 38, 47).text, '85 − 38');
  assert.equal(C.makeProblem('s', 38, 47).answer, 47);
  assert.equal(C.makeProblem('m', 7, 8).answer, 56);
  assert.equal(C.makeProblem('d', 7, 8).text, '56 ÷ 7');
  assert.equal(C.makeProblem('d', 7, 8).answer, 8);
});

t('carry and borrow buckets', () => {
  assert.equal(C.bucketOf('a', 12, 13), 'No carry');
  assert.equal(C.bucketOf('a', 18, 17), '1 carry');
  assert.equal(C.bucketOf('a', 58, 67), '2+ carries'); // 8+7 carries, 5+6+1 carries
  assert.equal(C.bucketOf('s', 25, 10), 'No borrow'); // 35 - 25
  assert.equal(C.bucketOf('s', 28, 17), '1 borrow'); // 45 - 28
  assert.equal(C.bucketOf('m', 7, 8), 'Product under 100');
  assert.equal(C.bucketOf('m', 12, 99), 'Product 1000+');
});

t('fingerprint ignores ranges of unused ops', () => {
  const a = C.normalizeConfig({ ops: ['a'], a: [2, 100, 2, 100], m: [2, 12, 2, 100], dur: 60 });
  const b = C.normalizeConfig({ ops: ['a'], a: [2, 100, 2, 100], m: [3, 9, 3, 9], dur: 60 });
  const c = C.normalizeConfig({ ops: ['a'], a: [2, 50, 2, 100], m: [2, 12, 2, 100], dur: 60 });
  assert.equal(C.fingerprint(a), C.fingerprint(b));
  assert.notEqual(C.fingerprint(a), C.fingerprint(c));
});

t('roundMetrics: spm, raw spm, accuracy', () => {
  const log = Array.from({ length: 20 }, (_, i) => ({ op: 'a', bucket: 'No carry', time: 1500, wrong: i < 5 ? 1 : 0, at: (i + 1) * 1500, x: 1, y: 1 }));
  const m = C.roundMetrics(log, 60);
  assert.equal(m.score, 20);
  assert.equal(m.wrong, 5);
  assert.equal(m.spm, 20);
  assert.equal(m.rawSpm, 25);
  assert.equal(Math.round(m.acc), 80);
  assert.equal(m.perOp.a, 1500);
});

t('consistency: steady beats erratic, and mixing types is not punished', () => {
  const steady = Array.from({ length: 30 }, () => ({ op: 'a', bucket: 'x', time: 1500, wrong: 0, at: 0 }));
  const erratic = Array.from({ length: 30 }, (_, i) => ({ op: 'a', bucket: 'x', time: i % 2 ? 400 : 4000, wrong: 0, at: 0 }));
  const mixed = Array.from({ length: 30 }, (_, i) => ({ op: i % 2 ? 'a' : 'm', bucket: i % 2 ? 'easy' : 'hard', time: i % 2 ? 1000 : 3000, wrong: 0, at: 0 }));
  assert.ok(C.consistencyOf(steady) > 95);
  assert.ok(C.consistencyOf(erratic) < 50);
  assert.ok(C.consistencyOf(mixed) > 95);
  assert.equal(C.consistencyOf(steady.slice(0, 3)), null);
});

t('summarize: highest, average, last 10, started vs completed', () => {
  const mk = (i, spm, done = true) => ({ ts: 1000 + i, completed: done, score: done ? spm : 3, spm: done ? spm : 0, rawSpm: spm, acc: 90, cons: 70, elapsed: done ? 60 : 10, ops: ['a'], dur: 60 });
  const recs = [];
  for (let i = 0; i < 12; i++) recs.push(mk(i, 10 + i));
  recs.push(mk(100, 0, false), mk(101, 0, false));
  const s = C.summarize(recs);
  assert.equal(s.started, 14);
  assert.equal(s.completed, 12);
  assert.ok(Math.abs(s.restartsPerCompleted - 2 / 12) < 1e-9);
  assert.equal(s.spm.high, 21);
  assert.equal(s.spm.last10, (12 + 13 + 14 + 15 + 16 + 17 + 18 + 19 + 20 + 21) / 10);
  assert.equal(s.timeSec, 12 * 60 + 20);
});

t('moving average, histogram', () => {
  assert.deepEqual(C.movingAverage([2, 4, 6], 2), [2, 3, 5]);
  const h = C.histogram([3, 12, 14, 41], 10);
  assert.deepEqual(h.map((b) => b.count), [1, 2, 0, 0, 1]);
});

t('trend stays hidden until there is enough data', () => {
  const few = Array.from({ length: 10 }, (_, i) => ({ ts: i, completed: true, score: 5, spm: 10 }));
  assert.equal(C.trendInfo(few).ready, false);
  const many = Array.from({ length: 40 }, (_, i) => ({ ts: i, completed: true, score: 5, spm: i < 30 ? 10 : 12 }));
  const tr = C.trendInfo(many);
  assert.equal(tr.ready, true);
  assert.equal(tr.dir, 'up');
});

t('applyFilters', () => {
  const now = 10 * 86400000;
  const recs = [
    { ts: now - 100, mode: 'n', dur: 30, ops: ['a'], fp: 'f1' },
    { ts: now - 2 * 86400000, mode: 'k', dur: 60, ops: ['a', 'm'], fp: 'f2' },
    { ts: now - 40 * 86400000, mode: 'n', dur: 30, ops: ['a'], fp: 'f1' },
  ];
  assert.equal(C.applyFilters(recs, { range: 'day', now }).length, 1);
  assert.equal(C.applyFilters(recs, { range: 'week', now }).length, 2);
  assert.equal(C.applyFilters(recs, { mode: 'k' }).length, 1);
  assert.equal(C.applyFilters(recs, { dur: 30 }).length, 2);
  assert.equal(C.applyFilters(recs, { ops: 'am' }).length, 1);
  assert.equal(C.applyFilters(recs, { fp: 'f1' }).length, 2);
});

t('sanitizeRecord rejects junk and neutralises HTML', () => {
  assert.equal(C.sanitizeRecord(null), null);
  assert.equal(C.sanitizeRecord({}), null);
  assert.equal(C.sanitizeRecord({ dur: 0, ts: 5 }), null);
  const r = C.sanitizeRecord({
    ts: 1700000000000, dur: 60, score: 10, label: '<img src=x onerror=alert(1)>', fp: '<script>x</script>',
    perType: { 'a|<img onerror=1>': [1, 1, 1], 'a|Carry': [3, 900, 1], 'z|Carry': [1, 1, 1] },
    ops: ['a', 'zzz'],
  });
  assert.ok(!/[<>]/.test(r.label + r.fp));
  assert.deepEqual(Object.keys(r.perType), ['a|Carry']);
  assert.deepEqual(r.ops, ['a']);
});

t('migrateV1 converts old history', () => {
  const out = C.migrateV1([{ ts: 1700000000000, mode: 'n', dur: 120, score: 60, ops: { a: 1500, m: 2100 }, types: { 'a|Carry': [5, 1500, 2] } }, { bad: true }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].spm, 30);
  assert.equal(out[0].wrong, 2);
  assert.ok(Math.abs(out[0].acc - (60 / 62) * 100) < 1e-9);
});

t('toCSV escapes quotes and blocks formula injection', () => {
  const rec = C.sanitizeRecord({ ts: 1700000000000, dur: 60, score: 10, spm: 10, label: '=HYPERLINK("x")', perOp: { a: 1000 } });
  const csv = C.toCSV([rec]);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('"id","date_utc"'));
  assert.ok(!lines[1].includes('"=HYPERLINK'));
});

t('killer problems respect ops and ranges', () => {
  const cfg = C.normalizeConfig({ ops: ['a', 's'], a: [2, 100, 2, 100], dur: 60 });
  const agg = { 'a|2+ carries': [10, 30000, 3], 'a|No carry': [10, 8000, 0], 'm|Product 1000+': [10, 90000, 5] };
  const rng = seeded(3);
  for (let i = 0; i < 300; i++) {
    const p = C.killerProblem(cfg, agg, rng);
    assert.ok(p.op === 'a' || p.op === 's');
  }
  const weak = C.weakTypes(agg, cfg.ops);
  assert.equal(weak[0].k, 'a|2+ carries');
});

t('heatmap grid shape and levels', () => {
  const now = new Date(2026, 10, 12, 12).getTime();
  const g = C.heatmapGrid([{ ts: now, elapsed: 600 }], 26, now);
  assert.equal(g.length, 26);
  assert.ok(g.every((c) => c.length === 7));
  const flat = g.flat();
  const today = flat.find((d) => d.key === C.localDayKey(now));
  assert.ok(today.level >= 1);
  assert.ok(flat.some((d) => d.level === -1)); // future days are marked
});

console.log(`\n${passed} test groups passed`);
