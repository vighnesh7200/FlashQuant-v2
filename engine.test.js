import assert from 'node:assert/strict';
import { createGame } from './engine.js';
import { tipFor, trickFor } from './tricks.js';
import { normalizeConfig, buildRecord, makeProblem } from './core.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok  ' + name); };

function harness(over = {}) {
  let clock = 1_000_000;
  const ev = { ticks: [], wrong: 0, ended: null, problems: [] };
  const cfg = normalizeConfig({ ops: ['a'], a: [10, 20, 10, 20], dur: 30, ...over.cfg });
  const g = createGame({
    cfg, mode: over.mode || 'n', now: () => clock,
    schedule: () => 1, unschedule: () => {},
    onTick: (x) => ev.ticks.push(x), onWrong: () => ev.wrong++, onProblem: (p) => ev.problems.push(p),
    onEnd: (r) => (ev.ended = r), ghostTimeline: over.ghost || null,
  });
  return { g, ev, adv: (ms) => { clock += ms; }, cfg };
}

t('solving advances score and logs time', () => {
  const { g, ev, adv } = harness();
  g.start();
  adv(1500);
  const ans = String(g.current().answer);
  assert.equal(g.input(ans).state, 'solved');
  assert.equal(g.solved(), 1);
  assert.equal(g.snapshot().log[0].time, 1500);
  assert.equal(ev.ended, null);
});

t('timer is a real deadline: a late poll ends the round on time', () => {
  const { g, ev, adv } = harness();
  g.start();
  adv(45_000); // tab was throttled for 45s
  g.poll();
  assert.ok(ev.ended);
  assert.equal(ev.ended.record.elapsed, 30);
  assert.equal(ev.ended.record.completed, true);
});

t('answers typed after the deadline are not counted', () => {
  const { g, ev, adv } = harness();
  g.start();
  adv(31_000);
  g.input(String(g.current().answer));
  assert.equal(ev.ended.record.score, 0);
});

t('wrong answer of full length counts once and clears the box', () => {
  const { g, ev } = harness();
  g.start();
  const a = g.current().answer;
  const wrong = String(a + 1).length === String(a).length ? String(a + 1) : String(a - 1);
  const r = g.input(wrong);
  assert.equal(r.state, 'wrong');
  assert.equal(r.value, '');
  assert.equal(ev.wrong, 1);
});

t('prefix of the right answer is not an error', () => {
  const { g } = harness({ cfg: { a: [60, 80, 60, 80] } }); // 3-digit answers
  g.start();
  const a = String(g.current().answer);
  assert.equal(g.input(a[0]).state, 'typing');
  assert.equal(g.input(a[0] + (a[1] === '9' ? '0' : String(Number(a[1]) + 1))).state, 'off-track');
});

t('unfinished wrong answer at the buzzer counts as a mistake', () => {
  const { g, ev, adv } = harness({ cfg: { a: [60, 80, 60, 80] } });
  g.start();
  const a = String(g.current().answer);
  g.input(a[0] === '9' ? '8' : String(Number(a[0]) + 1)); // wrong first digit, still typing
  adv(31_000);
  g.poll();
  assert.equal(ev.ended.record.wrong, 1);
});

t('abort records an unfinished round only if the player touched the keyboard', () => {
  const a = harness();
  a.g.start();
  const r1 = a.g.abort();
  assert.equal(r1.completed, false);
  assert.equal(r1.touched, false);
  const b = harness();
  b.g.start();
  b.g.input('1');
  const r2 = b.g.abort();
  assert.equal(r2.touched, true);
  assert.equal(r2.record.completed, false);
  assert.equal(r2.record.spm, 0);
});

t('no consecutive identical problems', () => {
  const { g, ev } = harness({ cfg: { a: [5, 6, 5, 6] } });
  g.start();
  for (let i = 0; i < 60; i++) g.input(String(g.current().answer));
  for (let i = 1; i < ev.problems.length; i++) assert.notEqual(ev.problems[i].text, ev.problems[i - 1].text);
});

t('ghost count follows the recorded timeline', () => {
  const { g, ev, adv } = harness({ ghost: [1, 2, 3, 10] });
  g.start();
  adv(2500);
  g.poll();
  assert.equal(ev.ticks.at(-1).ghost, 2);
});

t('finished round produces a full record and facts', () => {
  const { g, ev, adv } = harness({ cfg: { ops: ['m'], m: [2, 12, 2, 12] } });
  g.start();
  for (let i = 0; i < 8; i++) { adv(2000); g.input(String(g.current().answer)); }
  adv(20_000);
  g.poll();
  const rec = ev.ended.record;
  assert.equal(rec.score, 8);
  assert.equal(rec.spm, 16);
  assert.ok(Object.keys(ev.ended.facts).length > 0);
});

t('tricks are valid and use the real operands', () => {
  assert.match(tipFor('a', 38, 47), /47 \+ 38: 50 \+ 38 = 88, then take off 3 to get 85/);
  assert.match(tipFor('s', 38, 47), /85 − 38: go from 38 up 2 to 40, then up 45 to 85/);
  assert.match(tipFor('m', 7, 38), /7 × 38 = 7 × 30 \+ 7 × 8 = 210 \+ 56 = 266/);
  assert.match(tipFor('m', 7, 9), /neighbour fact/);
  assert.match(tipFor('d', 7, 38), /7 × 30 = 210/);
  // no silly "+ 0" or "take off 0" ever appears
  for (let x = 2; x < 100; x += 3) for (let y = 2; y < 100; y += 7) for (const op of ['a', 's', 'm', 'd']) {
    const s = tipFor(op, x, y);
    assert.ok(!/take off 0\b/.test(s) && !/\+ \d+ × 0\b/.test(s), s);
  }
});

t('trickFor gives a generic tip with no data and a targeted one with data', () => {
  assert.match(trickFor([]).html, /Round up/);
  const cfg = normalizeConfig({ ops: ['a'] });
  const mk = (i) => buildRecord({ cfg, mode: 'n', elapsed: 30, completed: true, ts: 1e12 + i, log: Array.from({ length: 12 }, (_, j) => { const p = makeProblem('a', 18, 17); return { op: 'a', bucket: p.bucket, time: 2000, wrong: 0, at: j * 1000, x: 18, y: 17, errs: [] }; }) });
  assert.match(trickFor([mk(1), mk(2)]).html, /Trick for Addition/);
});

console.log(`\n${passed} engine test groups passed`);
