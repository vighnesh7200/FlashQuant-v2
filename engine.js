// FlashQuant game engine. No DOM. The clock is a real deadline, so background throttling cannot stretch a round.

import { randomProblem, killerProblem, buildRecord, factsFromLog } from './core.js';

export function createGame({ cfg, mode = 'n', agg = {}, ghostTimeline = null, now = Date.now, rng = Math.random, onTick = () => {}, onProblem = () => {}, onSolve = () => {}, onWrong = () => {}, onEnd = () => {}, schedule = (fn, ms) => setInterval(fn, ms), unschedule = (id) => clearInterval(id) }) {
  const dur = cfg.dur;
  const log = [];
  const wrongAt = [];
  let startedAt = 0;
  let deadline = 0;
  let timer = null;
  let running = false;
  let touched = false;
  let cur = null;
  let partial = '';

  function pick() {
    for (let i = 0; i < 6; i++) {
      const p = mode === 'k' ? killerProblem(cfg, agg, rng) : randomProblem(cfg, rng);
      if (!cur || p.text !== cur.text) return p;
    }
    return mode === 'k' ? killerProblem(cfg, agg, rng) : randomProblem(cfg, rng);
  }

  function nextProblem() {
    const p = pick();
    cur = { ...p, wrong: 0, errs: [], t0: now() };
    partial = '';
    onProblem(cur);
  }

  function elapsedMs() {
    return Math.min(dur * 1000, Math.max(0, now() - startedAt));
  }

  function ghostCount(sec) {
    return ghostTimeline ? ghostTimeline.filter((x) => x <= sec).length : null;
  }

  function poll() {
    if (!running) return;
    const left = deadline - now();
    if (left <= 0) return finish(true);
    onTick({ leftMs: left, leftSec: Math.ceil(left / 1000), solved: log.length, ghost: ghostCount(elapsedMs() / 1000) });
  }

  function finish(completed) {
    if (!running) return null;
    running = false;
    if (timer !== null) unschedule(timer);
    timer = null;
    // An unfinished wrong answer on screen when time runs out still counts as a mistake.
    let pendingWrong = 0;
    if (completed && partial && !String(cur.answer).startsWith(partial)) pendingWrong = 1;
    const elapsed = completed ? dur : elapsedMs() / 1000;
    const record = buildRecord({ cfg, mode, log, wrongAt, pendingWrong, elapsed, completed, ts: startedAt });
    const result = { record, log: log.slice(), wrongAt: wrongAt.slice(), facts: factsFromLog(log), completed, touched };
    onEnd(result);
    return result;
  }

  return {
    start() {
      startedAt = now();
      deadline = startedAt + dur * 1000;
      running = true;
      nextProblem();
      onTick({ leftMs: dur * 1000, leftSec: dur, solved: 0, ghost: ghostCount(0) });
      timer = schedule(poll, 100);
    },
    // Call on every input change with the raw text of the answer box.
    input(raw) {
      if (!running) return { state: 'idle' };
      const v = String(raw).replace(/\D/g, '');
      partial = v;
      if (v === '') return { state: 'empty', value: '' };
      touched = true;
      if (now() >= deadline) {
        finish(true);
        return { state: 'idle' };
      }
      if (v === String(cur.answer)) {
        const t = now();
        log.push({ op: cur.op, bucket: cur.bucket, text: cur.text, x: cur.x, y: cur.y, time: t - cur.t0, wrong: cur.wrong, errs: cur.errs, at: t - startedAt });
        onSolve(log.length);
        nextProblem();
        poll();
        return { state: 'solved', value: '' };
      }
      if (v.length >= String(cur.answer).length) {
        cur.wrong++;
        cur.errs.push(parseInt(v, 10) - cur.answer);
        wrongAt.push(now() - startedAt);
        partial = '';
        onWrong(cur.wrong);
        return { state: 'wrong', value: '' };
      }
      // Still typing: tell the UI whether the digits so far can still become the right answer.
      return { state: String(cur.answer).startsWith(v) ? 'typing' : 'off-track', value: v };
    },
    abort() {
      return finish(false);
    },
    poll,
    isRunning: () => running,
    current: () => cur,
    solved: () => log.length,
    // Exposed for tests and for the live analysis.
    snapshot: () => ({ log: log.slice(), wrongAt: wrongAt.slice(), elapsedMs: elapsedMs() }),
  };
}
